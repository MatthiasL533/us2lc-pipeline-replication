const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  generateVisualNarratorArtifactsFromInputDir,
  generateProcessVisualizerArtifactsFromInputDir
} = require("./plan-generator");

const ROOT = path.join(__dirname, "..");
const GENERATOR_CLI = path.join(ROOT, "src", "plan-generator-cli.js");
const COMMANDER = path.join(ROOT, "src", "commander.js");
const TEST_DATA_ROOT = path.join(ROOT, "src", "test-data", "plan-generator");
const VALID_INPUT_DIR = path.join(TEST_DATA_ROOT, "input-valid");
const MOCK_RESPONSE_PATH = path.join(TEST_DATA_ROOT, "mock-ollama-response.json");
const MOCK_VN_RESPONSE_PATH = path.join(TEST_DATA_ROOT, "mock-vn-response.json");
const MOCK_PROCESS_VIZ_RESPONSE_PATH = path.join(TEST_DATA_ROOT, "mock-process-viz-response.json");

function runGenerator({ inputDir, outPath, extraArgs = [] }) {
  const result = spawnGenerator({ inputDir, outPath, extraArgs });
  if (result.status !== 0) {
    throw Object.assign(new Error(`generator failed with ${result.status}`), { stderr: result.stderr, stdout: result.stdout });
  }
  return result;
}

function spawnGenerator({ inputDir, outPath, extraArgs = [] }) {
  return require("child_process").spawnSync(
    process.execPath,
    [
      GENERATOR_CLI,
      "--input-dir",
      inputDir,
      "--out",
      outPath,
      "--mock-ollama-response",
      MOCK_RESPONSE_PATH,
      "--mock-process-viz-response",
      MOCK_PROCESS_VIZ_RESPONSE_PATH,
      ...extraArgs
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
}

function validatePlan(planPath) {
  const raw = execFileSync(process.execPath, [COMMANDER, planPath, "--validate-only"], {
    encoding: "utf8"
  });
  return JSON.parse(raw);
}

function testGeneratedPlanValidates() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-generator-integration-"));
  const outPath = path.join(tmp, "plan.json");

  const result = runGenerator({
    inputDir: VALID_INPUT_DIR,
    outPath,
    extraArgs: ["--mock-vn-response", MOCK_VN_RESPONSE_PATH]
  });

  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, true);
  assert.equal(fs.existsSync(outPath), true);
  assert.equal(fs.existsSync(path.join(tmp, "generation-report.json")), true);
  assert.equal(fs.existsSync(path.join(tmp, "visual-narrator-summary.json")), true);
  assert.equal(fs.existsSync(path.join(tmp, "process-visualizer-summary.json")), true);
  assert.equal(fs.existsSync(path.join(tmp, "process-visualizer-result.json")), true);
  assert.equal(fs.existsSync(path.join(tmp, "process-visualizer-run", "process-visualizer.gv")), true);
  assert.equal(fs.existsSync(path.join(tmp, "process-visualizer-run", "process-visualizer.png")), true);

  const report = JSON.parse(fs.readFileSync(path.join(tmp, "generation-report.json"), "utf8"));
  assert.equal(report.visualNarrator.enabled, true);
  assert.equal(report.visualNarrator.status, "completed");
  assert.equal(report.processVisualizer.enabled, true);
  assert.equal(report.processVisualizer.status, "completed");
  assert.equal(report.coverageGate.enabled, false);

  const validation = validatePlan(outPath);
  assert.equal(validation.valid, true);

  const plan = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert((plan.app.navigation.navigationItemRefs || []).length <= 6, "Expected navigation to stay compact.");
  assert(plan.security && Array.isArray(plan.security.userRoles) && plan.security.userRoles.length > 0, "Expected generated plan to include security user roles.");
  const detailPages = (plan.pages && plan.pages.specs || []).filter((page) => /_(detail|newedit)$/i.test(page.ref || ""));
  assert(detailPages.length > 0, "Expected generated plan to include detail-like pages.");
  for (const page of detailPages) {
    const dataView = (page.content || []).find((step) => step && step.type === "dataView");
    assert(dataView, `Expected detail page ${page.ref} to contain a dataView.`);
    assert(
      (dataView.content || []).some((step) => step && step.type === "attributeInput"),
      `Expected detail page ${page.ref} to contain attributeInput fields.`
    );
  }

  const planAssociations = (plan.domainModel && plan.domainModel.associations) || [];
  const associatedEntityNames = new Set(
    planAssociations.flatMap((assoc) => [assoc.parentEntity, assoc.childEntity]).map((name) => String(name || ""))
  );
  const detailWithAssociations = detailPages.find((page) => {
    const entityName = String(page.entityRef || "").split(".").pop();
    return associatedEntityNames.has(entityName);
  });
  assert(detailWithAssociations, "Expected at least one associated entity detail page to be generated.");
  const associatedDataView = (detailWithAssociations.content || []).find((step) => step && step.type === "dataView");
  assert(
    (associatedDataView.content || []).some((step) => step && step.type === "associationInput"),
    `Expected associated detail page ${detailWithAssociations.ref} to contain an association input.`
  );
}

