# Evaluation Artifacts

This directory contains the inputs, archived runs, quantitative analysis files, and qualitative analysis materials for the replication package.

## Layout

- `user_stories/`: the nine evaluation user-story datasets.
- `reference_models/`: gold/silver standard workbook and extracted Mendix reference domain models.
- `runs/vn-runs/`: standalone Visual Narrator outputs.
- `runs/pv-runs/`: standalone Process Visualizer outputs.
- `runs/final_runs/20260528-165228/`: initial stability and builder-stage timing run.
- `runs/final_runs/20260606-091359/`: final selected all-runs set and builder-stage timing run.
- `quantitative_analysis/`: notebooks, spreadsheets, and warning summaries.
- `qualitative_analysis/`: qualitative survey, think-aloud, expert-evaluation, codebook, and transcript artifacts.

## Final Run Set

The final selected run set is under `runs/final_runs/20260606-091359/all_runs/` and contains three selected runs for each dataset:

- `brewery`
- `camperplus`
- `education`
- `fish_chips`
- `grocery`
- `cinema`
- `collaboration`
- `sports`
- `matching`

## Analysis Files

The domain-model comparison inputs are:

- `reference_models/gold_silver_standard.xlsx`
- `reference_models/brewery_domain_model.json`
- `reference_models/education_domain_model.json`
- `reference_models/cinema_domain_model.json`
- `reference_models/collaboration_domain_model.json`
- `reference_models/matching_domain_model.json`

The main quantitative artifacts are:

- `quantitative_analysis/quantitative_evaluation_analysis.ipynb`
- `quantitative_analysis/generic_completeness_notebook.ipynb`
- `quantitative_analysis/domain_model_scoring_notebook.ipynb`
- `quantitative_analysis/all_runs_results.xlsx`
- `quantitative_analysis/first_runs_results.xlsx`
- `quantitative_analysis/domain_model_comparison_results.xlsx`
- `quantitative_analysis/domain-comparison.xlsx`

Archived outputs preserve original absolute paths in some logs and saved notebook outputs. Those paths document provenance and are not required for using the files in this package.

## Qualitative Analysis Files

The qualitative artifacts are:

- `qualitative_analysis/analysis/semi_expert_evaluation_analysis.ipynb`
- `qualitative_analysis/analysis/qualtrics_cleaned_responses.csv`
- `qualitative_analysis/analysis/qualtrics_codebook.csv`
- `qualitative_analysis/analysis/codebook_survey.xlsx`
- `qualitative_analysis/analysis/codebook_think_aloud.xlsx`
- `qualitative_analysis/codebook_expert.xlsx`
- `qualitative_analysis/transcripts/`

The transcript and survey files use participant IDs and role labels. Do not attempt to re-identify participants, and preserve anonymization when quoting or redistributing qualitative material.

## Known External Artifact

The qualitative analysis includes instruments, cleaned responses, codebooks, and transcripts. The prepared local Mendix app workspaces inspected by participants are not included.

The Mendix Maia comparison is summarized in the thesis, but this replication package does not currently include raw Maia interaction exports, screenshots, or session logs.
