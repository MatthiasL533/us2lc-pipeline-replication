const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const TRANSPARENT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

class ProcessVisualizerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProcessVisualizerError";
    this.details = details;
  }
}

const GENERIC_PROCESS_TERMS = new Set([
  "app",
  "application",
  "button",
  "data",
  "form",
  "information",
  "item",
  "list",
  "page",
  "process",
  "record",
  "screen",
  "system",
  "task",
  "thing",
  "user",
  "view",
  "work"
]);

const VERB_PREFIX_RE = /^(add|approve|assign|cancel|change|check|complete|create|delete|download|edit|enter|fill|generate|manage|notify|open|place|prepare|process|receive|reject|review|search|send|ship|start|submit|update|upload|validate|view)\s+/i;

function trimToString(value) {
  return String(value || "").trim();
}

function uniqStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = trimToString(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function toConceptKey(value) {
  const lower = trimToString(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!lower) return "";
  if (lower.endsWith("ies") && lower.length > 4) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("s") && !lower.endsWith("ss") && lower.length > 4) return lower.slice(0, -1);
  return lower;
}

function toTitlePhrase(value) {
  return trimToString(value)
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function getProcessVisualizerPaths({ repoRoot = process.cwd() } = {}) {
  const root = path.resolve(repoRoot);
  const processVisualizerRoot = path.join(root, "process-visualizer");
  const venvRoot = path.join(processVisualizerRoot, ".venv");
  const isWindows = process.platform === "win32";
  const pythonPath = isWindows
    ? path.join(venvRoot, "Scripts", "python.exe")
    : path.join(venvRoot, "bin", "python");

  return {
    repoRoot: root,
    processVisualizerRoot,
    venvRoot,
    pythonPath,
    wrapperPath: path.join(root, "src", "scripts", "run_process_visualizer.py")
  };
}

function buildProcessVisualizerCommand({
  inputPath,
  outputDir,
  model,
  ollamaUrl,
  repoRoot = process.cwd()
}) {
  const paths = getProcessVisualizerPaths({ repoRoot });
  return {
    cwd: paths.repoRoot,
    command: paths.pythonPath,
    args: [
      paths.wrapperPath,
      "--input",
      path.resolve(inputPath),
      "--output-dir",
      path.resolve(outputDir),
      "--model",
      trimToString(model) || "llama3",
      "--ollama-url",
      trimToString(ollamaUrl) || "http://127.0.0.1:11434"
    ]
  };
}

function ensureProcessVisualizerEnvironment(paths) {
  if (!fs.existsSync(paths.processVisualizerRoot)) {
    throw new ProcessVisualizerError("Process Visualizer folder was not found in this repository.", {
      code: "PV_MISSING_FOLDER",
      processVisualizerRoot: paths.processVisualizerRoot
    });
  }

  if (!fs.existsSync(paths.wrapperPath)) {
    throw new ProcessVisualizerError("Process Visualizer wrapper script is missing from the pipeline.", {
      code: "PV_MISSING_WRAPPER",
      wrapperPath: paths.wrapperPath
    });
  }

  if (!fs.existsSync(paths.pythonPath)) {
    throw new ProcessVisualizerError(
      [
        "Process Visualizer is enabled but its repo-local Python environment is missing.",
        "Run `npm run setup:process-viz` to create `process-visualizer/.venv` and install the required packages."
      ].join(" "),
      {
        code: "PV_MISSING_VENV",
        pythonPath: paths.pythonPath,
        venvRoot: paths.venvRoot
      }
    );
  }
}

function extractTaskObject(action) {
  let text = trimToString(action)
    .replace(VERB_PREFIX_RE, "")
    .replace(/^(a|an|the|new|existing|pending|specific)\s+/i, "")
    .replace(/\s+(record|item|entry)$/i, "")
    .trim();

  if (!text) return "";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 4) text = words.slice(-4).join(" ");

  const key = toConceptKey(text);
  if (!key || GENERIC_PROCESS_TERMS.has(key)) return "";
  return toTitlePhrase(text);
}

function walkBpmnElements(elements, visit, context = {}) {
  for (const element of Array.isArray(elements) ? elements : []) {
    if (!element || typeof element !== "object") continue;
    visit(element, context);

    if (Array.isArray(element.children)) {
      element.children.forEach((child, index) => {
        const condition = Array.isArray(element.conditions) ? element.conditions[index] : "";
        const nextContext = {
          ...context,
          gatewayId: trimToString(element.id),
          gatewayType: trimToString(element.type),
          condition: trimToString(condition)
        };
        walkBpmnElements(child, visit, nextContext);
      });
    }
  }
}

