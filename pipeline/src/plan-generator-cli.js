const path = require("path");

const {
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_PROCESS_VISUALIZER_MODEL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_KNOWLEDGE_DIR,
  DEFAULT_EXAMPLE_PLAN_PATHS,
  PlanGeneratorError,
  generatePlanFromInputDir
} = require("./plan-generator");

function parseArgs(argv) {
  const out = {
    inputDir: "input",
    outPath: path.join("src", "plans", "_scratch", "generated-plan.json"),
    model: DEFAULT_OLLAMA_MODEL,
    processVisualizerModel: DEFAULT_PROCESS_VISUALIZER_MODEL,
    ollamaUrl: DEFAULT_OLLAMA_URL,
    mockOllamaResponsePath: "",
    mockVisualNarratorResponsePath: "",
    mockProcessVisualizerResponsePath: "",
    useExamplePlans: true,
    useKnowledge: true,
    useVisualNarrator: true,
    useProcessVisualizer: true,
    strictProcessVisualizer: true,
    allowRepairPass: false,
    strictRepairPass: false,
    llmRetries: 0,
    llmRetryDelayMs: 0,
    seed: null,
    minStoryCoverage: null,
    stopAfter: "",
    knowledgeDir: DEFAULT_KNOWLEDGE_DIR,
    examplePlanPaths: DEFAULT_EXAMPLE_PLAN_PATHS.slice(),
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }

    if (arg === "--input-dir") {
      out.inputDir = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--input-dir=")) {
      out.inputDir = arg.slice("--input-dir=".length);
      continue;
    }

    if (arg === "--out") {
      out.outPath = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      out.outPath = arg.slice("--out=".length);
      continue;
    }

    if (arg === "--model") {
      out.model = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      out.model = arg.slice("--model=".length);
      continue;
    }

    if (arg === "--process-viz-model") {
      out.processVisualizerModel = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--process-viz-model=")) {
      out.processVisualizerModel = arg.slice("--process-viz-model=".length);
      continue;
    }

    if (arg === "--ollama-url") {
      out.ollamaUrl = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--ollama-url=")) {
      out.ollamaUrl = arg.slice("--ollama-url=".length);
      continue;
    }

    if (arg === "--mock-ollama-response") {
      out.mockOllamaResponsePath = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--mock-ollama-response=")) {
      out.mockOllamaResponsePath = arg.slice("--mock-ollama-response=".length);
      continue;
    }

    if (arg === "--mock-vn-response") {
      out.mockVisualNarratorResponsePath = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--mock-vn-response=")) {
      out.mockVisualNarratorResponsePath = arg.slice("--mock-vn-response=".length);
      continue;
    }

    if (arg === "--mock-process-viz-response") {
      out.mockProcessVisualizerResponsePath = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--mock-process-viz-response=")) {
      out.mockProcessVisualizerResponsePath = arg.slice("--mock-process-viz-response=".length);
      continue;
    }

    if (arg === "--no-examples") {
      out.useExamplePlans = false;
      continue;
    }

    if (arg === "--no-knowledge") {
      out.useKnowledge = false;
      continue;
    }

    if (arg === "--no-vn") {
      out.useVisualNarrator = false;
      continue;
    }

    if (arg === "--no-process-viz") {
      out.useProcessVisualizer = false;
      continue;
    }

    if (arg === "--strict-process-viz") {
      out.strictProcessVisualizer = true;
      continue;
    }

    if (arg === "--allow-repair-pass") {
      out.allowRepairPass = true;
      continue;
    }

    if (arg === "--strict-repair-pass") {
      out.strictRepairPass = true;
      continue;
    }

    if (arg === "--llm-retries") {
      out.llmRetries = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--llm-retries=")) {
      out.llmRetries = arg.slice("--llm-retries=".length);
      continue;
    }

    if (arg === "--llm-retry-delay-ms") {
      out.llmRetryDelayMs = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--llm-retry-delay-ms=")) {
      out.llmRetryDelayMs = arg.slice("--llm-retry-delay-ms=".length);
      continue;
    }

    if (arg === "--seed") {
      out.seed = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--seed=")) {
      out.seed = arg.slice("--seed=".length);
      continue;
    }

    if (arg === "--min-story-coverage") {
      out.minStoryCoverage = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--min-story-coverage=")) {
      out.minStoryCoverage = arg.slice("--min-story-coverage=".length);
      continue;
    }

    if (arg === "--stop-after") {
      out.stopAfter = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--stop-after=")) {
      out.stopAfter = arg.slice("--stop-after=".length);
      continue;
    }

    if (arg === "--knowledge-dir") {
      out.knowledgeDir = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--knowledge-dir=")) {
      out.knowledgeDir = arg.slice("--knowledge-dir=".length);
      continue;
    }
  }

  return out;
}