function testMissingRequiredFilesFailsClearly() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-generator-integration-missing-"));

  writeFile(path.join(tmp, "app-context.json"), JSON.stringify({ appId: "id", moduleName: "MyFirstModule" }, null, 2));

  let threw = false;
  try {
    runGenerator({
      inputDir: tmp,
      outPath: path.join(tmp, "plan.json")
    });
  } catch (err) {
    threw = true;
    const stderr = String(err.stderr || "");
    assert(stderr.includes("Missing required input file(s): user-stories.txt"));
  }

  assert.equal(threw, true, "Expected generator to fail when required files are missing.");
}

function testStabilityFiveRuns() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-generator-stability-"));

  for (let i = 0; i < 5; i += 1) {
    const outPath = path.join(tmp, `plan-${i + 1}.json`);
    runGenerator({
      inputDir: VALID_INPUT_DIR,
      outPath,
      extraArgs: ["--no-vn"]
    });

    const validation = validatePlan(outPath);
    assert.equal(validation.valid, true, `Expected run ${i + 1} to produce a valid plan.`);
  }
}

function testNoVnSkipsVisualNarrator() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-generator-no-vn-"));
  const outPath = path.join(tmp, "plan.json");

  runGenerator({
    inputDir: VALID_INPUT_DIR,
    outPath,
    extraArgs: ["--no-vn"]
  });

  const report = JSON.parse(fs.readFileSync(path.join(tmp, "generation-report.json"), "utf8"));
  assert.equal(report.visualNarrator.enabled, false);
  assert.equal(report.visualNarrator.status, "skipped");
}

function testNoProcessVizSkipsProcessVisualizer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-generator-no-process-viz-"));
  const outPath = path.join(tmp, "plan.json");

  runGenerator({
    inputDir: VALID_INPUT_DIR,
    outPath,
    extraArgs: ["--mock-vn-response", MOCK_VN_RESPONSE_PATH, "--no-process-viz"]
  });

  const report = JSON.parse(fs.readFileSync(path.join(tmp, "generation-report.json"), "utf8"));
  assert.equal(report.processVisualizer.enabled, false);
  assert.equal(report.processVisualizer.status, "skipped");
}

