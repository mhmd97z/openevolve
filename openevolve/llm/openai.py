"""
OpenAI API interface for LLMs

This module also supports a "manual mode" (human-in-the-loop) where prompts are written
to a task queue directory and the system waits for a corresponding *.answer.json file
"""

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import openai

from openevolve.llm.base import LLMInterface

logger = logging.getLogger(__name__)


def _iso_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


# Models that only respond on /v1/responses (not /v1/chat/completions).
# Add new entries here as OpenAI ships them.
RESPONSES_ONLY_MODEL_PREFIXES = (
    "o1-pro",
    "o3-pro",
    "gpt-5-pro",
    "gpt-5.5-pro",
)


def _is_openai_endpoint(api_base: Optional[str]) -> bool:
    """True for the canonical OpenAI endpoint (not Gemini compat, vLLM, etc.)."""
    if not api_base:
        return True
    return "api.openai.com" in api_base


def _use_responses_api(model: str, api_base: Optional[str]) -> bool:
    if not _is_openai_endpoint(api_base):
        return False
    m = str(model).lower()
    return any(m.startswith(p) for p in RESPONSES_ONLY_MODEL_PREFIXES)


def _to_responses_params(chat_params: Dict[str, Any]) -> Dict[str, Any]:
    """Translate chat-completions-style params to Responses-API params.

    The Responses API takes ``input`` (list of {role, content}) plus
    ``max_output_tokens`` and ``reasoning={"effort": ...}``. It rejects
    chat-only fields like ``temperature``/``top_p`` for reasoning models, so
    we drop them here.
    """
    out: Dict[str, Any] = {"model": chat_params["model"]}

    messages = chat_params.get("messages") or []
    instructions_parts: List[str] = []
    input_items: List[Dict[str, Any]] = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        if role == "system":
            if content:
                instructions_parts.append(str(content))
            continue
        input_items.append({"role": role, "content": str(content)})
    if instructions_parts:
        out["instructions"] = "\n\n".join(instructions_parts)
    out["input"] = input_items

    max_out = chat_params.get("max_completion_tokens") or chat_params.get("max_tokens")
    if max_out is not None:
        out["max_output_tokens"] = max_out

    effort = chat_params.get("reasoning_effort")
    if effort is not None:
        out["reasoning"] = {"effort": effort}

    if "verbosity" in chat_params:
        out["text"] = {"verbosity": chat_params["verbosity"]}

    return out


def _extract_responses_text(response: Any) -> str:
    """Pull the assistant text out of a Responses API result."""
    text = getattr(response, "output_text", None)
    if text:
        return text
    chunks: List[str] = []
    for item in getattr(response, "output", []) or []:
        if getattr(item, "type", None) != "message":
            continue
        for piece in getattr(item, "content", []) or []:
            t = getattr(piece, "text", None)
            if t:
                chunks.append(t)
    return "".join(chunks)


def _build_display_prompt(messages: List[Dict[str, str]]) -> str:
    """
    Render messages into a single plain-text prompt for the manual UI.
    """
    chunks: List[str] = []
    for m in messages:
        role = str(m.get("role", "user")).upper()
        content = m.get("content", "")
        chunks.append(f"### {role}\n{content}\n")
    return "\n".join(chunks).rstrip() + "\n"


def _atomic_write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.tmp"
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


