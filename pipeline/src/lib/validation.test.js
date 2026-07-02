const assert = require("assert");
const {
  validatePlan,
  applyReservedWordSanitizationToPlan,
  SUPPORTED_PAGE_STEP_TYPES,
  normalizeActionType: normalizeValidationActionType
} = require("./validation");
const { SUPPORTED_STEPS, STEP_ALIASES } = require("../builders/page/lib/step-registry");
const { normalizeActionType: normalizeBuilderActionType } = require("../builders/microflow/microflow-builder-template");
const { navigationIconPolicyForPrompt } = require("./glyphicons");

function testReservedWordSanitization() {
  const plan = {
    app: { appId: "id", moduleName: "MyFirstModule", layoutQualifiedName: "Atlas_Core.Atlas_Default" },
    domainModel: {
      entities: [
        {
          name: "Task",
          attributes: [
            { name: "id", type: "String" },
            { name: "Title", type: "String" }
          ]
        }
      ],
      associations: [],
      enumerations: []
    },
    pages: {
      specs: [
        {
          name: "Task_Detail",
          entityRef: "MyFirstModule.Task",
          content: [{ type: "attributeInput", attributeRef: "id" }]
        }
      ]
    }
  };

  const out = applyReservedWordSanitizationToPlan(plan, "MyFirstModule");
  assert.equal(out.totalRenamed, 1);
  assert.equal(plan.domainModel.entities[0].attributes[0].name, "externalId");
  assert.equal(plan.pages.specs[0].content[0].attributeRef, "externalId");
}

function testActionSchemaErrors() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    microflows: {
      specs: [
        {
          name: "MF_Test",
          actions: [{ type: "aggregateList", function: "sum" }]
        }
      ]
    }
  };

  const errors = validatePlan(plan);
  assert(errors.some((e) => e.includes("microflows.specs[0].actions[0].listVariableName is required")));
  assert(errors.some((e) => e.includes("microflows.specs[0].actions[0].attributeRef is required")));
}

function testMicroflowSemanticBuildabilityErrors() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    domainModel: {
      entities: [
        { name: "Task", attributes: [{ name: "Title", type: "String" }, { name: "Score", type: "Integer" }] }
      ],
      associations: [],
      enumerations: []
    },
    microflows: {
      specs: [
        {
          ref: "mf_bad",
          name: "MF_Bad",
          actions: [
            { type: "retrieveList", entityRef: "Missing", outputVariableName: "MissingList" },
            { type: "aggregateList", inputListVariableName: "Tasks", function: "sum", attributeRef: "MissingScore" },
            { type: "changeVariable", variableName: "Total", valueExpression: "1" },
            { type: "changeObject", targetVariableName: "TaskObject", changes: [{ attributeRef: "MissingTitle", valueExpression: "'x'" }] },
            { type: "callMicroflow", microflowRef: "mf_other", parameterMappings: [{ parameterName: "Task", argumentExpression: "$Task" }] },
            { type: "inventedAction" }
          ]
        }
      ]
    }
  };

  const errors = validatePlan(plan);
  assert(errors.some((e) => e.includes('entityRef "Missing" could not be resolved')));
  assert(errors.some((e) => e.includes('listVariableName "Tasks" is not an assigned list variable')));
  assert(errors.some((e) => e.includes('variableName "Total" is not assigned before use')));
  assert(errors.some((e) => e.includes('targetVariableName "TaskObject" is not an assigned object variable')));
  assert(errors.some((e) => e.includes("parameterMappings are unsupported")));
  assert(errors.some((e) => e.includes('type "inventedAction" is unsupported')));
}

