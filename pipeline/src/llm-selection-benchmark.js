const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_SECONDS = 20 * 60;
const DEFAULT_OUT_DIR = path.join(process.cwd(), "artifacts", "llm-selection");
const DEFAULT_DATASETS = ["matching", "collaboration", "sports", "cinema"];

const DATASET_FILES = {
  matching: path.join(process.cwd(), "thesis_data", "matching_user_stories.txt"),
  collaboration: path.join(process.cwd(), "thesis_data", "collaboration_user_stories.txt"),
  sports: path.join(process.cwd(), "thesis_data", "sports_user_stories.txt"),
  cinema: path.join(process.cwd(), "thesis_data", "cinema_user_stories.txt")
};

const DEFAULT_MODEL_SPECS = [
  { label: "llama3", alternatives: ["llama3", "llama3:latest", "llama3:8b"] },
  {
    label: "qwen2.5-coder:7b",
    alternatives: ["qwen2.5-coder:7b", "qwen2.5-coder:latest", "qwen2.5-coder"]
  },
  { label: "qwen2.5:7b", alternatives: ["qwen2.5:7b", "qwen2.5:latest", "qwen2.5"] },
  { label: "mistral:7b", alternatives: ["mistral:7b", "mistral:latest", "mistral"] },
  { label: "gemma3:4b", alternatives: ["gemma3:4b", "gemma3:latest", "gemma3"] },
  { label: "gemma4:e4b", alternatives: ["gemma4:e4b", "gemma4:latest", "gemma4"] },
  { label: "deepseek-r1", alternatives: ["deepseek-r1", "deepseek-r1:latest"] },
  { label: "phi4", alternatives: ["phi4", "phi4:latest"] }
];

const RUN_COLUMNS = [
  "dataset",
  "dataset_story_count",
  "model",
  "ollama_tag",
  "completed",
  "failure_type",
  "runtime_seconds",
  "output_plan_bytes",
  "valid_json",
  "has_app",
  "has_domain_model",
  "entity_count",
  "association_count",
  "attribute_count",
  "page_count",
  "microflow_count",
  "nanoflow_count",
  "workflow_count",
  "security_role_count",
  "story_coverage_ratio",
  "unsupported_section_count",
  "unresolved_reference_count",
  "ollama_prompt_tokens",
  "ollama_output_tokens",
  "ollama_total_duration_ms",
  "tokens_per_second",
  "timeout_seconds",
  "notes"
];

const SUMMARY_COLUMNS = [
  "model",
  "runs_completed",
  "runs_total",
  "completion_rate",
  "mean_runtime_seconds",
  "valid_json_rate",
  "mean_story_coverage_ratio",
  "mean_entity_count",
  "mean_page_count",
  "mean_unresolved_reference_count",
  "mean_tokens_per_second",
  "feasibility_label",
  "selection_note"
];

