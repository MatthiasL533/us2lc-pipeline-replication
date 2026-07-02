const assert = require("assert");
const {
  normalizeStepType,
  setRawByNameReference,
  resolveEntityReference,
  validateBooleanGatewayOutcomes,
  buildUserTaskAssignmentXPath,
  applyStringTemplate,
  syncServiceTaskParameterMappings,
  createActivityInFlow,
  buildStepsInFlow
} = require("./workflow-builder-template");

function testNormalizeStepType() {
  assert.equal(normalizeStepType("startEvent"), "start");
  assert.equal(normalizeStepType("service_task"), "serviceTask");
  assert.equal(normalizeStepType("user_task"), "userTask");
  assert.equal(normalizeStepType("exclusive_gateway"), "exclusiveGateway");
  assert.equal(normalizeStepType("end_event"), "end");
}

function testSetRawByNameReference() {
  const target = {
    __page: {
      updated: "",
      updateWithRawValue(v) {
        this.updated = v;
      }
    }
  };

  const ok = setRawByNameReference(target, "page", "MyFirstModule.Task_Detail");
  assert.equal(ok, true);
  assert.equal(target.__page.updated, "MyFirstModule.Task_Detail");
}

function testResolveEntityReference() {
  const model = {
    findEntityByQualifiedName(qname) {
      if (qname === "MyFirstModule.Task") return { qualifiedName: qname };
      return null;
    },
    allDomainModels() {
      return [
        {
          containerAsModule: {
            name: "MyFirstModule"
          }
        }
      ];
    }
  };

  assert(resolveEntityReference(model, "MyFirstModule", "Task"));
  assert(resolveEntityReference(model, "MyFirstModule", "MyFirstModule.Task"));
  assert.equal(resolveEntityReference(model, "MyFirstModule", "Missing"), null);
}

function testValidateBooleanGatewayOutcomes() {
  validateBooleanGatewayOutcomes(
    [
      { condition: true, steps: [] },
      { condition: false, steps: [] }
    ],
    "Decision_1"
  );

  let threw = false;
  try {
    validateBooleanGatewayOutcomes(
      [
        { condition: true, steps: [] },
        { condition: true, steps: [] }
      ],
      "Decision_2"
    );
  } catch (_err) {
    threw = true;
  }
  assert.equal(threw, true);
}

function testBuildUserTaskAssignmentXPath() {
  assert.equal(buildUserTaskAssignmentXPath({}), "[not(IsAnonymous)]");
  assert.equal(
    buildUserTaskAssignmentXPath({ userRoleRefs: ["Manager", "Employee"] }),
    "[not(IsAnonymous) and (System.UserRoles = '[%UserRole_Manager%]' or System.UserRoles = '[%UserRole_Employee%]')]"
  );
}

function testApplyStringTemplate() {
  const template = {
    text: "",
    arguments: {
      items: [{ expression: "old" }],
      replace(next) {
        this.items = next;
      }
    }
  };

  const Module = require("module");
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === "mendixmodelsdk") {
      return {
        microflows: {
          TemplateArgument: {
            createIn(container) {
              const arg = { expression: "" };
              container.arguments.items.push(arg);
              return arg;
            }
          }
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    applyStringTemplate({
      template,
      text: "{1}",
      args: ["$WorkflowContext/Title"]
    });
  } finally {
    Module._load = originalLoad;
  }

  assert.equal(template.text, "{1}");
  assert.equal(template.arguments.items.length, 1);
  assert.equal(template.arguments.items[0].expression, "$WorkflowContext/Title");
}

function testSyncServiceTaskParameterMappings() {
  const workflows = {
    MicroflowCallParameterMapping: {
      create() {
        return { parameter: null, expression: "" };
      }
    }
  };
  const parameter = { structureTypeName: "Microflows$MicroflowParameterObject", name: "WorkflowContext" };
  const handler = { objectCollection: { objects: [parameter] } };
  const activity = { parameterMappings: [] };

  syncServiceTaskParameterMappings({
    workflows,
    model: {},
    activity,
    handler,
    workflowParameterName: "WorkflowContext",
    step: {}
  });

  assert.equal(activity.parameterMappings.length, 1);
  assert.equal(activity.parameterMappings[0].parameter, parameter);
  assert.equal(activity.parameterMappings[0].expression, "$WorkflowContext");
}

function testCreateActivityInFlowFallsBackWhenCreateInHelperIsIllegal() {
  const created = { name: "" };
  const flow = {
    model: { id: "model" },
    activities: []
  };
  const workflows = {
    CallMicroflowTask: {
      createInFlowUnderActivities() {
        throw new Error(
          'In Mendix version 11.10.0 it is illegal on instances of Workflows$CallMicroflowTask to call the "createIn" method.'
        );
      },
      create(model) {
        assert.equal(model, flow.model);
        return created;
      }
    }
  };

  const activity = createActivityInFlow(workflows, "CallMicroflowTask", flow);
  assert.equal(activity, created);
  assert.deepEqual(flow.activities, [created]);
}

function testBuildStepsSkipsRemovedServiceTaskActivity() {
  const flow = {
    model: { id: "model" },
    activities: []
  };
  const workflows = {
    CallMicroflowTask: {
      createInFlowUnderActivities() {
        throw new Error(
          "Type 'Workflows$CallMicroflowTask' can no longer be instantiated in Mendix version 11.10.0 (removed since Mendix version 11.9.0): replaced with the abstract class MicroflowBasedActivity."
        );
      },
      create() {
        throw new Error(
          "Type 'Workflows$CallMicroflowTask' can no longer be instantiated in Mendix version 11.10.0 (removed since Mendix version 11.9.0): replaced with the abstract class MicroflowBasedActivity."
        );
      }
    },
    EndWorkflowActivity: {
      createInFlowUnderActivities(container) {
        const activity = { type: "end" };
        container.activities.push(activity);
        return activity;
      }
    }
  };

  buildStepsInFlow({
    workflows,
    flow,
    steps: [
      { type: "serviceTask", name: "Removed", handlerMicroflowRef: "mf_removed" },
      { type: "end", name: "Done" }
    ],
    context: {
      model: {},
      moduleName: "MyFirstModule",
      microflowRefsByRef: {},
      workflowParameterName: "WorkflowContext"
    }
  });

  assert.equal(flow.activities.length, 1);
  assert.equal(flow.activities[0].type, "end");
}

function run() {
  testNormalizeStepType();
  testSetRawByNameReference();
  testResolveEntityReference();
  testValidateBooleanGatewayOutcomes();
  testBuildUserTaskAssignmentXPath();
  testApplyStringTemplate();
  testSyncServiceTaskParameterMappings();
  testCreateActivityInFlowFallsBackWhenCreateInHelperIsIllegal();
  testBuildStepsSkipsRemovedServiceTaskActivity();
  console.log("workflow builder tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