function testMicroflowConceptualDslAliasesFailFast() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    domainModel: {
      entities: [
        { name: "Customer", attributes: [{ name: "NoShowCount", type: "Integer" }] },
        { name: "FineHistory", attributes: [{ name: "CustomerId", type: "Integer" }] }
      ],
      associations: [],
      enumerations: []
    },
    microflows: {
      specs: [
        {
          name: "IssueFineMicroflow",
          actions: [
            { type: "retrieveObject", entity: "Customer", parameters: { id: "$customerId" }, outputVariableName: "Customer_Object" },
            {
              type: "decision",
              condition: "$Customer/NoShowCount > 2",
              trueActions: [
                { type: "createObject", entity: "FineHistory", attributes: { CustomerId: "$customerId" } },
                { type: "commitObject", object: "$FineHistory" }
              ],
              falseActions: []
            }
          ]
        }
      ]
    }
  };

  const errors = validatePlan(plan);
  assert(errors.some((e) => e.includes(".parameters is unsupported")));
  assert(errors.some((e) => e.includes(".condition is unsupported")));
  assert(errors.some((e) => e.includes(".trueActions[0].attributes is unsupported")));
  assert(errors.some((e) => e.includes(".trueActions[1].object is unsupported")));
}

function testMicroflowExpressionErrorsFailFast() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    domainModel: {
      entities: [
        {
          name: "NotificationRecord",
          attributes: [
            { name: "Message", type: "String" },
            { name: "NotificationDate", type: "DateTime" },
            { name: "IsSent", type: "Boolean" }
          ]
        },
        { name: "Customer", attributes: [{ name: "NoShowCount", type: "Integer" }] }
      ],
      associations: [],
      enumerations: []
    },
    microflows: {
      specs: [
        {
          name: "MF_BadExpressions",
          actions: [
            { type: "createObject", entity: "NotificationRecord", outputVariableName: "NotificationRecord_New" },
            {
              type: "changeObject",
              targetVariableName: "NotificationRecord_New",
              changes: [
                { attributeRef: "Message", valueExpression: "Notification sent" },
                { attributeRef: "NotificationDate", valueExpression: "tomorrow" },
                { attributeRef: "IsSent", valueExpression: "yes" }
              ]
            },
            { type: "decision", conditionExpression: "$Customer/NoShowCount" }
          ]
        }
      ]
    }
  };

  const errors = validatePlan(plan);
  assert(errors.some((e) => e.includes("valueExpression must be a quoted string literal or variable")));
  assert(errors.some((e) => e.includes("valueExpression must be a DateTime token or variable")));
  assert(errors.some((e) => e.includes("valueExpression must be true, false, or a variable")));
  assert(errors.some((e) => e.includes('references unassigned variable "$Customer"')));
  assert(errors.some((e) => e.includes("conditionExpression must be a boolean expression")));
}

function testCreateVariableInitialValueExpressionFailsFast() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    microflows: {
      specs: [
        {
          name: "SendNotificationToStudent",
          actions: [
            {
              type: "createVariable",
              variableName: "Message",
              variableType: "String",
              initialValueExpression: "Session.Student.Email"
            }
          ]
        }
      ]
    }
  };

  const errors = validatePlan(plan);
  assert(errors.some((e) => e.includes("initialValueExpression.valueExpression must be a quoted string literal or variable")));
}

function testMicroflowEntityNameParameterTypeIsObjectVariable() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    domainModel: {
      entities: [
        { name: "Customer", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [],
      enumerations: []
    },
    microflows: {
      specs: [
        {
          name: "MF_CustomerParam",
          parameters: [{ name: "customer", type: "Customer" }],
          actions: [
            { type: "decision", conditionExpression: "$customer/Name != empty", trueActions: [], falseActions: [] }
          ]
        }
      ]
    }
  };

  const errors = validatePlan(plan);
  assert.equal(errors.length, 0, `Expected entity-name parameter type to be accepted, got: ${errors.join("; ")}`);

  plan.microflows.specs[0].parameters[0].type = "UnknownDomainType";
  const invalidErrors = validatePlan(plan);
  assert(invalidErrors.some((e) => e.includes('parameters[0].type "UnknownDomainType" is unsupported')));
}

