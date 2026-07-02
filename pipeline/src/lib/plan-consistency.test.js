const assert = require("assert");

const { analyzePlanConsistency, normalizePlan } = require("./plan-consistency");
const { makeValidPlan } = require("./plan-checker.test");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeRun(id, plan) {
  return {
    runId: id,
    plan,
    checker: {
      jsonParseValid: true
    }
  };
}

function testCanonicalizationIgnoresOrder() {
  const left = makeValidPlan();
  const right = clone(left);
  right.pages.specs.reverse();

  const normalizedLeft = normalizePlan(left);
  const normalizedRight = normalizePlan(right);
  assert.deepEqual(normalizedLeft, normalizedRight);

  const result = analyzePlanConsistency([makeRun("a", left), makeRun("b", right)], { model: "model-a" });
  assert.equal(result.ok, true);
  assert.equal(result.exactMatchRate, 1);
  assert.equal(result.consistencyScore, 1);
}

function testDifferentPlansReduceOverlap() {
  const left = makeValidPlan();
  const right = makeValidPlan();
  right.domainModel.entities = [
    {
      name: "Order",
      attributes: [{ name: "Total", type: "Decimal" }]
    }
  ];
  right.pages.specs = [
    { ref: "orders", name: "Orders", content: [{ type: "listView", entityRef: "MyFirstModule.Order" }] }
  ];

  const result = analyzePlanConsistency([makeRun("a", left), makeRun("b", right)], { model: "model-b" });
  assert.equal(result.ok, true);
  assert.equal(result.exactMatchRate, 0);
  assert(result.entityNameOverlapMean < 1);
  assert(result.pageOverlapMean < 1);
  assert(result.consistencyScore < 1);
}

function run() {
  testCanonicalizationIgnoresOrder();
  testDifferentPlansReduceOverlap();
  console.log("plan consistency tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
