const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { generatePlanFromInputDir, PlanGeneratorError } = require("./plan-generator");
const { checkPlanFile } = require("./lib/plan-checker");

function parseArgs(argv) {
  const out = {
    inputDir: "input",
    runsDir: path.join("artifacts", "pipeline-runs"),
    model: "",
    processVisualizerModel: "",
    ollamaUrl: "",
    noExamples: false,
    noKnowledge: false,
    noVn: false,
    noProcessViz: false,
    strictProcessViz: true,
    allowRepairPass: false,
    strictRepairPass: false,
    llmRetries: 0,
    llmRetryDelayMs: 0,
    minStoryCoverage: null,
    knowledgeDir: "",
    mockOllamaResponsePath: "",
    mockVisualNarratorResponsePath: "",
    mockProcessVisualizerResponsePath: "",
    validateOnly: false,
    runLabel: "",
    noAutoCommit: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input-dir") out.inputDir = argv[++i] || "";
    else if (arg.startsWith("--input-dir=")) out.inputDir = arg.slice("--input-dir=".length);
    else if (arg === "--runs-dir") out.runsDir = argv[++i] || "";
    else if (arg.startsWith("--runs-dir=")) out.runsDir = arg.slice("--runs-dir=".length);
    else if (arg === "--model") out.model = argv[++i] || "";
    else if (arg.startsWith("--model=")) out.model = arg.slice("--model=".length);
    else if (arg === "--process-viz-model") out.processVisualizerModel = argv[++i] || "";
    else if (arg.startsWith("--process-viz-model=")) {
      out.processVisualizerModel = arg.slice("--process-viz-model=".length);
    }
    else if (arg === "--ollama-url") out.ollamaUrl = argv[++i] || "";
    else if (arg.startsWith("--ollama-url=")) out.ollamaUrl = arg.slice("--ollama-url=".length);
    else if (arg === "--knowledge-dir") out.knowledgeDir = argv[++i] || "";
    else if (arg.startsWith("--knowledge-dir=")) out.knowledgeDir = arg.slice("--knowledge-dir=".length);
    else if (arg === "--mock-ollama-response") out.mockOllamaResponsePath = argv[++i] || "";
    else if (arg.startsWith("--mock-ollama-response=")) {
      out.mockOllamaResponsePath = arg.slice("--mock-ollama-response=".length);
    } else if (arg === "--mock-vn-response") out.mockVisualNarratorResponsePath = argv[++i] || "";
    else if (arg.startsWith("--mock-vn-response=")) {
      out.mockVisualNarratorResponsePath = arg.slice("--mock-vn-response=".length);
    } else if (arg === "--mock-process-viz-response") out.mockProcessVisualizerResponsePath = argv[++i] || "";
    else if (arg.startsWith("--mock-process-viz-response=")) {
      out.mockProcessVisualizerResponsePath = arg.slice("--mock-process-viz-response=".length);
    } else if (arg === "--run-label") out.runLabel = argv[++i] || "";
    else if (arg.startsWith("--run-label=")) out.runLabel = arg.slice("--run-label=".length);
    else if (arg === "--no-examples") out.noExamples = true;
    else if (arg === "--no-knowledge") out.noKnowledge = true;
    else if (arg === "--no-vn") out.noVn = true;
    else if (arg === "--no-process-viz") out.noProcessViz = true;
    else if (arg === "--strict-process-viz") out.strictProcessViz = true;
    else if (arg === "--allow-repair-pass") out.allowRepairPass = true;
    else if (arg === "--strict-repair-pass") out.strictRepairPass = true;
    else if (arg === "--llm-retries") out.llmRetries = argv[++i] || "";
    else if (arg.startsWith("--llm-retries=")) out.llmRetries = arg.slice("--llm-retries=".length);
    else if (arg === "--llm-retry-delay-ms") out.llmRetryDelayMs = argv[++i] || "";
    else if (arg.startsWith("--llm-retry-delay-ms=")) out.llmRetryDelayMs = arg.slice("--llm-retry-delay-ms=".length);
    else if (arg === "--min-story-coverage") out.minStoryCoverage = argv[++i] || "";
    else if (arg.startsWith("--min-story-coverage=")) out.minStoryCoverage = arg.slice("--min-story-coverage=".length);
    else if (arg === "--validate-only") out.validateOnly = true;
    else if (arg === "--no-auto-commit") out.noAutoCommit = true;
  }

  return out;
}

function formatUtcStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate())
  ].join("") + "-" + [pad(date.getUTCHours()), pad(date.getUTCMinutes()), pad(date.getUTCSeconds())].join("");
}