function testCreateAppAllowsMissingAppId() {
  const plan = {
    app: {
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    execution: {
      createApp: true
    },
    domainModel: {
      entities: [],
      associations: [],
      enumerations: []
    }
  };

  const errors = validatePlan(plan);
  assert.equal(errors.length, 0, `Expected no validation errors, got: ${errors.join("; ")}`);
}

function testMissingAppIdStillFailsWithoutCreateApp() {
  const plan = {
    app: {
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    domainModel: {
      entities: [],
      associations: [],
      enumerations: []
    }
  };

  const errors = validatePlan(plan);
  assert(errors.some((e) => e.includes("app.appId is required and must be a string.")));
}

function testCreateAppFieldValidation() {
  const base = {
    app: {
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    execution: {
      createApp: true
    },
    domainModel: {
      entities: [],
      associations: [],
      enumerations: []
    }
  };

  const withBadPrefix = JSON.parse(JSON.stringify(base));
  withBadPrefix.execution.createAppNamePrefix = 123;
  const prefixErrors = validatePlan(withBadPrefix);
  assert(prefixErrors.some((e) => e.includes("execution.createAppNamePrefix must be a string")));

  const withBadCreateAppName = JSON.parse(JSON.stringify(base));
  withBadCreateAppName.execution.createAppName = 123;
  const createAppNameErrors = validatePlan(withBadCreateAppName);
  assert(createAppNameErrors.some((e) => e.includes("execution.createAppName must be a string")));

  const withBadRepoType = JSON.parse(JSON.stringify(base));
  withBadRepoType.execution.createAppRepositoryType = "svn";
  const repoErrors = validatePlan(withBadRepoType);
  assert(repoErrors.some((e) => e.includes('execution.createAppRepositoryType must be "git"')));
}

function testInvalidAssociationTypeFailsBeforeSdkBuild() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    domainModel: {
      entities: [
        { name: "ApprovalRequest", attributes: [{ name: "Title", type: "String" }] },
        { name: "Comment", attributes: [{ name: "Body", type: "String" }] }
      ],
      associations: [
        {
          name: "ApprovalRequest_Comment",
          parentEntity: "ApprovalRequest",
          childEntity: "Comment",
          type: "hasComment"
        }
      ],
      enumerations: []
    }
  };

  const errors = validatePlan(plan);
  assert(errors.some((e) => e.includes('domainModel.associations[0].type "hasComment" is not supported')));

  plan.domainModel.associations[0].type = "many-to-many";
  assert.equal(validatePlan(plan).length, 0);
}

function testAssociationSetInputPreflightValidation() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    domainModel: {
      entities: [
        { name: "Workout", attributes: [{ name: "Name", type: "String" }] },
        { name: "Exercise", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [
        {
          name: "Workout_Exercise",
          parentEntity: "Workout",
          childEntity: "Exercise",
          type: "ReferenceSet"
        }
      ],
      enumerations: []
    },
    pages: {
      specs: [
        {
          ref: "workout_newedit",
          name: "Workout_NewEdit",
          entityRef: "MyFirstModule.Workout",
          content: [
            {
              type: "associationSetInput",
              associationRef: "Workout_Exercise",
              targetEntityRef: "MyFirstModule.Exercise"
            }
          ]
        }
      ]
    }
  };

  assert.equal(validatePlan(plan).length, 0);

  const badType = JSON.parse(JSON.stringify(plan));
  badType.domainModel.associations[0].type = "Reference";
  assert(validatePlan(badType).some((e) => e.includes("must point to a ReferenceSet association")));

  const badTarget = JSON.parse(JSON.stringify(plan));
  badTarget.pages.specs[0].content[0].targetEntityRef = "MyFirstModule.Workout";
  assert(validatePlan(badTarget).some((e) => e.includes("must differ from the reference-set context entity")));
}

function testAssociationInputPreflightValidationRejectsReferenceSet() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    domainModel: {
      entities: [
        { name: "Workout", attributes: [{ name: "Name", type: "String" }] },
        { name: "Exercise", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [
        {
          name: "Workout_Exercise",
          parentEntity: "Workout",
          childEntity: "Exercise",
          type: "ReferenceSet"
        }
      ],
      enumerations: []
    },
    pages: {
      specs: [
        {
          ref: "workout_newedit",
          name: "Workout_NewEdit",
          entityRef: "MyFirstModule.Workout",
          content: [
            {
              type: "associationInput",
              associationRef: "Workout_Exercise",
              targetEntityRef: "MyFirstModule.Exercise"
            }
          ]
        }
      ]
    }
  };

  const errors = validatePlan(plan);
  assert(errors.some((e) =>
    e.includes('associationRef "Workout_Exercise" must point to a Reference association, found "ReferenceSet"')
  ));
}

function testGeneratedPlanRequiresNavigationContract() {
  const plan = {
    meta: {
      planVersion: "1.1.0",
      generatedBy: "pipeline.plan-generator"
    },
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default",
      homePageRef: "home"
    },
    pages: {
      specs: [
        { ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Home" }] },
        { ref: "task_overview", name: "Task_Overview", content: [{ type: "dynamicText", text: "Tasks" }] }
      ]
    },
    domainModel: {
      entities: [{ name: "Task", attributes: [{ name: "Title", type: "String" }] }],
      associations: [],
      enumerations: []
    }
  };

  const errors = validatePlan(plan);
  assert(errors.some((e) => e.includes("security is required for plans generated by pipeline.plan-generator")));
  assert(errors.some((e) => e.includes("app.navigation.homePageButtons") || e.includes("app.navigation.menuItems")));

  plan.security = {
    moduleRoles: ["Manager"],
    userRoles: [{ name: "Manager", moduleRoles: ["Manager"] }]
  };

  plan.app.navigation = {
    homePageButtons: [{ pageRef: "task_overview", icon: { name: "home" } }],
    menuItems: [{ pageRef: "task_overview", icon: { name: "home" }, allowedRoles: ["Manager"] }]
  };
  const nextErrors = validatePlan(plan);
  assert.equal(nextErrors.length, 0, `Expected no validation errors, got: ${nextErrors.join("; ")}`);
  assert(navigationIconPolicyForPrompt().includes('{ "name": "home" }'));

  plan.app.navigation = {
    homePageButtons: [{ pageRef: "task_overview", icon: { name: "not-a-real-glyph" } }],
    menuItems: [{ pageRef: "task_overview", icon: { name: "home" }, allowedRoles: ["Manager"] }]
  };
  const invalidIconErrors = validatePlan(plan);
  assert(invalidIconErrors.some((e) => e.includes("only supports the home icon")));

  plan.app.navigation = {
    homePageButtons: [{ pageRef: "task_overview", icon: { code: 999999 } }],
    menuItems: [{ pageRef: "task_overview", icon: 999999, allowedRoles: ["Manager"] }]
  };
  const invalidNumericIconErrors = validatePlan(plan);
  assert(invalidNumericIconErrors.some((e) => e.includes("only supports the home icon")));
}

function testWorkflowUserRoleRefsValidateAgainstSecurity() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    security: {
      userRoles: [{ name: "Manager", moduleRoles: ["Manager"] }]
    },
    workflows: {
      specs: [
        {
          name: "WF_Test",
          bindings: { contextEntityRef: "MyFirstModule.Task" },
          steps: [
            { type: "start", name: "Start" },
            { type: "userTask", name: "Review", userRoleRefs: ["Manager"] }
          ]
        }
      ]
    }
  };

  const errors = validatePlan(plan);
  assert.equal(errors.length, 0, `Expected no validation errors, got: ${errors.join("; ")}`);

  plan.workflows.specs[0].steps[1].userRoleRefs = ["Missing Role"];
  const nextErrors = validatePlan(plan);
  assert(nextErrors.some((error) => error.includes("requires explicit userAssignmentXPath") || error.includes("missing security.userRoles")));
}

