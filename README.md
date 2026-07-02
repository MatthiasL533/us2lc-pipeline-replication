# US2LC Pipeline Replication Package

This repository contains the replication package for the thesis *From User Stories to Low-Code Applications: Automating Low-Code Development Through LLM-Driven Model Generation*. The thesis investigates how natural-language user stories can be transformed into low-code application artifacts through an LLM-driven pipeline that uses explicit domain and process-model representations as intermediate steps.

## Package Layout

- `pipeline/`: runnable Node.js package for plan generation, validation, diffing, benchmarking, and Mendix execution.
- `pipeline/src/`: pipeline source code, tests, schemas, reference plans, and helper scripts.
- `pipeline/input/`: small example input folders for local plan-generation runs.
- `pipeline/visual-narrator/`: vendored Visual Narrator source and requirements. The local Python environment is intentionally not included.
- `pipeline/process-visualizer/`: adapted Process Visualizer source. The local Python environment and caches are intentionally not included.
- `evaluation/user_stories/`: the nine evaluation user-story datasets.
- `evaluation/reference_models/`: gold-standard and extracted reference domain models used for domain-model comparison.
- `evaluation/runs/`: archived Visual Narrator, Process Visualizer, plan-generation, and builder-stage run artifacts.
- `evaluation/quantitative_analysis/`: spreadsheets and notebooks used for quantitative analysis.
- `evaluation/qualitative_analysis/`: qualitative survey, think-aloud, expert-evaluation, codebook, and transcript artifacts.

Archived JSON and log files may contain absolute paths from the original measurement machines. Treat those paths as provenance inside historical outputs; the runnable commands in this package use the relative paths documented below.

## Requirements

- Node.js 20 or newer. The package was checked with Node.js 24.
- npm.
- Python 3 for Visual Narrator setup.
- Python 3.11 for Process Visualizer setup.
- Optional: local Ollama at `http://127.0.0.1:11434` for live LLM-backed plan generation.
- Optional: `MENDIX_TOKEN` for live Mendix SDK execution.

The Python virtual environments are not committed. Recreate them with the setup commands below when you need live VN/PV preprocessing.

## Install

From the repository root:

```bash
cd pipeline
npm install
```

The Node dependencies are locked in `pipeline/package-lock.json`.

Optional preprocessing setup:

```bash
npm run setup:vn
npm run setup:process-viz
```

These commands create:

- `pipeline/visual-narrator/.venv`
- `pipeline/process-visualizer/.venv`

Both are ignored because they are local build artifacts.

## Verify The Package

Run the full test suite:

```bash
cd pipeline
npm test
```

This runs unit tests and smoke validation against the reference plans in `pipeline/src/plans/reference/`.

Validate one reference plan manually:

```bash
cd pipeline
npm run validate:plan --plan=src/plans/reference/reference-01-role-separated-crud.json
```

## Generate A Plan From Text Inputs

Use one of the example input folders under `pipeline/input/`:

```bash
cd pipeline
npm run generate:plan -- --input-dir=input/input_case_1 --out=src/plans/_scratch/generated-plan.json --no-vn --no-process-viz
```

The `--no-vn --no-process-viz` flags make the run independent of Python preprocessing. To run the full pipeline with preprocessing, first run the setup commands and then omit those flags.

For live LLM generation, make sure Ollama is running and has the selected model available. The default model is `llama3`.

## Run A Generated Plan Against Mendix

Live Mendix execution requires a token:

```bash
cd pipeline
export MENDIX_TOKEN="<token>"
npm run run:plan --plan=src/plans/reference/reference-07-client-actions-create-app.json
```

The reference create-app plan creates a Mendix app during execution. Inspect the plan before running if you want to change execution behavior.

## Evaluation Artifacts

The evaluation data is organized by stage:

