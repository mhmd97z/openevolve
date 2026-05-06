import math
import os
import json
import glob
import shutil
import logging
import re as _re
from numbers import Number
from typing import Optional, Any

from flask import Flask, render_template, jsonify, send_file

from manual import create_manual_blueprint


logger = logging.getLogger(__name__)
app = Flask(__name__, template_folder="templates")

# Resolve the workspace root (two levels above this script: scripts/ -> openevolve/ -> workspace/)
_WORKSPACE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_EXP_BASE = os.path.join(_WORKSPACE, "5g-eval", "exp_dirs")

_MULTI_RUN_DIR = None  # Set when --path points to a parent directory with multiple runs


def find_latest_checkpoint(base_folder):
    # Check whether the base folder is itself a checkpoint folder
    if os.path.basename(base_folder).startswith("checkpoint_"):
        return base_folder

    checkpoint_folders = glob.glob("**/checkpoint_*", root_dir=base_folder, recursive=True)
    if not checkpoint_folders:
        logger.info(f"No checkpoint folders found in {base_folder}")
        return None
    checkpoint_folders = [os.path.join(base_folder, folder) for folder in checkpoint_folders]
    checkpoint_folders.sort(key=lambda x: os.path.getmtime(x), reverse=True)
    logger.debug(f"Found checkpoint folder: {checkpoint_folders[0]}")
    return checkpoint_folders[0]


def load_evolution_data(checkpoint_folder):
    meta_path = os.path.join(checkpoint_folder, "metadata.json")
    programs_dir = os.path.join(checkpoint_folder, "programs")
    if not os.path.exists(meta_path) or not os.path.exists(programs_dir):
        logger.info(f"Missing metadata.json or programs dir in {checkpoint_folder}")
        return {"archive": [], "nodes": [], "edges": [], "checkpoint_dir": checkpoint_folder}
    with open(meta_path) as f:
        meta = json.load(f)

    nodes = []
    id_to_program = {}
    pids = set()
    for island_idx, id_list in enumerate(meta.get("islands", [])):
        for pid in id_list:
            prog_path = os.path.join(programs_dir, f"{pid}.json")

            # Keep track of PIDs and if one is double, append "-copyN" to the PID
            if pid in pids:
                base_pid = pid

                # If base_pid already has a "-copyN" suffix, strip it
                if "-copy" in base_pid:
                    base_pid = base_pid.rsplit("-copy", 1)[0]

                # Find the next available copy number
                copy_num = 1
                while f"{base_pid}-copy{copy_num}" in pids:
                    copy_num += 1
                pid = f"{base_pid}-copy{copy_num}"
            pids.add(pid)

            if os.path.exists(prog_path):
                with open(prog_path) as pf:
                    prog = json.load(pf)
                    sanitize_program_for_visualization(prog)
                prog["id"] = pid
                prog["island"] = island_idx
                nodes.append(prog)
                id_to_program[pid] = prog
            else:
                logger.debug(f"Program file not found: {prog_path}")

    edges = []
    for prog in nodes:
        parent_id = prog.get("parent_id")
        if parent_id and parent_id in id_to_program:
            edges.append({"source": parent_id, "target": prog["id"]})

    logger.info(f"Loaded {len(nodes)} nodes and {len(edges)} edges from {checkpoint_folder}")
    return {
        "archive": meta.get("archive", []),
        "nodes": nodes,
        "edges": edges,
        "checkpoint_dir": checkpoint_folder,
    }

def sanitize_program_for_visualization(program: dict[str, Any]) -> None:
    for k, v in program["metrics"].items():
        if not check_json_float(v):
            program["metrics"][k] = None
        if "parent_metrics" in program["metadata"]:
            for k, v in program["metadata"]["parent_metrics"].items():
                if not check_json_float(v):
                    program["metadata"]["parent_metrics"][k] = None

def check_json_float(v: Optional[float]) -> bool:
    return isinstance(v, Number) and not (math.isinf(v) or math.isnan(v))


