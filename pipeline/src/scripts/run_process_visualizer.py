#!/usr/bin/env python3

import argparse
import contextlib
import json
import os
import sys
from pathlib import Path


def read_json(path, default):
    try:
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf8"))
    except Exception:
        return default


def ensure_src_link(run_dir, process_visualizer_src):
    link_path = run_dir / "src"
    if link_path.exists():
        return
    try:
        link_path.symlink_to(process_visualizer_src, target_is_directory=True)
    except OSError:
        # Some filesystems disallow symlinks; copying only the static support
        # file keeps process-viz's hard-coded relative read working.
        target_dir = link_path / "coreference_resolution"
        target_dir.mkdir(parents=True, exist_ok=True)
        source_file = process_visualizer_src / "coreference_resolution" / "ignore_words.txt"
        (target_dir / "ignore_words.txt").write_text(source_file.read_text(encoding="utf8"), encoding="utf8")


def main():
    parser = argparse.ArgumentParser(description="Run Process Visualizer and emit structured JSON.")
    parser.add_argument("--input", required=True, help="Path to user-stories.txt")
    parser.add_argument("--output-dir", required=True, help="Directory for process-viz artifacts")
    parser.add_argument("--model", required=True, help="Ollama model name")
    parser.add_argument("--ollama-url", required=True, help="Ollama base URL")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    process_visualizer_root = repo_root / "process-visualizer"
    process_visualizer_src = process_visualizer_root / "src"
    input_path = Path(args.input).resolve()
    output_root = Path(args.output_dir).resolve()
    run_dir = output_root / "process-visualizer-run"
    run_dir.mkdir(parents=True, exist_ok=True)
    ensure_src_link(run_dir, process_visualizer_src)

    os.environ["PROCESS_VISUALIZER_LLM_PROVIDER"] = "ollama"
    os.environ["PROCESS_VISUALIZER_MODEL"] = args.model
    os.environ["OLLAMA_MODEL"] = args.model
    os.environ["OLLAMA_URL"] = args.ollama_url
    os.environ["HF_HOME"] = str(process_visualizer_root / ".cache" / "huggingface")
    os.environ["TRANSFORMERS_CACHE"] = str(process_visualizer_root / ".cache" / "huggingface" / "transformers")

    text = input_path.read_text(encoding="utf8").strip()
    graph_base = run_dir / "process-visualizer"
    old_cwd = Path.cwd()
    structure = []

    sys.path.insert(0, str(process_visualizer_src))

    try:
        with contextlib.redirect_stdout(sys.stderr):
            from process_bpmn_data import generate_graph_pdf, process_text

            os.chdir(run_dir)
            structure = process_text(text)
            if not structure:
                raise RuntimeError("Process Visualizer did not produce a BPMN structure.")
            generate_graph_pdf(structure, True, str(graph_base))
    finally:
        os.chdir(old_cwd)

    output_logs = run_dir / "output_logs"
    result = {
        "ok": True,
        "inputPath": str(input_path),
        "outputDir": str(run_dir),
        "model": args.model,
        "ollamaUrl": args.ollama_url,
        "entities": read_json(output_logs / "model_output.json", []),
        "bpmnStructure": read_json(output_logs / "bpmn_structure.json", structure),
        "graphData": read_json(output_logs / "graph_data.json", {}),
        "graphSourcePath": str(graph_base.with_suffix(".gv")),
        "graphImagePath": str(graph_base.with_suffix(".png")),
        "logsDir": str(output_logs),
        "stats": {
            "entityCount": len(read_json(output_logs / "model_output.json", [])),
            "topLevelElementCount": len(structure if isinstance(structure, list) else [structure])
        }
    }

    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