function testReservedBuiltInSecurityUserRoleNamesFailFast() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    security: {
      userRoles: [{ name: "Administrator", moduleRoles: ["Admin"], systemModuleRole: "System.Administrator" }]
    },
    pages: {
      specs: [{ ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Home" }] }]
    }
  };

  const errors = validatePlan(plan);
  assert(errors.some((error) => error.includes("reserved Mendix built-in user role name")));
}

function testNavigationToParameterizedPageFailsFast() {
  const plan = {
    meta: { planVersion: "1.1.0", generatedBy: "pipeline.plan-generator" },
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default",
      homePageRef: "home",
      navigation: {
        homePageButtons: [{ pageRef: "task_page" }],
        menuItems: [{ pageRef: "task_page" }]
      }
    },
    pages: {
      specs: [
        { ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Home" }] },
        {
          ref: "task_page",
          name: "Task_Page",
          pageParameters: [{ name: "WorkflowUserTask", entityRef: "System.WorkflowUserTask", required: true }],
          content: [{ type: "dynamicText", text: "Task" }]
        }
      ]
    }
  };

  const errors = validatePlan(plan);
  assert(errors.some((error) => error.includes("cannot be opened directly from homepage navigation")));
  assert(errors.some((error) => error.includes("cannot be opened directly from menu navigation")));
}

