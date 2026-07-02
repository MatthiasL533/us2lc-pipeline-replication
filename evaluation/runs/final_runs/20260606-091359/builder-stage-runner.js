const fs = require("fs");
const path = require("path");

const {
  loadPlanFile,
  applyPackRefs,
  validatePlan,
  runPlan,
  formatErrorForDisplay
} = require("../../../../pipeline/src/commander");
const { MendixPlatformClient } = require("mendixplatformsdk");

const measurementRoot = __dirname;
const stabilityRoot = path.join(measurementRoot, "stability");
const outputRoot = path.join(measurementRoot, "builder-stage-runs");
const tempPlanRoot = path.join(outputRoot, "plans");
const resultRoot = path.join(outputRoot, "results");
const fullResultsPath = path.join(outputRoot, "builder-stage-results.json");
const csvPath = path.join(outputRoot, "builder-stage-timings.csv");
let currentCreatedApp = null;

const originalCreateNewApp = MendixPlatformClient.prototype.createNewApp;
MendixPlatformClient.prototype.createNewApp = async function patchedCreateNewApp(appName, options) {
  const app = await originalCreateNewApp.call(this, appName, options);
  currentCreatedApp = {
    appId: app && app.appId ? app.appId : "",
    name: appName,
    repositoryType: options && options.repositoryType ? options.repositoryType : "git"
  };
  return app;
};

const requestedStages = [
  "domainModel",
  "security",
  "microflowsNanoflows",
  "workflows",
  "pages",
  "verification",
  "commit"
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readPlanEntries() {
  const entries = [];
  for (const dataset of fs.readdirSync(stabilityRoot).sort()) {
    const datasetDir = path.join(stabilityRoot, dataset);
    if (!fs.statSync(datasetDir).isDirectory()) continue;
    for (const run of fs.readdirSync(datasetDir).sort()) {
      const planPath = path.join(datasetDir, run, "plan.json");
      if (!fs.existsSync(planPath)) continue;
      entries.push({ dataset, run, planPath });
    }
  }
  return entries;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanRunId(run) {
  return String(run || "").replace("-", "");
}

function preparePlan({ dataset, run, planPath }) {
  const loadedPlan = loadPlanFile(planPath);
  const packResult = applyPackRefs(loadedPlan, {
    planDirectory: path.dirname(planPath)
  });
  const plan = clone(packResult.plan);
  plan.execution = {
    ...(plan.execution || {}),
    createApp: true,
    commit: true,
    createAppName: `rerun-${dataset}-${cleanRunId(run)}`,
    commitMessage: `Rerun practical performance builder-stage run: ${dataset} ${run}`
  };
  const errors = validatePlan(plan);
  if (errors.length > 0) {
    throw new Error(`Plan validation failed for ${dataset}/${run}: ${errors.join("; ")}`);
  }

  const tempPlanDir = path.join(tempPlanRoot, dataset, run);
  ensureDir(tempPlanDir);
  const tempPlanPath = path.join(tempPlanDir, "plan.json");
  fs.writeFileSync(tempPlanPath, JSON.stringify(plan, null, 2), "utf8");
  return {
    plan,
    tempPlanPath,
    appliedPackPaths: packResult.appliedPackPaths
  };
}

function stageDurationMap(stages = []) {
  const byStage = {};
  for (const stage of Array.isArray(stages) ? stages : []) {
    if (!stage || !stage.stage) continue;
    byStage[stage.stage] = Number.isFinite(Number(stage.durationMs)) ? Number(stage.durationMs) : "";
  }
  return byStage;
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function writeOutputs(rows, fullResults) {
  const headers = [
    "dataset",
    "run",
    "ok",
    "app_id",
    "created_app_id",
    "app_name",
    "branch",
    "working_copy_id",
    "committed",
    "failed_app_deleted",
    "total_ms",
    ...requestedStages.map((stage) => `${stage}_ms`),
    "error"
  ];
  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))
  ].join("\n");
  fs.writeFileSync(csvPath, `${csv}\n`, "utf8");
  fs.writeFileSync(fullResultsPath, JSON.stringify(fullResults, null, 2), "utf8");
}

async function deleteFailedCreatedApp() {
  if (!currentCreatedApp || !currentCreatedApp.appId) return false;
  try {
    await new MendixPlatformClient().getApp(currentCreatedApp.appId).delete();
    return true;
  } catch (_err) {
    return false;
  }
}

