const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { checkPlanFile } = require("./lib/plan-checker");
const { analyzePlanConsistency } = require("./lib/plan-consistency");
const { scorePlanFileAgainstRubric } = require("./lib/feature-fit-scorer");

const DEFAULT_CONFIG_PATH = path.join(__dirname, "benchmarks", "benchmark-config.json");
const DEFAULT_CASES_ROOT = path.join(__dirname, "benchmarks", "cases");
const MODE_DEFAULTS = {
  overnight: {
    runsPerCasePerModel: 1,
    useVisualNarrator: false,
    useProcessVisualizer: false
  },
  stability: {
    runsPerCasePerModel: 2
  }
};

function parseArgs(argv) {
  const out = {
    configPath: DEFAULT_CONFIG_PATH
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") out.configPath = argv[++i] || "";
    else if (arg.startsWith("--config=")) out.configPath = arg.slice("--config=".length);
  }

  return out;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node pipeline/plan-benchmark.js [--config=<path-to-config.json>]",
      "",
      "Default config:",
      `  ${DEFAULT_CONFIG_PATH}`
    ].join("\n")
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(value), "utf8");
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function stddev(values) {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
}

function inferFailureType(result = {}) {
  const stderr = String(result.stderr || "");
  const error = String(result.error || "");
  const combined = `${stderr}\n${error}`.toLowerCase();
  if (result.timedOut) return "timeout";
  if (combined.includes("invalid json")) return "invalid_json";
  if (combined.includes("econnrefused") || combined.includes("ollama")) return "ollama_error";
  if (combined.includes("validation")) return "validation_error";
  return "execution_error";
}

function collectGitMetadata(cwd) {
  const sha = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8"
  });
  const status = spawnSync("git", ["status", "--short"], {
    cwd,
    encoding: "utf8"
  });

  return {
    commitSha: sha.status === 0 ? String(sha.stdout || "").trim() : "",
    dirty: status.status === 0 ? String(status.stdout || "").trim().length > 0 : null
  };
}

function discoverCaseDirs(rootDir = DEFAULT_CASES_ROOT) {
  if (!fs.existsSync(rootDir)) return [];
  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function resolveCase(caseEntry, index) {
  const caseDir = path.resolve(typeof caseEntry === "string" ? caseEntry : caseEntry.caseDir || "");
  const inputDir = path.resolve(caseDir, "input");
  const rubricPath = path.resolve(caseDir, "case-rubric.json");
  const rubric = readJson(rubricPath);

  return {
    id: String((typeof caseEntry === "object" && caseEntry.id) || rubric.id || path.basename(caseDir) || `case-${index + 1}`),
    title: String(rubric.title || path.basename(caseDir)),
    caseDir,
    inputDir,
    rubricPath,
    rubric
  };
}

function normalizeCases(config) {
  let caseEntries = [];
  if (Array.isArray(config.cases) && config.cases.length > 0) {
    caseEntries = config.cases;
  } else if (config.inputDir) {
    const fallbackRoot = path.join(path.resolve(config.outputDir || path.join(__dirname, "benchmarks", "runs")), "..", "adhoc_case");
    caseEntries = [{ id: "adhoc_case", caseDir: fallbackRoot, inputDir: path.resolve(config.inputDir) }];
  } else {
    caseEntries = discoverCaseDirs();
  }

  return caseEntries.map((entry, index) => {
    if (typeof entry === "object" && entry.inputDir && !entry.caseDir) {
      return {
        id: String(entry.id || `case-${index + 1}`),
        title: String(entry.title || entry.id || `Case ${index + 1}`),
        caseDir: path.resolve(entry.inputDir, ".."),
        inputDir: path.resolve(entry.inputDir),
        rubricPath: path.resolve(entry.rubricPath || path.join(entry.inputDir, "..", "case-rubric.json")),
        rubric: readJson(path.resolve(entry.rubricPath || path.join(entry.inputDir, "..", "case-rubric.json")))
      };
    }
    return resolveCase(entry, index);
  });
}

function applyModeDefaults(config) {
  const mode = String(config.mode || "overnight").trim().toLowerCase();
  const defaults = MODE_DEFAULTS[mode] || {};
  return {
    ...config,
    mode,
    runsPerCasePerModel: config.runsPerCasePerModel !== undefined ? config.runsPerCasePerModel : defaults.runsPerCasePerModel,
    useVisualNarrator: config.useVisualNarrator !== undefined ? config.useVisualNarrator : defaults.useVisualNarrator,
    useProcessVisualizer: config.useProcessVisualizer !== undefined ? config.useProcessVisualizer : defaults.useProcessVisualizer
  };
}

function enforceRuntimeGuard(config, cases) {
  if (config.mode !== "overnight") return;
  if (config.runsPerCasePerModel > 2) {
    throw new Error("Overnight mode allows at most 2 runs per case per model.");
  }
  if (cases.length > 8) {
    throw new Error("Overnight mode expects at most 8 benchmark cases.");
  }
}

function loadBenchmarkConfig(configPath) {
  const absolute = path.resolve(configPath || DEFAULT_CONFIG_PATH);
  const raw = readJson(absolute);
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    throw new Error("Benchmark config must define a non-empty models array.");
  }

  const withDefaults = applyModeDefaults({
    scope: "plan-only",
    provider: "ollama",
    mode: "overnight",
    outputDir: path.join(__dirname, "benchmarks", "runs"),
    ollamaUrl: "http://127.0.0.1:11434",
    useVisualNarrator: false,
    useProcessVisualizer: false,
    useExamples: true,
    useKnowledge: true,
    timeoutMs: 450000,
    retryPolicy: "none",
    ...raw,
    configPath: absolute
  });
  const cases = normalizeCases(withDefaults);
  enforceRuntimeGuard(withDefaults, cases);

  return {
    ...withDefaults,
    cases
  };
}