def _has_own_checkpoints(path):
    """Return True if path is itself a checkpoint dir or directly contains a checkpoints/ dir."""
    if os.path.basename(path).startswith("checkpoint_"):
        return True
    return os.path.isdir(os.path.join(path, "checkpoints"))


def _is_multi_run_dir(path):
    """Return True if path is a parent directory containing multiple run subdirectories
    (each with checkpoints/ inside), rather than a single run directory itself."""
    if not os.path.isdir(path):
        return False
    if _has_own_checkpoints(path):
        return False
    child_runs = 0
    for entry in os.listdir(path):
        sub = os.path.join(path, entry)
        if os.path.isdir(sub) and _has_own_checkpoints(sub):
            child_runs += 1
            if child_runs >= 1:
                return True
    return False


def _list_runs(parent_dir):
    """Return sorted list of run directory names that contain checkpoints."""
    runs = []
    for entry in sorted(os.listdir(parent_dir)):
        sub = os.path.join(parent_dir, entry)
        if os.path.isdir(sub) and _has_own_checkpoints(sub):
            runs.append(entry)
    return runs


@app.route("/")
def index():
    multi = _MULTI_RUN_DIR is not None
    return render_template("index.html", checkpoint_dir=checkpoint_dir, multi_run=multi)


checkpoint_dir = None  # Global variable to store the checkpoint directory


@app.route("/api/runs")
def api_runs():
    """Return the list of available runs when in multi-run mode."""
    if _MULTI_RUN_DIR is None:
        return jsonify({"runs": []})
    return jsonify({"runs": _list_runs(_MULTI_RUN_DIR)})


@app.route("/api/data")
@app.route("/api/data/<run_name>")
def data(run_name=None):
    global checkpoint_dir

    if run_name and _MULTI_RUN_DIR:
        safe_name = os.path.basename(run_name)
        base_folder = os.path.join(_MULTI_RUN_DIR, safe_name)
    else:
        base_folder = os.environ.get("EVOLVE_OUTPUT", "examples/")

    checkpoint_dir = find_latest_checkpoint(base_folder)
    if not checkpoint_dir:
        logger.info(f"No checkpoints found in {base_folder}")
        return jsonify({"archive": [], "nodes": [], "edges": [], "checkpoint_dir": ""})

    logger.info(f"Loading data from checkpoint: {checkpoint_dir}")
    result = load_evolution_data(checkpoint_dir)
    logger.debug(f"Data: {result}")
    return jsonify(result)


@app.route("/program/<program_id>")
def program_page(program_id):
    global checkpoint_dir
    if checkpoint_dir is None:
        return "No checkpoint loaded", 500

    data = load_evolution_data(checkpoint_dir)
    program_data = next((p for p in data["nodes"] if p["id"] == program_id), None)
    program_data = {"code": "", "prompts": {}, **(program_data or {})}
    artifacts_json = program_data.get("artifacts_json", None)

    return render_template(
        "program_page.html",
        program_data=program_data,
        checkpoint_dir=checkpoint_dir,
        artifacts_json=artifacts_json,
    )


def _current_run_output_dir():
    """Return the OpenEvolve run output dir currently being visualized.

    Derives it from the global `checkpoint_dir` (parent of `checkpoints/`)
    so it stays correct in multi-run mode. Falls back to $EVOLVE_OUTPUT.
    """
    global checkpoint_dir
    if checkpoint_dir:
        # checkpoint_dir = <run>/checkpoints/checkpoint_XX
        parent = os.path.dirname(os.path.dirname(os.path.abspath(checkpoint_dir)))
        if os.path.isdir(parent):
            return parent
    env_output = os.environ.get("EVOLVE_OUTPUT")
    if env_output and os.path.isdir(env_output):
        return os.path.abspath(env_output)
    return None


