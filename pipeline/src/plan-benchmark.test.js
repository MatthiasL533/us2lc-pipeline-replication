const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { enforceRuntimeGuard, runBenchmark } = require("./plan-benchmark");
const { makeValidPlan } = require("./lib/plan-checker.test");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function createInputDir(rootDir) {
  const inputDir = path.join(rootDir, "input");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(
    path.join(inputDir, "user-stories.txt"),
    "As a manager, I want to manage tasks so that I can track work.\n",
    "utf8"
  );
  writeJson(path.join(inputDir, "app-context.json"), {
    appId: "id",
    moduleName: "MyFirstModule"
  });
  return inputDir;
}

function createCase(rootDir, caseId, rubric = {}) {
  const caseDir = path.join(rootDir, caseId);
  const inputDir = path.join(caseDir, "input");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(
    path.join(inputDir, "user-stories.txt"),
    "As a manager, I want to manage tasks so that I can track work.\n",
    "utf8"
  );
  writeJson(path.join(inputDir, "app-context.json"), {
    appId: "id",
    moduleName: "MyFirstModule",
    layoutQualifiedName: "Atlas_Core.Atlas_Default",
    homePageRef: "home"
  });
  writeJson(path.join(caseDir, "case-rubric.json"), {
    id: caseId,
    title: caseId,
    domain: {
      requiredEntities: ["Task"],
      allowedEntities: ["Task", "TaskComment", "User"]
    },
    pages: {
      requiredPageRefs: ["home", "task_overview"]
    },
    navigation: {
      requiredHomePageButtonRefs: ["task_overview"],
      requiredNavigationItemRefs: ["task_overview"]
    },
    constraints: {
      forbidWorkflows: true
    },
    ...rubric
  });

  return caseDir;
}

async function testBenchmarkAggregatesRunsAcrossCases() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-benchmark-"));
  const caseOne = createCase(tmp, "case-one");
  const caseTwo = createCase(tmp, "case-two");
  const config = {
    scope: "plan-only",
    provider: "ollama",
    mode: "overnight",
    models: ["model-a"],
    cases: [caseOne, caseTwo],
    runsPerCasePerModel: 1,
    ollamaUrl: "http://127.0.0.1:11434",
    useVisualNarrator: false,
    useExamples: false,
    useKnowledge: false,
    timeoutMs: 1000,
    outputDir: path.join(tmp, "benchmark"),
    retryPolicy: "none"
  };

  const durations = [100, 200];
  let callCount = 0;
  const result = await runBenchmark(config, {
    runGenerator: async ({ outPath, runDir }) => {
      callCount += 1;
      writeJson(outPath, makeValidPlan());
      fs.writeFileSync(path.join(runDir, "generator.stdout.log"), "ok", "utf8");
      fs.writeFileSync(path.join(runDir, "generator.stderr.log"), "", "utf8");
      return {
        status: 0,
        signal: null,
        stdout: "{}",
        stderr: "",
        timedOut: false,
        durationMs: durations[callCount - 1]
      };
    }
  });

  assert.equal(callCount, 2);
  assert.equal(fs.existsSync(result.resultsPath), true);
  assert.equal(fs.existsSync(result.reportPath), true);

  const benchmarkResults = JSON.parse(fs.readFileSync(result.resultsPath, "utf8"));
  assert.equal(benchmarkResults.cases.length, 2);
  assert.equal(benchmarkResults.aggregateModels.length, 1);
  assert.equal(benchmarkResults.aggregateModels[0].model, "model-a");
  assert(benchmarkResults.aggregateModels[0].averageFeatureFit > 0);
  assert.equal(typeof benchmarkResults.cases[0].models[0].generalizationBreakdown.lexicalCoverageScore, "number");

  const markdown = fs.readFileSync(result.reportPath, "utf8");
  assert(markdown.includes("## Case: case-one"));
  assert(markdown.includes("Lexical coverage"));
  assert(markdown.includes("## Final Summary"));
}

async function testBenchmarkTracksFailures() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-benchmark-fail-"));
  const caseOne = createCase(tmp, "case-one");
  const config = {
    scope: "plan-only",
    provider: "ollama",
    mode: "overnight",
    models: ["model-b"],
    cases: [caseOne],
    runsPerCasePerModel: 2,
    ollamaUrl: "http://127.0.0.1:11434",
    useVisualNarrator: false,
    useExamples: false,
    useKnowledge: false,
    timeoutMs: 1000,
    outputDir: path.join(tmp, "benchmark"),
    retryPolicy: "none"
  };

  let callCount = 0;
  const result = await runBenchmark(config, {
    runGenerator: async ({ outPath }) => {
      callCount += 1;
      if (callCount === 1) {
        fs.writeFileSync(outPath, "{bad json", "utf8");
        return {
          status: 1,
          signal: null,
          stdout: "",
          stderr: "Invalid JSON",
          timedOut: false,
          durationMs: 150
        };
      }

      writeJson(outPath, makeValidPlan());
      return {
        status: 0,
        signal: null,
        stdout: "{}",
        stderr: "",
        timedOut: false,
        durationMs: 120
      };
    }
  });

  const benchmarkResults = JSON.parse(fs.readFileSync(result.resultsPath, "utf8"));
  const caseSummary = benchmarkResults.cases[0].models[0];
  assert.equal(caseSummary.runsSucceeded, 1);
  assert(caseSummary.jsonValidityRate < 1);
}

function testOvernightGuardRejectsTooManyRuns() {
  let threw = false;
  try {
    enforceRuntimeGuard({ mode: "overnight", runsPerCasePerModel: 3 }, [{ id: "one" }]);
  } catch (err) {
    threw = true;
    assert(String(err.message).includes("at most 2 runs"));
  }
  assert.equal(threw, true);
}

async function run() {
  await testBenchmarkAggregatesRunsAcrossCases();
  await testBenchmarkTracksFailures();
  testOvernightGuardRejectsTooManyRuns();
  console.log("plan benchmark tests: OK");
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err.stack || err);
    process.exit(1);
  });
}

module.exports = { run };
