const assert = require("assert");

const { scorePlanAgainstRubric } = require("./feature-fit-scorer");
const { makeValidPlan } = require("./plan-checker.test");

function testScorerRewardsRequiredFeatures() {
  const plan = makeValidPlan();
  plan.domainModel.entities = [
    { name: "Task", attributes: [{ name: "Title", type: "String" }] },
    { name: "User", attributes: [{ name: "FullName", type: "String" }] },
    { name: "TaskComment", attributes: [{ name: "Body", type: "String" }] }
  ];
  plan.pages.specs = [
    { ref: "home", name: "Home", content: [{ type: "buttonToPage", pageRef: "task_overview" }] },
    { ref: "task_overview", name: "Task_Overview", content: [{ type: "listView", entityRef: "MyFirstModule.Task" }] },
    { ref: "taskcomment_newedit", name: "TaskComment_NewEdit", content: [{ type: "dataView", entityRef: "MyFirstModule.TaskComment" }] }
  ];
  const rubric = {
    id: "task_tracker",
    title: "Task Tracker",
    domain: {
      requiredEntities: ["Task", "User", "TaskComment"],
      allowedEntities: ["Task", "User", "TaskComment"]
    },
    relationships: {
      requiredAssociations: [{ parentEntity: "TaskComment", childEntity: "Task", name: "TaskComment_Task" }]
    },
    pages: {
      requiredPageRefs: ["home", "task_overview"],
      requiredOverviewEntities: ["Task"],
      requiredDetailEntities: ["TaskComment"]
    },
    navigation: {
      requiredHomePageButtonRefs: ["task_overview"],
      requiredNavigationItemRefs: ["task_overview"]
    },
    constraints: {
      forbidWorkflows: true
    }
  };

  plan.domainModel.associations = [{ parentEntity: "TaskComment", childEntity: "Task", name: "TaskComment_Task" }];
  const result = scorePlanAgainstRubric(plan, rubric);
  assert.equal(result.ok, true);
  assert(result.featureFitScore > 0.8);
  assert.equal(result.missingRequirements.requiredEntities.length, 0);
}

function testScorerPenalizesOffDomainArtifacts() {
  const plan = makeValidPlan();
  plan.domainModel.entities.push({ name: "Invoice", attributes: [{ name: "Amount", type: "Decimal" }] });

  const rubric = {
    id: "task_tracker",
    title: "Task Tracker",
    domain: {
      requiredEntities: ["Task", "User"],
      forbiddenEntities: ["Invoice"],
      allowedEntities: ["Task", "User", "TaskComment"]
    },
    constraints: {
      forbidWorkflows: true
    }
  };

  const result = scorePlanAgainstRubric(plan, rubric);
  assert(result.featureFitScore < 1);
  assert(result.unexpectedArtifacts.forbiddenEntitiesPresent.includes("Invoice"));
  assert(result.unexpectedArtifacts.entitiesOutsideAllowedSet.includes("Invoice"));
}

function run() {
  testScorerRewardsRequiredFeatures();
  testScorerPenalizesOffDomainArtifacts();
  console.log("feature fit scorer tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