function testMinStoryCoverageGateCanPass() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-generator-coverage-gate-"));
  const outPath = path.join(tmp, "plan.json");

  runGenerator({
    inputDir: VALID_INPUT_DIR,
    outPath,
    extraArgs: ["--mock-vn-response", MOCK_VN_RESPONSE_PATH, "--min-story-coverage=1"]
  });

  const report = JSON.parse(fs.readFileSync(path.join(tmp, "generation-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.coverageGate.enabled, true);
  assert.equal(report.coverageGate.minimum, 1);
  assert.equal(report.coverageGate.passed, true);
}

function testInvalidMinStoryCoverageFailsClearly() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-generator-coverage-invalid-"));
  const outPath = path.join(tmp, "plan.json");

  const result = spawnGenerator({
    inputDir: VALID_INPUT_DIR,
    outPath,
    extraArgs: ["--min-story-coverage=1.5"]
  });

  assert.notEqual(result.status, 0);
  assert(String(result.stderr || "").includes("--min-story-coverage must be a number between 0 and 1"));
}

function testGeneratorFailsWhenOllamaIsUnavailable() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-generator-no-ollama-"));
  const outPath = path.join(tmp, "plan.json");

  const result = require("child_process").spawnSync(
    process.execPath,
    [
      GENERATOR_CLI,
      "--input-dir",
      VALID_INPUT_DIR,
      "--out",
      outPath,
      "--no-vn",
      "--no-process-viz"
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  assert.notEqual(result.status, 0, "Expected generator to fail when the LLM call fails.");
  assert(String(result.stderr || "").includes("Entity pass failed after retries"));
  assert.equal(fs.existsSync(outPath), false, "Expected no plan to be written when the LLM call fails.");
}

function testProgressOutputShowsVnAndLlmStages() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-generator-progress-"));
  const outPath = path.join(tmp, "plan.json");

  const result = spawnGenerator({
    inputDir: VALID_INPUT_DIR,
    outPath,
    extraArgs: ["--mock-vn-response", MOCK_VN_RESPONSE_PATH]
  });

  assert.equal(result.status, 0);
  assert(String(result.stderr).includes("Stage 2/10: Running Visual Narrator"));
  assert(String(result.stderr).includes("Stage 3/10: Running Process Visualizer"));
  assert(String(result.stderr).includes("Stage 6/10: LLM first pass"));
}

function testGeneratePlanUsesPrecomputedArtifactsFromInputDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-generator-precomputed-"));
  const inputDir = path.join(tmp, "input");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.cpSync(VALID_INPUT_DIR, inputDir, { recursive: true });

  generateVisualNarratorArtifactsFromInputDir({
    inputDir,
    runVisualNarratorImpl: ({ outputDir }) => {
      const raw = JSON.parse(fs.readFileSync(MOCK_VN_RESPONSE_PATH, "utf8"));
      writeFile(path.join(outputDir, "visual-narrator-result.json"), JSON.stringify(raw, null, 2));
      writeFile(path.join(outputDir, "visual-narrator-summary.json"), JSON.stringify({ classNames: ["Ticket", "TicketComment"] }, null, 2));
      writeFile(path.join(outputDir, "visual-narrator-stories.json"), JSON.stringify(raw.stories || [], null, 2));
      writeFile(path.join(outputDir, "visual-narrator-ontology.omn"), String(raw.ontology || ""));
      return {
        artifacts: {
          rawPath: path.join(outputDir, "visual-narrator-result.json"),
          summaryPath: path.join(outputDir, "visual-narrator-summary.json"),
          storiesPath: path.join(outputDir, "visual-narrator-stories.json"),
          ontologyPath: path.join(outputDir, "visual-narrator-ontology.omn")
        },
        summary: { classNames: ["Ticket", "TicketComment"], classes: [], relationships: [], keyNouns: [], inferredRoles: [] },
        status: "completed",
        command: "mock:vn"
      };
    }
  });

  generateProcessVisualizerArtifactsFromInputDir({
    inputDir,
    runProcessVisualizerImpl: ({ outputDir }) => {
      const raw = JSON.parse(fs.readFileSync(MOCK_PROCESS_VIZ_RESPONSE_PATH, "utf8"));
      writeFile(path.join(outputDir, "process-visualizer-result.json"), JSON.stringify(raw, null, 2));
      writeFile(path.join(outputDir, "process-visualizer-summary.json"), JSON.stringify({ processObjects: ["Ticket"] }, null, 2));
      writeFile(path.join(outputDir, "process-visualizer-run", "process-visualizer.gv"), "digraph{}");
      writeFile(path.join(outputDir, "process-visualizer-run", "process-visualizer.png"), "");
      return {
        artifacts: {
          rawPath: path.join(outputDir, "process-visualizer-result.json"),
          summaryPath: path.join(outputDir, "process-visualizer-summary.json"),
          runDir: path.join(outputDir, "process-visualizer-run")
        },
        summary: { actors: [], tasks: [], gateways: [], processObjects: ["Ticket"], capabilityHints: {} },
        status: "completed",
        command: "mock:pv"
      };
    }
  });

  const outPath = path.join(tmp, "plan.json");
  const result = runGenerator({
    inputDir,
    outPath,
    extraArgs: ["--mock-vn-response", MOCK_VN_RESPONSE_PATH, "--mock-process-viz-response", MOCK_PROCESS_VIZ_RESPONSE_PATH]
  });

  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, true);

  const report = JSON.parse(fs.readFileSync(path.join(tmp, "generation-report.json"), "utf8"));
  assert(String(report.visualNarrator.command || "").startsWith("input-artifact:"));
  assert(String(report.processVisualizer.command || "").startsWith("input-artifact:"));
  assert(String(result.stderr).includes("Using Visual Narrator input artifacts from input directory."));
  assert(String(result.stderr).includes("Using Process Visualizer input artifacts from input directory."));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function run() {
  testGeneratedPlanValidates();
  testMissingRequiredFilesFailsClearly();
  testStabilityFiveRuns();
  testNoVnSkipsVisualNarrator();
  testNoProcessVizSkipsProcessVisualizer();
  testMinStoryCoverageGateCanPass();
  testInvalidMinStoryCoverageFailsClearly();
  testGeneratorFailsWhenOllamaIsUnavailable();
  testProgressOutputShowsVnAndLlmStages();
  testGeneratePlanUsesPrecomputedArtifactsFromInputDir();
  console.log("plan generator integration tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