async function main() {
  ensureDir(outputRoot);
  ensureDir(tempPlanRoot);
  ensureDir(resultRoot);

  const entries = readPlanEntries();
  const rows = [];
  const fullResults = {
    startedAt: new Date().toISOString(),
    measurementRoot,
    outputRoot,
    planCount: entries.length,
    appNameConvention: "rerun-<dataset>-<run0x>",
    requestedStages,
    runs: []
  };

  console.error(`Found ${entries.length} plans.`);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const label = `${entry.dataset}/${entry.run}`;
    const startedAt = Date.now();
    console.error(`[${index + 1}/${entries.length}] Starting ${label}`);

    let runRecord = {
      ...entry,
      ok: false,
      startedAt: new Date(startedAt).toISOString()
    };

    try {
      currentCreatedApp = null;
      const prepared = preparePlan(entry);
      runRecord.tempPlanPath = prepared.tempPlanPath;
      const result = await runPlan(prepared.plan, {
        planPath: prepared.tempPlanPath,
        planDirectory: path.dirname(prepared.tempPlanPath),
        appliedPackPaths: prepared.appliedPackPaths
      });
      const totalMs = Date.now() - startedAt;
      runRecord = {
        ...runRecord,
        ok: result.ok === true,
        totalMs,
        result
      };
      const resultPath = path.join(resultRoot, `${entry.dataset}-${entry.run}.json`);
      fs.writeFileSync(resultPath, JSON.stringify(runRecord, null, 2), "utf8");
      runRecord.resultPath = resultPath;

      const durations = stageDurationMap(result.stages);
      rows.push({
        dataset: entry.dataset,
        run: entry.run,
        ok: result.ok === true,
        app_id: result.appId || "",
        created_app_id: result.createdApp && result.createdApp.appId ? result.createdApp.appId : "",
        app_name: result.createdApp && result.createdApp.name ? result.createdApp.name : "",
        branch: result.branch || "",
        working_copy_id: result.workingCopyId || "",
        committed: result.committed === true,
        failed_app_deleted: false,
        total_ms: totalMs,
        ...Object.fromEntries(requestedStages.map((stage) => [`${stage}_ms`, durations[stage]])),
        error: ""
      });
      console.error(`[${index + 1}/${entries.length}] Completed ${label} in ${(totalMs / 1000).toFixed(1)}s`);
    } catch (err) {
      const totalMs = Date.now() - startedAt;
      const error = formatErrorForDisplay(err);
      const failedAppDeleted = await deleteFailedCreatedApp();
      runRecord = {
        ...runRecord,
        ok: false,
        totalMs,
        createdApp: currentCreatedApp,
        failedAppDeleted,
        error
      };
      const resultPath = path.join(resultRoot, `${entry.dataset}-${entry.run}.error.json`);
      fs.writeFileSync(resultPath, JSON.stringify(runRecord, null, 2), "utf8");
      runRecord.resultPath = resultPath;
      rows.push({
        dataset: entry.dataset,
        run: entry.run,
        ok: false,
        app_id: currentCreatedApp && currentCreatedApp.appId ? currentCreatedApp.appId : "",
        created_app_id: currentCreatedApp && currentCreatedApp.appId ? currentCreatedApp.appId : "",
        app_name: currentCreatedApp && currentCreatedApp.name ? currentCreatedApp.name : "",
        branch: "",
        working_copy_id: "",
        committed: false,
        failed_app_deleted: failedAppDeleted,
        total_ms: totalMs,
        ...Object.fromEntries(requestedStages.map((stage) => [`${stage}_ms`, ""])),
        error
      });
      console.error(`[${index + 1}/${entries.length}] Failed ${label}: ${error}`);
    }

    fullResults.runs.push(runRecord);
    writeOutputs(rows, fullResults);
  }

  fullResults.finishedAt = new Date().toISOString();
  fullResults.ok = fullResults.runs.every((run) => run.ok);
  writeOutputs(rows, fullResults);
  console.log(JSON.stringify({
    ok: fullResults.ok,
    planCount: entries.length,
    completed: rows.length,
    csvPath,
    fullResultsPath
  }, null, 2));
}

main().catch((err) => {
  console.error(formatErrorForDisplay(err));
  process.exit(1);
});