function parseArgs(argv) {
  const out = {
    models: null,
    datasets: DEFAULT_DATASETS.slice(),
    outDir: DEFAULT_OUT_DIR,
    ollamaUrl: DEFAULT_OLLAMA_URL,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    useVisualNarrator: true,
    useProcessVisualizer: true,
    stopOnSharedFailure: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--models") out.models = splitCsv(argv[++i] || "");
    else if (arg.startsWith("--models=")) out.models = splitCsv(arg.slice("--models=".length));
    else if (arg === "--datasets") out.datasets = splitCsv(argv[++i] || "");
    else if (arg.startsWith("--datasets=")) out.datasets = splitCsv(arg.slice("--datasets=".length));
    else if (arg === "--out-dir") out.outDir = argv[++i] || "";
    else if (arg.startsWith("--out-dir=")) out.outDir = arg.slice("--out-dir=".length);
    else if (arg === "--ollama-url") out.ollamaUrl = argv[++i] || "";
    else if (arg.startsWith("--ollama-url=")) out.ollamaUrl = arg.slice("--ollama-url=".length);
    else if (arg === "--timeout-seconds") out.timeoutSeconds = Number(argv[++i] || "");
    else if (arg.startsWith("--timeout-seconds=")) out.timeoutSeconds = Number(arg.slice("--timeout-seconds=".length));
    else if (arg === "--no-vn") out.useVisualNarrator = false;
    else if (arg === "--no-process-viz") out.useProcessVisualizer = false;
    else if (arg === "--stop-on-shared-failure") out.stopOnSharedFailure = true;
    else if (arg === "--continue-on-shared-failure") out.stopOnSharedFailure = false;
  }

  return out;
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node pipeline/llm-selection-benchmark.js [options]",
      "",
      "Options:",
      "  --models <csv>             Model tags to compare. Defaults to llama3,qwen2.5-coder:7b,qwen2.5:7b,mistral:7b,gemma3:4b,gemma4:e4b,deepseek-r1,phi4",
      "  --datasets <csv>           Dataset ids to run. Defaults to matching,collaboration,sports,cinema",
      `  --out-dir <path>           Output directory. Default: ${DEFAULT_OUT_DIR}`,
      `  --ollama-url <url>         Ollama base URL. Default: ${DEFAULT_OLLAMA_URL}`,
      `  --timeout-seconds <n>      Timeout per model/dataset run. Default: ${DEFAULT_TIMEOUT_SECONDS}`,
      "  --no-vn                    Disable Visual Narrator preprocessing for faster selection runs",
      "  --no-process-viz           Disable Process Visualizer preprocessing for faster selection runs",
      "  --stop-on-shared-failure   Stop after the first Visual Narrator or Process Visualizer failure",
      "  --continue-on-shared-failure Keep running all models even if a shared preprocessing stage fails (default)",
      "  --help                     Show this help"
    ].join("\n")
  );
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(value), "utf8");
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_err) {
    return null;
  }
}

function readTextIfExists(filePath) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function countStories(filePath) {
  return readTextIfExists(filePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(filePath, columns, rows) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(","));
  }
  writeText(filePath, `${lines.join("\n")}\n`);
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