class OpenAILLM(LLMInterface):
    """LLM interface using OpenAI-compatible APIs"""

    def __init__(
        self,
        model_cfg: Optional[dict] = None,
    ):
        self.model = model_cfg.name
        self.system_message = model_cfg.system_message
        self.temperature = model_cfg.temperature
        self.top_p = model_cfg.top_p
        self.max_tokens = model_cfg.max_tokens
        self.timeout = model_cfg.timeout
        self.retries = model_cfg.retries
        self.retry_delay = model_cfg.retry_delay
        self.api_base = model_cfg.api_base
        self.api_key = model_cfg.api_key
        self.random_seed = getattr(model_cfg, "random_seed", None)
        self.reasoning_effort = getattr(model_cfg, "reasoning_effort", None)

        # Manual mode: enabled via llm.manual_mode in config.yaml
        self.manual_mode = (getattr(model_cfg, "manual_mode", False) is True)
        self.manual_queue_dir: Optional[Path] = None

        if self.manual_mode:
            qdir = getattr(model_cfg, "_manual_queue_dir", None)
            if not qdir:
                raise ValueError(
                    "Manual mode is enabled but manual_queue_dir is missing. "
                    "This should be injected by the OpenEvolve controller."
                )
            self.manual_queue_dir = Path(str(qdir)).expanduser().resolve()
            self.manual_queue_dir.mkdir(parents=True, exist_ok=True)
            self.client = None
        else:
            # Set up API client (normal mode)
            # OpenAI client requires max_retries to be int, not None
            max_retries = self.retries if self.retries is not None else 0
            self.client = openai.OpenAI(
                api_key=self.api_key,
                base_url=self.api_base,
                timeout=self.timeout,
                max_retries=max_retries,
            )

        # Only log unique models to reduce duplication
        if not hasattr(logger, "_initialized_models"):
            logger._initialized_models = set()

        if self.model not in logger._initialized_models:
            logger.info(f"Initialized OpenAI LLM with model: {self.model}")
            logger._initialized_models.add(self.model)

    async def generate(self, prompt: str, **kwargs) -> str:
        """Generate text from a prompt"""
        return await self.generate_with_context(
            system_message=self.system_message,
            messages=[{"role": "user", "content": prompt}],
            **kwargs,
        )

    async def generate_with_context(
        self, system_message: str, messages: List[Dict[str, str]], **kwargs
    ) -> str:
        """Generate text using a system message and conversational context"""
        # Prepare messages with system message
        formatted_messages = [{"role": "system", "content": system_message}]
        formatted_messages.extend(messages)

        # Set up generation parameters
        # Define OpenAI reasoning models that require max_completion_tokens
        # These models don't support temperature/top_p and use different parameters
        OPENAI_REASONING_MODEL_PREFIXES = (
            # O-series reasoning models
            "o1-",
            "o1",  # o1, o1-mini, o1-preview
            "o3-",
            "o3",  # o3, o3-mini, o3-pro
            "o4-",  # o4-mini
            # GPT-5 series are also reasoning models
            "gpt-5-",
            "gpt-5",  # gpt-5, gpt-5-mini, gpt-5-nano
            # The GPT OSS series are also reasoning models
            "gpt-oss-120b",
            "gpt-oss-20b",
        )

        # Check if this is an OpenAI reasoning model based on model name pattern
        # This works for all endpoints (OpenAI, Azure, OptiLLM, OpenRouter, etc.)
        model_lower = str(self.model).lower()
        is_openai_reasoning_model = model_lower.startswith(OPENAI_REASONING_MODEL_PREFIXES)

        if is_openai_reasoning_model:
            # For OpenAI reasoning models
            params = {
                "model": self.model,
                "messages": formatted_messages,
                "max_completion_tokens": kwargs.get("max_tokens", self.max_tokens),
            }
            # Add optional reasoning parameters if provided
            reasoning_effort = kwargs.get("reasoning_effort", self.reasoning_effort)
            if reasoning_effort is not None:
                params["reasoning_effort"] = reasoning_effort
            if "verbosity" in kwargs:
                params["verbosity"] = kwargs["verbosity"]
        else:
            # Standard parameters for all other models
            params = {
                "model": self.model,
                "messages": formatted_messages,
                "temperature": kwargs.get("temperature", self.temperature),
                "top_p": kwargs.get("top_p", self.top_p),
                "max_tokens": kwargs.get("max_tokens", self.max_tokens),
            }

            # Handle reasoning_effort for open source reasoning models.
            reasoning_effort = kwargs.get("reasoning_effort", self.reasoning_effort)
            if reasoning_effort is not None:
                params["reasoning_effort"] = reasoning_effort

        # Add seed parameter for reproducibility if configured
        # Skip seed parameter for Google AI Studio endpoint as it doesn't support it
        # Seed only makes sense for actual API calls
        seed = kwargs.get("seed", self.random_seed)
        if seed is not None and not self.manual_mode:
            if self.api_base == "https://generativelanguage.googleapis.com/v1beta/openai/":
                logger.warning(
                    "Skipping seed parameter as Google AI Studio endpoint doesn't support it. "
                    "Reproducibility may be limited."
                )
            else:
                params["seed"] = seed

        # Attempt the API call with retries
        retries = kwargs.get("retries", self.retries)
        retry_delay = kwargs.get("retry_delay", self.retry_delay)

        # Manual mode: no timeout unless explicitly passed by the caller
        if self.manual_mode:
            timeout = kwargs.get("timeout", None)
            return await self._manual_wait_for_answer(params, timeout=timeout)

        timeout = kwargs.get("timeout", self.timeout)

        for attempt in range(retries + 1):
            try:
                response = await asyncio.wait_for(self._call_api(params), timeout=timeout)
                return response
            except asyncio.TimeoutError:
                if attempt < retries:
                    logger.warning(f"Timeout on attempt {attempt + 1}/{retries + 1}. Retrying...")
                    await asyncio.sleep(retry_delay)
                else:
                    logger.error(f"All {retries + 1} attempts failed with timeout")
                    raise
            except Exception as e:
                if attempt < retries:
                    logger.warning(
                        f"Error on attempt {attempt + 1}/{retries + 1}: {str(e)}. Retrying..."
                    )
                    await asyncio.sleep(retry_delay)
                else:
                    logger.error(f"All {retries + 1} attempts failed with error: {str(e)}")
                    raise

    async def _call_api(self, params: Dict[str, Any]) -> str:
        """Make the actual API call"""
        if self.client is None:
            raise RuntimeError("OpenAI client is not initialized (manual_mode enabled?)")

        loop = asyncio.get_event_loop()
        logger = logging.getLogger(__name__)

        if _use_responses_api(params.get("model", ""), self.api_base):
            responses_params = _to_responses_params(params)
            logger.debug(f"Responses API parameters: {responses_params}")
            response = await loop.run_in_executor(
                None, lambda: self.client.responses.create(**responses_params)
            )
            content = _extract_responses_text(response)
            logger.debug(f"Responses API response: {content}")
            return content

        response = await loop.run_in_executor(
            None, lambda: self.client.chat.completions.create(**params)
        )
        logger.debug(f"API parameters: {params}")
        logger.debug(f"API response: {response.choices[0].message.content}")
        return response.choices[0].message.content

    async def _manual_wait_for_answer(
        self, params: Dict[str, Any], timeout: Optional[Union[int, float]]
    ) -> str:
        """
        Manual mode: write a task JSON file and poll for *.answer.json
        If timeout is provided, we respect it; otherwise we wait indefinitely
        """

        if self.manual_queue_dir is None:
            raise RuntimeError("manual_queue_dir is not initialized")

        task_id = str(uuid.uuid4())
        messages = params.get("messages", [])
        display_prompt = _build_display_prompt(messages)

        task_payload: Dict[str, Any] = {
            "id": task_id,
            "created_at": _iso_now(),
            "model": params.get("model"),
            "display_prompt": display_prompt,
            "messages": messages,
            "meta": {
                "max_tokens": params.get("max_tokens"),
                "max_completion_tokens": params.get("max_completion_tokens"),
                "temperature": params.get("temperature"),
                "top_p": params.get("top_p"),
                "reasoning_effort": params.get("reasoning_effort"),
                "verbosity": params.get("verbosity"),
            },
        }

        task_path = self.manual_queue_dir / f"{task_id}.json"
        answer_path = self.manual_queue_dir / f"{task_id}.answer.json"

        _atomic_write_json(task_path, task_payload)
        logger.info(f"[manual_mode] Task enqueued: {task_path}")

        start = time.time()
        poll_interval = 0.5

        while True:
            if answer_path.exists():
                try:
                    data = json.loads(answer_path.read_text(encoding="utf-8"))
                except Exception as e:
                    logger.warning(f"[manual_mode] Failed to parse answer JSON for {task_id}: {e}")
                    await asyncio.sleep(poll_interval)
                    continue

                answer = str(data.get("answer") or "")
                logger.info(f"[manual_mode] Answer received for {task_id}")
                return answer

            if timeout is not None and (time.time() - start) > float(timeout):
                raise asyncio.TimeoutError(
                    f"Manual mode timed out after {timeout} seconds waiting for answer of task {task_id}"
                )

            await asyncio.sleep(poll_interval)