- `evaluation/runs/vn-runs/`: standalone Visual Narrator outputs for the evaluation datasets.
- `evaluation/runs/pv-runs/`: standalone Process Visualizer outputs for the evaluation datasets.
- `evaluation/runs/final_runs/20260528-165228/`: initial stability runs and builder-stage timing outputs.
- `evaluation/runs/final_runs/20260606-091359/`: final selected runs, run inputs, and builder-stage timing outputs.
- `evaluation/reference_models/`: gold/silver standard workbook and extracted Mendix reference domain models.
- `evaluation/quantitative_analysis/`: notebooks, spreadsheets, and warning summaries.
- `evaluation/qualitative_analysis/`: coded qualitative analysis workbooks, cleaned survey responses, codebooks, and anonymized transcripts.

The final selected run set contains three runs for each of the nine datasets:

- `brewery`
- `camperplus`
- `education`
- `fish_chips`
- `grocery`
- `cinema`
- `collaboration`
- `sports`
- `matching`

Builder-stage timing outputs are available at:

- `evaluation/runs/final_runs/20260528-165228/builder-stage-runs/builder-stage-timings.csv`
- `evaluation/runs/final_runs/20260606-091359/builder-stage-runs/builder-stage-timings.csv`

The rerun helpers are:

- `evaluation/runs/final_runs/20260528-165228/builder-stage-runner.js`
- `evaluation/runs/final_runs/20260606-091359/builder-stage-runner.js`

They require `MENDIX_TOKEN` and create/delete Mendix apps as part of live timing measurements.

## Quantitative Analysis

The main analysis notebooks are:

- `evaluation/quantitative_analysis/quantitative_evaluation_analysis.ipynb`
- `evaluation/quantitative_analysis/generic_completeness_notebook.ipynb`
- `evaluation/quantitative_analysis/domain_model_scoring_notebook.ipynb`

The main spreadsheet outputs are:

- `evaluation/quantitative_analysis/all_runs_results.xlsx`
- `evaluation/quantitative_analysis/first_runs_results.xlsx`
- `evaluation/quantitative_analysis/domain-comparison.xlsx`

The domain-model comparison inputs are stored in `evaluation/reference_models/`.

Some notebooks preserve absolute paths from the original analysis environment in saved cell outputs. The source cells use the current package layout and can be re-executed from this repository root.

## Qualitative Analysis

The qualitative materials are organized as follows:

- `evaluation/qualitative_analysis/analysis/semi_expert_evaluation_analysis.ipynb`: qualitative/semi-expert analysis notebook.
- `evaluation/qualitative_analysis/analysis/qualtrics_cleaned_responses.csv`: cleaned survey responses.
- `evaluation/qualitative_analysis/analysis/qualtrics_codebook.csv`: survey-code mapping.
- `evaluation/qualitative_analysis/analysis/codebook_survey.xlsx`: coded survey analysis workbook.
- `evaluation/qualitative_analysis/analysis/codebook_think_aloud.xlsx`: coded think-aloud analysis workbook.
- `evaluation/qualitative_analysis/codebook_expert.xlsx`: coded expert-evaluation workbook.
- `evaluation/qualitative_analysis/transcripts/`: anonymized think-aloud and expert transcripts.

The qualitative files use participant IDs and role labels rather than participant names. Do not attempt to re-identify participants, and preserve anonymization if quoting excerpts.

## Notes On Reproducibility

- Unit and smoke tests are hermetic and should pass after `npm install`.
- Full plan generation depends on the selected Ollama model and may vary across model versions.
- Live Mendix builder-stage measurements depend on Mendix platform availability, account permissions, network latency, and SDK behavior.
- The qualitative analysis includes instruments, cleaned responses, codebooks, and transcripts; the prepared local Mendix app workspaces inspected by participants are not included.
- The Mendix Maia comparison is reported in the thesis, but raw Maia interaction exports or screenshots are not included in this package.
- Generated scratch outputs, Python virtual environments, caches, notebook checkpoints, and OS metadata are excluded from the cleaned package.

## License

This package is released for research and non-commercial use only. See `LICENSE` for the full terms. Third-party components remain subject to their own licenses.