function defaultRunGenerator({ model, inputDir, outPath, config, runDir }) {
  const args = [
    path.join(__dirname, "plan-generator-cli.js"),
    "--input-dir",
    inputDir,
    "--out",
    outPath,
    "--model",
    model,
    "--ollama-url",
    config.ollamaUrl
  ];

  if (!config.useVisualNarrator) args.push("--no-vn");
  if (!config.useProcessVisualizer) args.push("--no-process-viz");
  if (!config.useExamples) args.push("--no-examples");
  if (!config.useKnowledge) args.push("--no-knowledge");

  const startedAt = Date.now();
  const child = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: config.timeoutMs,
    maxBuffer: 1024 * 1024 * 20
  });
  const durationMs = Date.now() - startedAt;

  writeText(path.join(runDir, "generator.stdout.log"), child.stdout || "");
  writeText(path.join(runDir, "generator.stderr.log"), child.stderr || "");

  return {
    status: child.status,
    signal: child.signal,
    stdout: child.stdout || "",
    stderr: child.stderr || "",
    timedOut: Boolean(child.error && child.error.code === "ETIMEDOUT"),
    durationMs
  };
}

function emptyChecker() {
  return {
    ok: false,
    jsonParseValid: false,
    schemaValid: false,
    validationErrors: ["Plan file was not created."],
    storyCoverageScore: null,
    artifactCounts: {
      entities: 0,
      associations: 0,
      enumerations: 0,
      pages: 0,
      microflows: 0,
      nanoflows: 0,
      workflows: 0
    },
    referenceIntegrity: { ok: false, issueCount: 0, issues: [] },
    stubFlags: { ok: false, flags: ["missing_plan_file"] }
  };
}

function emptyFeatureFit(rubric) {
  return {
    ok: false,
    rubricId: rubric.id || "",
    rubricTitle: rubric.title || "",
    featureFitScore: 0,
    domainFitScore: 0,
    relationshipFitScore: 0,
    pageTaskFitScore: 0,
    navigationFitScore: 0,
    mendixSuitabilityScore: 0,
    matchedRequirements: {},
    missingRequirements: {},
    unexpectedArtifacts: { forbiddenEntitiesPresent: [], entitiesOutsideAllowedSet: [], suitabilityPenalties: [] }
  };
}

function benchmarkTokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function buildGeneralizationMetrics({ plan, inputDir, featureFit }) {
  const storiesPath = path.join(inputDir, "user-stories.txt");
  const storyText = fs.existsSync(storiesPath) ? fs.readFileSync(storiesPath, "utf8") : "";
  const storyTokens = Array.from(new Set(benchmarkTokenize(storyText)));
  const entityNames = Array.isArray(plan && plan.domainModel && plan.domainModel.entities)
    ? plan.domainModel.entities.map((entity) => String(entity && entity.name || "").trim()).filter(Boolean)
    : [];
  const pageNames = Array.isArray(plan && plan.pages && plan.pages.specs)
    ? plan.pages.specs.map((page) => String(page && (page.name || page.ref) || "").trim()).filter(Boolean)
    : [];
  const mentionsTask = storyTokens.includes("task");
  const lexicalTargets = Array.from(new Set(storyTokens.filter((token) => !["want", "that", "with", "from", "user", "story"].includes(token))));
  const artifactText = `${entityNames.join(" ")} ${pageNames.join(" ")}`.toLowerCase();
  const lexicalHits = lexicalTargets.filter((token) => artifactText.includes(token));

  const taskEntities = mentionsTask ? [] : entityNames.filter((name) => /\btask\b/i.test(name));
  const taskPages = mentionsTask ? [] : pageNames.filter((name) => /\btask\b/i.test(name));
  const offDomainEntities = Array.isArray(featureFit && featureFit.unexpectedArtifacts && featureFit.unexpectedArtifacts.entitiesOutsideAllowedSet)
    ? featureFit.unexpectedArtifacts.entitiesOutsideAllowedSet.slice()
    : [];

  return {
    lexicalCoverageScore: lexicalTargets.length > 0 ? lexicalHits.length / lexicalTargets.length : 1,
    lexicalCoverageHits: lexicalHits,
    offDomainEntityContamination: Array.from(new Set(offDomainEntities.concat(taskEntities))),
    offDomainPageContamination: taskPages,
    rubricScoreDeltas: {
      domainMinusFeatureFit: Number(featureFit && featureFit.domainFitScore || 0) - Number(featureFit && featureFit.featureFitScore || 0),
      pagesMinusRelationships: Number(featureFit && featureFit.pageTaskFitScore || 0) - Number(featureFit && featureFit.relationshipFitScore || 0)
    }
  };
}

function buildRunRecord({ model, caseId, runIndex, runDir, generation, checker, featureFit, generalization }) {
  return {
    model,
    caseId,
    runId: `${caseId}-${model}-run-${String(runIndex).padStart(2, "0")}`,
    runIndex,
    runDir,
    completed: generation.status === 0,
    exitCode: generation.status,
    timedOut: generation.timedOut,
    durationMs: generation.durationMs,
    failureType: generation.status === 0 ? "" : inferFailureType(generation),
    checker,
    featureFit,
    generalization
  };
}

function summarizeRuns(runs, options = {}) {
  const succeeded = runs.filter((run) => run.completed);
  const durations = succeeded.map((run) => run.durationMs);
  const coverageValues = runs
    .map((run) => run.checker.storyCoverageScore)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const featureFitValues = runs
    .map((run) => run.featureFit.featureFitScore)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const lexicalCoverageValues = runs
    .map((run) => run.generalization && run.generalization.lexicalCoverageScore)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const contaminationCounts = runs.map((run) => {
    const entities = (run.generalization && run.generalization.offDomainEntityContamination) || [];
    const pages = (run.generalization && run.generalization.offDomainPageContamination) || [];
    return entities.length + pages.length;
  });

  return {
    label: options.label || "",
    runsAttempted: runs.length,
    runsSucceeded: succeeded.length,
    jsonValidityRate: mean(runs.map((run) => run.checker.jsonParseValid ? 1 : 0)),
    planValidationPassRate: mean(runs.map((run) => run.checker.schemaValid ? 1 : 0)),
    featureFit: {
      mean: mean(featureFitValues),
      min: featureFitValues.length ? Math.min(...featureFitValues) : 0,
      max: featureFitValues.length ? Math.max(...featureFitValues) : 0
    },
    generalization: {
      lexicalCoverageMean: mean(lexicalCoverageValues),
      contaminationMean: mean(contaminationCounts)
    },
    durationMs: {
      mean: mean(durations),
      median: median(durations),
      min: durations.length ? Math.min(...durations) : 0,
      max: durations.length ? Math.max(...durations) : 0,
      stddev: stddev(durations)
    },
    storyCoverage: {
      mean: mean(coverageValues),
      min: coverageValues.length ? Math.min(...coverageValues) : null
    },
    stubFlagRate: mean(runs.map((run) => run.checker.stubFlags && !run.checker.stubFlags.ok ? 1 : 0)),
    referenceIntegrityIssueRate: mean(
      runs.map((run) => run.checker.referenceIntegrity && !run.checker.referenceIntegrity.ok ? 1 : 0)
    ),
    consistency: analyzePlanConsistency(
      runs.map((run) => ({
        runId: run.runId,
        checker: run.checker,
        plan: run.plan || null
      })),
      { model: options.label || "" }
    )
  };
}