function testNavigationToMissingPageFailsFastWithoutThrowing() {
  const plan = {
    meta: { generatedBy: "pipeline.plan-generator", planVersion: "1.2.0" },
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default",
      navigation: {
        homePageButtonRefs: ["home"],
        navigationItemRefs: ["home"],
        homePageButtons: [{ pageRef: "missing_page" }],
        menuItems: [{ pageRef: "missing_page" }]
      }
    },
    domainModel: { entities: [], associations: [], enumerations: [] },
    pages: { specs: [{ ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Home" }] }] }
  };

  const errors = validatePlan(plan);
  assert(errors.some((e) => e.includes('app.navigation.homePageButtons[0].pageRef points to unknown page "missing_page"')));
  assert(errors.some((e) => e.includes('app.navigation.menuItems[0].pageRef points to unknown page "missing_page"')));
}

function testOpenLinkButtonRequiresSafeAbsoluteUrl() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    pages: {
      specs: [
        {
          ref: "home",
          name: "Home",
          content: [{ type: "openLinkButton", caption: "Docs", url: "javascript:alert(1)" }]
        }
      ]
    }
  };

  const errors = validatePlan(plan);
  assert(errors.some((error) => error.includes(".url must be a valid absolute http(s), mailto, or tel URL.")));

  plan.pages.specs[0].content[0].url = "https://example.com";
  const nextErrors = validatePlan(plan);
  assert.equal(nextErrors.length, 0, `Expected no validation errors, got: ${nextErrors.join("; ")}`);
}

function testInvalidDomainIdentifiersFailFast() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    domainModel: {
      entities: [
        {
          name: "Bad Entity",
          attributes: [{ name: "start date", type: "DateTime" }]
        }
      ],
      associations: [],
      enumerations: [{ name: "Lesson Type", values: ["private lesson"] }]
    },
    pages: { specs: [] }
  };

  const errors = validatePlan(plan);
  assert(errors.some((error) => error.includes('domainModel.entities[0].name "Bad Entity" is not a valid Mendix entity name')));
  assert(errors.some((error) => error.includes('domainModel.entities[0].attributes[0].name "start date" is not a valid Mendix attribute name')));
  assert(errors.some((error) => error.includes('domainModel.enumerations[0].name "Lesson Type" is not a valid Mendix enumeration name')));
  assert(errors.some((error) => error.includes('domainModel.enumerations[0].values[0] "private lesson" is not a valid Mendix enumeration value')));
}

