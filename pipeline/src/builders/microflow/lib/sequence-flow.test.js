const assert = require("assert");
const { validateDecisionBranchFlows } = require("./sequence-flow");

function testValidDecisionBranchValidation() {
  const split = { id: "split-1" };
  const flows = [
    {
      origin: split,
      caseValues: [{ value: "true" }]
    },
    {
      origin: split,
      caseValues: [{ value: "false" }]
    }
  ];

  const out = validateDecisionBranchFlows(split, flows);
  assert.equal(out.ok, true);
  assert.equal(out.trueCount, 1);
  assert.equal(out.falseCount, 1);
}

function testInvalidDecisionBranchValidation() {
  const split = { id: "split-2" };
  const flows = [
    {
      origin: split,
      caseValues: [{ value: "true" }]
    },
    {
      origin: split,
      caseValues: [{ value: "true" }]
    }
  ];

  const out = validateDecisionBranchFlows(split, flows);
  assert.equal(out.ok, false);
  assert.equal(out.trueCount, 2);
  assert.equal(out.falseCount, 0);
}

function run() {
  testValidDecisionBranchValidation();
  testInvalidDecisionBranchValidation();
  console.log("microflow sequence-flow tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