function summarizeCaseModel(caseDef, model, runs) {
  const summary = summarizeRuns(runs, { label: `${caseDef.id}:${model}` });
  const representative = runs.find((run) => run.featureFit && run.featureFit.ok) || runs[0] || null;

  return {
    caseId: caseDef.id,
    caseTitle: caseDef.title,
    model,
    ...summary,
    rubricBreakdown: representative
      ? {
          featureFitScore: representative.featureFit.featureFitScore,
          domainFitScore: representative.featureFit.domainFitScore,
          relationshipFitScore: representative.featureFit.relationshipFitScore,
          pageTaskFitScore: representative.featureFit.pageTaskFitScore,
          navigationFitScore: representative.featureFit.navigationFitScore,
          mendixSuitabilityScore: representative.featureFit.mendixSuitabilityScore,
          missingRequirements: representative.featureFit.missingRequirements,
          unexpectedArtifacts: representative.featureFit.unexpectedArtifacts
        }
      : null,
    generalizationBreakdown: representative ? representative.generalization : null
  };
}

function summarizeModelsAcrossCases(model, caseSummaries) {
  return {
    model,
    averageFeatureFit: mean(caseSummaries.map((item) => item.featureFit.mean)),
    minimumFeatureFit: caseSummaries.length ? Math.min(...caseSummaries.map((item) => item.featureFit.min)) : 0,
    averageJsonValidityRate: mean(caseSummaries.map((item) => item.jsonValidityRate)),
    averagePlanValidationPassRate: mean(caseSummaries.map((item) => item.planValidationPassRate)),
    averageTimeMs: mean(caseSummaries.map((item) => item.durationMs.mean)),
    averageStubFlagRate: mean(caseSummaries.map((item) => item.stubFlagRate)),
    averageReferenceIntegrityIssueRate: mean(caseSummaries.map((item) => item.referenceIntegrityIssueRate))
  };
}

function flattenMissingRequirements(missingRequirements = {}) {
  const out = [];
  for (const [key, values] of Object.entries(missingRequirements)) {
    for (const value of Array.isArray(values) ? values : []) {
      out.push(`${key}:${value}`);
    }
  }
  return out;
}