function testStalePageAttributeRefsFailFast() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    domainModel: {
      entities: [{ name: "Lesson", attributes: [{ name: "StartTime", type: "DateTime" }] }],
      associations: [],
      enumerations: []
    },
    pages: {
      specs: [
        {
          ref: "lesson_overview",
          name: "Lesson_Overview",
          entityRef: "MyFirstModule.Lesson",
          content: [
            {
              type: "listView",
              entityRef: "MyFirstModule.Lesson",
              itemContent: [{ type: "attributeInput", attributeRef: "Status" }]
            },
            {
              type: "dataGrid",
              entityRef: "MyFirstModule.Lesson",
              columns: [{ attributeRef: "CreatedAt" }],
              search: { fields: [{ attributeRef: "Title" }] }
            }
          ]
        }
      ]
    }
  };

  const errors = validatePlan(plan);
  assert(errors.some((error) => error.includes('unknown attribute "Lesson.Status"')));
  assert(errors.some((error) => error.includes('unknown attribute "Lesson.CreatedAt"')));
  assert(errors.some((error) => error.includes('unknown attribute "Lesson.Title"')));

  plan.pages.specs[0].content[0].itemContent[0].attributeRef = "StartTime";
  plan.pages.specs[0].content[1].columns[0].attributeRef = "StartTime";
  plan.pages.specs[0].content[1].search.fields[0].attributeRef = "StartTime";
  assert.equal(validatePlan(plan).length, 0);
}

function testPageStepContractCoversBuilderRegistry() {
  for (const stepType of SUPPORTED_STEPS) {
    assert(
      SUPPORTED_PAGE_STEP_TYPES.includes(stepType),
      `Validation must accept page builder step type "${stepType}"`
    );
  }

  for (const alias of Object.keys(STEP_ALIASES)) {
    assert(
      SUPPORTED_PAGE_STEP_TYPES.includes(alias),
      `Validation must accept page builder alias "${alias}"`
    );
  }
}

function testMicroflowActionAliasContractMatchesBuilder() {
  const aliases = [
    "show_message",
    "call_microflow",
    "call_nanoflow",
    "retrieve_list",
    "retrieve_object",
    "create_object",
    "aggregate_list",
    "create_variable",
    "change_variable",
    "decision",
    "if",
    "change_object",
    "commit_object",
    "return_value"
  ];

  for (const alias of aliases) {
    assert.equal(
      normalizeValidationActionType(alias),
      normalizeBuilderActionType(alias),
      `Validation and builder action normalization drifted for "${alias}"`
    );
  }
}

