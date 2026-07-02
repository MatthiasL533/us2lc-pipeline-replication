const assert = require("assert");
const { runGeneratedModuleSemanticChecks } = require("./semantic-checks");

function testWorkflowTaskButtonsRequireTaskDataContainer() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    workflows: {
      specs: [
        {
          name: "WF_Approval",
          bindings: { contextEntityRef: "MyFirstModule.ApprovalRequest" },
          steps: [
            { type: "start", name: "Start" },
            {
              type: "userTask",
              name: "ManagerReview",
              taskPageRef: "approval_task_page",
              userRoleRefs: ["Manager"]
            }
          ]
        }
      ]
    },
    pages: {
      specs: [
        {
          ref: "approval_task_page",
          name: "Approval_TaskPage",
          pageParameters: [{ name: "WorkflowUserTask", entityRef: "System.WorkflowUserTask", required: true }],
          content: [{ type: "setTaskOutcomeButton", caption: "Approve", outcomeValue: "Approve" }]
        }
      ]
    },
    verification: {
      semanticChecks: {
        workflowBindings: true
      }
    }
  };

  const invalid = runGeneratedModuleSemanticChecks({ plan, moduleName: "MyFirstModule" });
  assert.equal(invalid.ok, false, "Expected missing task data container to fail semantic checks.");
  assert(invalid.errors.some((error) => error.includes("outside a data container")));

  plan.pages.specs[0].content = [
    {
      type: "dataView",
      pageParameterName: "WorkflowUserTask",
      content: [{ type: "setTaskOutcomeButton", caption: "Approve", outcomeValue: "Approve" }]
    }
  ];

  const valid = runGeneratedModuleSemanticChecks({ plan, moduleName: "MyFirstModule" });
  assert.equal(valid.ok, true, `Expected workflow task page to pass semantic checks, got: ${valid.errors.join("; ")}`);
}

function run() {
  testWorkflowTaskButtonsRequireTaskDataContainer();
  console.log("pipeline semantic checks tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
