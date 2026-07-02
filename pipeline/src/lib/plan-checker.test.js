const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { checkPlanFile, checkPlanObject } = require("./plan-checker");

function makeValidPlan() {
  return {
    meta: {
      planVersion: "1.1.0",
      generatedBy: "pipeline.plan-generator"
    },
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default",
      homePageRef: "home",
      navigation: {
        homePageButtons: [{ pageRef: "task_overview", icon: { name: "home" }, allowedRoles: ["Manager"] }],
        menuItems: [{ pageRef: "task_overview", icon: { name: "home" }, allowedRoles: ["Manager"] }]
      }
    },
    security: {
      securityLevel: "prototype",
      moduleRoles: ["Manager"],
      userRoles: [{ name: "Manager", moduleRoles: ["Manager"] }]
    },
    domainModel: {
      entities: [
        {
          name: "Task",
          attributes: [
            { name: "Title", type: "String" },
            { name: "Done", type: "Boolean" }
          ]
        }
      ],
      associations: [],
      enumerations: []
    },
    pages: {
      specs: [
        {
          ref: "home",
          name: "Home",
          content: [{ type: "buttonToPage", pageRef: "task_overview" }]
        },
        {
          ref: "task_overview",
          name: "Task_Overview",
          entityRef: "MyFirstModule.Task",
          allowedRoles: ["Manager"],
          content: [
            {
              type: "dataGrid",
              widgetMode: "classic",
              entityRef: "MyFirstModule.Task",
              columns: [{ attributeRef: "Title" }],
              search: { fields: [{ attributeRef: "Title" }] }
            }
          ]
        }
      ]
    }
  };
}

function testValidPlanPasses() {
  const result = checkPlanObject(makeValidPlan());
  assert.equal(result.ok, true);
  assert.equal(result.jsonParseValid, true);
  assert.equal(result.schemaValid, true);
  assert.equal(result.storyCoverageScore, null);
  assert.equal(result.storyCoverageSource, "missing");
  assert.equal(result.referenceIntegrity.ok, true);
  assert.equal(result.stubFlags.ok, true);
  assert.equal(result.artifactCounts.entities, 1);
  assert.equal(result.artifactCounts.pages, 2);
}

function testCoverageRecomputesFromInputDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-checker-input-"));
  fs.writeFileSync(
    path.join(tmp, "user-stories.txt"),
    "As a task user, I want task title and done fields so that task status is visible.",
    "utf8"
  );
  fs.writeFileSync(
    path.join(tmp, "app-context.json"),
    JSON.stringify({ appId: "id", moduleName: "MyFirstModule" }),
    "utf8"
  );

  const result = checkPlanObject(makeValidPlan(), { inputDir: tmp });
  assert.equal(result.storyCoverageSource, "recomputed");
  assert.equal(result.storyCoverageScore, 1);
}

function testInvalidJsonFailsClearly() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-checker-invalid-"));
  const planPath = path.join(tmp, "bad-plan.json");
  fs.writeFileSync(planPath, "{not-json", "utf8");

  const result = checkPlanFile(planPath);
  assert.equal(result.ok, false);
  assert.equal(result.jsonParseValid, false);
  assert(result.validationErrors[0].includes("Invalid JSON"));
  assert(result.stubFlags.flags.includes("invalid_json"));
}

function testStubPlanGetsFlags() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule"
    },
    domainModel: {
      entities: [{ name: "Entity", attributes: [{ name: "Name", type: "String" }] }],
      associations: [],
      enumerations: []
    },
    pages: {
      specs: [{ ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Hi" }] }]
    }
  };

  const result = checkPlanObject(plan);
  assert.equal(result.ok, false);
  assert(result.stubFlags.flags.some((flag) => flag.startsWith("placeholder_entity_name")));
  assert(result.stubFlags.flags.some((flag) => flag.startsWith("entity_only_name_attribute")));
  assert(result.stubFlags.flags.some((flag) => flag.startsWith("page_without_useful_steps")));
}

function testReferenceIntegrityCatchesTargetPageRefs() {
  const plan = makeValidPlan();
  plan.pages.specs[0].content = [{ type: "buttonToPage", targetPageRef: "missing_page" }];
  plan.pages.specs[1].content[0].rowClickTargetPageRef = "missing_page";

  const result = checkPlanObject(plan);
  assert.equal(result.ok, false);
  assert.equal(result.referenceIntegrity.ok, false);
  assert(result.referenceIntegrity.issues.some((issue) => issue.includes("targetPageRef points to missing page")));
  assert(result.referenceIntegrity.issues.some((issue) => issue.includes("rowClickTargetPageRef points to missing page")));
}

function run() {
  testValidPlanPasses();
  testCoverageRecomputesFromInputDir();
  testInvalidJsonFailsClearly();
  testStubPlanGetsFlags();
  testReferenceIntegrityCatchesTargetPageRefs();
  console.log("plan checker tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = {
  makeValidPlan,
  run
};