function buildCommonMisses(caseSummaries) {
  const models = caseSummaries.length;
  const counts = new Map();
  for (const summary of caseSummaries) {
    const misses = flattenMissingRequirements((summary.rubricBreakdown && summary.rubricBreakdown.missingRequirements) || {});
    for (const miss of misses) {
      counts.set(miss, (counts.get(miss) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count === models)
    .map(([miss]) => miss)
    .sort((a, b) => a.localeCompare(b));
}

function renderMarkdownReport({ config, metadata, caseSummariesByCase, aggregateSummaries }) {
  const lines = [
    "# Mendix Plan Benchmark Report",
    "",
    "## Controls",
    "",
    `- Generated at: ${metadata.generatedAt}`,
    `- Scope: ${config.scope}`,
    `- Provider: ${config.provider}`,
    `- Mode: ${config.mode}`,
    `- Cases: ${config.cases.length}`,
    `- Runs per case per model: ${config.runsPerCasePerModel}`,
    `- Ollama URL: ${config.ollamaUrl}`,
    `- Visual Narrator enabled: ${config.useVisualNarrator}`,
    `- Process Visualizer enabled: ${config.useProcessVisualizer}`,
    `- Example plans enabled: ${config.useExamples}`,
    `- Knowledge enabled: ${config.useKnowledge}`,
    `- Timeout (ms): ${config.timeoutMs}`,
    `- Retry policy: ${config.retryPolicy}`,
    `- Host: ${metadata.hostName}`,
    `- Git commit: ${metadata.git.commitSha || "(unknown)"}`,
    `- Git dirty: ${metadata.git.dirty}`
  ];

  for (const [caseId, caseSummaries] of Object.entries(caseSummariesByCase)) {
    const caseTitle = caseSummaries[0] ? caseSummaries[0].caseTitle : caseId;
    lines.push("", `## Case: ${caseTitle}`, "");
    lines.push("| Model | Feature fit | Domain | Relationships | Pages | Navigation | Suitability | Lexical coverage | Contamination | Plan valid | Mean time (s) | Key misses |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const summary of caseSummaries) {
      const breakdown = summary.rubricBreakdown || {};
      const generalization = summary.generalizationBreakdown || {};
      const keyMisses = flattenMissingRequirements(breakdown.missingRequirements || {}).slice(0, 3).join(", ") || "(none)";
      lines.push(
        `| ${summary.model} | ${summary.featureFit.mean.toFixed(2)} | ${Number(breakdown.domainFitScore || 0).toFixed(2)} | ${Number(breakdown.relationshipFitScore || 0).toFixed(2)} | ${Number(breakdown.pageTaskFitScore || 0).toFixed(2)} | ${Number(breakdown.navigationFitScore || 0).toFixed(2)} | ${Number(breakdown.mendixSuitabilityScore || 0).toFixed(2)} | ${Number(generalization.lexicalCoverageScore || 0).toFixed(2)} | ${(((generalization.offDomainEntityContamination || []).length + (generalization.offDomainPageContamination || []).length)).toFixed(0)} | ${summary.planValidationPassRate.toFixed(2)} | ${(summary.durationMs.mean / 1000).toFixed(2)} | ${keyMisses} |`
      );
    }
    const commonMisses = buildCommonMisses(caseSummaries);
    lines.push("", `Shared misses across models: ${commonMisses.join(", ") || "(none)"}`);
  }

  lines.push("", "## Final Summary", "");
  lines.push("| Model | Avg feature fit | Min feature fit | Avg plan valid | Avg time (s) | Avg stub rate | Avg ref issue rate |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const summary of aggregateSummaries) {
    lines.push(
      `| ${summary.model} | ${summary.averageFeatureFit.toFixed(2)} | ${summary.minimumFeatureFit.toFixed(2)} | ${summary.averagePlanValidationPassRate.toFixed(2)} | ${(summary.averageTimeMs / 1000).toFixed(2)} | ${summary.averageStubFlagRate.toFixed(2)} | ${summary.averageReferenceIntegrityIssueRate.toFixed(2)} |`
    );
  }

  return lines.join("\n");
}

async function runBenchmark(config, options = {}) {
  const normalizedConfig =
    Array.isArray(config.cases) && config.cases.length > 0 && config.cases[0] && config.cases[0].inputDir
      ? config
      : (() => {
          const withMode = applyModeDefaults({ ...config });
          const cases = normalizeCases(withMode);
          enforceRuntimeGuard(withMode, cases);
          return { ...withMode, cases };
        })();
  const runner = options.runGenerator || defaultRunGenerator;
  const outputRoot = path.resolve(normalizedConfig.outputDir);
  const benchmarkDir = path.join(outputRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(benchmarkDir, { recursive: true });

  const metadata = {
    generatedAt: new Date().toISOString(),
    hostName: os.hostname(),
    configPath: config.configPath || "",
    git: collectGitMetadata(process.cwd())
  };

  const results = {
    ok: true,
    scope: normalizedConfig.scope,
    provider: normalizedConfig.provider,
    mode: normalizedConfig.mode,
    benchmarkDir,
    config: {
      models: normalizedConfig.models.slice(),
      mode: normalizedConfig.mode,
      cases: normalizedConfig.cases.map((item) => ({
        id: item.id,
        title: item.title,
        caseDir: item.caseDir,
        inputDir: item.inputDir,
        rubricPath: item.rubricPath
      })),
      runsPerCasePerModel: normalizedConfig.runsPerCasePerModel,
      ollamaUrl: normalizedConfig.ollamaUrl,
      useVisualNarrator: normalizedConfig.useVisualNarrator,
      useExamples: normalizedConfig.useExamples,
      useKnowledge: normalizedConfig.useKnowledge,
      timeoutMs: normalizedConfig.timeoutMs,
      outputDir: outputRoot,
      retryPolicy: normalizedConfig.retryPolicy
    },
    metadata,
    cases: [],
    aggregateModels: []
  };

  const aggregateByModel = new Map();

  for (const caseDef of normalizedConfig.cases) {
    const caseDir = path.join(benchmarkDir, "cases", caseDef.id);
    fs.mkdirSync(caseDir, { recursive: true });
    const caseResults = {
      caseId: caseDef.id,
      caseTitle: caseDef.title,
      inputDir: caseDef.inputDir,
      rubricPath: caseDef.rubricPath,
      models: []
    };

    for (const model of normalizedConfig.models) {
      const modelSlug = String(model).replace(/[^a-zA-Z0-9._-]+/g, "_");
      const modelDir = path.join(caseDir, modelSlug);
      fs.mkdirSync(modelDir, { recursive: true });
      const runs = [];

      for (let runIndex = 1; runIndex <= normalizedConfig.runsPerCasePerModel; runIndex += 1) {
        const runDir = path.join(modelDir, `run-${String(runIndex).padStart(2, "0")}`);
        fs.mkdirSync(runDir, { recursive: true });
        const planPath = path.join(runDir, "plan.json");

        const generation = await runner({
          model,
          inputDir: caseDef.inputDir,
          outPath: planPath,
          config: normalizedConfig,
          runDir,
          runIndex,
          caseDef
        });

        let checker = emptyChecker();
        let featureFit = emptyFeatureFit(caseDef.rubric);
        let generalization = buildGeneralizationMetrics({ plan: null, inputDir: caseDef.inputDir, featureFit });
        let plan = null;

        if (fs.existsSync(planPath)) {
          checker = checkPlanFile(planPath, { inputDir: caseDef.inputDir });
          if (checker.jsonParseValid) {
            plan = readJson(planPath);
            featureFit = scorePlanFileAgainstRubric({
              planPath,
              rubricPath: caseDef.rubricPath,
              inputDir: caseDef.inputDir
            });
            generalization = buildGeneralizationMetrics({ plan, inputDir: caseDef.inputDir, featureFit });
            writeJson(path.join(runDir, "feature-fit-result.json"), featureFit);
            writeJson(path.join(runDir, "generalization-result.json"), generalization);
          }
        }

        const runRecord = buildRunRecord({
          model,
          caseId: caseDef.id,
          runIndex,
          runDir,
          generation,
          checker,
          featureFit,
          generalization
        });
        runRecord.plan = plan;
        writeJson(path.join(runDir, "run-result.json"), runRecord);
        runs.push(runRecord);
      }

      const summary = summarizeCaseModel(caseDef, model, runs);
      writeJson(path.join(modelDir, "model-summary.json"), summary);
      caseResults.models.push({
        ...summary,
        runs: runs.map((run) => ({
          runId: run.runId,
          runIndex: run.runIndex,
          runDir: run.runDir,
          completed: run.completed,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          durationMs: run.durationMs,
          failureType: run.failureType,
          checker: run.checker,
          featureFit: run.featureFit,
          generalization: run.generalization
        }))
      });

      if (!aggregateByModel.has(model)) aggregateByModel.set(model, []);
      aggregateByModel.get(model).push(summary);
    }

    writeJson(path.join(caseDir, "case-summary.json"), caseResults);
    results.cases.push(caseResults);
  }

  results.aggregateModels = Array.from(aggregateByModel.entries())
    .map(([model, summaries]) => summarizeModelsAcrossCases(model, summaries))
    .sort((a, b) => a.model.localeCompare(b.model));

  const caseSummariesByCase = {};
  for (const caseResult of results.cases) {
    caseSummariesByCase[caseResult.caseId] = caseResult.models;
  }

  const resultsPath = path.join(benchmarkDir, "benchmark-results.json");
  const reportPath = path.join(benchmarkDir, "benchmark-report.md");
  writeJson(resultsPath, results);
  writeText(
    reportPath,
    renderMarkdownReport({
      config: results.config,
      metadata,
      caseSummariesByCase,
      aggregateSummaries: results.aggregateModels
    })
  );

  return {
    benchmarkDir,
    resultsPath,
    reportPath,
    results
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const config = loadBenchmarkConfig(args.configPath);
  const out = await runBenchmark(config);
  console.log(
    JSON.stringify(
      {
        ok: true,
        benchmarkDir: out.benchmarkDir,
        resultsPath: out.resultsPath,
        reportPath: out.reportPath
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Failed: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_CASES_ROOT,
  DEFAULT_CONFIG_PATH,
  applyModeDefaults,
  collectGitMetadata,
  defaultRunGenerator,
  discoverCaseDirs,
  enforceRuntimeGuard,
  inferFailureType,
  loadBenchmarkConfig,
  mean,
  median,
  parseArgs,
  printHelp,
  renderMarkdownReport,
  runBenchmark,
  stddev,
  summarizeCaseModel,
  summarizeModelsAcrossCases,
  summarizeRuns
};