function toSafeSlug(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node pipeline/e2e-runner.js [options]",
      "",
      "Options:",
      "  --input-dir <path>            Input folder (default: input)",
      "  --runs-dir <path>             Root folder for run outputs (default: artifacts/pipeline-runs)",
      "  --run-label <text>            Optional suffix in run folder name",
      "  --model <name>                Ollama model override",
      "  --process-viz-model <name>    Process Visualizer Ollama model override",
      "  --ollama-url <url>            Ollama URL override",
      "  --knowledge-dir <path>        LLM context directory override",
      "  --no-examples                 Disable example plan injection",
      "  --no-knowledge                Disable documentation injection",
      "  --no-vn                       Disable Visual Narrator preprocessing",
      "  --no-process-viz              Disable Process Visualizer preprocessing",
      "  --strict-process-viz          Fail generation when Process Visualizer errors (default)",
      "  --allow-repair-pass           Allow a second LLM repair pass when coverage is incomplete",
      "  --strict-repair-pass          Fail generation when the optional repair pass fails",
      "  --llm-retries <count>         Retry failed Ollama calls before failing (default: 0)",
      "  --llm-retry-delay-ms <ms>     Delay between LLM retries (default: 0)",
      "  --min-story-coverage <0..1>   Fail generation when story coverage is below this score",
      "  --mock-ollama-response <path> Use mock LLM response JSON",
      "  --mock-process-viz-response <path> Use mock Process Visualizer response JSON",
      "  --validate-only               Run commander validation only (no app build)",
      "  --no-auto-commit              Keep plan commit setting as-is",
      "  --help                        Show this help"
    ].join("\n")
  );
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function parseCommanderKeyValueSummary(stdout) {
  const summary = {};
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
    summary[key] = match[2];
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

function parseCommanderOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_err) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (_nestedErr) {
        // Fall through to line-based summary parsing.
      }
    }
  }

  const summary = parseCommanderKeyValueSummary(text);
  if (!summary) return null;
  return {
    ok: !/^failed\b/i.test(String(summary.status || "")),
    summary
  };
}

