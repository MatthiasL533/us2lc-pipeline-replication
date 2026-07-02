const assert = require("assert");

const fs = require("fs");
const os = require("os");
const path = require("path");

const { compareBenchmarkModels, comparePlans, renderMarkdownBenchmarkComparison, renderMarkdownDiff } = require("./plan-diff");
const { makeValidPlan } = require("./plan-checker.test");

function testPlanDiffFindsDifferences() {
  const left = makeValidPlan();
  const right = makeValidPlan();
  right.domainModel.entities.push({
    name: "Comment",
    attributes: [{ name: "Body", type: "String" }]
  });
  right.pages.specs.push({
    ref: "comment_overview",
    name: "Comment_Overview",
    content: [{ type: "listView", entityRef: "MyFirstModule.Comment" }]
  });

  const result = comparePlans({
    leftPlan: left,
    rightPlan: right,
    leftLabel: "model-a",
    rightLabel: "model-b"
  });

  assert.equal(result.ok, true);
  assert(result.differences.entities.onlyRight.includes("Comment"));
  assert(result.differences.pages.onlyRight.includes("comment_overview"));
  assert(result.similarity.entityJaccard < 1);
}

function testMarkdownRenderIncludesLabels() {
  const result = comparePlans({
    leftPlan: makeValidPlan(),
    rightPlan: makeValidPlan(),
    leftLabel: "run-1",
    rightLabel: "run-2"
  });

  const markdown = renderMarkdownDiff(result);
  assert(markdown.includes("run-1"));
  assert(markdown.includes("run-2"));
  assert(markdown.includes("## entities"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function testBenchmarkComparisonAggregatesModels() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-diff-benchmark-"));
  const benchmarkDir = path.join(tmp, "benchmark");
  const leftRun = path.join(benchmarkDir, "model_a", "run-01", "plan.json");
  const rightRun = path.join(benchmarkDir, "model_b", "run-01", "plan.json");

  const leftPlan = makeValidPlan();
  const rightPlan = makeValidPlan();
  rightPlan.domainModel.entities.push({
    name: "Comment",
    attributes: [{ name: "Body", type: "String" }]
  });

  writeJson(leftRun, leftPlan);
  writeJson(rightRun, rightPlan);
  writeJson(path.join(benchmarkDir, "benchmark-results.json"), {
    models: [
      {
        model: "model-a",
        runs: [{ runDir: path.join(benchmarkDir, "model_a", "run-01") }]
      },
      {
        model: "model-b",
        runs: [{ runDir: path.join(benchmarkDir, "model_b", "run-01") }]
      }
    ]
  });

  const result = compareBenchmarkModels(benchmarkDir);
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 2);
  assert.equal(result.pairwise.length, 1);
  assert.equal(result.pairwise[0].labels.left, "model-a");
  assert.equal(result.pairwise[0].labels.right, "model-b");

  const markdown = renderMarkdownBenchmarkComparison(result);
  assert(markdown.includes("model-a"));
  assert(markdown.includes("model-b"));
  assert(markdown.includes("Pairwise Similarity"));
}

function run() {
  testPlanDiffFindsDifferences();
  testMarkdownRenderIncludesLabels();
  testBenchmarkComparisonAggregatesModels();
  console.log("plan diff tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
