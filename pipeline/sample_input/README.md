# Plan Generator Input Folder

The plan generator reads this folder by default (`--input-dir=input`).

Required files:
- `user-stories.txt`
- `app-context.json`

`app-context.json` (key fields):
- required: `moduleName`
- required for v1 non-create-app mode: `appId`
- optional: `createApp` (`true` to create a new Mendix app)
- optional: `appName` (exact app name when `createApp=true`)
- optional fallback: `createAppNamePrefix` (used when `appName` is not set)

Optional files:
- `domain-info.txt`
- `acceptance-criteria.txt`
- `process.bpmn` (accepted but ignored in v1)

Run from `pipeline/`:

```bash
npm run generate:plan -- --input-dir=input/input_case_1 --out=src/plans/_scratch/generated-plan.json --no-vn --no-process-viz
```

Visual Narrator and Process Visualizer preprocessing are enabled by default during plan generation. Use the skip flags above for an offline smoke run, or set up the Python environments first.

Useful flags:
- `--no-vn` skip Visual Narrator and use the existing plan-generation flow only
- `--no-process-viz` skip Process Visualizer

Environment setup:

```bash
npm run setup:vn
npm run setup:process-viz
```
