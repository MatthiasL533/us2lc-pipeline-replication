const fs = require("fs");
const path = require("path");

const { validatePlan, normalizeActionType } = require("./lib/validation");
const { normalizeNavigationConfig } = require("./lib/navigation-contract");
const { normalizeAssociationType } = require("./lib/association-types");
const { deriveStoryCapabilityBaseline, collectPlanCapabilityRequirements } = require("./lib/app-capabilities");
const { HOME_ICON_NAME, isHomeIconName, navigationIconPolicyForPrompt } = require("./lib/glyphicons");
const {
  runVisualNarrator,
  normalizeVisualNarratorSummary,
  buildVisualNarratorPromptText,
  inferEntityNamesFromVisualNarrator,
  writeVisualNarratorArtifacts
} = require("./lib/visual-narrator");
const {
  ProcessVisualizerError,
  runProcessVisualizer,
  normalizeProcessVisualizerSummary,
  buildProcessVisualizerPromptText,
  writeProcessVisualizerArtifacts
} = require("./lib/process-visualizer");
const { runInputBundleStage, runPreprocessingStages } = require("./generator/input-bundle");
const { runBaselinePlannerStage } = require("./generator/baseline-planner");
const { runPromptBuilderStage } = require("./generator/prompt-builder");
const { runFirstLlmPassStage, runRepairLlmPassStage, runSectionLlmStage } = require("./generator/llm-client");
const { runPlanNormalizerStage, normalizeRepairPlan } = require("./generator/plan-normalizer");
const { runPlanMergerStage, mergeRepairPlan } = require("./generator/plan-merger");
const { buildCoverageGate, assertCoverageGate } = require("./generator/coverage-gate");
const {
  applyPlanMetadata,
  buildGenerationReport,
  buildReproducibilitySection,
  writeGenerationArtifacts
} = require("./generator/generation-report");

const DEFAULT_OLLAMA_MODEL = "llama3";
const DEFAULT_PROCESS_VISUALIZER_MODEL = "llama3";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_LAYOUT_QNAME = "Atlas_Core.Atlas_Default";
const DEFAULT_POPUP_LAYOUT_QNAME = "Atlas_Core.PopupLayout";
const PLAN_GENERATOR_VERSION = "1.1.0";
const DEFAULT_KNOWLEDGE_DIR = path.join(process.cwd(), "context");
const DEFAULT_REFERENCE_PLAN_DIR = path.join(process.cwd(), "src", "plans", "reference");
const DEFAULT_EXAMPLE_PLAN_PATHS = [
  path.join(DEFAULT_REFERENCE_PLAN_DIR, "reference-01-role-separated-crud.json"),
  path.join(DEFAULT_REFERENCE_PLAN_DIR, "reference-02-workflow-simple-approval.json"),
  path.join(DEFAULT_REFERENCE_PLAN_DIR, "reference-03-relational-crud.json"),
  path.join(DEFAULT_REFERENCE_PLAN_DIR, "reference-04-microflow-business-logic.json"),
  path.join(DEFAULT_REFERENCE_PLAN_DIR, "reference-05-analytics-filters.json"),
  path.join(DEFAULT_REFERENCE_PLAN_DIR, "reference-06-workflow-routing.json"),
  path.join(DEFAULT_REFERENCE_PLAN_DIR, "reference-07-client-actions-create-app.json")
];

const OLLAMA_NUM_CTX = 8192;
const OLLAMA_NUM_PREDICT = 6144;
const OLLAMA_TEMPERATURE = 0.05;
const OLLAMA_TOP_P = 0.9;
const OLLAMA_TIMEOUT_MS = 450000;
const COVERAGE_TARGET_SCORE = 1.0;
const COVERAGE_REPAIR_MIN_GAIN = 0.05;

const SUPPORTED_ATTRIBUTE_TYPES = new Set(["String", "Boolean", "Integer", "Long", "Decimal", "DateTime", "UUID"]);
const ATTRIBUTE_TYPE_BY_KEY = new Map(Array.from(SUPPORTED_ATTRIBUTE_TYPES).map((type) => [type.toLowerCase(), type]));

const SUPPORTED_PAGE_STEP_TYPES = new Set([
  "dynamicText",
  "buttonToPage",
  "createObjectButton",
  "listView",
  "dataGrid",
  "dataView",
  "associationInput",
  "associationSetInput",
  "referenceSelector",
  "referenceSetSelector",
  "filterToolbar",
  "attributeInput",
  "saveChangesButton",
  "cancelChangesButton",
  "callMicroflowButton",
  "callNanoflowButton",
  "callWorkflowButton",
  "showUserTaskPageButton",
  "setTaskOutcomeButton",
  "deleteObjectButton",
  "closePageButton",
  "openLinkButton",
  "widget"
]);

const USEFUL_PAGE_STEP_TYPES = new Set([
  "dataView",
  "dataGrid",
  "listView",
  "attributeInput",
  "associationInput",
  "associationSetInput",
  "referenceSelector",
  "referenceSetSelector",
  "buttonToPage",
  "createObjectButton",
  "saveChangesButton",
  "callMicroflowButton",
  "callNanoflowButton",
  "callWorkflowButton",
  "showUserTaskPageButton",
  "setTaskOutcomeButton",
  "deleteObjectButton",
  "widget",
  "filterToolbar"
]);

const SUPPORTED_MICROFLOW_ACTION_TYPES = [
  "showMessage",
  "callMicroflow",
  "callNanoflow",
  "retrieveList",
  "retrieveObject",
  "createObject",
  "aggregateList",
  "createVariable",
  "changeVariable",
  "decision",
  "changeObject",
  "commitObject",
  "returnValue"
];

const STOP_WORDS = new Set([
  "as",
  "an",
  "a",
  "the",
  "i",
  "want",
  "to",
  "so",
  "that",
  "can",
  "my",
  "our",
  "and",
  "or",
  "for",
  "with",
  "from",
  "into",
  "in",
  "on",
  "by",
  "of",
  "is",
  "are",
  "be",
  "it",
  "using",
  "have",
  "has",
  "their",
  "they",
  "all",
  "new",
  "app"
]);

const GENERIC_ENTITY_STOP_WORDS = new Set([
  ...STOP_WORDS,
  "manage",
  "add",
  "create",
  "edit",
  "update",
  "delete",
  "view",
  "see",
  "track",
  "review",
  "approve",
  "reject",
  "assign",
  "maintain",
  "mark",
  "use",
  "filter",
  "search",
  "receive",
  "send",
  "schedule",
  "record",
  "select",
  "choose",
  "capture",
  "store",
  "monitor",
  "analyze",
  "generate",
  "download",
  "upload",
  "browse",
  "access",
  "show",
  "list",
  "open",
  "close",
  "status",
  "history",
  "overview",
  "detail",
  "details",
  "dashboard",
  "home",
  "message",
  "messages",
  "information",
  "data",
  "reporting",
  "activity",
  "activities",
  "work",
  "workflow",
  "request",
  "specific",
  "pending",
  "value",
  "available",
  "detailed",
  "exact",
  "contents",
  "floor",
  "able",
  "such"
]);

const GENERIC_CONCEPT_NAMES = new Set([
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
  "record",
  "item",
  "activity",
  "list",
  "view",
  "form",
  "page",
  "button",
  "microflow",
  "workflow",
  "request"
]);

const DUPLICATE_ENTITY_SPECIFICITY_STOP_WORDS = new Set([
  "each",
  "every",
  "planned",
  "available",
  "selected",
  "current",
  "existing"
]);

const PERSON_ENTITY_RE = /\b(user|customer|employee|agent|staff|member|manager|admin|owner|auditor|approver|reviewer)\b/i;
const AUXILIARY_ENTITY_RE = /\b(notification|comment|attachment|document|file|approval|profile|report|log|history|period|role|department|team|rule)\b/i;
const NON_DOMAIN_ARTIFACT_ENTITY_RE = /(Workflow|Microflow|Nanoflow|Page|Form|Button|View|List|WorkflowTask|TaskUi|TaskUI)$/;

const STORY_TAG_RULES = [
  { tag: "login", re: /\blog[ -]?in|credential|sign[ -]?in|authenticate\b/i },
  { tag: "dashboard", re: /\bdashboard|view .*assigned task|see what i need\b/i },
  { tag: "task_management", re: /\btask(s)?\b/i },
  { tag: "task_completion", re: /\bmark .*completed|complete task|completion\b/i },
  { tag: "comments", re: /\bcomment(s)?\b/i },
  { tag: "attachments", re: /\battachment(s)?|upload file|file(s)?\b/i },
  { tag: "assignment", re: /\bassign\b/i },
  { tag: "deadlines", re: /\bdeadline|due date|overdue\b/i },
  { tag: "approval", re: /\bapprove|reject\b/i },
  { tag: "accounts", re: /\buser account|manage user|create user\b/i },
  { tag: "roles_permissions", re: /\brole(s)?|permission(s)?\b/i },
  { tag: "notifications", re: /\bnotification(s)?\b/i },
  { tag: "reporting", re: /\breport(s)?|metric(s)?|performance\b/i },
  { tag: "search_filter", re: /\bfilter|search\b/i },
  { tag: "workflow_rules", re: /\bworkflow rule|workflow|policy|process\b/i },
  { tag: "history", re: /\bhistory\b/i },
  { tag: "recurring", re: /\brecurring\b/i },
  { tag: "profile", re: /\bprofile|contact information\b/i },
  { tag: "audit", re: /\baudit|compliance|security activity\b/i }
];

class PlanGeneratorError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = "PlanGeneratorError";
    this.details = details;
  }
}

function trimToString(raw) {
  return String(raw || "").trim();
}

function normalizeOllamaSeed(seed) {
  if (seed === undefined || seed === null || seed === "") return null;
  const value = Number(seed);
  if (!Number.isFinite(value)) {
    throw new PlanGeneratorError(`--seed must be a finite integer, got "${seed}".`);
  }
  return Math.trunc(value);
}

function buildOllamaOptions({ seed = null } = {}) {
  const options = {
    temperature: OLLAMA_TEMPERATURE,
    top_p: OLLAMA_TOP_P,
    num_ctx: OLLAMA_NUM_CTX,
    num_predict: OLLAMA_NUM_PREDICT
  };
  const normalizedSeed = normalizeOllamaSeed(seed);
  if (normalizedSeed !== null) options.seed = normalizedSeed;
  return options;
}

function toSafeName(raw, fallback) {
  const base = trimToString(raw) || fallback;
  const normalized = base
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^([0-9])/, "_$1");
  return normalized || fallback;
}

function toPascalCase(raw, fallback = "Entity") {
  const source = trimToString(raw);
  if (!source) return toSafeName(fallback, fallback);

  // Preserve already-cased Mendix identifiers like TaskComment.
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(source) && /[A-Z]/.test(source.slice(1))) {
    return toSafeName(source, fallback);
  }

  const tokenized = source
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
  return toSafeName(tokenized, fallback);
}

function splitCamelCase(input) {
  return String(input || "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

function uniq(values) {
  return Array.from(new Set(values));
}

function singularizeWord(raw) {
  const word = trimToString(raw).toLowerCase();
  if (!word) return "";
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("sses") || word.endsWith("ss")) return word;
  if (word.endsWith("s") && word.length > 3) return word.slice(0, -1);
  return word;
}

function toConceptKey(raw) {
  const cleaned = trimToString(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .map((part) => singularizeWord(part))
    .join(" ");
}

function isGenericConceptName(raw) {
  const key = toConceptKey(raw);
  if (!key) return true;
  return key.split(/\s+/).every((part) => GENERIC_CONCEPT_NAMES.has(part) || GENERIC_ENTITY_STOP_WORDS.has(part));
}

function isLikelyGeneratedArtifactEntity(raw) {
  const name = trimToString(raw);
  const key = toConceptKey(name);
  if (!name || !key) return true;
  if (/^(?:[a-z])?ndmanage[A-Z]/i.test(name)) return true;
  const parts = key.split(/\s+/).filter(Boolean);
  const grammarConnectors = new Set(["and", "or", "so", "that", "to", "for", "with", "from", "into", "in", "on", "by", "of"]);
  const trailingActions = new Set(["add", "approve", "assign", "attach", "choose", "create", "edit", "generate", "include", "link", "manage", "record", "review", "see", "select", "start", "submit", "track", "update", "upload", "view"]);
  if (parts.length > 1 && parts.some((part) => grammarConnectors.has(part))) return true;
  if (parts.length > 1 && parts.slice(1).some((part) => trailingActions.has(part))) return true;
  if (key.split(/\s+/).every((part) => GENERIC_ENTITY_STOP_WORDS.has(part))) return true;
  return false;
}

function findCompositeArtifactEntity(entity, allEntities = [], stories = []) {
  const name = trimToString(entity && entity.name);
  if (!name) return null;
  const spacedKey = toConceptKey(splitCamelCase(name));
  const compactKey = spacedKey.replace(/\s+/g, "");
  if (!spacedKey.includes(" ")) return null;

  const otherEntities = (allEntities || [])
    .filter((candidate) => candidate && candidate !== entity && trimToString(candidate.name))
    .map((candidate) => ({
      name: trimToString(candidate.name),
      key: toConceptKey(splitCamelCase(candidate.name)),
      compactKey: toConceptKey(splitCamelCase(candidate.name)).replace(/\s+/g, "")
    }))
    .filter((candidate) => candidate.key && candidate.compactKey);

  for (const left of otherEntities) {
    for (const right of otherEntities) {
      if (left.name === right.name) continue;
      if (`${left.compactKey}${right.compactKey}` !== compactKey) continue;

      const exactCompositeMention = (stories || []).some((story) => storyMentionsTerm(story, spacedKey));
      const attributes = Array.isArray(entity && entity.attributes) ? entity.attributes : [];
      const distinctiveAttributes = attributes.filter((attr) => {
        const key = toConceptKey(attr && attr.name);
        return key && !["name", "title", "description", "status", "created at", "created on"].includes(key);
      });

      if (exactCompositeMention || distinctiveAttributes.length > 0) return null;
      return {
        left: left.name,
        right: right.name,
        reason: `Composite entity duplicates existing entities "${left.name}" and "${right.name}" without independent story evidence.`
      };
    }
  }

  return null;
}

function findGeneratedActionArtifactEntity(entity, allEntities = [], stories = []) {
  const name = trimToString(entity && entity.name);
  if (!name) return null;
  const spacedName = splitCamelCase(name);
  const parts = toConceptKey(spacedName).split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;

  const [prefix, ...rest] = parts;
  const restKey = rest.join(" ");
  const existingEntityKeys = new Set(
    (allEntities || [])
      .filter((candidate) => candidate && candidate !== entity)
      .map((candidate) => toConceptKey(splitCamelCase(candidate.name)))
      .filter(Boolean)
  );

  if (["added", "selected", "chosen", "created", "updated", "deleted", "managed"].includes(prefix) && existingEntityKeys.has(restKey)) {
    return { reason: `Action-derived entity duplicates existing entity "${rest.join(" ")}" without independent story evidence.` };
  }

  if (["its", "their", "his", "her", "my", "our"].includes(prefix) && rest.every((part) => GENERIC_ENTITY_STOP_WORDS.has(part) || ["detail", "view", "screen", "page", "form"].includes(part))) {
    return { reason: "Pronoun/detail artifact entity is not an independent domain concept." };
  }

  return null;
}

function storyMentionsTerm(story, term) {
  const key = toConceptKey(term);
  if (!key) return false;
  const storyKey = toConceptKey(`${story.role} ${story.want} ${story.benefit} ${story.raw}`);
  return storyKey.includes(key);
}

function splitRoleTerms(role) {
  return trimToString(role)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => singularizeWord(token))
    .filter((token) => token && !STOP_WORDS.has(token));
}

function coerceBoolean(raw, defaultValue) {
  if (raw === undefined || raw === null) return defaultValue;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const lower = raw.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return defaultValue;
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function readOptionalTextFile(filePath) {
  if (!fs.existsSync(filePath)) return "";
  return readTextFile(filePath);
}

function validateAppContext(appContext) {
  const errors = [];

  if (!appContext || typeof appContext !== "object" || Array.isArray(appContext)) {
    errors.push("app-context.json must be a JSON object.");
    return errors;
  }

  if (!trimToString(appContext.moduleName)) {
    errors.push("app-context.json: moduleName is required.");
  }

  const createApp = appContext.createApp === true;
  const seedAppId = trimToString(appContext.seedAppId);
  if (!createApp && !seedAppId && !trimToString(appContext.appId)) {
    errors.push("app-context.json: appId is required unless createApp is true or seedAppId is provided.");
  }

  if (appContext.seedAppId !== undefined && typeof appContext.seedAppId !== "string") {
    errors.push("app-context.json: seedAppId must be a string when provided.");
  }

  if (appContext.branch !== undefined && typeof appContext.branch !== "string") {
    errors.push("app-context.json: branch must be a string when provided.");
  }

  if (appContext.layoutQualifiedName !== undefined && typeof appContext.layoutQualifiedName !== "string") {
    errors.push("app-context.json: layoutQualifiedName must be a string when provided.");
  }

  if (appContext.homePageRef !== undefined && typeof appContext.homePageRef !== "string") {
    errors.push("app-context.json: homePageRef must be a string when provided.");
  }

  if (appContext.commit !== undefined && typeof appContext.commit !== "boolean") {
    errors.push("app-context.json: commit must be a boolean when provided.");
  }

  if (appContext.commitMessage !== undefined && typeof appContext.commitMessage !== "string") {
    errors.push("app-context.json: commitMessage must be a string when provided.");
  }

  if (appContext.createApp !== undefined && typeof appContext.createApp !== "boolean") {
    errors.push("app-context.json: createApp must be a boolean when provided.");
  }

  if (appContext.createAppNamePrefix !== undefined && typeof appContext.createAppNamePrefix !== "string") {
    errors.push("app-context.json: createAppNamePrefix must be a string when provided.");
  }
  if (appContext.appName !== undefined && typeof appContext.appName !== "string") {
    errors.push("app-context.json: appName must be a string when provided.");
  }

  if (appContext.createAppRepositoryType !== undefined && appContext.createAppRepositoryType !== "git") {
    errors.push('app-context.json: createAppRepositoryType must be "git" when provided.');
  }

  return errors;
}

function parseUserStories(userStoriesText) {
  const lines = String(userStoriesText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((raw, index) => {
    const cleaned = raw.replace(/\.$/, "");
    const match = cleaned.match(/^as\s+(?:an?|the)\s+([^,]+),\s*i\s+want\s+(.+?)(?:\s+so\s+that\s+(.+))?$/i);
    const role = match ? trimToString(match[1]) : "User";
    const want = match ? trimToString(match[2]) : cleaned;
    const benefit = match ? trimToString(match[3]) : "";

    const tags = STORY_TAG_RULES.filter((rule) => rule.re.test(cleaned)).map((rule) => rule.tag);

    return {
      id: `US${String(index + 1).padStart(2, "0")}`,
      raw,
      role,
      want,
      benefit,
      tags: uniq(tags),
      tokens: uniq(tokenize(`${role} ${want} ${benefit}`))
    };
  });
}

function loadInputBundle(inputDirectory) {
  const inputDir = path.resolve(inputDirectory);
  const files = {
    stories: path.join(inputDir, "user-stories.txt"),
    appContext: path.join(inputDir, "app-context.json"),
    domainInfo: path.join(inputDir, "domain-info.txt"),
    acceptanceCriteria: path.join(inputDir, "acceptance-criteria.txt"),
    bpmn: path.join(inputDir, "process.bpmn")
  };

  const missing = [];
  if (!fs.existsSync(files.stories)) missing.push("user-stories.txt");
  if (!fs.existsSync(files.appContext)) missing.push("app-context.json");
  if (missing.length > 0) {
    throw new PlanGeneratorError(`Missing required input file(s): ${missing.join(", ")}.`);
  }

  const userStories = readTextFile(files.stories).trim();
  if (!userStories) {
    throw new PlanGeneratorError("user-stories.txt is empty. Provide at least one user story.");
  }

  let appContext;
  try {
    appContext = JSON.parse(readTextFile(files.appContext));
  } catch (err) {
    throw new PlanGeneratorError(`app-context.json is not valid JSON: ${err.message}`);
  }

  const appContextErrors = validateAppContext(appContext);
  if (appContextErrors.length > 0) {
    throw new PlanGeneratorError("Invalid app-context.json.", appContextErrors);
  }

  const domainInfo = readOptionalTextFile(files.domainInfo).trim();
  const acceptanceCriteria = readOptionalTextFile(files.acceptanceCriteria).trim();

  const warnings = [];
  let bpmnText = "";
  if (fs.existsSync(files.bpmn)) {
    bpmnText = readTextFile(files.bpmn).trim();
    warnings.push("process.bpmn was provided but is ignored in v1.");
  }

  const stories = parseUserStories(userStories);

  return {
    inputDir,
    files,
    appContext,
    userStories,
    stories,
    domainInfo,
    acceptanceCriteria,
    bpmnText,
    warnings
  };
}

function clipText(input, maxChars) {
  const source = String(input || "");
  if (source.length <= maxChars) return source;
  return `${source.slice(0, maxChars)}\n\n[TRUNCATED: ${source.length - maxChars} chars omitted]`;
}

function normalizeSecurityLevel(rawLevel) {
  const value = trimToString(rawLevel).toLowerCase();
  if (!value) return "prototype";
  if (["none", "off"].includes(value)) return value;
  if (["prototype", "production"].includes(value)) return "prototype";
  if (["dev", "development", "demo", "test", "testing", "sandbox"].includes(value)) return "prototype";
  if (["prod", "live", "strict"].includes(value)) return "prototype";
  if (["disabled", "false", "no"].includes(value)) return "off";
  return "prototype";
}

function createVisualNarratorState({
  enabled = false,
  status = "skipped",
  durationMs = 0,
  command = "",
  artifacts = {},
  warnings = [],
  error = "",
  summary = null,
  promptText = ""
} = {}) {
  const normalizedSummary = summary && typeof summary === "object"
    ? summary
    : {
        classNames: [],
        classes: [],
        relationships: [],
        keyNouns: [],
        inferredRoles: []
      };

  return {
    enabled,
    status,
    durationMs,
    command,
    artifacts,
    warnings: Array.isArray(warnings) ? warnings.map((entry) => String(entry)) : [],
    error: trimToString(error),
    summary: normalizedSummary,
    promptText: trimToString(promptText)
  };
}

function getInputArtifactPath(inputDir, fileName) {
  return path.join(path.resolve(inputDir), fileName);
}

function detectVisualNarratorInputArtifacts(inputDir) {
  const rawPath = getInputArtifactPath(inputDir, "visual-narrator-result.json");
  return {
    rawPath,
    summaryPath: getInputArtifactPath(inputDir, "visual-narrator-summary.json"),
    storiesPath: getInputArtifactPath(inputDir, "visual-narrator-stories.json"),
    ontologyPath: getInputArtifactPath(inputDir, "visual-narrator-ontology.omn"),
    available: fs.existsSync(rawPath)
  };
}

function loadMockVisualNarratorResult({ mockPath, outputDir }) {
  const absolute = path.resolve(mockPath);
  const raw = JSON.parse(fs.readFileSync(absolute, "utf8"));
  const summary = normalizeVisualNarratorSummary(raw);
  const artifacts = writeVisualNarratorArtifacts({
    outputDir,
    result: raw
  });

  return createVisualNarratorState({
    enabled: true,
    status: "completed",
    durationMs: 0,
    command: `mock:${absolute}`,
    artifacts,
    warnings: [],
    error: "",
    summary,
    promptText: buildVisualNarratorPromptText(summary, raw.ontology || "")
  });
}

function loadInputVisualNarratorResult({ inputDir, outputDir }) {
  const detected = detectVisualNarratorInputArtifacts(inputDir);
  if (!detected.available) {
    throw new PlanGeneratorError(
      `Visual Narrator input artifact not found: ${path.basename(detected.rawPath)}.`
    );
  }

  const raw = JSON.parse(fs.readFileSync(detected.rawPath, "utf8"));
  const summary = normalizeVisualNarratorSummary(raw);
  const artifacts = writeVisualNarratorArtifacts({
    outputDir,
    result: raw
  });

  return createVisualNarratorState({
    enabled: true,
    status: "completed",
    durationMs: 0,
    command: `input-artifact:${detected.rawPath}`,
    artifacts,
    warnings: [],
    error: "",
    summary,
    promptText: buildVisualNarratorPromptText(summary, raw.ontology || "")
  });
}

function createProcessVisualizerState({
  enabled = false,
  status = "skipped",
  durationMs = 0,
  command = "",
  artifacts = {},
  warnings = [],
  error = "",
  summary = null,
  promptText = ""
} = {}) {
  const normalizedSummary = summary && typeof summary === "object"
    ? summary
    : {
        actors: [],
        tasks: [],
        gateways: [],
        processObjects: [],
        capabilityHints: {}
      };

  return {
    enabled,
    status,
    durationMs,
    command,
    artifacts,
    warnings: Array.isArray(warnings) ? warnings.map((entry) => String(entry)) : [],
    error: trimToString(error),
    summary: normalizedSummary,
    promptText: trimToString(promptText)
  };
}

function detectProcessVisualizerInputArtifacts(inputDir) {
  const rawPath = getInputArtifactPath(inputDir, "process-visualizer-result.json");
  return {
    rawPath,
    summaryPath: getInputArtifactPath(inputDir, "process-visualizer-summary.json"),
    runDir: getInputArtifactPath(inputDir, "process-visualizer-run"),
    available: fs.existsSync(rawPath)
  };
}

function loadMockProcessVisualizerResult({ mockPath, outputDir }) {
  const absolute = path.resolve(mockPath);
  const raw = JSON.parse(fs.readFileSync(absolute, "utf8"));
  const summary = normalizeProcessVisualizerSummary(raw);
  const artifacts = writeProcessVisualizerArtifacts({
    outputDir,
    result: raw
  });

  return createProcessVisualizerState({
    enabled: true,
    status: "completed",
    durationMs: 0,
    command: `mock:${absolute}`,
    artifacts,
    warnings: [],
    error: "",
    summary,
    promptText: buildProcessVisualizerPromptText(summary)
  });
}

function loadInputProcessVisualizerResult({ inputDir, outputDir }) {
  const detected = detectProcessVisualizerInputArtifacts(inputDir);
  if (!detected.available) {
    throw new PlanGeneratorError(
      `Process Visualizer input artifact not found: ${path.basename(detected.rawPath)}.`
    );
  }

  const raw = JSON.parse(fs.readFileSync(detected.rawPath, "utf8"));
  const summary = normalizeProcessVisualizerSummary(raw);
  const artifacts = writeProcessVisualizerArtifacts({
    outputDir,
    result: raw
  });

  return createProcessVisualizerState({
    enabled: true,
    status: "completed",
    durationMs: 0,
    command: `input-artifact:${detected.rawPath}`,
    artifacts,
    warnings: [],
    error: "",
    summary,
    promptText: buildProcessVisualizerPromptText(summary)
  });
}

function walkFilesRecursive(rootDir) {
  const files = [];
  if (!fs.existsSync(rootDir)) return files;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function scoreByTokenOverlap(content, queryTokens) {
  if (!content || queryTokens.length === 0) return 0;
  const lower = content.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (lower.includes(token)) score += 1;
  }
  return score;
}

function summarizeExamplePlan(filePath, warnings) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const entities = Array.isArray(parsed.domainModel && parsed.domainModel.entities)
      ? parsed.domainModel.entities.map((e) => e && e.name).filter(Boolean)
      : [];
    const pages = Array.isArray(parsed.pages && parsed.pages.specs)
      ? parsed.pages.specs.map((p) => p && p.name).filter(Boolean)
      : [];
    const stepTypes = new Set();
    for (const page of (parsed.pages && parsed.pages.specs) || []) {
      for (const step of (page && page.content) || []) {
        if (step && step.type) stepTypes.add(String(step.type));
      }
    }
    return {
      name: path.basename(filePath),
      entities: entities.slice(0, 14),
      pages: pages.slice(0, 14),
      stepTypes: Array.from(stepTypes).slice(0, 20)
    };
  } catch (err) {
    warnings.push(`Failed to summarize example plan ${filePath}: ${err.message}`);
    return null;
  }
}

function buildExamplePlansBlock(examplePlanPaths, warnings) {
  const summaries = [];
  for (const rawPath of examplePlanPaths || []) {
    const filePath = path.resolve(rawPath);
    if (!fs.existsSync(filePath)) {
      warnings.push(`Example plan not found and skipped: ${filePath}`);
      continue;
    }
    const summary = summarizeExamplePlan(filePath, warnings);
    if (summary) summaries.push(summary);
  }

  if (summaries.length === 0) return "";

  return summaries
    .map((s) => {
      return [
        `### ${s.name}`,
        `- entities: ${s.entities.join(", ") || "(none)"}`,
        `- pages: ${s.pages.join(", ") || "(none)"}`,
        `- stepTypes: ${s.stepTypes.join(", ") || "(none)"}`
      ].join("\n");
    })
    .join("\n\n");
}

function buildKnowledgeBlock({ knowledgeDir, queryText, warnings }) {
  if (!knowledgeDir) return "";
  const absDir = path.resolve(knowledgeDir);
  if (!fs.existsSync(absDir)) {
    warnings.push(`Knowledge directory not found and skipped: ${absDir}`);
    return "";
  }

  const allowedExt = new Set([".md", ".txt"]);
  const files = walkFilesRecursive(absDir).filter((f) => allowedExt.has(path.extname(f).toLowerCase()));
  if (files.length === 0) {
    warnings.push(`No .md/.txt knowledge files found in ${absDir}.`);
    return "";
  }

  const queryTokens = uniq(tokenize(queryText)).slice(0, 80);
  const scored = [];
  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const score = scoreByTokenOverlap(content, queryTokens);
      if (score > 0) {
        scored.push({ filePath, score, content });
      }
    } catch (_err) {
      // Skip unreadable files.
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 6);
  if (top.length === 0) {
    warnings.push("Knowledge retrieval found no relevant documentation chunks for this prompt.");
    return "";
  }

  return top
    .map((entry) => {
      const relative = path.relative(process.cwd(), entry.filePath) || entry.filePath;
      return `### ${relative} (score=${entry.score})\n${clipText(entry.content, 800)}`;
    })
    .join("\n\n");
}

function addWeightedCandidate(map, rawName, score, source, storyIds = []) {
  const name = toPascalCase(rawName, "");
  const key = toConceptKey(name);
  if (!name || !key || isGenericConceptName(name)) return;
  const entry = map.get(key) || {
    name,
    score: 0,
    sources: new Set(),
    storyIds: new Set()
  };
  entry.score += Number(score || 0);
  if (source) entry.sources.add(String(source));
  for (const storyId of storyIds || []) {
    if (storyId) entry.storyIds.add(String(storyId));
  }
  if (name.length > entry.name.length) entry.name = name;
  map.set(key, entry);
}

function collectStoryEntityPhraseCandidates(stories) {
  const candidates = new Map();
  const adjacentNounPhraseRe = /\b([a-z][a-z0-9]*)\s+([a-z][a-z0-9]*)s?\b/gi;
  const actionObjectPhraseRe = /\b(?:add|approve|assign|attach|audit|choose|create|edit|generate|include|link|manage|maintain|record|review|select|start|submit|track|update|upload|view)\s+(?:a|an|the|new|existing|pending|specific|all|my|our)?\s*([a-z][a-z0-9]*(?:\s+[a-z][a-z0-9]*){0,3})/gi;
  const phraseConnectors = new Set(["and", "or", "to", "for", "from", "with", "by", "on", "in", "into", "of", "that", "so"]);
  const weakPhraseModifiers = new Set(["specific", "pending", "high", "value", "which", "available", "new", "detailed", "existing", "each", "every", "planned", "selected", "current"]);

  function cleanPhrase(rawPhrase) {
    const parts = String(rawPhrase || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((part) => singularizeWord(part))
      .filter(Boolean);
    const connectorIndex = parts.findIndex((part) => phraseConnectors.has(part));
    const trimmed = connectorIndex >= 0 ? parts.slice(0, connectorIndex) : parts;
    while (trimmed.length > 0 && weakPhraseModifiers.has(trimmed[0])) trimmed.shift();
    while (trimmed.length > 0 && weakPhraseModifiers.has(trimmed[trimmed.length - 1])) trimmed.pop();
    return trimmed.filter((part) => !phraseConnectors.has(part));
  }

  function addPhraseCandidate(rawPhrase, score, source, storyIds) {
    const parts = cleanPhrase(rawPhrase);
    if (parts.length < 2) return;
    const [modifier] = parts;
    const head = parts[parts.length - 1];
    if (!modifier || !head) return;
    if (GENERIC_ENTITY_STOP_WORDS.has(modifier) || weakPhraseModifiers.has(modifier)) return;
    if (STOP_WORDS.has(head) || weakPhraseModifiers.has(head)) return;
    addWeightedCandidate(candidates, parts.join(" "), score, source, storyIds);
  }

  for (const story of stories || []) {
    const text = `${story.want} ${story.benefit}`;
    let match = actionObjectPhraseRe.exec(text);
    while (match) {
      addPhraseCandidate(match[1], 2.25, "story_action_object", [story.id]);
      match = actionObjectPhraseRe.exec(text);
    }

    match = adjacentNounPhraseRe.exec(text);
    while (match) {
      const modifier = singularizeWord(match[1]);
      const head = singularizeWord(match[2]);
      if (modifier && head) addPhraseCandidate(`${modifier} ${head}`, 1.25, "story_noun_phrase", [story.id]);
      match = adjacentNounPhraseRe.exec(text);
    }

    for (const token of tokenize(text)) {
      const singular = singularizeWord(token);
      if (!singular || GENERIC_ENTITY_STOP_WORDS.has(singular)) continue;
      addWeightedCandidate(candidates, singular, 1, "story_token", [story.id]);
    }
  }

  return Array.from(candidates.values()).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function collectDomainInfoEntityCandidates(domainInfo = "") {
  const candidates = [];
  const entityLineRe = /^\s*(?:[-*]\s*)?([A-Z][A-Za-z0-9_]*(?:\s+[A-Z][A-Za-z0-9_]*){0,4})\s*:/;
  const conceptLineRe = /\b(?:concept|entity|domain concept)\s*:\s*([A-Z][A-Za-z0-9_]*(?:\s+[A-Z][A-Za-z0-9_]*){0,4})/i;
  for (const line of String(domainInfo || "").split(/\n+/)) {
    const match = line.match(entityLineRe) || line.match(conceptLineRe);
    if (!match) continue;
    const name = toPascalCase(match[1], "");
    if (!name || isGenericConceptName(name) || isLikelyGeneratedArtifactEntity(name)) continue;
    candidates.push(name);
  }
  return uniq(candidates);
}

function deriveCapabilityFlags() {
  return {
    notifications: false,
    comments: false,
    attachments: false,
    approvals: false,
    reporting: false,
    searchFilter: false,
    audit: false,
    profiles: false,
    departments: false,
    roles: false,
    periods: false,
    decisions: false,
    workflowLikeRouting: false
  };
}

function defaultAttributesForEntity(entityName) {
  const make = (name, type, required) => ({ name, type, required });
  return [
    make("Title", "String", true),
    make("Description", "String", false),
    make("Status", "String", false),
    make("CreatedAt", "DateTime", false)
  ];
}

const FALLBACK_ATTRIBUTE_KEYS = new Set(["name", "title", "description", "status", "createdat", "createdon"]);
const ACTION_LIKE_ENTITY_TOKENS = new Set([
  "add", "added", "assign", "book", "booked", "booking", "call", "cancel", "change", "choose", "confirm", "edit",
  "extend", "know", "link", "login", "log", "manage", "notify", "open", "receive", "remove", "reset", "see",
  "select", "set", "start", "submit", "unsubscribe", "update", "use", "view"
]);

function isFallbackAttributeName(rawName) {
  const key = String(rawName || "").replace(/[_\s-]+/g, "").toLowerCase();
  return FALLBACK_ATTRIBUTE_KEYS.has(key) || /^attribute\d+$/i.test(String(rawName || ""));
}

function entityHasOnlyFallbackAttributes(entity) {
  const attrs = Array.isArray(entity && entity.attributes) ? entity.attributes : [];
  if (attrs.length === 0) return true;
  return attrs.every((attr) => isFallbackAttributeName(attr && attr.name));
}

function concreteAttributeCount(entity) {
  return (Array.isArray(entity && entity.attributes) ? entity.attributes : [])
    .filter((attr) => attr && attr.name && !isFallbackAttributeName(attr.name))
    .length;
}

function isPersonLikeEntity(name) {
  return PERSON_ENTITY_RE.test(splitCamelCase(name));
}

function isAuxiliaryEntity(name) {
  return AUXILIARY_ENTITY_RE.test(splitCamelCase(name));
}

function choosePrimaryEntityName(entityNames) {
  const names = (entityNames || []).filter(Boolean);
  const primary = names.find((name) => !isAuxiliaryEntity(name));
  return primary || names[0] || "";
}

function buildAssociationSpec(parentEntity, childEntity, nameHint = "") {
  const safeParent = toPascalCase(parentEntity, "Parent");
  const safeChild = toPascalCase(childEntity, "Child");
  return {
    name: toSafeName(nameHint || `${safeParent}_${safeChild}`, `${safeParent}_${safeChild}`),
    parentEntity: safeParent,
    childEntity: safeChild,
    type: "Reference",
    owner: "Both"
  };
}

function deriveAssociationCandidates({ entityNames, stories, visualNarratorSummary, processVisualizerSummary = null }) {
  const entities = new Set((entityNames || []).map((name) => toPascalCase(name, "")).filter(Boolean));
  const associations = [];
  const seen = new Set();
  const add = (parent, child, nameHint) => {
    const parentName = toPascalCase(parent, "");
    const childName = toPascalCase(child, "");
    if (!parentName || !childName || parentName === childName) return;
    if (!entities.has(parentName) || !entities.has(childName)) return;
    const key = `${parentName.toLowerCase()}|${childName.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    associations.push(buildAssociationSpec(parentName, childName, nameHint));
  };

  for (const rel of (visualNarratorSummary && visualNarratorSummary.relationships) || []) {
    add(rel.domain, rel.range, rel.name || `${rel.domain}_${rel.range}`);
  }

  for (const intent of collectStoryBackedAssociationIntents(stories, Array.from(entities))) {
    add(intent.parentEntity, intent.childEntity, `${intent.parentEntity}_${intent.childEntity}`);
  }

  return associations;
}

function collectDeterministicAssociationHints({ plan, stories, visualNarrator, processVisualizer }) {
  const entities = Array.isArray(plan && plan.domainModel && plan.domainModel.entities) ? plan.domainModel.entities : [];
  const entityNames = entities.map((entity) => entity && entity.name).filter(Boolean);
  const entityNameByKey = new Map(entityNames.map((name) => [normalizeEntityToken(name), name]));
  const hints = [];
  const seen = new Set();
  const addHint = ({ parentEntity, childEntity, source, storyId = "", matchedWording = "", evidence = "", reason = "", confidence = 0.5 }) => {
    const parent = entityNameByKey.get(normalizeEntityToken(parentEntity));
    const child = entityNameByKey.get(normalizeEntityToken(childEntity));
    if (!parent || !child || normalizeEntityToken(parent) === normalizeEntityToken(child)) return;
    const key = `${source}|${parent.toLowerCase()}|${child.toLowerCase()}|${storyId}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({
      parentEntity: parent,
      childEntity: child,
      source,
      storyId,
      matchedWording,
      evidence,
      reason,
      confidence,
      directionSignal: `${parent} is the contextual/editing side; ${child} is the selected/referenced side.`
    });
  };

  for (const intent of collectStoryBackedAssociationIntents(stories, entityNames)) {
    const story = (stories || []).find((candidate) => candidate && candidate.id === intent.storyId);
    addHint({
      parentEntity: intent.parentEntity,
      childEntity: intent.childEntity,
      source: "story_pattern",
      storyId: intent.storyId,
      matchedWording: story && story.raw ? story.raw : "",
      evidence: story && story.raw ? story.raw : intent.reason,
      reason: intent.reason,
      confidence: 0.72
    });
  }

  for (const rel of (visualNarrator && visualNarrator.summary && visualNarrator.summary.relationships) || []) {
    addHint({
      parentEntity: rel && (rel.domain || rel.parentEntity || rel.source),
      childEntity: rel && (rel.range || rel.childEntity || rel.target),
      source: "visual_narrator",
      matchedWording: rel && rel.name || "",
      evidence: rel && rel.name || "",
      reason: "Visual Narrator emitted a relationship between finalized entities.",
      confidence: 0.6
    });
  }

  for (const hint of (processVisualizer && processVisualizer.summary && processVisualizer.summary.relationshipHints) || []) {
    addHint({
      parentEntity: hint && hint.parentEntity,
      childEntity: hint && hint.childEntity,
      source: "process_visualizer",
      matchedWording: hint && hint.reason || "",
      evidence: hint && hint.reason || "",
      reason: "Process Visualizer emitted a relationship hint between finalized entities.",
      confidence: 0.58
    });
  }

  return hints;
}

function buildBaselineEntityCandidates({ stories, moduleName, domainInfo = "", visualNarratorSummary, processVisualizerSummary = null }) {
  const candidates = new Map();
  for (const candidate of collectStoryEntityPhraseCandidates(stories)) {
    addWeightedCandidate(candidates, candidate.name, candidate.score, "story_evidence", Array.from(candidate.storyIds || []));
  }
  for (const name of collectDomainInfoEntityCandidates(domainInfo)) {
    addWeightedCandidate(candidates, name, 3, "domain_info");
  }
  for (const name of (processVisualizerSummary && processVisualizerSummary.processObjects) || []) {
    const storyBacked = (stories || []).some((story) => storyMentionsTerm(story, name));
    if (!storyBacked) continue;
    addWeightedCandidate(candidates, name, 0.75, "process_visualizer");
  }
  for (const entry of inferEntityNamesFromVisualNarrator(visualNarratorSummary || {}, moduleName) || []) {
    const key = toConceptKey(entry.name);
    const existing = candidates.get(key);
    if (!existing) continue;
    addWeightedCandidate(candidates, entry.name, Math.min(2, Math.max(0.75, existing.score * 0.2)), "visual_narrator");
  }
  for (const noun of (visualNarratorSummary && visualNarratorSummary.keyNouns) || []) {
    const key = toConceptKey(noun.term);
    if (!candidates.has(key)) continue;
    addWeightedCandidate(candidates, noun.term, Math.min(1.5, Number(noun.weight || 0) * 0.25), "vn_key_noun");
  }

  const sorted = Array.from(candidates.values()).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const names = [];
  for (const entry of sorted) {
    const roleMatch = (stories || []).some((story) => {
      const roleTerms = splitRoleTerms(story.role);
      return roleTerms.length > 0 && toConceptKey(entry.name) === roleTerms.join(" ");
    });
    if (roleMatch && !isPersonLikeEntity(entry.name) && !(visualNarratorSummary && visualNarratorSummary.classNames || []).includes(entry.name)) {
      continue;
    }
    names.push(entry.name);
    if (names.length >= 8) break;
  }
  return dedupeByName(names.map((name) => ({ name, attributes: defaultAttributesForEntity(name) })), (entry) => entry.name);
}

function buildOllamaPrompt({
  stories,
  domainInfo,
  acceptanceCriteria = "",
  visualNarratorPromptText,
  processVisualizerPromptText,
  appContext,
  examplePlansText,
  knowledgeText
}) {
  const moduleName = trimToString(appContext.moduleName) || "MyFirstModule";
  const storiesText = stories
    .map((s) => `${s.id}: ${s.raw}`)
    .join("\n");

  const parts = [
    "You are generating a Mendix pipeline plan draft for user stories.",
    "You should always keep in mind that the output will be used for a Mendix app.",
    "Return only valid JSON. Do not use markdown.",
    "",
    "HARD RULES:",
    "- Business domain MUST align with the user stories. Do not switch to unrelated domains.",
    "- Output sections supported by this phase: domainModel, security, pages, microflows, nanoflows, and workflows.",
    "- Build one coherent Mendix domain model, not a bag of entities.",
    "- Non-config entities should usually participate in at least one association; do not leave auxiliary entities isolated unless the stories clearly require it.",
    "- Give each operational entity concrete usable attributes, not just a placeholder Name field.",
    "- Operational entities should have meaningful and useful attributes.",
    "- First derive the domain model from the user stories and domain info alone, then use Visual Narrator and Process Visualizer only as supporting evidence for missed concepts, relationships, actors, or process flow.",
    "- Treat Visual Narrator and Process Visualizer as supportive data, not as ground truth and not as lists to append blindly.",
    "- When needed according to the user stories, create a user entity with relevant attributes. ",


    "",
    "OUTPUT SHAPE:",
    "- domainModel: entities[], associations[], enumerations[]",
    "- domainModel.associations[] MUST use {name,parentEntity,childEntity,type}. parentEntity and childEntity MUST exactly match entity names from domainModel.entities[].",
    "- Do not use ambiguous association endpoint fields such as source/target, entity1/entity2, nested endpoint objects, labels, or prose-only relationship descriptions.",
    "- security: enabled, securityLevel, moduleRoles[], userRoles[]",
    "- microflows: specs[] when stories require calculations, status changes, automation, validation, workflow handlers, or button-triggered business logic",
    "- nanoflows: specs[] when stories require supported client-side button-triggered logic",
    "- workflows: specs[] when stories require approval, review, reject/approve outcomes, workflow tasks, or routed human work",
    "- pages: specs[]",
    "",
    "DOMAIN MODEL RUBRIC:",
    "- Prefer business entities that users create, edit, review, assign, approve, report on, or audit.",
    "- Avoid duplicate or overlapping entities unless the stories clearly distinguish them.",
    "- Auxiliary entities such as comments, attachments, approvals, notifications, reports, logs, periods, roles, or profiles should only exist if story-backed and connected to the main graph.",
    "- Prefer associations that reflect actor-to-record, record-to-catalog, or record-to-supporting-artifact relationships visible in the stories.",
    "- Do not produce stub entities with only Name unless the stories support a true catalog/configuration concept.",
    "",
    "ANTI-PATTERNS TO AVOID:",
    "- Generic abstractions such as Work, What, Data, Information, Quality, or Progress as standalone entities.",
    "- Duplicate singular/plural or near-synonym entities.",
    "- Disconnected auxiliary entities with no associations.",
    "- Technical or implementation concepts such as microflows, workflows, pages, forms, lists, buttons, tasks, or views as persisted entities unless the stories explicitly model them as business records.",
    "- Detail pages that contain only headers and no editable form content.",
    "",
    "SECURITY RULES:",
    "- security is mandatory in every generated plan.",
    "- Infer user roles from the user stories, domain info, and any clearly implied actors.",
    "- Prefer app-specific role names such as Manager, Employee, IntakeCoordinator, or CaseWorker.",
    "- Do not use reserved built-in Mendix project user role names like User or Administrator as security.userRoles names.",
    "- Every security.userRoles entry should map to at least one module role.",
    "- If a role needs elevated administration rights, express that via systemModuleRole instead of using a built-in project user role name.",
    "",
    "PAGE RULES:",
    `- Supported page steps include: ${Array.from(SUPPORTED_PAGE_STEP_TYPES).join(", ")}.`,
    "- Detail pages should use a dataView with attribute and association inputs when the entity has editable attributes/relations.",
    "- If a workflow is generated, include a page or detail action that starts it with callWorkflowButton and include a workflow task page for user-task outcomes.",
    "- If a microflow or nanoflow is generated for user-triggered logic, include a matching callMicroflowButton or callNanoflowButton where the user story expects the action.",
    "- Follow the workflow pattern from the reference approval example: use the story-backed business context entity, handler microflows with a WorkflowContext parameter, workflows.specs with serviceTask/userTask/outcomes, a start action using callWorkflowButton, and a task page bound to System.WorkflowUserTask.",
    "- Never represent Workflow, Microflow, WorkflowTask, Task UI, Page, View, List, Button, or Form as domainModel entities just because the story mentions app behavior.",
    "- You may choose recommended generic Mendix archetypes when they fit the stories, but they are optional, not mandatory.",
    "- Recommended optional archetypes include: home hub (title/subtitle/buttons), dashboard or overview with database-backed listView plus create button, and popup NewEdit pages with PopupLayout and a context dataView.",
    "- Do not force every app into the same archetype. Choose page patterns that best fit the stories and supported plan contract.",
    `- ${navigationIconPolicyForPrompt()}`,
    "",
    "FLOW RULES:",
    "- Generate microflows, nanoflows, or workflows only when the user stories clearly require executable logic, client-side logic, routed human work, approvals, or task outcomes supported by this JSON plan contract.",
    "- Every generated flow must be story-backed and reachable through a page action, a workflow service task, or another generated flow.",
    `- Supported microflow/nanoflow action types include: ${SUPPORTED_MICROFLOW_ACTION_TYPES.join(", ")}.`,
    `Module name: ${moduleName}`,
    "",
    "USER STORIES (all required):",
    clipText(storiesText, 22000),
    "",
    "OPTIONAL DOMAIN INFO:",
    domainInfo ? clipText(domainInfo, 6000) : "(not provided)",
    "",
    "ACCEPTANCE CRITERIA:",
    acceptanceCriteria ? clipText(acceptanceCriteria, 6000) : "(not provided)",
    "",
    "VISUAL NARRATOR EVIDENCE:",
    visualNarratorPromptText ? clipText(visualNarratorPromptText, 9000) : "(not provided)",
    "",
    "PROCESS VISUALIZER EVIDENCE:",
    processVisualizerPromptText ? clipText(processVisualizerPromptText, 7000) : "(not provided)"
  ];

  if (examplePlansText) {
    parts.push("", "EXAMPLE PLAN SHAPES (for structure only):", clipText(examplePlansText, 8000));
  }

  if (knowledgeText) {
    parts.push("", "MENDIX KNOWLEDGE (for constraints/supported constructs):", clipText(knowledgeText, 6000));
  }

  parts.push(
    "",
    "FINAL CHECK BEFORE YOU RETURN JSON:",
    "- Keep entity and page names meaningful and consistent.",
    "- Include workflows.specs only when stories clearly require routed human work, approval/rejection outcomes, or workflow task UI; include needed handler microflows and task pages.",
    "- Include microflows.specs or nanoflows.specs only when stories require trigger, calculate, automate, update status, validate, or client-side behavior; connect user-triggered flows from page actions.",
    "- Do not create CRUD entities/pages for Workflow or Microflow; those belong in workflows.specs and microflows.specs.",
    "- Make sure associated entities expose editable relation inputs on detail pages.",
    "- Include Home page with ref 'home'."
  );

  return parts.join("\n");
}

function buildRepairPrompt({ stories, missingStories, currentPlan, appContext }) {
  const moduleName = trimToString(appContext.moduleName) || "MyFirstModule";
  return [
    "Repair the plan so missing user stories are covered.",
    "Return only valid JSON with domainModel, security, microflows, workflows, and pages sections as needed.",
    `Module name: ${moduleName}`,
    "",
    "All stories:",
    stories.map((s) => `${s.id}: ${s.raw}`).join("\n"),
    "",
    "Missing stories that must become covered:",
    missingStories.map((s) => `${s.id}: ${s.raw}`).join("\n"),
    "",
    "Current plan:",
    clipText(JSON.stringify(currentPlan, null, 2), 18000),
    "",
    "Repair rules:",
    "- Keep existing correct entities/pages.",
    "- Keep security mandatory and preserve or improve the existing security section.",
    "- Add only required new entities/pages/attributes/microflows/workflows for missing stories.",
    "- If missing stories mention workflow, approval, approve, reject, or task UI, repair with workflows.specs plus needed handler microflows and workflow task pages.",
    "- If missing stories mention trigger, calculate, automate, update status, or validate, repair with microflows.specs and page actions.",
    "- Keep output valid for pipeline validation."
  ].join("\n");
}

function getOllamaOutputSchema() {
  return {
    type: "object",
    additionalProperties: true,
    required: ["domainModel", "pages"],
    properties: {
      domainModel: {
        type: "object",
        additionalProperties: true,
        required: ["entities"],
        properties: {
          entities: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              required: ["name"],
              properties: {
                name: { type: "string" },
                attributes: { type: "array" },
                indexes: { type: "array" }
              }
            }
          },
          associations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              required: ["name", "parentEntity", "childEntity", "type"],
              properties: {
                name: { type: "string" },
                parentEntity: { type: "string" },
                childEntity: { type: "string" },
                type: { type: "string" },
                owner: { type: "string" }
              }
            }
          },
          enumerations: { type: "array" }
        }
      },
      security: {
        type: "object",
        additionalProperties: true,
        properties: {
          enabled: { type: "boolean" },
          securityLevel: { type: "string" },
          moduleRoles: { type: "array" },
          userRoles: { type: "array" },
          demoUsers: { type: "array" }
        }
      },
      microflows: {
        type: "object",
        additionalProperties: true,
        properties: {
          specs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              required: ["name"],
              properties: {
                ref: { type: "string" },
                name: { type: "string" },
                parameters: { type: "array" },
                actions: { type: "array" },
                allowedRoles: { type: "array" }
              }
            }
          }
        }
      },
      workflows: {
        type: "object",
        additionalProperties: true,
        properties: {
          specs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              required: ["name", "steps"],
              properties: {
                ref: { type: "string" },
                name: { type: "string" },
                bindings: { type: "object" },
                steps: { type: "array" }
              }
            }
          }
        }
      },
      pages: {
        type: "object",
        additionalProperties: true,
        required: ["specs"],
        properties: {
          specs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              required: ["name"],
              properties: {
                ref: { type: "string" },
                name: { type: "string" },
                title: { type: "string" },
                entityRef: { type: "string" },
                content: { type: "array" }
              }
            }
          }
        }
      },
      verification: { type: "object" }
    }
  };
}

function getDomainModelReviewSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      entities: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "verdict"],
          properties: {
            name: { type: "string" },
            verdict: { type: "string", enum: ["keep", "drop", "repair"] },
            attributes: { type: "array" },
            evidence: { type: "array", items: { type: "string" } },
            reason: { type: "string" }
          }
        }
      },
      associations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["name", "verdict"],
          properties: {
            name: { type: "string" },
            verdict: { type: "string", enum: ["keep", "drop", "repair"] },
            parentEntity: { type: "string" },
            childEntity: { type: "string" },
            type: { type: "string" },
            evidence: { type: "array", items: { type: "string" } },
            reason: { type: "string" }
          }
        }
      },
      warnings: { type: "array", items: { type: "string" } }
    }
  };
}

function getEntityCoverageSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["storyCoverage", "missingEntityCandidates", "missingAttributeCandidates", "misclassifiedConcepts", "relationshipHints"],
    properties: {
      storyCoverage: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["storyId", "coveredConcepts", "missingConcepts", "reason"],
          properties: {
            storyId: { type: "string" },
            coveredConcepts: { type: "array", items: { type: "string" } },
            missingConcepts: { type: "array", items: { type: "string" } },
            reason: { type: "string" }
          }
        }
      },
      missingEntityCandidates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["name", "attributes", "reason"],
          properties: {
            name: { type: "string" },
            attributes: { type: "array" },
            evidence: { type: "array", items: { type: "string" } },
            reason: { type: "string" }
          }
        }
      },
      missingAttributeCandidates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["entity", "name", "type", "evidenceStoryIds", "evidenceQuote", "reason"],
          properties: {
            entity: { type: "string" },
            name: { type: "string" },
            type: { type: "string" },
            evidenceStoryIds: { type: "array", items: { type: "string" } },
            evidenceQuote: { type: "string" },
            evidence: { type: "array", items: { type: "string" } },
            reason: { type: "string" }
          }
        }
      },
      misclassifiedConcepts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            name: { type: "string" },
            reason: { type: "string" }
          }
        }
      },
      relationshipHints: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            parentEntity: { type: "string" },
            childEntity: { type: "string" },
            reason: { type: "string" }
          }
        }
      },
      warnings: { type: "array", items: { type: "string" } }
    }
  };
}

function getAssociationGenerationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["associations"],
    properties: {
      associations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "parentEntity", "childEntity", "type", "evidence", "reason"],
          properties: {
            name: { type: "string" },
            parentEntity: { type: "string" },
            childEntity: { type: "string" },
            type: { type: "string" },
            evidence: { type: "array", items: { type: "string" } },
            directionReason: { type: "string" },
            reason: { type: "string" }
          }
        }
      },
      entityCoverage: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["entity", "status", "reason"],
          properties: {
            entity: { type: "string" },
            status: { type: "string", enum: ["linked", "standalone", "attribute-only"] },
            reason: { type: "string" }
          }
        }
      },
      warnings: { type: "array", items: { type: "string" } }
    }
  };
}

function getAssociationRepairSchema() {
  const schema = getAssociationGenerationSchema();
  schema.properties.auditDecisions = {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["auditId", "decision", "reason"],
      properties: {
        auditId: { type: "string" },
        decision: { type: "string", enum: ["add", "reverse", "keep", "reject", "attribute-only", "standalone"] },
        reason: { type: "string" }
      }
    }
  };
  return schema;
}

function getEntityGenerationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["domainModel"],
    properties: {
      domainModel: {
        type: "object",
        additionalProperties: false,
        required: ["entities"],
        properties: {
          entities: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              required: ["name"],
              properties: {
                name: { type: "string" },
                attributes: { type: "array" }
              }
            }
          },
          enumerations: { type: "array" }
        }
      },
      warnings: { type: "array", items: { type: "string" } }
    }
  };
}

function getSecurityGenerationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["security"],
    properties: {
      security: {
        type: "object",
        additionalProperties: true,
        required: ["enabled", "securityLevel", "moduleRoles", "userRoles"],
        properties: {
          enabled: { type: "boolean" },
          securityLevel: { type: "string" },
          moduleRoles: { type: "array" },
          userRoles: { type: "array" },
          demoUsers: { type: "array" }
        }
      },
      warnings: { type: "array", items: { type: "string" } }
    }
  };
}

function getBehaviorGenerationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      microflows: { type: "object", additionalProperties: true },
      nanoflows: { type: "object", additionalProperties: true },
      workflows: { type: "object", additionalProperties: true },
      warnings: { type: "array", items: { type: "string" } }
    }
  };
}

function getPageGenerationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["pages"],
    properties: {
      app: { type: "object", additionalProperties: true },
      pages: {
        type: "object",
        additionalProperties: true,
        required: ["specs"],
        properties: {
          specs: { type: "array" }
        }
      },
      warnings: { type: "array", items: { type: "string" } }
    }
  };
}

async function readOllamaGeneratePayload(response) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new PlanGeneratorError(`Ollama response is not valid JSON: ${err.message}`);
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let accumulatedResponse = "";
  let lastPayload = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });

    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch (err) {
        throw new PlanGeneratorError(`Ollama streaming response contained invalid JSON: ${err.message}`);
      }
      if (payload.response !== undefined && payload.response !== null) {
        accumulatedResponse += String(payload.response);
      }
      lastPayload = payload;
    }
  }

  const trailing = `${buffered}${decoder.decode()}`.trim();
  if (trailing) {
    let payload;
    try {
      payload = JSON.parse(trailing);
    } catch (err) {
      throw new PlanGeneratorError(`Ollama streaming response contained invalid JSON: ${err.message}`);
    }
    if (payload.response !== undefined && payload.response !== null) {
      accumulatedResponse += String(payload.response);
    }
    lastPayload = payload;
  }

  if (!lastPayload) {
    throw new PlanGeneratorError("Ollama streaming response was empty.");
  }

  return {
    ...lastPayload,
    response: accumulatedResponse
  };
}

async function callOllamaGenerate({
  prompt,
  model = DEFAULT_OLLAMA_MODEL,
  ollamaUrl = DEFAULT_OLLAMA_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = OLLAMA_TIMEOUT_MS,
  format = getOllamaOutputSchema(),
  ollamaOptions = buildOllamaOptions()
}) {
  if (typeof fetchImpl !== "function") {
    throw new PlanGeneratorError("No fetch implementation available for Ollama request.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${ollamaUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        stream: true,
        format,
        prompt,
        options: { ...ollamaOptions }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = typeof response.text === "function" ? await response.text() : "";
      throw new PlanGeneratorError(`Ollama request failed (${response.status}): ${text}`);
    }

    const payload = await readOllamaGeneratePayload(response);
    const rawResponse = payload && payload.response;
    if (rawResponse === undefined || rawResponse === null) {
      throw new PlanGeneratorError("Ollama response did not contain a \"response\" field.");
    }

    let generatedPlan;
    if (typeof rawResponse === "string") {
      try {
        generatedPlan = JSON.parse(rawResponse);
      } catch (err) {
        throw new PlanGeneratorError(`Generated content is not valid JSON: ${err.message}`);
      }
    } else if (typeof rawResponse === "object") {
      generatedPlan = rawResponse;
    } else {
      throw new PlanGeneratorError("Generated content has unsupported type.");
    }

    return {
      generatedPlan,
      ollamaRaw: payload
    };
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new PlanGeneratorError(`Ollama request timed out after ${timeoutMs}ms.`);
    }
    if (err instanceof PlanGeneratorError) {
      throw err;
    }
    throw new PlanGeneratorError(err.message || String(err));
  } finally {
    clearTimeout(timeout);
  }
}

function hasStoryTag(stories, tag) {
  return stories.some((s) => s.tags.includes(tag));
}

function makeEntity(name, attributes) {
  return {
    name,
    attributes: attributes.map((a) => ({ ...a }))
  };
}

function buildStoryDrivenBaselineDraft({
  stories,
  moduleName,
  domainInfo = "",
  visualNarratorSummary = null,
  processVisualizerSummary = null
}) {
  const entityCandidates = buildBaselineEntityCandidates({
    stories,
    moduleName,
    domainInfo,
    visualNarratorSummary,
    processVisualizerSummary
  });
  const entityNames = entityCandidates.map((entry) => entry.name);
  const associations = dedupeByName(
    deriveAssociationCandidates({
      entityNames,
      stories,
      visualNarratorSummary,
      processVisualizerSummary
    }),
    (assoc) => assoc.name
  );
  const primaryEntity = choosePrimaryEntityName(entityNames);

  return {
    domainModel: {
      entities: entityCandidates,
      associations,
      enumerations: []
    },
    pages: {
      specs: buildBaselinePages({
        moduleName,
        entities: entityCandidates,
        associations,
        primaryEntity,
        featureFlags: deriveCapabilityFlags()
      })
    }
  };
}

function dedupeByName(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = String(keyFn(item) || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function ensureUniqueSpecNames(specs, artifactLabel, warnings = []) {
  const seen = new Set();
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i];
    if (!spec || typeof spec !== "object") continue;
    const originalName = trimToString(spec.name);
    if (!originalName) continue;

    const key = originalName.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }

    const base = toSafeName(originalName, `${artifactLabel}${i + 1}`);
    const refSuffix = toPascalCase(spec.ref || `${artifactLabel}${i + 1}`, `${artifactLabel}${i + 1}`);
    let candidate = `${base}_${refSuffix}`;
    let suffix = 2;
    while (seen.has(candidate.toLowerCase())) {
      candidate = `${base}_${refSuffix}_${suffix}`;
      suffix += 1;
    }
    spec.name = candidate;
    seen.add(candidate.toLowerCase());
    warnings.push(`Renamed duplicate ${artifactLabel} name "${originalName}" to "${candidate}".`);
  }
  return specs;
}

function firstAttributeByType(attributes = [], predicate) {
  return (attributes || []).find((attribute) => predicate(String(attribute && attribute.type || "").trim(), attribute)) || null;
}

function buildEntityColumns(attributes = [], limit = 5) {
  return (attributes || []).slice(0, limit).map((attr) => ({
    attributeRef: attr.name,
    caption: splitCamelCase(attr.name).trim()
  }));
}

function buildEntityListViewTemplate(entity, limit = 5) {
  const attributes = Array.isArray(entity && entity.attributes) ? entity.attributes.slice(0, limit) : [];
  const template = attributes.map((attr, index) => ({
    type: "attributeInput",
    attributeRef: attr.name,
    autoLabel: index === 0
  }));

  if (template.length > 0) return template;

  return [{ type: "dynamicText", text: splitCamelCase(entity && entity.name ? entity.name : "Item"), renderMode: "Paragraph" }];
}

function buildHomePageButtons(pageRefs = [], pagesByRef = {}) {
  return pageRefs
    .map((pageRef) => {
      const page = pagesByRef[pageRef];
      if (!page) return null;
      return {
        type: "buttonToPage",
        caption: page.title || splitCamelCase(page.name || pageRef).trim() || "Open",
        targetPageRef: pageRef
      };
    })
    .filter(Boolean);
}

function buildBaselinePages({ moduleName, entities, associations = [], primaryEntity = "", featureFlags = {} }) {
  const pages = [];
  const pagesByRef = {};
  const homeButtonRefs = [];
  const homeTitle = primaryEntity ? `${primaryEntity} Workspace` : `${moduleName} Home`;

  const homePage = {
    ref: "home",
    name: "Home",
    title: "Home",
    content: [
      { type: "dynamicText", text: homeTitle, renderMode: "H2" },
      { type: "dynamicText", text: "Generated from user stories", renderMode: "Paragraph" }
    ]
  };
  pages.push(homePage);
  pagesByRef[homePage.ref] = homePage;

  const primaryEntitySpec = entities.find((entity) => entity && entity.name === primaryEntity) || null;
  if (primaryEntitySpec) {
    const categoryAttr =
      firstAttributeByType(primaryEntitySpec.attributes, (type) => type === "String" || type === "Boolean") ||
      (Array.isArray(primaryEntitySpec.attributes) ? primaryEntitySpec.attributes[0] : null);
    const valueAttr =
      firstAttributeByType(primaryEntitySpec.attributes, (type) => ["Integer", "Long", "Decimal"].includes(type)) ||
      firstAttributeByType(primaryEntitySpec.attributes, (type) => type === "Boolean");

    const dashboardContent = [
      { type: "dynamicText", text: `${primaryEntity} Dashboard`, renderMode: "H2" },
      {
        type: "dynamicText",
        text: `Overview and data management for ${splitCamelCase(primaryEntity).toLowerCase()}.`,
        renderMode: "Paragraph"
      },
      {
        type: "createObjectButton",
        caption: `Add ${primaryEntity}`,
        entityRef: `${moduleName}.${primaryEntity}`,
        targetPageRef: `${primaryEntity.toLowerCase()}_newedit`
      },
      {
        type: "listView",
        entityRef: `${moduleName}.${primaryEntity}`,
        rowClickTargetPageRef: `${primaryEntity.toLowerCase()}_newedit`,
        autoRowClickToDetail: true,
        itemContent: buildEntityListViewTemplate(primaryEntitySpec)
      }
    ];

    if (featureFlags.reporting && categoryAttr && valueAttr) {
      dashboardContent.push({
        type: "widget",
        name: `${toSafeName(primaryEntity)}_dashboard_chart`,
        widgetId: "com.mendix.charts.web.BarChart",
        widgetName: "Bar Chart",
        propertyTypes: [
          { key: "chartTitle", valueType: "TextTemplate" },
          { key: "dataSource", valueType: "DataSource" },
          { key: "categoryAttribute", valueType: "Attribute", dataSourceProperty: "dataSource" },
          { key: "valueAttribute", valueType: "Attribute", dataSourceProperty: "dataSource" }
        ],
        props: {
          chartTitle: `${splitCamelCase(primaryEntity)} overview`,
          dataSource: { entityRef: `${moduleName}.${primaryEntity}` },
          categoryAttribute: categoryAttr.name,
          valueAttribute: valueAttr.name
        }
      });
    }

    pages.push({
      ref: `${primaryEntity.toLowerCase()}_dashboard`,
      name: `${primaryEntity}_Dashboard`,
      title: `${primaryEntity} Dashboard`,
      entityRef: `${moduleName}.${primaryEntity}`,
      content: dashboardContent
    });
    pagesByRef[`${primaryEntity.toLowerCase()}_dashboard`] = pages[pages.length - 1];
    homeButtonRefs.push(`${primaryEntity.toLowerCase()}_dashboard`);
  }

  for (const entity of entities) {
    const entityName = entity.name;
    const refBase = entityName.toLowerCase();
    const entityRef = `${moduleName}.${entityName}`;

    const overviewRef = `${refBase}_overview`;
    const newEditRef = `${refBase}_newedit`;

    const overviewContent = [
      { type: "dynamicText", text: `${entityName} Overview`, renderMode: "H2" },
      {
        type: "dynamicText",
        text: `Manage ${splitCamelCase(entityName).toLowerCase()} records and open the create dialog when new data is needed.`,
        renderMode: "Paragraph"
      },
      {
        type: "createObjectButton",
        caption: `Add ${entityName}`,
        entityRef,
        targetPageRef: newEditRef
      }
    ];

    overviewContent.push({
      type: "listView",
      entityRef,
      rowClickTargetPageRef: newEditRef,
      autoRowClickToDetail: true,
      itemContent: buildEntityListViewTemplate(entity)
    });

    const overviewPage = {
      ref: overviewRef,
      name: `${entityName}_Overview`,
      title: `${entityName} Overview`,
      entityRef,
      content: overviewContent
    };
    pages.push(overviewPage);
    pagesByRef[overviewRef] = overviewPage;
    homeButtonRefs.push(overviewRef);

    const detailInputs = (entity.attributes || []).slice(0, 8).map((attr) => ({
      type: "attributeInput",
      attributeRef: attr.name
    }));
    const associationInputs = associations
      .filter((assoc) => assoc.parentEntity === entityName || assoc.childEntity === entityName)
      .map((assoc) => {
        const targetEntity = assoc.parentEntity === entityName ? assoc.childEntity : assoc.parentEntity;
        const isReferenceSet = String(assoc.type || "").toLowerCase() === "referenceset";
        return {
          type: isReferenceSet ? "associationSetInput" : "associationInput",
          associationRef: assoc.name,
          targetEntityRef: `${moduleName}.${targetEntity}`,
          label: splitCamelCase(targetEntity).trim()
        };
      });

    const newEditPage = {
      ref: newEditRef,
      name: `${entityName}_NewEdit`,
      title: `${entityName} NewEdit`,
      entityRef,
      layoutQualifiedName: DEFAULT_POPUP_LAYOUT_QNAME,
      pageParameters: [{ name: entityName, entityRef, required: true }],
      content: [
        {
          type: "dataView",
          pageParameterName: entityName,
          labelWidth: 3,
          content: detailInputs.concat(associationInputs).concat([
          { type: "saveChangesButton", caption: "Save", closePage: true },
          { type: "cancelChangesButton", caption: "Cancel", closePage: true }
        ])
      }
      ]
    };
    pages.push(newEditPage);
    pagesByRef[newEditRef] = newEditPage;
  }

  homePage.content.push(...buildHomePageButtons(homeButtonRefs, pagesByRef));

  return dedupeByName(pages, (p) => p.ref || p.name);
}

function inferTypeFromAttributeName(attrName) {
  const lower = String(attrName || "").toLowerCase();
  if (!lower) return "String";
  if (/^(is|has|can)[a-z0-9_]*$/.test(lower)) return "Boolean";
  if (/date|time|deadline|due|timestamp|at$/.test(lower)) return "DateTime";
  if (/count|number|qty|total|score/.test(lower)) return "Integer";
  if (/amount|price|cost/.test(lower)) return "Decimal";
  return "String";
}

function normalizeAttributeType(rawType, attrName = "") {
  if (rawType && typeof rawType === "object") {
    const kind = trimToString(rawType.kind);
    const enumName = trimToString(rawType.enumName || rawType.enum);
    if (kind === "Enum" && enumName) {
      return {
        kind: "Enum",
        enumName: toSafeName(enumName, "GeneratedEnum")
      };
    }
  }

  const simple = trimToString(rawType);
  if (SUPPORTED_ATTRIBUTE_TYPES.has(simple)) return simple;
  if (ATTRIBUTE_TYPE_BY_KEY.has(simple.toLowerCase())) return ATTRIBUTE_TYPE_BY_KEY.get(simple.toLowerCase());
  return inferTypeFromAttributeName(attrName);
}

function normalizeAttributeName(rawName, fallback = "Attribute") {
  const normalized = toPascalCase(rawName, fallback);
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(normalized)) return normalized;
  return toSafeName(normalized, fallback).replace(/^_+/, "") || fallback;
}

function normalizeEntity(entity, fallbackIndex, options = {}) {
  if (!entity || typeof entity !== "object") return null;
  const expandNameFallback = options.expandNameFallback !== false;

  const name = toPascalCase(entity.name, `Entity${fallbackIndex + 1}`);
  const attributesSource = Array.isArray(entity.attributes) ? entity.attributes : [];
  const attrs = attributesSource
    .map((attr, index) => {
      if (!attr || typeof attr !== "object") return null;
      const attrName = normalizeAttributeName(attr.name, `Attribute${index + 1}`);
      const normalizedType = normalizeAttributeType(attr.type, attrName);
      const normalized = {
        name: attrName,
        type: normalizedType,
        required: Boolean(attr.required)
      };
      if (attr.defaultValue !== undefined) normalized.defaultValue = attr.defaultValue;
      return normalized;
    })
    .filter(Boolean);

  const attributes = dedupeByName(attrs, (a) => a.name);

  if (attributes.length === 0) {
    attributes.push({ name: "Name", type: "String", required: true });
  }
  if (expandNameFallback && attributes.length === 1 && /^name$/i.test(String(attributes[0] && attributes[0].name || ""))) {
    for (const attr of defaultAttributesForEntity(name)) {
      if (!attributes.some((existing) => String(existing && existing.name).toLowerCase() === String(attr.name).toLowerCase())) {
        attributes.push({ ...attr });
      }
    }
  }

  return {
    name,
    attributes
  };
}

function normalizeEnumeration(spec, fallbackIndex) {
  if (!spec || typeof spec !== "object") return null;
  const name = toSafeName(spec.name, `Enum${fallbackIndex + 1}`);
  const valuesRaw = Array.isArray(spec.values) ? spec.values : [];
  const values = valuesRaw
    .map((entry, index) => {
      if (typeof entry === "string") {
        const valueName = toSafeName(entry, `Value${index + 1}`);
        return {
          name: valueName,
          caption: valueName
        };
      }
      if (entry && typeof entry === "object") {
        const valueName = toSafeName(entry.name, `Value${index + 1}`);
        return {
          name: valueName,
          caption: trimToString(entry.caption) || valueName
        };
      }
      return null;
    })
    .filter(Boolean);

  return {
    name,
    values: dedupeByName(values, (v) => v.name)
  };
}

function sanitizePageContent(content, warnings, pageName) {
  const source = Array.isArray(content) ? content : [];
  return source
    .map((step, index) => {
      if (!step || typeof step !== "object") return null;
      const type = trimToString(step.type);
      if (!SUPPORTED_PAGE_STEP_TYPES.has(type)) {
        warnings.push(`Dropped unsupported page step type \"${type || "<empty>"}\" in page ${pageName} at index ${index}.`);
        return null;
      }

      const out = { ...step, type };
      if (type === "dynamicText") {
        out.text = trimToString(step.text) || "Generated content";
        out.renderMode = trimToString(step.renderMode) || "Paragraph";
      }

      if (Array.isArray(step.content)) out.content = sanitizePageContent(step.content, warnings, pageName);
      if (Array.isArray(step.itemContent)) out.itemContent = sanitizePageContent(step.itemContent, warnings, pageName);
      if (Array.isArray(step.templateContent)) {
        out.templateContent = sanitizePageContent(step.templateContent, warnings, pageName);
      }

      return out;
    })
    .filter(Boolean);
}

function qualifyEntityRef(ref, moduleName) {
  const token = trimToString(ref);
  if (!token) return "";
  if (token.includes(".")) return token;
  return `${moduleName}.${token}`;
}

function normalizePages(pagesSection, moduleName, warnings) {
  const sourceSpecs =
    pagesSection && Array.isArray(pagesSection.specs)
      ? pagesSection.specs
      : pagesSection && Array.isArray(pagesSection.pageSpecs)
        ? pagesSection.pageSpecs
        : [];

  const specs = sourceSpecs
    .map((page, index) => {
      if (!page || typeof page !== "object") return null;
      const pageName = toSafeName(page.name, `Page${index + 1}`);
      const ref = toSafeName(page.ref || page.name, `page_${index + 1}`).toLowerCase();

      const out = {
        ref,
        name: pageName,
        title: trimToString(page.title) || splitCamelCase(pageName),
        content: sanitizePageContent(page.content, warnings, pageName)
      };

      const entityRef = qualifyEntityRef(page.entityRef || page.entity, moduleName);
      if (entityRef) out.entityRef = entityRef;

      const parameterEntityRef = qualifyEntityRef(page.parameterEntityRef, moduleName);
      if (parameterEntityRef) out.parameterEntityRef = parameterEntityRef;

      if (Array.isArray(page.pageParameters)) {
        out.pageParameters = page.pageParameters
          .map((param, paramIndex) => {
            if (!param || typeof param !== "object") return null;
            const paramEntityRef = qualifyEntityRef(param.entityRef, moduleName);
            if (!paramEntityRef) return null;
            return {
              name: toSafeName(param.name, `Param${paramIndex + 1}`),
              entityRef: paramEntityRef,
              required: param.required !== false
            };
          })
          .filter(Boolean);
      }

      if (!out.content || out.content.length === 0) {
        out.content = [{ type: "dynamicText", text: out.title, renderMode: "H2" }];
      }

      return out;
    })
    .filter(Boolean);

  if (specs.length === 0) {
    warnings.push("Generated pages were empty; injected fallback Home page.");
    specs.push({
      ref: "home",
      name: "Home",
      title: "Home",
      content: [{ type: "dynamicText", text: "Home", renderMode: "H2" }]
    });
  }

  if (!specs.some((p) => p.ref === "home")) {
    specs.unshift({
      ref: "home",
      name: "Home",
      title: "Home",
      content: [{ type: "dynamicText", text: "Home", renderMode: "H2" }]
    });
    warnings.push("No home page ref found; inserted Home page with ref \"home\".");
  }

  const dedupedSpecs = dedupeByName(specs, (p) => p.ref || p.name);
  return {
    specs: ensureUniqueSpecNames(dedupedSpecs, "page", warnings)
  };
}

function cloneSpecSection(section) {
  if (!section || typeof section !== "object") return null;
  const specs = Array.isArray(section.specs)
    ? section.specs
    : Array.isArray(section.items)
      ? section.items
      : [];
  if (specs.length === 0) return null;
  return {
    ...section,
    specs: specs
      .filter((spec) => spec && typeof spec === "object")
      .map((spec) => ({ ...spec }))
  };
}

function generatedValueKind(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function createGeneratedSanitizationDiagnostics(stageName = "generated") {
  return {
    stageName,
    rawCount: 0,
    finalCount: 0,
    invalidItemsDropped: [],
    nestedInvalidItemsDropped: [],
    repairedItems: []
  };
}

function sanitizeObjectArray(value, pathLabel, diagnostics, { requiredNameOrRef = false } = {}) {
  const source = Array.isArray(value) ? value : [];
  diagnostics.rawCount += source.length;
  const out = [];
  source.forEach((entry, index) => {
    const pointer = `${pathLabel}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.invalidItemsDropped.push({ path: pointer, kind: generatedValueKind(entry) });
      return;
    }
    if (requiredNameOrRef && !trimToString(entry.ref || entry.name)) {
      diagnostics.invalidItemsDropped.push({ path: pointer, kind: "object", reason: "missing ref/name" });
      return;
    }
    out.push(entry);
  });
  return out;
}

function sanitizeNestedObjectArray(container, key, pathLabel, diagnostics) {
  if (!container || typeof container !== "object" || !Array.isArray(container[key])) return;
  const source = container[key];
  const kept = [];
  source.forEach((entry, index) => {
    const pointer = `${pathLabel}.${key}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.nestedInvalidItemsDropped.push({ path: pointer, kind: generatedValueKind(entry) });
      return;
    }
    kept.push(entry);
  });
  container[key] = kept;
}

function sanitizePageStepTree(steps, pathLabel, diagnostics) {
  if (!Array.isArray(steps)) return [];
  const kept = [];
  steps.forEach((step, index) => {
    const pointer = `${pathLabel}[${index}]`;
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      diagnostics.nestedInvalidItemsDropped.push({ path: pointer, kind: generatedValueKind(step) });
      return;
    }
    step.content = sanitizePageStepTree(step.content, `${pointer}.content`, diagnostics);
    step.itemContent = sanitizePageStepTree(step.itemContent, `${pointer}.itemContent`, diagnostics);
    step.templateContent = sanitizePageStepTree(step.templateContent, `${pointer}.templateContent`, diagnostics);
    sanitizeNestedObjectArray(step, "columns", pointer, diagnostics);
    if (step.search && typeof step.search === "object" && !Array.isArray(step.search)) {
      sanitizeNestedObjectArray(step.search, "fields", `${pointer}.search`, diagnostics);
    }
    kept.push(step);
  });
  return kept;
}

function sanitizeGeneratedPagePassResult(pageResult, warnings = []) {
  const diagnostics = createGeneratedSanitizationDiagnostics("pages");
  const result = pageResult && typeof pageResult === "object" ? pageResult : {};
  const pages = result.pages && typeof result.pages === "object" && !Array.isArray(result.pages)
    ? result.pages
    : {};
  const specs = sanitizeObjectArray(pages.specs, "pages.specs", diagnostics, { requiredNameOrRef: true });
  specs.forEach((page, index) => {
    const pointer = `pages.specs[${index}]`;
    page.content = sanitizePageStepTree(page.content, `${pointer}.content`, diagnostics);
    sanitizeNestedObjectArray(page, "pageParameters", pointer, diagnostics);
  });
  diagnostics.finalCount = specs.length;
  if (diagnostics.invalidItemsDropped.length > 0 || diagnostics.nestedInvalidItemsDropped.length > 0) {
    warnings.push(`Sanitized page pass output: dropped ${diagnostics.invalidItemsDropped.length} invalid page spec(s) and ${diagnostics.nestedInvalidItemsDropped.length} invalid nested item(s).`);
  }
  return {
    result: {
      ...result,
      pages: {
        ...pages,
        specs
      }
    },
    diagnostics
  };
}

function sanitizeGeneratedBehaviorResult(behaviorResult, warnings = []) {
  const diagnostics = createGeneratedSanitizationDiagnostics("behavior");
  const result = behaviorResult && typeof behaviorResult === "object" ? behaviorResult : {};
  for (const sectionName of ["microflows", "nanoflows", "workflows"]) {
    const section = result[sectionName] && typeof result[sectionName] === "object" && !Array.isArray(result[sectionName])
      ? result[sectionName]
      : {};
    const specs = sanitizeObjectArray(section.specs, `${sectionName}.specs`, diagnostics, { requiredNameOrRef: true });
    specs.forEach((spec, index) => {
      const pointer = `${sectionName}.specs[${index}]`;
      sanitizeNestedObjectArray(spec, "actions", pointer, diagnostics);
      sanitizeNestedObjectArray(spec, "steps", pointer, diagnostics);
    });
    result[sectionName] = { ...section, specs };
  }
  diagnostics.finalCount =
    (result.microflows.specs || []).length +
    (result.nanoflows.specs || []).length +
    (result.workflows.specs || []).length;
  if (diagnostics.invalidItemsDropped.length > 0 || diagnostics.nestedInvalidItemsDropped.length > 0) {
    warnings.push(`Sanitized behavior pass output: dropped ${diagnostics.invalidItemsDropped.length} invalid spec(s) and ${diagnostics.nestedInvalidItemsDropped.length} invalid nested item(s).`);
  }
  return { result, diagnostics };
}

function sanitizeFinalRepairInput(plan, warnings = []) {
  const diagnostics = createGeneratedSanitizationDiagnostics("finalRepairInput");
  if (!plan || typeof plan !== "object") return diagnostics;
  if (plan.domainModel && typeof plan.domainModel === "object") {
    for (const key of ["entities", "associations", "enumerations"]) {
      plan.domainModel[key] = sanitizeObjectArray(plan.domainModel[key], `domainModel.${key}`, diagnostics, { requiredNameOrRef: key !== "associations" });
    }
    for (const [entityIndex, entity] of (plan.domainModel.entities || []).entries()) {
      entity.attributes = sanitizeObjectArray(entity.attributes, `domainModel.entities[${entityIndex}].attributes`, diagnostics, { requiredNameOrRef: true });
    }
  }
  if (plan.pages && typeof plan.pages === "object") {
    plan.pages.specs = sanitizeObjectArray(plan.pages.specs, "pages.specs", diagnostics, { requiredNameOrRef: true });
    (plan.pages.specs || []).forEach((page, index) => {
      const pointer = `pages.specs[${index}]`;
      page.content = sanitizePageStepTree(page.content, `${pointer}.content`, diagnostics);
      sanitizeNestedObjectArray(page, "pageParameters", pointer, diagnostics);
    });
  }
  for (const sectionName of ["microflows", "nanoflows"]) {
    if (!plan[sectionName] || typeof plan[sectionName] !== "object") continue;
    plan[sectionName].specs = sanitizeObjectArray(plan[sectionName].specs, `${sectionName}.specs`, diagnostics, { requiredNameOrRef: true });
    (plan[sectionName].specs || []).forEach((spec, index) => {
      sanitizeNestedObjectArray(spec, "actions", `${sectionName}.specs[${index}]`, diagnostics);
    });
  }
  if (plan.workflows && typeof plan.workflows === "object") {
    plan.workflows.specs = sanitizeObjectArray(plan.workflows.specs, "workflows.specs", diagnostics, { requiredNameOrRef: true });
    (plan.workflows.specs || []).forEach((spec, index) => {
      sanitizeNestedObjectArray(spec, "steps", `workflows.specs[${index}]`, diagnostics);
    });
  }
  diagnostics.finalCount =
    (plan.domainModel && Array.isArray(plan.domainModel.entities) ? plan.domainModel.entities.length : 0) +
    (plan.pages && Array.isArray(plan.pages.specs) ? plan.pages.specs.length : 0);
  if (diagnostics.invalidItemsDropped.length > 0 || diagnostics.nestedInvalidItemsDropped.length > 0) {
    warnings.push(`Sanitized final repair input: dropped ${diagnostics.invalidItemsDropped.length} invalid top-level item(s) and ${diagnostics.nestedInvalidItemsDropped.length} invalid nested item(s).`);
  }
  return diagnostics;
}

function runFinalRepairStep(stepName, fn, diagnostics, warnings = []) {
  const startedAt = Date.now();
  try {
    const result = fn();
    diagnostics.push({ stepName, status: "completed", durationMs: Date.now() - startedAt });
    return result;
  } catch (err) {
    const badPath = warnings.find((warning) => /invalid .*spec|Sanitized/.test(String(warning || ""))) || "";
    const message = `Final repair failed in ${stepName}: ${err && err.message ? err.message : String(err)}${badPath ? ` (${badPath})` : ""}`;
    throw new PlanGeneratorError(message);
  }
}

function writeJsonArtifact(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  return filePath;
}

function writeGenerationDebugArtifacts({ absoluteOutPath, finalPlan, pagePassResult = null, progress = () => {} }) {
  const outputDir = path.dirname(absoluteOutPath);
  const artifacts = {
    preFinalRepairPlanPath: path.join(outputDir, "pre-final-repair-plan.json")
  };
  progress(`Stage 9/10: Writing pre-final repair debug plan to ${artifacts.preFinalRepairPlanPath}...`);
  writeJsonArtifact(artifacts.preFinalRepairPlanPath, finalPlan);
  if (pagePassResult) {
    artifacts.pagePassSanitizedPath = path.join(outputDir, "page-pass-sanitized.json");
    progress(`Stage 9/10: Writing sanitized page pass debug artifact to ${artifacts.pagePassSanitizedPath}...`);
    const sanitized = sanitizeGeneratedPagePassResult(pagePassResult, []).result;
    writeJsonArtifact(artifacts.pagePassSanitizedPath, sanitized);
  }
  return artifacts;
}

function normalizeGenerationDebugStopAfter(value) {
  const normalized = trimToString(value).toLowerCase();
  if (["page-pass", "pre-final-repair"].includes(normalized)) return normalized;
  return "";
}

function hasNonEmptyActionField(action, keys) {
  for (const key of keys) {
    if (action[key] !== undefined && String(action[key]).trim() !== "") return true;
  }
  return false;
}

function sanitizeGeneratedFlowAction(action, { sectionName, specName, actionIndex, warnings }) {
  if (!action || typeof action !== "object") return null;
  const type = normalizeActionType(action.type);
  const label = `${sectionName} "${specName}" action ${actionIndex}`;
  if (!type) {
    warnings.push(`Dropped ${label} because action.type is missing.`);
    return null;
  }
  if (!SUPPORTED_MICROFLOW_ACTION_TYPES.includes(type)) {
    warnings.push(`Dropped ${label} because action.type "${type}" is unsupported.`);
    return null;
  }

  if ((type === "callMicroflow" || type === "callNanoflow") &&
    !hasNonEmptyActionField(action, ["microflowRef", "nanoflowRef", "targetRef", "target", "microflowQualifiedName", "nanoflowQualifiedName"])) {
    warnings.push(`Dropped ${label} because ${type} is missing a target flow reference.`);
    return null;
  }

  if ((type === "retrieveList" || type === "retrieveObject" || type === "createObject") &&
    !hasNonEmptyActionField(action, ["entityRef", "entity", "fromEntityRef", "fromEntity"])) {
    warnings.push(`Dropped ${label} because ${type} is missing entityRef.`);
    return null;
  }

  if (type === "aggregateList") {
    if (!hasNonEmptyActionField(action, ["inputListVariableName", "listVariableName", "sourceListVariableName", "input"])) {
      warnings.push(`Dropped ${label} because aggregateList is missing listVariableName.`);
      return null;
    }
    const fn = String(action.function || action.aggregateFunction || "Count").trim().toLowerCase();
    const requiresAttr = ["sum", "minimum", "min", "maximum", "max", "average", "avg"].includes(fn);
    if (requiresAttr && !hasNonEmptyActionField(action, ["attributeRef", "attribute", "memberRef", "member"])) {
      warnings.push(`Dropped ${label} because aggregateList ${fn} is missing attributeRef.`);
      return null;
    }
  }

  if (type === "createVariable" &&
    !hasNonEmptyActionField(action, ["name", "variableName", "targetVariableName"])) {
    warnings.push(`Dropped ${label} because createVariable is missing variableName.`);
    return null;
  }

  if (type === "changeObject") {
    const changes = Array.isArray(action.changes)
      ? action.changes
      : Array.isArray(action.members)
        ? action.members
        : [];
    if (!hasNonEmptyActionField(action, ["targetVariableName", "objectVariableName", "variableName", "changeVariableName"]) || changes.length === 0) {
      warnings.push(`Dropped ${label} because changeObject is missing targetVariableName or changes.`);
      return null;
    }
  }

  return { ...action, type };
}

function sanitizeGeneratedFlowSection(section, sectionName, warnings = []) {
  if (!section || !Array.isArray(section.specs)) return section;
  for (const spec of section.specs) {
    if (!spec || typeof spec !== "object" || !Array.isArray(spec.actions)) continue;
    const specName = trimToString(spec.name || spec.ref) || "<unnamed>";
    spec.actions = spec.actions
      .map((action, index) => sanitizeGeneratedFlowAction(action, {
        sectionName,
        specName,
        actionIndex: index,
        warnings
      }))
      .filter(Boolean);
  }
  return section;
}

function buildFlowSemanticContext(plan) {
  const moduleName = trimToString(plan && plan.app && plan.app.moduleName) || "MyFirstModule";
  const entities = Array.isArray(plan && plan.domainModel && plan.domainModel.entities)
    ? plan.domainModel.entities
    : [];
  const entityByKey = new Map();
  for (const entity of entities) {
    const name = trimToString(entity && entity.name);
    if (!name) continue;
    entityByKey.set(name.toLowerCase(), entity);
    entityByKey.set(`${moduleName}.${name}`.toLowerCase(), entity);
  }
  const microflowRefs = new Set((Array.isArray(plan && plan.microflows && plan.microflows.specs) ? plan.microflows.specs : [])
    .flatMap((spec) => [spec && spec.ref, spec && spec.name, spec && spec.name ? `${moduleName}.${spec.name}` : ""])
    .map(trimToString)
    .filter(Boolean));
  const nanoflowRefs = new Set((Array.isArray(plan && plan.nanoflows && plan.nanoflows.specs) ? plan.nanoflows.specs : [])
    .flatMap((spec) => [spec && spec.ref, spec && spec.name, spec && spec.name ? `${moduleName}.${spec.name}` : ""])
    .map(trimToString)
    .filter(Boolean));
  return { moduleName, entityByKey, microflowRefs, nanoflowRefs };
}

function resolveFlowEntityRef(context, rawRef) {
  const ref = trimToString(rawRef);
  if (!ref) return null;
  return context.entityByKey.get(ref.toLowerCase()) ||
    context.entityByKey.get(`${context.moduleName}.${ref}`.toLowerCase()) ||
    null;
}

function resolveFlowAttribute(entity, rawRef) {
  const ref = trimToString(rawRef);
  if (!entity || !ref || !Array.isArray(entity.attributes)) return null;
  const shortRef = ref.split(".").pop();
  return entity.attributes.find((attr) => trimToString(attr && attr.name).toLowerCase() === shortRef.toLowerCase()) || null;
}

function inferFlowVariableEntity(context, typeSpec) {
  if (typeof typeSpec === "string") {
    return resolveFlowEntityRef(context, typeSpec);
  }
  if (!typeSpec || typeof typeSpec !== "object") return null;
  const entityRef = trimToString(typeSpec.entityRef || typeSpec.entity || typeSpec.qualifiedName);
  return entityRef ? resolveFlowEntityRef(context, entityRef) : null;
}

function isSupportedFlowDataTypeKind(rawKind) {
  return ["void", "string", "boolean", "integer", "long", "decimal", "datetime", "object", "list", "enum", "enumeration"]
    .includes(trimToString(rawKind).toLowerCase());
}

function normalizeFlowParameterTypeSpec(context, param) {
  const rawType = param && (param.type || param.parameterType || param.dataType);
  const entity = inferFlowVariableEntity(context, rawType || {});
  if (!entity) return { entity: null, typeSpec: rawType };
  return {
    entity,
    typeSpec: {
      kind: "Object",
      entityRef: `${context.moduleName}.${entity.name}`
    }
  };
}

function addFlowDiagnostic(metadata, key, entry) {
  if (!Array.isArray(metadata[key])) metadata[key] = [];
  metadata[key].push(entry);
}

function normalizeFlowVariableRef(rawRef) {
  return trimToString(rawRef).replace(/^\$/, "");
}

function rewriteFlowExpressionVariables(expression, variables) {
  let out = trimToString(expression);
  if (!out) return out;
  for (const [variableName, variable] of variables.entries()) {
    const entityName = trimToString(variable && variable.entity && variable.entity.name);
    if (!entityName || entityName === variableName) continue;
    out = out.replace(new RegExp(`\\$${entityName}\\b`, "g"), `$${variableName}`);
  }
  return out;
}

function repairFlowExpressionAttributeRefs(expression, variables) {
  let out = trimToString(expression);
  if (!out) return out;
  out = out.replace(/\$([A-Za-z][A-Za-z0-9_]*)\/([A-Za-z][A-Za-z0-9_]*)/g, (match, rawVariableName, rawAttributeName) => {
    const variable = variables.get(rawVariableName);
    const candidateVariableName = variable
      ? rawVariableName
      : findSingleObjectVariableForEntity(variables, rawVariableName);
    const resolvedVariable = variables.get(candidateVariableName);
    if (!resolvedVariable || resolvedVariable.kind !== "object") return match;
    const attr = resolveFlowAttribute(resolvedVariable.entity, rawAttributeName);
    if (!attr) return match;
    return `$${candidateVariableName}/${attr.name}`;
  });
  return rewriteFlowExpressionVariables(out, variables);
}

function isQuotedMendixStringLiteral(value) {
  return /^'(?:[^']|'')*'$/.test(trimToString(value));
}

function quoteMendixStringLiteral(value) {
  return `'${String(value || "").replace(/^["']|["']$/g, "").replace(/'/g, "''")}'`;
}

function isSimpleFlowVariableExpression(value) {
  return /^\$[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)?$/.test(trimToString(value));
}

function normalizeFlowValueExpressionForAttribute(rawExpression, attr, variables) {
  const raw = rawExpression === undefined || rawExpression === null ? "" : String(rawExpression);
  const repaired = repairFlowExpressionAttributeRefs(raw, variables);
  const value = trimToString(repaired);
  const type = attr && typeof attr.type === "object" ? "Enumeration" : trimToString(attr && attr.type) || "String";
  if (!value) return { ok: false, reason: "empty expression" };
  const variableRefValidation = validateFlowExpressionVariableRefs(value, variables);
  if (!variableRefValidation.ok) return variableRefValidation;
  if (isSimpleFlowVariableExpression(value) || /^\[%[A-Za-z0-9_]+%\]$/.test(value)) return { ok: true, expression: value };
  if (["String", "UUID", "Enumeration"].includes(type)) {
    return { ok: true, expression: isQuotedMendixStringLiteral(value) ? value : quoteMendixStringLiteral(value) };
  }
  if (type === "Boolean") {
    const lower = value.toLowerCase();
    if (["true", "false"].includes(lower)) return { ok: true, expression: lower };
    return { ok: false, reason: `invalid Boolean expression "${value}"` };
  }
  if (["Integer", "Long"].includes(type)) {
    if (/^-?\d+$/.test(value)) return { ok: true, expression: value };
    return { ok: false, reason: `invalid ${type} expression "${value}"` };
  }
  if (type === "Decimal") {
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return { ok: true, expression: value };
    return { ok: false, reason: `invalid Decimal expression "${value}"` };
  }
  if (type === "DateTime") {
    if (/^(now|currentdate|currentdatetime|today)$/i.test(value)) return { ok: true, expression: "[%CurrentDateTime%]" };
    return { ok: false, reason: `invalid DateTime expression "${value}"` };
  }
  return { ok: true, expression: value };
}

function normalizeFlowVariableTypeSpec(rawType) {
  if (rawType && typeof rawType === "object") {
    const kind = trimToString(rawType.kind || rawType.type);
    if (/^(Enum|Enumeration)$/i.test(kind)) return "Enumeration";
    if (ATTRIBUTE_TYPE_BY_KEY.has(kind.toLowerCase())) return ATTRIBUTE_TYPE_BY_KEY.get(kind.toLowerCase());
    if (SUPPORTED_ATTRIBUTE_TYPES.has(kind)) return kind;
    return "Object";
  }
  const simple = trimToString(rawType);
  if (!simple) return "String";
  if (/^(Enum|Enumeration)$/i.test(simple)) return "Enumeration";
  if (SUPPORTED_ATTRIBUTE_TYPES.has(simple)) return simple;
  if (ATTRIBUTE_TYPE_BY_KEY.has(simple.toLowerCase())) return ATTRIBUTE_TYPE_BY_KEY.get(simple.toLowerCase());
  return "String";
}

function normalizeFlowValueExpressionForType(rawExpression, rawType, variables) {
  return normalizeFlowValueExpressionForAttribute(rawExpression, {
    name: "Value",
    type: normalizeFlowVariableTypeSpec(rawType)
  }, variables);
}

function normalizeFlowDecisionExpression(rawExpression, variables) {
  const expression = repairFlowExpressionAttributeRefs(rawExpression, variables);
  if (!expression) return { ok: false, reason: "empty decision expression" };
  const variableRefs = [...expression.matchAll(/\$([A-Za-z][A-Za-z0-9_]*)(?:\/([A-Za-z][A-Za-z0-9_]*))?/g)];
  for (const match of variableRefs) {
    const variable = variables.get(match[1]);
    if (!variable) return { ok: false, reason: `unresolved variable "${match[1]}"` };
    if (match[2] && (!variable.entity || !resolveFlowAttribute(variable.entity, match[2]))) {
      return { ok: false, reason: `unresolved attribute "${match[2]}"` };
    }
  }
  if (/^\s*(true|false)\s*$/i.test(expression)) return { ok: true, expression: expression.toLowerCase() };
  if (!/[=!<>]=?| and | or |\(|\)/i.test(expression)) return { ok: false, reason: "decision expression is not boolean" };
  return { ok: true, expression };
}

function validateFlowExpressionVariableRefs(expression, variables) {
  const expr = trimToString(expression);
  for (const match of expr.matchAll(/\$([A-Za-z][A-Za-z0-9_]*)(?:\/([A-Za-z][A-Za-z0-9_]*))?/g)) {
    const variable = variables.get(match[1]);
    if (!variable) return { ok: false, reason: `unresolved variable "${match[1]}"` };
    if (match[2] && (!variable.entity || !resolveFlowAttribute(variable.entity, match[2]))) {
      return { ok: false, reason: `unresolved attribute "${match[2]}"` };
    }
  }
  return { ok: true, reason: "" };
}

function findSingleObjectVariableForEntity(variables, entityName) {
  const key = normalizeEntityToken(entityName);
  const matches = [];
  for (const [variableName, variable] of variables.entries()) {
    if (variable && variable.kind === "object" && normalizeEntityToken(variable.entity && variable.entity.name) === key) {
      matches.push(variableName);
    }
  }
  return matches.length === 1 ? matches[0] : "";
}

function expandCreateObjectAttributesAction(actionSpec, entity, outputVariableName, variables, metadata, sectionName, specName, warnings) {
  const rawAttrs = actionSpec && actionSpec.attributes && typeof actionSpec.attributes === "object" && !Array.isArray(actionSpec.attributes)
    ? actionSpec.attributes
    : null;
  if (!rawAttrs) return [];
  const changes = [];
  for (const [attributeName, valueExpression] of Object.entries(rawAttrs)) {
    const attr = resolveFlowAttribute(entity, attributeName);
    if (!attr) {
      addFlowDiagnostic(metadata, "droppedMicroflowActions", {
        section: sectionName,
        flow: specName,
        actionType: "changeObject",
        reason: `unresolved inline createObject attribute "${attributeName}"`
      });
      warnings.push(`Dropped inline createObject attribute "${attributeName}" in ${sectionName} "${specName}" because it does not exist on "${entity.name}".`);
      continue;
    }
    const normalizedValue = normalizeFlowValueExpressionForAttribute(valueExpression, attr, variables);
    if (!normalizedValue.ok) {
      addFlowDiagnostic(metadata, "droppedMicroflowActions", {
        section: sectionName,
        flow: specName,
        actionType: "changeObject",
        reason: normalizedValue.reason,
        attribute: attr.name
      });
      warnings.push(`Dropped inline createObject attribute "${attributeName}" in ${sectionName} "${specName}" because ${normalizedValue.reason}.`);
      continue;
    }
    if (trimToString(valueExpression) !== normalizedValue.expression) {
      addFlowDiagnostic(metadata, "repairedMicroflows", {
        section: sectionName,
        flow: specName,
        reason: `Normalized expression for ${attr.name}.`
      });
    }
    changes.push({
      attributeRef: attr.name,
      valueExpression: normalizedValue.ok ? normalizedValue.expression : trimToString(valueExpression)
    });
  }
  if (changes.length === 0) return [];
  addFlowDiagnostic(metadata, "repairedMicroflows", {
    section: sectionName,
    flow: specName,
    reason: "Expanded createObject.attributes into changeObject.changes."
  });
  return [{
    type: "changeObject",
    targetVariableName: outputVariableName,
    changes
  }];
}

function normalizeGeneratedFlowBranchActions(actions, variables, context, metadata, sectionName, specName, warnings) {
  const kept = [];
  for (const rawAction of Array.isArray(actions) ? actions : []) {
    const actionSpec = sanitizeGeneratedFlowAction(rawAction, {
      sectionName,
      specName,
      actionIndex: kept.length,
      warnings
    });
    if (!actionSpec) continue;
    const actionType = trimToString(actionSpec.type);
    const dropAction = (reason) => {
      addFlowDiagnostic(metadata, "droppedMicroflowActions", {
        section: sectionName,
        flow: specName,
        actionType,
        reason
      });
      warnings.push(`Dropped ${sectionName} "${specName}" nested action "${actionType}": ${reason}.`);
    };

    if (actionType === "retrieveList" || actionType === "retrieveObject" || actionType === "createObject") {
      const entityRef = actionSpec.entityRef || actionSpec.entity || actionSpec.fromEntityRef || actionSpec.fromEntity || "";
      const entity = resolveFlowEntityRef(context, entityRef);
      if (!entity) {
        dropAction(`unresolved entity "${trimToString(entityRef) || "<empty>"}"`);
        continue;
      }
      const outputVariableName = trimToString(
        actionSpec.outputVariableName ||
        actionSpec.variableName ||
        actionSpec.name ||
        `${entity.name}_${actionType === "retrieveList" ? "List" : actionType === "createObject" ? "New" : "Object"}`
      );
      if (variables.has(outputVariableName)) {
        dropAction(`duplicate variable "${outputVariableName}"`);
        continue;
      }
      actionSpec.outputVariableName = outputVariableName;
      delete actionSpec.attributes;
      delete actionSpec.parameters;
      variables.set(outputVariableName, { kind: actionType === "retrieveList" ? "list" : "object", entity });
      kept.push(actionSpec);
      if (actionType === "createObject") {
        kept.push(...expandCreateObjectAttributesAction(rawAction, entity, outputVariableName, variables, metadata, sectionName, specName, warnings));
      }
      continue;
    }

    if (actionType === "commitObject") {
      const rawTargetVariableName = normalizeFlowVariableRef(actionSpec.variableName || actionSpec.targetVariableName || actionSpec.objectVariableName || actionSpec.object);
      const targetVariableName = variables.has(rawTargetVariableName)
        ? rawTargetVariableName
        : findSingleObjectVariableForEntity(variables, rawTargetVariableName);
      const targetVar = variables.get(targetVariableName);
      if (!targetVar || targetVar.kind !== "object") {
        dropAction(`unresolved object variable "${rawTargetVariableName || "<empty>"}"`);
        continue;
      }
      actionSpec.variableName = targetVariableName;
      delete actionSpec.object;
      kept.push(actionSpec);
      continue;
    }

    if (actionType === "changeObject") {
      const targetVariableName = normalizeFlowVariableRef(actionSpec.targetVariableName || actionSpec.objectVariableName || actionSpec.variableName || actionSpec.changeVariableName || actionSpec.object);
      const targetVar = variables.get(targetVariableName);
      const explicitEntity = resolveFlowEntityRef(context, actionSpec.entityRef || actionSpec.entity || "");
      const entity = explicitEntity || (targetVar && targetVar.entity) || null;
      if (!targetVar || targetVar.kind !== "object" || !entity) {
        dropAction(`unresolved object variable "${targetVariableName || "<empty>"}"`);
        continue;
      }
      const changes = Array.isArray(actionSpec.changes) ? actionSpec.changes : Array.isArray(actionSpec.members) ? actionSpec.members : [];
      const repairedChanges = [];
      for (const change of changes) {
        const attr = resolveFlowAttribute(entity, change && (change.attributeRef || change.attribute || change.memberRef || change.member));
        if (!attr) {
          const reason = `unresolved attribute "${trimToString(change && (change.attributeRef || change.attribute || change.memberRef || change.member)) || "<empty>"}"`;
          addFlowDiagnostic(metadata, "droppedMicroflowActions", {
            section: sectionName,
            flow: specName,
            actionType,
            reason
          });
          warnings.push(`Dropped ${sectionName} "${specName}" changeObject member: ${reason}.`);
          continue;
        }
        const normalizedValue = normalizeFlowValueExpressionForAttribute(change && (change.valueExpression || change.expression || change.value), attr, variables);
        if (!normalizedValue.ok) {
          addFlowDiagnostic(metadata, "droppedMicroflowActions", {
            section: sectionName,
            flow: specName,
            actionType,
            reason: normalizedValue.reason,
            attribute: attr.name
          });
          warnings.push(`Dropped ${sectionName} "${specName}" changeObject member "${attr.name}": ${normalizedValue.reason}.`);
          continue;
        }
        if (trimToString(change && (change.valueExpression || change.expression || change.value)) !== normalizedValue.expression) {
          addFlowDiagnostic(metadata, "repairedMicroflows", {
            section: sectionName,
            flow: specName,
            reason: `Normalized expression for ${attr.name}.`
          });
        }
        repairedChanges.push({
          ...change,
          attributeRef: attr.name,
          valueExpression: normalizedValue.expression
        });
      }
      if (repairedChanges.length === 0) {
        dropAction("no buildable changeObject changes remained");
        continue;
      }
      actionSpec.targetVariableName = targetVariableName;
      actionSpec.changes = repairedChanges;
      kept.push(actionSpec);
      continue;
    }

    if (actionType === "decision") {
      if (actionSpec.condition !== undefined && actionSpec.conditionExpression === undefined && actionSpec.expression === undefined) {
        actionSpec.conditionExpression = actionSpec.condition;
        delete actionSpec.condition;
      }
      const rawCondition = actionSpec.conditionExpression !== undefined ? actionSpec.conditionExpression : actionSpec.expression;
      const normalizedCondition = normalizeFlowDecisionExpression(rawCondition, variables);
      if (!normalizedCondition.ok) {
        dropAction(normalizedCondition.reason);
        continue;
      }
      actionSpec.conditionExpression = normalizedCondition.expression;
      delete actionSpec.expression;
      actionSpec.trueActions = normalizeGeneratedFlowBranchActions(actionSpec.trueActions, new Map(variables), context, metadata, sectionName, specName, warnings);
      actionSpec.falseActions = normalizeGeneratedFlowBranchActions(actionSpec.falseActions, new Map(variables), context, metadata, sectionName, specName, warnings);
      kept.push(actionSpec);
      continue;
    }

    if (actionType === "changeVariable") {
      if (actionSpec.expression !== undefined) actionSpec.expression = repairFlowExpressionAttributeRefs(actionSpec.expression, variables);
      if (actionSpec.valueExpression !== undefined) actionSpec.valueExpression = repairFlowExpressionAttributeRefs(actionSpec.valueExpression, variables);
    }
    if (actionType === "createVariable") {
      const variableName = trimToString(actionSpec.name || actionSpec.variableName || actionSpec.targetVariableName);
      if (!variableName || variables.has(variableName)) {
        dropAction(variableName ? `duplicate variable "${variableName}"` : "missing variableName");
        continue;
      }
      const rawInitialValue = actionSpec.initialValueExpression !== undefined
        ? actionSpec.initialValueExpression
        : actionSpec.valueExpression !== undefined
          ? actionSpec.valueExpression
          : actionSpec.expression;
      if (rawInitialValue !== undefined && trimToString(rawInitialValue)) {
        const normalizedValue = normalizeFlowValueExpressionForType(
          rawInitialValue,
          actionSpec.variableType || actionSpec.dataType || actionSpec.returnType || "String",
          variables
        );
        if (!normalizedValue.ok) {
          dropAction(normalizedValue.reason);
          continue;
        }
        if (trimToString(rawInitialValue) !== normalizedValue.expression) {
          addFlowDiagnostic(metadata, "repairedMicroflows", {
            section: sectionName,
            flow: specName,
            reason: `Normalized initial value expression for variable "${variableName}".`
          });
        }
        actionSpec.initialValueExpression = normalizedValue.expression;
        delete actionSpec.valueExpression;
        delete actionSpec.expression;
      }
      variables.set(variableName, { kind: "value", entity: null });
    }
    if (actionType === "returnValue") {
      if (actionSpec.expression !== undefined) actionSpec.expression = repairFlowExpressionAttributeRefs(actionSpec.expression, variables);
      if (actionSpec.valueExpression !== undefined) actionSpec.valueExpression = repairFlowExpressionAttributeRefs(actionSpec.valueExpression, variables);
    }

    kept.push(actionSpec);
  }
  return kept;
}

function validateGeneratedFlowSectionSemantics(section, sectionName, plan, metadata, warnings = []) {
  if (!section || !Array.isArray(section.specs)) return section;
  const context = buildFlowSemanticContext(plan);
  const keptSpecs = [];

  for (const spec of section.specs) {
    if (!spec || typeof spec !== "object") continue;
    const specName = trimToString(spec.name || spec.ref) || "<unnamed>";
    const variables = new Map();
    for (const param of Array.isArray(spec.parameters) ? spec.parameters : []) {
      const name = trimToString(param && param.name);
      if (!name || variables.has(name)) continue;
      const normalizedParamType = normalizeFlowParameterTypeSpec(context, param);
      const explicitEntity = resolveFlowEntityRef(context, param.entityRef || param.entity);
      const entity = explicitEntity || normalizedParamType.entity;
      if (entity) {
        param.type = { kind: "Object", entityRef: `${context.moduleName}.${entity.name}` };
        delete param.parameterType;
        delete param.dataType;
      } else if (typeof (param.type || param.parameterType || param.dataType) === "string" &&
        !isSupportedFlowDataTypeKind(param.type || param.parameterType || param.dataType)) {
        warnings.push(`Normalized unsupported ${sectionName} "${specName}" parameter type "${trimToString(param.type || param.parameterType || param.dataType)}" to String.`);
        param.type = "String";
        delete param.parameterType;
        delete param.dataType;
      }
      variables.set(name, {
        kind: entity ? "object" : "value",
        entity
      });
    }

    const keptActions = [];
    for (const action of Array.isArray(spec.actions) ? spec.actions : []) {
      const type = sanitizeGeneratedFlowAction(action, {
        sectionName,
        specName,
        actionIndex: keptActions.length,
        warnings
      });
      if (!type) continue;
      const actionSpec = type;
      const actionType = trimToString(actionSpec.type);
      const actionLabel = `${sectionName} "${specName}" action "${actionType}"`;
      const dropAction = (reason) => {
        addFlowDiagnostic(metadata, "droppedMicroflowActions", {
          section: sectionName,
          flow: specName,
          actionType,
          reason
        });
        warnings.push(`Dropped ${actionLabel}: ${reason}.`);
      };

      if ((actionType === "callMicroflow" || actionType === "callNanoflow") &&
        Array.isArray(actionSpec.parameterMappings) && actionSpec.parameterMappings.length > 0) {
        dropAction("unsupported parameter mappings");
        continue;
      }
      if (actionType === "callMicroflow") {
        const target = trimToString(actionSpec.microflowRef || actionSpec.targetRef || actionSpec.microflowQualifiedName || actionSpec.target);
        if (!target || !context.microflowRefs.has(target)) {
          dropAction(`unresolved microflow target "${target || "<empty>"}"`);
          continue;
        }
      }
      if (actionType === "callNanoflow") {
        const target = trimToString(actionSpec.nanoflowRef || actionSpec.targetRef || actionSpec.nanoflowQualifiedName || actionSpec.target);
        if (!target || !context.nanoflowRefs.has(target)) {
          dropAction(`unresolved nanoflow target "${target || "<empty>"}"`);
          continue;
        }
      }

      if (actionType === "retrieveList" || actionType === "retrieveObject" || actionType === "createObject") {
        const entityRef = actionSpec.entityRef || actionSpec.entity || actionSpec.fromEntityRef || actionSpec.fromEntity || "";
        const entity = resolveFlowEntityRef(context, entityRef);
        if (!entity) {
          dropAction(`unresolved entity "${trimToString(entityRef) || "<empty>"}"`);
          continue;
        }
        const outputVariableName = trimToString(
          actionSpec.outputVariableName ||
          actionSpec.variableName ||
          actionSpec.name ||
          `${entity.name}_${actionType === "retrieveList" ? "List" : actionType === "createObject" ? "New" : "Object"}`
        );
        if (variables.has(outputVariableName)) {
          dropAction(`duplicate variable "${outputVariableName}"`);
          continue;
        }
        actionSpec.outputVariableName = outputVariableName;
        delete actionSpec.attributes;
        delete actionSpec.parameters;
        variables.set(outputVariableName, {
          kind: actionType === "retrieveList" ? "list" : "object",
          entity
        });
        if (actionType === "createObject") {
          keptActions.push(actionSpec);
          keptActions.push(...expandCreateObjectAttributesAction(action, entity, outputVariableName, variables, metadata, sectionName, specName, warnings));
          continue;
        }
      }

      if (actionType === "aggregateList") {
        const inputListVariableName = trimToString(
          actionSpec.inputListVariableName ||
          actionSpec.listVariableName ||
          actionSpec.sourceListVariableName ||
          actionSpec.input
        );
        const inputVar = variables.get(inputListVariableName);
        if (!inputVar || inputVar.kind !== "list") {
          dropAction(`variable used before assignment "${inputListVariableName || "<empty>"}"`);
          continue;
        }
        const fn = trimToString(actionSpec.function || actionSpec.aggregateFunction || "Count").toLowerCase();
        const requiresAttr = ["sum", "minimum", "min", "maximum", "max", "average", "avg"].includes(fn);
        const attrRef = actionSpec.attributeRef || actionSpec.attribute || actionSpec.memberRef || actionSpec.member || "";
        if (requiresAttr && !resolveFlowAttribute(inputVar.entity, attrRef)) {
          dropAction(`unresolved attribute "${trimToString(attrRef) || "<empty>"}"`);
          continue;
        }
        const outputVariableName = trimToString(actionSpec.outputVariableName || actionSpec.variableName || actionSpec.name || `${inputListVariableName}Count`);
        if (variables.has(outputVariableName)) {
          dropAction(`duplicate variable "${outputVariableName}"`);
          continue;
        }
        actionSpec.outputVariableName = outputVariableName;
        variables.set(outputVariableName, { kind: "value", entity: null });
      }

      if (actionType === "createVariable") {
        const variableName = trimToString(actionSpec.name || actionSpec.variableName || actionSpec.targetVariableName);
        if (!variableName || variables.has(variableName)) {
          dropAction(variableName ? `duplicate variable "${variableName}"` : "missing variableName");
          continue;
        }
        const rawInitialValue = actionSpec.initialValueExpression !== undefined
          ? actionSpec.initialValueExpression
          : actionSpec.valueExpression !== undefined
            ? actionSpec.valueExpression
            : actionSpec.expression;
        if (rawInitialValue !== undefined && trimToString(rawInitialValue)) {
          const normalizedValue = normalizeFlowValueExpressionForType(
            rawInitialValue,
            actionSpec.variableType || actionSpec.dataType || actionSpec.returnType || "String",
            variables
          );
          if (!normalizedValue.ok) {
            dropAction(normalizedValue.reason);
            continue;
          }
          if (trimToString(rawInitialValue) !== normalizedValue.expression) {
            addFlowDiagnostic(metadata, "repairedMicroflows", {
              section: sectionName,
              flow: specName,
              reason: `Normalized initial value expression for variable "${variableName}".`
            });
          }
          actionSpec.initialValueExpression = normalizedValue.expression;
          delete actionSpec.valueExpression;
          delete actionSpec.expression;
        }
        const entity = inferFlowVariableEntity(context, actionSpec.variableType || actionSpec.dataType || actionSpec.returnType || {});
        variables.set(variableName, { kind: entity ? "object" : "value", entity });
      }

      if (actionType === "changeVariable") {
        const variableName = normalizeFlowVariableRef(actionSpec.name || actionSpec.variableName || actionSpec.changeVariableName || actionSpec.targetVariableName);
        if (!variables.has(variableName)) {
          dropAction(`variable used before assignment "${variableName || "<empty>"}"`);
          continue;
        }
        actionSpec.variableName = variableName;
        if (actionSpec.expression !== undefined) actionSpec.expression = repairFlowExpressionAttributeRefs(actionSpec.expression, variables);
        if (actionSpec.valueExpression !== undefined) actionSpec.valueExpression = repairFlowExpressionAttributeRefs(actionSpec.valueExpression, variables);
      }

      if (actionType === "changeObject") {
        const targetVariableName = normalizeFlowVariableRef(actionSpec.targetVariableName || actionSpec.objectVariableName || actionSpec.variableName || actionSpec.changeVariableName || actionSpec.object);
        const targetVar = variables.get(targetVariableName);
        const explicitEntity = resolveFlowEntityRef(context, actionSpec.entityRef || actionSpec.entity || "");
        const entity = explicitEntity || (targetVar && targetVar.entity) || null;
        if (!targetVar || targetVar.kind !== "object" || !entity) {
          dropAction(`unresolved object variable "${targetVariableName || "<empty>"}"`);
          continue;
        }
        actionSpec.targetVariableName = targetVariableName;
        const changes = Array.isArray(actionSpec.changes) ? actionSpec.changes : Array.isArray(actionSpec.members) ? actionSpec.members : [];
        const repairedChanges = [];
        for (const change of changes) {
          const attr = resolveFlowAttribute(entity, change && (change.attributeRef || change.attribute || change.memberRef || change.member));
          if (!attr) {
            const reason = `unresolved attribute "${trimToString(change && (change.attributeRef || change.attribute || change.memberRef || change.member)) || "<empty>"}"`;
            addFlowDiagnostic(metadata, "droppedMicroflowActions", {
              section: sectionName,
              flow: specName,
              actionType,
              reason
            });
            warnings.push(`Dropped ${sectionName} "${specName}" changeObject member: ${reason}.`);
            continue;
          }
          const normalizedValue = normalizeFlowValueExpressionForAttribute(change && (change.valueExpression || change.expression || change.value), attr, variables);
          if (!normalizedValue.ok) {
            addFlowDiagnostic(metadata, "droppedMicroflowActions", {
              section: sectionName,
              flow: specName,
              actionType,
              reason: normalizedValue.reason,
              attribute: attr.name
            });
            warnings.push(`Dropped ${sectionName} "${specName}" changeObject member "${attr.name}": ${normalizedValue.reason}.`);
            continue;
          }
          if (trimToString(change && (change.valueExpression || change.expression || change.value)) !== normalizedValue.expression) {
            addFlowDiagnostic(metadata, "repairedMicroflows", {
              section: sectionName,
              flow: specName,
              reason: `Normalized expression for ${attr.name}.`
            });
          }
          repairedChanges.push({
            ...change,
            attributeRef: attr.name,
            valueExpression: normalizedValue.expression
          });
        }
        if (repairedChanges.length === 0) {
          dropAction("no buildable changeObject changes remained");
          continue;
        }
        actionSpec.changes = repairedChanges;
      }

      if (actionType === "commitObject") {
        const rawTargetVariableName = normalizeFlowVariableRef(actionSpec.variableName || actionSpec.targetVariableName || actionSpec.objectVariableName || actionSpec.object);
        const targetVariableName = variables.has(rawTargetVariableName)
          ? rawTargetVariableName
          : findSingleObjectVariableForEntity(variables, rawTargetVariableName);
        const targetVar = variables.get(targetVariableName);
        if (!targetVar || targetVar.kind !== "object") {
          dropAction(`unresolved object variable "${rawTargetVariableName || "<empty>"}"`);
          continue;
        }
        actionSpec.variableName = targetVariableName;
        delete actionSpec.object;
      }

      if (actionType === "decision") {
        if (actionSpec.condition !== undefined && actionSpec.conditionExpression === undefined && actionSpec.expression === undefined) {
          actionSpec.conditionExpression = actionSpec.condition;
          delete actionSpec.condition;
        }
        const rawCondition = actionSpec.conditionExpression !== undefined ? actionSpec.conditionExpression : actionSpec.expression;
        const normalizedCondition = normalizeFlowDecisionExpression(rawCondition, variables);
        if (!normalizedCondition.ok) {
          dropAction(normalizedCondition.reason);
          continue;
        }
        actionSpec.conditionExpression = normalizedCondition.expression;
        delete actionSpec.expression;
        actionSpec.trueActions = normalizeGeneratedFlowBranchActions(actionSpec.trueActions, new Map(variables), context, metadata, sectionName, specName, warnings);
        actionSpec.falseActions = normalizeGeneratedFlowBranchActions(actionSpec.falseActions, new Map(variables), context, metadata, sectionName, specName, warnings);
      }

      if (actionType === "returnValue") {
        if (actionSpec.expression !== undefined) actionSpec.expression = repairFlowExpressionAttributeRefs(actionSpec.expression, variables);
        if (actionSpec.valueExpression !== undefined) actionSpec.valueExpression = repairFlowExpressionAttributeRefs(actionSpec.valueExpression, variables);
      }

      keptActions.push(actionSpec);
    }

    if (keptActions.length === 0) {
      const reason = "no buildable actions remained after semantic validation";
      addFlowDiagnostic(metadata, "droppedMicroflows", {
        section: sectionName,
        ref: trimToString(spec.ref),
        name: trimToString(spec.name) || specName,
        reason
      });
      warnings.push(`Dropped ${sectionName} "${specName}" because ${reason}.`);
      continue;
    }
    keptSpecs.push({ ...spec, actions: keptActions });
    addFlowDiagnostic(metadata, "keptMicroflows", { section: sectionName, name: specName, actionCount: keptActions.length });
  }

  section.specs = keptSpecs;
  return section;
}

function removeDroppedFlowReferences(plan, droppedFlowRefs, metadata, warnings = []) {
  const dropped = new Set((droppedFlowRefs || []).map((ref) => trimToString(ref)).filter(Boolean));
  if (dropped.size === 0) return;
  const dropRef = (source, ref) => {
    addFlowDiagnostic(metadata, "droppedMicroflowReferences", { source, ref });
    warnings.push(`Removed reference to dropped flow "${ref}" from ${source}.`);
  };

  for (const sectionName of ["microflows", "nanoflows"]) {
    for (const spec of Array.isArray(plan && plan[sectionName] && plan[sectionName].specs) ? plan[sectionName].specs : []) {
      const specName = trimToString(spec && (spec.ref || spec.name)) || "<unnamed>";
      spec.actions = (Array.isArray(spec && spec.actions) ? spec.actions : []).filter((action) => {
        const ref = trimToString(action && (action.microflowRef || action.nanoflowRef || action.targetRef || action.target));
        if ((action && (action.type === "callMicroflow" || action.type === "callNanoflow")) && dropped.has(ref)) {
          dropRef(`${sectionName} "${specName}"`, ref);
          return false;
        }
        return true;
      });
    }
  }

  for (const page of Array.isArray(plan && plan.pages && plan.pages.specs) ? plan.pages.specs : []) {
    walkPageStepsMutable(page && page.content, (step) => {
      if (!step || typeof step !== "object") return;
      if ((step.type === "callMicroflowButton" || step.type === "callNanoflowButton") && dropped.has(trimToString(step.microflowRef || step.nanoflowRef))) {
        dropRef(`page "${page.ref || page.name || "<unnamed>"}"`, trimToString(step.microflowRef || step.nanoflowRef));
        step.type = "dynamicText";
        step.text = trimToString(step.caption || step.text) || "Unavailable action";
        step.microflowRef = "";
        step.nanoflowRef = "";
      }
    });
  }

  for (const workflow of Array.isArray(plan && plan.workflows && plan.workflows.specs) ? plan.workflows.specs : []) {
    walkWorkflowStepsMutable(workflow && workflow.steps, (step) => {
      const ref = trimToString(step && step.handlerMicroflowRef);
      if (ref && dropped.has(ref)) {
        dropRef(`workflow "${workflow.ref || workflow.name || "<unnamed>"}"`, ref);
        delete step.handlerMicroflowRef;
      }
    });
  }
}

function mergeSpecSections(baseSection, llmSection, artifactLabel = "artifact", warnings = []) {
  const base = cloneSpecSection(baseSection) || {};
  const llm = cloneSpecSection(llmSection) || {};
  const mergedSpecs = dedupeByName(
    [
      ...(Array.isArray(base.specs) ? base.specs : []),
      ...(Array.isArray(llm.specs) ? llm.specs : [])
    ],
    (spec) => spec && (spec.ref || spec.name)
  );
  if (mergedSpecs.length === 0) return null;
  return {
    ...base,
    ...llm,
    specs: ensureUniqueSpecNames(mergedSpecs, artifactLabel, warnings)
  };
}

function cloneDiagnosticValue(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return String(value);
  }
}

function endpointNameFromValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return trimToString(value);
  if (typeof value !== "object") return "";
  for (const key of ["entity", "entityName", "name", "ref", "entityRef", "qualifiedName"]) {
    const text = trimToString(value[key]);
    if (text) return text;
  }
  return "";
}

function readAssociationEndpoint(assoc, keys) {
  for (const key of keys) {
    if (!assoc || assoc[key] === undefined || assoc[key] === null) continue;
    const text = endpointNameFromValue(assoc[key]);
    if (text) return text;
  }
  return "";
}

function collectAssociationEndpointHints(assoc) {
  return {
    parentEntity: readAssociationEndpoint(assoc, ["parentEntity", "parent", "from", "source", "entity1", "left", "ownerEntity"]),
    childEntity: readAssociationEndpoint(assoc, ["childEntity", "child", "to", "target", "entity2", "right", "targetEntity"])
  };
}

function normalizeEntityRefKey(raw) {
  const text = trimToString(raw);
  if (!text) return "";
  return text.includes(".") ? text.split(".").pop().toLowerCase() : text.toLowerCase();
}

function combineAssociationDiagnostics(baseDomainModel, llmDomainModel, normalizedAssociationCount) {
  const baseDiagnostics = baseDomainModel && baseDomainModel._associationDiagnostics;
  const llmDiagnostics = llmDomainModel && llmDomainModel._associationDiagnostics;
  const diagnostics = [baseDiagnostics, llmDiagnostics].filter((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
  );
  return {
    rawAssociationCount: diagnostics.reduce((sum, entry) => sum + Number(entry.rawAssociationCount || 0), 0),
    normalizedAssociationCount,
    malformedAssociationCandidates: diagnostics.flatMap((entry) =>
      Array.isArray(entry.malformedAssociationCandidates) ? entry.malformedAssociationCandidates : []
    )
  };
}

function normalizeDomainModel(domainModelSection, warnings, options = {}) {
  const source = domainModelSection && typeof domainModelSection === "object" ? domainModelSection : {};
  const entitiesSource = Array.isArray(source.entities) ? source.entities : [];
  const entities = dedupeByName(
    entitiesSource
      .map((entity, index) => normalizeEntity(entity, index, options))
      .filter((entity) => {
        if (!entity) return false;
        if (!NON_DOMAIN_ARTIFACT_ENTITY_RE.test(entity.name)) return true;
        warnings.push(`Dropped non-domain artifact entity "${entity.name}"; use microflows/workflows/pages sections instead.`);
        return false;
      }),
    (e) => e.name
  );

  if (entities.length === 0) {
    warnings.push("Generated domain model had no entities.");
  }

  const entityNameByLower = new Map(entities.map((e) => [String(e.name).toLowerCase(), e.name]));
  const sourceAssociations = Array.isArray(source.associations) ? source.associations : [];
  const associationDiagnostics = {
    rawAssociationCount: sourceAssociations.length,
    normalizedAssociationCount: 0,
    malformedAssociationCandidates: []
  };
  const associations = sourceAssociations.length > 0
    ? dedupeByName(
        sourceAssociations
          .filter((assoc) => assoc && typeof assoc === "object")
          .map((assoc) => {
            const parentRaw = trimToString(assoc.parentEntity || assoc.from);
            const childRaw = trimToString(assoc.childEntity || assoc.to);
            const parentKey = normalizeEntityRefKey(parentRaw);
            const childKey = normalizeEntityRefKey(childRaw);
            const parentEntity = entityNameByLower.get(parentKey);
            const childEntity = entityNameByLower.get(childKey);

            if (!parentEntity || !childEntity) {
              const endpointHints = collectAssociationEndpointHints(assoc);
              const candidate = {
                name: trimToString(assoc.name) || toSafeName(`${endpointHints.parentEntity}_${endpointHints.childEntity}`, "Association"),
                parentEntity: endpointHints.parentEntity,
                childEntity: endpointHints.childEntity,
                type: trimToString(assoc.type || assoc.associationType || assoc.relationshipType),
                reason: "Association endpoints could not be resolved after normalization.",
                raw: cloneDiagnosticValue(assoc)
              };
              associationDiagnostics.malformedAssociationCandidates.push(candidate);
              warnings.push(
                `Queued association \"${candidate.name || "<unnamed>"}\" for domain review because entities could not be resolved after normalization.`
              );
              return null;
            }

            const associationType = normalizeAssociationType(assoc.type, {
              allowSemanticFallback: true
            });
            const metadata = assoc.metadata && typeof assoc.metadata === "object" && !Array.isArray(assoc.metadata)
              ? { ...assoc.metadata }
              : {};
            if (associationType.semanticType) {
              metadata.relationshipType = metadata.relationshipType || associationType.semanticType;
              warnings.push(
                `Normalized semantic association type "${associationType.semanticType}" on association "${assoc.name || `${parentEntity}_${childEntity}`}" to "${associationType.type}".`
              );
            }

            return {
              name: toSafeName(assoc.name || `${parentEntity}_${childEntity}`, `${parentEntity}_${childEntity}`),
              parentEntity,
              childEntity,
              type: associationType.type,
              owner: trimToString(assoc.owner) || "Both",
              ...(Object.keys(metadata).length > 0 ? { metadata } : {})
            };
          })
          .filter(Boolean),
        (a) => a.name
      )
    : [];
  associationDiagnostics.normalizedAssociationCount = associations.length;

  const enumerations = Array.isArray(source.enumerations)
    ? dedupeByName(source.enumerations.map(normalizeEnumeration).filter(Boolean), (e) => e.name)
    : [];

  return {
    entities,
    associations,
    enumerations,
    _associationDiagnostics: associationDiagnostics
  };
}

function buildExecutionSection(appContext) {
  const execution = {
    commit: coerceBoolean(appContext.commit, false),
    dg2Cleanup: coerceBoolean(appContext.dg2Cleanup, true),
    forceLegacyWebClientForLookups: coerceBoolean(appContext.forceLegacyWebClientForLookups, true)
  };

  if (trimToString(appContext.commitMessage)) {
    execution.commitMessage = trimToString(appContext.commitMessage);
  }
  if (appContext.createApp !== undefined) {
    execution.createApp = Boolean(appContext.createApp);
  }
  if (trimToString(appContext.createAppNamePrefix)) {
    execution.createAppNamePrefix = trimToString(appContext.createAppNamePrefix);
  }
  if (trimToString(appContext.appName)) {
    execution.createAppName = trimToString(appContext.appName);
  }
  if (trimToString(appContext.createAppRepositoryType)) {
    execution.createAppRepositoryType = trimToString(appContext.createAppRepositoryType);
  }
  if (trimToString(appContext.seedAppId)) {
    execution.seedAppId = trimToString(appContext.seedAppId);
  }

  return execution;
}

function splitRoleCandidateList(text) {
  return String(text || "")
    .replace(/\band\b/gi, ",")
    .replace(/[\/|]/g, ",")
    .split(/[,\n;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function inferRoleCandidatesFromDomainInfo(domainInfo = "") {
  const candidates = [];
  const lines = String(domainInfo || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (!/\b(role|user type|user types|persona|personas|actor|actors)\b/i.test(line)) continue;
    const focused = line.includes(":") ? line.split(":").slice(1).join(":") : line;
    for (const part of splitRoleCandidateList(focused)) {
      const cleaned = part
        .replace(/\b(i have|we have|there (?:are|is)|our)\b/gi, " ")
        .replace(/\b\d+\b/g, " ")
        .replace(/\buser types?\b/gi, " ")
        .replace(/\broles?\b/gi, " ")
        .replace(/\bpersonas?\b/gi, " ")
        .replace(/\bactors?\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned) candidates.push(cleaned);
    }
  }

  return candidates;
}

function normalizeRoleNameForSecurity(rawRole, moduleName = "MyFirstModule") {
  const original = trimToString(rawRole);
  if (!original) return "";
  const raw = original.includes(".") ? original.split(".").pop() : original;
  if (!raw) return "";
  const words = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length > 4) return "";
  if (/^\s*the\b/i.test(raw)) return "";
  if (/\b(should|assigned|bound|include|prefer|selecting|generated?|implementation)\b/i.test(raw)) {
    return "";
  }
  const normalized = toPascalCase(raw, "");
  if (!normalized) return "";
  const lower = normalized.toLowerCase();
  if (lower === "user") return "AppUser";
  if (lower === "administrator") return "AppAdministrator";
  if (lower.endsWith("role") && lower.length > "role".length) {
    return normalized.slice(0, -"Role".length);
  }
  return normalized;
}

function roleImpliesAdministrator(rawRole) {
  return /\badmin(?:istrator)?\b/i.test(trimToString(rawRole));
}

function normalizeRoleRefList(refs, roleNameMap, moduleName) {
  const out = [];
  for (const rawRef of Array.isArray(refs) ? refs : []) {
    const ref = trimToString(rawRef);
    if (!ref) continue;
    const token = ref.includes(".") ? ref.split(".").pop() : ref;
    const normalized =
      roleNameMap.get(ref.toLowerCase()) ||
      roleNameMap.get(token.toLowerCase()) ||
      normalizeRoleNameForSecurity(token, moduleName);
    if (normalized) out.push(normalized);
  }
  return uniq(out);
}

function walkWorkflowStepsMutable(steps, visitor) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== "object") continue;
    visitor(step);
    for (const outcome of Array.isArray(step.outcomes) ? step.outcomes : []) {
      walkWorkflowStepsMutable(outcome && outcome.steps, visitor);
    }
  }
}

function collectSecurityRoleSeeds({ generatedPlan, appContext, stories = [], domainInfo = "" }) {
  const moduleName = trimToString(appContext && appContext.moduleName) || "MyFirstModule";
  const seeds = [];
  const add = (raw) => {
    const normalized = normalizeRoleNameForSecurity(raw, moduleName);
    if (normalized) seeds.push(normalized);
  };

  const draftSecurity =
    generatedPlan && generatedPlan.security && typeof generatedPlan.security === "object" ? generatedPlan.security : {};
  for (const moduleRole of Array.isArray(draftSecurity.moduleRoles) ? draftSecurity.moduleRoles : []) {
    add(typeof moduleRole === "string" ? moduleRole : moduleRole && moduleRole.name);
  }
  for (const userRole of Array.isArray(draftSecurity.userRoles) ? draftSecurity.userRoles : []) {
    add(userRole && userRole.name);
  }
  for (const page of generatedPlan && generatedPlan.pages && Array.isArray(generatedPlan.pages.specs) ? generatedPlan.pages.specs : []) {
    for (const rawRef of Array.isArray(page && page.allowedRoles) ? page.allowedRoles : []) add(rawRef);
  }

  const navigation =
    generatedPlan && generatedPlan.app && generatedPlan.app.navigation ? generatedPlan.app.navigation : {};
  for (const entry of [...(navigation.homePageButtons || []), ...(navigation.menuItems || [])]) {
    for (const rawRef of Array.isArray(entry && entry.allowedRoles) ? entry.allowedRoles : []) add(rawRef);
  }

  for (const workflow of generatedPlan && generatedPlan.workflows && Array.isArray(generatedPlan.workflows.specs)
    ? generatedPlan.workflows.specs
    : []) {
    walkWorkflowStepsMutable(workflow && workflow.steps, (step) => {
      for (const key of ["userRoleRefs", "targetUserRoleRefs", "allowedUserRoles"]) {
        for (const rawRef of Array.isArray(step && step[key]) ? step[key] : []) add(rawRef);
      }
    });
  }

  for (const story of stories) add(story && story.role);
  for (const candidate of inferRoleCandidatesFromDomainInfo(domainInfo)) add(candidate);

  if (seeds.length === 0) {
    add("AppUser");
  }

  return uniq(seeds);
}

function isSyntheticRoleName(roleName, moduleName = "MyFirstModule") {
  const normalized = toPascalCase(roleName, "");
  if (!normalized) return true;
  const lower = normalized.toLowerCase();
  if (["role", "userrole", "moduleuserrole", "moduleuser", "moduleadmin"].includes(lower)) return true;
  const moduleToken = toPascalCase(moduleName, "");
  if (!moduleToken) return false;
  const moduleLower = moduleToken.toLowerCase();
  return lower === moduleLower ||
    lower === `${moduleLower}role` ||
    lower === `${moduleLower}user` ||
    lower === `${moduleLower}roleuser` ||
    lower === `${moduleLower}roleadministrator` ||
    lower === `${moduleLower}administrator`;
}

function modulePrefixedNameSuffix(name, moduleName = "MyFirstModule") {
  const normalized = toPascalCase(name, "");
  const moduleToken = toPascalCase(moduleName, "");
  if (!normalized || !moduleToken) return "";
  if (normalized.toLowerCase() === moduleToken.toLowerCase()) return "";
  if (!normalized.toLowerCase().startsWith(moduleToken.toLowerCase())) return "";
  return normalized.slice(moduleToken.length);
}

function roleSuffixedNameBase(name) {
  const normalized = toPascalCase(name, "");
  if (!normalized || normalized.length <= "Role".length) return "";
  if (!normalized.toLowerCase().endsWith("role")) return "";
  return normalized.slice(0, -"Role".length);
}

function sanitizeSecurityRoles(plan, stories = [], domainInfo = "", warnings = []) {
  const moduleName = trimToString(plan && plan.app && plan.app.moduleName) || "MyFirstModule";
  if (!plan.security || typeof plan.security !== "object") plan.security = {};
  const rawUserRoles = (Array.isArray(plan.security.userRoles) ? plan.security.userRoles : [])
    .map((role) => trimToString(role && role.name))
    .filter(Boolean);
  const removedSyntheticRoles = [];
  const removedKeys = new Set();
  const keptRoles = [];
  const seen = new Set();

  for (const role of Array.isArray(plan.security.userRoles) ? plan.security.userRoles : []) {
    const name = normalizeRoleNameForSecurity(role && role.name, moduleName);
    if (!name) continue;
    if (isSyntheticRoleName(name, moduleName)) {
      removedSyntheticRoles.push(name);
      removedKeys.add(name.toLowerCase());
      continue;
    }
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    keptRoles.push({
      ...role,
      name,
      moduleRoles: normalizeRoleRefList(role && role.moduleRoles, new Map([[name.toLowerCase(), name]]), moduleName)
        .filter((ref) => !isSyntheticRoleName(ref, moduleName)),
      systemModuleRole: trimToString(role && role.systemModuleRole) || (roleImpliesAdministrator(name) ? "System.Administrator" : "System.User")
    });
  }

  if (keptRoles.length === 0) {
    for (const roleName of collectSecurityRoleSeeds({ generatedPlan: { security: {} }, appContext: { moduleName }, stories, domainInfo })) {
      if (!roleName || isSyntheticRoleName(roleName, moduleName) || seen.has(roleName.toLowerCase())) continue;
      seen.add(roleName.toLowerCase());
      keptRoles.push({
        name: roleName,
        moduleRoles: [roleName],
        systemModuleRole: roleImpliesAdministrator(roleName) ? "System.Administrator" : "System.User"
      });
    }
  }

  const keptNames = new Set(keptRoles.map((role) => role.name.toLowerCase()));
  for (const role of keptRoles) {
    role.moduleRoles = uniq((Array.isArray(role.moduleRoles) && role.moduleRoles.length > 0 ? role.moduleRoles : [role.name])
      .filter((ref) => keptNames.has(String(ref).toLowerCase()) && !removedKeys.has(String(ref).toLowerCase())));
    if (role.moduleRoles.length === 0) role.moduleRoles = [role.name];
  }

  const originalModuleRoles = Array.isArray(plan.security.moduleRoles) ? plan.security.moduleRoles : [];
  for (const role of originalModuleRoles) {
    const name = normalizeRoleNameForSecurity(typeof role === "string" ? role : role && role.name, moduleName);
    if (name && isSyntheticRoleName(name, moduleName)) {
      removedSyntheticRoles.push(name);
      removedKeys.add(name.toLowerCase());
    }
  }

  plan.security.userRoles = keptRoles;
  plan.security.moduleRoles = uniq(keptRoles.flatMap((role) => [role.name, ...(role.moduleRoles || [])])
    .filter((name) => keptNames.has(String(name).toLowerCase())));
  if (Array.isArray(plan.security.demoUsers) && plan.security.demoUsers.length > 0) {
    warnings.push("Removed generated demo users; users are managed manually.");
  }
  plan.security.demoUsers = [];

  if (removedSyntheticRoles.length > 0) {
    warnings.push(`Removed synthetic security roles: ${uniq(removedSyntheticRoles).join(", ")}.`);
  }

  return {
    rawUserRoles,
    removedSyntheticRoles: uniq(removedSyntheticRoles),
    keptUserRoles: keptRoles.map((role) => role.name)
  };
}

function ensureUserRoleEntities(plan, stories = [], warnings = []) {
  if (!plan.domainModel || !Array.isArray(plan.domainModel.entities)) return { roleEntitiesCreated: [] };
  const created = [];
  const entityByKey = new Map(plan.domainModel.entities.map((entity) => [normalizeEntityToken(entity && entity.name), entity]));
  for (const role of Array.isArray(plan.security && plan.security.userRoles) ? plan.security.userRoles : []) {
    const roleName = trimToString(role && role.name);
    if (!roleName) continue;
    const key = normalizeEntityToken(roleName);
    if (entityByKey.has(key)) continue;
    const entityName = toPascalCase(roleName, "AppUserProfile");
    const entity = normalizeEntity({
      name: entityName,
      attributes: [
        { name: "Name", type: "String", required: true },
        { name: "Email", type: "String", required: false },
        { name: "IsActive", type: "Boolean", required: false, defaultValue: false }
      ]
    }, 0, { expandNameFallback: false });
    if (!entity) continue;
    plan.domainModel.entities.push(entity);
    entityByKey.set(key, entity);
    created.push({
      role: roleName,
      entity: entity.name,
      attributes: entity.attributes.map((attr) => attr.name),
      reason: storyMentionsTerm({ role: roleName, want: "", benefit: "", raw: "" }, roleName)
        ? "Created profile entity for story-backed user role."
        : "Created profile entity for final security user role."
    });
    warnings.push(`Created profile entity "${entity.name}" for security role "${roleName}".`);
  }
  return { roleEntitiesCreated: created };
}

function synthesizeSecuritySection({ generatedPlan, appContext, stories = [], domainInfo = "", warnings = [] }) {
  const moduleName = trimToString(appContext && appContext.moduleName) || "MyFirstModule";
  const draftSecurity =
    generatedPlan && generatedPlan.security && typeof generatedPlan.security === "object" ? generatedPlan.security : {};
  if (Array.isArray(draftSecurity.demoUsers) && draftSecurity.demoUsers.length > 0) {
    warnings.push("Removed generated demo users; users are managed manually.");
  }
  const inferredRoles = collectSecurityRoleSeeds({ generatedPlan, appContext, stories, domainInfo });
  const roleNameMap = new Map();
  for (const roleName of inferredRoles) {
    roleNameMap.set(roleName.toLowerCase(), roleName);
  }

  const userRoles = [];
  const seen = new Set();
  for (const spec of Array.isArray(draftSecurity.userRoles) ? draftSecurity.userRoles : []) {
    if (!spec || typeof spec !== "object") continue;
    const normalizedName = normalizeRoleNameForSecurity(spec.name, moduleName);
    if (!normalizedName) continue;
    roleNameMap.set(trimToString(spec.name).toLowerCase(), normalizedName);
    roleNameMap.set(normalizedName.toLowerCase(), normalizedName);
    if (seen.has(normalizedName.toLowerCase())) continue;
    seen.add(normalizedName.toLowerCase());
    const moduleRoles = normalizeRoleRefList(spec.moduleRoles, roleNameMap, moduleName);
    userRoles.push({
      ...spec,
      name: normalizedName,
      moduleRoles: moduleRoles.length > 0 ? moduleRoles : [normalizedName],
      systemModuleRole:
        trimToString(spec.systemModuleRole) || (roleImpliesAdministrator(spec.name) ? "System.Administrator" : "System.User")
    });
  }

  for (const roleName of inferredRoles) {
    if (seen.has(roleName.toLowerCase())) continue;
    seen.add(roleName.toLowerCase());
    userRoles.push({
      name: roleName,
      moduleRoles: [roleName],
      systemModuleRole: roleImpliesAdministrator(roleName) ? "System.Administrator" : "System.User"
    });
  }

  const moduleRoles = uniq([
    ...normalizeRoleRefList(draftSecurity.moduleRoles, roleNameMap, moduleName),
    ...userRoles.flatMap((spec) => [spec.name, ...normalizeRoleRefList(spec.moduleRoles, roleNameMap, moduleName)])
  ]);

  return {
    ...(draftSecurity && typeof draftSecurity === "object" ? draftSecurity : {}),
    enabled: draftSecurity.enabled !== false,
    securityLevel: normalizeSecurityLevel(draftSecurity.securityLevel || draftSecurity.level),
    moduleRoles,
    userRoles,
    demoUsers: []
  };
}

function normalizeGeneratedPlanRoleRefs(plan, warnings = []) {
  const moduleName = trimToString(plan && plan.app && plan.app.moduleName) || "MyFirstModule";
  const roleNameMap = new Map();
  for (const spec of Array.isArray(plan && plan.security && plan.security.userRoles) ? plan.security.userRoles : []) {
    const name = trimToString(spec && spec.name);
    if (name) roleNameMap.set(name.toLowerCase(), name);
  }

  const validRoleKeys = new Set(Array.from(roleNameMap.values()).map((name) => name.toLowerCase()));
  const normalizeRefs = (refs) => normalizeRoleRefList(refs, roleNameMap, moduleName)
    .filter((roleName) => validRoleKeys.has(String(roleName).toLowerCase()));

  for (const page of plan && plan.pages && Array.isArray(plan.pages.specs) ? plan.pages.specs : []) {
    if (Array.isArray(page && page.allowedRoles)) page.allowedRoles = normalizeRefs(page.allowedRoles);
  }

  const navigation = plan && plan.app && plan.app.navigation && typeof plan.app.navigation === "object"
    ? plan.app.navigation
    : null;
  if (navigation) {
    for (const entry of [...(navigation.homePageButtons || []), ...(navigation.menuItems || [])]) {
      if (Array.isArray(entry && entry.allowedRoles)) entry.allowedRoles = normalizeRefs(entry.allowedRoles);
    }
  }

  for (const workflow of plan && plan.workflows && Array.isArray(plan.workflows.specs) ? plan.workflows.specs : []) {
    walkWorkflowStepsMutable(workflow && workflow.steps, (step) => {
      for (const key of ["userRoleRefs", "targetUserRoleRefs", "allowedUserRoles"]) {
        if (Array.isArray(step && step[key])) step[key] = normalizeRefs(step[key]);
      }
    });
  }

  for (const demoUser of plan && plan.security && Array.isArray(plan.security.demoUsers) ? plan.security.demoUsers : []) {
    if (Array.isArray(demoUser && demoUser.userRoles)) demoUser.userRoles = normalizeRefs(demoUser.userRoles);
  }

  if (!plan.security || !Array.isArray(plan.security.userRoles) || plan.security.userRoles.length === 0) {
    warnings.push("Generated plan security normalization produced no user roles; expected at least one.");
  }
}

function normalizeGeneratedPlan({ generatedPlan, appContext, stories = [], domainInfo = "", warnings: seedWarnings = [], normalizationOptions = {} }) {
  const warnings = [...seedWarnings];
  const draft = generatedPlan && typeof generatedPlan === "object" ? generatedPlan : {};
  const moduleName = trimToString(appContext.moduleName) || "MyFirstModule";

  const normalizedDomainModel = normalizeDomainModel(draft.domainModel, warnings, normalizationOptions);
  const normalizedPages = normalizePages(draft.pages, moduleName, warnings);

  const app = {
    appId: trimToString(appContext.appId),
    branch: trimToString(appContext.branch) || "main",
    moduleName,
    layoutQualifiedName: trimToString(appContext.layoutQualifiedName) || DEFAULT_LAYOUT_QNAME,
    homePageRef: trimToString(appContext.homePageRef) || "home"
  };
  const navigationFromDraft = draft.app && draft.app.navigation && typeof draft.app.navigation === "object"
    ? draft.app.navigation
    : null;
  const navigationFromContext = appContext.navigation && typeof appContext.navigation === "object"
    ? appContext.navigation
    : null;
  if (navigationFromDraft || navigationFromContext) {
    app.navigation = {
      ...(navigationFromContext || {}),
      ...(navigationFromDraft || {})
    };
  }

  if (!normalizedPages.specs.some((spec) => spec.ref === app.homePageRef)) {
    app.homePageRef = normalizedPages.specs[0].ref;
    warnings.push(`Configured homePageRef was not found; switched to \"${app.homePageRef}\".`);
  }

  const plan = {
    meta: {
      planVersion: PLAN_GENERATOR_VERSION,
      generatedAt: new Date().toISOString(),
      generatedBy: "pipeline.plan-generator"
    },
    app,
    execution: buildExecutionSection(appContext),
    domainModel: normalizedDomainModel,
    security: synthesizeSecuritySection({
      generatedPlan: draft,
      appContext,
      stories,
      domainInfo,
      warnings
    }),
    pages: normalizedPages,
    verification: {
      failOnMissing: true
    }
  };

  const normalizedMicroflows = cloneSpecSection(draft.microflows);
  if (normalizedMicroflows) {
    sanitizeGeneratedFlowSection(normalizedMicroflows, "microflow", warnings);
    normalizedMicroflows.specs = ensureUniqueSpecNames(normalizedMicroflows.specs || [], "microflow", warnings);
    plan.microflows = normalizedMicroflows;
  }

  const normalizedNanoflows = cloneSpecSection(draft.nanoflows);
  if (normalizedNanoflows) {
    sanitizeGeneratedFlowSection(normalizedNanoflows, "nanoflow", warnings);
    normalizedNanoflows.specs = ensureUniqueSpecNames(normalizedNanoflows.specs || [], "nanoflow", warnings);
    plan.nanoflows = normalizedNanoflows;
  }

  const normalizedWorkflows = cloneSpecSection(draft.workflows);
  if (normalizedWorkflows) {
    normalizedWorkflows.specs = ensureUniqueSpecNames(normalizedWorkflows.specs || [], "workflow", warnings);
    plan.workflows = normalizedWorkflows;
  }

  if (draft.verification && typeof draft.verification === "object") {
    plan.verification = {
      ...plan.verification,
      ...draft.verification
    };
  }

  const flowValidationMetadata = {
    keptMicroflows: [],
    repairedMicroflows: [],
    droppedMicroflows: [],
    droppedMicroflowActions: [],
    droppedMicroflowReferences: []
  };
  if (plan.microflows) validateGeneratedFlowSectionSemantics(plan.microflows, "microflow", plan, flowValidationMetadata, warnings);
  if (plan.nanoflows) validateGeneratedFlowSectionSemantics(plan.nanoflows, "nanoflow", plan, flowValidationMetadata, warnings);
  removeDroppedFlowReferences(plan, flowValidationMetadata.droppedMicroflows.flatMap((entry) => [entry.ref, entry.name]), flowValidationMetadata, warnings);
  sanitizeSecurityRoles(plan, stories, domainInfo, warnings);
  normalizeGeneratedPlanRoleRefs(plan, warnings);
  ensureUserRoleEntities(plan, stories, warnings);
  removeModulePrefixedDuplicateEntities(plan, warnings);
  removeRoleSuffixedDuplicateEntities(plan, warnings);
  sanitizeNavigationIcons(plan, warnings);
  normalizeReferenceSetAssociationsForDropdownInputs(plan, warnings);
  reconcileDomainModelNamespaceNames(plan, warnings);
  ensureEntityCrudPages(plan, warnings);
  reconcilePageAttributeRefs(plan, warnings);
  ensureNavigationSpecAndHomeButtons(plan, warnings);

  return {
    plan,
    warnings
  };
}

function buildStoryTokenSet(stories) {
  return uniq(stories.flatMap((s) => s.tokens));
}

function entityNameTokens(entityName) {
  return uniq(tokenize(splitCamelCase(entityName).replace(/_/g, " ")));
}

function buildEvidenceProfile({ stories, visualNarratorSummary, processVisualizerSummary = null, baselinePlan }) {
  const storyTokenSet = buildStoryTokenSet(stories);
  const vnEntityKeys = new Set(
    ((visualNarratorSummary && visualNarratorSummary.classNames) || []).map((name) => toConceptKey(name)).filter(Boolean)
  );
  const vnRelationshipPairs = new Set(
    ((visualNarratorSummary && visualNarratorSummary.relationships) || [])
      .map((entry) => `${toConceptKey(entry.domain)}|${toConceptKey(entry.range)}`)
      .filter(Boolean)
  );
  const baselineEntityKeys = new Set(
    (((baselinePlan && baselinePlan.domainModel && baselinePlan.domainModel.entities) || [])).map((entry) => toConceptKey(entry.name)).filter(Boolean)
  );
  const processEntityKeys = new Set(
    ((processVisualizerSummary && processVisualizerSummary.processObjects) || []).map((entry) => toConceptKey(entry)).filter(Boolean)
  );
  const roleKeys = new Set(
    uniq([
      ...((visualNarratorSummary && visualNarratorSummary.inferredRoles) || []).map((entry) => toConceptKey(entry)),
      ...(stories || []).flatMap((story) => {
        const terms = splitRoleTerms(story.role);
        return terms.length > 0 ? [terms.join(" ")] : [];
      })
    ]).filter(Boolean)
  );

  return {
    storyTokenSet,
    vnEntityKeys,
    vnRelationshipPairs,
    processEntityKeys,
    baselineEntityKeys,
    roleKeys
  };
}

function scoreEntityRelevance(entityName, evidence) {
  if (isLikelyGeneratedArtifactEntity(entityName)) return -1;
  const storyTokenSet = evidence && Array.isArray(evidence.storyTokenSet) ? evidence.storyTokenSet : [];
  const tokens = entityNameTokens(entityName);
  const conceptKey = toConceptKey(entityName);
  if (tokens.length === 0 && !conceptKey) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (storyTokenSet.includes(token)) hits += 1;
  }
  let score = tokens.length > 0 ? hits / tokens.length : 0;
  if (evidence && evidence.vnEntityKeys && evidence.vnEntityKeys.has(conceptKey)) score += 0.8;
  if (evidence && evidence.processEntityKeys && evidence.processEntityKeys.has(conceptKey)) score += 0.5;
  if (evidence && evidence.baselineEntityKeys && evidence.baselineEntityKeys.has(conceptKey)) score += 0.5;
  if (evidence && evidence.roleKeys && evidence.roleKeys.has(conceptKey) && !isPersonLikeEntity(entityName)) score -= 0.5;
  return score;
}

function mergeAttributes(baseAttrs, llmAttrs) {
  const out = [];
  const byName = new Map();

  for (const attr of baseAttrs || []) {
    if (!attr || !attr.name) continue;
    const key = String(attr.name).toLowerCase();
    byName.set(key, { ...attr });
    out.push(byName.get(key));
  }

  for (const attr of llmAttrs || []) {
    if (!attr || !attr.name) continue;
    const key = String(attr.name).toLowerCase();
    if (byName.has(key)) {
      const existing = byName.get(key);
      if (!existing.required && attr.required) existing.required = true;
      if (existing.type === "String" && attr.type && attr.type !== "String") existing.type = attr.type;
    } else {
      const next = { ...attr };
      byName.set(key, next);
      out.push(next);
    }
  }

  return out;
}

function storyMentionsPersistedDataForEntity(stories = [], entityName = "") {
  const label = splitCamelCase(entityName);
  if (!label) return false;
  const dataEvidenceRe = /\b(attribute|address|amount|bank|capacity|count|date|description|detail|email|field|information|method|name|number|payment|phone|preference|profile|record|setting|status|type)\b/i;
  return (stories || []).some((story) => {
    if (!storyMentionsTerm(story, label)) return false;
    const text = `${story && story.want || ""} ${story && story.benefit || ""} ${story && story.raw || ""}`;
    return dataEvidenceRe.test(text);
  });
}

function entityLooksActionLike(entityName = "") {
  const tokens = splitEntityMentionTokens(entityName);
  if (tokens.length === 0) return false;
  return tokens.every((token) => ACTION_LIKE_ENTITY_TOKENS.has(token)) ||
    (tokens.length === 1 && ACTION_LIKE_ENTITY_TOKENS.has(tokens[0]));
}

function classifyWeakEntity(entity, { stories = [], evidence = null, source = "unknown", enforceFallbackOnly = true } = {}) {
  const name = trimToString(entity && entity.name);
  if (!name) return { weak: true, reason: "empty entity name" };
  const fallbackOnly = entityHasOnlyFallbackAttributes(entity);
  const concreteAttrs = concreteAttributeCount(entity);
  const persistedDataEvidence = storyMentionsPersistedDataForEntity(stories, name);
  const key = normalizeEntityToken(name);
  const roleOnly = evidence && evidence.roleKeys && evidence.roleKeys.has(key) && !persistedDataEvidence;
  const actionLike = entityLooksActionLike(name) && !persistedDataEvidence;
  const lowDataEvidence = fallbackOnly && concreteAttrs === 0 && !persistedDataEvidence;

  if (roleOnly) return { weak: true, reason: "role-only concept without persisted data evidence" };
  if (actionLike) return { weak: true, reason: "action phrase without persisted data evidence" };
  if (enforceFallbackOnly && source === "baseline" && lowDataEvidence) return { weak: true, reason: "baseline-only fallback attributes without persisted data evidence" };
  return { weak: false, reason: "" };
}

function summarizeEntityAttributes(entity) {
  return {
    name: entity && entity.name,
    attributes: (Array.isArray(entity && entity.attributes) ? entity.attributes : []).map((attr) => ({
      name: attr && attr.name,
      type: attr && attr.type,
      required: Boolean(attr && attr.required),
      fallback: isFallbackAttributeName(attr && attr.name)
    })),
    fallbackOnly: entityHasOnlyFallbackAttributes(entity),
    concreteAttributeCount: concreteAttributeCount(entity)
  };
}

function isReservedOrGenericAttributeName(rawName) {
  const key = String(rawName || "").replace(/[_\s-]+/g, "").toLowerCase();
  return key === "id" || key === "type";
}

function normalizeCoverageAttributeCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const entity = trimToString(candidate.entity || candidate.entityName || candidate.parentEntity);
  const rawName = trimToString(candidate.name || candidate.attribute || candidate.attributeName);
  const name = normalizeAttributeName(rawName, "Attribute");
  if (!entity || !name) return null;
  const evidenceStoryIds = Array.isArray(candidate.evidenceStoryIds)
    ? candidate.evidenceStoryIds.map(trimToString).filter(Boolean)
    : [];
  return {
    entity,
    attribute: {
      name,
      type: normalizeAttributeType(candidate.type, name),
      required: Boolean(candidate.required)
    },
    originalName: rawName,
    evidenceStoryIds,
    evidenceQuote: trimToString(candidate.evidenceQuote || candidate.quote || ""),
    reason: trimToString(candidate.reason || candidate.evidence)
  };
}

function normalizeCoverageEntityCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const name = trimToString(candidate.name || candidate.entity || candidate.entityName || candidate.concept);
  if (!name) return null;
  const attributes = Array.isArray(candidate.attributes)
    ? candidate.attributes
      .map((attr, index) => normalizeEntity({ name, attributes: [attr] }, index, { expandNameFallback: false }))
      .flatMap((entity) => entity && Array.isArray(entity.attributes) ? entity.attributes : [])
    : [];
  return {
    name,
    attributes,
    reason: trimToString(candidate.reason || candidate.evidence)
  };
}

function suggestAttributesForRecommendedEntity() {
  return [{ name: "Name", type: "String", required: true }];
}

function extractMissingEntityRecommendations(reviewResult, entityCoverage = {}, stories = []) {
  const recommendations = [];
  const add = (name, reason, source, storyId = "") => {
    const entityName = toPascalCase(name, "");
    if (!entityName) return;
    recommendations.push({ name: entityName, reason: trimToString(reason), source, storyId: trimToString(storyId) });
  };

  for (const candidate of Array.isArray(entityCoverage && entityCoverage.missingEntityCandidates) ? entityCoverage.missingEntityCandidates : []) {
    const normalized = normalizeCoverageEntityCandidate(candidate);
    if (normalized) add(normalized.name, normalized.reason || "Entity coverage identified missing persisted concept.", "coverage");
  }

  const warningTexts = [
    ...(Array.isArray(reviewResult && reviewResult.warnings) ? reviewResult.warnings : []),
    ...(Array.isArray(entityCoverage && entityCoverage.warnings) ? entityCoverage.warnings : [])
  ].map(String);
  for (const warning of warningTexts) {
    const quoted = [...warning.matchAll(/['"]([A-Za-z][A-Za-z0-9 _-]{1,60})['"]/g)].map((match) => match[1]);
    for (const name of quoted) {
      if (/\b(entity|domain model|story|attribute|association)\b/i.test(name)) continue;
      add(name, warning, "review_warning", (warning.match(/\bUS\d+\b/i) || [])[0] || "");
    }
    const entityFor = warning.match(/does not include an? entity for\s+([A-Za-z][A-Za-z0-9 _-]{1,60})(?:[.,]| which| that|$)/i);
    if (entityFor) add(entityFor[1], warning, "review_warning", (warning.match(/\bUS\d+\b/i) || [])[0] || "");
  }

  for (const entry of Array.isArray(entityCoverage && entityCoverage.storyCoverage) ? entityCoverage.storyCoverage : []) {
    for (const concept of Array.isArray(entry && entry.missingConcepts) ? entry.missingConcepts : []) {
      add(concept, `Entity coverage reported missing concept for story ${trimToString(entry && entry.storyId) || "<unknown>"}.`, "coverage_story", entry && entry.storyId);
    }
  }

  const seen = new Set();
  return recommendations.filter((recommendation) => {
    const key = normalizeEntityToken(recommendation.name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyReviewEntityRecommendations({ plan, reviewResult, entityCoverage, stories, warnings, metadata }) {
  const existingEntityKeys = new Set((Array.isArray(plan.domainModel && plan.domainModel.entities) ? plan.domainModel.entities : [])
    .map((entity) => normalizeEntityToken(entity && entity.name))
    .filter(Boolean));
  const recommendations = extractMissingEntityRecommendations(reviewResult, entityCoverage, stories);
  metadata.reviewRecommendedEntities = recommendations.map((recommendation) => ({
    name: recommendation.name,
    source: recommendation.source,
    reason: recommendation.reason
  }));
  metadata.reviewAppliedEntities = [];
  metadata.reviewUnappliedRecommendations = [];

  for (const recommendation of recommendations) {
    const key = normalizeEntityToken(recommendation.name);
    if (!key) continue;
    if (existingEntityKeys.has(key)) {
      metadata.reviewUnappliedRecommendations.push({
        name: recommendation.name,
        reason: "Entity already exists."
      });
      continue;
    }
    const backedStories = (stories || []).filter((story) => storyMentionsTerm(story, recommendation.name));
    if (backedStories.length === 0) {
      metadata.reviewUnappliedRecommendations.push({
        name: recommendation.name,
        reason: "No story evidence mentions the recommended persisted concept."
      });
      continue;
    }
    const attributes = suggestAttributesForRecommendedEntity(recommendation.name, backedStories);
    if (attributes.length <= 1 && !backedStories.some((story) => /\b(profile|record|manage|track|create|update|store|maintain|book|reserve|schedule)\b/i.test(`${story.want} ${story.raw}`))) {
      metadata.reviewUnappliedRecommendations.push({
        name: recommendation.name,
        reason: "No concrete story-backed attributes or lifecycle evidence."
      });
      continue;
    }
    const entity = normalizeEntity({
      name: recommendation.name,
      attributes
    }, 0, { expandNameFallback: false });
    if (!entity) continue;
    const weak = classifyWeakEntity(entity, {
      stories,
      evidence: buildEvidenceProfile({ stories, baselinePlan: { domainModel: plan.domainModel } }),
      source: "review_recommendation"
    });
    if (weak.weak) {
      metadata.reviewUnappliedRecommendations.push({ name: entity.name, reason: weak.reason });
      metadata.rejectedWeakEntities.push({ name: entity.name, reason: weak.reason });
      continue;
    }
    plan.domainModel.entities.push(entity);
    existingEntityKeys.add(key);
    metadata.reviewAppliedEntities.push({
      name: entity.name,
      attributes: entity.attributes.map((attr) => attr.name),
      source: recommendation.source,
      reason: recommendation.reason || "Review recommendation identified missing persisted concept."
    });
    warnings.push(`Domain review applied missing entity recommendation "${entity.name}".`);
  }
}

function repairEntityAttributes(entity, allEntityNames, warnings, metadata) {
  if (!entity || !Array.isArray(entity.attributes)) return;
  const entityName = trimToString(entity.name);
  const entityNameKeys = new Set((allEntityNames || [])
    .filter((name) => normalizeEntityToken(name) !== normalizeEntityToken(entityName))
    .map((name) => normalizeEntityToken(name)));
  const removed = [];
  entity.attributes = entity.attributes.filter((attr) => {
    const attrName = trimToString(attr && attr.name);
    if (!attrName) return false;
    if (/^id$/i.test(attrName)) {
      removed.push({ name: attrName, reason: "reserved generic Id attribute" });
      return false;
    }
    if (/^type$/i.test(attrName)) {
      removed.push({ name: attrName, reason: "generic Type attribute requires a specific name or enum" });
      return false;
    }
    if (entityNameKeys.has(normalizeEntityToken(attrName)) && String(attr.type || "String") === "String") {
      removed.push({ name: attrName, reason: "entity reference modeled as String attribute" });
      return false;
    }
    return true;
  });
  if (entity.attributes.length === 0) {
    entity.attributes.push({ name: "Name", type: "String", required: true });
  }
  const seen = new Set();
  entity.attributes = entity.attributes
    .map((attr, index) => {
      if (!attr || typeof attr !== "object") return null;
      const oldName = trimToString(attr.name);
      const name = normalizeAttributeName(oldName, `Attribute${index + 1}`);
      if (!name) return null;
      if (oldName && oldName !== name) {
        removed.push({ name: oldName, replacement: name, reason: "invalid Mendix attribute identifier" });
      }
      const key = name.toLowerCase();
      if (seen.has(key)) {
        removed.push({ name, reason: "duplicate attribute after normalization" });
        return null;
      }
      seen.add(key);
      return {
        ...attr,
        name,
        type: normalizeAttributeType(attr.type, name)
      };
    })
    .filter(Boolean);
  if (entity.attributes.length === 0) {
    entity.attributes.push({ name: "Name", type: "String", required: true });
  }
  if (removed.length > 0) {
    metadata.repairedAttributeEntities.push({
      name: entityName,
      removedAttributes: removed,
      reason: "Removed reserved/generic or relationship-like attributes."
    });
    warnings.push(`Domain review repaired reserved/generic attributes for entity "${entityName}".`);
  }
}

function normalizeEvidenceBackedAttributeCandidate(rawAttr, index) {
  if (!rawAttr || typeof rawAttr !== "object") return null;
  const originalName = trimToString(rawAttr.name || rawAttr.attribute || rawAttr.attributeName);
  const name = normalizeAttributeName(originalName, `Attribute${index + 1}`);
  if (!name) return null;
  const attr = {
    name,
    type: normalizeAttributeType(rawAttr.type, name),
    required: Boolean(rawAttr.required)
  };
  if (rawAttr.defaultValue !== undefined) attr.defaultValue = rawAttr.defaultValue;
  return {
    attribute: attr,
    originalName,
    evidenceStoryIds: Array.isArray(rawAttr.evidenceStoryIds)
      ? rawAttr.evidenceStoryIds.map(trimToString).filter(Boolean)
      : [],
    evidenceQuote: trimToString(rawAttr.evidenceQuote || rawAttr.quote || ""),
    reason: trimToString(rawAttr.reason || rawAttr.evidence || "")
  };
}

function attributeHasStoryEvidence(normalizedAttr, storyIds) {
  if (!normalizedAttr || !storyIds || storyIds.size === 0) return false;
  if (!Array.isArray(normalizedAttr.evidenceStoryIds) || normalizedAttr.evidenceStoryIds.length === 0) return false;
  if (!normalizedAttr.evidenceStoryIds.some((storyId) => storyIds.has(storyId))) return false;
  return Boolean(normalizedAttr.evidenceQuote);
}

function applyCoverageEntityCandidates({ plan, entityCoverage = {}, stories = [], warnings = [] }) {
  const metadata = {
    addedEntityCandidates: [],
    rejectedWeakEntities: [],
    coverageAppliedEntities: [],
    coverageAppliedAttributes: [],
    coverageRejectedAttributes: []
  };
  if (!plan || !plan.domainModel) return metadata;
  if (!Array.isArray(plan.domainModel.entities)) plan.domainModel.entities = [];
  const existingEntityKeys = new Set(plan.domainModel.entities
    .map((entity) => normalizeEntityToken(entity && entity.name))
    .filter(Boolean));

  for (const candidate of Array.isArray(entityCoverage && entityCoverage.missingEntityCandidates) ? entityCoverage.missingEntityCandidates : []) {
    const normalizedCandidate = normalizeCoverageEntityCandidate(candidate);
    if (!normalizedCandidate) continue;
    const key = normalizeEntityToken(normalizedCandidate.name);
    if (!key || existingEntityKeys.has(key)) continue;
    const candidateEntity = normalizeEntity({
      name: normalizedCandidate.name,
      attributes: normalizedCandidate.attributes.length > 0
        ? normalizedCandidate.attributes
        : [{ name: "Name", type: "String", required: true }]
    }, 0, { expandNameFallback: false });
    const weak = classifyWeakEntity(candidateEntity, {
      stories,
      evidence: buildEvidenceProfile({ stories, baselinePlan: { domainModel: plan.domainModel } }),
      source: "coverage"
    });
    if (weak.weak) {
      metadata.rejectedWeakEntities.push({ name: candidateEntity.name, reason: weak.reason });
      continue;
    }
    plan.domainModel.entities.push(candidateEntity);
    existingEntityKeys.add(key);
    const addedEntity = {
      name: candidateEntity.name,
      attributes: candidateEntity.attributes.map((attr) => attr.name),
      reason: normalizedCandidate.reason || "Entity coverage audit identified missing persisted concept."
    };
    metadata.addedEntityCandidates.push(addedEntity);
    metadata.coverageAppliedEntities.push(addedEntity);
    warnings.push(`Entity coverage added missing entity candidate "${candidateEntity.name}".`);
  }

  const storyIds = new Set((stories || []).map((story) => trimToString(story && story.id)).filter(Boolean));
  const entityByKey = new Map(plan.domainModel.entities
    .map((entity) => [normalizeEntityToken(entity && entity.name), entity])
    .filter(([key]) => Boolean(key)));
  for (const candidate of Array.isArray(entityCoverage && entityCoverage.missingAttributeCandidates) ? entityCoverage.missingAttributeCandidates : []) {
    const normalizedCandidate = normalizeCoverageAttributeCandidate(candidate);
    if (!normalizedCandidate) continue;
    const entity = entityByKey.get(normalizeEntityToken(normalizedCandidate.entity));
    const attr = normalizedCandidate.attribute;
    const reject = (reason) => {
      metadata.coverageRejectedAttributes.push({
        entity: normalizedCandidate.entity,
        attribute: attr && attr.name,
        reason,
        evidenceStoryIds: normalizedCandidate.evidenceStoryIds,
        evidenceQuote: normalizedCandidate.evidenceQuote
      });
    };
    if (!entity) {
      reject("target entity missing");
      continue;
    }
    if (isReservedOrGenericAttributeName(attr.name)) {
      reject("reserved or generic attribute name");
      continue;
    }
    if (!attributeHasStoryEvidence(normalizedCandidate, storyIds)) {
      reject("missing story-backed evidence");
      continue;
    }
    if (entity.attributes.some((existing) => normalizeEntityToken(existing && existing.name) === normalizeEntityToken(attr.name))) {
      reject("attribute already exists");
      continue;
    }
    if (!Array.isArray(entity.attributes)) entity.attributes = [];
    entity.attributes.push(attr);
    metadata.coverageAppliedAttributes.push({
      entity: entity.name,
      attribute: attr.name,
      evidenceStoryIds: normalizedCandidate.evidenceStoryIds,
      evidenceQuote: normalizedCandidate.evidenceQuote,
      reason: normalizedCandidate.reason || "Entity coverage audit identified missing story-backed attribute."
    });
    warnings.push(`Entity coverage added story-backed attribute "${attr.name}" to entity "${entity.name}".`);
  }

  return metadata;
}

function mergeEntityPassDomainModels(baseDomainModel, llmDomainModel, evidence, stories, warnings) {
  const metadata = {
    keptEntityCount: 0,
    baselineOnlyEntityCount: 0,
    fallbackAttributeEntityCount: 0,
    repairedAttributeEntities: [],
    rejectedAttributeCandidates: [],
    rejectedWeakEntities: [],
    rawEntityAttributeSummaries: (Array.isArray(llmDomainModel && llmDomainModel.entities) ? llmDomainModel.entities : []).map(summarizeEntityAttributes),
    reviewedEntityAttributeSummaries: []
  };
  const mergedEntities = [];
  const byName = new Map();
  const llmKeys = new Set();

  for (const entity of (Array.isArray(llmDomainModel && llmDomainModel.entities) ? llmDomainModel.entities : [])) {
    if (!entity || !entity.name) continue;
    const key = normalizeEntityToken(entity.name);
    if (!key || llmKeys.has(key)) continue;
    llmKeys.add(key);
    const relevance = scoreEntityRelevance(entity.name, evidence);
    const weak = classifyWeakEntity(entity, { stories, evidence, source: "llm" });
    if (relevance < 0.34 && weak.weak) {
      metadata.rejectedWeakEntities.push({ name: entity.name, reason: weak.reason || "low relevance entity" });
      warnings.push(`Entity pass rejected weak entity "${entity.name}": ${weak.reason || "low relevance entity"}.`);
      continue;
    }
    const clone = { ...entity, attributes: (entity.attributes || []).map((a) => ({ ...a })) };
    byName.set(key, clone);
    mergedEntities.push(clone);
  }

  for (const entity of (Array.isArray(baseDomainModel && baseDomainModel.entities) ? baseDomainModel.entities : [])) {
    if (!entity || !entity.name) continue;
    const key = normalizeEntityToken(entity.name);
    if (!key || byName.has(key)) continue;
    if (llmKeys.size > 0) {
      metadata.rejectedWeakEntities.push({
        name: entity.name,
        reason: "baseline-only entity omitted because the Entity pass did not return it"
      });
      continue;
    }
    const weak = classifyWeakEntity(entity, { stories, evidence, source: "baseline" });
    if (weak.weak) {
      metadata.rejectedWeakEntities.push({ name: entity.name, reason: weak.reason });
      warnings.push(`Entity pass rejected baseline-only weak entity "${entity.name}": ${weak.reason}.`);
      continue;
    }
    metadata.baselineOnlyEntityCount += 1;
    const clone = { ...entity, attributes: (entity.attributes || []).map((a) => ({ ...a })) };
    byName.set(key, clone);
    mergedEntities.push(clone);
  }

  for (const entity of mergedEntities) {
    if (entityHasOnlyFallbackAttributes(entity)) metadata.fallbackAttributeEntityCount += 1;
    metadata.reviewedEntityAttributeSummaries.push(summarizeEntityAttributes(entity));
  }
  metadata.keptEntityCount = mergedEntities.length;

  const mergedEnum = dedupeByName(
    [
      ...((baseDomainModel && baseDomainModel.enumerations) || []),
      ...((llmDomainModel && llmDomainModel.enumerations) || [])
    ],
    (e) => e && e.name
  );
  const entityNames = new Set(mergedEntities.map((e) => normalizeEntityToken(e && e.name)));
  const mergedAssoc = dedupeByName(
    [
      ...((baseDomainModel && baseDomainModel.associations) || []),
      ...((llmDomainModel && llmDomainModel.associations) || [])
    ],
    (a) => a && a.name
  ).filter((assoc) => entityNames.has(normalizeEntityToken(assoc && assoc.parentEntity)) &&
    entityNames.has(normalizeEntityToken(assoc && assoc.childEntity)));

  return {
    domainModel: {
      entities: mergedEntities,
      associations: mergedAssoc,
      enumerations: mergedEnum,
      _associationDiagnostics: combineAssociationDiagnostics(baseDomainModel, llmDomainModel, mergedAssoc.length)
    },
    metadata
  };
}

function mergeDomainModels(baseDomainModel, llmDomainModel, evidence, warnings) {
  const mergedEntities = [];
  const byName = new Map();

  for (const entity of (baseDomainModel && baseDomainModel.entities) || []) {
    if (!entity || !entity.name) continue;
    const key = String(entity.name).toLowerCase();
    const clone = { ...entity, attributes: (entity.attributes || []).map((a) => ({ ...a })) };
    byName.set(key, clone);
    mergedEntities.push(clone);
  }

  for (const entity of (llmDomainModel && llmDomainModel.entities) || []) {
    if (!entity || !entity.name) continue;
    const key = String(entity.name).toLowerCase();
    const relevance = scoreEntityRelevance(entity.name, evidence);

    if (byName.has(key)) {
      const existing = byName.get(key);
      existing.attributes = mergeAttributes(existing.attributes || [], entity.attributes || []);
      continue;
    }

    if (relevance >= 0.34) {
      const clone = { ...entity, attributes: (entity.attributes || []).map((a) => ({ ...a })) };
      byName.set(key, clone);
      mergedEntities.push(clone);
    } else {
      warnings.push(`Dropped low-relevance LLM entity \"${entity.name}\".`);
    }
  }

  const mergedEnum = dedupeByName(
    [
      ...((baseDomainModel && baseDomainModel.enumerations) || []),
      ...((llmDomainModel && llmDomainModel.enumerations) || [])
    ],
    (e) => e && e.name
  );

  const mergedAssoc = dedupeByName(
    [
      ...((baseDomainModel && baseDomainModel.associations) || []),
      ...((llmDomainModel && llmDomainModel.associations) || [])
    ],
    (a) => a && a.name
  );

  const entityNames = new Set(mergedEntities.map((e) => String(e.name || "").toLowerCase()));
  const filteredAssoc = mergedAssoc.filter((assoc) => {
    const parent = String((assoc && (assoc.parentEntity || assoc.from)) || "").split(".").pop().toLowerCase();
    const child = String((assoc && (assoc.childEntity || assoc.to)) || "").split(".").pop().toLowerCase();
    const ok = entityNames.has(parent) && entityNames.has(child);
    if (!ok) {
      warnings.push(`Dropped association \"${assoc && assoc.name ? assoc.name : "<unnamed>"}\" due to missing merged entities.`);
    }
    return ok;
  });

  return {
    entities: mergedEntities,
    associations: filteredAssoc,
    enumerations: mergedEnum,
    _associationDiagnostics: combineAssociationDiagnostics(baseDomainModel, llmDomainModel, filteredAssoc.length)
  };
}

function pageRelevance(page, storyTokenSet) {
  const tokens = tokenize(
    [
      page && page.name,
      page && page.title,
      page && page.entityRef,
      ...(Array.isArray(page && page.content)
        ? page.content.map((s) => (s && (s.text || s.caption || s.type)) || "")
        : [])
    ]
      .filter(Boolean)
      .join(" ")
  );

  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (storyTokenSet.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

function mergePages(basePages, llmPages, evidence, warnings) {
  const storyTokenSet = evidence && Array.isArray(evidence.storyTokenSet) ? evidence.storyTokenSet : [];
  const out = [];
  const byRef = new Map();

  for (const page of (basePages && basePages.specs) || []) {
    if (!page || !page.ref) continue;
    const clone = { ...page, content: (page.content || []).map((c) => ({ ...c })) };
    out.push(clone);
    byRef.set(String(clone.ref).toLowerCase(), clone);
  }

  for (const page of (llmPages && llmPages.specs) || []) {
    if (!page || !page.ref) continue;
    const refKey = String(page.ref).toLowerCase();
    const relevance = pageRelevance(page, storyTokenSet);
    const entityName = String((page.entityRef || "").split(".").pop() || "");
    const entityBoost = entityName ? scoreEntityRelevance(entityName, evidence) : 0;

    if (byRef.has(refKey)) {
      const existing = byRef.get(refKey);
      const existingScore = pageRelevance(existing, storyTokenSet);
      const existingStepCount = flattenPageStepCount(existing.content || []);
      const incomingStepCount = flattenPageStepCount(page.content || []);

      if (relevance + entityBoost > existingScore || incomingStepCount > existingStepCount + 2) {
        byRef.set(refKey, { ...page });
        const idx = out.findIndex((p) => String(p.ref).toLowerCase() === refKey);
        if (idx >= 0) out[idx] = { ...page };
      }
      continue;
    }

    if (relevance + entityBoost >= 0.18) {
      const clone = { ...page };
      out.push(clone);
      byRef.set(refKey, clone);
    } else {
      warnings.push(`Dropped low-relevance LLM page \"${page.name || page.ref}\".`);
    }
  }

  const dedupedPages = dedupeByName(out, (p) => p.ref || p.name);
  return { specs: ensureUniqueSpecNames(dedupedPages, "page", warnings) };
}

function normalizeEntityToken(raw = "") {
  return toConceptKey(String(raw || "").split(".").pop());
}

function splitEntityMentionTokens(name) {
  return toConceptKey(splitCamelCase(name)).split(/\s+/).filter(Boolean);
}

function collectStoryBackedAssociationIntents(stories = [], entityNames = []) {
  const entityEntries = (entityNames || [])
    .map((name) => {
      const tokens = splitEntityMentionTokens(name);
      return {
        name,
        key: normalizeEntityToken(name),
        label: splitCamelCase(name).toLowerCase(),
        tokens,
        head: tokens[tokens.length - 1] || ""
      };
    })
    .filter((entry) => entry.name && entry.key)
    .sort((a, b) => b.tokens.length - a.tokens.length || a.name.localeCompare(b.name));
  const intents = [];

  function mentions(text, entity) {
    const keyPattern = entity.key.replace(/\s+/g, "\\s+");
    const labelPattern = entity.label.replace(/\s+/g, "\\s+");
    return new RegExp(`\\b(?:${keyPattern}|${labelPattern})s?\\b`, "i").test(text);
  }

  function mentionsHead(text, entity) {
    if (!entity || entity.tokens.length < 2 || !entity.head) return false;
    return new RegExp(`\\b(?:(?:that|this|the|a|an|selected|current)\\s+)?${entity.head}s?\\b`, "i").test(text);
  }

  function findMentionIn(text, mentioned) {
    return mentioned.find((entry) => mentions(text, entry)) ||
      mentioned.find((entry) => mentionsHead(text, entry)) ||
      null;
  }

  for (const story of stories || []) {
    const text = [story.want || "", story.benefit ? `so that ${story.benefit}` : ""].filter(Boolean).join(" ").toLowerCase();
    const mentioned = entityEntries.filter((entry) => mentions(text, entry));
    if (mentioned.length < 2) continue;

    const addMatch = text.match(/\b(?:add|attach|assign|choose|include|link|select|submit)\s+([a-z0-9\s]+?)\s+(?:to|for|in|into|on|with)\s+([a-z0-9\s]+?)(?:[,.]?\s+so\s+that|[,.]?$)/i);
    if (addMatch) {
      const object = findMentionIn(addMatch[1], mentioned);
      const context = findMentionIn(addMatch[2], mentioned);
      if (object && context && object.name !== context.name) {
        intents.push({
          parentEntity: context.name,
          childEntity: object.name,
          storyId: story.id,
          reason: `Story ${story.id} explicitly links ${object.name} to ${context.name}.`
        });
      }
    }

    const propertyMatch = text.match(/\b(?:set|change|edit|update|choose|select|see|view)\s+(?:the\s+)?([a-z0-9\s]+?)\s+of\s+(?:the\s+|a\s+|an\s+|my\s+)?([a-z0-9\s]+?)(?:[,.]?\s+so\s+that|[,.]?$)/i);
    if (propertyMatch) {
      const property = findMentionIn(propertyMatch[1], mentioned);
      const context = findMentionIn(propertyMatch[2], mentioned);
      if (property && context && property.name !== context.name) {
        intents.push({
          parentEntity: context.name,
          childEntity: property.name,
          storyId: story.id,
          reason: `Story ${story.id} links ${property.name} as contextual data of ${context.name}.`
        });
      }
    }
  }

  const seen = new Set();
  return intents.filter((intent) => {
    const key = `${intent.parentEntity}|${intent.childEntity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function associationMatchesIntent(assoc, intent) {
  const parent = String(assoc && assoc.parentEntity || "").split(".").pop();
  const child = String(assoc && assoc.childEntity || "").split(".").pop();
  return parent === intent.parentEntity && child === intent.childEntity;
}

function normalizeReferenceSetAssociationsForDropdownInputs(plan, warnings = []) {
  const associations = Array.isArray(plan && plan.domainModel && plan.domainModel.associations)
    ? plan.domainModel.associations
    : [];
  const normalizedRefs = new Set();

  for (const assoc of associations) {
    if (!assoc || typeof assoc !== "object") continue;
    if (String(assoc.type || "").toLowerCase() !== "referenceset") continue;

    const metadata = assoc.metadata && typeof assoc.metadata === "object" && !Array.isArray(assoc.metadata)
      ? { ...assoc.metadata }
      : {};
    metadata.relationshipType = metadata.relationshipType || "ReferenceSet";
    metadata.normalizedInputMethod = metadata.normalizedInputMethod || "dropdown";
    assoc.metadata = metadata;
    assoc.type = "Reference";

    const name = String(assoc.name || "").trim();
    if (name) normalizedRefs.add(name);
    warnings.push(
      `Normalized reference-set association "${name || "<unnamed>"}" to Reference so generated forms can use dropdown association inputs.`
    );
  }

  if (normalizedRefs.size === 0) return;

  for (const page of (plan.pages && Array.isArray(plan.pages.specs) ? plan.pages.specs : [])) {
    walkPageStepsMutable(page.content || [], (step) => {
      if (!step || typeof step !== "object") return;
      const assocRef = String(step.associationRef || step.association || "").trim();
      if (!assocRef || !normalizedRefs.has(assocRef)) return;
      if (step.type === "associationSetInput") step.type = "associationInput";
      if (step.type === "referenceSetSelector") step.type = "referenceSelector";
    });
  }
}

function applyDeterministicAssociationEvidence(plan, stories, warnings) {
  const entities = Array.isArray(plan && plan.domainModel && plan.domainModel.entities) ? plan.domainModel.entities : [];
  const entityNames = entities.map((entity) => entity && entity.name).filter(Boolean);
  const associations = Array.isArray(plan && plan.domainModel && plan.domainModel.associations)
    ? plan.domainModel.associations
    : [];
  const intents = collectStoryBackedAssociationIntents(stories, entityNames);
  const added = [];
  const repaired = [];
  const dropped = [];
  if (intents.length === 0) return { added, repaired, dropped };

  const out = associations.map((assoc) => ({ ...assoc }));
  const storyPairSupported = (left, right) => (stories || []).some((story) => {
    const text = { role: "", want: story && story.want, benefit: story && story.benefit, raw: `${story && story.want || ""} ${story && story.benefit || ""}` };
    return storyMentionsTerm(text, left) && storyMentionsTerm(text, right);
  });
  for (const intent of intents) {
    const exact = out.find((assoc) => associationMatchesIntent(assoc, intent));
    if (exact) {
      exact.type = "Reference";
      continue;
    }
    const reverse = out.find((assoc) => {
      const parent = String(assoc && assoc.parentEntity || "").split(".").pop();
      const child = String(assoc && assoc.childEntity || "").split(".").pop();
      return parent === intent.childEntity && child === intent.parentEntity;
    });
    if (reverse) {
      reverse.parentEntity = intent.parentEntity;
      reverse.childEntity = intent.childEntity;
      reverse.name = toSafeName(`${intent.parentEntity}_${intent.childEntity}`, reverse.name || "Association");
      reverse.type = "Reference";
      repaired.push({ name: reverse.name, parentEntity: intent.parentEntity, childEntity: intent.childEntity, reason: intent.reason });
      warnings.push(`Repaired association "${reverse.name}" direction from story evidence (${intent.storyId}).`);
      continue;
    }

    const next = buildAssociationSpec(intent.parentEntity, intent.childEntity, `${intent.parentEntity}_${intent.childEntity}`);
    next.type = "Reference";
    out.push(next);
    added.push({ name: next.name, parentEntity: next.parentEntity, childEntity: next.childEntity, reason: intent.reason });
    warnings.push(`Added story-backed association "${next.name}" from ${intent.parentEntity} to ${intent.childEntity}.`);
  }

  const filtered = out.filter((assoc) => {
    const parent = String(assoc && assoc.parentEntity || "").split(".").pop();
    const child = String(assoc && assoc.childEntity || "").split(".").pop();
    const conflicts = intents.some((intent) =>
      child === intent.childEntity &&
      parent !== intent.parentEntity &&
      !storyPairSupported(parent, child)
    );
    if (!conflicts) return true;
    dropped.push({ name: assoc.name, parentEntity: parent, childEntity: child, reason: "Contradicts a clearer story-backed association." });
    warnings.push(`Dropped unsupported association "${assoc.name}" because story evidence links ${child} to a different context.`);
    return false;
  });

  plan.domainModel.associations = dedupeByName(filtered, (assoc) => assoc && assoc.name);
  return { added, repaired, dropped };
}

function buildDomainModelReviewPrompt({
  stories,
  domainInfo = "",
  visualNarrator,
  processVisualizer,
  domainModel,
  associationDiagnostics = {},
  entityCoverage = {}
}) {
  return [
    "Review this generated Mendix domain model for unsupported or contradictory entities and associations.",
    "Use only the user stories, optional domain context, Visual Narrator summary, and Process Visualizer summary as evidence.",
    "Do not invent new entities. Prefer keep for core story-backed entities even when attributes are incomplete.",
    "Review entity attributes too, but do not invent new business attributes here. Story-backed missing attributes are handled by Entity Coverage.",
    "Drop/refuse attributes that are merely domain-plausible or lack story-backed evidence.",
    "Keep placeholder-only attributes for otherwise valid entities when refinement could not justify concrete story-backed fields.",
    "Drop entities that are app/UI artifacts, placeholders, role-only/security-only concepts, action phrases, generic behavior concepts, or not evidenced as persisted business data.",
    "Do not hardcode entity names. Keep actor-like names only when the stories require persisted app-specific profile/configuration data for that actor.",
    "Use the entity coverage audit as evidence for missing persisted concepts and bad attribute modeling, but still reject audit candidates that are roles/actions/UI/security-only.",
    "If an audit missingEntityCandidate is valid, return an entity verdict repair with attributes for that candidate.",
    "Do not apply audit missingAttributeCandidates unless they include story-backed evidence.",
    "For associations, keep when evidence supports the relationship, drop unsupported relationships, and repair direction only when story wording clearly states the editable context.",
    "Also review association candidates needing repair. These were emitted by the first LLM pass but had malformed endpoint fields. Return verdict repair with valid parentEntity and childEntity when the relationship is story-backed and endpoints map to kept entities.",
    "Return only JSON with arrays: entities[{name,verdict,attributes,evidence,reason}], associations[{name,verdict,parentEntity,childEntity,type,evidence,reason}], warnings[].",
    "",
    "USER STORIES",
    (stories || []).map((story) => `${story.id}: ${story.raw}`).join("\n"),
    "",
    "DOMAIN INFO",
    domainInfo ? clipText(domainInfo, 3000) : "(not provided)",
    "",
    "VISUAL NARRATOR SUMMARY",
    JSON.stringify(visualNarrator && visualNarrator.summary ? visualNarrator.summary : {}, null, 2),
    "",
    "PROCESS VISUALIZER SUMMARY",
    JSON.stringify(processVisualizer && processVisualizer.summary ? processVisualizer.summary : {}, null, 2),
    "",
    "DRAFT DOMAIN MODEL",
    JSON.stringify(domainModel || {}, null, 2),
    "",
    "ENTITY COVERAGE AUDIT",
    JSON.stringify(entityCoverage || {}, null, 2),
    "",
    "ASSOCIATION CANDIDATES NEEDING REPAIR",
    JSON.stringify((associationDiagnostics && associationDiagnostics.malformedAssociationCandidates) || [], null, 2)
  ].join("\n");
}

function buildEntityCoveragePrompt({ stories, domainInfo = "", visualNarrator, processVisualizer, domainModel }) {
  return [
    "Audit the generated Mendix domain vocabulary for story coverage. Do not create pages, security, flows, or final associations.",
    "Return JSON with storyCoverage[], missingEntityCandidates[], missingAttributeCandidates[], misclassifiedConcepts[], relationshipHints[], warnings[].",
    "storyCoverage MUST contain one entry for every user story id. Do not leave storyCoverage empty.",
    "missingEntityCandidates MUST be objects {name,attributes,reason}; never strings.",
    "Each missingEntityCandidate must include 2-6 concrete attributes unless it is a true catalog, in which case include Name and explain catalog evidence.",
    "missingAttributeCandidates MUST be objects {entity,name,type,evidenceStoryIds,evidenceQuote,reason}; never strings.",
    "relationshipHints MUST be objects {parentEntity,childEntity,reason}; never strings.",
    "Check each user story for persisted domain data that is missing or compressed into the wrong entity.",
    "Suggest missing entities only when users create, edit, book, schedule, track, audit, or report on a persisted business record.",
    "Look especially for persisted records that the current model compressed into attributes or behavior, such as bookings, subscriptions, attendance/check-ins, rooms/resources, assigned staff profiles, family membership members, fines, notifications, and session occurrences when story-backed.",
    "Suggest attributes only when they are concrete story-backed fields on an existing entity.",
    "Every missingAttributeCandidate MUST include evidenceStoryIds[] that reference actual story ids and a non-empty evidenceQuote copied or tightly paraphrased from the story.",
    "Do not suggest attributes that are merely domain-plausible, conventional, nice-to-have, or based on generic domain knowledge.",
    "Do not suggest Id attributes. Use business-specific names such as AccountNumber, MembershipNumber, ExternalReference only when story-backed.",
    "Do not suggest generic Type attributes. Use a specific name or enum concept such as MembershipType or LessonType when story-backed.",
    "Flag String attributes that are really relationships to another entity in relationshipHints, not as attributes.",
    "Do not hardcode names; base every candidate on story evidence.",
    "",
    "USER STORIES",
    (stories || []).map((story) => `${story.id}: ${story.raw}`).join("\n"),
    "",
    "DOMAIN INFO",
    domainInfo ? clipText(domainInfo, 2000) : "(not provided)",
    "",
    "VISUAL NARRATOR SUMMARY",
    JSON.stringify(visualNarrator && visualNarrator.summary ? visualNarrator.summary : {}, null, 2),
    "",
    "PROCESS VISUALIZER SUMMARY",
    JSON.stringify(processVisualizer && processVisualizer.summary ? processVisualizer.summary : {}, null, 2),
    "",
    "CURRENT DOMAIN MODEL",
    JSON.stringify(domainModel || {}, null, 2)
  ].join("\n");
}

function buildAssociationGenerationPrompt({
  stories,
  domainInfo = "",
  visualNarrator,
  processVisualizer,
  domainModel,
  existingDiagnostics = {},
  entityCoverage = {},
  deterministicAssociationHints = []
}) {
  const entities = Array.isArray(domainModel && domainModel.entities) ? domainModel.entities : [];
  const associations = Array.isArray(domainModel && domainModel.associations) ? domainModel.associations : [];
  return [
    "Generate the Mendix domain model association graph for the finalized entities.",
    "Focus only on associations. Do not create entities, attributes, pages, security, flows, workflows, or prose outside JSON.",
    "Use only the user stories, optional domain context, Visual Narrator summary, Process Visualizer summary, and finalized entity list as evidence.",
    "Return the complete final set of story-backed associations needed for the application to be usable. Do not return only additions.",
    "Every association endpoint MUST exactly match one of the finalized entity names.",
    "Each parentEntity/childEntity pair may appear at most once. If multiple verbs describe the same pair, return one association with the clearest name and put the extra verbs in reason/evidence.",
    "Before returning, check every operational entity: if it participates in a story-backed relationship, include a unique association for it; otherwise mark it standalone or attribute-only with a specific reason.",
    "Direction rule: parentEntity is the contextual, owning, editing, or containing object; childEntity is the selected, referenced, assigned, contained, or related object.",
    "Direction examples: Add Exercise to Workout => Workout -> Exercise. Assign Trainer to Lesson => Lesson -> Trainer. Customer books Lesson => Customer -> Lesson unless a Booking/Reservation entity is the contextual record.",
    "Use deterministic association hints as advisory evidence only. You may accept, reject, or reverse them when the story evidence supports a better graph.",
    "For each association, include directionReason explaining why parentEntity and childEntity are oriented that way.",
    `Aim for broad coverage: with ${entities.length} finalized entities, return around ${Math.max(0, Math.min(12, Math.ceil(entities.length * 0.7)))} unique associations when story evidence supports them.`,
    "Prefer associations for actor-to-record, booking/scheduling, membership/subscription, room/session/lesson, notification/fine, and ownership/assignment relationships when story-backed.",
    "For sports domains, pay special attention to Customer/Subscription/MembershipType, Customer/Lesson, Trainer/Lesson, Lesson/Session, Lesson/Room, Session/Time, and Notification relationships when those entities exist.",
    "Do not model enum/catalog choices as associations unless the target is a finalized entity.",
    "For each finalized entity, include entityCoverage status linked, standalone, or attribute-only. Standalone and attribute-only require a concrete reason.",
    "Return only JSON with associations[{name,parentEntity,childEntity,type,evidence,directionReason,reason}], entityCoverage[{entity,status,reason}], warnings[].",
    "",
    "USER STORIES",
    (stories || []).map((story) => `${story.id}: ${story.raw}`).join("\n"),
    "",
    "DOMAIN INFO",
    domainInfo ? clipText(domainInfo, 3000) : "(not provided)",
    "",
    "FINALIZED ENTITIES",
    JSON.stringify(entities.map((entity) => ({
      name: entity.name,
      attributes: (Array.isArray(entity.attributes) ? entity.attributes : []).map((attr) => ({
        name: attr && attr.name,
        type: attr && attr.type
      }))
    })), null, 2),
    "",
    "CURRENT ASSOCIATIONS",
    JSON.stringify(associations, null, 2),
    "",
    "EARLIER ASSOCIATION DIAGNOSTICS",
    JSON.stringify(existingDiagnostics || {}, null, 2),
    "",
    "ENTITY COVERAGE RELATIONSHIP HINTS",
    JSON.stringify((entityCoverage && entityCoverage.relationshipHints) || [], null, 2),
    "",
    "DETERMINISTIC ASSOCIATION HINTS (ADVISORY ONLY)",
    JSON.stringify(deterministicAssociationHints || [], null, 2),
    "",
    "VISUAL NARRATOR RELATIONSHIPS",
    JSON.stringify((visualNarrator && visualNarrator.summary && visualNarrator.summary.relationships) || [], null, 2),
    "",
    "PROCESS VISUALIZER SUMMARY",
    JSON.stringify(processVisualizer && processVisualizer.summary ? processVisualizer.summary : {}, null, 2)
  ].join("\n");
}

function associationEndpointPairKey(parentEntity, childEntity) {
  return [
    normalizeEntityToken(parentEntity),
    normalizeEntityToken(childEntity)
  ].join("|");
}

function collectStoryMentionedEntityPairs(stories, entityNames) {
  const pairs = [];
  const seen = new Set();
  for (const story of stories || []) {
    const mentioned = (entityNames || []).filter((name) => storyMentionsTerm(story, name));
    for (let i = 0; i < mentioned.length; i += 1) {
      for (let j = i + 1; j < mentioned.length; j += 1) {
        const left = mentioned[i];
        const right = mentioned[j];
        const key = [normalizeEntityToken(left), normalizeEntityToken(right)].sort().join("|");
        if (seen.has(`${story && story.id}|${key}`)) continue;
        seen.add(`${story && story.id}|${key}`);
        pairs.push({
          storyId: story && story.id || "",
          leftEntity: left,
          rightEntity: right,
          evidence: story && story.raw || ""
        });
      }
    }
  }
  return pairs;
}

function auditAssociationGaps({
  plan,
  stories,
  entityCoverage = {},
  deterministicAssociationHints = [],
  currentAssociations = []
}) {
  const entities = Array.isArray(plan && plan.domainModel && plan.domainModel.entities) ? plan.domainModel.entities : [];
  const entityNames = entities.map((entity) => entity && entity.name).filter(Boolean);
  const associations = Array.isArray(plan && plan.domainModel && plan.domainModel.associations)
    ? plan.domainModel.associations
    : [];
  const pairKeys = new Set(associations.map((assoc) => associationEndpointPairKey(assoc && assoc.parentEntity, assoc && assoc.childEntity)));
  const unorderedPairKeys = new Set(associations.map((assoc) => [
    normalizeEntityToken(assoc && assoc.parentEntity),
    normalizeEntityToken(assoc && assoc.childEntity)
  ].sort().join("|")));
  const linkedEntityKeys = new Set(
    associations.flatMap((assoc) => [
      normalizeEntityToken(assoc && assoc.parentEntity),
      normalizeEntityToken(assoc && assoc.childEntity)
    ]).filter(Boolean)
  );
  const items = [];
  const seen = new Set();
  const addItem = (item) => {
    const key = `${item.type}|${item.parentEntity || item.leftEntity}|${item.childEntity || item.rightEntity}|${item.storyId || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ id: `association_audit_${items.length + 1}`, ...item });
  };

  for (const entity of entities) {
    const name = entity && entity.name;
    if (!name || linkedEntityKeys.has(normalizeEntityToken(name))) continue;
    const attributeCount = Array.isArray(entity.attributes) ? entity.attributes.length : 0;
    if (attributeCount === 0 || attributeCount > 1 || !isAuxiliaryEntity(name)) {
      addItem({
        type: "unlinked_operational_entity",
        entity: name,
        reason: "Finalized entity is not referenced by any accepted association."
      });
    }
  }

  for (const pair of collectStoryMentionedEntityPairs(stories, entityNames)) {
    const unordered = [normalizeEntityToken(pair.leftEntity), normalizeEntityToken(pair.rightEntity)].sort().join("|");
    if (unorderedPairKeys.has(unordered)) continue;
    addItem({
      type: "co_mentioned_story_entities",
      leftEntity: pair.leftEntity,
      rightEntity: pair.rightEntity,
      storyId: pair.storyId,
      evidence: pair.evidence,
      reason: "Two finalized entities co-occur in a story but the final graph has no association between them."
    });
  }

  for (const hint of [
    ...((entityCoverage && entityCoverage.relationshipHints) || []),
    ...(deterministicAssociationHints || [])
  ]) {
    const parentEntity = hint && hint.parentEntity;
    const childEntity = hint && hint.childEntity;
    if (!parentEntity || !childEntity) continue;
    const forward = associationEndpointPairKey(parentEntity, childEntity);
    const reverse = associationEndpointPairKey(childEntity, parentEntity);
    if (!pairKeys.has(forward) && pairKeys.has(reverse)) {
      addItem({
        type: "suspicious_reversed_relationship_hint",
        parentEntity,
        childEntity,
        storyId: hint.storyId || "",
        evidence: hint.evidence || hint.reason || "",
        reason: hint.reason || "Relationship hint is represented only in reverse direction."
      });
      continue;
    }
    const unordered = [normalizeEntityToken(parentEntity), normalizeEntityToken(childEntity)].sort().join("|");
    if (unorderedPairKeys.has(unordered)) continue;
    addItem({
      type: "unrepresented_relationship_hint",
      parentEntity,
      childEntity,
      storyId: hint.storyId || "",
      evidence: hint.evidence || hint.reason || "",
      reason: hint.reason || "Relationship hint is not represented in the final graph."
    });
  }

  for (const assoc of currentAssociations || []) {
    const parent = assoc && assoc.parentEntity;
    const child = assoc && assoc.childEntity;
    if (!parent || !child) continue;
    const forward = associationEndpointPairKey(parent, child);
    const reverse = associationEndpointPairKey(child, parent);
    if (pairKeys.has(forward) || !pairKeys.has(reverse)) continue;
    addItem({
      type: "suspicious_reversed_current_association",
      parentEntity: parent,
      childEntity: child,
      reason: "A previously reviewed association appears only in reverse direction in the LLM graph."
    });
  }

  return {
    itemCount: items.length,
    items
  };
}

function buildAssociationRepairPrompt({
  stories,
  domainInfo = "",
  visualNarrator,
  processVisualizer,
  domainModel,
  deterministicAssociationHints = [],
  gapAudit = {}
}) {
  return [
    "Repair and adjudicate the Mendix domain model association graph.",
    "Return the complete final association graph, not a patch.",
    "Use the gap audit as questions to decide. Do not blindly add every audit item.",
    "For each audit item, decide add, reverse, keep, reject, attribute-only, or standalone in auditDecisions.",
    "Direction rule: parentEntity is the contextual, owning, editing, or containing object; childEntity is the selected, referenced, assigned, contained, or related object.",
    "Return only JSON with associations[{name,parentEntity,childEntity,type,evidence,directionReason,reason}], entityCoverage[{entity,status,reason}], auditDecisions[{auditId,decision,reason}], warnings[].",
    "",
    "USER STORIES",
    (stories || []).map((story) => `${story.id}: ${story.raw}`).join("\n"),
    "",
    "DOMAIN INFO",
    domainInfo ? clipText(domainInfo, 3000) : "(not provided)",
    "",
    "CURRENT FINALIZED DOMAIN MODEL",
    JSON.stringify(domainModel || {}, null, 2),
    "",
    "GAP AUDIT ITEMS",
    JSON.stringify((gapAudit && gapAudit.items) || [], null, 2),
    "",
    "DETERMINISTIC ASSOCIATION HINTS (ADVISORY ONLY)",
    JSON.stringify(deterministicAssociationHints || [], null, 2),
    "",
    "VISUAL NARRATOR RELATIONSHIPS",
    JSON.stringify((visualNarrator && visualNarrator.summary && visualNarrator.summary.relationships) || [], null, 2),
    "",
    "PROCESS VISUALIZER SUMMARY",
    JSON.stringify(processVisualizer && processVisualizer.summary ? processVisualizer.summary : {}, null, 2)
  ].join("\n");
}

function buildEntityGenerationPrompt({ stories, domainInfo = "", visualNarrator, processVisualizer, baselineDraft }) {
  return [
    "Generate only the Mendix domain vocabulary for this app.",
    "Return JSON with domainModel.entities[] and optional domainModel.enumerations[] only.",
    "Do not return associations, security, pages, microflows, nanoflows, workflows, navigation, or verification.",
    "Prefer business entities users create, edit, book, schedule, review, assign, report on, or audit.",
    "Avoid app/UI artifacts, generic concepts, actors as duplicate entities unless their profile data must be persisted, and entities with only placeholder names.",
    "Give operational entities concrete story-backed attributes. Do not use generic fallback attributes like Title, Description, Status, CreatedAt unless each is directly supported by stories.",
    "If an entity is only a role/security user, action phrase, screen, workflow, or process step, omit it from domainModel.entities.",
    "Catalog or association-only entities are allowed only when story-backed; keep attributes minimal and specific. Boolean attributes may omit defaultValue; the builder defaults them to false.",
    "",
    "USER STORIES",
    (stories || []).map((story) => `${story.id}: ${story.raw}`).join("\n"),
    "",
    "DOMAIN INFO",
    domainInfo ? clipText(domainInfo, 3000) : "(not provided)",
    "",
    "VISUAL NARRATOR SUMMARY",
    JSON.stringify(visualNarrator && visualNarrator.summary ? visualNarrator.summary : {}, null, 2),
    "",
    "PROCESS VISUALIZER SUMMARY",
    JSON.stringify(processVisualizer && processVisualizer.summary ? processVisualizer.summary : {}, null, 2),
    "",
    "BASELINE ENTITY CANDIDATES",
    JSON.stringify((baselineDraft && baselineDraft.domainModel) || {}, null, 2)
  ].join("\n");
}

function buildSecurityGenerationPrompt({ stories, domainInfo = "", appContext, domainModel }) {
  return [
    "Generate only Mendix security for this app.",
    "Return JSON with security{enabled,securityLevel,moduleRoles,userRoles,demoUsers} only.",
    "Infer user roles from stories and domain context. Use app-specific roles. Avoid placeholder User/Role unless story-backed.",
    "Each userRole should map to at least one module role. Admin-like roles should use System.Administrator; others System.User.",
    "",
    "USER STORIES",
    (stories || []).map((story) => `${story.id}: ${story.raw}`).join("\n"),
    "",
    "DOMAIN INFO",
    domainInfo ? clipText(domainInfo, 3000) : "(not provided)",
    "",
    "APP CONTEXT",
    JSON.stringify({ moduleName: appContext && appContext.moduleName }, null, 2),
    "",
    "FINAL DOMAIN MODEL",
    JSON.stringify(domainModel || {}, null, 2)
  ].join("\n");
}

function summarizeDomainModelForSectionPrompt(domainModel = {}) {
  const entities = Array.isArray(domainModel.entities) ? domainModel.entities : [];
  const associations = Array.isArray(domainModel.associations) ? domainModel.associations : [];
  const enumerations = Array.isArray(domainModel.enumerations) ? domainModel.enumerations : [];
  return {
    entities: entities.map((entity) => ({
      name: entity && entity.name,
      attributes: Array.isArray(entity && entity.attributes)
        ? entity.attributes.map((attribute) => ({ name: attribute && attribute.name, type: attribute && attribute.type }))
        : []
    })),
    associations: associations.map((association) => ({
      name: association && association.name,
      parentEntity: association && association.parentEntity,
      childEntity: association && association.childEntity,
      type: association && association.type
    })),
    enumerations: enumerations.map((enumeration) => ({
      name: enumeration && enumeration.name,
      values: Array.isArray(enumeration && enumeration.values) ? enumeration.values : []
    }))
  };
}

function summarizeSecurityForSectionPrompt(security = {}) {
  return {
    enabled: Boolean(security.enabled),
    securityLevel: security.securityLevel,
    moduleRoles: Array.isArray(security.moduleRoles)
      ? security.moduleRoles.map((role) => ({ name: role && role.name }))
      : [],
    userRoles: Array.isArray(security.userRoles)
      ? security.userRoles.map((role) => ({
        name: role && role.name,
        moduleRoles: Array.isArray(role && role.moduleRoles) ? role.moduleRoles : []
      }))
      : []
  };
}

function buildBehaviorGenerationPrompt({ stories, domainInfo = "", domainModel, security }) {
  return [
    "Generate only Mendix behavior artifacts for this app.",
    "Return JSON with optional microflows.specs[], nanoflows.specs[], and workflows.specs[] only.",
    "Do not create entities, associations, security, pages, navigation, or verification.",
    "Use only finalized entities, associations, and roles. Do not reference missing entities or roles.",
    "Generate behavior only when stories require calculations, status changes, notifications, validations, workflow approvals, or button-triggered business logic.",
    "Keep the response compact: prefer 0-5 essential microflows/nanoflows/workflows total. CRUD, list, and edit behavior will be generated by page/domain builders.",
    "If the stories do not require explicit business behavior, return empty specs arrays.",
    `Use only these action types: ${SUPPORTED_MICROFLOW_ACTION_TYPES.join(", ")}.`,
    "Every action must be buildable from earlier actions or declared parameters in the same flow.",
    "Do not use prose-only actions, relationship strings, unsupported parameterMappings, or references to missing entities, attributes, roles, microflows, or nanoflows.",
    "Use retrieveList/retrieveObject/createObject before aggregateList/changeObject/commitObject when an object or list variable is needed.",
    "Workflow handler microflows must use a single context parameter that matches the workflow context entity.",
    "",
    "USER STORIES",
    (stories || []).map((story) => `${story.id}: ${story.raw}`).join("\n"),
    "",
    "DOMAIN INFO",
    domainInfo ? clipText(domainInfo, 1200) : "(not provided)",
    "",
    "FINAL DOMAIN MODEL SUMMARY",
    JSON.stringify(summarizeDomainModelForSectionPrompt(domainModel), null, 2),
    "",
    "FINAL SECURITY SUMMARY",
    JSON.stringify(summarizeSecurityForSectionPrompt(security), null, 2)
  ].join("\n");
}

function buildPageGenerationPrompt({ stories, domainInfo = "", appContext, domainModel, security, microflows, nanoflows, workflows }) {
  return [
    "Generate only Mendix pages and app navigation for this app.",
    "Return JSON with pages.specs[] and optional app.navigation only.",
    "Do not create or modify domain model, security, microflows, nanoflows, workflows, or verification.",
    "Generate pages after the finalized associations exist. Use associationInput or associationSetInput for editable relationships where appropriate.",
    "Use only finalized entity, association, role, microflow, nanoflow, and workflow refs.",
    "Include a usable home page plus overview/detail or new-edit pages for core entities.",
    "",
    "USER STORIES",
    (stories || []).map((story) => `${story.id}: ${story.raw}`).join("\n"),
    "",
    "DOMAIN INFO",
    domainInfo ? clipText(domainInfo, 3000) : "(not provided)",
    "",
    "APP CONTEXT",
    JSON.stringify({ moduleName: appContext && appContext.moduleName, homePageRef: appContext && appContext.homePageRef }, null, 2),
    "",
    "FINAL DOMAIN MODEL",
    JSON.stringify(domainModel || {}, null, 2),
    "",
    "FINAL SECURITY",
    JSON.stringify(security || {}, null, 2),
    "",
    "BEHAVIOR ARTIFACTS",
    JSON.stringify({ microflows, nanoflows, workflows }, null, 2)
  ].join("\n");
}

function prunePagesForDroppedEntities(plan, droppedEntityNames, warnings) {
  const dropped = new Set((droppedEntityNames || []).map((name) => normalizeEntityToken(name)).filter(Boolean));
  if (dropped.size === 0 || !plan.pages || !Array.isArray(plan.pages.specs)) return [];

  const removedRefs = [];
  plan.pages.specs = plan.pages.specs.filter((page) => {
    const entityKey = normalizeEntityToken(page && page.entityRef);
    if (!entityKey || !dropped.has(entityKey)) return true;
    const ref = String(page.ref || "").trim();
    if (ref) removedRefs.push(ref);
    warnings.push(`Removed page "${ref || page.name || "<unnamed>"}" for dropped entity "${String(page.entityRef || "").split(".").pop()}".`);
    return false;
  });

  if (removedRefs.length > 0 && plan.app && plan.app.navigation) {
    const removed = new Set(removedRefs);
    const nav = normalizeNavigationConfig(plan.app.navigation);
    nav.homePageButtons = (nav.homePageButtons || []).filter((entry) => !removed.has(entry.pageRef));
    nav.menuItems = (nav.menuItems || []).filter((entry) => !removed.has(entry.pageRef));
    nav.homePageButtonRefs = nav.homePageButtons.map((entry) => entry.pageRef);
    nav.navigationItemRefs = nav.menuItems.map((entry) => entry.pageRef);
    plan.app.navigation = nav;
  }
  if (removedRefs.length > 0 && plan.pages && Array.isArray(plan.pages.specs)) {
    const removed = new Set(removedRefs);
    for (const page of plan.pages.specs) {
      walkPageStepsMutable(page && page.content, (step) => {
        for (const key of ["targetPageRef", "pageRef", "rowClickTargetPageRef"]) {
          if (removed.has(String(step && step[key] || ""))) {
            step[key] = "";
          }
        }
      });
      if (Array.isArray(page && page.content)) {
        page.content = page.content.filter((step) => !(step && step.type === "buttonToPage" && !step.targetPageRef));
      }
    }
  }

  return removedRefs;
}

function entityHasOnlyDefaultAttributes(entity) {
  const attrs = Array.isArray(entity && entity.attributes) ? entity.attributes : [];
  if (attrs.length === 0) return true;
  const defaultNames = new Set(["name", "title", "description", "status", "createdat", "createdon"]);
  return attrs.every((attr) => defaultNames.has(String(attr && attr.name || "").toLowerCase()));
}

function findSpecificDuplicateEntity(entity, allEntities = [], stories = [], ignoredEntityKeys = new Set()) {
  const name = trimToString(entity && entity.name);
  if (!name || !entityHasOnlyDefaultAttributes(entity)) return null;
  const attrs = Array.isArray(entity && entity.attributes) ? entity.attributes : [];
  if (attrs.length <= 1) return null;
  const keyTokens = toConceptKey(splitCamelCase(name)).split(/\s+/).filter(Boolean);
  if (keyTokens.length === 0) return null;

  const candidates = (allEntities || [])
    .filter((candidate) => {
      if (!candidate || candidate === entity || !trimToString(candidate.name)) return false;
      if (isLikelyGeneratedArtifactEntity(candidate.name)) return false;
      if (findCompositeArtifactEntity(candidate, allEntities, stories)) return false;
      if (findGeneratedActionArtifactEntity(candidate, allEntities, stories)) return false;
      return !ignoredEntityKeys.has(normalizeEntityToken(candidate.name));
    })
    .map((candidate) => {
      const candidateTokens = toConceptKey(splitCamelCase(candidate.name)).split(/\s+/).filter(Boolean);
      return { entity: candidate, tokens: candidateTokens };
    })
    .filter((candidate) => candidate.tokens.length > keyTokens.length);

  for (const candidate of candidates) {
    const tokenSet = new Set(candidate.tokens);
    if (!keyTokens.every((token) => tokenSet.has(token))) continue;
    const extraTokens = candidate.tokens.filter((token) => !keyTokens.includes(token));
    if (extraTokens.length === 0 || extraTokens.every((token) => DUPLICATE_ENTITY_SPECIFICITY_STOP_WORDS.has(token))) continue;
    const exactMention = (stories || []).some((story) => storyMentionsTerm(story, splitCamelCase(candidate.entity.name)));
    if (!exactMention) continue;
    return {
      name: candidate.entity.name,
      reason: `Generic entity duplicates more specific story-backed entity "${candidate.entity.name}".`
    };
  }

  return null;
}

function applyDomainModelReview({
  plan,
  reviewResult,
  stories,
  warnings,
  entityCoverage = {},
  enforceAttributeQuality = false,
  allowDeterministicAssociationFallback = false
}) {
  const metadata = {
    enabled: true,
    status: "completed",
    droppedEntities: [],
    droppedAssociations: [],
    keptAssociations: [],
    malformedAssociationCandidates: [],
    repairedAssociationCandidates: [],
    rejectedAssociationCandidates: [],
    repairedAssociations: [],
    addedAssociations: [],
    repairedAttributeEntities: [],
    rejectedAttributeCandidates: [],
    rejectedWeakEntities: [],
    addedEntityCandidates: [],
    addedAttributeCandidates: [],
    reviewRecommendedEntities: [],
    reviewAppliedEntities: [],
    reviewUnappliedRecommendations: [],
    fallbackAttributeEntityCount: 0,
    reviewedEntityAttributeSummaries: [],
    warnings: []
  };
  if (!plan.domainModel) return metadata;
  const associationDiagnostics = plan.domainModel._associationDiagnostics &&
    typeof plan.domainModel._associationDiagnostics === "object" &&
    !Array.isArray(plan.domainModel._associationDiagnostics)
    ? plan.domainModel._associationDiagnostics
    : {};
  metadata.malformedAssociationCandidates = Array.isArray(associationDiagnostics.malformedAssociationCandidates)
    ? associationDiagnostics.malformedAssociationCandidates.map((candidate) => cloneDiagnosticValue(candidate))
    : [];

  const entityVerdicts = new Map();
  for (const verdict of Array.isArray(reviewResult && reviewResult.entities) ? reviewResult.entities : []) {
    const key = normalizeEntityToken(verdict && verdict.name);
    if (key) entityVerdicts.set(key, verdict);
  }
  const reviewDroppedEntityKeys = new Set(
    Array.from(entityVerdicts.entries())
      .filter((entry) => entry[1] && entry[1].verdict === "drop")
      .map((entry) => entry[0])
  );

  const existingEntityKeys = new Set((Array.isArray(plan.domainModel.entities) ? plan.domainModel.entities : [])
    .map((entity) => normalizeEntityToken(entity && entity.name))
    .filter(Boolean));
  for (const candidate of Array.isArray(entityCoverage && entityCoverage.missingEntityCandidates) ? entityCoverage.missingEntityCandidates : []) {
    const normalizedCandidate = normalizeCoverageEntityCandidate(candidate);
    if (!normalizedCandidate) continue;
    const key = normalizeEntityToken(normalizedCandidate.name);
    if (!key || existingEntityKeys.has(key)) continue;
    const candidateEntity = normalizeEntity({
      name: normalizedCandidate.name,
      attributes: normalizedCandidate.attributes.length > 0
        ? normalizedCandidate.attributes
        : [{ name: "Name", type: "String", required: true }]
    }, 0, { expandNameFallback: false });
    const weak = classifyWeakEntity(candidateEntity, {
      stories,
      evidence: buildEvidenceProfile({ stories, baselinePlan: { domainModel: plan.domainModel } }),
      source: "coverage"
    });
    if (weak.weak) {
      metadata.rejectedWeakEntities.push({ name: candidateEntity.name, reason: weak.reason });
      continue;
    }
    plan.domainModel.entities.push(candidateEntity);
    existingEntityKeys.add(key);
    metadata.addedEntityCandidates.push({
      name: candidateEntity.name,
      attributes: candidateEntity.attributes.map((attr) => attr.name),
      reason: normalizedCandidate.reason || "Entity coverage audit identified missing persisted concept."
    });
    warnings.push(`Domain coverage added missing entity candidate "${candidateEntity.name}".`);
  }

  applyReviewEntityRecommendations({ plan, reviewResult, entityCoverage, stories, warnings, metadata });

  const originalEntities = Array.isArray(plan.domainModel.entities) ? plan.domainModel.entities : [];
  const storyIds = new Set((stories || []).map((story) => trimToString(story && story.id)).filter(Boolean));
  plan.domainModel.entities = originalEntities.filter((entity) => {
    const entityName = trimToString(entity && entity.name);
    const verdict = entityVerdicts.get(normalizeEntityToken(entityName));
    if (verdict && verdict.verdict === "repair" && Array.isArray(verdict.attributes)) {
      const accepted = [];
      const seenAttributeKeys = new Set();
      for (const rawAttr of verdict.attributes) {
        const normalized = normalizeEvidenceBackedAttributeCandidate(rawAttr, accepted.length);
        if (!normalized) continue;
        const attr = normalized.attribute;
        const reject = (reason) => {
          metadata.rejectedAttributeCandidates.push({
            entity: entityName,
            attribute: attr && attr.name,
            reason,
            evidenceStoryIds: normalized.evidenceStoryIds,
            evidenceQuote: normalized.evidenceQuote
          });
        };
        if (isReservedOrGenericAttributeName(attr.name)) {
          reject("reserved or generic attribute name");
          continue;
        }
        if (!attributeHasStoryEvidence(normalized, storyIds)) {
          reject("missing story-backed evidence");
          continue;
        }
        const attrKey = normalizeEntityToken(attr.name);
        if (!attrKey || seenAttributeKeys.has(attrKey)) continue;
        seenAttributeKeys.add(attrKey);
        accepted.push(attr);
      }
      if (accepted.length > 0 && !entityHasOnlyFallbackAttributes({ attributes: accepted })) {
        entity.attributes = accepted;
        metadata.repairedAttributeEntities.push({
          name: entityName,
          attributes: accepted.map((attr) => attr.name),
          reason: trimToString(verdict.reason) || "Domain review repaired weak entity attributes."
        });
        warnings.push(`Domain review repaired attributes for entity "${entityName}".`);
      }
    }
    if (!verdict || verdict.verdict !== "drop") {
      if (isLikelyGeneratedArtifactEntity(entityName)) {
        metadata.droppedEntities.push({ name: entity.name, reason: "Generic or parser-artifact entity name without domain evidence." });
        warnings.push(`Domain review dropped unsupported entity "${entity.name}": generic or parser-artifact entity name without domain evidence.`);
        return false;
      }
      const weakEntity = classifyWeakEntity(entity, {
        stories,
        evidence: buildEvidenceProfile({ stories, baselinePlan: { domainModel: plan.domainModel } }),
        source: "reviewed",
        enforceFallbackOnly: enforceAttributeQuality
      });
      if (weakEntity.weak) {
        metadata.rejectedWeakEntities.push({ name: entity.name, reason: weakEntity.reason });
        metadata.droppedEntities.push({ name: entity.name, reason: weakEntity.reason });
        warnings.push(`Domain review dropped weak entity "${entity.name}": ${weakEntity.reason}.`);
        return false;
      }
      const compositeArtifact = findCompositeArtifactEntity(entity, originalEntities, stories);
      if (compositeArtifact) {
        metadata.droppedEntities.push({ name: entity.name, reason: compositeArtifact.reason });
        warnings.push(`Domain review dropped unsupported entity "${entity.name}": ${compositeArtifact.reason}`);
        return false;
      }
      const actionArtifact = findGeneratedActionArtifactEntity(entity, originalEntities, stories);
      if (actionArtifact) {
        metadata.droppedEntities.push({ name: entity.name, reason: actionArtifact.reason });
        warnings.push(`Domain review dropped unsupported entity "${entity.name}": ${actionArtifact.reason}`);
        return false;
      }
      const duplicate = findSpecificDuplicateEntity(entity, originalEntities, stories, reviewDroppedEntityKeys);
      if (duplicate) {
        metadata.droppedEntities.push({ name: entity.name, reason: duplicate.reason });
        warnings.push(`Domain review dropped duplicate generic entity "${entity.name}": ${duplicate.reason}`);
        return false;
      }
      return true;
    }
    const storyBackedCompound = splitEntityMentionTokens(entityName).length >= 2 &&
      (stories || []).some((story) => storyMentionsTerm(story, splitCamelCase(entityName))) &&
      !isLikelyGeneratedArtifactEntity(entityName) &&
      !findCompositeArtifactEntity(entity, originalEntities, stories) &&
      !findGeneratedActionArtifactEntity(entity, originalEntities, stories);
    if (storyBackedCompound) {
      const reason = trimToString(verdict.reason);
      metadata.warnings.push(`Kept story-backed entity "${entityName}" despite drop verdict${reason ? `: ${reason}` : "."}`);
      warnings.push(`Domain review kept story-backed entity "${entityName}" despite drop verdict${reason ? `: ${reason}` : "."}`);
      return true;
    }
    metadata.droppedEntities.push({ name: entity.name, reason: trimToString(verdict.reason) });
    warnings.push(`Domain review dropped unsupported entity "${entity.name}"${verdict.reason ? `: ${verdict.reason}` : "."}`);
    return false;
  });
  const allEntityNamesForAttributeRepair = plan.domainModel.entities.map((entity) => entity && entity.name).filter(Boolean);
  for (const entity of plan.domainModel.entities) {
    repairEntityAttributes(entity, allEntityNamesForAttributeRepair, warnings, metadata);
  }
  metadata.fallbackAttributeEntityCount = plan.domainModel.entities.filter(entityHasOnlyFallbackAttributes).length;
  metadata.reviewedEntityAttributeSummaries = plan.domainModel.entities.map(summarizeEntityAttributes);

  const keptEntityNames = new Set(plan.domainModel.entities.map((entity) => normalizeEntityToken(entity && entity.name)));
  const assocVerdicts = new Map();
  for (const verdict of Array.isArray(reviewResult && reviewResult.associations) ? reviewResult.associations : []) {
    const key = String(verdict && verdict.name || "").trim().toLowerCase();
    if (key) assocVerdicts.set(key, verdict);
  }

  plan.domainModel.associations = (Array.isArray(plan.domainModel.associations) ? plan.domainModel.associations : []).flatMap((assoc) => {
    const parentKey = normalizeEntityToken(assoc && assoc.parentEntity);
    const childKey = normalizeEntityToken(assoc && assoc.childEntity);
    const verdictKey = String(assoc && assoc.name || "").trim().toLowerCase();
    const verdict = assocVerdicts.get(verdictKey);
    if (!keptEntityNames.has(parentKey) || !keptEntityNames.has(childKey)) {
      metadata.droppedAssociations.push({ name: assoc.name, reason: "Association references a dropped entity." });
      warnings.push(`Domain review dropped association "${assoc.name}" because it references a dropped entity.`);
      return [];
    }
    if (verdict && verdict.verdict === "drop") {
      metadata.droppedAssociations.push({ name: assoc.name, reason: trimToString(verdict.reason) });
      warnings.push(`Domain review dropped unsupported association "${assoc.name}"${verdict.reason ? `: ${verdict.reason}` : "."}`);
      return [];
    }
    if (verdict && verdict.verdict === "repair" && verdict.parentEntity && verdict.childEntity) {
      const parentEntity = String(verdict.parentEntity).split(".").pop();
      const childEntity = String(verdict.childEntity).split(".").pop();
      if (keptEntityNames.has(normalizeEntityToken(parentEntity)) && keptEntityNames.has(normalizeEntityToken(childEntity))) {
        const repaired = {
          ...assoc,
          parentEntity,
          childEntity,
          name: toSafeName(`${parentEntity}_${childEntity}`, assoc.name || "Association")
        };
        if (verdict.type) repaired.type = verdict.type;
        metadata.repairedAssociations.push({ name: repaired.name, parentEntity, childEntity, reason: trimToString(verdict.reason) });
        warnings.push(`Domain review repaired association "${assoc.name}" to ${parentEntity} -> ${childEntity}.`);
        return [repaired];
      }
    }
    metadata.keptAssociations.push({
      name: assoc.name,
      parentEntity: assoc.parentEntity,
      childEntity: assoc.childEntity,
      reason: verdict && verdict.reason ? trimToString(verdict.reason) : "Kept normalized association."
    });
    return [assoc];
  });

  const repairedCandidateAssociations = [];
  for (const candidate of metadata.malformedAssociationCandidates) {
    const candidateName = trimToString(candidate && candidate.name);
    const verdictKey = candidateName.toLowerCase();
    const verdict = assocVerdicts.get(verdictKey);
    if (!verdict) {
      metadata.rejectedAssociationCandidates.push({
        name: candidateName || "<unnamed>",
        reason: "Domain review did not return a repair verdict for this malformed association candidate."
      });
      continue;
    }
    if (verdict.verdict === "drop") {
      metadata.rejectedAssociationCandidates.push({
        name: candidateName || trimToString(verdict.name) || "<unnamed>",
        reason: trimToString(verdict.reason) || "Domain review rejected malformed association candidate."
      });
      continue;
    }
    if (verdict.verdict !== "repair" && verdict.verdict !== "keep") {
      metadata.rejectedAssociationCandidates.push({
        name: candidateName || trimToString(verdict.name) || "<unnamed>",
        reason: `Unsupported association candidate verdict "${trimToString(verdict.verdict) || "<empty>"}".`
      });
      continue;
    }

    const parentEntity = String(verdict.parentEntity || candidate.parentEntity || "").split(".").pop();
    const childEntity = String(verdict.childEntity || candidate.childEntity || "").split(".").pop();
    if (!keptEntityNames.has(normalizeEntityToken(parentEntity)) || !keptEntityNames.has(normalizeEntityToken(childEntity))) {
      metadata.rejectedAssociationCandidates.push({
        name: candidateName || trimToString(verdict.name) || "<unnamed>",
        parentEntity,
        childEntity,
        reason: "Repaired association candidate references missing or dropped entities."
      });
      continue;
    }

    const associationType = normalizeAssociationType(verdict.type || candidate.type, {
      allowSemanticFallback: true
    });
    const repaired = {
      name: toSafeName(trimToString(verdict.name) || candidateName || `${parentEntity}_${childEntity}`, `${parentEntity}_${childEntity}`),
      parentEntity,
      childEntity,
      type: associationType.type,
      owner: "Both"
    };
    if (associationType.semanticType) {
      repaired.metadata = { relationshipType: associationType.semanticType };
    }
    repairedCandidateAssociations.push(repaired);
    metadata.repairedAssociationCandidates.push({
      name: repaired.name,
      parentEntity,
      childEntity,
      reason: trimToString(verdict.reason) || "Domain review repaired malformed association candidate."
    });
    warnings.push(`Domain review repaired malformed association candidate "${repaired.name}" to ${parentEntity} -> ${childEntity}.`);
  }

  if (repairedCandidateAssociations.length > 0) {
    plan.domainModel.associations = dedupeByName(
      [...plan.domainModel.associations, ...repairedCandidateAssociations],
      (assoc) => assoc && assoc.name
    );
  }

  metadata.droppedEntities.sort((left, right) => {
    const leftExplicit = reviewDroppedEntityKeys.has(normalizeEntityToken(left && left.name)) ? 0 : 1;
    const rightExplicit = reviewDroppedEntityKeys.has(normalizeEntityToken(right && right.name)) ? 0 : 1;
    if (leftExplicit !== rightExplicit) return leftExplicit - rightExplicit;
    return 0;
  });
  prunePagesForDroppedEntities(plan, metadata.droppedEntities.map((entry) => entry.name), warnings);
  if (allowDeterministicAssociationFallback) {
    const deterministic = applyDeterministicAssociationEvidence(plan, stories, warnings);
    metadata.addedAssociations.push(...deterministic.added);
    metadata.repairedAssociations.push(...deterministic.repaired);
    metadata.droppedAssociations.push(...deterministic.dropped);
  }
  metadata.warnings.push(...(Array.isArray(reviewResult && reviewResult.warnings) ? reviewResult.warnings.map(String) : []));
  warnings.push(...metadata.warnings.map((entry) => `Domain review warning: ${entry}`));
  return metadata;
}

async function runDomainModelReviewStage({
  plan,
  bundle,
  visualNarrator,
  processVisualizer,
  entityCoverage,
  model,
  ollamaUrl,
  fetchImpl,
  callOllamaGenerate,
  ollamaOptions,
  progress,
  warnings,
  mockOllamaResponsePath
}) {
  if (bundle && bundle.appContext && bundle.appContext.domainModelReview === false) {
    return { enabled: false, status: "skipped", droppedEntities: [], droppedAssociations: [], repairedAssociations: [], addedAssociations: [], warnings: [] };
  }

  progress("Stage 7/10: Reviewing domain model validity...");
  let reviewResult = { entities: [], associations: [], warnings: [] };
  let status = mockOllamaResponsePath ? "deterministic_only" : "completed";
  let allowDeterministicAssociationFallback = Boolean(mockOllamaResponsePath);
  if (!mockOllamaResponsePath) {
    try {
      const result = await callOllamaGenerate({
        prompt: buildDomainModelReviewPrompt({
          stories: bundle.stories,
          domainInfo: bundle.domainInfo,
          visualNarrator,
          processVisualizer,
          domainModel: plan.domainModel,
          associationDiagnostics: plan.domainModel && plan.domainModel._associationDiagnostics,
          entityCoverage
        }),
        model,
        ollamaUrl,
        fetchImpl,
        ollamaOptions,
        format: getDomainModelReviewSchema()
      });
      reviewResult = result.generatedPlan || reviewResult;
    } catch (err) {
      status = "llm_unavailable";
      allowDeterministicAssociationFallback = true;
      warnings.push(`Domain model review LLM pass failed; applied deterministic story-evidence review only: ${err && err.message ? err.message : String(err)}`);
    }
  }

  const metadata = applyDomainModelReview({
    plan,
    reviewResult,
    stories: bundle.stories,
    warnings,
    entityCoverage,
    enforceAttributeQuality: Boolean(entityCoverage && typeof entityCoverage === "object" && Object.keys(entityCoverage).length > 0),
    allowDeterministicAssociationFallback
  });
  metadata.status = status;
  return metadata;
}

function associationPairKey(assoc) {
  const parent = normalizeEntityToken(assoc && assoc.parentEntity);
  const child = normalizeEntityToken(assoc && assoc.childEntity);
  const type = String(assoc && assoc.type || "Reference").toLowerCase();
  return `${parent}|${child}|${type}`;
}

function applyAssociationGeneration({ plan, associationResult, warnings, replaceGraph = true }) {
  const associationSanitization = createGeneratedSanitizationDiagnostics("associations");
  const rawAssociationResult = associationResult && typeof associationResult === "object" ? associationResult : {};
  const sanitizedAssociations = sanitizeObjectArray(rawAssociationResult.associations, "associations", associationSanitization);
  const sanitizedEntityCoverage = sanitizeObjectArray(rawAssociationResult.entityCoverage, "entityCoverage", associationSanitization);
  associationSanitization.finalCount = sanitizedAssociations.length;
  associationResult = {
    ...rawAssociationResult,
    associations: sanitizedAssociations,
    entityCoverage: sanitizedEntityCoverage
  };
  if (associationSanitization.invalidItemsDropped.length > 0) {
    warnings.push(`Sanitized association generation output: dropped ${associationSanitization.invalidItemsDropped.length} invalid item(s).`);
  }
  const metadata = {
    enabled: true,
    status: "completed",
    rawAssociationCount: Array.isArray(associationResult && associationResult.associations)
      ? associationResult.associations.length
      : 0,
    acceptedAssociations: [],
    rejectedAssociations: [],
    sanitization: associationSanitization,
    entityCoverage: Array.isArray(associationResult && associationResult.entityCoverage)
      ? associationResult.entityCoverage.map((entry) => cloneDiagnosticValue(entry))
      : [],
    warnings: []
  };
  if (!plan.domainModel) return metadata;

  const keptEntityNames = new Set(
    (Array.isArray(plan.domainModel.entities) ? plan.domainModel.entities : [])
      .map((entity) => normalizeEntityToken(entity && entity.name))
      .filter(Boolean)
  );
  const existing = Array.isArray(plan.domainModel.associations) ? plan.domainModel.associations : [];
  const existingKeys = new Set(replaceGraph ? [] : existing.map(associationPairKey));
  const accepted = [];

  for (const assoc of Array.isArray(associationResult && associationResult.associations) ? associationResult.associations : []) {
    const parentEntity = String(assoc && assoc.parentEntity || "").split(".").pop();
    const childEntity = String(assoc && assoc.childEntity || "").split(".").pop();
    const name = toSafeName(trimToString(assoc && assoc.name) || `${parentEntity}_${childEntity}`, `${parentEntity}_${childEntity}`);
    if (!keptEntityNames.has(normalizeEntityToken(parentEntity)) || !keptEntityNames.has(normalizeEntityToken(childEntity))) {
      metadata.rejectedAssociations.push({
        name,
        parentEntity,
        childEntity,
        reason: "Association generation returned endpoints outside finalized entities."
      });
      continue;
    }
    if (normalizeEntityToken(parentEntity) === normalizeEntityToken(childEntity)) {
      metadata.rejectedAssociations.push({
        name,
        parentEntity,
        childEntity,
        reason: "Association generation returned a self-association; not added without explicit model support."
      });
      continue;
    }

    const associationType = normalizeAssociationType(assoc && assoc.type, {
      allowSemanticFallback: true
    });
    const next = {
      name,
      parentEntity,
      childEntity,
      type: associationType.type,
      owner: "Both"
    };
    if (associationType.semanticType) {
      next.metadata = { relationshipType: associationType.semanticType };
    }
    const key = associationPairKey(next);
    if (existingKeys.has(key)) {
      metadata.rejectedAssociations.push({
        name,
        parentEntity,
        childEntity,
        reason: "Equivalent association already exists."
      });
      continue;
    }
    existingKeys.add(key);
    accepted.push(next);
    metadata.acceptedAssociations.push({
      name,
      parentEntity,
      childEntity,
      type: next.type,
      directionReason: trimToString(assoc && assoc.directionReason),
      reason: trimToString(assoc && assoc.reason) || "Association generation accepted story-backed relationship."
    });
    warnings.push(`Association generation added "${name}" from ${parentEntity} to ${childEntity}.`);
  }

  plan.domainModel.associations = replaceGraph
    ? dedupeByName(accepted, (assoc) => assoc && assoc.name)
    : (accepted.length > 0 ? dedupeByName([...existing, ...accepted], (assoc) => assoc && assoc.name) : existing);

  const linkedEntityKeys = new Set(
    (plan.domainModel.associations || []).flatMap((assoc) => [
      normalizeEntityToken(assoc && assoc.parentEntity),
      normalizeEntityToken(assoc && assoc.childEntity)
    ]).filter(Boolean)
  );
  const coverageByEntity = new Map(
    metadata.entityCoverage
      .filter((entry) => entry && entry.entity)
      .map((entry) => [normalizeEntityToken(entry.entity), { ...entry }])
  );
  metadata.entityCoverage = (Array.isArray(plan.domainModel.entities) ? plan.domainModel.entities : []).map((entity) => {
    const name = trimToString(entity && entity.name);
    const key = normalizeEntityToken(name);
    const existingCoverage = coverageByEntity.get(key) || {};
    if (linkedEntityKeys.has(key)) {
      return {
        entity: name,
        status: "linked",
        reason: existingCoverage.status === "linked" && trimToString(existingCoverage.reason)
          ? trimToString(existingCoverage.reason)
          : "Linked by accepted association graph."
      };
    }
    return {
      entity: name,
      status: existingCoverage.status === "attribute-only" ? "attribute-only" : "standalone",
      reason: trimToString(existingCoverage.reason) || "No accepted association references this entity."
    };
  });

  const operationalEntityCount = keptEntityNames.size;
  if (operationalEntityCount >= 4 && (plan.domainModel.associations || []).length < Math.max(2, Math.floor(operationalEntityCount / 3))) {
    metadata.warnings.push(
      `Association generation returned a sparse graph: ${(plan.domainModel.associations || []).length} associations for ${operationalEntityCount} entities.`
    );
  }
  metadata.warnings.push(...(Array.isArray(associationResult && associationResult.warnings) ? associationResult.warnings.map(String) : []));
  warnings.push(...metadata.warnings.map((entry) => `Association generation warning: ${entry}`));
  return metadata;
}

async function runAssociationGenerationStage({
  plan,
  bundle,
  visualNarrator,
  processVisualizer,
  entityCoverage,
  model,
  ollamaUrl,
  fetchImpl,
  callOllamaGenerate,
  ollamaOptions,
  progress,
  warnings,
  mockOllamaResponsePath
}) {
  if (bundle && bundle.appContext && bundle.appContext.associationGeneration === false) {
    return { enabled: false, status: "skipped", rawAssociationCount: 0, acceptedAssociations: [], rejectedAssociations: [], entityCoverage: [], warnings: [] };
  }
  if (mockOllamaResponsePath) {
    return { enabled: false, status: "skipped_mock", rawAssociationCount: 0, acceptedAssociations: [], rejectedAssociations: [], entityCoverage: [], warnings: [] };
  }

  progress("Stage 7/10: Generating association graph...");
  const deterministicAssociationHints = collectDeterministicAssociationHints({
    plan,
    stories: bundle.stories,
    visualNarrator,
    processVisualizer
  });
  const currentAssociations = Array.isArray(plan && plan.domainModel && plan.domainModel.associations)
    ? plan.domainModel.associations.map((assoc) => ({ ...assoc }))
    : [];
  let associationResult = { associations: [], entityCoverage: [], warnings: [] };
  let status = "completed";
  try {
    const result = await callOllamaGenerate({
      prompt: buildAssociationGenerationPrompt({
        stories: bundle.stories,
        domainInfo: bundle.domainInfo,
        visualNarrator,
        processVisualizer,
        domainModel: plan.domainModel,
        existingDiagnostics: plan.domainModel && plan.domainModel._associationDiagnostics,
        entityCoverage,
        deterministicAssociationHints
      }),
      model,
      ollamaUrl,
      fetchImpl,
      ollamaOptions,
      format: getAssociationGenerationSchema()
    });
    associationResult = result.generatedPlan || associationResult;
  } catch (err) {
    status = "llm_unavailable";
    warnings.push(`Association generation LLM pass failed; keeping reviewed associations only: ${err && err.message ? err.message : String(err)}`);
    return {
      enabled: true,
      status,
      rawAssociationCount: 0,
      acceptedAssociations: [],
      rejectedAssociations: [],
      entityCoverage: [],
      deterministicAssociationHints,
      gapAudit: { itemCount: 0, items: [] },
      repair: { attempted: false, status: "skipped_llm_unavailable", auditDecisions: [], warnings: [] },
      warnings: []
    };
  }

  const metadata = applyAssociationGeneration({ plan, associationResult, warnings, replaceGraph: true });
  metadata.status = status;
  metadata.deterministicAssociationHints = deterministicAssociationHints;
  metadata.gapAudit = auditAssociationGaps({
    plan,
    stories: bundle.stories,
    entityCoverage,
    deterministicAssociationHints,
    currentAssociations
  });
  metadata.repair = { attempted: false, status: "skipped_no_gaps", auditDecisions: [], warnings: [] };
  if (metadata.gapAudit.itemCount > 0) {
    metadata.repair = { attempted: true, status: "completed", auditDecisions: [], warnings: [] };
    try {
      const repairResponse = await callOllamaGenerate({
        prompt: buildAssociationRepairPrompt({
          stories: bundle.stories,
          domainInfo: bundle.domainInfo,
          visualNarrator,
          processVisualizer,
          domainModel: plan.domainModel,
          deterministicAssociationHints,
          gapAudit: metadata.gapAudit
        }),
        model,
        ollamaUrl,
        fetchImpl,
        ollamaOptions,
        format: getAssociationRepairSchema()
      });
      const repairResult = repairResponse.generatedPlan || { associations: [], entityCoverage: [], auditDecisions: [], warnings: [] };
      const repairApply = applyAssociationGeneration({ plan, associationResult: repairResult, warnings, replaceGraph: true });
      metadata.acceptedAssociations = repairApply.acceptedAssociations;
      metadata.rejectedAssociations = metadata.rejectedAssociations.concat(
        repairApply.rejectedAssociations.map((entry) => ({ ...entry, phase: "repair" }))
      );
      metadata.entityCoverage = repairApply.entityCoverage;
      metadata.repair.auditDecisions = Array.isArray(repairResult.auditDecisions)
        ? repairResult.auditDecisions.map((entry) => cloneDiagnosticValue(entry))
        : [];
      metadata.repair.warnings = repairApply.warnings;
      metadata.repair.rawAssociationCount = repairApply.rawAssociationCount;
    } catch (err) {
      metadata.repair.status = "llm_unavailable";
      metadata.repair.warnings.push(`Association repair LLM pass failed; keeping first association graph: ${err && err.message ? err.message : String(err)}`);
      warnings.push(metadata.repair.warnings[metadata.repair.warnings.length - 1]);
    }
  }
  return metadata;
}

function createSectionMetadata(status, result, extra = {}) {
  const raw = result && result.ollamaRaw ? result.ollamaRaw : {};
  return {
    enabled: true,
    status,
    model: trimToString(raw.model),
    promptEvalCount: raw.prompt_eval_count || 0,
    evalCount: raw.eval_count || 0,
    totalDuration: raw.total_duration || 0,
    warnings: [],
    ...extra
  };
}

function basePlanFromBaseline({ baselinePlan, appContext }) {
  const moduleName = trimToString(appContext.moduleName) || "MyFirstModule";
  return {
    ...baselinePlan,
    app: {
      ...(baselinePlan.app || {}),
      appId: trimToString(appContext.appId),
      branch: trimToString(appContext.branch) || "main",
      moduleName,
      layoutQualifiedName: trimToString(appContext.layoutQualifiedName) || DEFAULT_LAYOUT_QNAME,
      homePageRef: trimToString(appContext.homePageRef) || "home"
    },
    execution: buildExecutionSection(appContext),
    verification: {
      ...(baselinePlan.verification || {}),
      failOnMissing: true
    }
  };
}

function applyEntityPass({ baselinePlan, entityResult, appContext, stories, domainInfo, visualNarrator, processVisualizer, warnings }) {
  const entitySanitization = createGeneratedSanitizationDiagnostics("entity");
  const rawDomainModel = entityResult && entityResult.domainModel && typeof entityResult.domainModel === "object"
    ? entityResult.domainModel
    : {};
  const sanitizedEntities = sanitizeObjectArray(rawDomainModel.entities, "domainModel.entities", entitySanitization, { requiredNameOrRef: true });
  sanitizedEntities.forEach((entity, index) => {
    entity.attributes = sanitizeObjectArray(entity.attributes, `domainModel.entities[${index}].attributes`, entitySanitization, { requiredNameOrRef: true });
  });
  const sanitizedEnumerations = sanitizeObjectArray(rawDomainModel.enumerations, "domainModel.enumerations", entitySanitization, { requiredNameOrRef: true });
  entitySanitization.finalCount = sanitizedEntities.length;
  if (entitySanitization.invalidItemsDropped.length > 0) {
    warnings.push(`Sanitized entity pass output: dropped ${entitySanitization.invalidItemsDropped.length} invalid item(s).`);
  }
  const normalized = normalizeGeneratedPlan({
    generatedPlan: {
      domainModel: {
        ...rawDomainModel,
        entities: sanitizedEntities,
        enumerations: sanitizedEnumerations
      },
      pages: { specs: [{ ref: "home", name: "Home", title: "Home", content: [{ type: "dynamicText", text: "Home" }] }] }
    },
    appContext,
    stories,
    domainInfo,
    warnings: [],
    normalizationOptions: { expandNameFallback: false }
  });
  const evidence = buildEvidenceProfile({
    stories,
    visualNarratorSummary: visualNarrator.summary,
    processVisualizerSummary: processVisualizer.summary,
    baselinePlan
  });
  const plan = basePlanFromBaseline({ baselinePlan, appContext });
  const merged = mergeEntityPassDomainModels(
    baselinePlan.domainModel || {},
    normalized.plan.domainModel || {},
    evidence,
    stories,
    warnings
  );
  plan.domainModel = merged.domainModel;
  plan.pages = baselinePlan.pages || { specs: [] };
  const keptEntityKeys = new Set((Array.isArray(plan.domainModel.entities) ? plan.domainModel.entities : [])
    .map((entity) => normalizeEntityToken(entity && entity.name))
    .filter(Boolean));
  const removedBaselineEntityNames = (Array.isArray(baselinePlan && baselinePlan.domainModel && baselinePlan.domainModel.entities)
    ? baselinePlan.domainModel.entities
    : [])
    .map((entity) => trimToString(entity && entity.name))
    .filter((name) => name && !keptEntityKeys.has(normalizeEntityToken(name)));
  prunePagesForDroppedEntities(plan, removedBaselineEntityNames, warnings);
  warnings.push(...normalized.warnings);
  return {
    plan,
    metadata: {
      rawEntityCount: Array.isArray(entityResult && entityResult.domainModel && entityResult.domainModel.entities)
        ? entityResult.domainModel.entities.length
        : 0,
      finalEntityCount: Array.isArray(plan.domainModel.entities) ? plan.domainModel.entities.length : 0,
      sanitization: entitySanitization,
      ...merged.metadata,
      warnings: Array.isArray(entityResult && entityResult.warnings) ? entityResult.warnings.map(String) : []
    }
  };
}

function applyEntityCoveragePass({ coverageResult }) {
  const result = coverageResult && typeof coverageResult === "object" ? coverageResult : {};
  return {
    rawStoryCoverageCount: Array.isArray(result.storyCoverage) ? result.storyCoverage.length : 0,
    missingEntityCandidateCount: Array.isArray(result.missingEntityCandidates) ? result.missingEntityCandidates.length : 0,
    missingAttributeCandidateCount: Array.isArray(result.missingAttributeCandidates) ? result.missingAttributeCandidates.length : 0,
    misclassifiedConceptCount: Array.isArray(result.misclassifiedConcepts) ? result.misclassifiedConcepts.length : 0,
    relationshipHintCount: Array.isArray(result.relationshipHints) ? result.relationshipHints.length : 0,
    storyCoverage: Array.isArray(result.storyCoverage) ? result.storyCoverage.map((entry) => cloneDiagnosticValue(entry)) : [],
    missingEntityCandidates: Array.isArray(result.missingEntityCandidates) ? result.missingEntityCandidates.map((entry) => cloneDiagnosticValue(entry)) : [],
    missingAttributeCandidates: Array.isArray(result.missingAttributeCandidates) ? result.missingAttributeCandidates.map((entry) => cloneDiagnosticValue(entry)) : [],
    misclassifiedConcepts: Array.isArray(result.misclassifiedConcepts) ? result.misclassifiedConcepts.map((entry) => cloneDiagnosticValue(entry)) : [],
    relationshipHints: Array.isArray(result.relationshipHints) ? result.relationshipHints.map((entry) => cloneDiagnosticValue(entry)) : [],
    warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : []
  };
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function runEntityCoverageStage({
  bundle,
  visualNarrator,
  processVisualizer,
  plan,
  model,
  ollamaUrl,
  fetchImpl,
  llmRetries,
  llmRetryDelayMs,
  callOllamaGenerate,
  ollamaOptions,
  progress
}) {
  const storyChunks = chunkArray(bundle.stories || [], 12);
  const merged = {
    storyCoverage: [],
    missingEntityCandidates: [],
    missingAttributeCandidates: [],
    misclassifiedConcepts: [],
    relationshipHints: [],
    warnings: []
  };
  const raw = {
    model: "",
    prompt_eval_count: 0,
    eval_count: 0,
    total_duration: 0
  };

  for (let index = 0; index < storyChunks.length; index += 1) {
    progress(`Stage 6/10: Entity coverage pass chunk ${index + 1}/${storyChunks.length} calling Ollama model ${model} at ${ollamaUrl}...`);
    const result = await runSectionLlmStage({
      stageName: `Stage 6/10: Entity coverage pass chunk ${index + 1}/${storyChunks.length}`,
      prompt: buildEntityCoveragePrompt({
        stories: storyChunks[index],
        domainInfo: bundle.domainInfo,
        visualNarrator,
        processVisualizer,
        domainModel: plan.domainModel
      }),
      schema: getEntityCoverageSchema(),
      model,
      ollamaUrl,
      fetchImpl,
      llmRetries,
      llmRetryDelayMs,
      callOllamaGenerate,
      ollamaOptions,
      progress: () => {}
    });
    const generated = result.generatedPlan || {};
    for (const key of ["storyCoverage", "missingEntityCandidates", "missingAttributeCandidates", "misclassifiedConcepts", "relationshipHints", "warnings"]) {
      if (Array.isArray(generated[key])) merged[key].push(...generated[key]);
    }
    const resultRaw = result.ollamaRaw || {};
    raw.model = raw.model || trimToString(resultRaw.model);
    raw.prompt_eval_count += Number(resultRaw.prompt_eval_count || 0);
    raw.eval_count += Number(resultRaw.eval_count || 0);
    raw.total_duration += Number(resultRaw.total_duration || 0);
  }

  return {
    generatedPlan: merged,
    ollamaRaw: raw,
    chunks: storyChunks.length
  };
}

function applySecurityPass({ plan, securityResult, appContext, stories, domainInfo, warnings }) {
  const rawUserRoles = Array.isArray(securityResult && securityResult.security && securityResult.security.userRoles)
    ? securityResult.security.userRoles.map((role) => trimToString(role && role.name)).filter(Boolean)
    : [];
  plan.security = synthesizeSecuritySection({
    generatedPlan: securityResult && securityResult.security ? { security: securityResult.security } : {},
    appContext,
    stories,
    domainInfo,
    warnings
  });
  const roleCleanup = sanitizeSecurityRoles(plan, stories, domainInfo, warnings);
  normalizeGeneratedPlanRoleRefs(plan, warnings);
  const roleEntityMetadata = ensureUserRoleEntities(plan, stories, warnings);
  return {
    rawUserRoles,
    rawUserRoleCount: rawUserRoles.length,
    removedSyntheticRoles: roleCleanup.removedSyntheticRoles,
    keptUserRoles: roleCleanup.keptUserRoles,
    roleEntitiesCreated: roleEntityMetadata.roleEntitiesCreated,
    finalUserRoleCount: Array.isArray(plan.security && plan.security.userRoles) ? plan.security.userRoles.length : 0,
    finalModuleRoleCount: Array.isArray(plan.security && plan.security.moduleRoles) ? plan.security.moduleRoles.length : 0,
    warnings: Array.isArray(securityResult && securityResult.warnings) ? securityResult.warnings.map(String) : []
  };
}

function applyBehaviorPass({ plan, behaviorResult, warnings }) {
  const behaviorSanitization = sanitizeGeneratedBehaviorResult(behaviorResult, warnings);
  behaviorResult = behaviorSanitization.result;
  const moduleName = trimToString(plan && plan.app && plan.app.moduleName) || "MyFirstModule";
  const entityRefs = new Set((Array.isArray(plan && plan.domainModel && plan.domainModel.entities)
    ? plan.domainModel.entities
    : [])
    .flatMap((entity) => {
      const name = trimToString(entity && entity.name);
      return name ? [name, `${moduleName}.${name}`] : [];
    }));
  const metadata = {
    rawMicroflows: Array.isArray(behaviorResult && behaviorResult.microflows && behaviorResult.microflows.specs) ? behaviorResult.microflows.specs.length : 0,
    rawNanoflows: Array.isArray(behaviorResult && behaviorResult.nanoflows && behaviorResult.nanoflows.specs) ? behaviorResult.nanoflows.specs.length : 0,
    rawWorkflows: Array.isArray(behaviorResult && behaviorResult.workflows && behaviorResult.workflows.specs) ? behaviorResult.workflows.specs.length : 0,
    finalMicroflows: 0,
    finalNanoflows: 0,
    finalWorkflows: 0,
    keptMicroflows: [],
    repairedMicroflows: [],
    droppedMicroflows: [],
    droppedMicroflowActions: [],
    droppedMicroflowReferences: [],
    rejectedWorkflows: [],
    warnings: Array.isArray(behaviorResult && behaviorResult.warnings) ? behaviorResult.warnings.map(String) : []
  };
  const normalizedMicroflows = cloneSpecSection(behaviorResult && behaviorResult.microflows);
  if (normalizedMicroflows) {
    sanitizeGeneratedFlowSection(normalizedMicroflows, "microflow", warnings);
    normalizedMicroflows.specs = ensureUniqueSpecNames(normalizedMicroflows.specs || [], "microflow", warnings);
    plan.microflows = normalizedMicroflows;
    validateGeneratedFlowSectionSemantics(plan.microflows, "microflow", plan, metadata, warnings);
    metadata.finalMicroflows = normalizedMicroflows.specs.length;
  }
  const normalizedNanoflows = cloneSpecSection(behaviorResult && behaviorResult.nanoflows);
  if (normalizedNanoflows) {
    sanitizeGeneratedFlowSection(normalizedNanoflows, "nanoflow", warnings);
    normalizedNanoflows.specs = ensureUniqueSpecNames(normalizedNanoflows.specs || [], "nanoflow", warnings);
    plan.nanoflows = normalizedNanoflows;
    validateGeneratedFlowSectionSemantics(plan.nanoflows, "nanoflow", plan, metadata, warnings);
    metadata.finalNanoflows = normalizedNanoflows.specs.length;
  }
  const droppedFlowRefs = metadata.droppedMicroflows.flatMap((entry) => [entry && entry.ref, entry && entry.name]).filter(Boolean);
  const normalizedWorkflows = cloneSpecSection(behaviorResult && behaviorResult.workflows);
  if (normalizedWorkflows) {
    normalizedWorkflows.specs = ensureUniqueSpecNames(normalizedWorkflows.specs || [], "workflow", warnings);
    normalizedWorkflows.specs = normalizedWorkflows.specs.filter((workflow) => {
      const workflowName = trimToString(workflow && (workflow.name || workflow.ref)) || "<unnamed>";
      const contextRef = trimToString(
        workflow && workflow.bindings && workflow.bindings.contextEntityRef ||
        workflow && workflow.contextEntityRef ||
        workflow && workflow.entityRef
      );
      if (!contextRef) {
        const reason = `Dropped workflow "${workflowName}" because it did not specify bindings.contextEntityRef.`;
        metadata.rejectedWorkflows.push({ name: workflowName, reason });
        warnings.push(reason);
        return false;
      }
      const normalizedContextRef = contextRef.includes(".") ? contextRef : `${moduleName}.${contextRef}`;
      const shortContextRef = normalizedContextRef.split(".").pop();
      if (!entityRefs.has(contextRef) && !entityRefs.has(normalizedContextRef) && !entityRefs.has(shortContextRef)) {
        const reason = `Dropped workflow "${workflowName}" because context entity "${contextRef}" does not exist.`;
        metadata.rejectedWorkflows.push({ name: workflowName, contextEntityRef: contextRef, reason });
        warnings.push(reason);
        return false;
      }
      workflow.bindings = { ...(workflow.bindings && typeof workflow.bindings === "object" ? workflow.bindings : {}), contextEntityRef: normalizedContextRef };
      delete workflow.contextEntityRef;
      delete workflow.entityRef;
      return true;
    });
    plan.workflows = normalizedWorkflows;
    metadata.finalWorkflows = normalizedWorkflows.specs.length;
  }
  removeDroppedFlowReferences(plan, droppedFlowRefs, metadata, warnings);
  return {
    ...metadata,
    sanitization: behaviorSanitization.diagnostics
  };
}

function applyPagePass({ plan, pageResult, appContext, stories, visualNarrator, processVisualizer, warnings }) {
  const pageSanitization = sanitizeGeneratedPagePassResult(pageResult, warnings);
  pageResult = pageSanitization.result;
  const moduleName = trimToString(appContext.moduleName) || "MyFirstModule";
  const normalizedPages = normalizePages(pageResult && pageResult.pages, moduleName, warnings);
  plan.pages = mergePages(plan.pages || { specs: [] }, normalizedPages, buildEvidenceProfile({
    stories,
    visualNarratorSummary: visualNarrator.summary,
    processVisualizerSummary: processVisualizer.summary,
    baselinePlan: plan
  }), warnings);
  const entityRefs = new Set(
    (Array.isArray(plan.domainModel && plan.domainModel.entities) ? plan.domainModel.entities : [])
      .flatMap((entity) => {
        const name = trimToString(entity && entity.name);
        return name ? [name, `${moduleName}.${name}`] : [];
      })
  );
  plan.pages.specs = (Array.isArray(plan.pages && plan.pages.specs) ? plan.pages.specs : []).filter((page) => {
    const ref = trimToString(page && page.entityRef);
    if (!ref || entityRefs.has(ref)) return true;
    warnings.push(`Dropped page "${page.ref || page.name || "<unnamed>"}" because page pass referenced missing entity "${ref}".`);
    return false;
  });
  if (pageResult && pageResult.app && pageResult.app.navigation && typeof pageResult.app.navigation === "object") {
    plan.app.navigation = {
      ...(plan.app.navigation || {}),
      ...pageResult.app.navigation
    };
  }
  return {
    rawPageCount: pageSanitization.diagnostics.rawCount,
    finalPageCount: Array.isArray(plan.pages && plan.pages.specs) ? plan.pages.specs.length : 0,
    sanitization: pageSanitization.diagnostics,
    warnings: Array.isArray(pageResult && pageResult.warnings) ? pageResult.warnings.map(String) : []
  };
}

function flattenPageStepCount(content) {
  let count = 0;
  function walk(steps) {
    for (const step of Array.isArray(steps) ? steps : []) {
      if (!step || typeof step !== "object") continue;
      count += 1;
      walk(step.content);
      walk(step.itemContent);
      walk(step.templateContent);
    }
  }
  walk(content);
  return count;
}

function walkPageStepsMutable(steps = [], visitor) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== "object") continue;
    visitor(step);
    walkPageStepsMutable(step.content, visitor);
    walkPageStepsMutable(step.itemContent, visitor);
    walkPageStepsMutable(step.templateContent, visitor);
  }
}

function buildPageAttributeContext(plan) {
  const moduleName = trimToString(plan && plan.app && plan.app.moduleName) || "MyFirstModule";
  const entityByKey = new Map();
  for (const entity of Array.isArray(plan && plan.domainModel && plan.domainModel.entities) ? plan.domainModel.entities : []) {
    const name = trimToString(entity && entity.name);
    if (!name) continue;
    entityByKey.set(normalizeEntityToken(name), entity);
    entityByKey.set(normalizeEntityToken(`${moduleName}.${name}`), entity);
  }
  return { moduleName, entityByKey };
}

function resolvePageEntity(context, rawRef) {
  const ref = trimToString(rawRef);
  if (!ref) return null;
  return context.entityByKey.get(normalizeEntityToken(ref)) ||
    context.entityByKey.get(normalizeEntityToken(ref.split(".").pop())) ||
    null;
}

function resolvePageAttribute(entity, rawRef) {
  const ref = trimToString(rawRef);
  if (!entity || !ref || !Array.isArray(entity.attributes)) return null;
  const shortRef = ref.split(".").pop();
  return entity.attributes.find((attr) => trimToString(attr && attr.name).toLowerCase() === shortRef.toLowerCase()) || null;
}

function firstPageDisplayAttribute(entity) {
  const attrs = Array.isArray(entity && entity.attributes) ? entity.attributes : [];
  return attrs.find((attr) => attr && trimToString(attr.name) && !isFallbackAttributeName(attr.name)) ||
    attrs.find((attr) => attr && trimToString(attr.name)) ||
    null;
}

function reconcilePageAttributeRefs(plan, warnings = []) {
  const diagnostics = {
    repairedPageAttributeRefs: [],
    droppedPageAttributeRefs: [],
    fallbackPageAttributeRefs: []
  };
  if (!plan || !plan.pages || !Array.isArray(plan.pages.specs)) return diagnostics;
  const context = buildPageAttributeContext(plan);

  function noteRepair(page, entity, from, to, source) {
    diagnostics.repairedPageAttributeRefs.push({ page, entity: entity && entity.name, from, to, source });
    warnings.push(`Repaired page attribute "${entity && entity.name}.${from}" to "${to}" on page "${page}".`);
  }

  function noteDrop(page, entity, attr, source) {
    diagnostics.droppedPageAttributeRefs.push({ page, entity: entity && entity.name, attribute: attr, source });
    warnings.push(`Removed stale page attribute "${entity && entity.name}.${attr}" from page "${page}".`);
  }

  function noteFallback(page, entity, attr, source) {
    diagnostics.fallbackPageAttributeRefs.push({ page, entity: entity && entity.name, attribute: attr, source });
    warnings.push(`Added fallback page attribute "${entity && entity.name}.${attr}" to page "${page}".`);
  }

  function reconcileAttrObject(obj, key, entity, pageName, source) {
    if (!obj || !entity || obj[key] === undefined) return true;
    const raw = trimToString(obj[key]);
    if (!raw) return true;
    const attr = resolvePageAttribute(entity, raw);
    if (!attr) {
      noteDrop(pageName, entity, raw, source);
      return false;
    }
    if (trimToString(attr.name) !== raw.split(".").pop()) {
      noteRepair(pageName, entity, raw, attr.name, source);
      obj[key] = attr.name;
    }
    return true;
  }

  function attributeBindingEntityForStep(step, key, fallbackEntity) {
    const stepType = trimToString(step && step.type);
    if (
      (key === "displayAttributeRef" || key === "displayAttribute") &&
      (stepType === "associationInput" || stepType === "associationSetInput" || stepType === "referenceSelector" || stepType === "referenceSetSelector")
    ) {
      return resolvePageEntity(context, step.targetEntityRef || step.targetEntity) || fallbackEntity;
    }
    return fallbackEntity;
  }

  function reconcileSteps(steps, inheritedEntity, pageName, sourcePath = "content") {
    const out = [];
    for (const step of Array.isArray(steps) ? steps : []) {
      if (!step || typeof step !== "object") continue;
      const stepEntity = resolvePageEntity(context, step.entityRef || step.entity || step.parameterEntityRef || step.contextEntityRef) || inheritedEntity;
      let keep = true;

      for (const key of ["attributeRef", "attribute", "attributeName", "displayAttributeRef", "displayAttribute"]) {
        const bindingEntity = attributeBindingEntityForStep(step, key, stepEntity);
        if (step[key] !== undefined && !reconcileAttrObject(step, key, bindingEntity, pageName, `${sourcePath}.${key}`)) {
          if (step.type === "attributeInput" || key === "attributeRef") keep = false;
          else delete step[key];
        }
      }

      if (Array.isArray(step.columns)) {
        step.columns = step.columns.filter((column, index) => {
          const key = column && column.attributeRef !== undefined ? "attributeRef" : column && column.attribute !== undefined ? "attribute" : "attributeName";
          return reconcileAttrObject(column, key, stepEntity, pageName, `${sourcePath}.columns[${index}]`);
        });
        if (step.columns.length === 0 && stepEntity) {
          const fallback = firstPageDisplayAttribute(stepEntity);
          if (fallback) {
            step.columns.push({ attributeRef: fallback.name });
            noteFallback(pageName, stepEntity, fallback.name, `${sourcePath}.columns`);
          }
        }
      }

      if (step.search && Array.isArray(step.search.fields)) {
        step.search.fields = step.search.fields.filter((field, index) => {
          const key = field && field.attributeRef !== undefined ? "attributeRef" : field && field.attribute !== undefined ? "attribute" : "attributeName";
          return reconcileAttrObject(field, key, stepEntity, pageName, `${sourcePath}.search.fields[${index}]`);
        });
      }

      if (Array.isArray(step.content)) step.content = reconcileSteps(step.content, stepEntity, pageName, `${sourcePath}.content`);
      if (Array.isArray(step.itemContent)) {
        step.itemContent = reconcileSteps(step.itemContent, stepEntity, pageName, `${sourcePath}.itemContent`);
        if ((step.type === "listView" || step.type === "dataGrid") && stepEntity && !step.itemContent.some((child) => child && child.type === "attributeInput")) {
          const fallback = firstPageDisplayAttribute(stepEntity);
          if (fallback) {
            step.itemContent.push({ type: "attributeInput", attributeRef: fallback.name, autoLabel: true });
            noteFallback(pageName, stepEntity, fallback.name, `${sourcePath}.itemContent`);
          }
        }
      }
      if (Array.isArray(step.templateContent)) {
        step.templateContent = reconcileSteps(step.templateContent, stepEntity, pageName, `${sourcePath}.templateContent`);
      }

      if (keep) out.push(step);
    }
    return out;
  }

  for (const page of plan.pages.specs) {
    if (!page || typeof page !== "object") continue;
    const pageName = trimToString(page.ref || page.name) || "<unnamed>";
    const pageEntity = resolvePageEntity(context, page.entityRef || page.parameterEntityRef || page.contextEntityRef || page.entity);
    page.content = reconcileSteps(page.content, pageEntity, pageName);
  }

  return diagnostics;
}

function dedupeDomainModelEntities(plan, warnings = []) {
  const diagnostics = { dedupedEntities: [] };
  if (!plan || !plan.domainModel || !Array.isArray(plan.domainModel.entities)) return diagnostics;
  const byKey = new Map();
  const deduped = [];
  for (const entity of plan.domainModel.entities) {
    if (!entity || typeof entity !== "object") continue;
    const key = normalizeEntityToken(entity.name);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entity);
      deduped.push(entity);
      continue;
    }
    const existingAttrs = Array.isArray(existing.attributes) ? existing.attributes : [];
    const existingAttrKeys = new Set(existingAttrs.map((attr) => normalizeEntityToken(attr && attr.name)).filter(Boolean));
    const mergedAttributes = [];
    for (const attr of Array.isArray(entity.attributes) ? entity.attributes : []) {
      const attrKey = normalizeEntityToken(attr && attr.name);
      if (!attrKey || existingAttrKeys.has(attrKey)) continue;
      existingAttrs.push({ ...attr });
      existingAttrKeys.add(attrKey);
      mergedAttributes.push(attr.name);
    }
    existing.attributes = existingAttrs;
    diagnostics.dedupedEntities.push({
      name: existing.name,
      duplicateName: entity.name,
      mergedAttributes
    });
    warnings.push(`Removed duplicate entity "${entity.name}" and merged ${mergedAttributes.length} non-duplicate attribute(s).`);
  }
  plan.domainModel.entities = deduped;
  return diagnostics;
}

function removePageRefsFromNavigation(plan, removedPageRefs) {
  const removed = new Set(Array.from(removedPageRefs || []).map((ref) => String(ref || "").trim()).filter(Boolean));
  if (removed.size === 0 || !plan || !plan.app || !plan.app.navigation || typeof plan.app.navigation !== "object") return;
  const navigation = plan.app.navigation;
  if (Array.isArray(navigation.homePageButtonRefs)) {
    navigation.homePageButtonRefs = navigation.homePageButtonRefs.filter((ref) => !removed.has(String(ref || "").trim()));
  }
  if (Array.isArray(navigation.navigationItemRefs)) {
    navigation.navigationItemRefs = navigation.navigationItemRefs.filter((ref) => !removed.has(String(ref || "").trim()));
  }
  if (Array.isArray(navigation.homePageButtons)) {
    navigation.homePageButtons = navigation.homePageButtons.filter((entry) => !removed.has(String((entry && (entry.pageRef || entry.ref)) || "").trim()));
  }
  if (Array.isArray(navigation.menuItems)) {
    navigation.menuItems = navigation.menuItems.filter((entry) => !removed.has(String((entry && (entry.pageRef || entry.ref)) || "").trim()));
  }
}

function dropPagesForEntities(plan, droppedEntityNames, warnings = []) {
  const diagnostics = { removedPages: [] };
  if (!plan || !plan.pages || !Array.isArray(plan.pages.specs)) return diagnostics;
  const droppedKeys = new Set(Array.from(droppedEntityNames || []).map((name) => normalizeEntityToken(name)).filter(Boolean));
  const droppedNameTokens = new Set(Array.from(droppedEntityNames || []).map((name) => toPascalCase(name, "").toLowerCase()).filter(Boolean));
  if (droppedKeys.size === 0) return diagnostics;
  const keptPages = [];
  const removedPageRefs = new Set();
  for (const page of plan.pages.specs) {
    if (!page || typeof page !== "object") {
      keptPages.push(page);
      continue;
    }
    const refs = [
      page.entityRef,
      page.parameterEntityRef,
      page.contextEntityRef,
      page.entity,
      ...(Array.isArray(page.pageParameters) ? page.pageParameters.map((param) => param && param.entityRef) : [])
    ];
    const pageEntityKeys = refs.map((ref) => normalizeEntityToken(ref)).filter(Boolean);
    const pageNameToken = toPascalCase(`${page.ref || ""} ${page.name || ""}`, "").toLowerCase();
    const matchesDroppedName = Array.from(droppedNameTokens).some((token) => token && pageNameToken.includes(token));
    if (!pageEntityKeys.some((key) => droppedKeys.has(key)) && !matchesDroppedName) {
      keptPages.push(page);
      continue;
    }
    const ref = trimToString(page.ref);
    if (ref) removedPageRefs.add(ref);
    diagnostics.removedPages.push({
      ref,
      name: trimToString(page.name),
      entityRef: trimToString(page.entityRef || page.parameterEntityRef || page.contextEntityRef || page.entity)
    });
  }
  plan.pages.specs = keptPages;
  removePageRefsFromNavigation(plan, removedPageRefs);
  if (diagnostics.removedPages.length > 0) {
    warnings.push(`Removed ${diagnostics.removedPages.length} page(s) bound to module-prefixed duplicate entities.`);
  }
  return diagnostics;
}

function removeModulePrefixedDuplicateEntities(plan, warnings = []) {
  const diagnostics = { removedModulePrefixedEntities: [], removedPages: [] };
  if (!plan || !plan.domainModel || !Array.isArray(plan.domainModel.entities)) return diagnostics;
  const moduleName = trimToString(plan && plan.app && plan.app.moduleName) || "MyFirstModule";
  const canonicalByKey = new Map();
  for (const entity of plan.domainModel.entities) {
    if (!entity || typeof entity !== "object") continue;
    if (modulePrefixedNameSuffix(entity.name, moduleName)) continue;
    const key = normalizeEntityToken(entity.name);
    if (key && !canonicalByKey.has(key)) canonicalByKey.set(key, entity);
  }
  for (const role of Array.isArray(plan.security && plan.security.userRoles) ? plan.security.userRoles : []) {
    const roleName = normalizeRoleNameForSecurity(role && role.name, moduleName);
    const key = normalizeEntityToken(roleName);
    if (key && !canonicalByKey.has(key)) canonicalByKey.set(key, { name: roleName, attributes: [] });
  }

  const keptEntities = [];
  const droppedNames = [];
  for (const entity of plan.domainModel.entities) {
    if (!entity || typeof entity !== "object") continue;
    const suffix = modulePrefixedNameSuffix(entity.name, moduleName);
    const suffixKey = normalizeEntityToken(suffix);
    const canonical = suffixKey ? canonicalByKey.get(suffixKey) : null;
    if (!suffix || !canonical || canonical === entity) {
      keptEntities.push(entity);
      continue;
    }

    const mergedAttributes = [];
    const canonicalAttrs = Array.isArray(canonical.attributes) ? canonical.attributes : [];
    canonical.attributes = canonicalAttrs;
    const existingAttrKeys = new Set(canonicalAttrs.map((attr) => normalizeEntityToken(attr && attr.name)).filter(Boolean));
    for (const attr of Array.isArray(entity.attributes) ? entity.attributes : []) {
      const attrKey = normalizeEntityToken(attr && attr.name);
      if (!attrKey || existingAttrKeys.has(attrKey)) continue;
      canonicalAttrs.push({ ...attr });
      existingAttrKeys.add(attrKey);
      mergedAttributes.push(attr.name);
    }

    droppedNames.push(entity.name);
    diagnostics.removedModulePrefixedEntities.push({
      name: entity.name,
      canonicalName: canonical.name,
      mergedAttributes
    });
  }

  if (droppedNames.length === 0) return diagnostics;
  plan.domainModel.entities = keptEntities;
  diagnostics.removedPages = dropPagesForEntities(plan, droppedNames, warnings).removedPages;
  warnings.push(`Removed module-prefixed duplicate entities: ${droppedNames.join(", ")}.`);
  return diagnostics;
}

function removeRoleSuffixedDuplicateEntities(plan, warnings = []) {
  const diagnostics = { removedRoleSuffixedEntities: [], removedPages: [] };
  if (!plan || !plan.domainModel || !Array.isArray(plan.domainModel.entities)) return diagnostics;
  const canonicalByKey = new Map();
  for (const entity of plan.domainModel.entities) {
    if (!entity || typeof entity !== "object") continue;
    if (roleSuffixedNameBase(entity.name)) continue;
    const key = normalizeEntityToken(entity.name);
    if (key && !canonicalByKey.has(key)) canonicalByKey.set(key, entity);
  }

  const keptEntities = [];
  const droppedNames = [];
  for (const entity of plan.domainModel.entities) {
    if (!entity || typeof entity !== "object") continue;
    const baseName = roleSuffixedNameBase(entity.name);
    const canonical = baseName ? canonicalByKey.get(normalizeEntityToken(baseName)) : null;
    if (!baseName || !canonical || canonical === entity) {
      keptEntities.push(entity);
      continue;
    }

    const mergedAttributes = [];
    const canonicalAttrs = Array.isArray(canonical.attributes) ? canonical.attributes : [];
    canonical.attributes = canonicalAttrs;
    const existingAttrKeys = new Set(canonicalAttrs.map((attr) => normalizeEntityToken(attr && attr.name)).filter(Boolean));
    for (const attr of Array.isArray(entity.attributes) ? entity.attributes : []) {
      const attrKey = normalizeEntityToken(attr && attr.name);
      if (!attrKey || existingAttrKeys.has(attrKey)) continue;
      canonicalAttrs.push({ ...attr });
      existingAttrKeys.add(attrKey);
      mergedAttributes.push(attr.name);
    }

    droppedNames.push(entity.name);
    diagnostics.removedRoleSuffixedEntities.push({
      name: entity.name,
      canonicalName: canonical.name,
      mergedAttributes
    });
  }

  if (droppedNames.length === 0) return diagnostics;
  plan.domainModel.entities = keptEntities;
  diagnostics.removedPages = dropPagesForEntities(plan, droppedNames, warnings).removedPages;
  warnings.push(`Removed role-suffixed duplicate entities: ${droppedNames.join(", ")}.`);
  return diagnostics;
}

function nextAvailableDomainModelName(baseName, suffix, occupiedNames) {
  const base = toSafeName(baseName, "DomainModelItem");
  let candidate = toSafeName(`${base}${suffix}`, `${base}${suffix}`);
  let index = 2;
  while (occupiedNames.has(candidate.toLowerCase())) {
    candidate = toSafeName(`${base}${suffix}${index}`, `${base}${suffix}${index}`);
    index += 1;
  }
  occupiedNames.add(candidate.toLowerCase());
  return candidate;
}

function updateEnumerationRefs(plan, renameMap) {
  if (!renameMap || renameMap.size === 0) return;
  for (const entity of Array.isArray(plan && plan.domainModel && plan.domainModel.entities) ? plan.domainModel.entities : []) {
    for (const attr of Array.isArray(entity && entity.attributes) ? entity.attributes : []) {
      if (!attr || typeof attr !== "object" || !attr.type || typeof attr.type !== "object") continue;
      const enumName = trimToString(attr.type.enumName || attr.type.enum);
      const replacement = renameMap.get(enumName.toLowerCase());
      if (!replacement) continue;
      attr.type = {
        ...attr.type,
        enumName: replacement
      };
      if (attr.type.enum !== undefined) attr.type.enum = replacement;
    }
  }
}

function updateAssociationRefs(plan, renameMap) {
  if (!renameMap || renameMap.size === 0) return;
  const replaceRef = (value) => {
    const raw = trimToString(value);
    if (!raw) return value;
    return renameMap.get(raw.toLowerCase()) || value;
  };
  for (const page of Array.isArray(plan && plan.pages && plan.pages.specs) ? plan.pages.specs : []) {
    walkPageStepsMutable(page && page.content, (step) => {
      for (const key of ["associationRef", "association", "associationName", "targetAssociationRef"]) {
        if (step && step[key] !== undefined) step[key] = replaceRef(step[key]);
      }
    });
  }
}

function reconcileDomainModelNamespaceNames(plan, warnings = []) {
  const diagnostics = { renamedEnumerations: [], renamedAssociations: [] };
  const domainModel = plan && plan.domainModel;
  if (!domainModel || typeof domainModel !== "object") return diagnostics;
  const occupied = new Set();
  for (const entity of Array.isArray(domainModel.entities) ? domainModel.entities : []) {
    const name = trimToString(entity && entity.name);
    if (name) occupied.add(name.toLowerCase());
  }

  const enumRenameMap = new Map();
  for (const enumeration of Array.isArray(domainModel.enumerations) ? domainModel.enumerations : []) {
    const name = trimToString(enumeration && enumeration.name);
    if (!name) continue;
    if (!occupied.has(name.toLowerCase())) {
      occupied.add(name.toLowerCase());
      continue;
    }
    const renamed = nextAvailableDomainModelName(name, "Value", occupied);
    enumeration.name = renamed;
    enumRenameMap.set(name.toLowerCase(), renamed);
    diagnostics.renamedEnumerations.push({ from: name, to: renamed, reason: "Collided with existing entity/association/enumeration name." });
    warnings.push(`Renamed enumeration "${name}" to "${renamed}" because Mendix domain model names share one namespace.`);
  }
  updateEnumerationRefs(plan, enumRenameMap);

  const associationRenameMap = new Map();
  for (const association of Array.isArray(domainModel.associations) ? domainModel.associations : []) {
    const name = trimToString(association && association.name);
    if (!name) continue;
    if (!occupied.has(name.toLowerCase())) {
      occupied.add(name.toLowerCase());
      continue;
    }
    const renamed = nextAvailableDomainModelName(name, "Association", occupied);
    association.name = renamed;
    associationRenameMap.set(name.toLowerCase(), renamed);
    diagnostics.renamedAssociations.push({ from: name, to: renamed, reason: "Collided with existing entity/enumeration/association name." });
    warnings.push(`Renamed association "${name}" to "${renamed}" because Mendix domain model names share one namespace.`);
  }
  updateAssociationRefs(plan, associationRenameMap);

  return diagnostics;
}

function pageHasUsefulSteps(page) {
  let useful = false;
  walkPageStepsMutable(page && page.content, (step) => {
    if (step && USEFUL_PAGE_STEP_TYPES.has(String(step.type || "").trim())) useful = true;
  });
  return useful;
}

function prunePlaceholderPages(plan, warnings) {
  return [];
}

function storiesRequireWorkflow(stories = []) {
  return (stories || []).some((story) => /\bworkflow|approval|approve|reject|task ui|workflow task\b/i.test(String(story && story.raw || "")));
}

function planHasUsableWorkflow(plan = {}) {
  const workflowSpecs = Array.isArray(plan && plan.workflows && plan.workflows.specs) ? plan.workflows.specs : [];
  const hasUserTaskWorkflow = workflowSpecs.some((workflow) => {
    let ok = false;
    walkWorkflowStepsMutable(workflow && workflow.steps, (step) => {
      if (String(step && step.type) === "userTask" && trimToString(step.taskPageRef)) ok = true;
    });
    return ok;
  });
  if (!hasUserTaskWorkflow) return false;

  const pages = Array.isArray(plan && plan.pages && plan.pages.specs) ? plan.pages.specs : [];
  const hasTaskPage = pages.some((page) => {
    const hasWorkflowUserTaskParam = String(page && page.entityRef || "") === "System.WorkflowUserTask" ||
      (Array.isArray(page && page.pageParameters) && page.pageParameters.some((param) => param && param.entityRef === "System.WorkflowUserTask"));
    if (!hasWorkflowUserTaskParam) return false;
    let hasOutcome = false;
    walkPageStepsMutable(page.content, (step) => {
      if (step.type === "setTaskOutcomeButton") hasOutcome = true;
    });
    return hasOutcome;
  });

  const hasStartButton = pages.some((page) => {
    let found = false;
    walkPageStepsMutable(page.content, (step) => {
      if (step.type === "callWorkflowButton") found = true;
    });
    return found;
  });

  return hasTaskPage && hasStartButton;
}

function removeWorkflowPlaceholderPages(plan, warnings) {
  if (!plan || !plan.pages || !Array.isArray(plan.pages.specs)) return;
  const before = plan.pages.specs.length;
  plan.pages.specs = plan.pages.specs.filter((page) => {
    const label = `${page && page.ref || ""} ${page && page.name || ""} ${page && page.title || ""}`;
    if (!/workflow\s*task|workflowtask/i.test(label)) return true;
    const isRealTaskPage = String(page && page.entityRef || "") === "System.WorkflowUserTask" ||
      (Array.isArray(page && page.pageParameters) && page.pageParameters.some((param) => param && param.entityRef === "System.WorkflowUserTask"));
    return isRealTaskPage;
  });
  if (plan.pages.specs.length < before) {
    warnings.push("Dropped placeholder workflow task pages that were not bound to System.WorkflowUserTask.");
  }
}

function addAttributeIfMissing(entity, attr) {
  entity.attributes = Array.isArray(entity.attributes) ? entity.attributes : [];
  if (!entity.attributes.some((existing) => String(existing && existing.name).toLowerCase() === String(attr.name).toLowerCase())) {
    entity.attributes.push({ ...attr });
  }
}

function chooseWorkflowContextEntity(plan, stories = [], domainInfo = "") {
  const entities = Array.isArray(plan && plan.domainModel && plan.domainModel.entities) ? plan.domainModel.entities : [];
  const names = entities.map((entity) => String(entity && entity.name || ""));
  const evidenceText = `${domainInfo || ""}\n${(stories || []).map((story) => story && story.raw || "").join("\n")}`;
  const workflowContextText = `${domainInfo || ""}\n${(stories || [])
    .filter((story) => /\bworkflow|approval|approve|reject|review\b/i.test(String(story && story.raw || "")))
    .map((story) => story.raw || "")
    .join("\n")}`;
  const scored = entities
    .map((entity) => {
      const name = String(entity && entity.name || "");
      if (!name) return null;
      const label = splitCamelCase(name);
      let score = 0;
      if (storyMentionsTerm({ role: "", want: "", benefit: "", raw: evidenceText }, label)) score += 4;
      if (storyMentionsTerm({ role: "", want: "", benefit: "", raw: workflowContextText }, label)) score += 6;
      if (/\bworkflow\s+context\s+entity\b/i.test(domainInfo) && storyMentionsTerm({ role: "", want: "", benefit: "", raw: domainInfo }, label)) {
        score += 8;
      }
      if (/\b(request|approval|case|application|order|ticket)\b/i.test(label)) score += 3;
      if (isAuxiliaryEntity(name)) score -= 2;
      score += Math.min(3, toConceptKey(label).split(/\s+/).filter(Boolean).length * 0.5);
      return { entity, score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
  if (scored.length > 0 && scored[0].score >= 7) return scored[0].entity;

  const preferred = [
    "SupplyRequest",
    "RestockRequest",
    "MealPlanApprovalRequest",
    "ApprovalRequest",
    "Request",
    "MedicalEquipment"
  ];
  const found = preferred.find((name) => names.includes(name));
  if (found) return entities.find((entity) => entity.name === found);
  return entities.find((entity) => /\brequest\b/i.test(splitCamelCase(entity.name))) || entities[0] || null;
}

function normalizeRoleKey(value) {
  return String(value || "").replace(/[^a-z0-9]+/gi, "").toLowerCase();
}

function extractStoryRole(story) {
  const explicit = trimToString(story && story.role);
  if (explicit) return explicit;
  const raw = trimToString(story && story.raw);
  const match = raw.match(/\bAs\s+(?:an?\s+)?([^,]+),/i);
  return match ? match[1].trim() : "";
}

function chooseWorkflowApproverRole(plan, stories = []) {
  const roles = Array.isArray(plan && plan.security && plan.security.userRoles) ? plan.security.userRoles.map((role) => role.name) : [];
  const rolesByKey = new Map(roles.map((role) => [normalizeRoleKey(role), role]));
  const storyText = (story) => String(story && story.raw || story && story.want || "");
  const reviewerStory =
    (stories || []).find((story) => /\bapprove|reject|workflow task|task ui\b/i.test(storyText(story))) ||
    (stories || []).find((story) => /\breview\b/i.test(storyText(story)));
  const reviewerRole = extractStoryRole(reviewerStory);
  const reviewerKey = normalizeRoleKey(reviewerRole);
  if (reviewerKey && rolesByKey.has(reviewerKey)) return rolesByKey.get(reviewerKey);

  return roles.find((role) => /\bDepartmentHead\b|Head|Manager|Approver|Reviewer/i.test(role)) || roles[0] || "Manager";
}

function collectWorkflowUserTasks(workflow) {
  const tasks = [];
  walkWorkflowStepsMutable(workflow && workflow.steps, (step) => {
    if (String(step && step.type) === "userTask") tasks.push(step);
  });
  return tasks;
}

function ensureWorkflowReviewerRoleConsistency(plan, stories = [], warnings = []) {
  if (!storiesRequireWorkflow(stories)) return;
  const workflows = Array.isArray(plan && plan.workflows && plan.workflows.specs) ? plan.workflows.specs : [];
  if (workflows.length === 0) return;

  const reviewerRole = chooseWorkflowApproverRole(plan, stories);
  if (!reviewerRole) return;

  const singleUserTasks = [];
  for (const workflow of workflows) {
    const tasks = collectWorkflowUserTasks(workflow);
    if (tasks.length === 1) singleUserTasks.push({ workflow, task: tasks[0] });
  }
  if (singleUserTasks.length !== 1) return;

  const task = singleUserTasks[0].task;
  const existingRoles = Array.isArray(task.userRoleRefs) ? task.userRoleRefs : [];
  if (existingRoles.length === 1 && existingRoles[0] === reviewerRole) return;

  task.userRoleRefs = [reviewerRole];
  const taskPageRef = trimToString(task.taskPageRef);
  const pages = Array.isArray(plan && plan.pages && plan.pages.specs) ? plan.pages.specs : [];
  for (const page of pages) {
    if (page.ref === taskPageRef || page.entityRef === "System.WorkflowUserTask") {
      page.allowedRoles = [reviewerRole];
    }
  }
  warnings.push(`Aligned single-step workflow approval role to ${reviewerRole}.`);
}

function deriveWorkflowIntent(plan, stories = [], domainInfo = "") {
  const contextEntity = chooseWorkflowContextEntity(plan, stories, domainInfo);
  if (!contextEntity) return null;
  const base = toSafeName(contextEntity.name, "WorkflowContext");
  const baseLower = base.toLowerCase();
  const storyText = (stories || []).map((story) => String(story && story.raw || "")).join(" ");
  const approve = /\bapprove|approval\b/i.test(storyText);
  const reject = /\breject\b/i.test(storyText);
  const outcomes = approve || reject
    ? [
        { value: "Approve", status: "Approved", microflowRef: `mf_${baseLower}_approve`, microflowName: `MF_${base}_Approve` },
        { value: "Reject", status: "Rejected", microflowRef: `mf_${baseLower}_reject`, microflowName: `MF_${base}_Reject` }
      ]
    : [
        { value: "Complete", status: "Completed", microflowRef: `mf_${baseLower}_complete`, microflowName: `MF_${base}_Complete` }
      ];

  return {
    contextEntity,
    base,
    baseLower,
    workflowRef: `wf_${baseLower}`,
    workflowName: `WF_${base}`,
    prepareRef: `mf_${baseLower}_prepare`,
    prepareName: `MF_${base}_Prepare`,
    taskPageRef: `${baseLower}_workflow_task`,
    taskPageName: `${base}_WorkflowTask`,
    managerPageRef: `${baseLower}_workflow_tasks`,
    managerPageName: `${base}_WorkflowTasks`,
    reviewStepName: `${base}Review`,
    startCaption: `Start ${splitCamelCase(base).trim()} Workflow`,
    reviewTitle: `${splitCamelCase(base).trim()} Workflow Tasks`,
    taskTitle: `${splitCamelCase(base).trim()} Workflow Task`,
    outcomes
  };
}

function buildWorkflowHandlerMicroflows(intent, contextRef) {
  const parameter = {
    name: "WorkflowContext",
    type: { kind: "Object", entityRef: contextRef },
    required: true
  };
  const specs = [
    {
      ref: intent.prepareRef,
      name: intent.prepareName,
      parameters: [parameter],
      actions: [
        {
          type: "changeObject",
          targetVariableName: "WorkflowContext",
          commit: "yes",
          changes: [{ attributeRef: "Status", valueExpression: "'In review'" }]
        }
      ]
    }
  ];

  for (const outcome of intent.outcomes) {
    specs.push({
      ref: outcome.microflowRef,
      name: outcome.microflowName,
      parameters: [parameter],
      actions: [
        {
          type: "changeObject",
          targetVariableName: "WorkflowContext",
          commit: "yes",
          changes: [{ attributeRef: "Status", valueExpression: `'${outcome.status}'` }]
        }
      ]
    });
  }

  return { specs };
}

function ensureStepOnContextDetailPage(plan, contextEntity, workflowRef, caption, warnings) {
  const moduleName = plan && plan.app && plan.app.moduleName ? plan.app.moduleName : "MyFirstModule";
  const entityRef = `${moduleName}.${contextEntity.name}`;
  const detailRef = `${contextEntity.name.toLowerCase()}_newedit`;
  let detailPage = (plan.pages.specs || []).find((page) => page.ref === detailRef) ||
    (plan.pages.specs || []).find((page) => page.entityRef === entityRef && Array.isArray(page.pageParameters) && page.pageParameters.length > 0);

  if (!detailPage) {
    detailPage = {
      ref: detailRef,
      name: `${contextEntity.name}_NewEdit`,
      title: `${contextEntity.name} NewEdit`,
      entityRef,
      layoutQualifiedName: DEFAULT_POPUP_LAYOUT_QNAME,
      pageParameters: [{ name: contextEntity.name, entityRef, required: true }],
      content: [
        {
          type: "dataView",
          pageParameterName: contextEntity.name,
          labelWidth: 3,
          content: (contextEntity.attributes || []).slice(0, 8).map((attr) => ({ type: "attributeInput", attributeRef: attr.name }))
        }
      ]
    };
    plan.pages.specs.push(detailPage);
  }

  let dataView = null;
  walkPageStepsMutable(detailPage.content, (step) => {
    if (!dataView && step.type === "dataView") dataView = step;
  });
  if (!dataView) {
    dataView = {
      type: "dataView",
      pageParameterName: contextEntity.name,
      labelWidth: 3,
      content: []
    };
    detailPage.content.push(dataView);
  }
  dataView.content = Array.isArray(dataView.content) ? dataView.content : [];
  if (!dataView.content.some((step) => step && step.type === "callWorkflowButton" && step.workflowRef === workflowRef)) {
    const insertAt = dataView.content.findIndex((step) => step && (step.type === "saveChangesButton" || step.type === "cancelChangesButton"));
    const workflowButton = {
      type: "callWorkflowButton",
      caption,
      workflowRef,
      closePage: true
    };
    if (insertAt >= 0) dataView.content.splice(insertAt, 0, workflowButton);
    else dataView.content.push(workflowButton);
    warnings.push(`Added callWorkflowButton to ${detailPage.name} for generated workflow.`);
  }
}

function ensureWorkflowStartButtons(plan, warnings = []) {
  const moduleName = plan && plan.app && plan.app.moduleName ? plan.app.moduleName : "MyFirstModule";
  const workflows = Array.isArray(plan && plan.workflows && plan.workflows.specs) ? plan.workflows.specs : [];
  const entities = Array.isArray(plan && plan.domainModel && plan.domainModel.entities) ? plan.domainModel.entities : [];

  for (const workflow of workflows) {
    const workflowRef = trimToString(workflow && (workflow.ref || workflow.name));
    if (!workflowRef) continue;
    let hasStartButton = false;
    for (const page of plan && plan.pages && Array.isArray(plan.pages.specs) ? plan.pages.specs : []) {
      walkPageStepsMutable(page && page.content, (step) => {
        if (step && step.type === "callWorkflowButton" && trimToString(step.workflowRef) === workflowRef) {
          hasStartButton = true;
        }
      });
    }
    if (hasStartButton) continue;

    const contextRef = trimToString(workflow && workflow.bindings && workflow.bindings.contextEntityRef);
    const contextName = contextRef.includes(".") ? contextRef.split(".").pop() : contextRef;
    const contextEntity = entities.find((entity) =>
      String(entity && entity.name || "") === contextName ||
      `${moduleName}.${entity && entity.name || ""}` === contextRef
    );
    if (!contextEntity) continue;
    ensureStepOnContextDetailPage(
      plan,
      contextEntity,
      workflowRef,
      `Start ${splitCamelCase(contextEntity.name).trim()} Workflow`,
      warnings
    );
  }
}

function ensureWorkflowScaffold(plan, stories, warnings, domainInfo = "") {
  removeWorkflowPlaceholderPages(plan, warnings);
  ensureWorkflowReviewerRoleConsistency(plan, stories, warnings);
  if (!storiesRequireWorkflow(stories) || planHasUsableWorkflow(plan)) return;
  if (!plan.pages || !Array.isArray(plan.pages.specs)) plan.pages = { specs: [] };

  const intent = deriveWorkflowIntent(plan, stories, domainInfo);
  if (!intent) return;
  const { contextEntity } = intent;
  if (!contextEntity) return;
  addAttributeIfMissing(contextEntity, { name: "Title", type: "String", required: true });
  addAttributeIfMissing(contextEntity, { name: "Description", type: "String", required: false });
  addAttributeIfMissing(contextEntity, { name: "Status", type: "String", required: false });

  const moduleName = plan && plan.app && plan.app.moduleName ? plan.app.moduleName : "MyFirstModule";
  const contextRef = `${moduleName}.${contextEntity.name}`;
  const approverRole = chooseWorkflowApproverRole(plan, stories);

  plan.microflows = mergeSpecSections(plan.microflows, buildWorkflowHandlerMicroflows(intent, contextRef), "microflow", warnings);

  plan.workflows = mergeSpecSections(plan.workflows, {
    specs: [
      {
        ref: intent.workflowRef,
        name: intent.workflowName,
        bindings: { contextEntityRef: contextRef },
        steps: [
          { type: "start", name: "Start" },
          { type: "serviceTask", name: `${intent.base}Prepare`, handlerMicroflowRef: intent.prepareRef },
          {
            type: "userTask",
            name: intent.reviewStepName,
            taskName: "{1}",
            taskNameArgs: ["$WorkflowContext/Title"],
            taskDescription: "{1}",
            taskDescriptionArgs: ["$WorkflowContext/Description"],
            taskPageRef: intent.taskPageRef,
            userRoleRefs: [approverRole],
            outcomes: intent.outcomes.map((outcome) => ({
              value: outcome.value,
              steps: [
                { type: "serviceTask", name: outcome.status, handlerMicroflowRef: outcome.microflowRef },
                { type: "end", name: outcome.status }
              ]
            }))
          }
        ]
      }
    ]
  }, "workflow", warnings);

  ensureStepOnContextDetailPage(plan, contextEntity, intent.workflowRef, intent.startCaption, warnings);

  const pageRefs = new Set(plan.pages.specs.map((page) => page.ref));
  if (!pageRefs.has(intent.managerPageRef)) {
    plan.pages.specs.push({
      ref: intent.managerPageRef,
      name: intent.managerPageName,
      title: intent.reviewTitle,
      entityRef: "System.WorkflowUserTask",
      allowedRoles: [approverRole],
      content: [
        { type: "dynamicText", text: intent.reviewTitle, renderMode: "H2" },
        {
          type: "listView",
          entityRef: "System.WorkflowUserTask",
          itemContent: [
            { type: "attributeInput", attributeRef: "Name", autoLabel: false },
            { type: "attributeInput", attributeRef: "Description", autoLabel: false },
            { type: "showUserTaskPageButton", caption: "Open Task", assignOnOpen: true, openWhenAssigned: true }
          ]
        }
      ]
    });
  }

  if (!pageRefs.has(intent.taskPageRef)) {
    plan.pages.specs.push({
      ref: intent.taskPageRef,
      name: intent.taskPageName,
      title: intent.taskTitle,
      layoutQualifiedName: DEFAULT_POPUP_LAYOUT_QNAME,
      allowedRoles: [approverRole],
      pageParameters: [{ name: "WorkflowUserTask", entityRef: "System.WorkflowUserTask", required: true }],
      content: [
        {
          type: "dataView",
          pageParameterName: "WorkflowUserTask",
          content: [
            { type: "attributeInput", attributeRef: "Name", autoLabel: true },
            { type: "attributeInput", attributeRef: "Description", autoLabel: true },
            ...intent.outcomes.map((outcome) => ({
              type: "setTaskOutcomeButton",
              caption: outcome.value,
              outcomeValue: outcome.value
            }))
          ]
        }
      ]
    });
  }

  plan.pages.specs = ensureUniqueSpecNames(plan.pages.specs, "page", warnings);
  warnings.push(`Synthesized reference-style workflow scaffold for ${contextEntity.name} because workflow stories were detected but no usable workflow was generated.`);
}

function ensureEntityCrudPages(plan, warnings) {
  const moduleName = plan && plan.app && plan.app.moduleName ? plan.app.moduleName : "MyFirstModule";
  if (!plan.pages || !Array.isArray(plan.pages.specs)) plan.pages = { specs: [] };
  const rawPageCount = plan.pages.specs.length;
  plan.pages.specs = plan.pages.specs.filter((page) => page && typeof page === "object" && !Array.isArray(page));
  if (plan.pages.specs.length < rawPageCount) {
    warnings.push(`Removed ${rawPageCount - plan.pages.specs.length} invalid page spec(s) before CRUD page repair.`);
  }
  const pages = plan.pages.specs.slice();
  const pageRefs = new Set(pages.map((p) => String(p.ref || "").toLowerCase()));
  const associations = Array.isArray(plan && plan.domainModel && plan.domainModel.associations)
    ? plan.domainModel.associations
    : [];

  function buildDetailContent(entity) {
    const associationInputs = associations
      .filter((assoc) => {
        const parent = String(assoc && assoc.parentEntity || "").split(".").pop();
        const child = String(assoc && assoc.childEntity || "").split(".").pop();
        return parent === entity.name || child === entity.name;
      })
      .map((assoc) => {
        const parent = String(assoc && assoc.parentEntity || "").split(".").pop();
        const child = String(assoc && assoc.childEntity || "").split(".").pop();
        const targetEntityName = parent === entity.name ? child : parent;
        const associationType = String(assoc && assoc.type || "").toLowerCase();
        return {
          type: associationType === "referenceset" ? "associationSetInput" : "associationInput",
          associationRef: assoc.name,
          targetEntityRef: `${moduleName}.${targetEntityName}`,
          label: splitCamelCase(targetEntityName).trim()
        };
      });

    return [
      {
        type: "dataView",
        pageParameterName: entity.name,
        labelWidth: 3,
        content: (entity.attributes || []).slice(0, 8).map((attr) => ({ type: "attributeInput", attributeRef: attr.name }))
          .concat(associationInputs)
          .concat([
            { type: "saveChangesButton", caption: "Save", closePage: true },
            { type: "cancelChangesButton", caption: "Cancel", closePage: true }
          ])
      }
    ];
  }

  function pageHasUsableDetailForm(page, expectedAssociationRefs = []) {
    const expectedAssociations = associations
      .filter((assoc) => expectedAssociationRefs.includes(assoc && assoc.name))
      .map((assoc) => ({
        name: String(assoc && assoc.name || "").trim(),
        type: String(assoc && assoc.type || "").toLowerCase() === "referenceset" ? "associationSetInput" : "associationInput"
      }))
      .filter((assoc) => assoc.name);
    const expectedRefs = new Set(expectedAssociations.map((assoc) => assoc.name));
    const expectedTypesByRef = new Map(expectedAssociations.map((assoc) => [assoc.name, assoc.type]));
    return Array.isArray(page && page.content) && page.content.some((step) => {
      if (!step || typeof step !== "object") return false;
      if (step.type !== "dataView") return false;
      const inner = Array.isArray(step.content) ? step.content : [];
      const hasAttributeInput = inner.some((child) => child && child.type === "attributeInput");
      const lookupSteps = inner.filter((child) => child && /association(Input|SetInput)|reference(Selector|SetSelector)/.test(String(child.type || "")));
      const associationRefs = new Set(lookupSteps
        .map((child) => String(child.associationRef || child.association || "").trim())
        .filter(Boolean));
      if (!hasAttributeInput) return false;
      for (const ref of expectedRefs) {
        if (!associationRefs.has(ref)) return false;
      }
      for (const ref of associationRefs) {
        if (!expectedRefs.has(ref)) return false;
      }
      for (const child of lookupSteps) {
        const ref = String(child.associationRef || child.association || "").trim();
        const expectedType = expectedTypesByRef.get(ref);
        const actualType = child.type === "associationSetInput" || child.type === "referenceSetSelector"
          ? "associationSetInput"
          : "associationInput";
        if (expectedType && actualType !== expectedType) return false;
      }
      return true;
    });
  }

  function walkPageSteps(steps, visit) {
    for (const step of Array.isArray(steps) ? steps : []) {
      if (!step || typeof step !== "object") continue;
      visit(step);
      for (const key of ["content", "itemContent", "children"]) {
        if (Array.isArray(step[key])) walkPageSteps(step[key], visit);
      }
    }
  }

  function synthesizeMissingDetailPage(ref, entityRef) {
    const targetRef = String(ref || "").trim();
    if (!targetRef || pageRefs.has(targetRef.toLowerCase()) || !/_newedit$/i.test(targetRef)) return;

    const rawEntityName = String((entityRef || "").split(".").pop() || targetRef.replace(/_newedit$/i, "")).trim();
    const entityName = rawEntityName ? toPascalCase(rawEntityName, "Item") : "Item";
    const qualifiedEntityRef = trimToString(entityRef) || `${moduleName}.${entityName}`;
    const knownEntity = ((plan.domainModel && plan.domainModel.entities) || [])
      .find((entity) => toConceptKey(entity && entity.name) === toConceptKey(entityName));
    const detailEntity = knownEntity || {
      name: entityName,
      attributes: [{ name: "Name", type: "String", required: false }]
    };

    pages.push({
      ref: targetRef,
      name: `${entityName}_NewEdit`,
      title: `${splitCamelCase(entityName).trim()} NewEdit`,
      entityRef: qualifiedEntityRef,
      layoutQualifiedName: DEFAULT_POPUP_LAYOUT_QNAME,
      pageParameters: [{ name: entityName, entityRef: qualifiedEntityRef, required: true }],
      content: buildDetailContent(detailEntity)
    });
    pageRefs.add(targetRef.toLowerCase());
    warnings.push(`Added missing NewEdit page "${targetRef}" referenced by generated page content.`);
  }

  for (const entity of (plan.domainModel && plan.domainModel.entities) || []) {
    if (!entity || !entity.name) continue;
    const refBase = String(entity.name).toLowerCase();
    const entityRef = `${moduleName}.${entity.name}`;

    const overviewRef = `${refBase}_overview`;
    const detailRef = `${refBase}_newedit`;

    if (!pageRefs.has(overviewRef)) {
      pages.push({
        ref: overviewRef,
        name: `${entity.name}_Overview`,
        title: `${entity.name} Overview`,
        entityRef,
        content: [
          { type: "dynamicText", text: `${entity.name} Overview`, renderMode: "H2" },
          {
            type: "createObjectButton",
            caption: `Create ${entity.name}`,
            entityRef,
            targetPageRef: detailRef
          },
          {
            type: "listView",
            entityRef,
            autoRowClickToDetail: true,
            rowClickTargetPageRef: detailRef,
            itemContent: buildEntityListViewTemplate(entity)
          }
        ]
      });
      pageRefs.add(overviewRef);
      warnings.push(`Added missing overview page for entity \"${entity.name}\".`);
    }

    if (!pageRefs.has(detailRef)) {
      pages.push({
        ref: detailRef,
        name: `${entity.name}_NewEdit`,
        title: `${entity.name} NewEdit`,
        entityRef,
        layoutQualifiedName: DEFAULT_POPUP_LAYOUT_QNAME,
        pageParameters: [{ name: entity.name, entityRef, required: true }],
        content: buildDetailContent(entity)
      });
      pageRefs.add(detailRef);
      warnings.push(`Added missing NewEdit page for entity \"${entity.name}\".`);
    } else {
      const existingDetail = pages.find((page) => String(page && page.ref || "").toLowerCase() === detailRef);
      const expectedAssociationRefs = associations.filter((assoc) => {
        const parent = String(assoc && assoc.parentEntity || "").split(".").pop();
        const child = String(assoc && assoc.childEntity || "").split(".").pop();
        return parent === entity.name || child === entity.name;
      }).map((assoc) => assoc && assoc.name).filter(Boolean);
      if (existingDetail && !pageHasUsableDetailForm(existingDetail, expectedAssociationRefs)) {
        existingDetail.entityRef = existingDetail.entityRef || entityRef;
        existingDetail.layoutQualifiedName = existingDetail.layoutQualifiedName || DEFAULT_POPUP_LAYOUT_QNAME;
        existingDetail.pageParameters = Array.isArray(existingDetail.pageParameters) && existingDetail.pageParameters.length > 0
          ? existingDetail.pageParameters
          : [{ name: entity.name, entityRef, required: true }];
        existingDetail.content = buildDetailContent(entity);
        warnings.push(`Repaired NewEdit page for entity \"${entity.name}\" because its form inputs no longer matched current associations.`);
      }
    }
  }

  for (const page of pages) {
    walkPageSteps(page && page.content, (step) => {
      if (step.type === "createObjectButton" && step.targetPageRef) {
        synthesizeMissingDetailPage(step.targetPageRef, step.entityRef || page.entityRef);
      }
      if ((step.type === "listView" || step.type === "dataGrid") && step.rowClickTargetPageRef) {
        synthesizeMissingDetailPage(step.rowClickTargetPageRef, step.entityRef || page.entityRef);
      }
    });
  }

  if (!pageRefs.has("home")) {
    pages.unshift({
      ref: "home",
      name: "Home",
      title: "Home",
      content: [{ type: "dynamicText", text: "Home", renderMode: "H2" }]
    });
    warnings.push("Added missing Home page.");
  }

  plan.pages = {
    specs: ensureUniqueSpecNames(dedupeByName(pages, (p) => p.ref || p.name), "page", warnings)
  };
  prunePlaceholderPages(plan, warnings);
}

function defaultNavigationRefsFromPages(plan) {
  const pages = (plan.pages && Array.isArray(plan.pages.specs) ? plan.pages.specs : [])
    .filter((page) => page && typeof page === "object" && !Array.isArray(page));
  const overviewCandidates = pages
    .map((page) => {
      const ref = String((page && page.ref) || "").trim();
      const entityName = String((page && page.entityRef || "").split(".").pop() || "").trim();
      return { ref, entityName };
    })
    .filter((entry) => entry.ref && entry.ref !== "home" && /_overview$/.test(entry.ref))
    .sort((left, right) => {
      const leftAux = left.entityName && isAuxiliaryEntity(left.entityName) ? 1 : 0;
      const rightAux = right.entityName && isAuxiliaryEntity(right.entityName) ? 1 : 0;
      if (leftAux !== rightAux) return leftAux - rightAux;
      return left.ref.localeCompare(right.ref);
    })
    .slice(0, 6)
    .map((entry) => entry.ref);
  if (overviewCandidates.length > 0) return overviewCandidates;

  return pages
    .filter((p) => !(Array.isArray(p && p.pageParameters) && p.pageParameters.length > 0))
    .map((p) => String((p && p.ref) || ""))
    .filter((ref) => ref && ref !== "home")
    .slice(0, 6);
}

function workflowTaskInboxNavigationEntries(plan) {
  const pages = (plan && plan.pages && Array.isArray(plan.pages.specs) ? plan.pages.specs : [])
    .filter((page) => page && typeof page === "object" && !Array.isArray(page));
  return pages
    .filter((page) => {
      if (!page || !page.ref) return false;
      if (String(page.entityRef || "") !== "System.WorkflowUserTask") return false;
      const hasRequiredPageParameter = Array.isArray(page.pageParameters) && page.pageParameters.length > 0;
      return !hasRequiredPageParameter;
    })
    .map((page) => ({
      pageRef: String(page.ref).trim(),
      caption: trimToString(page.title || page.name) || "Workflow Tasks",
      icon: { name: "check" },
      allowedRoles: Array.isArray(page.allowedRoles) ? page.allowedRoles : []
    }))
    .filter((entry) => entry.pageRef);
}

function normalizeNavigationIconSpec(icon, warnings = [], pointer = "navigation icon") {
  if (icon === undefined || icon === null || icon === "") return undefined;

  const fallback = { name: HOME_ICON_NAME };
  const warn = () => {
    warnings.push(`Replaced unsupported ${pointer} with the only supported icon "home".`);
    return fallback;
  };

  if (typeof icon === "number") return warn();
  if (typeof icon === "string") {
    const value = icon.trim();
    if (!value) return undefined;
    return isHomeIconName(value) ? HOME_ICON_NAME : warn();
  }
  if (icon && typeof icon === "object" && !Array.isArray(icon)) {
    const name = String(icon.name || "").trim();
    if (isHomeIconName(name)) return { name: HOME_ICON_NAME };
    return warn();
  }

  return warn();
}

function sanitizeNavigationIcons(plan, warnings = []) {
  const navigation = plan && plan.app && plan.app.navigation && typeof plan.app.navigation === "object"
    ? plan.app.navigation
    : null;
  if (!navigation) return;

  for (const sectionName of ["homePageButtons", "menuItems"]) {
    const entries = Array.isArray(navigation[sectionName]) ? navigation[sectionName] : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      if (entry.icon === undefined || entry.icon === null || entry.icon === "") continue;
      const pageRef = String(entry.pageRef || entry.ref || "").trim();
      entry.icon = normalizeNavigationIconSpec(
        entry.icon,
        warnings,
        `navigation icon for "${pageRef || sectionName}"`
      );
    }
  }
}

function ensureNavigationSpecAndHomeButtons(plan, warnings) {
  plan.app = plan.app || {};
  const nav = normalizeNavigationConfig(plan.app.navigation && typeof plan.app.navigation === "object" ? plan.app.navigation : {});
  const existingButtonRefs = Array.isArray(nav.homePageButtonRefs) ? nav.homePageButtonRefs : [];
  const existingNavRefs = Array.isArray(nav.navigationItemRefs) ? nav.navigationItemRefs : [];
  const pages = plan.pages && Array.isArray(plan.pages.specs) ? plan.pages.specs : [];
  const validPageRefs = new Set(
    pages
      .filter((page) => page && typeof page === "object" && String(page.ref || "").trim())
      .map((page) => String(page.ref).trim())
  );

  const defaults = defaultNavigationRefsFromPages(plan);
  function toNavigationEntry(entry = {}) {
    const out = {
      pageRef: String(entry.pageRef || entry.ref || "").trim(),
      caption: String(entry.caption || "").trim(),
      allowedRoles: Array.isArray(entry.allowedRoles) ? entry.allowedRoles : []
    };
    if (entry.icon !== undefined && entry.icon !== null && entry.icon !== "") {
      out.icon = normalizeNavigationIconSpec(entry.icon, warnings, `navigation icon for "${out.pageRef}"`);
    }
    return out;
  }

  function dropInvalidNavigationEntries(entries, label) {
    const kept = [];
    for (const entry of entries) {
      if (!entry.pageRef || !validPageRefs.has(entry.pageRef)) {
        warnings.push(`Removed ${label} navigation entry "${entry.pageRef || "<empty>"}" because target page does not exist.`);
        continue;
      }
      kept.push(entry);
    }
    return kept;
  }

  let homePageButtons = dedupeByName(
    (nav.homePageButtons && nav.homePageButtons.length > 0 ? nav.homePageButtons : (existingButtonRefs.length > 0 ? existingButtonRefs : defaults).map((ref) => ({ pageRef: ref }))),
    (x) => x.pageRef || x.ref
  ).map((entry) => toNavigationEntry(entry));
  let menuItems = dedupeByName(
    (nav.menuItems && nav.menuItems.length > 0 ? nav.menuItems : (existingNavRefs.length > 0 ? existingNavRefs : defaults).map((ref) => ({ pageRef: ref }))),
    (x) => x.pageRef || x.ref
  ).map((entry) => toNavigationEntry(entry));
  homePageButtons = dropInvalidNavigationEntries(homePageButtons, "homepage");
  menuItems = dropInvalidNavigationEntries(menuItems, "menu");

  const workflowTaskEntries = workflowTaskInboxNavigationEntries(plan);
  function upsertNavigationEntry(entries, entry) {
    const existing = entries.find((item) => item.pageRef === entry.pageRef);
    if (!existing) {
      entries.push(toNavigationEntry(entry));
      return true;
    }
    if (!existing.caption) existing.caption = entry.caption;
    if ((!Array.isArray(existing.allowedRoles) || existing.allowedRoles.length === 0) && Array.isArray(entry.allowedRoles)) {
      existing.allowedRoles = entry.allowedRoles;
    }
    if (existing.icon === undefined && entry.icon !== undefined) existing.icon = entry.icon;
    return false;
  }
  for (const entry of workflowTaskEntries) {
    if (upsertNavigationEntry(homePageButtons, entry)) {
      warnings.push(`Added workflow task inbox "${entry.pageRef}" to homepage navigation.`);
    }
    if (upsertNavigationEntry(menuItems, entry)) {
      warnings.push(`Added workflow task inbox "${entry.pageRef}" to menu navigation.`);
    }
  }

  const navigationCap = 6;
  for (const ref of defaults) {
    if (homePageButtons.length < navigationCap && !homePageButtons.some((entry) => entry.pageRef === ref)) {
      homePageButtons.push(toNavigationEntry({ pageRef: ref }));
      warnings.push(`Added overview page "${ref}" to homepage navigation.`);
    }
    if (menuItems.length < navigationCap && !menuItems.some((entry) => entry.pageRef === ref)) {
      menuItems.push(toNavigationEntry({ pageRef: ref }));
      warnings.push(`Added overview page "${ref}" to menu navigation.`);
    }
  }

  if (homePageButtons.length === 0 || menuItems.length === 0) {
    warnings.push("Could not derive required navigation refs from pages; navigation contract may fail validation.");
  }

  plan.app.navigation = {
    ...nav,
    homePageButtons,
    menuItems,
    homePageButtonRefs: homePageButtons.map((entry) => entry.pageRef),
    navigationItemRefs: menuItems.map((entry) => entry.pageRef)
  };

  const homeRef = String(plan.app.homePageRef || "home");
  const homePage = pages.find((p) => p && String(p.ref) === homeRef) || pages.find((p) => p && String(p.ref) === "home");
  if (!homePage) return;
  if (Array.isArray(homePage.content)) {
    homePage.content = homePage.content.filter((step) => {
      if (!step || typeof step !== "object") return true;
      if (String(step.type) !== "buttonToPage" || !step.targetPageRef) return true;
      if (validPageRefs.has(String(step.targetPageRef))) return true;
      warnings.push(`Removed homepage button to missing page "${step.targetPageRef}".`);
      return false;
    });
  }

  const existingTargets = new Set();
  for (const step of Array.isArray(homePage.content) ? homePage.content : []) {
    if (!step || typeof step !== "object") continue;
    if (String(step.type) === "buttonToPage" && step.targetPageRef) {
      existingTargets.add(String(step.targetPageRef));
    }
  }

  const toAdd = homePageButtons.filter((entry) => entry.pageRef && !existingTargets.has(entry.pageRef) && entry.pageRef !== homeRef);
  for (const entry of toAdd) {
    const targetRef = entry.pageRef;
    homePage.content.push({
      type: "buttonToPage",
      caption: entry.caption || splitCamelCase(targetRef.replace(/_/g, " ")).trim(),
      targetPageRef: targetRef
    });
  }
}

function evaluateStoryCoverage(plan, stories, visualNarratorSummary = null, processVisualizerSummary = null) {
  const entities = ((plan.domainModel && plan.domainModel.entities) || []).map((entity) => entity || {});
  const pages = ((plan.pages && plan.pages.specs) || []).map((page) => page || {});
  const planEntityNames = entities.map((entity) => String(entity.name || ""));

  function conceptKeyVariants(raw) {
    const variants = new Set();
    const direct = toConceptKey(raw);
    if (direct) variants.add(direct);
    const spaced = toConceptKey(splitCamelCase(raw));
    if (spaced) {
      variants.add(spaced);
      variants.add(spaced.replace(/\s+/g, ""));
      const parts = spaced.split(/\s+/).filter(Boolean);
      for (let start = 0; start < parts.length; start += 1) {
        for (let end = start + 1; end <= parts.length; end += 1) {
          const slice = parts.slice(start, end);
          if (slice.length === 0) continue;
          variants.add(slice.join(" "));
          variants.add(slice.join(""));
        }
      }
    }
    return Array.from(variants).filter(Boolean);
  }

  const planConceptKeys = new Set([
    ...planEntityNames.flatMap((name) => conceptKeyVariants(name)),
    ...entities.flatMap((entity) => (entity.attributes || []).flatMap((attr) => conceptKeyVariants(attr && attr.name))),
    ...((plan.domainModel && plan.domainModel.associations) || []).flatMap((assoc) => [
      ...conceptKeyVariants(assoc && assoc.name),
      ...conceptKeyVariants(assoc && assoc.parentEntity),
      ...conceptKeyVariants(assoc && assoc.childEntity)
    ]),
    ...pages.flatMap((page) => [
      ...conceptKeyVariants(page && page.name),
      ...conceptKeyVariants(page && page.title),
      ...conceptKeyVariants(String(page && page.entityRef || "").split(".").pop())
    ])
  ].filter(Boolean));
  const pageRefs = new Set(pages.map((page) => String(page.ref || "").toLowerCase()).filter(Boolean));
  const vnConceptKeys = new Set(
    ((visualNarratorSummary && visualNarratorSummary.classNames) || []).map((entry) => toConceptKey(entry)).filter(Boolean)
  );
  const pvConceptKeys = new Set(
    ((processVisualizerSummary && processVisualizerSummary.processObjects) || []).map((entry) => toConceptKey(entry)).filter(Boolean)
  );

  const entries = stories.map((story) => {
    const phraseCandidates = collectStoryEntityPhraseCandidates([story]).map((entry) => entry.name);
    const storyEntityKeys = uniq(
      phraseCandidates.map((entry) => toConceptKey(entry)).filter(Boolean)
        .concat(
          story.tokens
            .map((token) => singularizeWord(token))
            .filter((token) => token && !GENERIC_ENTITY_STOP_WORDS.has(token))
        )
    );
    const matchedConcepts = storyEntityKeys.filter((token) => planConceptKeys.has(token));
    const vnAlignedConcepts = storyEntityKeys.filter((token) => vnConceptKeys.has(token));
    const pvAlignedConcepts = storyEntityKeys.filter((token) => pvConceptKeys.has(token));
    const uiRefs = storyEntityKeys
      .map((token) => `${token.replace(/\s+/g, "").toLowerCase()}_overview`)
      .filter((ref) => pageRefs.has(ref));
    const lexicalScore = storyEntityKeys.length > 0 ? matchedConcepts.length / storyEntityKeys.length : 0;
    const uiScore = uiRefs.length > 0 ? 1 : pages.length > 1 ? 0.5 : 0;
    const storyCovered = lexicalScore >= 0.45 || (lexicalScore >= 0.3 && uiScore > 0 && (vnAlignedConcepts.length > 0 || pvAlignedConcepts.length > 0 || matchedConcepts.length >= 2));

    return {
      id: story.id,
      story: story.raw,
      storyConcepts: storyEntityKeys,
      matchedConcepts,
      processVisualizerAlignedConcepts: pvAlignedConcepts,
      matchedUiRefs: uiRefs,
      lexicalScore,
      covered: storyCovered
    };
  });

  const coveredCount = entries.filter((e) => e.covered).length;
  const total = entries.length;
  const score = total === 0 ? 1 : coveredCount / total;

  return {
    total,
    covered: coveredCount,
    score,
    entries,
    missingStories: entries.filter((e) => !e.covered)
  };
}

function mergePlanCandidates({
  baselinePlan,
  llmPlan,
  stories,
  visualNarratorSummary,
  processVisualizerSummary = null,
  warnings
}) {
  const evidence = buildEvidenceProfile({
    stories,
    visualNarratorSummary,
    processVisualizerSummary,
    baselinePlan
  });

  const merged = {
    ...baselinePlan,
    meta: {
      ...(baselinePlan.meta || {}),
      mergedWithLlm: true
    },
    domainModel: mergeDomainModels(
      baselinePlan.domainModel || {},
      llmPlan.domainModel || {},
      evidence,
      warnings
    ),
    pages: mergePages(baselinePlan.pages || { specs: [] }, llmPlan.pages || { specs: [] }, evidence, warnings),
    verification: {
      ...(baselinePlan.verification || {}),
      ...(llmPlan.verification || {})
    }
  };

  const mergedMicroflows = mergeSpecSections(baselinePlan.microflows, llmPlan.microflows, "microflow", warnings);
  if (mergedMicroflows) merged.microflows = mergedMicroflows;

  const mergedNanoflows = mergeSpecSections(baselinePlan.nanoflows, llmPlan.nanoflows, "nanoflow", warnings);
  if (mergedNanoflows) merged.nanoflows = mergedNanoflows;

  const mergedWorkflows = mergeSpecSections(baselinePlan.workflows, llmPlan.workflows, "workflow", warnings);
  if (mergedWorkflows) merged.workflows = mergedWorkflows;

  normalizeReferenceSetAssociationsForDropdownInputs(merged, warnings);
  ensureEntityCrudPages(merged, warnings);
  return merged;
}

function loadMockGeneratedPlan(mockPath) {
  const absolute = path.resolve(mockPath);
  const raw = fs.readFileSync(absolute, "utf8");
  const parsed = JSON.parse(raw);

  if (parsed && typeof parsed === "object" && parsed.response !== undefined) {
    const responseBody = typeof parsed.response === "string" ? JSON.parse(parsed.response) : parsed.response;
    return {
      generatedPlan: responseBody,
      ollamaRaw: parsed
    };
  }

  return {
    generatedPlan: parsed,
    ollamaRaw: {
      model: "mock",
      total_duration: 0,
      load_duration: 0,
      prompt_eval_count: 0,
      eval_count: 0
    }
  };
}

function generateVisualNarratorArtifactsFromInputDir({
  inputDir,
  outputDir = inputDir,
  repoRoot = process.cwd(),
  onProgress = null,
  runVisualNarratorImpl = runVisualNarrator
}) {
  const progress = typeof onProgress === "function" ? onProgress : () => {};
  const bundle = loadInputBundle(inputDir);
  const state = runVisualNarratorImpl({
    inputPath: bundle.files.stories,
    outputDir,
    systemName: trimToString(bundle.appContext.appName) || trimToString(bundle.appContext.moduleName) || "System",
    repoRoot,
    progress
  });

  return {
    inputDir: bundle.inputDir,
    artifacts: state.artifacts,
    summary: state.summary,
    status: state.status,
    command: state.command
  };
}

function generateProcessVisualizerArtifactsFromInputDir({
  inputDir,
  outputDir = inputDir,
  model = DEFAULT_PROCESS_VISUALIZER_MODEL,
  ollamaUrl = DEFAULT_OLLAMA_URL,
  repoRoot = process.cwd(),
  onProgress = null,
  runProcessVisualizerImpl = runProcessVisualizer
}) {
  const progress = typeof onProgress === "function" ? onProgress : () => {};
  const bundle = loadInputBundle(inputDir);
  const state = runProcessVisualizerImpl({
    inputPath: bundle.files.stories,
    outputDir,
    model,
    ollamaUrl,
    repoRoot,
    progress
  });

  return {
    inputDir: bundle.inputDir,
    artifacts: state.artifacts,
    summary: state.summary,
    status: state.status,
    command: state.command
  };
}

async function generatePlanFromInputDir({
  inputDir,
  outPath,
  model = DEFAULT_OLLAMA_MODEL,
  processVisualizerModel = DEFAULT_PROCESS_VISUALIZER_MODEL,
  ollamaUrl = DEFAULT_OLLAMA_URL,
  mockOllamaResponsePath = "",
  fetchImpl = globalThis.fetch,
  onProgress = null,
  useExamplePlans = true,
  useKnowledge = true,
  useVisualNarrator = true,
  useProcessVisualizer = true,
  strictProcessVisualizer = true,
  allowRepairPass = false,
  strictRepairPass = false,
  llmRetries = 0,
  llmRetryDelayMs = 0,
  seed = null,
  minStoryCoverage = null,
  mockVisualNarratorResponsePath = "",
  mockProcessVisualizerResponsePath = "",
  examplePlanPaths = DEFAULT_EXAMPLE_PLAN_PATHS,
  knowledgeDir = DEFAULT_KNOWLEDGE_DIR,
  generationDebugStopAfter = "",
  runVisualNarratorImpl = runVisualNarrator,
  runProcessVisualizerImpl = runProcessVisualizer
}) {
  const progress = typeof onProgress === "function" ? onProgress : () => {};
  const absoluteOutPath = path.resolve(outPath);
  const outputDir = path.dirname(absoluteOutPath);
  const ollamaOptions = buildOllamaOptions({ seed });

  const bundle = runInputBundleStage({
    inputDir,
    loadInputBundle,
    progress
  });
  const { visualNarrator, processVisualizer } = runPreprocessingStages({
    bundle,
    outputDir,
    model,
    processVisualizerModel,
    ollamaUrl,
    useVisualNarrator,
    useProcessVisualizer,
    mockVisualNarratorResponsePath,
    mockProcessVisualizerResponsePath,
    runVisualNarratorImpl,
    runProcessVisualizerImpl,
    createVisualNarratorState,
    createProcessVisualizerState,
    loadMockVisualNarratorResult,
    loadMockProcessVisualizerResult,
    loadInputVisualNarratorResult,
    loadInputProcessVisualizerResult,
    trimToString,
    PlanGeneratorError,
    strictProcessVisualizer,
    progress
  });
  const baselineDraft = runBaselinePlannerStage({
    bundle,
    visualNarrator,
    processVisualizer,
    buildStoryDrivenBaselineDraft,
    PlanGeneratorError,
    progress
  });
  const generationMode = trimToString(bundle.appContext.generationMode) ||
    (mockOllamaResponsePath ? "legacy" : "multi-pass");
  const debugStopAfter = normalizeGenerationDebugStopAfter(generationDebugStopAfter) ||
    normalizeGenerationDebugStopAfter(bundle.appContext.generationDebugStopAfter);

  if (generationMode === "multi-pass") {
    const mergeWarnings = [];
    const sectionPasses = {};
    let llmPassCount = 0;

    progress("Stage 5/10: Entity pass building prompt...");
    const entityPass = await runSectionLlmStage({
      stageName: "Stage 5/10: Entity pass",
      prompt: buildEntityGenerationPrompt({
        stories: bundle.stories,
        domainInfo: bundle.domainInfo,
        visualNarrator,
        processVisualizer,
        baselineDraft
      }),
      schema: getEntityGenerationSchema(),
      model,
      ollamaUrl,
      fetchImpl,
      llmRetries,
      llmRetryDelayMs,
      callOllamaGenerate,
      ollamaOptions,
      progress
    });
    llmPassCount += 1;
    let { plan: finalPlan, metadata: entityMetadata } = applyEntityPass({
      baselinePlan: normalizeGeneratedPlan({
        generatedPlan: baselineDraft,
        appContext: bundle.appContext,
        stories: bundle.stories,
        domainInfo: bundle.domainInfo,
        warnings: []
      }).plan,
      entityResult: entityPass.generatedPlan,
      appContext: bundle.appContext,
      stories: bundle.stories,
      domainInfo: bundle.domainInfo,
      visualNarrator,
      processVisualizer,
      warnings: mergeWarnings
    });
    sectionPasses.entity = createSectionMetadata("completed", entityPass, entityMetadata);

    progress("Stage 6/10: Entity coverage pass building prompt...");
    const entityCoveragePass = await runEntityCoverageStage({
      bundle,
      visualNarrator,
      processVisualizer,
      plan: finalPlan,
      model,
      ollamaUrl,
      fetchImpl,
      llmRetries,
      llmRetryDelayMs,
      callOllamaGenerate,
      ollamaOptions,
      progress
    });
    llmPassCount += entityCoveragePass.chunks || 1;
    const entityCoverage = entityCoveragePass.generatedPlan || {};
    const coverageApplication = applyCoverageEntityCandidates({
      plan: finalPlan,
      entityCoverage,
      stories: bundle.stories,
      warnings: mergeWarnings
    });
    sectionPasses.coverage = createSectionMetadata(
      "completed",
      entityCoveragePass,
      {
        ...applyEntityCoveragePass({ coverageResult: entityCoverage }),
        ...coverageApplication
      }
    );

    const domainModelReview = await runDomainModelReviewStage({
      plan: finalPlan,
      bundle,
      visualNarrator,
      processVisualizer,
      entityCoverage,
      model,
      ollamaUrl,
      fetchImpl,
      callOllamaGenerate,
      ollamaOptions,
      progress,
      warnings: mergeWarnings,
      mockOllamaResponsePath: ""
    });

    llmPassCount += 1;
    const associationGeneration = await runAssociationGenerationStage({
      plan: finalPlan,
      bundle,
      visualNarrator,
      processVisualizer,
      entityCoverage,
      model,
      ollamaUrl,
      fetchImpl,
      callOllamaGenerate,
      ollamaOptions,
      progress,
      warnings: mergeWarnings,
      mockOllamaResponsePath: ""
    });

    progress("Stage 8/10: Generating security, behavior, and pages...");
    progress("Security pass building prompt...");
    const securityPass = await runSectionLlmStage({
      stageName: "Security pass",
      prompt: buildSecurityGenerationPrompt({
        stories: bundle.stories,
        domainInfo: bundle.domainInfo,
        appContext: bundle.appContext,
        domainModel: finalPlan.domainModel
      }),
      schema: getSecurityGenerationSchema(),
      model,
      ollamaUrl,
      fetchImpl,
      llmRetries,
      llmRetryDelayMs,
      callOllamaGenerate,
      ollamaOptions,
      progress
    });
    llmPassCount += 1;
    sectionPasses.security = createSectionMetadata(
      "completed",
      securityPass,
      applySecurityPass({
        plan: finalPlan,
        securityResult: securityPass.generatedPlan,
        appContext: bundle.appContext,
        stories: bundle.stories,
        domainInfo: bundle.domainInfo,
        warnings: mergeWarnings
      })
    );

    progress("Behavior pass building prompt...");
    const behaviorPass = await runSectionLlmStage({
      stageName: "Behavior pass",
      prompt: buildBehaviorGenerationPrompt({
        stories: bundle.stories,
        domainInfo: bundle.domainInfo,
        domainModel: finalPlan.domainModel,
        security: finalPlan.security
      }),
      schema: getBehaviorGenerationSchema(),
      model,
      ollamaUrl,
      fetchImpl,
      llmRetries,
      llmRetryDelayMs,
      callOllamaGenerate,
      ollamaOptions,
      progress
    });
    llmPassCount += 1;
    sectionPasses.behavior = createSectionMetadata(
      "completed",
      behaviorPass,
      applyBehaviorPass({ plan: finalPlan, behaviorResult: behaviorPass.generatedPlan, warnings: mergeWarnings })
    );
    ensureWorkflowScaffold(finalPlan, bundle.stories, mergeWarnings, bundle.domainInfo);

    progress("Page pass building prompt...");
    let pagePass = null;
    let pagePassResult = null;
    try {
      pagePass = await runSectionLlmStage({
        stageName: "Page pass",
        prompt: buildPageGenerationPrompt({
          stories: bundle.stories,
          domainInfo: bundle.domainInfo,
          appContext: bundle.appContext,
          domainModel: finalPlan.domainModel,
          security: finalPlan.security,
          microflows: finalPlan.microflows,
          nanoflows: finalPlan.nanoflows,
          workflows: finalPlan.workflows
        }),
        schema: getPageGenerationSchema(),
        model,
        ollamaUrl,
        fetchImpl,
        llmRetries,
        llmRetryDelayMs,
        callOllamaGenerate,
        ollamaOptions,
        progress
      });
      llmPassCount += 1;
      pagePassResult = pagePass.generatedPlan;
      sectionPasses.pages = createSectionMetadata(
        "completed",
        pagePass,
        applyPagePass({
          plan: finalPlan,
          pageResult: pagePassResult,
          appContext: bundle.appContext,
          stories: bundle.stories,
          visualNarrator,
          processVisualizer,
          warnings: mergeWarnings
        })
      );
    } catch (err) {
      llmPassCount += 1;
      const message = err && err.message ? err.message : String(err);
      const warning = `Page pass failed; continuing with baseline and generated CRUD pages: ${message}`;
      progress(warning);
      mergeWarnings.push(warning);
      sectionPasses.pages = {
        enabled: true,
        status: "llm_unavailable",
        model,
        promptEvalCount: 0,
        evalCount: 0,
        totalDuration: 0,
        warnings: [warning],
        error: message,
        fallback: "baseline_and_crud_pages"
      };
    }

    progress("Stage 9/10: Final repair and validation prep...");
    const debugArtifacts = writeGenerationDebugArtifacts({
      absoluteOutPath,
      finalPlan,
      pagePassResult,
      progress
    });
    if (debugStopAfter === "page-pass" || debugStopAfter === "pre-final-repair") {
      progress(`Stage 10/10: Debug stop after ${debugStopAfter}; writing current plan to ${absoluteOutPath}...`);
      writeJsonArtifact(absoluteOutPath, finalPlan);
      return {
        planPath: absoluteOutPath,
        reportPath: "",
        warnings: mergeWarnings,
        model,
        validationErrors: [],
        visualNarrator: visualNarrator,
        processVisualizer: processVisualizer,
        stoppedEarly: true,
        debugStopAfter,
        debugArtifacts
      };
    }
    const finalRepairSteps = [];
    const finalRepairInputSanitization = runFinalRepairStep(
      "sanitizeFinalRepairInput",
      () => sanitizeFinalRepairInput(finalPlan, mergeWarnings),
      finalRepairSteps,
      mergeWarnings
    );
    runFinalRepairStep("normalizeReferenceSetAssociationsForDropdownInputs", () => normalizeReferenceSetAssociationsForDropdownInputs(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
    const modulePrefixedEntityCleanup = runFinalRepairStep("removeModulePrefixedDuplicateEntities", () => removeModulePrefixedDuplicateEntities(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
    const roleSuffixedEntityCleanup = runFinalRepairStep("removeRoleSuffixedDuplicateEntities", () => removeRoleSuffixedDuplicateEntities(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
    const entityDeduplication = runFinalRepairStep("dedupeDomainModelEntities", () => dedupeDomainModelEntities(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
    const domainModelNamespaceReconciliation = runFinalRepairStep("reconcileDomainModelNamespaceNames", () => reconcileDomainModelNamespaceNames(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
    runFinalRepairStep("ensureEntityCrudPages", () => ensureEntityCrudPages(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
    const pageAttributeReconciliation = runFinalRepairStep("reconcilePageAttributeRefs", () => reconcilePageAttributeRefs(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
    runFinalRepairStep("ensureWorkflowStartButtons", () => ensureWorkflowStartButtons(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
    runFinalRepairStep("ensureNavigationSpecAndHomeButtons", () => ensureNavigationSpecAndHomeButtons(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
    const coverage = evaluateStoryCoverage(finalPlan, bundle.stories, visualNarrator.summary, processVisualizer.summary);

    const planDiagnostics = applyPlanMetadata({
      finalPlan,
      bundle,
      visualNarrator,
      processVisualizer,
      coverage,
      domainModelReview,
      associationGeneration,
      sectionPasses,
      deriveStoryCapabilityBaseline,
      collectPlanCapabilityRequirements
    });
    planDiagnostics.pageAttributeReconciliation = pageAttributeReconciliation;
    planDiagnostics.entityDeduplication = entityDeduplication;
    planDiagnostics.modulePrefixedEntityCleanup = modulePrefixedEntityCleanup;
    planDiagnostics.roleSuffixedEntityCleanup = roleSuffixedEntityCleanup;
    planDiagnostics.domainModelNamespaceReconciliation = domainModelNamespaceReconciliation;
    planDiagnostics.finalRepairInputSanitization = finalRepairInputSanitization;
    planDiagnostics.finalRepairSteps = finalRepairSteps;
    planDiagnostics.debugArtifacts = debugArtifacts;

    const allWarnings = mergeWarnings.concat(
      ...Object.values(sectionPasses).map((entry) => Array.isArray(entry.warnings) ? entry.warnings : [])
    );

    progress("Stage 9/10: Validating plan schema and runtime guards...");
    const validationErrors = validatePlan(finalPlan);
    if (validationErrors.length > 0) {
      throw new PlanGeneratorError("Generated plan failed validation.", validationErrors);
    }

    const coverageGate = buildCoverageGate({
      coverage,
      minStoryCoverage,
      PlanGeneratorError
    });
    const report = buildGenerationReport({
      bundle,
      absoluteOutPath,
      allWarnings,
      model,
      coverage,
      coverageGate,
      llmResult: entityPass,
      visualNarrator,
      processVisualizer,
      domainModelReview,
      associationGeneration,
      sectionPasses,
      planDiagnostics,
      llmPassCount,
      allowRepairPass,
      generationMode,
      constants: {
        OLLAMA_NUM_CTX,
        OLLAMA_NUM_PREDICT
      },
      ollamaOptions,
      reproducibility: buildReproducibilitySection({
        bundle,
        model,
        processVisualizerModel,
        ollamaUrl,
        ollamaOptions,
        useExamplePlans,
        useKnowledge,
        useVisualNarrator,
        useProcessVisualizer,
        examplePlanPaths,
        knowledgeDir
      })
    });
    const reportPath = writeGenerationArtifacts({
      absoluteOutPath,
      finalPlan,
      report,
      progress
    });

    assertCoverageGate({
      coverageGate,
      coverage,
      PlanGeneratorError
    });

    progress("Stage 10/10: Generation complete.");

    return {
      planPath: absoluteOutPath,
      reportPath,
      warnings: allWarnings,
      model: report.model,
      validationErrors: [],
      visualNarrator: report.visualNarrator,
      processVisualizer: report.processVisualizer
    };
  }

  const { prompt, promptWarnings } = runPromptBuilderStage({
    bundle,
    visualNarrator,
    processVisualizer,
    baselineDraft,
    useExamplePlans,
    useKnowledge,
    examplePlanPaths,
    knowledgeDir,
    buildExamplePlansBlock,
    buildKnowledgeBlock,
    buildOllamaPrompt,
    progress
  });
  let firstPass;
  try {
    firstPass = await runFirstLlmPassStage({
      prompt,
      model,
      ollamaUrl,
      mockOllamaResponsePath,
      fetchImpl,
      llmRetries,
      llmRetryDelayMs,
      loadMockGeneratedPlan,
      callOllamaGenerate,
      ollamaOptions,
      progress
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    progress(`Stage 6/10: LLM first pass failed after retries; aborting generation (${message}).`);
    throw new PlanGeneratorError(`LLM first pass failed after retries: ${message}`);
  }
  const { llmResult, llmCallWarnings } = firstPass;
  let llmPassCount = firstPass.llmPassCount;
  const { baselineNormalized, llmNormalized } = runPlanNormalizerStage({
    baselineDraft,
    llmResult,
    bundle,
    promptWarnings,
    normalizeGeneratedPlan,
    progress
  });
  let { finalPlan, mergeWarnings, coverage } = runPlanMergerStage({
    bundle,
    visualNarrator,
    processVisualizer,
    baselineNormalized,
    llmNormalized,
    mergePlanCandidates,
    ensureWorkflowScaffold,
    ensureNavigationSpecAndHomeButtons,
    evaluateStoryCoverage,
    progress
  });

  if (allowRepairPass && !mockOllamaResponsePath && coverage.score + 1e-9 < COVERAGE_TARGET_SCORE && coverage.missingStories.length > 0) {
    llmPassCount += 1;
    let repairResult = null;
    try {
      repairResult = await runRepairLlmPassStage({
        stories: bundle.stories,
        coverage,
        currentPlan: finalPlan,
        appContext: bundle.appContext,
        model,
        ollamaUrl,
        fetchImpl,
        llmRetries,
        llmRetryDelayMs,
        buildRepairPrompt,
        callOllamaGenerate,
        ollamaOptions,
        progress
      });
    } catch (err) {
      if (strictRepairPass) throw err;
      mergeWarnings.push(`Repair pass failed; continuing with previous merged plan: ${err && err.message ? err.message : String(err)}`);
    }

    if (repairResult) {
      const repairNormalized = normalizeRepairPlan({
        repairResult,
        bundle,
        normalizeGeneratedPlan
      });
      const { repairedPlan, repairedWarnings, repairedCoverage } = mergeRepairPlan({
        finalPlan,
        repairNormalized,
        bundle,
        visualNarrator,
        processVisualizer,
        mergePlanCandidates,
        ensureWorkflowScaffold,
        ensureNavigationSpecAndHomeButtons,
        evaluateStoryCoverage
      });

      if (repairedCoverage.score >= coverage.score + COVERAGE_REPAIR_MIN_GAIN || repairedCoverage.score >= COVERAGE_TARGET_SCORE) {
        finalPlan = repairedPlan;
        coverage = repairedCoverage;
        mergeWarnings.push(...repairedWarnings);
        mergeWarnings.push("Applied repair pass to improve story coverage.");
      } else {
        mergeWarnings.push("Repair pass did not materially improve coverage; keeping previous merged plan.");
      }
    }
  }

  const domainModelReview = await runDomainModelReviewStage({
    plan: finalPlan,
    bundle,
    visualNarrator,
    processVisualizer,
    entityCoverage: {},
    model,
    ollamaUrl,
    fetchImpl,
    callOllamaGenerate,
    ollamaOptions,
    progress,
    warnings: mergeWarnings,
    mockOllamaResponsePath
  });
  let associationGeneration = { enabled: false, status: "skipped", rawAssociationCount: 0, acceptedAssociations: [], rejectedAssociations: [], entityCoverage: [], warnings: [] };
  if (!mockOllamaResponsePath) {
    llmPassCount += 1;
    associationGeneration = await runAssociationGenerationStage({
      plan: finalPlan,
      bundle,
      visualNarrator,
      processVisualizer,
      entityCoverage: {},
      model,
      ollamaUrl,
      fetchImpl,
      callOllamaGenerate,
      ollamaOptions,
      progress,
      warnings: mergeWarnings,
      mockOllamaResponsePath
    });
  }
  progress("Stage 9/10: Final repair and validation prep...");
  const debugArtifacts = writeGenerationDebugArtifacts({
    absoluteOutPath,
    finalPlan,
    progress
  });
  if (debugStopAfter === "pre-final-repair") {
    progress(`Stage 10/10: Debug stop after ${debugStopAfter}; writing current plan to ${absoluteOutPath}...`);
    writeJsonArtifact(absoluteOutPath, finalPlan);
    return {
      planPath: absoluteOutPath,
      reportPath: "",
      warnings: mergeWarnings,
      model,
      validationErrors: [],
      visualNarrator,
      processVisualizer,
      stoppedEarly: true,
      debugStopAfter,
      debugArtifacts
    };
  }
  const finalRepairSteps = [];
  const finalRepairInputSanitization = runFinalRepairStep(
    "sanitizeFinalRepairInput",
    () => sanitizeFinalRepairInput(finalPlan, mergeWarnings),
    finalRepairSteps,
    mergeWarnings
  );
  runFinalRepairStep("normalizeReferenceSetAssociationsForDropdownInputs", () => normalizeReferenceSetAssociationsForDropdownInputs(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
  const modulePrefixedEntityCleanup = runFinalRepairStep("removeModulePrefixedDuplicateEntities", () => removeModulePrefixedDuplicateEntities(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
  const roleSuffixedEntityCleanup = runFinalRepairStep("removeRoleSuffixedDuplicateEntities", () => removeRoleSuffixedDuplicateEntities(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
  const entityDeduplication = runFinalRepairStep("dedupeDomainModelEntities", () => dedupeDomainModelEntities(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
  const domainModelNamespaceReconciliation = runFinalRepairStep("reconcileDomainModelNamespaceNames", () => reconcileDomainModelNamespaceNames(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
  runFinalRepairStep("ensureEntityCrudPages", () => ensureEntityCrudPages(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
  const pageAttributeReconciliation = runFinalRepairStep("reconcilePageAttributeRefs", () => reconcilePageAttributeRefs(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
  runFinalRepairStep("ensureWorkflowStartButtons", () => ensureWorkflowStartButtons(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
  runFinalRepairStep("ensureNavigationSpecAndHomeButtons", () => ensureNavigationSpecAndHomeButtons(finalPlan, mergeWarnings), finalRepairSteps, mergeWarnings);
  coverage = evaluateStoryCoverage(finalPlan, bundle.stories, visualNarrator.summary, processVisualizer.summary);

  const planDiagnostics = applyPlanMetadata({
    finalPlan,
    bundle,
    visualNarrator,
    processVisualizer,
    coverage,
    domainModelReview,
    associationGeneration,
    deriveStoryCapabilityBaseline,
    collectPlanCapabilityRequirements
  });
  planDiagnostics.pageAttributeReconciliation = pageAttributeReconciliation;
  planDiagnostics.entityDeduplication = entityDeduplication;
  planDiagnostics.modulePrefixedEntityCleanup = modulePrefixedEntityCleanup;
  planDiagnostics.roleSuffixedEntityCleanup = roleSuffixedEntityCleanup;
  planDiagnostics.domainModelNamespaceReconciliation = domainModelNamespaceReconciliation;
  planDiagnostics.finalRepairInputSanitization = finalRepairInputSanitization;
  planDiagnostics.finalRepairSteps = finalRepairSteps;
  planDiagnostics.debugArtifacts = debugArtifacts;

  const allWarnings = baselineNormalized.warnings.concat(llmNormalized.warnings).concat(mergeWarnings).concat(llmCallWarnings);

  progress("Stage 9/10: Validating plan schema and runtime guards...");
  const validationErrors = validatePlan(finalPlan);
  if (validationErrors.length > 0) {
    throw new PlanGeneratorError("Generated plan failed validation.", validationErrors);
  }

  const coverageGate = buildCoverageGate({
    coverage,
    minStoryCoverage,
    PlanGeneratorError
  });
  const report = buildGenerationReport({
    bundle,
    absoluteOutPath,
    allWarnings,
    model,
    coverage,
    coverageGate,
    llmResult,
    visualNarrator,
    processVisualizer,
    domainModelReview,
    associationGeneration,
    planDiagnostics,
    llmPassCount,
    allowRepairPass,
    generationMode,
    constants: {
      OLLAMA_NUM_CTX,
      OLLAMA_NUM_PREDICT
    },
    ollamaOptions,
    reproducibility: buildReproducibilitySection({
      bundle,
      prompt,
      model,
      processVisualizerModel,
      ollamaUrl,
      ollamaOptions,
      useExamplePlans,
      useKnowledge,
      useVisualNarrator,
      useProcessVisualizer,
      examplePlanPaths,
      knowledgeDir
    })
  });
  const reportPath = writeGenerationArtifacts({
    absoluteOutPath,
    finalPlan,
    report,
    progress
  });

  assertCoverageGate({
    coverageGate,
    coverage,
    PlanGeneratorError
  });

  progress("Stage 10/10: Generation complete.");

  return {
    planPath: absoluteOutPath,
    reportPath,
    warnings: allWarnings,
    model: report.model,
    validationErrors: [],
    visualNarrator: report.visualNarrator,
    processVisualizer: report.processVisualizer
  };
}

module.exports = {
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_PROCESS_VISUALIZER_MODEL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_KNOWLEDGE_DIR,
  DEFAULT_EXAMPLE_PLAN_PATHS,
  SUPPORTED_PAGE_STEP_TYPES: Array.from(SUPPORTED_PAGE_STEP_TYPES),
  SUPPORTED_MICROFLOW_ACTION_TYPES,
  PlanGeneratorError,
  validateAppContext,
  loadInputBundle,
  buildStoryDrivenBaselineDraft,
  buildOllamaPrompt,
  normalizeGeneratedPlan,
  applyCoverageEntityCandidates,
  applyDomainModelReview,
  applyAssociationGeneration,
  applyDeterministicAssociationEvidence,
  collectDeterministicAssociationHints,
  auditAssociationGaps,
  runAssociationGenerationStage,
  ensureWorkflowScaffold,
  ensureWorkflowStartButtons,
  ensureEntityCrudPages,
  ensureNavigationSpecAndHomeButtons,
  callOllamaGenerate,
  evaluateStoryCoverage,
  detectVisualNarratorInputArtifacts,
  detectProcessVisualizerInputArtifacts,
  loadInputVisualNarratorResult,
  loadInputProcessVisualizerResult,
  generateVisualNarratorArtifactsFromInputDir,
  generateProcessVisualizerArtifactsFromInputDir,
  generatePlanFromInputDir
};
