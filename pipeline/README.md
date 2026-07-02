# US2LC Pipeline

This directory is the runnable Node.js package for the replication package. Source code lives under `src/`.

## Structure

- `src/commander.js`: plan validation and Mendix execution entrypoint.
- `src/plan-generator-cli.js`: text-input to plan generation CLI.
- `src/plan-generator.js`: plan-generation orchestration.
- `src/generator/`: prompt, LLM, normalization, merge, coverage, and report helpers.
- `src/lib/`: validation, checking, diffing, semantic checks, VN/PV adapters, and shared helpers.
- `src/builders/`: page, microflow, and workflow builder templates and tests.
- `src/plans/reference/`: canonical reference plans.
- `src/plans/schema/`: JSON schemas.
- `src/test-data/`: test fixtures.
- `input/`: small example input folders.
- `visual-narrator/`: Visual Narrator source.
- `process-visualizer/`: Process Visualizer source.

## Install

```bash
npm install
```

Optional preprocessing environments:

```bash
npm run setup:vn
npm run setup:process-viz
```

## Test

```bash
npm test
```

Run only unit tests:

```bash
npm run test:unit
```

Run only reference-plan smoke validation:

```bash
npm run test:smoke
```

## Validate Or Run A Plan

```bash
npm run validate:plan --plan=src/plans/reference/reference-01-role-separated-crud.json
npm run run:plan --plan=src/plans/reference/reference-01-role-separated-crud.json
```

Direct entrypoints are also valid:

```bash
node src/commander.js src/plans/reference/reference-01-role-separated-crud.json --validate-only
node src/commander.js src/plans/reference/reference-01-role-separated-crud.json
```

Live Mendix execution requires:

```bash
export MENDIX_TOKEN="<token>"
```

## Generate A Plan

Offline, without VN/PV preprocessing:

```bash
npm run generate:plan -- --input-dir=input/input_case_1 --out=src/plans/_scratch/generated-plan.json --no-vn --no-process-viz
```

With preprocessing enabled:

```bash
npm run setup:vn
npm run setup:process-viz
npm run generate:plan -- --input-dir=input/input_case_1 --out=src/plans/_scratch/generated-plan.json
```

The default Ollama model is `llama3` at `http://127.0.0.1:11434`.

Useful flags:

- `--no-vn`: skip Visual Narrator.
- `--no-process-viz`: skip Process Visualizer.
- `--no-examples`: skip reference-plan examples in the prompt.
- `--no-knowledge`: skip optional Mendix knowledge directory injection.
- `--min-story-coverage=<0..1>`: fail generation below a required story-coverage score.
- `--mock-ollama-response=<path>`: use a local JSON response for tests.
- `--mock-vn-response=<path>`: use a local Visual Narrator JSON response for tests.
- `--mock-process-viz-response=<path>`: use a local Process Visualizer JSON response for tests.

Input folder contract:

- Required: `user-stories.txt`
- Required: `app-context.json`
- Optional: `domain-info.txt`
- Optional: `acceptance-criteria.txt`
- Optional: `process.bpmn`

`app-context.json` requires `moduleName` and requires `appId` unless `createApp` or `seedAppId` is used.

## Other Commands

```bash
npm run check:plan --plan=src/plans/reference/reference-01-role-separated-crud.json --input-dir=input/input_case_1
npm run diff:plans --left=plan-a.json --right=plan-b.json --format=markdown
npm run benchmark:plans -- --config=<benchmark-config.json>
npm run generate:vn -- --input-dir=input/input_case_1
npm run generate:process-viz -- --input-dir=input/input_case_1
```

Benchmark config/case directories are not part of the cleaned replication package unless supplied separately.
