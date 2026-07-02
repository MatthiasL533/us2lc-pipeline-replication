const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { DEFAULT_EXAMPLE_PLAN_PATHS } = require("../plan-generator");

const ROOT = path.join(__dirname, "..", "..");
const COMMANDER_PATH = path.join(ROOT, "src", "commander.js");

const PLAN_FILES = [
  path.join(ROOT, "src", "plans", "reference", "reference-01-role-separated-crud.json"),
  path.join(ROOT, "src", "plans", "reference", "reference-02-workflow-simple-approval.json"),
  path.join(ROOT, "src", "plans", "reference", "reference-03-relational-crud.json"),
  path.join(ROOT, "src", "plans", "reference", "reference-04-microflow-business-logic.json"),
  path.join(ROOT, "src", "plans", "reference", "reference-05-analytics-filters.json"),
  path.join(ROOT, "src", "plans", "reference", "reference-06-workflow-routing.json"),
  path.join(ROOT, "src", "plans", "reference", "reference-07-client-actions-create-app.json")
];

function testReferenceDefaults() {
  assert.equal(DEFAULT_EXAMPLE_PLAN_PATHS.length, PLAN_FILES.length, "Expected generator defaults to match reference plan count.");
  for (const planPath of DEFAULT_EXAMPLE_PLAN_PATHS) {
    assert(planPath.includes(`${path.sep}src${path.sep}plans${path.sep}reference${path.sep}`), `Expected reference path: ${planPath}`);
    assert.equal(fs.existsSync(planPath), true, `Expected example plan to exist: ${planPath}`);
  }

  for (const planPath of PLAN_FILES) {
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.equal(plan.execution && plan.execution.commit, true, `Expected execution.commit=true for ${planPath}`);
    const raw = JSON.stringify(plan);
    assert.equal(/com\.mendix\.charts\./.test(raw), false, `Charts are not allowed in reference plans: ${planPath}`);
  }
}

function testValidateOnlyContract() {
  for (const planPath of PLAN_FILES) {
    const raw = execFileSync(process.execPath, [COMMANDER_PATH, planPath, "--validate-only"], {
      encoding: "utf8"
    });
    const out = JSON.parse(raw);
    assert.equal(out.valid, true, `Expected valid=true for ${planPath}`);
    assert(Array.isArray(out.stages), `Expected stages array for ${planPath}`);
    assert.equal(out.stages.length, 1, `Expected exactly one stage in validate-only mode for ${planPath}`);
    assert.equal(out.stages[0].stage, "validation");
    assert.equal(out.stages[0].ok, true);
  }
}

function run() {
  testReferenceDefaults();
  testValidateOnlyContract();
  console.log("plan contract tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
