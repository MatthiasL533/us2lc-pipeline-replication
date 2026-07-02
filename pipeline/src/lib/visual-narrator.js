const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

class VisualNarratorError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "VisualNarratorError";
    this.details = details;
  }
}

const GENERIC_VN_CONCEPT_KEYS = new Set([
  "thing",
  "what",
  "work",
  "data",
  "information",
  "quality",
  "progress",
  "question",
  "update",
  "place",
  "policy",
  "process",
  "system",
  "app",
  "record",
  "stakeholder",
  "project",
  "people",
  "userstory",
  "functionalrole",
  "person",
  "history",
  "completion",
  "credential",
  "rule",
  "activity"
]);

function getVisualNarratorPaths({ repoRoot = process.cwd() } = {}) {
  const root = path.resolve(repoRoot);
  const vnRoot = path.join(root, "visual-narrator");
  const venvRoot = path.join(vnRoot, ".venv");
  const isWindows = process.platform === "win32";
  const pythonPath = isWindows
    ? path.join(venvRoot, "Scripts", "python.exe")
    : path.join(venvRoot, "bin", "python");

  return {
    repoRoot: root,
    vnRoot,
    venvRoot,
    pythonPath,
    wrapperPath: path.join(root, "src", "scripts", "run_visual_narrator.py")
  };
}

function buildVisualNarratorCommand({ inputPath, systemName = "System", repoRoot = process.cwd() }) {
  const paths = getVisualNarratorPaths({ repoRoot });
  return {
    cwd: paths.repoRoot,
    command: paths.pythonPath,
    args: [paths.wrapperPath, "--input", path.resolve(inputPath), "--system-name", String(systemName || "System")]
  };
}

function ensureVisualNarratorEnvironment(paths) {
  if (!fs.existsSync(paths.vnRoot)) {
    throw new VisualNarratorError("Visual Narrator folder was not found in this repository.", {
      code: "VN_MISSING_FOLDER",
      vnRoot: paths.vnRoot
    });
  }

  if (!fs.existsSync(paths.wrapperPath)) {
    throw new VisualNarratorError("Visual Narrator wrapper script is missing from the pipeline.", {
      code: "VN_MISSING_WRAPPER",
      wrapperPath: paths.wrapperPath
    });
  }

  if (!fs.existsSync(paths.pythonPath)) {
    throw new VisualNarratorError(
      [
        "Visual Narrator is enabled but its repo-local Python environment is missing.",
        "Run `npm run setup:vn` to create `visual-narrator/.venv` and install the required packages."
      ].join(" "),
      {
        code: "VN_MISSING_VENV",
        pythonPath: paths.pythonPath,
        venvRoot: paths.venvRoot
      }
    );
  }
}

function trimLines(text, maxLines = 60) {
  const lines = String(text || "").trim().split("\n").filter(Boolean);
  if (lines.length <= maxLines) return lines.join("\n");
  return `${lines.slice(0, maxLines).join("\n")}\n[...${lines.length - maxLines} more lines omitted]`;
}

function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = String(value || "").trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function toConceptKey(value) {
  const lower = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!lower) return "";
  if (lower.endsWith("ies") && lower.length > 4) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("s") && !lower.endsWith("ss") && lower.length > 4) return lower.slice(0, -1);
  return lower;
}

function isGenericConceptName(name) {
  return GENERIC_VN_CONCEPT_KEYS.has(toConceptKey(name));
}

function filterVisualNarratorClasses({ classes, inferredRoles, keyNouns }) {
  const roleKeys = new Set((inferredRoles || []).map((entry) => toConceptKey(entry)).filter(Boolean));
  const strongNounKeys = new Set(
    (keyNouns || [])
      .filter((entry) => Number(entry.weight || 0) >= 1)
      .map((entry) => toConceptKey(entry.term))
      .filter(Boolean)
  );
  const out = [];
  const seen = new Set();

  for (const entry of classes || []) {
    const name = String(entry && entry.name || "").trim();
    const parent = String(entry && entry.parent || "").trim();
    const key = toConceptKey(name);
    if (!name || !key) continue;
    if (seen.has(key)) continue;
    if (entry && entry.isRole) continue;
    if (roleKeys.has(key)) continue;
    if (/^us\d+$/i.test(name)) continue;
    if (isGenericConceptName(name)) continue;
    if (parent && isGenericConceptName(parent) && !strongNounKeys.has(key) && !/\s/.test(name)) continue;

    seen.add(key);
    out.push({
      name,
      parent,
      isRole: false
    });
  }

  return out;
}