@app.route("/api/figures/<program_id>")
def api_figures(program_id):
    """Return a list of figure URLs for program_id.

    Primary source: the run's own output tree
        <run>/figures/<program_id>/<scenario>/<run_dir>/<file>.png
    Fallback: the legacy 5g-eval/exp_dirs tree (for older runs that
    predate the self-contained figure mirror).
    """
    figures = []
    seen = set()

    run_output = _current_run_output_dir()
    if run_output:
        # Some pipelines normalize hyphens to underscores when creating the
        # per-program figure directory, so check both spellings.
        candidate_ids = {program_id, program_id.replace("-", "_")}
        run_paths: list[str] = []
        for pid in candidate_ids:
            run_paths.extend(
                glob.glob(os.path.join(run_output, "figures", pid, "*", "*", "*.png"))
            )
        for abs_path in sorted(set(run_paths)):
            rel = os.path.relpath(abs_path, run_output)
            parts = rel.replace("\\", "/").split("/")
            # parts: figures / <program_id> / <scenario> / <run_dir> / <file>
            scenario = parts[2] if len(parts) > 2 else "unknown"
            run_dir = parts[3] if len(parts) > 3 else ""
            filename = parts[-1]
            key = (scenario, run_dir, filename)
            if key in seen:
                continue
            seen.add(key)
            figures.append({
                "scenario": scenario,
                "run_dir":  run_dir,
                "filename": filename,
                "url":      f"/run_figures/{rel}",
            })

    # Backward-compatible fallback: legacy 5g-eval/exp_dirs layout
    normalized = program_id.replace("-", "_")
    legacy_pattern = os.path.join(
        _EXP_BASE, "openevolve", "*", normalized, "*", "run*", "figures", "*.png"
    )
    for abs_path in sorted(glob.glob(legacy_pattern)):
        rel = os.path.relpath(abs_path, _EXP_BASE)
        parts = rel.replace("\\", "/").split("/")
        # parts: openevolve / <run_id> / <program_id> / <scenario> / <run_dir> / figures / <file>
        scenario = parts[3] if len(parts) > 3 else "unknown"
        run_dir = parts[4] if len(parts) > 4 else ""
        filename = parts[-1]
        key = (scenario, run_dir, filename)
        if key in seen:
            continue
        seen.add(key)
        figures.append({
            "scenario": scenario,
            "run_dir":  run_dir,
            "filename": filename,
            "url":      f"/exp_figures/{rel}",
        })

    return jsonify(figures)


@app.route("/run_figures/<path:filepath>")
def serve_run_figure(filepath):
    """Serve a figure PNG from the current run's output tree."""
    run_output = _current_run_output_dir()
    if not run_output:
        return "Not found", 404
    abs_path = os.path.realpath(os.path.join(run_output, filepath))
    base = os.path.realpath(run_output)
    if not abs_path.startswith(base + os.sep) and abs_path != base:
        return "Forbidden", 403
    if not os.path.isfile(abs_path):
        return "Not found", 404
    return send_file(abs_path, mimetype="image/png")


@app.route("/exp_figures/<path:filepath>")
def serve_exp_figure(filepath):
    """Serve a figure PNG from the legacy exp_dirs tree (backward compat)."""
    abs_path = os.path.realpath(os.path.join(_EXP_BASE, filepath))
    base = os.path.realpath(_EXP_BASE)
    if not abs_path.startswith(base + os.sep) and abs_path != base:
        return "Forbidden", 403
    if not os.path.isfile(abs_path):
        return "Not found", 404
    return send_file(abs_path, mimetype="image/png")


@app.route("/api/test_results")
def api_test_results_list():
    """List test_runner result bundles under <run>/test_results/<stem>/summary.json."""
    run_output = _current_run_output_dir()
    if not run_output:
        return jsonify({"configs": []})
    base = os.path.join(run_output, "test_results")
    configs: list[str] = []
    if os.path.isdir(base):
        for entry in sorted(os.listdir(base)):
            sub = os.path.join(base, entry)
            summary = os.path.join(sub, "summary.json")
            if os.path.isfile(summary):
                configs.append(entry)
    return jsonify({"configs": configs})