function testDuplicateArtifactNamesFailFast() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default"
    },
    security: {
      moduleRoles: ["Manager", "manager"],
      userRoles: [
        { name: "Manager", moduleRoles: ["Manager"] },
        { name: "manager", moduleRoles: ["Manager"] }
      ]
    },
    domainModel: {
      entities: [
        {
          name: "Task",
          attributes: [
            { name: "Title", type: "String" },
            { name: "title", type: "String" }
          ]
        },
        { name: "task", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [
        { name: "Task_Owner", parentEntity: "Task", childEntity: "Owner" },
        { name: "task_owner", parentEntity: "Task", childEntity: "Owner" }
      ],
      enumerations: [
        { name: "TaskStatus", values: ["Open", "open"] },
        { name: "taskstatus", values: ["Closed"] }
      ]
    },
    pages: {
      specs: [
        { ref: "task_page", name: "Task_Page", content: [{ type: "dynamicText", text: "Task" }] },
        { ref: "Task_Page", name: "task_page", content: [{ type: "dynamicText", text: "Task" }] }
      ]
    },
    microflows: {
      specs: [
        { ref: "mf_task", name: "MF_Task", actions: [] },
        { ref: "MF_Task", name: "mf_task", actions: [] }
      ]
    },
    workflows: {
      specs: [
        {
          ref: "wf_task",
          name: "WF_Task",
          bindings: { contextEntityRef: "MyFirstModule.Task" },
          steps: [{ type: "start", name: "Start" }]
        },
        {
          ref: "WF_Task",
          name: "wf_task",
          bindings: { contextEntityRef: "MyFirstModule.Task" },
          steps: [{ type: "start", name: "Start" }]
        }
      ]
    }
  };

  const errors = validatePlan(plan);
  assert(errors.some((e) => e.includes("duplicates entity name")));
  assert(errors.some((e) => e.includes("duplicates attribute name")));
  assert(errors.some((e) => e.includes("duplicates association name")));
  assert(errors.some((e) => e.includes("duplicates enumeration name")));
  assert(errors.some((e) => e.includes("duplicates enumeration value")));
  assert(errors.some((e) => e.includes("duplicates page ref")));
  assert(errors.some((e) => e.includes("duplicates page name")));
  assert(errors.some((e) => e.includes("duplicates microflow ref")));
  assert(errors.some((e) => e.includes("duplicates microflow name")));
  assert(errors.some((e) => e.includes("duplicates workflow ref")));
  assert(errors.some((e) => e.includes("duplicates workflow name")));
  assert(errors.some((e) => e.includes("duplicates module role name")));
  assert(errors.some((e) => e.includes("duplicates user role name")));
}

function testDomainModelSharedNamespaceDuplicatesFailFast() {
  const plan = {
    app: {
      appId: "id",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default",
      navigation: { homePageButtonRefs: ["home"], navigationItemRefs: ["home"] }
    },
    domainModel: {
      entities: [{ name: "MembershipStatus", attributes: [{ name: "Name", type: "String" }] }],
      associations: [{ name: "MembershipStatus", parentEntity: "MembershipStatus", childEntity: "MembershipStatus", type: "Reference" }],
      enumerations: [{ name: "MembershipStatus", values: ["Active", "Expired"] }]
    },
    pages: { specs: [{ ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Home" }] }] }
  };

  const errors = validatePlan(plan);
  assert(errors.some((e) => e.includes("domainModel.associations[0].name duplicates entity")));
  assert(errors.some((e) => e.includes("domainModel.enumerations[0].name duplicates entity")));
}

function run() {
  testReservedWordSanitization();
  testActionSchemaErrors();
  testMicroflowSemanticBuildabilityErrors();
  testMicroflowConceptualDslAliasesFailFast();
  testMicroflowExpressionErrorsFailFast();
  testCreateVariableInitialValueExpressionFailsFast();
  testMicroflowEntityNameParameterTypeIsObjectVariable();
  testCreateAppAllowsMissingAppId();
  testMissingAppIdStillFailsWithoutCreateApp();
  testCreateAppFieldValidation();
  testInvalidAssociationTypeFailsBeforeSdkBuild();
  testAssociationSetInputPreflightValidation();
  testAssociationInputPreflightValidationRejectsReferenceSet();
  testGeneratedPlanRequiresNavigationContract();
  testWorkflowUserRoleRefsValidateAgainstSecurity();
  testReservedBuiltInSecurityUserRoleNamesFailFast();
  testNavigationToParameterizedPageFailsFast();
  testNavigationToMissingPageFailsFastWithoutThrowing();
  testOpenLinkButtonRequiresSafeAbsoluteUrl();
  testInvalidDomainIdentifiersFailFast();
  testStalePageAttributeRefsFailFast();
  testPageStepContractCoversBuilderRegistry();
  testMicroflowActionAliasContractMatchesBuilder();
  testDuplicateArtifactNamesFailFast();
  testDomainModelSharedNamespaceDuplicatesFailFast();
  console.log("pipeline validation tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
