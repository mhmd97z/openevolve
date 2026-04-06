"""
Utilities for dumping LLM responses for debugging.
"""

import json
import time
from pathlib import Path
from typing import Dict, Optional


def dump_invalid_diff_response(
    llm_response: str,
    iteration: int,
    log_dir: Optional[str],
    prompt: Optional[Dict[str, str]] = None,
) -> Optional[str]:
    """
    Persist an LLM response that could not be parsed into valid diff blocks.

    Args:
        llm_response: Raw response returned by the model
        iteration: Evolution iteration number
        log_dir: Active run log directory
        prompt: Optional prompt payload for extra debugging context

    Returns:
        The dump file path if written, otherwise None.
    """
    if not log_dir:
        return None

    dump_dir = Path(log_dir) / "invalid_diff_responses"
    dump_dir.mkdir(parents=True, exist_ok=True)

    dump_path = dump_dir / (
        f"iteration_{iteration:06d}_{time.strftime('%Y%m%d_%H%M%S')}.json"
    )
    payload = {
        "iteration": iteration,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "reason": "no_valid_diffs_found",
        "llm_response": llm_response,
    }
    if prompt:
        payload["prompt"] = prompt

    dump_path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return str(dump_path)