@app.route("/api/test_results/<config_stem>")
def api_test_results_detail(config_stem: str):
    """Return parsed summary.json for one test_runner bundle."""
    run_output = _current_run_output_dir()
    if not run_output:
        return jsonify({"error": "no_run_output"}), 404
    safe = os.path.basename(config_stem)
    summary_path = os.path.realpath(
        os.path.join(run_output, "test_results", safe, "summary.json")
    )
    run_real = os.path.realpath(run_output)
    if not summary_path.startswith(run_real + os.sep) and summary_path != run_real:
        return jsonify({"error": "forbidden"}), 403
    if not os.path.isfile(summary_path):
        return jsonify({"error": "not_found"}), 404
    with open(summary_path, encoding="utf-8") as f:
        data = json.load(f)
    return jsonify(data)


def run_static_export(args):
    output_dir = args.static_output
    os.makedirs(output_dir, exist_ok=True)

    # Load data and prepare JSON string
    checkpoint_dir = find_latest_checkpoint(args.path)
    if not checkpoint_dir:
        raise RuntimeError(f"No checkpoint found in {args.path}")
    data = load_evolution_data(checkpoint_dir)
    logger.info(f"Exporting visualization for checkpoint: {checkpoint_dir}")

    with app.app_context():
        data_json = jsonify(data).get_data(as_text=True)
    inlined = f"<script>window.STATIC_DATA = {data_json};</script>"

    # Load index.html template
    templates_dir = os.path.join(os.path.dirname(__file__), "templates")
    template_path = os.path.join(templates_dir, "index.html")
    with open(template_path, "r", encoding="utf-8") as f:
        html = f.read()

    # Insert static json data into the HTML
    html = _re.sub(r"\{\{\s*url_for\('static', filename='([^']+)'\)\s*\}\}", r"static/\1", html)
    script_tag_idx = html.find('<script type="module"')

    if script_tag_idx != -1:
        html = html[:script_tag_idx] + inlined + "\n" + html[script_tag_idx:]
    else:
        html = html.replace("</body>", inlined + "\n</body>")

    with open(os.path.join(output_dir, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)

    # Copy over static files
    static_src = os.path.join(os.path.dirname(__file__), "static")
    static_dst = os.path.join(output_dir, "static")
    if os.path.exists(static_dst):
        shutil.rmtree(static_dst)
    shutil.copytree(static_src, static_dst)

    logger.info(
        f"Static export written to {output_dir}/\n"
        f"Note: use a web server, not file://. "
        f"Try: python3 -m http.server --directory {output_dir} 8080"
    )


# Manual mode blueprint mounted at /manual
app.register_blueprint(create_manual_blueprint(lambda: os.environ.get("EVOLVE_OUTPUT", "examples/")))


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="OpenEvolve Evolution Visualizer")
    parser.add_argument(
        "--path",
        type=str,
        default="examples/",
        help="Path to a single run output directory, a checkpoint_* dir, or a parent directory containing multiple runs.",
    )
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument(
        "--log-level",
        type=str,
        default="INFO",
        help="Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)",
    )
    parser.add_argument(
        "--static-output",
        type=str,
        default=None,
        help="Produce a static HTML export in this directory and exit.",
    )
    args = parser.parse_args()

    log_level = getattr(logging, args.log_level.upper(), logging.INFO)
    logging.basicConfig(level=log_level, format="[%(asctime)s] %(levelname)s %(name)s: %(message)s")

    logger.info(f"Current working directory: {os.getcwd()}")

    if args.static_output:
        run_static_export(args)

    import sys
    _this = sys.modules[__name__]
    if _is_multi_run_dir(args.path):
        _this._MULTI_RUN_DIR = os.path.abspath(args.path)
        runs = _list_runs(_this._MULTI_RUN_DIR)
        logger.info(f"Multi-run mode: found {len(runs)} runs in {_this._MULTI_RUN_DIR}")
        os.environ["EVOLVE_OUTPUT"] = os.path.join(_this._MULTI_RUN_DIR, runs[0]) if runs else args.path
    else:
        os.environ["EVOLVE_OUTPUT"] = args.path

    logger.info(f"Starting server at http://{args.host}:{args.port} with log level {args.log_level.upper()}")
    logger.info(f"Manual UI: http://{args.host}:{args.port}/manual")
    app.run(host=args.host, port=args.port, debug=True)