async function fetchOllamaTags(ollamaUrl) {
  const url = `${String(ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/$/, "")}/api/tags`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Ollama tags request failed (${response.status})`);
  }
  const payload = await response.json();
  return Array.isArray(payload.models)
    ? payload.models.map((model) => String(model && model.name ? model.name : "")).filter(Boolean)
    : [];
}

function buildModelSpecs(args) {
  if (!args.models || args.models.length === 0) return DEFAULT_MODEL_SPECS;
  return args.models.map((model) => ({ label: model, alternatives: [model] }));
}

function resolveModelTag(spec, availableTags) {
  const available = availableTags.slice();
  for (const candidate of spec.alternatives || []) {
    if (available.includes(candidate)) return candidate;
  }

  const baseNames = (spec.alternatives || [spec.label])
    .map((candidate) => String(candidate).split(":")[0])
    .filter(Boolean);

  for (const baseName of baseNames) {
    const matches = available
      .filter((tag) => tag === baseName || tag.startsWith(`${baseName}:`))
      .sort((a, b) => scoreModelMatch(a, spec.label) - scoreModelMatch(b, spec.label) || a.localeCompare(b));
    if (matches.length > 0) return matches[0];
  }

  return "";
}

function scoreModelMatch(tag, requested) {
  const lower = String(tag).toLowerCase();
  const requestedLower = String(requested).toLowerCase();
  let score = lower === requestedLower ? 0 : 50;
  if (requestedLower.includes("7b") && lower.includes("7b")) score -= 20;
  if (requestedLower.includes("4b") && lower.includes("4b")) score -= 20;
  if (requestedLower.includes("latest") && lower.includes("latest")) score -= 10;
  if (lower.includes("32b") || lower.includes("70b") || lower.includes("405b")) score += 30;
  return score;
}

function prepareInputFolder({ dataset, storiesPath, outputRoot }) {
  const inputDir = path.join(outputRoot, "inputs", dataset);
  ensureDir(inputDir);
  const stories = readTextIfExists(storiesPath).trim();
  writeText(path.join(inputDir, "user-stories.txt"), `${stories}\n`);
  writeText(
    path.join(inputDir, "app-context.json"),
    JSON.stringify(
      {
        moduleName: "MyFirstModule",
        createApp: true,
        createAppNamePrefix: `LLMSelection${toPascalCase(dataset)}`,
        createAppRepositoryType: "git",
        layoutQualifiedName: "Atlas_Core.Atlas_Default",
        homePageRef: "home",
        commit: false
      },
      null,
      2
    )
  );
  return inputDir;
}

function toPascalCase(value) {
  return String(value || "")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function buildMissingModelRow({ dataset, storyCount, model, timeoutSeconds, notes }) {
  return baseRow({
    dataset,
    storyCount,
    model,
    ollamaTag: "",
    completed: false,
    failureType: "model_missing",
    timeoutSeconds,
    notes
  });
}

function buildUnavailableRow({ dataset, storyCount, model, timeoutSeconds, notes }) {
  return baseRow({
    dataset,
    storyCount,
    model,
    ollamaTag: "",
    completed: false,
    failureType: "ollama_unavailable",
    timeoutSeconds,
    notes
  });
}

function baseRow({ dataset, storyCount, model, ollamaTag, completed, failureType, timeoutSeconds, notes }) {
  return {
    dataset,
    dataset_story_count: storyCount,
    model,
    ollama_tag: ollamaTag,
    completed: completed ? "true" : "false",
    failure_type: failureType,
    runtime_seconds: "",
    output_plan_bytes: 0,
    valid_json: "false",
    has_app: "false",
    has_domain_model: "false",
    entity_count: 0,
    association_count: 0,
    attribute_count: 0,
    page_count: 0,
    microflow_count: 0,
    nanoflow_count: 0,
    workflow_count: 0,
    security_role_count: 0,
    story_coverage_ratio: "",
    unsupported_section_count: "",
    unresolved_reference_count: "",
    ollama_prompt_tokens: "",
    ollama_output_tokens: "",
    ollama_total_duration_ms: "",
    tokens_per_second: "",
    timeout_seconds: timeoutSeconds,
    notes
  };
}

function runPlanGeneration({
  dataset,
  storyCount,
  modelLabel,
  ollamaTag,
  inputDir,
  runDir,
  timeoutSeconds,
  ollamaUrl,
  useVisualNarrator,
  useProcessVisualizer
}) {
  fs.rmSync(runDir, { recursive: true, force: true });
  ensureDir(runDir);
  const planPath = path.join(runDir, "plan.json");
  const cliPath = path.join(process.cwd(), "pipeline", "plan-generator-cli.js");
  const args = [
    cliPath,
    "--input-dir",
    inputDir,
    "--out",
    planPath,
    "--model",
    ollamaTag,
    "--ollama-url",
    ollamaUrl
  ];
  if (!useVisualNarrator) args.push("--no-vn");
  if (!useProcessVisualizer) args.push("--no-process-viz");

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    maxBuffer: 64 * 1024 * 1024
  });
  const runtimeSeconds = (Date.now() - startedAt) / 1000;

  writeText(path.join(runDir, "stdout.log"), result.stdout || "");
  writeText(path.join(runDir, "stderr.log"), result.stderr || "");
  writeText(path.join(runDir, "command.txt"), `${process.execPath} ${args.map(shellQuote).join(" ")}\n`);

  const reportPath = path.join(runDir, "generation-report.json");
  const report = readJsonIfExists(reportPath);
  const planText = readTextIfExists(planPath);
  const planBytes = fs.existsSync(planPath) ? fs.statSync(planPath).size : 0;

  let plan = null;
  let validJson = false;
  if (planText) {
    try {
      plan = JSON.parse(planText);
      validJson = Boolean(plan && typeof plan === "object");
    } catch (_err) {
      validJson = false;
    }
  }

  const failureType = inferFailureType({ result, validJson, plan, planBytes });
  const completed = failureType === "ok";
  const metrics = inspectPlan(plan);
  const ollamaMetrics = extractOllamaMetrics(report, runtimeSeconds);
  const coverageRatio =
    report && report.coverage && Number.isFinite(Number(report.coverage.score))
      ? Number(report.coverage.score)
      : estimateStoryCoverage(plan, storyCount);

  return {
    dataset,
    dataset_story_count: storyCount,
    model: modelLabel,
    ollama_tag: ollamaTag,
    completed: completed ? "true" : "false",
    failure_type: failureType,
    runtime_seconds: formatNumber(runtimeSeconds, 3),
    output_plan_bytes: planBytes,
    valid_json: validJson ? "true" : "false",
    has_app: metrics.hasApp ? "true" : "false",
    has_domain_model: metrics.hasDomainModel ? "true" : "false",
    entity_count: metrics.entityCount,
    association_count: metrics.associationCount,
    attribute_count: metrics.attributeCount,
    page_count: metrics.pageCount,
    microflow_count: metrics.microflowCount,
    nanoflow_count: metrics.nanoflowCount,
    workflow_count: metrics.workflowCount,
    security_role_count: metrics.securityRoleCount,
    story_coverage_ratio: coverageRatio === "" ? "" : formatNumber(coverageRatio, 3),
    unsupported_section_count: metrics.unsupportedSectionCount,
    unresolved_reference_count: metrics.unresolvedReferenceCount,
    ollama_prompt_tokens: ollamaMetrics.promptTokens,
    ollama_output_tokens: ollamaMetrics.outputTokens,
    ollama_total_duration_ms: ollamaMetrics.totalDurationMs,
    tokens_per_second: ollamaMetrics.tokensPerSecond,
    timeout_seconds: timeoutSeconds,
    notes: buildRunNotes(result, report)
  };
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function inferFailureType({ result, validJson, plan, planBytes }) {
  if (result.error && result.error.code === "ETIMEDOUT") return "timeout";
  if (result.signal === "SIGTERM" && result.status === null) return "timeout";
  const combined = `${result.stderr || ""}\n${result.stdout || ""}`;
  if (/out of memory|cannot allocate memory|memory allocation|killed/i.test(combined)) return "resource_failure";
  if (result.status !== 0) return "generation_error";
  if (!planBytes) return "empty_plan";
  if (!validJson) return "invalid_json";
  if (!plan || typeof plan !== "object") return "empty_plan";
  return "ok";
}

function buildRunNotes(result, report) {
  const notes = [];
  if (result.status !== 0 && result.status !== null) notes.push(`exit=${result.status}`);
  if (result.signal) notes.push(`signal=${result.signal}`);
  const combined = `${result.stderr || ""}\n${result.stdout || ""}`;
  if (/Process Visualizer exited with code|Process Visualizer .*failed|run_process_visualizer/i.test(combined)) {
    notes.push("process_visualizer_failed");
  }
  if (/Visual Narrator .*failed|run_visual_narrator/i.test(combined)) {
    notes.push("visual_narrator_failed");
  }
  if (report && Array.isArray(report.warnings) && report.warnings.length > 0) {
    notes.push(`warnings=${report.warnings.length}`);
  }
  return notes.join("; ");
}

function extractOllamaMetrics(report, runtimeSeconds) {
  const ollama = report && report.ollama && typeof report.ollama === "object" ? report.ollama : {};
  const promptTokens = toNumberOrBlank(ollama.promptEvalCount);
  const outputTokens = toNumberOrBlank(ollama.evalCount);
  const totalDurationMs = toNumberOrBlank(
    Number.isFinite(Number(ollama.totalDuration)) ? Number(ollama.totalDuration) / 1e6 : ""
  );
  const tokensPerSecond =
    outputTokens !== "" && Number(outputTokens) > 0 && runtimeSeconds > 0
      ? formatNumber(Number(outputTokens) / runtimeSeconds, 3)
      : "";
  return {
    promptTokens,
    outputTokens,
    totalDurationMs: totalDurationMs === "" ? "" : formatNumber(totalDurationMs, 3),
    tokensPerSecond
  };
}

function inspectPlan(plan) {
  const metrics = {
    hasApp: Boolean(plan && plan.app && typeof plan.app === "object"),
    hasDomainModel: Boolean(plan && plan.domainModel && typeof plan.domainModel === "object"),
    entityCount: 0,
    associationCount: 0,
    attributeCount: 0,
    pageCount: 0,
    microflowCount: 0,
    nanoflowCount: 0,
    workflowCount: 0,
    securityRoleCount: 0,
    unsupportedSectionCount: 0,
    unresolvedReferenceCount: 0
  };

  if (!plan || typeof plan !== "object") return metrics;

  const allowedSections = new Set([
    "meta",
    "app",
    "execution",
    "domainModel",
    "security",
    "pages",
    "microflows",
    "nanoflows",
    "workflows",
    "verification"
  ]);
  metrics.unsupportedSectionCount = Object.keys(plan).filter((key) => !allowedSections.has(key)).length;

  const entities = Array.isArray(plan.domainModel && plan.domainModel.entities) ? plan.domainModel.entities : [];
  const associations = Array.isArray(plan.domainModel && plan.domainModel.associations) ? plan.domainModel.associations : [];
  const pages = specs(plan.pages);
  const microflows = specs(plan.microflows);
  const nanoflows = specs(plan.nanoflows);
  const workflows = specs(plan.workflows);

  metrics.entityCount = entities.length;
  metrics.associationCount = associations.length;
  metrics.attributeCount = entities.reduce((sum, entity) => sum + (Array.isArray(entity.attributes) ? entity.attributes.length : 0), 0);
  metrics.pageCount = pages.length;
  metrics.microflowCount = microflows.length;
  metrics.nanoflowCount = nanoflows.length;
  metrics.workflowCount = workflows.length;
  metrics.securityRoleCount = countSecurityRoles(plan.security);
  metrics.unresolvedReferenceCount = countUnresolvedReferences({ plan, entities, associations, pages, microflows, nanoflows, workflows });

  return metrics;
}

function specs(section) {
  if (Array.isArray(section)) return section;
  if (section && Array.isArray(section.specs)) return section.specs;
  return [];
}

function countSecurityRoles(security) {
  if (!security || typeof security !== "object") return 0;
  const moduleRoles = Array.isArray(security.moduleRoles) ? security.moduleRoles.length : 0;
  const userRoles = Array.isArray(security.userRoles) ? security.userRoles.length : 0;
  return Math.max(moduleRoles, userRoles);
}

function countUnresolvedReferences({ plan, entities, associations, pages, microflows, nanoflows, workflows }) {
  const entityNames = new Set(entities.map((entity) => normalizeRef(entity && entity.name)).filter(Boolean));
  const pageRefs = new Set();
  for (const page of pages) {
    if (page && page.ref) pageRefs.add(String(page.ref));
    if (page && page.name) pageRefs.add(String(page.name));
  }
  const microflowRefs = new Set(microflows.map((flow) => String((flow && (flow.ref || flow.name)) || "")).filter(Boolean));
  const nanoflowRefs = new Set(nanoflows.map((flow) => String((flow && (flow.ref || flow.name)) || "")).filter(Boolean));
  const workflowRefs = new Set(workflows.map((flow) => String((flow && (flow.ref || flow.name)) || "")).filter(Boolean));

  let unresolved = 0;
  for (const association of associations) {
    for (const key of ["parent", "child", "source", "target", "from", "to", "owner", "entity"]) {
      const ref = normalizeRef(association && association[key]);
      if (ref && !entityNames.has(ref)) unresolved += 1;
    }
  }

  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, raw] of Object.entries(value)) {
      if (key === "entityRef" && raw && !isSystemRef(raw) && !entityNames.has(normalizeRef(raw))) unresolved += 1;
      if ((key === "targetPageRef" || key === "pageRef" || key === "rowClickTargetPageRef") && raw && !pageRefs.has(String(raw))) {
        unresolved += 1;
      }
      if (key === "microflowRef" && raw && !microflowRefs.has(String(raw))) unresolved += 1;
      if (key === "nanoflowRef" && raw && !nanoflowRefs.has(String(raw))) unresolved += 1;
      if (key === "workflowRef" && raw && !workflowRefs.has(String(raw))) unresolved += 1;
      walk(raw);
    }
  };

  walk(plan.pages);
  walk(plan.microflows);
  walk(plan.nanoflows);
  walk(plan.workflows);
  walk(plan.app && plan.app.navigation);
  return unresolved;
}

function normalizeRef(value) {
  if (!value) return "";
  const text = String(value).trim();
  if (!text) return "";
  const parts = text.split(".");
  return parts[parts.length - 1];
}

function isSystemRef(value) {
  return String(value || "").startsWith("System.");
}

function estimateStoryCoverage(plan, storyCount) {
  if (!plan || !storyCount) return "";
  const artifactCount =
    specs(plan.pages).length +
    specs(plan.microflows).length +
    specs(plan.nanoflows).length +
    specs(plan.workflows).length +
    (Array.isArray(plan.domainModel && plan.domainModel.entities) ? plan.domainModel.entities.length : 0);
  return Math.min(1, artifactCount / storyCount);
}

function toNumberOrBlank(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : "";
}

function formatNumber(value, decimals) {
  if (value === "" || value === null || value === undefined) return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return number.toFixed(decimals);
}

function mean(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (!finite.length) return "";
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function summarizeRows(rows, modelLabels) {
  return modelLabels.map((model) => {
    const modelRows = rows.filter((row) => row.model === model);
    const completedRows = modelRows.filter((row) => row.completed === "true");
    const validJsonRows = modelRows.filter((row) => row.valid_json === "true");
    const completionRate = modelRows.length ? completedRows.length / modelRows.length : 0;
    const validJsonRate = modelRows.length ? validJsonRows.length / modelRows.length : 0;
    const feasibilityLabel = labelFeasibility({ modelRows, completionRate, validJsonRate });
    return {
      model,
      runs_completed: completedRows.length,
      runs_total: modelRows.length,
      completion_rate: formatNumber(completionRate, 3),
      mean_runtime_seconds: formatNumber(mean(completedRows.map((row) => row.runtime_seconds)), 3),
      valid_json_rate: formatNumber(validJsonRate, 3),
      mean_story_coverage_ratio: formatNumber(mean(completedRows.map((row) => row.story_coverage_ratio)), 3),
      mean_entity_count: formatNumber(mean(completedRows.map((row) => row.entity_count)), 3),
      mean_page_count: formatNumber(mean(completedRows.map((row) => row.page_count)), 3),
      mean_unresolved_reference_count: formatNumber(mean(completedRows.map((row) => row.unresolved_reference_count)), 3),
      mean_tokens_per_second: formatNumber(mean(completedRows.map((row) => row.tokens_per_second)), 3),
      feasibility_label: feasibilityLabel,
      selection_note: buildSelectionNote({ modelRows, completionRate, validJsonRate, feasibilityLabel })
    };
  });
}

function labelFeasibility({ modelRows, completionRate, validJsonRate }) {
  if (modelRows.every((row) => row.failure_type === "model_missing")) return "not installed";
  if (modelRows.every((row) => row.failure_type === "ollama_unavailable")) return "ollama unavailable";
  if (modelRows.some((row) => row.failure_type === "resource_failure")) return "resource failure";
  if (modelRows.some((row) => row.failure_type === "timeout")) return "too slow";
  if (completionRate === 1 && validJsonRate === 1) return "feasible";
  if (completionRate > 0) return "partially feasible";
  return "not feasible";
}

function buildSelectionNote({ modelRows, completionRate, validJsonRate, feasibilityLabel }) {
  if (feasibilityLabel === "feasible") return "completed both lightweight selection cases";
  if (feasibilityLabel === "not installed") return "requested model tag was not available locally";
  if (feasibilityLabel === "ollama unavailable") return "Ollama was not reachable during benchmark setup";
  const failures = Array.from(new Set(modelRows.map((row) => row.failure_type).filter((type) => type && type !== "ok")));
  return `completion=${formatNumber(completionRate, 3)} valid_json=${formatNumber(validJsonRate, 3)} failures=${failures.join("|")}`;
}

function logRunOutcome(row) {
  const runtime = row.runtime_seconds ? `${row.runtime_seconds}s` : "n/a";
  const coverage = row.story_coverage_ratio ? ` coverage=${row.story_coverage_ratio}` : "";
  console.error(
    `[llm-selection] ${row.dataset}/${row.model}: ${row.failure_type} completed=${row.completed} runtime=${runtime}${coverage}`
  );
}

function isSharedPreprocessingFailure(row, args) {
  const notes = String(row.notes || "");
  return (
    row.failure_type === "generation_error" &&
    ((args.useProcessVisualizer && notes.includes("process_visualizer_failed")) ||
      (args.useVisualNarrator && notes.includes("visual_narrator_failed")))
  );
}

function sharedFailureMessage(row) {
  const notes = String(row.notes || "");
  if (notes.includes("process_visualizer_failed")) {
    return [
      `Process Visualizer failed during ${row.dataset}/${row.model}.`,
      "This is a shared preprocessing failure, so continuing would probably fail every remaining model.",
      "Rerun with --no-process-viz for a plan-generation-only selection benchmark, or add --continue-on-shared-failure to force all runs."
    ].join(" ");
  }
  if (notes.includes("visual_narrator_failed")) {
    return [
      `Visual Narrator failed during ${row.dataset}/${row.model}.`,
      "This is a shared preprocessing failure, so continuing would probably fail every remaining model.",
      "Rerun with --no-vn for a plan-generation-only selection benchmark, or add --continue-on-shared-failure to force all runs."
    ].join(" ");
  }
  return `Shared preprocessing failed during ${row.dataset}/${row.model}.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.outDir) throw new Error("--out-dir is required.");
  if (!Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds <= 0) {
    throw new Error("--timeout-seconds must be a positive number.");
  }

  const outputRoot = path.resolve(args.outDir);
  ensureDir(outputRoot);

  let availableTags = [];
  let ollamaError = "";
  try {
    availableTags = await fetchOllamaTags(args.ollamaUrl || DEFAULT_OLLAMA_URL);
  } catch (err) {
    ollamaError = err && err.message ? err.message : String(err);
  }

  const modelSpecs = buildModelSpecs(args);
  const rows = [];
  const modelLabels = modelSpecs.map((spec) => spec.label);
  const datasetInputs = {};
  const runsCsvPath = path.join(outputRoot, "llm-selection-runs.csv");
  const summaryCsvPath = path.join(outputRoot, "llm-selection-summary.csv");

  function flushCsvOutputs() {
    writeCsv(runsCsvPath, RUN_COLUMNS, rows);
    writeCsv(summaryCsvPath, SUMMARY_COLUMNS, summarizeRows(rows, modelLabels));
  }

  for (const dataset of args.datasets) {
    const storiesPath = DATASET_FILES[dataset];
    if (!storiesPath) throw new Error(`Unsupported dataset "${dataset}". Supported datasets: ${Object.keys(DATASET_FILES).join(", ")}`);
    if (!fs.existsSync(storiesPath)) throw new Error(`Dataset file not found: ${storiesPath}`);
    datasetInputs[dataset] = {
      storiesPath,
      storyCount: countStories(storiesPath),
      inputDir: prepareInputFolder({ dataset, storiesPath, outputRoot })
    };
  }

  for (const spec of modelSpecs) {
    const ollamaTag = ollamaError ? "" : resolveModelTag(spec, availableTags);
    for (const dataset of args.datasets) {
      const datasetInfo = datasetInputs[dataset];
      if (ollamaError) {
        rows.push(
          buildUnavailableRow({
            dataset,
            storyCount: datasetInfo.storyCount,
            model: spec.label,
            timeoutSeconds: args.timeoutSeconds,
            notes: ollamaError
          })
        );
        logRunOutcome(rows[rows.length - 1]);
        flushCsvOutputs();
        continue;
      }
      if (!ollamaTag) {
        rows.push(
          buildMissingModelRow({
            dataset,
            storyCount: datasetInfo.storyCount,
            model: spec.label,
            timeoutSeconds: args.timeoutSeconds,
            notes: `available=${availableTags.join("|")}`
          })
        );
        logRunOutcome(rows[rows.length - 1]);
        flushCsvOutputs();
        continue;
      }

      const runDir = path.join(outputRoot, "runs", slug(dataset), slug(spec.label));
      console.error(`[llm-selection] ${dataset} with ${ollamaTag}...`);
      const row = runPlanGeneration({
        dataset,
        storyCount: datasetInfo.storyCount,
        modelLabel: spec.label,
        ollamaTag,
        inputDir: datasetInfo.inputDir,
        runDir,
        timeoutSeconds: args.timeoutSeconds,
        ollamaUrl: args.ollamaUrl || DEFAULT_OLLAMA_URL,
        useVisualNarrator: args.useVisualNarrator,
        useProcessVisualizer: args.useProcessVisualizer
      });
      rows.push(row);
      logRunOutcome(row);
      flushCsvOutputs();
      if (args.stopOnSharedFailure && isSharedPreprocessingFailure(row, args)) {
        throw new Error(sharedFailureMessage(row));
      }
    }
  }

  flushCsvOutputs();

  console.log(`Wrote ${runsCsvPath}`);
  console.log(`Wrote ${summaryCsvPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  inspectPlan,
  summarizeRows,
  resolveModelTag
};