function filterVisualNarratorRelationships({ relationships, allowedClassKeys }) {
  const out = [];
  const seen = new Set();

  for (const entry of relationships || []) {
    const name = String(entry && entry.name || "").trim();
    const domain = String(entry && entry.domain || "").trim();
    const range = String(entry && entry.range || "").trim();
    const key = `${toConceptKey(name)}|${toConceptKey(domain)}|${toConceptKey(range)}`;
    if (!name || !domain || !range || !key) continue;
    if (seen.has(key)) continue;
    if (!allowedClassKeys.has(toConceptKey(domain))) continue;
    if (!allowedClassKeys.has(toConceptKey(range))) continue;
    seen.add(key);
    out.push({ name, domain, range });
  }

  return out;
}

function filterVisualNarratorKeyNouns(keyNouns, allowedClassKeys) {
  const out = [];
  const seen = new Set();

  for (const entry of keyNouns || []) {
    const term = String(entry && entry.term || "").trim();
    const key = toConceptKey(term);
    if (!term || !key) continue;
    if (seen.has(key)) continue;
    if (isGenericConceptName(term)) continue;
    if (allowedClassKeys.size > 0 && !allowedClassKeys.has(key)) continue;
    seen.add(key);
    out.push({
      term,
      weight: Number(entry && entry.weight || 0)
    });
  }

  return out;
}

function normalizeVisualNarratorSummary(result) {
  const classes = Array.isArray(result.classes) ? result.classes : [];
  const relationships = Array.isArray(result.relationships) ? result.relationships : [];
  const keyNouns = Array.isArray(result.keyNouns) ? result.keyNouns : [];
  const inferredRoles = Array.isArray(result.inferredRoles) ? result.inferredRoles : [];
  const normalizedRoles = inferredRoles.map((entry) => String(entry || "").trim()).filter(Boolean);
  const filteredClasses = filterVisualNarratorClasses({
    classes: classes.map((entry) => ({
      name: String(entry && entry.name || "").trim(),
      parent: String(entry && entry.parent || "").trim(),
      isRole: Boolean(entry && entry.isRole)
    })).filter((entry) => entry.name),
    inferredRoles: normalizedRoles,
    keyNouns
  });
  const allowedClassKeys = new Set(filteredClasses.map((entry) => toConceptKey(entry.name)).filter(Boolean));
  const filteredRelationships = filterVisualNarratorRelationships({
    relationships: relationships.map((entry) => ({
      name: String(entry && entry.name || "").trim(),
      domain: String(entry && entry.domain || "").trim(),
      range: String(entry && entry.range || "").trim()
    })).filter((entry) => entry.name && entry.domain && entry.range),
    allowedClassKeys
  });
  const filteredKeyNouns = filterVisualNarratorKeyNouns(
    keyNouns
      .map((entry) => ({
        term: String(entry && entry.term || "").trim(),
        weight: Number(entry && entry.weight || 0)
      }))
      .filter((entry) => entry.term),
    allowedClassKeys
  );
  const rawClassNames = classes
    .map((entry) => String(entry && entry.name || "").trim())
    .filter(Boolean);
  const discardedClassNames = rawClassNames.filter((name) => !allowedClassKeys.has(toConceptKey(name)));

  return {
    classNames: filteredClasses.map((entry) => entry.name),
    classes: filteredClasses,
    relationships: filteredRelationships,
    keyNouns: filteredKeyNouns,
    inferredRoles: normalizedRoles,
    discardedClassNames: dedupeStrings(discardedClassNames)
  };
}

function buildVisualNarratorPromptText(summary, ontologyText) {
  const parts = [];
  const normalizedSummary = {
    inferredRoles: Array.isArray(summary && summary.inferredRoles) ? summary.inferredRoles : [],
    classNames: Array.isArray(summary && summary.classNames) ? summary.classNames : [],
    classes: Array.isArray(summary && summary.classes) ? summary.classes : [],
    relationships: Array.isArray(summary && summary.relationships) ? summary.relationships : [],
    discardedClassNames: Array.isArray(summary && summary.discardedClassNames) ? summary.discardedClassNames : [],
    keyNouns: Array.isArray(summary && summary.keyNouns) ? summary.keyNouns : []
  };

  parts.push(
    [
      "Use these Visual Narrator results only as filtered conceptual-model hints.",
      "Use them to choose business concepts and relations before generating JSON, not as a list to append.",
      "Ignore discarded candidates even if similar terms appear in raw VN output."
    ].join(" ")
  );

  if (normalizedSummary.inferredRoles.length > 0) {
    parts.push(`Core roles: ${normalizedSummary.inferredRoles.join(", ")}`);
  }

  if (normalizedSummary.classNames.length > 0) {
    parts.push(`Preferred entity candidates: ${normalizedSummary.classNames.join(", ")}`);
  }

  if (normalizedSummary.relationships.length > 0) {
    parts.push(
      "Preferred relationships:\n" +
        normalizedSummary.relationships
          .slice(0, 30)
          .map((entry) => `- ${entry.domain} --${entry.name}--> ${entry.range}`)
          .join("\n")
    );
  }

  if (normalizedSummary.discardedClassNames.length > 0) {
    parts.push(`Discarded VN candidates: ${normalizedSummary.discardedClassNames.slice(0, 20).join(", ")}`);
  }

  if (normalizedSummary.keyNouns.length > 0) {
    parts.push(
      `Supporting key nouns: ${normalizedSummary.keyNouns
        .slice(0, 15)
        .map((entry) => `${entry.term} (${entry.weight.toFixed(2)})`)
        .join(", ")}`
    );
  }

  if (normalizedSummary.classes.length > 0 && ontologyText) {
    parts.push(`Filtered class count: ${normalizedSummary.classes.length}`);
  }

  return parts.join("\n\n");
}