function normalizeProcessVisualizerSummary(result) {
  const structure = Array.isArray(result && result.bpmnStructure) ? result.bpmnStructure : [];
  const rawEntities = Array.isArray(result && result.entities) ? result.entities : [];
  const tasks = [];
  const gateways = [];
  const actors = [];
  const processObjects = [];

  walkBpmnElements(structure, (element, context) => {
    if (element.type === "task" && element.content) {
      const actor = trimToString(element.content.agent && element.content.agent.word);
      const action = trimToString(element.content.task && element.content.task.word);
      const condition = trimToString(
        (element.content.condition && element.content.condition.word) || context.condition
      );
      if (!action) return;

      actors.push(actor);
      const object = extractTaskObject(action);
      if (object) processObjects.push(object);
      tasks.push({
        actor,
        action,
        condition,
        gatewayId: trimToString(context.gatewayId),
        gatewayType: trimToString(context.gatewayType),
        storyIndex: Number.isFinite(Number(element.content.sentence_idx))
          ? Number(element.content.sentence_idx)
          : null
      });
    }

    if ((element.type === "exclusive" || element.type === "parallel") && Array.isArray(element.conditions)) {
      gateways.push({
        id: trimToString(element.id),
        type: trimToString(element.type),
        conditions: uniqStrings(element.conditions)
      });
    }
  });

  for (const entity of rawEntities) {
    if (!entity || typeof entity !== "object") continue;
    if (entity.entity_group === "AGENT") actors.push(entity.word);
    if (entity.entity_group === "TASK") {
      const object = extractTaskObject(entity.word);
      if (object) processObjects.push(object);
    }
  }

  const combinedText = [
    ...tasks.flatMap((task) => [task.actor, task.action, task.condition]),
    ...gateways.flatMap((gateway) => gateway.conditions),
    ...processObjects
  ].join(" ").toLowerCase();

  const capabilityHints = {
    hasApproval: /\bapprove|approval|reject|accepted|rejected\b/.test(combinedText),
    hasDecision: gateways.length > 0 || /\bif\b|\bdecide|decision|choose|condition\b/.test(combinedText),
    hasNotification: /\bnotification|notify|informed|alert|message\b/.test(combinedText),
    hasWorkflowLikeRouting: /\bworkflow|approval|approve|reject|review|route|assign|task\b/.test(combinedText) || gateways.length > 0
  };

  return {
    actors: uniqStrings(actors),
    tasks: tasks.slice(0, 80),
    gateways: gateways.slice(0, 30),
    processObjects: uniqStrings(processObjects)
      .filter((name) => !GENERIC_PROCESS_TERMS.has(toConceptKey(name)))
      .slice(0, 30),
    capabilityHints,
    stats: {
      taskCount: tasks.length,
      gatewayCount: gateways.length,
      rawEntityCount: rawEntities.length
    }
  };
}

