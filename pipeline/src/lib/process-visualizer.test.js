const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ProcessVisualizerError,
  getProcessVisualizerPaths,
  ensureProcessVisualizerEnvironment,
  normalizeProcessVisualizerSummary,
  buildProcessVisualizerPromptText,
  runProcessVisualizer
} = require("./process-visualizer");

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function mockResult() {
  return {
    ok: true,
    entities: [
      { entity_group: "AGENT", word: "employee" },
      { entity_group: "TASK", word: "submit a ticket" },
      { entity_group: "TASK", word: "open a page" }
    ],
    bpmnStructure: [
      {
        content: {
          agent: { word: "employee" },
          task: { word: "submit a ticket" },
          sentence_idx: 0
        },
        type: "task"
      },
      {
        id: "EG0",
        type: "exclusive",
        conditions: ["If approved", "If rejected"],
        children: [
          [
            {
              content: {
                agent: { word: "manager" },
                task: { word: "approve the ticket" },
                condition: { word: "If approved" },
                sentence_idx: 1
              },
              type: "task"
            }
          ],
          [
            {
              content: {
                agent: { word: "manager" },
                task: { word: "reject the ticket" },
                condition: { word: "If rejected" },
                sentence_idx: 1
              },
              type: "task"
            }
          ]
        ]
      }
    ],
    graphSourcePath: "/tmp/process-visualizer.gv",
    graphImagePath: "/tmp/process-visualizer.png",
    logsDir: "/tmp/output_logs"
  };
}

function testEnvironmentDetectionFailsClearly() {
  const root = mkTmpDir("process-viz-missing-");
  const paths = getProcessVisualizerPaths({ repoRoot: root });
  assert.throws(() => ensureProcessVisualizerEnvironment(paths), (err) => {
    assert(err instanceof ProcessVisualizerError);
    assert.equal(err.details.code, "PV_MISSING_FOLDER");
    return true;
  });
}

function testNormalizeSummaryFiltersAndExtractsProcessFlow() {
  const summary = normalizeProcessVisualizerSummary(mockResult());

  assert.deepEqual(summary.actors, ["employee", "manager"]);
  assert(summary.tasks.some((task) => task.action === "submit a ticket"));
  assert(summary.gateways.some((gateway) => gateway.id === "EG0"));
  assert(summary.processObjects.includes("Ticket"));
  assert(!summary.processObjects.includes("Page"));
  assert.equal(summary.capabilityHints.hasDecision, true);
  assert.equal(summary.capabilityHints.hasApproval, true);
  assert.equal(summary.capabilityHints.hasWorkflowLikeRouting, true);
}

function testPromptTextUsesStructuredEvidence() {
  const summary = normalizeProcessVisualizerSummary(mockResult());
  const text = buildProcessVisualizerPromptText(summary);

  assert(text.includes("Process actors: employee, manager"));
  assert(text.includes("Process object candidates: Ticket"));
  assert(text.includes("Task flow:"));
  assert(text.includes("Decisions/gateways:"));
  assert(text.includes("Capability hints:"));
}

function testRunProcessVisualizerWritesArtifactsWithMockedSpawn() {
  const root = mkTmpDir("process-viz-repo-");
  const outputDir = path.join(root, "out");
  const inputPath = path.join(root, "input", "user-stories.txt");
  const pythonPath = path.join(root, "process-visualizer", ".venv", "bin", "python");
  const wrapperPath = path.join(root, "src", "scripts", "run_process_visualizer.py");

  writeFile(inputPath, "As an employee, I want to submit a ticket.");
  writeFile(pythonPath, "");
  writeFile(wrapperPath, "# mock");

  const result = runProcessVisualizer({
    inputPath,
    outputDir,
    model: "llama3",
    ollamaUrl: "http://127.0.0.1:11434",
    repoRoot: root,
    spawnSyncImpl: (_command, _args, options) => {
      assert.equal(options.env.PROCESS_VISUALIZER_LLM_PROVIDER, "ollama");
      assert.equal(options.env.PROCESS_VISUALIZER_MODEL, "llama3");
      return {
        status: 0,
        stdout: `huggingface cache message\n${JSON.stringify(mockResult())}\n`,
        stderr: ""
      };
    }
  });

  assert.equal(result.enabled, true);
  assert.equal(result.status, "completed");
  assert.equal(fs.existsSync(path.join(outputDir, "process-visualizer-summary.json")), true);
  assert.equal(fs.existsSync(path.join(outputDir, "process-visualizer-result.json")), true);
  assert.equal(fs.existsSync(path.join(outputDir, "process-visualizer-run", "process-visualizer.gv")), true);
  assert.equal(fs.existsSync(path.join(outputDir, "process-visualizer-run", "process-visualizer.png")), true);
}

function run() {
  testEnvironmentDetectionFailsClearly();
  testNormalizeSummaryFiltersAndExtractsProcessFlow();
  testPromptTextUsesStructuredEvidence();
  testRunProcessVisualizerWritesArtifactsWithMockedSpawn();
  console.log("process visualizer unit tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