function inferEntityNamesFromVisualNarrator(summary, moduleName) {
  const modulePrefix = `${String(moduleName || "").trim()}.`;
  const out = [];
  const seen = new Set();

  for (const entry of summary.classes || []) {
    const name = String(entry && entry.name || "").trim();
    if (!name) continue;
    if (entry.isRole) continue;
    if (/^US\d+$/i.test(name)) continue;
    if (/^(Thing|UserStory|FunctionalRole|Person)$/i.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      entityRef: modulePrefix ? `${modulePrefix}${name}` : name
    });
  }

  return out;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function writeVisualNarratorArtifacts({ outputDir, result }) {
  const dir = path.resolve(outputDir);
  fs.mkdirSync(dir, { recursive: true });

  const ontologyPath = path.join(dir, "visual-narrator-ontology.omn");
  const storiesPath = path.join(dir, "visual-narrator-stories.json");
  const summaryPath = path.join(dir, "visual-narrator-summary.json");
  const rawPath = path.join(dir, "visual-narrator-result.json");

  fs.writeFileSync(ontologyPath, String(result.ontology || ""), "utf8");
  writeJson(storiesPath, Array.isArray(result.stories) ? result.stories : []);
  writeJson(summaryPath, normalizeVisualNarratorSummary(result));
  writeJson(rawPath, result);

  return {
    ontologyPath,
    storiesPath,
    summaryPath,
    rawPath
  };
}

function runVisualNarrator({
  inputPath,
  outputDir,
  systemName = "System",
  repoRoot = process.cwd(),
  spawnSyncImpl = spawnSync,
  progress = null
}) {
  const notify = typeof progress === "function" ? progress : () => {};
  const paths = getVisualNarratorPaths({ repoRoot });
  ensureVisualNarratorEnvironment(paths);

  const command = buildVisualNarratorCommand({
    inputPath,
    systemName,
    repoRoot
  });

  notify("Launching Visual Narrator Python wrapper...");
  const startedAt = Date.now();
  const child = spawnSyncImpl(command.command, command.args, {
    cwd: command.cwd,
    encoding: "utf8"
  });
  const durationMs = Date.now() - startedAt;

  if (child.error) {
    throw new VisualNarratorError(`Visual Narrator failed to start: ${child.error.message}`, {
      code: "VN_SPAWN_ERROR",
      durationMs,
      command,
      cause: child.error.message
    });
  }

  if (child.status !== 0) {
    const stderr = String(child.stderr || "").trim();
    const extraHint = /en_core_web_md/i.test(stderr)
      ? " The required spaCy model is missing. Run `npm run setup:vn` to install it."
      : "";
    throw new VisualNarratorError(`Visual Narrator exited with code ${child.status}.${extraHint}`, {
      code: "VN_EXIT_NON_ZERO",
      durationMs,
      command,
      exitCode: child.status,
      stderr
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(String(child.stdout || "{}"));
  } catch (err) {
    throw new VisualNarratorError(`Visual Narrator returned invalid JSON: ${err.message}`, {
      code: "VN_INVALID_JSON",
      durationMs,
      command,
      stdout: String(child.stdout || ""),
      stderr: String(child.stderr || "")
    });
  }

  const summary = normalizeVisualNarratorSummary(parsed);
  const artifacts = writeVisualNarratorArtifacts({
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
    promptText: buildVisualNarratorPromptText(summary, parsed.ontology || "")
  };
}

module.exports = {
  VisualNarratorError,
  getVisualNarratorPaths,
  buildVisualNarratorCommand,
  normalizeVisualNarratorSummary,
  buildVisualNarratorPromptText,
  inferEntityNamesFromVisualNarrator,
  writeVisualNarratorArtifacts,
  runVisualNarrator
};