function buildProcessVisualizerPromptText(summary) {
  const normalized = summary && typeof summary === "object"
    ? summary
    : { actors: [], tasks: [], gateways: [], processObjects: [], capabilityHints: {} };
  const parts = [
    [
      "Use these Process Visualizer results only as process-flow hints.",
      "Use them to understand actors, actions, decisions, and workflow-like routing.",
      "Do not create entities from this evidence unless user stories also support them."
    ].join(" ")
  ];

  if ((normalized.actors || []).length > 0) {
    parts.push(`Process actors: ${normalized.actors.slice(0, 20).join(", ")}`);
  }

  if ((normalized.processObjects || []).length > 0) {
    parts.push(`Process object candidates: ${normalized.processObjects.slice(0, 20).join(", ")}`);
  }

  if ((normalized.tasks || []).length > 0) {
    parts.push(
      "Task flow:\n" +
        normalized.tasks
          .slice(0, 30)
          .map((task) => {
            const prefix = task.condition ? `[${task.condition}] ` : "";
            const actor = task.actor ? `${task.actor}: ` : "";
            return `- ${prefix}${actor}${task.action}`;
          })
          .join("\n")
    );
  }

  if ((normalized.gateways || []).length > 0) {
    parts.push(
      "Decisions/gateways:\n" +
        normalized.gateways
          .slice(0, 20)
          .map((gateway) => `- ${gateway.type || "gateway"} ${gateway.id || ""}: ${(gateway.conditions || []).join(" | ")}`)
          .join("\n")
    );
  }

  const hints = normalized.capabilityHints || {};
  const enabledHints = Object.keys(hints).filter((key) => hints[key]);
  if (enabledHints.length > 0) {
    parts.push(`Capability hints: ${enabledHints.join(", ")}`);
  }

  return parts.join("\n\n");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function escapeGraphLabel(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function writeProcessVisualizerArtifacts({ outputDir, result }) {
  const dir = path.resolve(outputDir);
  fs.mkdirSync(dir, { recursive: true });

  const summary = normalizeProcessVisualizerSummary(result);
  const summaryPath = path.join(dir, "process-visualizer-summary.json");
  const rawPath = path.join(dir, "process-visualizer-result.json");
  const runDir = path.join(dir, "process-visualizer-run");
  const defaultGraphSourcePath = path.join(runDir, "process-visualizer.gv");
  const defaultGraphImagePath = path.join(runDir, "process-visualizer.png");
  const logsDir = result.logsDir || path.join(runDir, "output_logs");

  writeJson(summaryPath, summary);
  writeJson(rawPath, result);

  fs.mkdirSync(logsDir, { recursive: true });
  const graphSourcePath = result.graphSourcePath && fs.existsSync(result.graphSourcePath)
    ? result.graphSourcePath
    : defaultGraphSourcePath;
  if (!fs.existsSync(graphSourcePath)) {
    fs.mkdirSync(path.dirname(graphSourcePath), { recursive: true });
    const nodes = summary.tasks
      .map((task, index) => `  t${index} [label="${escapeGraphLabel(`${task.actor}: ${task.action}`)}"];`)
      .join("\n");
    fs.writeFileSync(graphSourcePath, `digraph process_visualizer {\n${nodes}\n}\n`, "utf8");
  }

  const graphImagePath = result.graphImagePath && fs.existsSync(result.graphImagePath)
    ? result.graphImagePath
    : defaultGraphImagePath;
  if (!fs.existsSync(graphImagePath)) {
    fs.mkdirSync(path.dirname(graphImagePath), { recursive: true });
    fs.writeFileSync(graphImagePath, Buffer.from(TRANSPARENT_PNG_BASE64, "base64"));
  }

  return {
    summaryPath,
    rawPath,
    graphSourcePath,
    graphImagePath,
    logsDir
  };
}

function parseProcessVisualizerJson(stdout) {
  const text = String(stdout || "").trim();
  try {
    return JSON.parse(text || "{}");
  } catch (_err) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw _err;
  }
}

function runProcessVisualizer({
  inputPath,
  outputDir,
  model,
  ollamaUrl,
  repoRoot = process.cwd(),
  spawnSyncImpl = spawnSync,
  progress = null
}) {
  const notify = typeof progress === "function" ? progress : () => {};
  const paths = getProcessVisualizerPaths({ repoRoot });
  ensureProcessVisualizerEnvironment(paths);

  const command = buildProcessVisualizerCommand({
    inputPath,
    outputDir,
    model,
    ollamaUrl,
    repoRoot
  });

  notify("Launching Process Visualizer Python wrapper...");
  const startedAt = Date.now();
  const child = spawnSyncImpl(command.command, command.args, {
    cwd: command.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PROCESS_VISUALIZER_LLM_PROVIDER: "ollama",
      PROCESS_VISUALIZER_MODEL: trimToString(model) || "llama3",
      OLLAMA_URL: trimToString(ollamaUrl) || "http://127.0.0.1:11434"
    },
    maxBuffer: 1024 * 1024 * 20
  });
  const durationMs = Date.now() - startedAt;

  if (child.error) {
    throw new ProcessVisualizerError(`Process Visualizer failed to start: ${child.error.message}`, {
      code: "PV_SPAWN_ERROR",
      durationMs,
      command,
      cause: child.error.message
    });
  }

  if (child.status !== 0) {
    throw new ProcessVisualizerError(`Process Visualizer exited with code ${child.status}.`, {
      code: "PV_EXIT_NON_ZERO",
      durationMs,
      command,
      exitCode: child.status,
      stderr: String(child.stderr || "").trim()
    });
  }

  let parsed;
  try {
    parsed = parseProcessVisualizerJson(child.stdout);
  } catch (err) {
    throw new ProcessVisualizerError(`Process Visualizer returned invalid JSON: ${err.message}`, {
      code: "PV_INVALID_JSON",
      durationMs,
      command,
      stdout: String(child.stdout || ""),
      stderr: String(child.stderr || "")
    });
  }

  const summary = normalizeProcessVisualizerSummary(parsed);
  const artifacts = writeProcessVisualizerArtifacts({
    outputDir,
    result: parsed
  });

  return {
    enabled: true,
    status: "completed",
    durationMs,
    command: [command.command].concat(command.args).join(" "),
    artifacts,
    warnings: [],
    stderr: String(child.stderr || "").trim(),
    result: parsed,
    summary,
    promptText: buildProcessVisualizerPromptText(summary)
  };
}

module.exports = {
  ProcessVisualizerError,
  getProcessVisualizerPaths,
  buildProcessVisualizerCommand,
  ensureProcessVisualizerEnvironment,
  normalizeProcessVisualizerSummary,
  buildProcessVisualizerPromptText,
  writeProcessVisualizerArtifacts,
  runProcessVisualizer
};