function normalizeNumberOption(value, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value === null || value === undefined || value === "") return value;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new PlanGeneratorError(`${label} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}.`);
  }
  return number;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node src/plan-generator-cli.js --input-dir=<input-dir> --out=<plan-path>",
      "",
      "Options:",
      "  --input-dir <path>            Input folder (default: input)",
      "  --out <path>                  Output plan path (default: src/plans/_scratch/generated-plan.json)",
      `  --model <name>                Ollama model (default: ${DEFAULT_OLLAMA_MODEL})`,
      `  --process-viz-model <name>    Process Visualizer Ollama model (default: ${DEFAULT_PROCESS_VISUALIZER_MODEL})`,
      `  --ollama-url <url>            Ollama base URL (default: ${DEFAULT_OLLAMA_URL})`,
      "  --mock-ollama-response <path> Use local JSON instead of calling Ollama (test helper)",
      "  --mock-process-viz-response <path> Use local JSON instead of running Process Visualizer (test helper)",
      "                               When canonical VN/PV artifacts exist in input-dir, they are used automatically.",
      "  --allow-repair-pass          Allow a second LLM repair pass when coverage is incomplete",
      "  --strict-repair-pass         Fail generation when the optional repair pass fails",
      "  --llm-retries <count>        Retry failed Ollama calls before failing (default: 0)",
      "  --llm-retry-delay-ms <ms>    Delay between LLM retries (default: 0)",
      "  --seed <integer>            Ollama seed for reproducible generation",
      "  --min-story-coverage <0..1>  Fail generation when story coverage is below this score",
      "  --stop-after <stage>         Stop after page-pass or pre-final-repair and write debug artifacts",
      "  --no-vn                       Disable Visual Narrator preprocessing",
      "  --no-process-viz              Disable Process Visualizer preprocessing",
      "  --strict-process-viz          Fail generation when Process Visualizer errors (default)",
      "  --no-examples                 Disable plan examples in prompt",
      `  --knowledge-dir <path>        Mendix LLM context directory (default: ${DEFAULT_KNOWLEDGE_DIR})`,
      "  --no-knowledge                Disable Mendix knowledge injection",
      "  --help                        Show this help"
    ].join("\n")
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.inputDir) {
    throw new PlanGeneratorError("--input-dir is required.");
  }
  if (!args.outPath) {
    throw new PlanGeneratorError("--out is required.");
  }

  args.minStoryCoverage = normalizeNumberOption(args.minStoryCoverage, "--min-story-coverage", { min: 0, max: 1 });
  args.llmRetries = normalizeNumberOption(args.llmRetries, "--llm-retries", { min: 0, max: 100, integer: true });
  args.llmRetryDelayMs = normalizeNumberOption(args.llmRetryDelayMs, "--llm-retry-delay-ms", { min: 0, max: 3600000, integer: true });
  args.seed = args.seed === null ? null : normalizeNumberOption(args.seed, "--seed", {
    min: Number.MIN_SAFE_INTEGER,
    max: Number.MAX_SAFE_INTEGER,
    integer: true
  });

  const startedAt = Date.now();
  function progress(message) {
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(`[generate:plan +${elapsedSec}s] ${message}`);
  }

  const result = await generatePlanFromInputDir({
    inputDir: args.inputDir,
    outPath: args.outPath,
    model: args.model || DEFAULT_OLLAMA_MODEL,
    processVisualizerModel: args.processVisualizerModel || DEFAULT_PROCESS_VISUALIZER_MODEL,
    ollamaUrl: args.ollamaUrl || DEFAULT_OLLAMA_URL,
    mockOllamaResponsePath: args.mockOllamaResponsePath,
    mockVisualNarratorResponsePath: args.mockVisualNarratorResponsePath,
    mockProcessVisualizerResponsePath: args.mockProcessVisualizerResponsePath,
    onProgress: progress,
    useExamplePlans: args.useExamplePlans,
    useKnowledge: args.useKnowledge,
    useVisualNarrator: args.useVisualNarrator,
    useProcessVisualizer: args.useProcessVisualizer,
    strictProcessVisualizer: args.strictProcessVisualizer,
    allowRepairPass: args.allowRepairPass,
    strictRepairPass: args.strictRepairPass,
    llmRetries: args.llmRetries,
    llmRetryDelayMs: args.llmRetryDelayMs,
    seed: args.seed,
    minStoryCoverage: args.minStoryCoverage,
    generationDebugStopAfter: args.stopAfter,
    knowledgeDir: args.knowledgeDir,
    examplePlanPaths: args.examplePlanPaths
  });

  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    if (err instanceof PlanGeneratorError) {
      console.error(`Failed: ${err.message}`);
      if (Array.isArray(err.details) && err.details.length > 0) {
        console.error(`- ${err.details.join("\n- ")}`);
      }
    } else {
      console.error(`Failed: ${err && err.message ? err.message : String(err)}`);
    }
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  printHelp,
  main
};