function formatPlanCheckerFailure(checkResult) {
  const lines = [];
  if (!checkResult || typeof checkResult !== "object") {
    return "plan-checker failed without details.";
  }

  if (Array.isArray(checkResult.validationErrors) && checkResult.validationErrors.length > 0) {
    lines.push(`validationErrors=${checkResult.validationErrors.length}`);
  }
  if (checkResult.referenceIntegrity && checkResult.referenceIntegrity.ok === false) {
    lines.push(`referenceIntegrityIssues=${checkResult.referenceIntegrity.issueCount || 0}`);
  }
  if (checkResult.stubFlags && checkResult.stubFlags.ok === false) {
    const flags = Array.isArray(checkResult.stubFlags.flags) ? checkResult.stubFlags.flags : [];
    lines.push(`stubFlags=${flags.join(", ") || "unknown"}`);
  }
  if (checkResult.storyCoverageScore !== null && checkResult.storyCoverageScore !== undefined) {
    lines.push(
      `storyCoverage=${checkResult.storyCoverageCovered}/${checkResult.storyCoverageTotal} (${Number(checkResult.storyCoverageScore).toFixed(3)})`
    );
  }

  return lines.length > 0 ? lines.join("; ") : "plan-checker returned ok=false.";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const startedAt = new Date();
  const stamp = formatUtcStamp(startedAt);
  const label = toSafeSlug(args.runLabel);
  const runId = label ? `${stamp}-${label}` : stamp;
  const runsRoot = path.resolve(args.runsDir || path.join("artifacts", "pipeline-runs"));
  const runDir = path.join(runsRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const planPath = path.join(runDir, "plan.json");
  const generatorStdoutPath = path.join(runDir, "generator-output.json");
  const commanderStdoutPath = path.join(runDir, "commander-output.json");
  const commanderStdoutLogPath = path.join(runDir, "commander.stdout.log");
  const commanderStderrLogPath = path.join(runDir, "commander.stderr.log");
  const planCheckOutputPath = path.join(runDir, "plan-checker-output.json");
  const runReportPath = path.join(runDir, "run-report.json");

  function progress(message) {
    const sec = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
    console.error(`[run:e2e ${runId} +${sec}s] ${message}`);
  }

  const runReport = {
    ok: false,
    runId,
    runDir,
    startedAt: startedAt.toISOString(),
    inputDir: path.resolve(args.inputDir),
    outputs: {
      planPath,
      generationReportPath: path.join(runDir, "generation-report.json"),
      generatorOutputPath: generatorStdoutPath,
      planCheckOutputPath,
      commanderOutputPath: commanderStdoutPath,
      commanderStdoutLogPath,
      commanderStderrLogPath
    },
    stages: []
  };

  try {
    progress("Generating plan...");
    const generation = await generatePlanFromInputDir({
      inputDir: args.inputDir,
      outPath: planPath,
      model: args.model || undefined,
      processVisualizerModel: args.processVisualizerModel || undefined,
      ollamaUrl: args.ollamaUrl || undefined,
      mockOllamaResponsePath: args.mockOllamaResponsePath || "",
      mockVisualNarratorResponsePath: args.mockVisualNarratorResponsePath || "",
      mockProcessVisualizerResponsePath: args.mockProcessVisualizerResponsePath || "",
      useExamplePlans: !args.noExamples,
      useKnowledge: !args.noKnowledge,
      useVisualNarrator: !args.noVn,
      useProcessVisualizer: !args.noProcessViz,
      strictProcessVisualizer: args.strictProcessViz,
      allowRepairPass: args.allowRepairPass,
      strictRepairPass: args.strictRepairPass,
      llmRetries: args.llmRetries,
      llmRetryDelayMs: args.llmRetryDelayMs,
      minStoryCoverage: args.minStoryCoverage,
      knowledgeDir: args.knowledgeDir || undefined,
      onProgress: (msg) => progress(`generate: ${msg}`)
    });
    writeJson(generatorStdoutPath, generation);
    runReport.stages.push({ stage: "generatePlan", ok: true, details: generation });

    if (!args.validateOnly && !args.noAutoCommit) {
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      plan.execution = plan.execution && typeof plan.execution === "object" ? plan.execution : {};
      if (plan.execution.commit !== true) {
        plan.execution.commit = true;
        if (!plan.execution.commitMessage) {
          plan.execution.commitMessage = `Pipeline E2E run ${runId}`;
        }
        fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");
        runReport.stages.push({
          stage: "autoCommit",
          ok: true,
          summary: "Set execution.commit=true for end-to-end run visibility in app."
        });
      }
    }

    progress("Checking generated plan...");
    const planCheck = checkPlanFile(planPath, { inputDir: args.inputDir });
    writeJson(planCheckOutputPath, planCheck);
    runReport.stages.push({
      stage: "checkPlan",
      ok: planCheck.ok,
      outputPath: planCheckOutputPath,
      summary: planCheck.ok ? "Plan checker passed." : formatPlanCheckerFailure(planCheck)
    });
    if (!planCheck.ok) {
      throw new Error(`plan-checker failed: ${formatPlanCheckerFailure(planCheck)}`);
    }

    progress(args.validateOnly ? "Running commander validation..." : "Running commander build...");
    const commanderArgs = [path.join(__dirname, "commander.js"), planPath];
    if (args.validateOnly) commanderArgs.push("--validate-only");
    const cmd = spawnSync(process.execPath, commanderArgs, { encoding: "utf8" });
    fs.writeFileSync(commanderStdoutLogPath, cmd.stdout || "", "utf8");
    fs.writeFileSync(commanderStderrLogPath, cmd.stderr || "", "utf8");

    const commanderJson = parseCommanderOutput(cmd.stdout);
    if (commanderJson) {
      writeJson(commanderStdoutPath, commanderJson);
    }

    if (cmd.status !== 0) {
      runReport.stages.push({
        stage: args.validateOnly ? "validatePlan" : "runPlan",
        ok: false,
        exitCode: cmd.status,
        stderrTail: String(cmd.stderr || "").slice(-2000)
      });
      throw new Error(`commander failed with exit code ${cmd.status}`);
    }

    runReport.stages.push({
      stage: args.validateOnly ? "validatePlan" : "runPlan",
      ok: true,
      outputPath: commanderStdoutPath
    });
    runReport.ok = true;
    runReport.finishedAt = new Date().toISOString();
    writeJson(runReportPath, runReport);

    console.log(
      JSON.stringify(
        {
          ok: true,
          runId,
          runDir,
          planPath,
          generationReportPath: runReport.outputs.generationReportPath,
          generatorOutputPath: generatorStdoutPath,
          planCheckOutputPath,
          commanderOutputPath: commanderStdoutPath,
          commanderStdoutLogPath,
          commanderStderrLogPath
        },
        null,
        2
      )
    );
  } catch (err) {
    runReport.ok = false;
    runReport.finishedAt = new Date().toISOString();
    runReport.error = err && err.message ? err.message : String(err);
    writeJson(runReportPath, runReport);

    if (err instanceof PlanGeneratorError) {
      console.error(`Failed: ${err.message}`);
      if (Array.isArray(err.details) && err.details.length > 0) {
        console.error(`- ${err.details.join("\n- ")}`);
      }
    } else {
      console.error(`Failed: ${runReport.error}`);
    }
    console.error(`Run report: ${runReportPath}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  formatUtcStamp,
  toSafeSlug,
  parseCommanderOutput,
  parseCommanderKeyValueSummary,
  formatPlanCheckerFailure
};
