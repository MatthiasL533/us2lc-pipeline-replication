const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { validatePlan } = require("./lib/validation");
const { parseArgs: parseGeneratorCliArgs } = require("./plan-generator-cli");
const { parseArgs: parseGenerateVnCliArgs } = require("./generate-vn-cli");
const { parseArgs: parseGenerateProcessVizCliArgs } = require("./generate-process-viz-cli");
const { parseArgs: parseE2eArgs, parseCommanderOutput, formatPlanCheckerFailure } = require("./e2e-runner");
const { formatMissingStory } = require("./generator/coverage-gate");
const { runPreprocessingStages } = require("./generator/input-bundle");
const { callWithRetries } = require("./generator/llm-client");
const { ProcessVisualizerError } = require("./lib/process-visualizer");
const { buildVisualNarratorPromptText } = require("./lib/visual-narrator");
const { _private: modelBuilderPrivate } = require("./model-builder");
const {
  DEFAULT_PROCESS_VISUALIZER_MODEL,
  PlanGeneratorError,
  SUPPORTED_PAGE_STEP_TYPES,
  SUPPORTED_MICROFLOW_ACTION_TYPES,
  loadInputBundle,
  normalizeGeneratedPlan,
  applyCoverageEntityCandidates,
  applyDomainModelReview,
  applyAssociationGeneration,
  applyDeterministicAssociationEvidence,
  collectDeterministicAssociationHints,
  auditAssociationGaps,
  runAssociationGenerationStage,
  buildStoryDrivenBaselineDraft,
  buildOllamaPrompt,
  callOllamaGenerate,
  evaluateStoryCoverage,
  ensureWorkflowScaffold,
  ensureWorkflowStartButtons,
  ensureEntityCrudPages,
  ensureNavigationSpecAndHomeButtons,
  detectVisualNarratorInputArtifacts,
  detectProcessVisualizerInputArtifacts,
  generateVisualNarratorArtifactsFromInputDir,
  generateProcessVisualizerArtifactsFromInputDir,
  generatePlanFromInputDir
} = require("./plan-generator");

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeRequiredInputFiles(dir, overrides = {}) {
  const stories = overrides.userStories || "As an admin, I want to manage tickets.";
  const appContext = overrides.appContext || {
    appId: "00000000-0000-0000-0000-000000000000",
    moduleName: "MyFirstModule",
    branch: "main"
  };

  writeFile(path.join(dir, "user-stories.txt"), stories);
  writeFile(path.join(dir, "app-context.json"), JSON.stringify(appContext, null, 2));

  if (overrides.domainInfo !== undefined) {
    writeFile(path.join(dir, "domain-info.txt"), overrides.domainInfo);
  }
  if (overrides.acceptanceCriteria !== undefined) {
    writeFile(path.join(dir, "acceptance-criteria.txt"), overrides.acceptanceCriteria);
  }
  if (overrides.bpmn !== undefined) {
    writeFile(path.join(dir, "process.bpmn"), overrides.bpmn);
  }
}

function testMissingRequiredFiles() {
  const tmp = mkTmpDir("plan-generator-required-");
  writeFile(path.join(tmp, "app-context.json"), JSON.stringify({ appId: "id", moduleName: "MyFirstModule" }, null, 2));

  assert.throws(() => loadInputBundle(tmp), (err) => {
    assert(err instanceof PlanGeneratorError);
    assert(err.message.includes("Missing required input file(s): user-stories.txt"));
    return true;
  });
}

function testOptionalTxtFilesAreAccepted() {
  const tmp = mkTmpDir("plan-generator-optional-");
  writeRequiredInputFiles(tmp);

  const bundle = loadInputBundle(tmp);
  assert.equal(bundle.userStories.length > 0, true);
  assert.equal(bundle.domainInfo, "");
  assert.equal(bundle.acceptanceCriteria, "");
}

function testAcceptanceCriteriaFileIsAccepted() {
  const tmp = mkTmpDir("plan-generator-acceptance-criteria-");
  writeRequiredInputFiles(tmp, {
    acceptanceCriteria: [
      "Global:",
      "- Members must not access admin-only management pages.",
      "US01:",
      "- Members can view the gym list."
    ].join("\n")
  });

  const bundle = loadInputBundle(tmp);
  assert(bundle.acceptanceCriteria.includes("Members must not access admin-only management pages."));
  assert.equal(bundle.domainInfo, "");
}

function testAppIdIsRequired() {
  const tmp = mkTmpDir("plan-generator-appid-");
  writeRequiredInputFiles(tmp, {
    appContext: {
      moduleName: "MyFirstModule"
    }
  });

  assert.throws(() => loadInputBundle(tmp), (err) => {
    assert(err instanceof PlanGeneratorError);
    assert(err.message.includes("Invalid app-context.json"));
    assert(Array.isArray(err.details));
    assert(err.details.some((entry) => entry.includes("appId is required unless createApp is true or seedAppId is provided")));
    return true;
  });
}

function testCreateAppInputAllowsMissingAppId() {
  const tmp = mkTmpDir("plan-generator-createapp-");
  writeRequiredInputFiles(tmp, {
    appContext: {
      moduleName: "MyFirstModule",
      createApp: true,
      appName: "Generated App"
    }
  });

  const bundle = loadInputBundle(tmp);
  assert.equal(bundle.appContext.createApp, true);
  assert.equal(bundle.appContext.appName, "Generated App");
}

function testBpmnWarning() {
  const tmp = mkTmpDir("plan-generator-bpmn-");
  writeRequiredInputFiles(tmp, {
    bpmn: "<definitions><process id=\"p1\"/></definitions>"
  });

  const bundle = loadInputBundle(tmp);
  assert(bundle.warnings.some((w) => w.includes("ignored in v1")));
}

function testNormalizeGeneratedPlanProducesValidPlan() {
  const draft = {
    app: {
      navigation: {
        homePageButtonRefs: ["home"],
        navigationItemRefs: ["home"]
      }
    },
    domainModel: {
      entities: [
        {
          name: "Ticket",
          attributes: [
            { name: "Title", type: "String", required: true },
            { name: "Status", type: { kind: "Enum", enumName: "TicketStatus" }, required: true }
          ]
        },
        {
          name: "Workflow",
          attributes: [{ name: "Name", type: "String", required: true }]
        },
        {
          name: "Microflow",
          attributes: [{ name: "Name", type: "String", required: true }]
        }
      ],
      associations: [],
      enumerations: [{ name: "TicketStatus", values: ["Open", "Closed"] }]
    },
    microflows: {
      specs: [
        {
          ref: "mf_close_ticket",
          name: "MF_CloseTicket",
          actions: [{ type: "showMessage", message: "Ticket closed." }]
        }
      ]
    },
    workflows: {
      specs: [
        {
          ref: "wf_ticket_review",
          name: "WF_TicketReview",
          bindings: { contextEntityRef: "MyFirstModule.Ticket" },
          steps: [{ type: "start", name: "Start" }, { type: "end", name: "Done" }]
        }
      ]
    },
    pages: {
      specs: [
        {
          ref: "home",
          name: "Home",
          title: "Home",
          content: [{ type: "dynamicText", text: "Welcome", renderMode: "H2" }]
        }
      ]
    }
  };

  const appContext = {
    appId: "00000000-0000-0000-0000-000000000000",
    moduleName: "MyFirstModule",
    branch: "main",
    appName: "US2LC Pipeline Demo"
  };

  const out = normalizeGeneratedPlan({ generatedPlan: draft, appContext });
  const errors = validatePlan(out.plan);
  assert.equal(errors.length, 0, `Expected valid normalized plan, got: ${errors.join("; ")}`);
  assert.equal(out.plan.execution.createAppName, "US2LC Pipeline Demo");
  assert.equal(Boolean(out.plan.security), true);
  assert.equal(out.plan.security.securityLevel, "prototype");
  assert.deepEqual(out.plan.security.moduleRoles, ["AppUser"]);
  assert.deepEqual(
    out.plan.security.userRoles.map((role) => role.name),
    ["AppUser"]
  );
  assert.deepEqual(out.plan.domainModel.entities.map((entity) => entity.name), ["Ticket", "AppUser"]);
  assert(out.warnings.some((warning) => warning.includes("Dropped non-domain artifact entity \"Workflow\"")));
  assert(out.warnings.some((warning) => warning.includes("Dropped non-domain artifact entity \"Microflow\"")));
  assert.equal(out.plan.microflows.specs[0].ref, "mf_close_ticket");
  assert.equal(out.plan.workflows.specs[0].ref, "wf_ticket_review");
}

function testNormalizeGeneratedPlanNormalizesReferenceSetLookupToDropdownInput() {
  const draft = {
    app: {
      navigation: {
        homePageButtonRefs: ["workout_overview"],
        navigationItemRefs: ["workout_overview"]
      }
    },
    domainModel: {
      entities: [
        { name: "Workout", attributes: [{ name: "Name", type: "String" }] },
        { name: "Exercise", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [
        { name: "Workout_Exercise", parentEntity: "Workout", childEntity: "Exercise", type: "ReferenceSet" }
      ],
      enumerations: []
    },
    pages: {
      specs: [
        {
          ref: "workout_overview",
          name: "Workout_Overview",
          entityRef: "MyFirstModule.Workout",
          content: [{ type: "dynamicText", text: "Workouts", renderMode: "H2" }]
        },
        {
          ref: "workout_newedit",
          name: "Workout_NewEdit",
          entityRef: "MyFirstModule.Workout",
          content: [
            {
              type: "dataView",
              pageParameterName: "Workout",
              content: [
                { type: "attributeInput", attributeRef: "Name" },
                {
                  type: "associationInput",
                  associationRef: "Workout_Exercise",
                  targetEntityRef: "MyFirstModule.Exercise"
                }
              ]
            }
          ],
          pageParameters: [{ name: "Workout", entityRef: "MyFirstModule.Workout", required: true }]
        }
      ]
    }
  };

  const appContext = {
    appId: "00000000-0000-0000-0000-000000000000",
    moduleName: "MyFirstModule",
    branch: "main"
  };

  const out = normalizeGeneratedPlan({ generatedPlan: draft, appContext });
  const workoutPage = out.plan.pages.specs.find((page) => page.ref === "workout_newedit");
  const lookup = workoutPage.content[0].content.find((step) => step.associationRef === "Workout_Exercise");

  assert.equal(out.plan.domainModel.associations[0].type, "Reference");
  assert.equal(out.plan.domainModel.associations[0].metadata.relationshipType, "ReferenceSet");
  assert.equal(lookup.type, "associationInput");
  assert.equal(validatePlan(out.plan).length, 0);
  assert(out.warnings.some((warning) => warning.includes('Normalized reference-set association "Workout_Exercise" to Reference')));
}

function testNormalizeGeneratedPlanDropsTitleOnlyPlaceholderPages() {
  const draft = {
    app: {
      navigation: {
        homePageButtonRefs: ["home"],
        navigationItemRefs: ["home"]
      }
    },
    domainModel: {
      entities: [
        {
          name: "Gym",
          attributes: [
            { name: "Name", type: "String" },
            { name: "Address", type: "String" }
          ]
        }
      ],
      associations: [],
      enumerations: []
    },
    pages: {
      specs: [
        {
          ref: "gymlist",
          name: "GymList",
          title: "Gym List",
          content: [{ type: "dynamicText", text: "Gym List", renderMode: "H2" }]
        }
      ]
    }
  };

  const appContext = {
    appId: "00000000-0000-0000-0000-000000000000",
    moduleName: "MyFirstModule",
    branch: "main"
  };

  const out = normalizeGeneratedPlan({ generatedPlan: draft, appContext });
  const refs = out.plan.pages.specs.map((page) => page.ref);

  assert(refs.includes("gym_overview"));
  assert(refs.includes("gymlist"));
  assert(!out.warnings.some((warning) => warning.includes('Dropped placeholder page "gymlist"')));
  ensureNavigationSpecAndHomeButtons(out.plan, out.warnings);
  assert.equal(validatePlan(out.plan).length, 0);
}

function testNormalizeGeneratedPlanSanitizesNavigationIcons() {
  const draft = {
    app: {
      navigation: {
        homePageButtons: [{ pageRef: "home", icon: { name: "tasks" } }],
        menuItems: [{ pageRef: "home", icon: { name: "workflow" } }]
      }
    },
    domainModel: {
      entities: [{ name: "Request", attributes: [{ name: "Title", type: "String" }] }],
      associations: [],
      enumerations: []
    },
    pages: {
      specs: [{ ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Home" }] }]
    }
  };

  const out = normalizeGeneratedPlan({
    generatedPlan: draft,
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  assert.deepEqual(out.plan.app.navigation.homePageButtons[0].icon, { name: "home" });
  assert.deepEqual(out.plan.app.navigation.menuItems[0].icon, { name: "home" });
  assert(out.warnings.some((warning) => warning.includes("Replaced unsupported navigation icon")));
  assert.equal(validatePlan(out.plan).length, 0);
}

function testNormalizeGeneratedPlanAugmentsNameOnlyEntities() {
  const draft = {
    domainModel: {
      entities: [{ name: "MealPlanRecipe", attributes: [{ name: "Name", type: "String", required: true }] }],
      associations: [],
      enumerations: []
    },
    pages: {
      specs: [{ ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Home" }] }]
    }
  };

  const out = normalizeGeneratedPlan({
    generatedPlan: draft,
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  const entity = out.plan.domainModel.entities.find((item) => item.name === "MealPlanRecipe");
  assert(entity.attributes.length > 1);
  assert(entity.attributes.some((attr) => attr.name === "Title"));
  ensureNavigationSpecAndHomeButtons(out.plan, out.warnings);
  assert.equal(validatePlan(out.plan).length, 0);
}

function testNormalizeGeneratedPlanUsesOnlyGenericDefaultsForCategoryNames() {
  const draft = {
    domainModel: {
      entities: [
        { name: "Notification", attributes: [{ name: "Name", type: "String", required: true }] },
        { name: "Employee", attributes: [{ name: "Name", type: "String", required: true }] }
      ],
      associations: [],
      enumerations: []
    },
    pages: {
      specs: [{ ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Home" }] }]
    }
  };

  const out = normalizeGeneratedPlan({
    generatedPlan: draft,
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  const notification = out.plan.domainModel.entities.find((item) => item.name === "Notification");
  const employee = out.plan.domainModel.entities.find((item) => item.name === "Employee");
  const genericDefaultNames = ["Name", "Title", "Description", "Status", "CreatedAt"];
  assert.deepEqual(notification.attributes.map((attr) => attr.name), genericDefaultNames);
  assert.deepEqual(employee.attributes.map((attr) => attr.name), genericDefaultNames);
  assert(!notification.attributes.some((attr) => attr.name === "Message" || attr.name === "IsRead"));
  assert(!employee.attributes.some((attr) => attr.name === "FullName" || attr.name === "Email"));
}

function testNormalizeGeneratedPlanFiltersInstructionalRoleNames() {
  const out = normalizeGeneratedPlan({
    generatedPlan: {
      domainModel: {
        entities: [{ name: "MealPlanApprovalRequest", attributes: [{ name: "Status", type: "String" }] }],
        associations: [],
        enumerations: []
      },
      pages: { specs: [{ ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Home" }] }] }
    },
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    },
    stories: [
      {
        id: "US01",
        raw: "As a Chef Instructor, I want to approve meal plan requests.",
        role: "Chef Instructor",
        want: "approve meal plan requests",
        benefit: "",
        tags: [],
        tokens: []
      }
    ],
    domainInfo: "Core roles:\n- Chef Instructor: reviews requests.\n- The workflow should create a user task assigned to the Chef Instructor role."
  });

  const roleNames = out.plan.security.userRoles.map((role) => role.name);
  assert(roleNames.includes("ChefInstructor"));
  assert(!roleNames.some((role) => /WorkflowShouldCreate|AssignedTo/i.test(role)));
}

function testWorkflowScaffoldPrefersExplicitContextAndFinalStartRepair() {
  const warnings = [];
  const plan = {
    app: { moduleName: "MyFirstModule" },
    security: { userRoles: [{ name: "ChefInstructor" }] },
    domainModel: {
      entities: [
        { name: "PlanRequest", attributes: [{ name: "Title", type: "String" }] },
        { name: "MealPlanApprovalRequest", attributes: [{ name: "Status", type: "String" }] }
      ],
      associations: [],
      enumerations: []
    },
    pages: { specs: [] }
  };
  const stories = [
    {
      id: "US01",
      raw: "As a Chef Instructor, I want to approve meal plan approval requests.",
      role: "Chef Instructor",
      want: "approve meal plan approval requests",
      benefit: "",
      tags: [],
      tokens: []
    }
  ];

  ensureWorkflowScaffold(
    plan,
    stories,
    warnings,
    "MealPlanApprovalRequest: the workflow context entity for meal plan approval."
  );
  assert.equal(plan.workflows.specs[0].bindings.contextEntityRef, "MyFirstModule.MealPlanApprovalRequest");

  const detail = plan.pages.specs.find((page) => page.ref === "mealplanapprovalrequest_newedit");
  detail.content[0].content = detail.content[0].content.filter((step) => step.type !== "callWorkflowButton");
  ensureWorkflowStartButtons(plan, warnings);
  assert(detail.content[0].content.some((step) => step.type === "callWorkflowButton" && step.workflowRef === "wf_mealplanapprovalrequest"));
}

function testDomainReviewDropsSpecificDuplicateGenericEntities() {
  const warnings = [];
  const plan = {
    app: {
      moduleName: "MyFirstModule",
      navigation: {
        homePageButtons: [{ pageRef: "school_overview" }, { pageRef: "cookingschool_overview" }],
        menuItems: [{ pageRef: "school_overview" }, { pageRef: "cookingschool_overview" }]
      }
    },
    domainModel: {
      entities: [
        { name: "School", attributes: [{ name: "Title", type: "String" }, { name: "Status", type: "String" }] },
        { name: "CookingSchool", attributes: [{ name: "Name", type: "String" }, { name: "Address", type: "String" }] },
        { name: "PlanRequest", attributes: [{ name: "Title", type: "String" }, { name: "Status", type: "String" }] },
        { name: "MealPlanApprovalRequest", attributes: [{ name: "Status", type: "String" }] }
      ],
      associations: [
        { name: "School_Request", parentEntity: "School", childEntity: "PlanRequest", type: "Reference" }
      ],
      enumerations: []
    },
    pages: {
      specs: [
        { ref: "school_overview", name: "School_Overview", entityRef: "MyFirstModule.School", content: [{ type: "listView", entityRef: "MyFirstModule.School" }] },
        { ref: "cookingschool_overview", name: "CookingSchool_Overview", entityRef: "MyFirstModule.CookingSchool", content: [{ type: "listView", entityRef: "MyFirstModule.CookingSchool" }] },
        { ref: "planrequest_overview", name: "PlanRequest_Overview", entityRef: "MyFirstModule.PlanRequest", content: [{ type: "listView", entityRef: "MyFirstModule.PlanRequest" }] },
        { ref: "mealplanapprovalrequest_overview", name: "MealPlanApprovalRequest_Overview", entityRef: "MyFirstModule.MealPlanApprovalRequest", content: [{ type: "listView", entityRef: "MyFirstModule.MealPlanApprovalRequest" }] }
      ]
    }
  };
  const stories = [
    {
      id: "US01",
      raw: "As a Cooking student, I want to submit a meal plan approval request for a selected cooking school.",
      role: "Cooking student",
      want: "submit a meal plan approval request for a selected cooking school",
      benefit: "",
      tags: [],
      tokens: []
    }
  ];

  applyDomainModelReview({ plan, reviewResult: { entities: [], associations: [], warnings: [] }, stories, warnings });
  assert(!plan.domainModel.entities.some((entity) => entity.name === "School"));
  assert(!plan.domainModel.entities.some((entity) => entity.name === "PlanRequest"));
  assert(plan.domainModel.entities.some((entity) => entity.name === "CookingSchool"));
  assert(plan.domainModel.entities.some((entity) => entity.name === "MealPlanApprovalRequest"));
  assert(!plan.pages.specs.some((page) => page.entityRef === "MyFirstModule.School"));
  assert(!plan.app.navigation.homePageButtonRefs.includes("school_overview"));
}

function testNavigationBackfillsCoreOverviewPages() {
  const warnings = [];
  const plan = {
    app: {
      moduleName: "MyFirstModule",
      navigation: {
        homePageButtons: [{ pageRef: "cookingschool_overview" }],
        menuItems: [{ pageRef: "cookingschool_overview" }]
      }
    },
    domainModel: {
      entities: [
        { name: "CookingSchool", attributes: [{ name: "Name", type: "String" }] },
        { name: "Recipe", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [],
      enumerations: []
    },
    pages: {
      specs: [
        { ref: "home", name: "Home", content: [] },
        { ref: "cookingschool_overview", name: "CookingSchool_Overview", entityRef: "MyFirstModule.CookingSchool", content: [{ type: "listView", entityRef: "MyFirstModule.CookingSchool" }] },
        { ref: "recipe_overview", name: "Recipe_Overview", entityRef: "MyFirstModule.Recipe", content: [{ type: "listView", entityRef: "MyFirstModule.Recipe" }] }
      ]
    }
  };

  ensureNavigationSpecAndHomeButtons(plan, warnings);
  assert(plan.app.navigation.homePageButtonRefs.includes("recipe_overview"));
  assert(plan.app.navigation.navigationItemRefs.includes("recipe_overview"));
}

function testFinalPageRepairDropsInvalidPageSpecsBeforeNavigation() {
  const warnings = [];
  const plan = {
    app: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      layoutQualifiedName: "Atlas_Core.Atlas_Default",
      homePageRef: "home",
      navigation: {
        homePageButtonRefs: ["home"],
        navigationItemRefs: ["home"]
      }
    },
    domainModel: {
      entities: [{ name: "Student", attributes: [{ name: "Name", type: "String" }] }],
      associations: [],
      enumerations: []
    },
    pages: {
      specs: [
        null,
        { ref: "home", name: "Home", title: "Home", content: [] }
      ]
    }
  };

  ensureEntityCrudPages(plan, warnings);
  ensureNavigationSpecAndHomeButtons(plan, warnings);

  assert(!plan.pages.specs.some((page) => page === null));
  assert(plan.pages.specs.some((page) => page.ref === "student_overview"));
  assert(plan.app.navigation.homePageButtonRefs.includes("student_overview"));
  assert(warnings.some((warning) => warning.includes("Removed 1 invalid page spec")));
  assert.equal(validatePlan(plan).length, 0);
}

function testNormalizeGeneratedPlanReconcilesStalePageAttributeRefs() {
  const draft = {
    app: {
      navigation: {
        homePageButtonRefs: ["lesson_overview"],
        navigationItemRefs: ["lesson_overview"]
      }
    },
    domainModel: {
      entities: [{ name: "Lesson", attributes: [{ name: "StartTime", type: "DateTime" }, { name: "Capacity", type: "Integer" }] }],
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
              itemContent: [
                { type: "attributeInput", attributeRef: "Status" },
                { type: "attributeInput", attributeRef: "starttime" }
              ]
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

  const out = normalizeGeneratedPlan({
    generatedPlan: draft,
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  const pageJson = JSON.stringify(out.plan.pages);
  assert(!pageJson.includes("Status"));
  assert(!pageJson.includes("CreatedAt"));
  assert(!pageJson.includes("Title"));
  assert(pageJson.includes("StartTime"));
  assert(out.warnings.some((warning) => warning.includes('Removed stale page attribute "Lesson.Status"')));
  assert(out.warnings.some((warning) => warning.includes('Repaired page attribute "Lesson.starttime" to "StartTime"')));
  const errors = validatePlan(out.plan);
  assert.equal(errors.length, 0, `Expected valid normalized plan, got: ${errors.join("; ")}`);
}

function testNormalizeGeneratedPlanSanitizesAttributeNames() {
  const out = normalizeGeneratedPlan({
    generatedPlan: {
      domainModel: {
        entities: [
          {
            name: "Lesson",
            attributes: [
              { name: "start date", type: "DateTime" },
              { name: "trainer email", type: "String" }
            ]
          }
        ],
        associations: [],
        enumerations: []
      },
      pages: { specs: [] }
    },
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  const lesson = out.plan.domainModel.entities.find((entity) => entity.name === "Lesson");
  assert(lesson.attributes.some((attr) => attr.name === "StartDate"));
  assert(lesson.attributes.some((attr) => attr.name === "TrainerEmail"));
  const errors = validatePlan(out.plan);
  assert(!errors.some((error) => error.includes("not a valid Mendix")));
}

function testCoverageAttributesAcceptOnlyStoryBackedEvidence() {
  const warnings = [];
  const plan = {
    app: { moduleName: "MyFirstModule", navigation: { homePageButtonRefs: [], navigationItemRefs: [] } },
    domainModel: {
      entities: [{ name: "Subscription", attributes: [{ name: "Name", type: "String", required: true }] }],
      associations: [],
      enumerations: []
    },
    pages: { specs: [] }
  };
  const stories = [
    {
      id: "US1",
      raw: "As a customer, I want to pay a subscription fee and see whether my subscription is active.",
      role: "customer",
      want: "pay a subscription fee and see whether my subscription is active",
      benefit: "",
      tags: [],
      tokens: []
    }
  ];

  const metadata = applyCoverageEntityCandidates({
    plan,
    entityCoverage: {
      missingAttributeCandidates: [
        {
          entity: "Subscription",
          name: "Amount",
          type: "Decimal",
          evidenceStoryIds: ["US1"],
          evidenceQuote: "pay a subscription fee",
          reason: "The story requires storing the subscription fee."
        },
        {
          entity: "Subscription",
          name: "RenewalDate",
          type: "DateTime",
          evidenceStoryIds: [],
          evidenceQuote: "",
          reason: "Subscriptions often renew."
        }
      ],
      missingEntityCandidates: []
    },
    stories,
    warnings
  });

  const subscription = plan.domainModel.entities.find((entity) => entity.name === "Subscription");
  assert(subscription.attributes.some((attr) => attr.name === "Amount"));
  assert(!subscription.attributes.some((attr) => attr.name === "RenewalDate"));
  assert(metadata.coverageAppliedAttributes.some((entry) => entry.attribute === "Amount"));
  assert(metadata.coverageRejectedAttributes.some((entry) => entry.attribute === "RenewalDate" && entry.reason.includes("missing story-backed evidence")));
}

function testCoverageAttributesKeepPlaceholderWhenEvidenceIsWeak() {
  const plan = {
    app: { moduleName: "MyFirstModule" },
    domainModel: {
      entities: [{ name: "Room", attributes: [{ name: "Name", type: "String", required: true }] }],
      associations: [],
      enumerations: []
    }
  };
  const stories = [
    {
      id: "US1",
      raw: "As a planner, I want to view rooms.",
      role: "planner",
      want: "view rooms",
      benefit: "",
      tags: [],
      tokens: []
    }
  ];
  const metadata = applyCoverageEntityCandidates({
    plan,
    entityCoverage: {
      missingAttributeCandidates: [
        {
          entity: "Room",
          name: "Room Capacity",
          type: "Integer",
          evidenceStoryIds: ["US1"],
          evidenceQuote: "",
          reason: "Rooms often have capacity."
        }
      ],
      missingEntityCandidates: []
    },
    stories,
    warnings: []
  });

  const room = plan.domainModel.entities.find((entity) => entity.name === "Room");
  assert.deepEqual(room.attributes.map((attr) => attr.name), ["Name"]);
  assert(metadata.coverageRejectedAttributes.some((entry) => entry.attribute === "RoomCapacity" && entry.reason.includes("missing story-backed evidence")));
}

function testNormalizeGeneratedPlanDropsUnbuildableFlowActions() {
  const draft = {
    app: {
      navigation: {
        homePageButtonRefs: ["home"],
        navigationItemRefs: ["home"]
      }
    },
    domainModel: {
      entities: [{ name: "Task", attributes: [{ name: "Title", type: "String", required: true }] }],
      associations: [],
      enumerations: []
    },
    microflows: {
      specs: [
        {
          ref: "mf_task_summary",
          name: "MF_TaskSummary",
          actions: [
            { type: "aggregateList", function: "sum" },
            { type: "Fine", amount: 25 },
            { type: "showMessage", message: "Summary ready." }
          ]
        }
      ]
    },
    pages: {
      specs: [{ ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Home" }] }]
    }
  };

  const out = normalizeGeneratedPlan({
    generatedPlan: draft,
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  assert(out.warnings.some((warning) => warning.includes("aggregateList is missing listVariableName")));
  assert(out.warnings.some((warning) => warning.includes('action.type "Fine" is unsupported')));
  assert.deepEqual(out.plan.microflows.specs[0].actions.map((action) => action.type), ["showMessage"]);
  const errors = validatePlan(out.plan);
  assert.equal(errors.length, 0, `Expected valid normalized plan, got: ${errors.join("; ")}`);
}

function testNormalizeGeneratedPlanDropsSemanticallyInvalidMicroflowAndRefs() {
  const draft = {
    app: {
      navigation: {
        homePageButtonRefs: ["home"],
        navigationItemRefs: ["home"]
      }
    },
    domainModel: {
      entities: [{ name: "Task", attributes: [{ name: "Title", type: "String", required: true }] }],
      associations: [],
      enumerations: []
    },
    microflows: {
      specs: [
        {
          ref: "mf_invalid",
          name: "MF_Invalid",
          actions: [{ type: "retrieveList", entityRef: "MissingEntity", outputVariableName: "MissingList" }]
        }
      ]
    },
    pages: {
      specs: [
        {
          ref: "home",
          name: "Home",
          title: "Home",
          content: [{ type: "callMicroflowButton", caption: "Run Invalid", microflowRef: "mf_invalid" }]
        }
      ]
    }
  };

  const out = normalizeGeneratedPlan({
    generatedPlan: draft,
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  assert.equal(out.plan.microflows.specs.length, 0);
  assert(out.warnings.some((warning) => warning.includes('Dropped microflow "MF_Invalid"')));
  assert(out.warnings.some((warning) => warning.includes('Removed reference to dropped flow "mf_invalid"')));
  assert(!JSON.stringify(out.plan.pages).includes("mf_invalid"));
  const errors = validatePlan(out.plan);
  assert.equal(errors.length, 0, `Expected valid normalized plan, got: ${errors.join("; ")}`);
}

function testNormalizeGeneratedPlanRepairsConceptualMicroflowDslAliases() {
  const draft = {
    app: {
      navigation: {
        homePageButtonRefs: ["home"],
        navigationItemRefs: ["home"]
      }
    },
    domainModel: {
      entities: [
        { name: "Customer", attributes: [{ name: "NoShowCount", type: "Integer" }] },
        {
          name: "FineHistory",
          attributes: [
            { name: "CustomerId", type: "Integer" },
            { name: "Name", type: "String" },
            { name: "IssuedAt", type: "DateTime" },
            { name: "IsIssued", type: "Boolean" }
          ]
        }
      ],
      associations: [],
      enumerations: []
    },
    microflows: {
      specs: [
        {
          name: "IssueFineMicroflow",
          parameters: [{ name: "customerId", type: "Integer" }],
          actions: [
            { type: "retrieveObject", entity: "Customer", parameters: { id: "$customerId" }, outputVariableName: "Customer_Object" },
            {
              type: "decision",
              condition: "$Customer/NoShowCount > 2",
              trueActions: [
                {
                  type: "createObject",
                  entity: "FineHistory",
                  attributes: {
                    CustomerId: "$customerId",
                    Name: "Fine issued",
                    IssuedAt: "now",
                    IsIssued: "true"
                  }
                },
                { type: "commitObject", object: "$FineHistory" },
                { type: "showMessage", message: "Fine issued successfully" }
              ],
              falseActions: [{ type: "showMessage", message: "No fine issued" }]
            }
          ]
        }
      ]
    },
    pages: { specs: [{ ref: "home", name: "Home", title: "Home", content: [{ type: "dynamicText", text: "Home" }] }] }
  };

  const out = normalizeGeneratedPlan({
    generatedPlan: draft,
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  const decision = out.plan.microflows.specs[0].actions[1];
  assert.equal(decision.conditionExpression, "$Customer_Object/NoShowCount > 2");
  assert(!Object.prototype.hasOwnProperty.call(decision, "condition"));
  assert.equal(decision.trueActions[0].outputVariableName, "FineHistory_New");
  assert.equal(decision.trueActions[1].type, "changeObject");
  assert.equal(decision.trueActions[1].targetVariableName, "FineHistory_New");
  assert(decision.trueActions[1].changes.some((change) => change.attributeRef === "Name" && change.valueExpression === "'Fine issued'"));
  assert(decision.trueActions[1].changes.some((change) => change.attributeRef === "IssuedAt" && change.valueExpression === "[%CurrentDateTime%]"));
  assert(decision.trueActions[1].changes.some((change) => change.attributeRef === "IsIssued" && change.valueExpression === "true"));
  assert.equal(decision.trueActions[2].variableName, "FineHistory_New");
  assert(!Object.prototype.hasOwnProperty.call(decision.trueActions[2], "object"));
  assert(!Object.prototype.hasOwnProperty.call(out.plan.microflows.specs[0].actions[0], "parameters"));
  const errors = validatePlan(out.plan);
  assert.equal(errors.length, 0, `Expected valid normalized plan, got: ${errors.join("; ")}`);
}

function testNormalizeGeneratedPlanDropsInvalidFlowExpressions() {
  const draft = {
    app: { navigation: { homePageButtonRefs: ["home"], navigationItemRefs: ["home"] } },
    domainModel: {
      entities: [
        {
          name: "NotificationRecord",
          attributes: [
            { name: "Message", type: "String" },
            { name: "NotificationDate", type: "DateTime" }
          ]
        }
      ],
      associations: [],
      enumerations: []
    },
    nanoflows: {
      specs: [
        {
          name: "SendNotificationToCustomer",
          actions: [
            { type: "createObject", entity: "NotificationRecord", outputVariableName: "NotificationRecord_New" },
            {
              type: "changeObject",
              targetVariableName: "NotificationRecord_New",
              changes: [
                { attributeRef: "Message", valueExpression: "Notification sent" },
                { attributeRef: "NotificationDate", valueExpression: "not a date" }
              ]
            }
          ]
        }
      ]
    },
    pages: { specs: [{ ref: "home", name: "Home", title: "Home", content: [{ type: "dynamicText", text: "Home" }] }] }
  };

  const out = normalizeGeneratedPlan({
    generatedPlan: draft,
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  const changeObject = out.plan.nanoflows.specs[0].actions[1];
  assert.deepEqual(changeObject.changes.map((change) => change.attributeRef), ["Message"]);
  assert.equal(changeObject.changes[0].valueExpression, "'Notification sent'");
  assert(out.warnings.some((warning) => warning.includes("invalid DateTime expression")));
  const errors = validatePlan(out.plan);
  assert.equal(errors.length, 0, `Expected valid normalized plan, got: ${errors.join("; ")}`);
}

function testNormalizeGeneratedPlanQuotesCreateVariableStringInitialValue() {
  const out = normalizeGeneratedPlan({
    generatedPlan: {
      app: { navigation: { homePageButtonRefs: ["home"], navigationItemRefs: ["home"] } },
      domainModel: {
        entities: [{ name: "Session", attributes: [{ name: "Name", type: "String" }] }],
        associations: [],
        enumerations: []
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
              },
              { type: "showMessage", message: "Notification sent" }
            ]
          }
        ]
      },
      pages: { specs: [{ ref: "home", name: "Home", title: "Home", content: [{ type: "dynamicText", text: "Home" }] }] }
    },
    appContext: { appId: "00000000-0000-0000-0000-000000000000", moduleName: "MyFirstModule", branch: "main" }
  });

  const createVariable = out.plan.microflows.specs[0].actions[0];
  assert.equal(createVariable.initialValueExpression, "'Session.Student.Email'");
  assert.equal(validatePlan(out.plan).length, 0);
}

function testNormalizeGeneratedPlanForcesPrototypeSecurity() {
  const out = normalizeGeneratedPlan({
    generatedPlan: {
      app: { navigation: { homePageButtonRefs: ["home"], navigationItemRefs: ["home"] } },
      security: {
        enabled: true,
        securityLevel: "production",
        moduleRoles: ["Manager"],
        userRoles: [{ name: "Manager", moduleRoles: ["Manager"] }]
      },
      domainModel: { entities: [], associations: [], enumerations: [] },
      pages: { specs: [{ ref: "home", name: "Home", title: "Home", content: [{ type: "dynamicText", text: "Home" }] }] }
    },
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });
  assert.equal(out.plan.security.securityLevel, "prototype");
}

function testNormalizeGeneratedPlanCoercesEntityParameterType() {
  const out = normalizeGeneratedPlan({
    generatedPlan: {
      app: { navigation: { homePageButtonRefs: ["home"], navigationItemRefs: ["home"] } },
      domainModel: {
        entities: [
          { name: "Customer", attributes: [{ name: "Name", type: "String" }] },
          { name: "FineHistory", attributes: [{ name: "Name", type: "String" }] }
        ],
        associations: [],
        enumerations: []
      },
      microflows: {
        specs: [
          {
            name: "IssueFineForNoShow",
            parameters: [
              { name: "customer", type: "Customer" },
              { name: "noShowCount", type: "Integer" }
            ],
            actions: [
              {
                type: "decision",
                conditionExpression: "$noShowCount > 2",
                trueActions: [
                  { type: "createObject", entity: "FineHistory", outputVariableName: "FineHistory_New" },
                  {
                    type: "changeObject",
                    targetVariableName: "FineHistory_New",
                    changes: [{ attributeRef: "Name", valueExpression: "Fine for no-show" }]
                  }
                ],
                falseActions: []
              }
            ]
          }
        ]
      },
      pages: { specs: [{ ref: "home", name: "Home", title: "Home", content: [{ type: "dynamicText", text: "Home" }] }] }
    },
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  const params = out.plan.microflows.specs[0].parameters;
  assert.deepEqual(params[0].type, { kind: "Object", entityRef: "MyFirstModule.Customer" });
  assert.equal(params[1].type, "Integer");
  const errors = validatePlan(out.plan);
  assert.equal(errors.length, 0, `Expected valid normalized plan, got: ${errors.join("; ")}`);
}

function testNormalizeGeneratedPlanSynthesizesSecurityFromStoriesAndDomainInfo() {
  const draft = {
    app: {
      navigation: {
        homePageButtonRefs: ["home"],
        navigationItemRefs: ["home"]
      }
    },
    domainModel: {
      entities: [{ name: "Request", attributes: [{ name: "Title", type: "String", required: true }] }],
      associations: [],
      enumerations: []
    },
    pages: {
      specs: [{ ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Home", renderMode: "H2" }] }]
    }
  };

  const out = normalizeGeneratedPlan({
    generatedPlan: draft,
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    },
    stories: [
      {
        id: "US01",
        raw: "As a ward nurse, I want to request supplies.",
        role: "ward nurse",
        want: "request supplies",
        benefit: "",
        tags: [],
        tokens: ["ward", "nurse", "request", "supplies"]
      }
    ],
    domainInfo: "I have 3 user types: admin, employee and manager"
  });

  assert.deepEqual(
    out.plan.security.userRoles.map((role) => role.name),
    ["WardNurse", "Admin", "Employee", "Manager"]
  );
  assert.equal(
    out.plan.security.userRoles.find((role) => role.name === "Admin").systemModuleRole,
    "System.Administrator"
  );
}

function testNormalizeGeneratedPlanCanonicalizesSemanticAssociationTypes() {
  const draft = {
    app: {
      navigation: {
        homePageButtonRefs: ["home"],
        navigationItemRefs: ["home"]
      }
    },
    domainModel: {
      entities: [
        { name: "ApprovalRequest", attributes: [{ name: "Title", type: "String" }] },
        { name: "Comment", attributes: [{ name: "Body", type: "String" }] },
        { name: "Tag", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [
        {
          name: "ApprovalRequest_Comment",
          parentEntity: "ApprovalRequest",
          childEntity: "Comment",
          type: "hasComment",
          owner: "Both"
        },
        {
          name: "ApprovalRequest_Tag",
          parentEntity: "ApprovalRequest",
          childEntity: "Tag",
          type: "many-to-many",
          owner: "Both"
        }
      ],
      enumerations: []
    },
    pages: {
      specs: [{ ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Home" }] }]
    }
  };

  const out = normalizeGeneratedPlan({
    generatedPlan: draft,
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  const commentAssociation = out.plan.domainModel.associations.find((assoc) => assoc.name === "ApprovalRequest_Comment");
  const tagAssociation = out.plan.domainModel.associations.find((assoc) => assoc.name === "ApprovalRequest_Tag");

  assert.equal(commentAssociation.type, "Reference");
  assert.equal(commentAssociation.metadata.relationshipType, "hasComment");
  assert.equal(tagAssociation.type, "Reference");
  assert.equal(tagAssociation.metadata.relationshipType, "ReferenceSet");
  assert(out.warnings.some((warning) => warning.includes('Normalized semantic association type "hasComment"')));
  assert.equal(validatePlan(out.plan).length, 0);
}

function testGeneratorCliDefaultsToVisualNarrator() {
  const args = parseGeneratorCliArgs([]);
  assert.equal(args.useVisualNarrator, true);
  assert.equal(args.useProcessVisualizer, true);
  assert.equal(args.strictProcessVisualizer, true);
  assert.equal(args.allowRepairPass, false);
  assert.equal(args.minStoryCoverage, null);
  assert.equal(args.processVisualizerModel, DEFAULT_PROCESS_VISUALIZER_MODEL);

  const disabled = parseGeneratorCliArgs(["--no-vn"]);
  assert.equal(disabled.useVisualNarrator, false);

  const processVizDisabled = parseGeneratorCliArgs(["--no-process-viz"]);
  assert.equal(processVizDisabled.useProcessVisualizer, false);

  const processVizStrict = parseGeneratorCliArgs(["--strict-process-viz"]);
  assert.equal(processVizStrict.strictProcessVisualizer, true);

  const processVizMocked = parseGeneratorCliArgs(["--mock-process-viz-response", "pv.json"]);
  assert.equal(processVizMocked.mockProcessVisualizerResponsePath, "pv.json");

  const processVizModel = parseGeneratorCliArgs(["--process-viz-model", "llama3:latest"]);
  assert.equal(processVizModel.processVisualizerModel, "llama3:latest");

  const repair = parseGeneratorCliArgs(["--allow-repair-pass"]);
  assert.equal(repair.allowRepairPass, true);

  const strictRepair = parseGeneratorCliArgs(["--strict-repair-pass"]);
  assert.equal(strictRepair.strictRepairPass, true);

  const retries = parseGeneratorCliArgs(["--llm-retries=2", "--llm-retry-delay-ms", "25"]);
  assert.equal(retries.llmRetries, "2");
  assert.equal(retries.llmRetryDelayMs, "25");

  const seeded = parseGeneratorCliArgs(["--seed=42"]);
  assert.equal(seeded.seed, "42");

  const coverageGate = parseGeneratorCliArgs(["--min-story-coverage=0.8"]);
  assert.equal(coverageGate.minStoryCoverage, "0.8");

  const stopAfter = parseGeneratorCliArgs(["--stop-after", "page-pass"]);
  assert.equal(stopAfter.stopAfter, "page-pass");
}

function testSeparatePrecomputeCliDefaults() {
  const vnArgs = parseGenerateVnCliArgs([]);
  assert.equal(vnArgs.inputDir, "input");
  assert.equal(vnArgs.outputDir, "");

  const pvArgs = parseGenerateProcessVizCliArgs(["--model=llama3:latest", "--ollama-url", "http://localhost:11434"]);
  assert.equal(pvArgs.inputDir, "input");
  assert.equal(pvArgs.model, "llama3:latest");
  assert.equal(pvArgs.ollamaUrl, "http://localhost:11434");
}

function testE2eCliDefaultsToVisualNarrator() {
  const args = parseE2eArgs([]);
  assert.equal(args.noVn, false);
  assert.equal(args.noProcessViz, false);
  assert.equal(args.strictProcessViz, true);
  assert.equal(args.allowRepairPass, false);
  assert.equal(args.minStoryCoverage, null);

  const disabled = parseE2eArgs(["--no-vn"]);
  assert.equal(disabled.noVn, true);

  const processVizDisabled = parseE2eArgs(["--no-process-viz"]);
  assert.equal(processVizDisabled.noProcessViz, true);

  const processVizStrict = parseE2eArgs(["--strict-process-viz"]);
  assert.equal(processVizStrict.strictProcessViz, true);

  const processVizMocked = parseE2eArgs(["--mock-process-viz-response", "pv.json"]);
  assert.equal(processVizMocked.mockProcessVisualizerResponsePath, "pv.json");

  const processVizModel = parseE2eArgs(["--process-viz-model=llama3:latest"]);
  assert.equal(processVizModel.processVisualizerModel, "llama3:latest");

  const repair = parseE2eArgs(["--allow-repair-pass"]);
  assert.equal(repair.allowRepairPass, true);

  const strictRepair = parseE2eArgs(["--strict-repair-pass"]);
  assert.equal(strictRepair.strictRepairPass, true);

  const retries = parseE2eArgs(["--llm-retries", "2", "--llm-retry-delay-ms=25"]);
  assert.equal(retries.llmRetries, "2");
  assert.equal(retries.llmRetryDelayMs, "25");

  const coverageGate = parseE2eArgs(["--min-story-coverage", "0.75"]);
  assert.equal(coverageGate.minStoryCoverage, "0.75");
}

function testSeparateVisualNarratorPrecomputeWritesCanonicalArtifacts() {
  const tmp = mkTmpDir("plan-generator-vn-precompute-");
  writeRequiredInputFiles(tmp, {
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      appName: "TicketSystem"
    }
  });

  const result = generateVisualNarratorArtifactsFromInputDir({
    inputDir: tmp,
    runVisualNarratorImpl: ({ outputDir }) => {
      writeFile(path.join(outputDir, "visual-narrator-ontology.omn"), "Ontology");
      writeFile(path.join(outputDir, "visual-narrator-stories.json"), "[]");
      writeFile(path.join(outputDir, "visual-narrator-summary.json"), JSON.stringify({ classNames: ["Ticket"] }, null, 2));
      writeFile(
        path.join(outputDir, "visual-narrator-result.json"),
        JSON.stringify({
          ontology: "Ontology",
          stories: [],
          classes: [{ name: "Ticket", parent: "", isRole: false }],
          relationships: [],
          inferredRoles: [],
          keyNouns: [{ term: "Ticket", weight: 2 }]
        }, null, 2)
      );
      return {
        artifacts: detectVisualNarratorInputArtifacts(outputDir),
        summary: { classNames: ["Ticket"], classes: [{ name: "Ticket" }], relationships: [], keyNouns: [], inferredRoles: [] },
        status: "completed",
        command: "mock:vn"
      };
    }
  });

  assert.equal(result.status, "completed");
  const detected = detectVisualNarratorInputArtifacts(tmp);
  assert.equal(detected.available, true);
  assert.equal(fs.existsSync(detected.summaryPath), true);
  assert.equal(fs.existsSync(detected.storiesPath), true);
  assert.equal(fs.existsSync(detected.ontologyPath), true);
}

function testSeparateProcessVisualizerPrecomputeWritesCanonicalArtifacts() {
  const tmp = mkTmpDir("plan-generator-pv-precompute-");
  writeRequiredInputFiles(tmp);

  const result = generateProcessVisualizerArtifactsFromInputDir({
    inputDir: tmp,
    runProcessVisualizerImpl: ({ outputDir }) => {
      writeFile(
        path.join(outputDir, "process-visualizer-result.json"),
        JSON.stringify({
          entities: [{ entity_group: "TASK", word: "submit a ticket" }],
          bpmnStructure: []
        }, null, 2)
      );
      writeFile(path.join(outputDir, "process-visualizer-summary.json"), JSON.stringify({ processObjects: ["Ticket"] }, null, 2));
      writeFile(path.join(outputDir, "process-visualizer-run", "process-visualizer.gv"), "digraph{}");
      writeFile(path.join(outputDir, "process-visualizer-run", "process-visualizer.png"), "");
      return {
        artifacts: detectProcessVisualizerInputArtifacts(outputDir),
        summary: { actors: [], tasks: [], gateways: [], processObjects: ["Ticket"], capabilityHints: {} },
        status: "completed",
        command: "mock:pv"
      };
    }
  });

  assert.equal(result.status, "completed");
  const detected = detectProcessVisualizerInputArtifacts(tmp);
  assert.equal(detected.available, true);
  assert.equal(fs.existsSync(detected.summaryPath), true);
  assert.equal(fs.existsSync(path.join(detected.runDir, "process-visualizer.gv")), true);
}

function testPreprocessingPrefersInputArtifactsOverMockAndInlineRuns() {
  const tmp = mkTmpDir("plan-generator-input-artifact-precedence-");
  writeRequiredInputFiles(tmp);
  writeFile(
    path.join(tmp, "visual-narrator-result.json"),
    JSON.stringify({
      ontology: "Ontology",
      stories: [],
      classes: [{ name: "Ticket", parent: "", isRole: false }],
      relationships: [],
      inferredRoles: [],
      keyNouns: [{ term: "Ticket", weight: 2 }]
    }, null, 2)
  );
  writeFile(
    path.join(tmp, "process-visualizer-result.json"),
    JSON.stringify({
      entities: [{ entity_group: "TASK", word: "submit a ticket" }],
      bpmnStructure: []
    }, null, 2)
  );

  const states = runPreprocessingStages({
    bundle: loadInputBundle(tmp),
    outputDir: path.join(tmp, "out"),
    model: "llama3",
    ollamaUrl: "http://127.0.0.1:11434",
    useVisualNarrator: true,
    useProcessVisualizer: true,
    mockVisualNarratorResponsePath: "/tmp/mock-vn.json",
    mockProcessVisualizerResponsePath: "/tmp/mock-pv.json",
    runVisualNarratorImpl: () => {
      throw new Error("Visual Narrator should not run inline when input artifact exists");
    },
    runProcessVisualizerImpl: () => {
      throw new Error("Process Visualizer should not run inline when input artifact exists");
    },
    createVisualNarratorState: ({ enabled, status }) => ({
      enabled,
      status,
      durationMs: 0,
      command: "",
      artifacts: {},
      warnings: [],
      error: "",
      summary: {},
      promptText: ""
    }),
    createProcessVisualizerState: ({ enabled, status }) => ({
      enabled,
      status,
      durationMs: 0,
      command: "",
      artifacts: {},
      warnings: [],
      error: "",
      summary: { actors: [], tasks: [], gateways: [], processObjects: [], capabilityHints: {} },
      promptText: ""
    }),
    loadMockVisualNarratorResult: () => {
      throw new Error("Mock VN loader should not win over input artifact");
    },
    loadMockProcessVisualizerResult: () => {
      throw new Error("Mock PV loader should not win over input artifact");
    },
    loadInputVisualNarratorResult: ({ inputDir }) => ({
      enabled: true,
      status: "completed",
      durationMs: 0,
      command: `input-artifact:${path.join(inputDir, "visual-narrator-result.json")}`,
      artifacts: {},
      warnings: [],
      error: "",
      summary: { classNames: ["Ticket"], classes: [], relationships: [], keyNouns: [], inferredRoles: [] },
      promptText: "Ticket"
    }),
    loadInputProcessVisualizerResult: ({ inputDir }) => ({
      enabled: true,
      status: "completed",
      durationMs: 0,
      command: `input-artifact:${path.join(inputDir, "process-visualizer-result.json")}`,
      artifacts: {},
      warnings: [],
      error: "",
      summary: { actors: [], tasks: [], gateways: [], processObjects: ["Ticket"], capabilityHints: {} },
      promptText: "Ticket"
    }),
    trimToString: (value) => String(value || "").trim(),
    PlanGeneratorError,
    strictProcessVisualizer: true,
    progress: () => {}
  });

  assert(states.visualNarrator.command.startsWith("input-artifact:"));
  assert(states.processVisualizer.command.startsWith("input-artifact:"));
}

function testPreprocessingFallsBackToInlineWhenArtifactsAbsent() {
  const tmp = mkTmpDir("plan-generator-input-artifact-fallback-");
  writeRequiredInputFiles(tmp);
  let ranVn = false;
  let ranPv = false;

  const states = runPreprocessingStages({
    bundle: loadInputBundle(tmp),
    outputDir: path.join(tmp, "out"),
    model: "llama3",
    ollamaUrl: "http://127.0.0.1:11434",
    useVisualNarrator: true,
    useProcessVisualizer: true,
    mockVisualNarratorResponsePath: "",
    mockProcessVisualizerResponsePath: "",
    runVisualNarratorImpl: () => {
      ranVn = true;
      return {
        enabled: true,
        status: "completed",
        durationMs: 0,
        command: "inline:vn",
        artifacts: {},
        warnings: [],
        error: "",
        summary: { classNames: [], classes: [], relationships: [], keyNouns: [], inferredRoles: [] },
        promptText: ""
      };
    },
    runProcessVisualizerImpl: () => {
      ranPv = true;
      return {
        enabled: true,
        status: "completed",
        durationMs: 0,
        command: "inline:pv",
        artifacts: {},
        warnings: [],
        error: "",
        summary: { actors: [], tasks: [], gateways: [], processObjects: [], capabilityHints: {} },
        promptText: ""
      };
    },
    createVisualNarratorState: ({ enabled, status }) => ({
      enabled,
      status,
      durationMs: 0,
      command: "",
      artifacts: {},
      warnings: [],
      error: "",
      summary: {},
      promptText: ""
    }),
    createProcessVisualizerState: ({ enabled, status }) => ({
      enabled,
      status,
      durationMs: 0,
      command: "",
      artifacts: {},
      warnings: [],
      error: "",
      summary: { actors: [], tasks: [], gateways: [], processObjects: [], capabilityHints: {} },
      promptText: ""
    }),
    loadMockVisualNarratorResult: () => null,
    loadMockProcessVisualizerResult: () => null,
    loadInputVisualNarratorResult: () => {
      throw new Error("missing artifact");
    },
    loadInputProcessVisualizerResult: () => {
      throw new Error("missing artifact");
    },
    trimToString: (value) => String(value || "").trim(),
    PlanGeneratorError,
    strictProcessVisualizer: true,
    progress: () => {}
  });

  assert.equal(ranVn, true);
  assert.equal(ranPv, true);
  assert.equal(states.visualNarrator.command, "inline:vn");
  assert.equal(states.processVisualizer.command, "inline:pv");
}

async function testLlmRetryHelperRetriesFailures() {
  let attempts = 0;
  const messages = [];
  const result = await callWithRetries({
    label: "test call",
    attempts: 3,
    retryDelayMs: 0,
    progress: (message) => messages.push(message),
    fn: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`temporary ${attempts}`);
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
  assert.equal(messages.length, 2);
}

async function testFirstLlmFailureAbortsGeneration() {
  const tmp = mkTmpDir("plan-generator-fallback-");
  writeRequiredInputFiles(tmp, {
    userStories: "As an employee, I want to manage tasks.",
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  const outPath = path.join(tmp, "plan.json");
  await assert.rejects(
    () => generatePlanFromInputDir({
      inputDir: tmp,
      outPath,
      useVisualNarrator: false,
      useProcessVisualizer: false,
      useExamplePlans: false,
      useKnowledge: false,
      llmRetries: 0,
      fetchImpl: async () => ({
        ok: true,
        text: async () => JSON.stringify({ response: "{\"domainModel\":" })
      })
    }),
    (err) => err && err.message && err.message.includes("Entity pass failed after retries")
  );
  assert.equal(fs.existsSync(outPath), false);
}

async function testCallOllamaGenerateReadsStreamingResponses() {
  const encoder = new TextEncoder();
  const plan = { domainModel: { entities: [], associations: [], enumerations: [] } };
  let requestBody = null;
  const result = await callOllamaGenerate({
    prompt: "test prompt",
    ollamaOptions: {
      temperature: 0.05,
      top_p: 0.9,
      num_ctx: 8192,
      num_predict: 6144,
      seed: 42
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify({ response: "{\"domainModel\":" })}\n`));
            controller.enqueue(encoder.encode(`${JSON.stringify({ response: JSON.stringify(plan.domainModel), done: false })}\n`));
            controller.enqueue(encoder.encode(`${JSON.stringify({
              response: "}",
              done: true,
              model: "stream-test",
              total_duration: 123,
              prompt_eval_count: 10,
              eval_count: 20
            })}\n`));
            controller.close();
          }
        })
      };
    }
  });

  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.options.seed, 42);
  assert.deepEqual(result.generatedPlan, plan);
  assert.equal(result.ollamaRaw.model, "stream-test");
  assert.equal(result.ollamaRaw.prompt_eval_count, 10);
  assert.equal(result.ollamaRaw.eval_count, 20);
}

async function testGeneratePlanRunsMockedDomainModelReviewPass() {
  const tmp = mkTmpDir("plan-generator-domain-review-");
  writeRequiredInputFiles(tmp, {
    userStories: [
      "As an athlete, I want to manage workouts.",
      "As an athlete, I want to add exercises to workouts so that each workout has planned movements."
    ].join("\n"),
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  const entityPassPlan = {
    domainModel: {
      entities: [
        { name: "Workout", attributes: [{ name: "Name", type: "String" }] },
        { name: "Exercise", attributes: [{ name: "Name", type: "String" }] },
        { name: "WorkoutScreen", attributes: [{ name: "Name", type: "String" }] }
      ],
      enumerations: []
    }
  };
  const pagePassPlan = {
    pages: {
      specs: [
        { ref: "home", name: "Home", title: "Home", content: [{ type: "dynamicText", text: "Home" }] },
        { ref: "imaginaryscreenstate_overview", name: "WorkoutScreen_Overview", entityRef: "MyFirstModule.WorkoutScreen", content: [] }
      ]
    }
  };
  const review = {
    entities: [{ name: "WorkoutScreen", verdict: "drop", reason: "UI state, not story-backed." }],
    associations: [{ name: "Workout_WorkoutScreen", verdict: "drop", reason: "Dropped entity." }],
    warnings: ["reviewed test domain"]
  };
  const associationGeneration = {
    associations: [
      {
        name: "Workout_Exercise",
        parentEntity: "Workout",
        childEntity: "Exercise",
        type: "Reference",
        evidence: ["US02"],
        reason: "Workout contains planned exercises."
      }
    ],
    entityCoverage: [
      { entity: "Workout", status: "linked", reason: "Linked to exercises." },
      { entity: "Exercise", status: "linked", reason: "Linked to workouts." }
    ],
    warnings: []
  };
  const responses = [
    { response: JSON.stringify(entityPassPlan), model: "test" },
    { response: JSON.stringify({ storyCoverage: [], missingEntityCandidates: [], missingAttributeCandidates: [], misclassifiedConcepts: [], relationshipHints: [], warnings: [] }), model: "test" },
    { response: JSON.stringify(review), model: "test" },
    { response: JSON.stringify(associationGeneration), model: "test" },
    { response: JSON.stringify({ security: { enabled: true, securityLevel: "prototype", moduleRoles: ["Athlete"], userRoles: [{ name: "Athlete", moduleRoles: ["Athlete"], systemModuleRole: "System.User" }], demoUsers: [] } }), model: "test" },
    { response: JSON.stringify({ microflows: { specs: [] }, nanoflows: { specs: [] }, workflows: { specs: [] } }), model: "test" },
    { response: JSON.stringify(pagePassPlan), model: "test" }
  ];

  const outPath = path.join(tmp, "plan.json");
  await generatePlanFromInputDir({
    inputDir: tmp,
    outPath,
    seed: 42,
    useVisualNarrator: false,
    useProcessVisualizer: false,
    useExamplePlans: false,
    useKnowledge: false,
    fetchImpl: async () => {
      const next = responses.shift();
      return {
        ok: true,
        text: async () => JSON.stringify(next)
      };
    }
  });

  const plan = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const report = JSON.parse(fs.readFileSync(path.join(tmp, "generation-report.json"), "utf8"));
  assert(!plan.domainModel.entities.some((entity) => entity.name === "WorkoutScreen"));
  assert(!plan.pages.specs.some((page) => page.entityRef === "MyFirstModule.WorkoutScreen"));
  assert(plan.domainModel.associations.some((assoc) =>
    assoc.name === "Workout_Exercise" &&
    assoc.parentEntity === "Workout" &&
    assoc.childEntity === "Exercise"
  ));
  assert.equal(report.domainModelReview.status, "completed");
  assert.equal(report.ollama.options.seed, 42);
  assert.equal(report.reproducibility.settings.ollamaOptions.seed, 42);
  assert.equal(report.reproducibility.inputs.stories.sha256.length, 64);
  assert.equal(report.associationGeneration.status, "completed");
  assert.equal(report.planDiagnostics.sectionPasses.coverage.status, "completed");
  assert.equal(report.associationGeneration.rawAssociationCount, 1);
  assert.equal(report.associationGeneration.acceptedAssociations.length, 1);
  assert.equal(report.associationGeneration.rejectedAssociations.length, 0);
  assert.equal(report.domainModelReview.droppedEntities[0].name, "WorkoutScreen");
  assert.equal(plan.meta.domainModelReview, undefined);
  assert.equal(plan.meta.storyCoverage, undefined);
  assert.equal(plan.meta.storyCoverageScore, undefined);
  assert.equal(plan.domainModel._associationDiagnostics, undefined);
  assert.equal(report.planDiagnostics.associationDiagnostics.rawAssociationCount >= 0, true);
  assert.equal(report.planDiagnostics.associationGeneration.rawAssociationCount, 1);
  assert.equal(report.planDiagnostics.domainModelReview.droppedEntities[0].name, "WorkoutScreen");
  assert.equal(report.coverage.entries.length > 0, true);
}

async function testGeneratePlanSanitizesMalformedPagePassOutput() {
  const tmp = mkTmpDir("plan-generator-page-sanitize-");
  writeRequiredInputFiles(tmp, {
    userStories: "As a student, I want to view my lessons.",
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });
  const responses = [
    { response: JSON.stringify({ domainModel: { entities: [{ name: "Student", attributes: [{ name: "Name", type: "String" }] }, null], enumerations: [] } }), model: "test" },
    { response: JSON.stringify({ storyCoverage: [], missingEntityCandidates: [], missingAttributeCandidates: [], misclassifiedConcepts: [], relationshipHints: [], warnings: [] }), model: "test" },
    { response: JSON.stringify({ entities: [], associations: [], warnings: [] }), model: "test" },
    { response: JSON.stringify({ associations: [], entityCoverage: [], warnings: [] }), model: "test" },
    { response: JSON.stringify({ security: { enabled: true, securityLevel: "prototype", moduleRoles: ["Student"], userRoles: [{ name: "Student", moduleRoles: ["Student"], systemModuleRole: "System.User" }], demoUsers: [] } }), model: "test" },
    { response: JSON.stringify({ microflows: { specs: [null] }, nanoflows: { specs: [] }, workflows: { specs: [] } }), model: "test" },
    {
      response: JSON.stringify({
        pages: {
          specs: [
            null,
            {
              ref: "student_overview",
              name: "Student_Overview",
              entityRef: "MyFirstModule.Student",
              content: [null, "bad", { type: "listView", entityRef: "MyFirstModule.Student", itemContent: [null, { type: "attributeInput", attributeRef: "Name" }] }]
            }
          ]
        }
      }),
      model: "test"
    }
  ];

  const outPath = path.join(tmp, "plan.json");
  await generatePlanFromInputDir({
    inputDir: tmp,
    outPath,
    useVisualNarrator: false,
    useProcessVisualizer: false,
    useExamplePlans: false,
    useKnowledge: false,
    fetchImpl: async () => {
      const next = responses.shift();
      return { ok: true, text: async () => JSON.stringify(next) };
    }
  });

  const plan = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const report = JSON.parse(fs.readFileSync(path.join(tmp, "generation-report.json"), "utf8"));
  assert(!plan.pages.specs.some((page) => page === null));
  assert(plan.pages.specs.some((page) => page.ref === "student_overview"));
  assert.equal(report.planDiagnostics.sectionPasses.pages.sanitization.invalidItemsDropped.length, 1);
  assert(report.planDiagnostics.sectionPasses.pages.sanitization.nestedInvalidItemsDropped.length >= 2);
  assert(fs.existsSync(path.join(tmp, "pre-final-repair-plan.json")));
  assert(fs.existsSync(path.join(tmp, "page-pass-sanitized.json")));
}

async function testGeneratePlanContinuesWhenPagePassReturnsInvalidJson() {
  const tmp = mkTmpDir("plan-generator-page-pass-fallback-");
  writeRequiredInputFiles(tmp, {
    userStories: "As a student, I want to view my lessons.",
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });
  const responses = [
    { response: JSON.stringify({ domainModel: { entities: [{ name: "Student", attributes: [{ name: "Name", type: "String" }] }], enumerations: [] } }), model: "test" },
    { response: JSON.stringify({ storyCoverage: [], missingEntityCandidates: [], missingAttributeCandidates: [], misclassifiedConcepts: [], relationshipHints: [], warnings: [] }), model: "test" },
    { response: JSON.stringify({ entities: [], associations: [], warnings: [] }), model: "test" },
    { response: JSON.stringify({ associations: [], entityCoverage: [], warnings: [] }), model: "test" },
    { response: JSON.stringify({ security: { enabled: true, securityLevel: "prototype", moduleRoles: ["Student"], userRoles: [{ name: "Student", moduleRoles: ["Student"], systemModuleRole: "System.User" }], demoUsers: [] } }), model: "test" },
    { response: JSON.stringify({ microflows: { specs: [] }, nanoflows: { specs: [] }, workflows: { specs: [] } }), model: "test" },
    { response: '{ "pages": { "specs": [ { "ref": "broken", } ] }', model: "test" }
  ];

  const outPath = path.join(tmp, "plan.json");
  await generatePlanFromInputDir({
    inputDir: tmp,
    outPath,
    useVisualNarrator: false,
    useProcessVisualizer: false,
    useExamplePlans: false,
    useKnowledge: false,
    fetchImpl: async () => {
      const next = responses.shift();
      return { ok: true, text: async () => JSON.stringify(next) };
    }
  });

  const plan = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const report = JSON.parse(fs.readFileSync(path.join(tmp, "generation-report.json"), "utf8"));
  assert(plan.pages.specs.length > 0);
  assert.equal(report.planDiagnostics.sectionPasses.pages.status, "llm_unavailable");
  assert(report.planDiagnostics.sectionPasses.pages.warnings[0].includes("Page pass failed; continuing"));
  assert(fs.existsSync(path.join(tmp, "pre-final-repair-plan.json")));
  assert(!fs.existsSync(path.join(tmp, "page-pass-sanitized.json")));
}

async function testGeneratePlanDebugStopAfterPagePassWritesArtifacts() {
  const tmp = mkTmpDir("plan-generator-stop-page-pass-");
  writeRequiredInputFiles(tmp, {
    userStories: "As a student, I want to view lessons.",
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main",
      generationDebugStopAfter: "page-pass"
    }
  });
  const responses = [
    { response: JSON.stringify({ domainModel: { entities: [{ name: "Student", attributes: [{ name: "Name", type: "String" }] }], enumerations: [] } }), model: "test" },
    { response: JSON.stringify({ storyCoverage: [], missingEntityCandidates: [], missingAttributeCandidates: [], misclassifiedConcepts: [], relationshipHints: [], warnings: [] }), model: "test" },
    { response: JSON.stringify({ entities: [], associations: [], warnings: [] }), model: "test" },
    { response: JSON.stringify({ associations: [], entityCoverage: [], warnings: [] }), model: "test" },
    { response: JSON.stringify({ security: { enabled: true, securityLevel: "prototype", moduleRoles: ["Student"], userRoles: [{ name: "Student", moduleRoles: ["Student"], systemModuleRole: "System.User" }], demoUsers: [] } }), model: "test" },
    { response: JSON.stringify({ microflows: { specs: [] }, nanoflows: { specs: [] }, workflows: { specs: [] } }), model: "test" },
    { response: JSON.stringify({ pages: { specs: [null, { ref: "home", name: "Home", title: "Home", content: [] }] } }), model: "test" }
  ];

  const outPath = path.join(tmp, "plan.json");
  const result = await generatePlanFromInputDir({
    inputDir: tmp,
    outPath,
    useVisualNarrator: false,
    useProcessVisualizer: false,
    useExamplePlans: false,
    useKnowledge: false,
    fetchImpl: async () => {
      const next = responses.shift();
      return { ok: true, text: async () => JSON.stringify(next) };
    }
  });

  assert.equal(result.stoppedEarly, true);
  assert.equal(result.debugStopAfter, "page-pass");
  assert(fs.existsSync(outPath));
  assert(fs.existsSync(path.join(tmp, "pre-final-repair-plan.json")));
  assert(fs.existsSync(path.join(tmp, "page-pass-sanitized.json")));
  assert.equal(fs.existsSync(path.join(tmp, "generation-report.json")), false);
}

function testCommanderOutputParsingHandlesSdkLogs() {
  const parsed = parseCommanderOutput([
    "Creating new app 'Example'...",
    "Successfully created app with id 'abc'",
    "app: Example",
    "id: 11111111-1111-1111-1111-111111111111",
    "status: OK"
  ].join("\n"));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary.app, "Example");
  assert.equal(parsed.summary.id, "11111111-1111-1111-1111-111111111111");
  assert.equal(parsed.summary.status, "OK");
}

function testE2ePlanCheckerFailureSummaryIncludesStubFlags() {
  const summary = formatPlanCheckerFailure({
    ok: false,
    validationErrors: [],
    referenceIntegrity: { ok: true, issueCount: 0, issues: [] },
    stubFlags: {
      ok: false,
      flags: ["page_without_useful_steps:gymlist"]
    },
    storyCoverageScore: 0.7142857142857143,
    storyCoverageCovered: 5,
    storyCoverageTotal: 7
  });

  assert(summary.includes("page_without_useful_steps:gymlist"));
  assert(summary.includes("storyCoverage=5/7 (0.714)"));
}

function testCoverageGateDetailsUseStoryTextFallback() {
  const detail = formatMissingStory({
    id: "US07",
    story: "As a reviewer, I want to inspect task details.",
    lexicalScore: 0.125,
    storyConcepts: ["reviewer", "task"],
    matchedConcepts: ["task"]
  });

  assert(detail.includes("US07: As a reviewer"));
  assert(detail.includes("lexicalScore=0.125"));
  assert(detail.includes("concepts=reviewer, task"));
  assert(detail.includes("matched=task"));
}

function testProcessVisualizerFailureCanDegradeGracefully() {
  const states = runPreprocessingStages({
    bundle: {
      files: { stories: "/tmp/user-stories.txt" },
      appContext: { appName: "Example", moduleName: "MyFirstModule" }
    },
    outputDir: "/tmp",
    model: "llama3",
    ollamaUrl: "http://127.0.0.1:11434",
    useVisualNarrator: false,
    useProcessVisualizer: true,
    mockVisualNarratorResponsePath: "",
    mockProcessVisualizerResponsePath: "",
    runVisualNarratorImpl: () => {
      throw new Error("Visual Narrator should be skipped");
    },
    runProcessVisualizerImpl: () => {
      throw new ProcessVisualizerError("Process Visualizer exited with code 1.", {
        code: "PV_EXIT_NON_ZERO",
        durationMs: 12,
        command: { command: "python", args: ["wrapper.py"] },
        stderr: "Traceback"
      });
    },
    createVisualNarratorState: ({ enabled, status }) => ({
      enabled,
      status,
      durationMs: 0,
      command: "",
      artifacts: {},
      warnings: [],
      error: "",
      summary: {},
      promptText: ""
    }),
    createProcessVisualizerState: ({
      enabled,
      status,
      durationMs = 0,
      command = "",
      warnings = [],
      error = ""
    }) => ({
      enabled,
      status,
      durationMs,
      command,
      artifacts: {},
      warnings,
      error,
      summary: { actors: [], tasks: [], gateways: [], processObjects: [], capabilityHints: {} },
      promptText: ""
    }),
    loadMockVisualNarratorResult: () => null,
    loadMockProcessVisualizerResult: () => null,
    trimToString: (value) => String(value || "").trim(),
    PlanGeneratorError,
    strictProcessVisualizer: false,
    progress: () => {}
  });

  assert.equal(states.processVisualizer.status, "failed");
  assert.equal(states.processVisualizer.enabled, true);
  assert.equal(states.processVisualizer.error, "Process Visualizer exited with code 1.");
  assert(states.processVisualizer.warnings[0].includes("Traceback"));
}

function testProcessVisualizerUsesDedicatedModel() {
  let seenModel = "";
  runPreprocessingStages({
    bundle: {
      files: { stories: "/tmp/user-stories.txt" },
      appContext: { appName: "Example", moduleName: "MyFirstModule" }
    },
    outputDir: "/tmp",
    model: "gemma4:e4b",
    processVisualizerModel: "llama3",
    ollamaUrl: "http://127.0.0.1:11434",
    useVisualNarrator: false,
    useProcessVisualizer: true,
    mockVisualNarratorResponsePath: "",
    mockProcessVisualizerResponsePath: "",
    runVisualNarratorImpl: () => {
      throw new Error("Visual Narrator should be skipped");
    },
    runProcessVisualizerImpl: ({ model }) => {
      seenModel = model;
      return {
        enabled: true,
        status: "ready",
        durationMs: 0,
        command: "",
        artifacts: {},
        warnings: [],
        error: "",
        summary: { actors: [], tasks: [], gateways: [], processObjects: [], capabilityHints: {} },
        promptText: ""
      };
    },
    createVisualNarratorState: ({ enabled, status }) => ({
      enabled,
      status,
      durationMs: 0,
      command: "",
      artifacts: {},
      warnings: [],
      error: "",
      summary: {},
      promptText: ""
    }),
    createProcessVisualizerState: ({ enabled, status }) => ({
      enabled,
      status,
      durationMs: 0,
      command: "",
      artifacts: {},
      warnings: [],
      error: "",
      summary: { actors: [], tasks: [], gateways: [], processObjects: [], capabilityHints: {} },
      promptText: ""
    }),
    loadMockVisualNarratorResult: () => null,
    loadMockProcessVisualizerResult: () => null,
    trimToString: (value) => String(value || "").trim(),
    PlanGeneratorError,
    strictProcessVisualizer: true,
    progress: () => {}
  });

  assert.equal(seenModel, "llama3");
}

function testVisualNarratorPromptTextUsesStructuredEvidence() {
  const text = buildVisualNarratorPromptText({
    inferredRoles: ["Manager", "Employee"],
    classNames: ["Task", "TaskComment"],
    classes: [{ name: "Task" }, { name: "TaskComment" }],
    relationships: [{ domain: "TaskComment", name: "belongsTo", range: "Task" }],
    discardedClassNames: ["Work", "What"],
    keyNouns: [{ term: "Task", weight: 3.2 }]
  }, "Ontology");

  assert(text.includes("Preferred entity candidates: Task, TaskComment"));
  assert(text.includes("Preferred relationships:"));
  assert(text.includes("Discarded VN candidates: Work, What"));
  assert(text.includes("Core roles: Manager, Employee"));
}

function testOllamaPromptOrdersDomainRulesBeforePageRules() {
  const appContext = {
    appId: "00000000-0000-0000-0000-000000000000",
    moduleName: "MyFirstModule",
    branch: "main"
  };
  const stories = [
    {
      id: "US01",
      raw: "As an employee, I want to upload attachments to tasks so that work stays organized."
    }
  ];
  const baselineDraft = buildStoryDrivenBaselineDraft({
    stories: [
      {
        id: "US01",
        raw: stories[0].raw,
        role: "employee",
        want: "upload attachments to tasks",
        benefit: "work stays organized",
        tags: ["task_management", "attachments"],
        tokens: ["employee", "upload", "attachments", "tasks", "organized"]
      }
    ],
    moduleName: "MyFirstModule",
    visualNarratorSummary: {
      classNames: ["Task", "TaskAttachment"],
      classes: [{ name: "Task" }, { name: "TaskAttachment" }],
      relationships: [{ name: "belongsTo", domain: "TaskAttachment", range: "Task" }],
      keyNouns: [],
      inferredRoles: []
    }
  });

  const prompt = buildOllamaPrompt({
    stories,
    domainInfo: "",
    acceptanceCriteria: "Global:\n- Employees can upload attachments only to tasks they can access.",
    visualNarratorPromptText:
      "Preferred entity candidates: Task, TaskAttachment\nDiscarded VN candidates: Work, What",
    processVisualizerPromptText:
      "Process actors: employee\nProcess object candidates: Task\nTask flow:\n- employee: upload attachments",
    appContext,
    examplePlansText: "### example\n- entities: Task, TaskAttachment\n- pages: Task_Overview",
    knowledgeText: "Use supported Mendix constructs only.",
    baselineDraft
  });

  assert(prompt.includes("DOMAIN MODEL RUBRIC:"));
  assert(prompt.includes("SECURITY RULES:"));
  assert(prompt.includes("ANTI-PATTERNS TO AVOID:"));
  assert(prompt.includes("PAGE RULES:"));
  assert(!prompt.includes("BASELINE SCAFFOLD:"));
  assert(!prompt.includes("FULL BASELINE DRAFT:"));
  assert(prompt.includes("Output sections supported by this phase: domainModel, security, pages, microflows, nanoflows, and workflows."));
  assert(!prompt.includes("Output only sections relevant for this phase: domainModel, security, and pages"));
  assert(prompt.includes("- security: enabled, securityLevel, moduleRoles[], userRoles[]"));
  assert(prompt.includes("- microflows: specs[]"));
  assert(prompt.includes("- nanoflows: specs[]"));
  assert(prompt.includes("- workflows: specs[]"));
  for (const stepType of SUPPORTED_PAGE_STEP_TYPES) {
    assert(prompt.includes(stepType), `Expected prompt to mention supported page step ${stepType}`);
  }
  for (const actionType of SUPPORTED_MICROFLOW_ACTION_TYPES) {
    assert(prompt.includes(actionType), `Expected prompt to mention supported action ${actionType}`);
  }
  assert(prompt.includes("Every generated flow must be story-backed"));
  assert(prompt.includes("security is mandatory in every generated plan"));
  assert(prompt.includes("callMicroflowButton"));
  assert(prompt.includes("callNanoflowButton"));
  assert(prompt.includes("callWorkflowButton"));
  assert(prompt.includes("workflow task page"));
  assert(prompt.includes("System.WorkflowUserTask"));
  assert(prompt.includes("WorkflowContext"));
  assert(prompt.includes("Never represent Workflow"));
  assert(prompt.includes("Include workflows.specs only when stories clearly require"));
  assert(prompt.includes("Discarded VN candidates: Work, What"));
  assert(prompt.includes("PROCESS VISUALIZER EVIDENCE:"));
  assert(prompt.includes("ACCEPTANCE CRITERIA:"));
  assert(prompt.includes("Employees can upload attachments only to tasks they can access."));
  assert(prompt.includes("Process actors: employee"));
  assert(prompt.includes("Task flow:"));
  assert(prompt.includes("Do not produce stub entities with only Name"));
  assert(!prompt.includes("connect comments, attachments, approvals, notifications, reports, audit/history, recurring rules, and profiles back to Task and/or User"));
  assert(!prompt.includes("Prefer task-management concepts when stories are task-related"));
  assert(prompt.indexOf("DOMAIN MODEL RUBRIC:") < prompt.indexOf("PAGE RULES:"));
}

function testBaselineGeneralizesToCaseManagement() {
  const draft = buildStoryDrivenBaselineDraft({
    stories: [
      {
        id: "US01",
        raw: "As a customer service agent, I want to manage cases and update customer information.",
        role: "customer service agent",
        want: "manage cases and update customer information",
        benefit: "",
        tags: [],
        tokens: ["customer", "service", "agent", "manage", "cases", "update", "customer", "information"]
      },
      {
        id: "US02",
        raw: "As a customer, I want to receive notifications about my case status.",
        role: "customer",
        want: "receive notifications about my case status",
        benefit: "",
        tags: [],
        tokens: ["customer", "receive", "notifications", "case", "status"]
      }
    ],
    moduleName: "MyFirstModule",
    visualNarratorSummary: {
      classNames: ["Case", "Customer", "Notification"],
      classes: [{ name: "Case" }, { name: "Customer" }, { name: "Notification" }],
      relationships: [{ name: "belongsTo", domain: "Case", range: "Customer" }],
      keyNouns: [{ term: "Case", weight: 3 }, { term: "Customer", weight: 2 }],
      inferredRoles: ["Customer Service Agent", "Customer"]
    }
  });

  const entityNames = draft.domainModel.entities.map((entity) => entity.name);
  assert(entityNames.includes("Case"));
  assert(entityNames.includes("Customer"));
  assert(entityNames.includes("Notification"));
  assert(!entityNames.some((name) => /^Task/.test(name)));
}

function testBaselineGeneralizesToStaffAdmin() {
  const draft = buildStoryDrivenBaselineDraft({
    stories: [
      {
        id: "US01",
        raw: "As an HR manager, I want to manage employee records and assign departments.",
        role: "hr manager",
        want: "manage employee records and assign departments",
        benefit: "",
        tags: [],
        tokens: ["hr", "manager", "employee", "records", "assign", "departments"]
      }
    ],
    moduleName: "MyFirstModule",
    visualNarratorSummary: {
      classNames: ["Employee", "Department", "Role"],
      classes: [{ name: "Employee" }, { name: "Department" }, { name: "Role" }],
      relationships: [{ name: "belongsTo", domain: "Employee", range: "Department" }],
      keyNouns: [{ term: "Employee", weight: 3 }, { term: "Department", weight: 2 }],
      inferredRoles: ["HR Manager"]
    }
  });

  const entityNames = draft.domainModel.entities.map((entity) => entity.name);
  assert(entityNames.includes("Employee"));
  assert(entityNames.includes("Department"));
  assert(!entityNames.includes("Role"));
  assert(draft.domainModel.associations.some((assoc) => assoc.parentEntity === "Employee" && assoc.childEntity === "Department"));
}

function testBaselineKeepsNeutralVerbObjectExtraction() {
  const draft = buildStoryDrivenBaselineDraft({
    stories: [
      {
        id: "US01",
        raw: "As a gym member, I want to create a workout and select exercises.",
        role: "gym member",
        want: "create a workout and select exercises",
        benefit: "",
        tags: [],
        tokens: ["gym", "member", "create", "workout", "select", "exercises"]
      }
    ],
    moduleName: "MyFirstModule",
    visualNarratorSummary: {
      classNames: [],
      classes: [],
      relationships: [],
      keyNouns: [],
      inferredRoles: []
    }
  });

  const entityNames = draft.domainModel.entities.map((entity) => entity.name);
  assert(entityNames.includes("Workout"));
  assert(entityNames.includes("Exercise"));
}

function testBaselineUsesExplicitDomainInfoEntityLabels() {
  const draft = buildStoryDrivenBaselineDraft({
    stories: [
      {
        id: "US01",
        raw: "As a student, I want to submit a plan for review.",
        role: "student",
        want: "submit a plan for review",
        benefit: "",
        tags: [],
        tokens: ["student", "submit", "plan", "review"]
      }
    ],
    moduleName: "MyFirstModule",
    domainInfo: [
      "Core domain concepts:",
      "- MealPlanApprovalRequest: the workflow context entity.",
      "- CookingSchool: a cooking school location.",
      "- Recipe: an approved catalog item."
    ].join("\n"),
    visualNarratorSummary: {
      classNames: [],
      classes: [],
      relationships: [],
      keyNouns: [],
      inferredRoles: []
    }
  });

  const entityNames = draft.domainModel.entities.map((entity) => entity.name);
  assert(entityNames.includes("MealPlanApprovalRequest"));
  assert(entityNames.includes("CookingSchool"));
  assert(entityNames.includes("Recipe"));
}

function testProcessTaskActionsDoNotCreateBaselineEntities() {
  const draft = buildStoryDrivenBaselineDraft({
    stories: [
      {
        id: "US01",
        raw: "As a coordinator, I want to work through the queue.",
        role: "coordinator",
        want: "work through the queue",
        benefit: "",
        tags: [],
        tokens: ["coordinator", "work", "queue"]
      }
    ],
    moduleName: "MyFirstModule",
    visualNarratorSummary: {
      classNames: [],
      classes: [],
      relationships: [],
      keyNouns: [],
      inferredRoles: []
    },
    processVisualizerSummary: {
      actors: ["Manager"],
      tasks: [{ actor: "Manager", action: "approve purchase request" }],
      gateways: [],
      processObjects: [],
      capabilityHints: {}
    }
  });

  const entityNames = draft.domainModel.entities.map((entity) => entity.name);
  assert(!entityNames.includes("PurchaseRequest"));
}

function testBaselineTreatsVisualNarratorAsSupportingEvidence() {
  const draft = buildStoryDrivenBaselineDraft({
    stories: [
      {
        id: "US01",
        raw: "As a lab coordinator, I want to maintain calibration records for instruments.",
        role: "lab coordinator",
        want: "maintain calibration records for instruments",
        benefit: "",
        tags: [],
        tokens: ["lab", "coordinator", "maintain", "calibration", "records", "instruments"]
      },
      {
        id: "US02",
        raw: "As a technician, I want to upload maintenance logs for instruments.",
        role: "technician",
        want: "upload maintenance logs for instruments",
        benefit: "",
        tags: [],
        tokens: ["technician", "upload", "maintenance", "logs", "instruments"]
      }
    ],
    moduleName: "MyFirstModule",
    visualNarratorSummary: {
      classNames: ["Calibration Record", "Instrument", "List", "View", "Microflow", "Maintenance Log"],
      classes: [
        { name: "Calibration Record" },
        { name: "Instrument" },
        { name: "List" },
        { name: "View" },
        { name: "Microflow" },
        { name: "Maintenance Log" }
      ],
      relationships: [],
      keyNouns: [
        { term: "List", weight: 2 },
        { term: "Microflow", weight: 2 },
        { term: "Instrument", weight: 2 }
      ],
      inferredRoles: ["Lab Coordinator", "Technician"]
    }
  });

  const entityNames = draft.domainModel.entities.map((entity) => entity.name);
  assert(entityNames.includes("CalibrationRecord"));
  assert(entityNames.includes("MaintenanceLog"));
  assert(entityNames.includes("Instrument"));
  assert(!entityNames.includes("List"));
  assert(!entityNames.includes("View"));
  assert(!entityNames.includes("Microflow"));
}

function testWorkflowScaffoldRepairsPlaceholderTaskPages() {
  const plan = {
    app: { moduleName: "MyFirstModule", homePageRef: "home" },
    domainModel: {
      entities: [
        {
          name: "SupplyRequest",
          attributes: [{ name: "Title", type: "String", required: true }]
        }
      ],
      associations: [],
      enumerations: []
    },
    security: {
      userRoles: [{ name: "LogisticsOfficer" }, { name: "DepartmentHead" }]
    },
    pages: {
      specs: [
        { ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Home" }] },
        {
          ref: "supplyrequest_newedit",
          name: "SupplyRequest_NewEdit",
          entityRef: "MyFirstModule.SupplyRequest",
          pageParameters: [{ name: "SupplyRequest", entityRef: "MyFirstModule.SupplyRequest", required: true }],
          content: [{ type: "dataView", pageParameterName: "SupplyRequest", content: [{ type: "attributeInput", attributeRef: "Title" }] }]
        },
        { ref: "workflowtasklist", name: "WorkflowTaskList", content: [{ type: "dynamicText", text: "Wrong" }] }
      ]
    }
  };
  const warnings = [];

  ensureWorkflowScaffold(
    plan,
    [
      {
        id: "US01",
        raw: "As a Logistics Officer, I want to start a new approval workflow for a high-value supply request.",
        role: "logistics officer"
      },
      {
        id: "US02",
        raw: "As a Department Head, I want to use a workflow task UI to approve or reject pending supply requests.",
        role: "department head"
      }
    ],
    warnings
  );

  assert(!plan.pages.specs.some((page) => page.ref === "workflowtasklist"));
  assert(plan.microflows.specs.some((spec) => spec.ref === "mf_supplyrequest_prepare"));
  assert(plan.microflows.specs.some((spec) => spec.ref === "mf_supplyrequest_approve"));
  assert(plan.microflows.specs.some((spec) => spec.ref === "mf_supplyrequest_reject"));
  assert(plan.workflows.specs.some((spec) => spec.ref === "wf_supplyrequest"));
  const workflow = plan.workflows.specs.find((spec) => spec.ref === "wf_supplyrequest");
  const userTask = workflow.steps.find((step) => step.type === "userTask");
  assert.deepEqual(userTask.userRoleRefs, ["DepartmentHead"]);
  assert(JSON.stringify(workflow.steps).includes("mf_supplyrequest_prepare"));
  assert(JSON.stringify(workflow.steps).includes("mf_supplyrequest_approve"));
  const taskPage = plan.pages.specs.find((page) => page.ref === "supplyrequest_workflow_task");
  assert(taskPage);
  assert(taskPage.pageParameters.some((param) => param.entityRef === "System.WorkflowUserTask"));
  const managerPage = plan.pages.specs.find((page) => page.ref === "supplyrequest_workflow_tasks");
  assert(managerPage);
  assert.equal(managerPage.entityRef, "System.WorkflowUserTask");
  assert.deepEqual(managerPage.allowedRoles, ["DepartmentHead"]);
  const detailPage = plan.pages.specs.find((page) => page.ref === "supplyrequest_newedit");
  assert(JSON.stringify(detailPage.content).includes("callWorkflowButton"));
  ensureNavigationSpecAndHomeButtons(plan, warnings);
  assert(plan.app.navigation.homePageButtons.some((entry) =>
    entry.pageRef === "supplyrequest_workflow_tasks" &&
    entry.caption === "Supply Request Workflow Tasks" &&
    entry.allowedRoles.includes("DepartmentHead")
  ));
  assert(plan.app.navigation.menuItems.some((entry) =>
    entry.pageRef === "supplyrequest_workflow_tasks" &&
    entry.allowedRoles.includes("DepartmentHead")
  ));
  assert(JSON.stringify(plan.pages.specs.find((page) => page.ref === "home").content).includes("supplyrequest_workflow_tasks"));
  assert(warnings.some((warning) => warning.includes("Synthesized reference-style workflow scaffold for SupplyRequest")));
}

function testBaselineUsesStandardHomeDashboardAndPopupPatterns() {
  const draft = buildStoryDrivenBaselineDraft({
    stories: [
      {
        id: "US01",
        raw: "As an analyst, I want to search and manage reports from a dashboard.",
        role: "analyst",
        want: "search and manage reports from a dashboard",
        benefit: "",
        tags: [],
        tokens: ["analyst", "search", "manage", "reports", "dashboard"]
      }
    ],
    moduleName: "MyFirstModule",
    visualNarratorSummary: {
      classNames: ["Report"],
      classes: [{ name: "Report" }],
      relationships: [],
      keyNouns: [{ term: "Report", weight: 3 }],
      inferredRoles: ["Analyst"]
    }
  });

  const pages = draft.pages.specs;
  const home = pages.find((page) => page.ref === "home");
  const dashboard = pages.find((page) => page.ref === "report_dashboard");
  const newEdit = pages.find((page) => page.ref === "report_newedit");

  assert(home);
  assert(dashboard);
  assert(newEdit);
  assert(home.content.some((step) => step.type === "buttonToPage" && step.targetPageRef === "report_dashboard"));
  assert(home.content.some((step) => step.type === "buttonToPage" && step.targetPageRef === "report_overview"));
  assert.equal(newEdit.layoutQualifiedName, "Atlas_Core.PopupLayout");

  const dashboardListView = dashboard.content.find((step) => step.type === "listView");
  assert(dashboardListView);
  assert.equal(dashboardListView.entityRef, "MyFirstModule.Report");
  assert.equal(dashboardListView.rowClickTargetPageRef, "report_newedit");

  const overview = pages.find((page) => page.ref === "report_overview");
  assert(overview);
  const overviewCreate = overview.content.find((step) => step.type === "createObjectButton");
  assert(overviewCreate);
  assert.equal(overviewCreate.targetPageRef, "report_newedit");

  const newEditDataView = newEdit.content.find((step) => step.type === "dataView");
  assert(newEditDataView);
  assert.equal(newEditDataView.pageParameterName, "Report");
  assert.equal(newEditDataView.labelWidth, 3);
}

function testNormalizeGeneratedPlanRepairsDanglingGeneratedNewEditRefs() {
  const draft = {
    app: {
      navigation: {
        homePageButtonRefs: ["materialresource_overview"],
        navigationItemRefs: ["materialresource_overview"]
      }
    },
    domainModel: {
      entities: [
        { name: "Course", attributes: [{ name: "Name", type: "String" }] }
      ]
    },
    pages: {
      specs: [
        {
          ref: "home",
          name: "Home",
          title: "Home",
          content: [{ type: "dynamicText", text: "Home", renderMode: "H2" }]
        },
        {
          ref: "materialresource_overview",
          name: "MaterialResource_Overview",
          title: "Material Resource Overview",
          entityRef: "MyFirstModule.MaterialResource",
          content: [
            {
              type: "createObjectButton",
              caption: "Add Material Resource",
              entityRef: "MyFirstModule.MaterialResource",
              targetPageRef: "materialresource_newedit"
            },
            {
              type: "listView",
              entityRef: "MyFirstModule.MaterialResource",
              rowClickTargetPageRef: "materialresource_newedit"
            }
          ]
        }
      ]
    }
  };

  const out = normalizeGeneratedPlan({
    generatedPlan: draft,
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  const repairedPage = out.plan.pages.specs.find((page) => page.ref === "materialresource_newedit");
  assert(repairedPage);
  assert.equal(repairedPage.layoutQualifiedName, "Atlas_Core.PopupLayout");
  assert.equal(validatePlan(out.plan).length, 0);
  assert(out.warnings.some((warning) => warning.includes("Added missing NewEdit page \"materialresource_newedit\"")));
}

function testNormalizeGeneratedPlanCapturesMalformedAssociationCandidates() {
  const out = normalizeGeneratedPlan({
    generatedPlan: {
      domainModel: {
        entities: [
          { name: "Workout", attributes: [{ name: "Name", type: "String" }] },
          { name: "Exercise", attributes: [{ name: "Name", type: "String" }] }
        ],
        associations: [
          { name: "Workout_Exercise", source: "Workout", target: "Exercise", type: "many-to-many" }
        ]
      },
      pages: {
        specs: [{ ref: "home", name: "Home", title: "Home", content: [{ type: "dynamicText", text: "Home" }] }]
      }
    },
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  assert.equal(out.plan.domainModel.associations.length, 0);
  assert.equal(out.plan.domainModel._associationDiagnostics.rawAssociationCount, 1);
  assert.equal(out.plan.domainModel._associationDiagnostics.normalizedAssociationCount, 0);
  assert.equal(out.plan.domainModel._associationDiagnostics.malformedAssociationCandidates.length, 1);
  assert.equal(out.plan.domainModel._associationDiagnostics.malformedAssociationCandidates[0].parentEntity, "Workout");
  assert.equal(out.plan.domainModel._associationDiagnostics.malformedAssociationCandidates[0].childEntity, "Exercise");
  assert(out.warnings.some((warning) => warning.includes("Queued association \"Workout_Exercise\" for domain review")));
}

function testDomainReviewRepairsMalformedAssociationCandidate() {
  const warnings = [];
  const plan = {
    domainModel: {
      entities: [
        { name: "Workout", attributes: [{ name: "Name", type: "String" }] },
        { name: "Exercise", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [],
      enumerations: [],
      _associationDiagnostics: {
        rawAssociationCount: 1,
        normalizedAssociationCount: 0,
        malformedAssociationCandidates: [
          {
            name: "Workout_Exercise",
            parentEntity: "Workout",
            childEntity: "Exercise",
            type: "many-to-many",
            reason: "Association endpoints could not be resolved after normalization.",
            raw: { name: "Workout_Exercise", source: "Workout", target: "Exercise", type: "many-to-many" }
          }
        ]
      }
    }
  };

  const metadata = applyDomainModelReview({
    plan,
    reviewResult: {
      entities: [],
      associations: [
        {
          name: "Workout_Exercise",
          verdict: "repair",
          parentEntity: "Workout",
          childEntity: "Exercise",
          type: "many-to-many",
          reason: "Story-backed workout exercise selection."
        }
      ]
    },
    stories: [],
    warnings
  });

  assert(plan.domainModel.associations.some((assoc) =>
    assoc.name === "Workout_Exercise" &&
    assoc.parentEntity === "Workout" &&
    assoc.childEntity === "Exercise" &&
    assoc.type === "ReferenceSet"
  ));
  assert.equal(metadata.repairedAssociationCandidates.length, 1);
  assert.equal(metadata.rejectedAssociationCandidates.length, 0);
}

function testDomainReviewRejectsMalformedAssociationCandidateWithMissingEntity() {
  const warnings = [];
  const plan = {
    domainModel: {
      entities: [{ name: "Workout", attributes: [{ name: "Name", type: "String" }] }],
      associations: [],
      enumerations: [],
      _associationDiagnostics: {
        rawAssociationCount: 1,
        normalizedAssociationCount: 0,
        malformedAssociationCandidates: [
          { name: "Workout_Exercise", parentEntity: "Workout", childEntity: "Exercise", type: "Reference" }
        ]
      }
    }
  };

  const metadata = applyDomainModelReview({
    plan,
    reviewResult: {
      entities: [],
      associations: [
        {
          name: "Workout_Exercise",
          verdict: "repair",
          parentEntity: "Workout",
          childEntity: "Exercise",
          type: "Reference"
        }
      ]
    },
    stories: [],
    warnings
  });

  assert.equal(plan.domainModel.associations.length, 0);
  assert.equal(metadata.repairedAssociationCandidates.length, 0);
  assert.equal(metadata.rejectedAssociationCandidates.length, 1);
  assert(metadata.rejectedAssociationCandidates[0].reason.includes("missing or dropped entities"));
}

function testDomainReviewAppliesMissingEntityWarningRecommendation() {
  const warnings = [];
  const stories = [{
    id: "US39",
    role: "Trainer",
    want: "see which rooms are free at a given timeslot",
    benefit: "so that I can schedule a lesson in an available room",
    raw: "As a Trainer, I want to see which rooms are free at a given timeslot, so that I can schedule a lesson in an available room."
  }];
  const plan = {
    domainModel: {
      entities: [{ name: "Lesson", attributes: [{ name: "Name", type: "String" }] }],
      associations: [],
      enumerations: []
    },
    pages: { specs: [] },
    app: { navigation: {} }
  };

  const metadata = applyDomainModelReview({
    plan,
    reviewResult: {
      entities: [],
      associations: [],
      warnings: ["The domain model does not include a 'Room' entity, which may be relevant for story US39."]
    },
    stories,
    warnings,
    enforceAttributeQuality: true
  });

  const room = plan.domainModel.entities.find((entity) => entity.name === "Room");
  assert(room);
  assert.deepEqual(room.attributes.map((attr) => attr.name), ["Name"]);
  assert.equal(metadata.reviewRecommendedEntities.length, 1);
  assert.equal(metadata.reviewAppliedEntities[0].name, "Room");
}

function testNormalizeGeneratedPlanRemovesSyntheticRolesAndCreatesRoleEntities() {
  const draft = {
    security: {
      enabled: true,
      securityLevel: "prototype",
      moduleRoles: ["MyFirstModuleRole", "Customer"],
      userRoles: [
        { name: "MyFirstModuleRole", moduleRoles: ["MyFirstModuleRole"] },
        { name: "Customer", moduleRoles: ["Customer", "MyFirstModuleRole"] }
      ],
      demoUsers: [{ userName: "customer@example.com", userRoles: ["Customer", "MyFirstModuleRole"] }]
    },
    domainModel: { entities: [], associations: [], enumerations: [] },
    pages: {
      specs: [
        { ref: "home", name: "Home", title: "Home", allowedRoles: ["Customer", "MyFirstModuleRole"], content: [] }
      ]
    }
  };
  const out = normalizeGeneratedPlan({
    generatedPlan: draft,
    appContext: { moduleName: "MyFirstModule", branch: "main", appId: "00000000-0000-0000-0000-000000000000" },
    stories: [{ role: "Customer", want: "manage my account profile", benefit: "", raw: "As a Customer, I want to manage my account profile." }]
  });

  assert.deepEqual(out.plan.security.userRoles.map((role) => role.name), ["Customer"]);
  assert(!out.plan.security.moduleRoles.includes("MyFirstModuleRole"));
  assert.deepEqual(out.plan.security.demoUsers, []);
  assert(!JSON.stringify(out.plan.pages).includes("MyFirstModuleRole"));
  const customerEntity = out.plan.domainModel.entities.find((entity) => entity.name === "Customer");
  assert(customerEntity);
  assert(customerEntity.attributes.some((attr) => attr.name === "Email"));
  assert(out.warnings.some((warning) => warning.includes("Removed synthetic security roles")));
  assert(out.warnings.some((warning) => warning.includes("Removed generated demo users")));
}

function testNormalizeGeneratedPlanStripsModuleQualifiedRoleNamesAndDropsDuplicateEntities() {
  const draft = {
    security: {
      enabled: true,
      securityLevel: "prototype",
      moduleRoles: ["MyFirstModule.Employee", "MyFirstModule.Manager", "MyFirstModule.FinanceOfficer"],
      userRoles: [
        { name: "MyFirstModule.Employee", moduleRoles: ["MyFirstModule.Employee"] },
        { name: "MyFirstModule.Manager", moduleRoles: ["MyFirstModule.Manager"] },
        { name: "MyFirstModule.FinanceOfficer", moduleRoles: ["MyFirstModule.FinanceOfficer"] }
      ]
    },
    domainModel: {
      entities: [
        { name: "Employee", attributes: [{ name: "Name", type: "String" }] },
        { name: "Manager", attributes: [{ name: "Name", type: "String" }] },
        { name: "FinanceOfficer", attributes: [{ name: "Name", type: "String" }] },
        { name: "MyfirstmoduleEmployee", attributes: [{ name: "Email", type: "String" }] },
        { name: "MyfirstmoduleManager", attributes: [{ name: "Email", type: "String" }] },
        { name: "MyfirstmoduleFinanceofficer", attributes: [{ name: "Email", type: "String" }] }
      ],
      associations: [],
      enumerations: []
    },
    pages: {
      specs: [
        { ref: "home", name: "Home", title: "Home", content: [] },
        { ref: "myfirstmoduleemployee_overview", name: "MyfirstmoduleEmployee_Overview", entityRef: "MyFirstModule.MyfirstmoduleEmployee", content: [] },
        { ref: "myfirstmodulemanager_overview", name: "MyfirstmoduleManager_Overview", entityRef: "MyFirstModule.MyfirstmoduleManager", content: [] },
        { ref: "myfirstmodulefinanceofficer_overview", name: "MyfirstmoduleFinanceofficer_Overview", entityRef: "MyFirstModule.MyfirstmoduleFinanceofficer", content: [] }
      ]
    },
    app: {
      navigation: {
        homePageButtonRefs: ["myfirstmoduleemployee_overview"],
        navigationItemRefs: ["myfirstmodulemanager_overview"],
        homePageButtons: [{ pageRef: "myfirstmoduleemployee_overview" }],
        menuItems: [{ pageRef: "myfirstmodulefinanceofficer_overview" }]
      }
    }
  };

  const out = normalizeGeneratedPlan({
    generatedPlan: draft,
    appContext: { moduleName: "MyFirstModule", branch: "main", appId: "00000000-0000-0000-0000-000000000000" },
    stories: [
      { role: "Employee", want: "complete assigned tasks", benefit: "", raw: "As an Employee, I want to complete assigned tasks." },
      { role: "Manager", want: "approve requests", benefit: "", raw: "As a Manager, I want to approve requests." },
      { role: "Finance Officer", want: "review invoices", benefit: "", raw: "As a Finance Officer, I want to review invoices." }
    ]
  });

  assert.deepEqual(out.plan.security.userRoles.map((role) => role.name), ["Employee", "Manager", "FinanceOfficer"]);
  assert.deepEqual(out.plan.security.moduleRoles, ["Employee", "Manager", "FinanceOfficer"]);
  assert(out.plan.domainModel.entities.some((entity) => entity.name === "Employee"));
  assert(out.plan.domainModel.entities.some((entity) => entity.name === "Manager"));
  assert(out.plan.domainModel.entities.some((entity) => entity.name === "FinanceOfficer"));
  assert(!out.plan.domainModel.entities.some((entity) => /^Myfirstmodule/i.test(entity.name)));
  assert(!out.plan.pages.specs.some((page) => /myfirstmodule/i.test(`${page.ref} ${page.name}`)));
  assert(!JSON.stringify(out.plan.app.navigation).includes("myfirstmodule"));
  assert(out.warnings.some((warning) => warning.includes("Removed module-prefixed duplicate entities")));
  assert.equal(validatePlan(out.plan).length, 0);
}

function testNormalizeGeneratedPlanStripsRoleSuffixAndDropsDuplicateRoleEntities() {
  const out = normalizeGeneratedPlan({
    generatedPlan: {
      security: {
        enabled: true,
        securityLevel: "prototype",
        moduleRoles: ["StudentRole", "TutorRole", "ManagerRole"],
        userRoles: [
          { name: "StudentRole", moduleRoles: ["StudentRole"] },
          { name: "TutorRole", moduleRoles: ["TutorRole"] },
          { name: "ManagerRole", moduleRoles: ["ManagerRole"] }
        ]
      },
      domainModel: {
        entities: [
          { name: "Student", attributes: [{ name: "Name", type: "String" }] },
          { name: "Tutor", attributes: [{ name: "Name", type: "String" }] },
          { name: "Manager", attributes: [{ name: "Name", type: "String" }] },
          { name: "StudentRole", attributes: [{ name: "Email", type: "String" }] },
          { name: "TutorRole", attributes: [{ name: "Email", type: "String" }] },
          { name: "ManagerRole", attributes: [{ name: "Email", type: "String" }] }
        ],
        associations: [],
        enumerations: []
      },
      pages: {
        specs: [
          { ref: "home", name: "Home", title: "Home", content: [] },
          { ref: "studentrole_overview", name: "StudentRole_Overview", entityRef: "MyFirstModule.StudentRole", content: [] }
        ]
      },
      app: { navigation: { homePageButtonRefs: ["studentrole_overview"], navigationItemRefs: ["studentrole_overview"] } }
    },
    appContext: { moduleName: "MyFirstModule", branch: "main", appId: "00000000-0000-0000-0000-000000000000" }
  });

  assert.deepEqual(out.plan.security.userRoles.map((role) => role.name), ["Student", "Tutor", "Manager"]);
  assert(!out.plan.domainModel.entities.some((entity) => /Role$/.test(entity.name)));
  assert(!out.plan.pages.specs.some((page) => /studentrole/i.test(`${page.ref} ${page.name}`)));
  assert(out.warnings.some((warning) => warning.includes("Removed role-suffixed duplicate entities")));
  assert.equal(validatePlan(out.plan).length, 0);
}

function testNormalizeGeneratedPlanRenamesEnumerationCollidingWithEntity() {
  const out = normalizeGeneratedPlan({
    generatedPlan: {
      domainModel: {
        entities: [
          {
            name: "Membership",
            attributes: [{ name: "Status", type: { kind: "Enum", enumName: "MembershipStatus" } }]
          },
          {
            name: "MembershipStatus",
            attributes: [{ name: "Name", type: "String" }]
          }
        ],
        associations: [],
        enumerations: [{ name: "MembershipStatus", values: ["Active", "Expired"] }]
      },
      pages: { specs: [{ ref: "home", name: "Home", title: "Home", content: [] }] },
      app: { navigation: { homePageButtonRefs: ["home"], navigationItemRefs: ["home"] } }
    },
    appContext: { moduleName: "MyFirstModule", branch: "main", appId: "00000000-0000-0000-0000-000000000000" }
  });

  const enumNames = out.plan.domainModel.enumerations.map((enumeration) => enumeration.name);
  assert(enumNames.includes("MembershipStatusValue"));
  const membership = out.plan.domainModel.entities.find((entity) => entity.name === "Membership");
  assert.equal(membership.attributes.find((attr) => attr.name === "Status").type.enumName, "MembershipStatusValue");
  assert(out.plan.domainModel.entities.some((entity) => entity.name === "MembershipStatus"));
  assert(out.warnings.some((warning) => warning.includes('Renamed enumeration "MembershipStatus"')));
  assert.equal(validatePlan(out.plan).length, 0);
}

function testNormalizeGeneratedPlanStripsLlmDemoUsers() {
  const out = normalizeGeneratedPlan({
    generatedPlan: {
      app: {
        navigation: {
          homePageButtonRefs: ["home"],
          navigationItemRefs: ["home"]
        }
      },
      security: {
        enabled: true,
        securityLevel: "prototype",
        moduleRoles: ["Manager"],
        userRoles: [{ name: "Manager", moduleRoles: ["Manager"] }],
        demoUsers: [{ userName: "john.doe", userRoles: ["Manager"] }]
      },
      domainModel: { entities: [], associations: [], enumerations: [] },
      pages: { specs: [{ ref: "home", name: "Home", title: "Home", content: [{ type: "dynamicText", text: "Home" }] }] }
    },
    appContext: { moduleName: "MyFirstModule", branch: "main", appId: "00000000-0000-0000-0000-000000000000" }
  });

  assert.deepEqual(out.plan.security.demoUsers, []);
  assert.equal(validatePlan(out.plan).length, 0);
  assert(out.warnings.some((warning) => warning.includes("Removed generated demo users")));
}

function testAssociationGenerationAddsValidAssociationsAndRejectsInvalidEndpoints() {
  const warnings = [];
  const plan = {
    domainModel: {
      entities: [
        { name: "Customer", attributes: [{ name: "Name", type: "String" }] },
        { name: "Lesson", attributes: [{ name: "Name", type: "String" }] },
        { name: "Trainer", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [
        { name: "Trainer_Lesson", parentEntity: "Trainer", childEntity: "Lesson", type: "Reference", owner: "Both" }
      ],
      enumerations: []
    }
  };

  const metadata = applyAssociationGeneration({
    plan,
    associationResult: {
      associations: [
        {
          name: "Customer_Lesson",
          parentEntity: "Customer",
          childEntity: "Lesson",
          type: "many-to-many",
          evidence: ["Customers book lessons."],
          directionReason: "Customer is the booking context and Lesson is selected.",
          reason: "Customers can book lessons."
        },
        {
          name: "Customer_MembershipType",
          parentEntity: "Customer",
          childEntity: "MembershipType",
          type: "Reference",
          evidence: ["Customers choose membership type."],
          directionReason: "Invalid endpoint should be rejected before direction matters.",
          reason: "Invalid endpoint should be rejected."
        },
        {
          name: "Customer_Lesson_Duplicate",
          parentEntity: "Customer",
          childEntity: "Lesson",
          type: "many-to-many",
          evidence: ["Customer selects a lesson."],
          directionReason: "Duplicate pair should be rejected.",
          reason: "Duplicate pair should be rejected."
        }
      ],
      entityCoverage: [
        { entity: "Customer", status: "linked", reason: "Linked to Lesson." },
        { entity: "Lesson", status: "linked", reason: "Linked to Customer and Trainer." },
        { entity: "Trainer", status: "linked", reason: "Linked to Lesson." }
      ],
      warnings: []
    },
    warnings
  });

  assert(plan.domainModel.associations.some((assoc) =>
    assoc.name === "Customer_Lesson" &&
    assoc.parentEntity === "Customer" &&
    assoc.childEntity === "Lesson" &&
    assoc.type === "ReferenceSet"
  ));
  assert.equal(metadata.acceptedAssociations.length, 1);
  assert.equal(metadata.rejectedAssociations.length, 2);
  assert.deepEqual(plan.domainModel.associations.map((assoc) => assoc.name), ["Customer_Lesson"]);
  assert.equal(metadata.entityCoverage.find((entry) => entry.entity === "Customer").status, "linked");
  assert.equal(metadata.entityCoverage.find((entry) => entry.entity === "Lesson").status, "linked");
  assert(metadata.rejectedAssociations.some((entry) => entry.reason.includes("outside finalized entities")));
  assert(metadata.rejectedAssociations.some((entry) => entry.reason.includes("already exists")));
}

function testAssociationGapAuditFindsUnlinkedAndCoMentionedEntities() {
  const plan = {
    domainModel: {
      entities: [
        { name: "Ticket", attributes: [{ name: "Title", type: "String" }, { name: "Status", type: "String" }] },
        { name: "Comment", attributes: [{ name: "Body", type: "String" }] },
        { name: "Agent", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [],
      enumerations: []
    }
  };
  const stories = [
    {
      id: "US01",
      raw: "As an agent, I want to add comments to tickets.",
      role: "agent",
      want: "add comments to tickets",
      benefit: "",
      tags: [],
      tokens: ["agent", "add", "comments", "tickets"]
    }
  ];

  const audit = auditAssociationGaps({ plan, stories });
  assert(audit.items.some((item) => item.type === "unlinked_operational_entity" && item.entity === "Ticket"));
  assert(audit.items.some((item) =>
    item.type === "co_mentioned_story_entities" &&
    [item.leftEntity, item.rightEntity].includes("Ticket") &&
    [item.leftEntity, item.rightEntity].includes("Comment")
  ));
}

function testAssociationGapAuditSuppressesExistingAssociations() {
  const plan = {
    domainModel: {
      entities: [
        { name: "Ticket", attributes: [{ name: "Title", type: "String" }] },
        { name: "Comment", attributes: [{ name: "Body", type: "String" }] }
      ],
      associations: [{ name: "Ticket_Comment", parentEntity: "Ticket", childEntity: "Comment", type: "Reference" }],
      enumerations: []
    }
  };
  const stories = [
    {
      id: "US01",
      raw: "As an agent, I want to add comments to tickets.",
      role: "agent",
      want: "add comments to tickets",
      benefit: "",
      tags: [],
      tokens: ["agent", "add", "comments", "tickets"]
    }
  ];

  const audit = auditAssociationGaps({ plan, stories });
  assert(!audit.items.some((item) => item.type === "co_mentioned_story_entities"));
  assert(!audit.items.some((item) => item.type === "unlinked_operational_entity"));
}

async function testAssociationGenerationRepairPassAddsMissingAssociation() {
  const warnings = [];
  const plan = {
    domainModel: {
      entities: [
        { name: "Ticket", attributes: [{ name: "Title", type: "String" }] },
        { name: "Comment", attributes: [{ name: "Body", type: "String" }] }
      ],
      associations: [],
      enumerations: []
    }
  };
  const bundle = {
    stories: [
      {
        id: "US01",
        raw: "As an agent, I want to add comments to tickets.",
        role: "agent",
        want: "add comments to tickets",
        benefit: "",
        tags: [],
        tokens: ["agent", "add", "comments", "tickets"]
      }
    ],
    domainInfo: "",
    appContext: {}
  };
  const responses = [
    { generatedPlan: { associations: [], entityCoverage: [], warnings: [] } },
    {
      generatedPlan: {
        associations: [
          {
            name: "Ticket_Comment",
            parentEntity: "Ticket",
            childEntity: "Comment",
            type: "Reference",
            evidence: ["US01"],
            directionReason: "Ticket is the context that comments are added to.",
            reason: "Comments belong to tickets."
          }
        ],
        entityCoverage: [
          { entity: "Ticket", status: "linked", reason: "Linked to comments." },
          { entity: "Comment", status: "linked", reason: "Linked to tickets." }
        ],
        auditDecisions: [{ auditId: "association_audit_1", decision: "add", reason: "Story adds comments to tickets." }],
        warnings: []
      }
    }
  ];

  const metadata = await runAssociationGenerationStage({
    plan,
    bundle,
    visualNarrator: { summary: {} },
    processVisualizer: { summary: {} },
    entityCoverage: {},
    model: "test",
    ollamaUrl: "http://test",
    fetchImpl: async () => { throw new Error("fetch should not be called"); },
    callOllamaGenerate: async () => responses.shift(),
    progress: () => {},
    warnings,
    mockOllamaResponsePath: ""
  });

  assert(plan.domainModel.associations.some((assoc) =>
    assoc.name === "Ticket_Comment" &&
    assoc.parentEntity === "Ticket" &&
    assoc.childEntity === "Comment"
  ));
  assert.equal(metadata.gapAudit.itemCount > 0, true);
  assert.equal(metadata.repair.attempted, true);
  assert.equal(metadata.repair.status, "completed");
}

async function testAssociationGenerationRepairPassCanOverrideHintDirection() {
  const warnings = [];
  const plan = {
    domainModel: {
      entities: [
        { name: "Lesson", attributes: [{ name: "Name", type: "String" }] },
        { name: "Trainer", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [],
      enumerations: []
    }
  };
  const bundle = {
    stories: [
      {
        id: "US01",
        raw: "As a coordinator, I want to assign trainers to lessons.",
        role: "coordinator",
        want: "assign trainers to lessons",
        benefit: "",
        tags: [],
        tokens: ["coordinator", "assign", "trainers", "lessons"]
      }
    ],
    domainInfo: "",
    appContext: {}
  };
  const responses = [
    {
      generatedPlan: {
        associations: [
          {
            name: "Trainer_Lesson",
            parentEntity: "Trainer",
            childEntity: "Lesson",
            type: "Reference",
            evidence: ["US01"],
            directionReason: "First pass chose trainer context.",
            reason: "First pass direction."
          }
        ],
        entityCoverage: [],
        warnings: []
      }
    },
    {
      generatedPlan: {
        associations: [
          {
            name: "Lesson_Trainer",
            parentEntity: "Lesson",
            childEntity: "Trainer",
            type: "Reference",
            evidence: ["US01"],
            directionReason: "Lesson is the editing context and Trainer is assigned to it.",
            reason: "Repair pass follows assignment direction rule."
          }
        ],
        entityCoverage: [],
        auditDecisions: [{ auditId: "association_audit_1", decision: "reverse", reason: "Assign trainers to lessons orients Lesson -> Trainer." }],
        warnings: []
      }
    }
  ];

  const metadata = await runAssociationGenerationStage({
    plan,
    bundle,
    visualNarrator: { summary: {} },
    processVisualizer: { summary: {} },
    entityCoverage: {},
    model: "test",
    ollamaUrl: "http://test",
    fetchImpl: async () => { throw new Error("fetch should not be called"); },
    callOllamaGenerate: async () => responses.shift(),
    progress: () => {},
    warnings,
    mockOllamaResponsePath: ""
  });

  assert.deepEqual(plan.domainModel.associations.map((assoc) => `${assoc.parentEntity}->${assoc.childEntity}`), ["Lesson->Trainer"]);
  assert.equal(metadata.repair.auditDecisions[0].decision, "reverse");
}

async function testAssociationGenerationUnavailableKeepsReviewedAssociations() {
  const warnings = [];
  const plan = {
    domainModel: {
      entities: [
        { name: "Ticket", attributes: [{ name: "Title", type: "String" }] },
        { name: "Comment", attributes: [{ name: "Body", type: "String" }] }
      ],
      associations: [{ name: "Ticket_Comment", parentEntity: "Ticket", childEntity: "Comment", type: "Reference" }],
      enumerations: []
    }
  };

  const metadata = await runAssociationGenerationStage({
    plan,
    bundle: {
      stories: [],
      domainInfo: "",
      appContext: {}
    },
    visualNarrator: { summary: {} },
    processVisualizer: { summary: {} },
    entityCoverage: {},
    model: "test",
    ollamaUrl: "http://test",
    fetchImpl: async () => { throw new Error("fetch should not be called"); },
    callOllamaGenerate: async () => { throw new Error("offline"); },
    progress: () => {},
    warnings,
    mockOllamaResponsePath: ""
  });

  assert.deepEqual(plan.domainModel.associations.map((assoc) => assoc.name), ["Ticket_Comment"]);
  assert.equal(metadata.status, "llm_unavailable");
  assert.equal(metadata.repair.status, "skipped_llm_unavailable");
  assert(warnings.some((warning) => warning.includes("keeping reviewed associations only")));
}

function testBooleanDefaultsArePreservedAndDefaultedFalse() {
  const out = normalizeGeneratedPlan({
    generatedPlan: {
      domainModel: {
        entities: [
          {
            name: "Workout",
            attributes: [
              { name: "IsActive", type: "Boolean" },
              { name: "IsPublic", type: "Boolean", defaultValue: true },
              { name: "IsArchived", type: "Boolean", defaultValue: false }
            ]
          }
        ],
        associations: []
      },
      pages: {
        specs: [{ ref: "home", name: "Home", title: "Home", content: [{ type: "dynamicText", text: "Home" }] }]
      }
    },
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main"
    }
  });

  const attrs = out.plan.domainModel.entities[0].attributes;
  assert.equal(attrs.find((attr) => attr.name === "IsPublic").defaultValue, true);
  assert.equal(attrs.find((attr) => attr.name === "IsArchived").defaultValue, false);
  assert.equal(modelBuilderPrivate.normalizeDefaultValue({ kind: "Boolean" }, undefined), "false");
  assert.equal(modelBuilderPrivate.normalizeDefaultValue({ kind: "Boolean" }, null), "false");
  assert.equal(modelBuilderPrivate.normalizeDefaultValue({ kind: "Boolean" }, true), "true");
  assert.equal(modelBuilderPrivate.normalizeDefaultValue({ kind: "Boolean" }, false), "false");
  assert.equal(modelBuilderPrivate.normalizeDefaultValue({ kind: "Boolean" }, "invalid"), "false");

  const attribute = { value: { defaultValue: "" } };
  modelBuilderPrivate.applyAttributeDefaultValue(attribute, { type: "Boolean" });
  assert.equal(attribute.value.defaultValue, "false");
}

function testEntityPassNormalizationDoesNotExpandNameFallback() {
  const out = normalizeGeneratedPlan({
    generatedPlan: {
      domainModel: {
        entities: [{ name: "Profile", attributes: [{ name: "Name", type: "String", required: true }] }]
      },
      pages: { specs: [{ ref: "home", name: "Home", content: [{ type: "dynamicText", text: "Home" }] }] }
    },
    appContext: { appId: "app", moduleName: "MyFirstModule", homePageRef: "home" },
    normalizationOptions: { expandNameFallback: false }
  });
  const profile = out.plan.domainModel.entities.find((entity) => entity.name === "Profile");
  assert.deepEqual(profile.attributes.map((attr) => attr.name), ["Name"]);
}

async function testMultiPassEntityPassReplacesBaselineFallbackAttributes() {
  const tmp = mkTmpDir("plan-generator-entity-quality-");
  writeRequiredInputFiles(tmp, {
    userStories: [
      "As a Customer, I want to add my email and phone number, so the gym can contact me.",
      "As a Customer, I want to update my payment information, so my subscription can be paid.",
      "As a User, I want to log in to the system, so that I can use the system."
    ].join("\n"),
    appContext: {
      appId: "00000000-0000-0000-0000-000000000000",
      moduleName: "MyFirstModule",
      branch: "main",
      generationMode: "multi-pass"
    }
  });

  const responses = [
    {
      response: JSON.stringify({
        domainModel: {
          entities: [
            {
              name: "Customer",
              attributes: [
                { name: "Email", type: "String", required: true },
                { name: "PhoneNumber", type: "String", required: false },
                { name: "PaymentInformation", type: "String", required: false }
              ]
            },
            { name: "User", attributes: [{ name: "Name", type: "String", required: true }] }
          ],
          enumerations: []
        }
      }),
      model: "test"
    },
    {
      response: JSON.stringify({
        storyCoverage: [
          { storyId: "US02", coveredConcepts: ["Customer"], missingConcepts: ["Subscription"], reason: "Payment story requires subscription record." }
        ],
        missingEntityCandidates: [
          {
            name: "Subscription",
            attributes: [
              { name: "Id", type: "Integer" },
              { name: "StartDate", type: "DateTime" },
              { name: "EndDate", type: "DateTime" },
              { name: "Type", type: "String" }
            ],
            reason: "Customer payment story implies persisted subscription period."
          }
        ],
        missingAttributeCandidates: [
          { entity: "Customer", name: "AccountNumber", type: "String", reason: "Customer account should have business account number." }
        ],
        misclassifiedConcepts: [],
        relationshipHints: [
          { parentEntity: "Customer", childEntity: "Subscription", reason: "Customer has subscription." }
        ],
        warnings: []
      }),
      model: "test"
    },
    {
      response: JSON.stringify({
        entities: [
          {
            name: "Customer",
            verdict: "repair",
            reason: "Customer contact and payment fields are explicitly story-backed.",
            attributes: [
              {
                name: "Email",
                type: "String",
                required: true,
                evidenceStoryIds: ["US01"],
                evidenceQuote: "add my email and phone number",
                reason: "Customer email is directly requested."
              },
              {
                name: "PhoneNumber",
                type: "String",
                evidenceStoryIds: ["US01"],
                evidenceQuote: "add my email and phone number",
                reason: "Customer phone number is directly requested."
              },
              {
                name: "PaymentInformation",
                type: "String",
                evidenceStoryIds: ["US02"],
                evidenceQuote: "update my payment information",
                reason: "Customer payment information is directly requested."
              },
              {
                name: "AccountNumber",
                type: "String",
                evidenceStoryIds: [],
                evidenceQuote: "",
                reason: "Customer accounts usually have account numbers."
              }
            ]
          },
          {
            name: "Subscription",
            verdict: "repair",
            reason: "The payment story requires a persisted paid state for subscription.",
            attributes: [
              {
                name: "IsPaid",
                type: "Boolean",
                evidenceStoryIds: ["US02"],
                evidenceQuote: "so my subscription can be paid",
                reason: "The story requires storing whether the subscription is paid."
              }
            ]
          },
          { name: "User", verdict: "placeholder", attributes: [], reason: "Security-only concept." }
        ],
        warnings: []
      }),
      model: "test"
    },
    {
      response: JSON.stringify({
        entities: [
          { name: "Customer", verdict: "keep", reason: "Customer stores persisted contact and payment data." },
          { name: "User", verdict: "keep", reason: "Reviewer missed that this is security-only." },
          { name: "Subscription", verdict: "keep", reason: "Coverage added story-backed subscription." }
        ],
        associations: [],
        warnings: []
      }),
      model: "test"
    },
    { response: JSON.stringify({ associations: [], entityCoverage: [] }), model: "test" },
    {
      response: JSON.stringify({
        associations: [
          {
            name: "Customer_Subscription",
            parentEntity: "Customer",
            childEntity: "Subscription",
            type: "Reference",
            evidence: ["US02"],
            directionReason: "Customer is the context that has the subscription.",
            reason: "Coverage relationship hint is story-backed."
          }
        ],
        entityCoverage: [
          { entity: "Customer", status: "linked", reason: "Linked to subscription." },
          { entity: "Subscription", status: "linked", reason: "Linked to customer." }
        ],
        auditDecisions: [{ auditId: "association_audit_1", decision: "add", reason: "Customer has subscription." }],
        warnings: []
      }),
      model: "test"
    },
    { response: JSON.stringify({ security: { enabled: true, securityLevel: "prototype", moduleRoles: ["Customer"], userRoles: [{ name: "Customer", moduleRoles: ["Customer"], systemModuleRole: "System.User" }], demoUsers: [] } }), model: "test" },
    { response: JSON.stringify({ microflows: { specs: [] }, nanoflows: { specs: [] }, workflows: { specs: [] } }), model: "test" },
    { response: JSON.stringify({ pages: { specs: [{ ref: "home", name: "Home", title: "Home", content: [{ type: "dynamicText", text: "Home" }] }] } }), model: "test" }
  ];

  const outPath = path.join(tmp, "plan.json");
  await generatePlanFromInputDir({
    inputDir: tmp,
    outPath,
    useVisualNarrator: false,
    useProcessVisualizer: false,
    useExamplePlans: false,
    useKnowledge: false,
    fetchImpl: async () => {
      const next = responses.shift();
      return { ok: true, text: async () => JSON.stringify(next) };
    }
  });

  const plan = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const report = JSON.parse(fs.readFileSync(path.join(tmp, "generation-report.json"), "utf8"));
  const customer = plan.domainModel.entities.find((entity) => entity.name === "Customer");
  const subscription = plan.domainModel.entities.find((entity) => entity.name === "Subscription");
  assert(customer);
  assert(subscription);
  assert.deepEqual(customer.attributes.map((attr) => attr.name), ["Email", "PhoneNumber", "PaymentInformation"]);
  assert.deepEqual(subscription.attributes.map((attr) => attr.name), ["IsPaid"]);
  assert(!customer.attributes.some((attr) => ["Title", "Description", "Status", "CreatedAt"].includes(attr.name)));
  assert(!customer.attributes.some((attr) => attr.name === "AccountNumber"));
  assert(!subscription.attributes.some((attr) => ["Id", "Type", "StartDate", "EndDate"].includes(attr.name)));
  assert(!plan.domainModel.entities.some((entity) => entity.name === "User"));
  assert.equal(report.planDiagnostics.sectionPasses.coverage.missingEntityCandidateCount, 1);
  assert.equal(report.planDiagnostics.sectionPasses.coverage.addedEntityCandidates[0].name, "Subscription");
  assert(report.planDiagnostics.domainModelReview.rejectedAttributeCandidates.some((entry) => entry.attribute === "AccountNumber"));
  assert(report.planDiagnostics.domainModelReview.rejectedWeakEntities.some((entry) => entry.reason.includes("role-only")));
  assert.equal(report.planDiagnostics.domainModelReview.fallbackAttributeEntityCount, 0);
}

function testCoverageDoesNotDefaultToTaskDomain() {
  const plan = {
    domainModel: {
      entities: [
        { name: "Case", attributes: [{ name: "Title" }, { name: "Status" }] },
        { name: "Customer", attributes: [{ name: "FullName" }] }
      ],
      associations: [{ name: "Case_Customer", parentEntity: "Case", childEntity: "Customer" }]
    },
    pages: {
      specs: [
        { ref: "home", name: "Home", title: "Home", content: [{ type: "dynamicText", text: "Home" }] },
        { ref: "case_overview", name: "Case_Overview", title: "Case Overview", entityRef: "MyFirstModule.Case", content: [{ type: "listView" }] },
        { ref: "case_detail", name: "Case_Detail", title: "Case Detail", entityRef: "MyFirstModule.Case", content: [{ type: "dataView", content: [{ type: "attributeInput", attributeRef: "Title" }] }] }
      ]
    }
  };
  const stories = [
    {
      id: "US01",
      raw: "As a customer service agent, I want to manage cases for customers.",
      role: "customer service agent",
      want: "manage cases for customers",
      benefit: "",
      tags: [],
      tokens: ["customer", "service", "agent", "manage", "cases", "customers"]
    }
  ];

  const coverage = evaluateStoryCoverage(plan, stories, {
    classNames: ["Case", "Customer"],
    relationships: [{ domain: "Case", range: "Customer", name: "belongsTo" }]
  });
  assert.equal(coverage.score, 1);
  assert.equal(coverage.entries[0].covered, true);
}

function testDomainReviewPrunesUnsupportedEntityPagesAndNavigation() {
  const warnings = [];
  const plan = {
    app: {
      moduleName: "MyFirstModule",
      navigation: {
        homePageButtons: [{ pageRef: "workout_overview" }, { pageRef: "placeholder_overview" }],
        menuItems: [{ pageRef: "workout_overview" }, { pageRef: "placeholder_overview" }]
      }
    },
    domainModel: {
      entities: [
        { name: "Workout", attributes: [{ name: "Name", type: "String" }] },
        { name: "Exercise", attributes: [{ name: "Name", type: "String" }] },
        { name: "PlaceholderWorkflowView", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [
        { name: "Workout_Exercise", parentEntity: "Workout", childEntity: "Exercise", type: "ReferenceSet" },
        { name: "Workout_PlaceholderWorkflowView", parentEntity: "Workout", childEntity: "PlaceholderWorkflowView", type: "Reference" }
      ],
      enumerations: []
    },
    pages: {
      specs: [
        { ref: "workout_overview", name: "Workout_Overview", entityRef: "MyFirstModule.Workout", content: [] },
        { ref: "placeholder_overview", name: "Placeholder_Overview", entityRef: "MyFirstModule.PlaceholderWorkflowView", content: [] }
      ]
    }
  };

  const metadata = applyDomainModelReview({
    plan,
    reviewResult: {
      entities: [{ name: "PlaceholderWorkflowView", verdict: "drop", reason: "UI artifact, not a domain concept." }],
      associations: []
    },
    stories: [],
    warnings
  });

  assert.deepEqual(plan.domainModel.entities.map((entity) => entity.name), ["Workout", "Exercise"]);
  assert(!plan.pages.specs.some((page) => page.ref === "placeholder_overview"));
  assert(!plan.app.navigation.homePageButtonRefs.includes("placeholder_overview"));
  assert.equal(metadata.droppedEntities[0].name, "PlaceholderWorkflowView");
}

function testStoryBackedAssociationRepairAddsWorkoutExerciseSelectorIntent() {
  const warnings = [];
  const plan = {
    domainModel: {
      entities: [
        { name: "Workout", attributes: [{ name: "Name", type: "String" }] },
        { name: "Exercise", attributes: [{ name: "Name", type: "String" }] },
        { name: "Gym", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [{ name: "Gym_Exercise", parentEntity: "Gym", childEntity: "Exercise", type: "Reference" }],
      enumerations: []
    }
  };
  const stories = [
    {
      id: "US01",
      raw: "As an athlete, I want to add exercises to workouts so that each workout has a plan.",
      role: "athlete",
      want: "add exercises to workouts",
      benefit: "each workout has a plan",
      tags: [],
      tokens: ["athlete", "add", "exercises", "workouts", "workout", "plan"]
    }
  ];

  const metadata = applyDeterministicAssociationEvidence(plan, stories, warnings);
  assert(plan.domainModel.associations.some((assoc) =>
    assoc.name === "Workout_Exercise" &&
    assoc.parentEntity === "Workout" &&
    assoc.childEntity === "Exercise" &&
    assoc.type === "Reference"
  ));
  assert(!plan.domainModel.associations.some((assoc) => assoc.name === "Gym_Exercise"));
  assert.equal(metadata.added.length, 1);
  assert.equal(metadata.dropped.length, 1);
}

function testStoryBackedAssociationRepairResolvesHeadReferenceToCompoundEntity() {
  const warnings = [];
  const plan = {
    domainModel: {
      entities: [
        { name: "CocktailMenu", attributes: [{ name: "Name", type: "String" }] },
        { name: "Cocktail", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [],
      enumerations: []
    }
  };
  const stories = [
    {
      id: "US01",
      raw: "As a guest, I want to create a cocktail menu and select cocktails to add to that menu.",
      role: "guest",
      want: "create a cocktail menu and select cocktails to add to that menu",
      benefit: "",
      tags: [],
      tokens: ["guest", "create", "cocktail", "menu", "select", "cocktails", "add", "menu"]
    }
  ];

  const metadata = applyDeterministicAssociationEvidence(plan, stories, warnings);
  assert(plan.domainModel.associations.some((assoc) =>
    assoc.name === "CocktailMenu_Cocktail" &&
    assoc.parentEntity === "CocktailMenu" &&
    assoc.childEntity === "Cocktail"
  ));
  assert.equal(metadata.added.length, 1);
}

function testDomainReviewDoesNotApplyDeterministicAssociationsByDefault() {
  const warnings = [];
  const plan = {
    domainModel: {
      entities: [
        { name: "Workout", attributes: [{ name: "Name", type: "String" }] },
        { name: "Exercise", attributes: [{ name: "Name", type: "String" }] },
        { name: "Gym", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [{ name: "Gym_Exercise", parentEntity: "Gym", childEntity: "Exercise", type: "Reference" }],
      enumerations: []
    },
    pages: { specs: [] },
    app: { navigation: {} }
  };
  const stories = [
    {
      id: "US01",
      raw: "As an athlete, I want to add exercises to workouts so that each workout has a plan.",
      role: "athlete",
      want: "add exercises to workouts",
      benefit: "each workout has a plan",
      tags: [],
      tokens: ["athlete", "add", "exercises", "workouts", "workout", "plan"]
    }
  ];

  const hints = collectDeterministicAssociationHints({ plan, stories, visualNarrator: {}, processVisualizer: {} });
  const metadata = applyDomainModelReview({
    plan,
    reviewResult: { entities: [], associations: [], warnings: [] },
    stories,
    warnings
  });

  assert(hints.some((hint) => hint.parentEntity === "Workout" && hint.childEntity === "Exercise"));
  assert(!plan.domainModel.associations.some((assoc) => assoc.name === "Workout_Exercise"));
  assert(plan.domainModel.associations.some((assoc) => assoc.name === "Gym_Exercise"));
  assert.equal(metadata.addedAssociations.length, 0);
  assert.equal(metadata.droppedAssociations.length, 0);
}

function testDomainReviewKeepsStoryBackedCompoundEntityDropVerdict() {
  const warnings = [];
  const plan = {
    domainModel: {
      entities: [
        { name: "CocktailMenu", attributes: [{ name: "Name", type: "String" }] },
        { name: "Menu", attributes: [{ name: "Name", type: "String" }] },
        { name: "Cocktail", attributes: [{ name: "Name", type: "String" }] }
      ],
      associations: [],
      enumerations: []
    }
  };
  const stories = [
    {
      id: "US01",
      raw: "As a guest, I want to create a cocktail menu and select cocktails to add to that menu.",
      role: "guest",
      want: "create a cocktail menu and select cocktails to add to that menu",
      benefit: "",
      tags: [],
      tokens: []
    }
  ];

  const metadata = applyDomainModelReview({
    plan,
    reviewResult: {
      entities: [{ name: "CocktailMenu", verdict: "drop", reason: "Duplicate of Menu." }],
      associations: []
    },
    stories,
    warnings
  });

  assert(plan.domainModel.entities.some((entity) => entity.name === "CocktailMenu"));
  assert(plan.domainModel.entities.some((entity) => entity.name === "Cocktail"));
  assert(metadata.warnings.some((entry) => entry.includes("Kept story-backed entity")));
}

function testDomainReviewDropsGenericAndParserArtifactEntities() {
  const warnings = [];
  const plan = {
    domainModel: {
      entities: [
        { name: "Workout", attributes: [{ name: "Name", type: "String" }] },
        { name: "Exercise", attributes: [{ name: "Name", type: "String" }] },
        { name: "Able", attributes: [{ name: "Title", type: "String" }] },
        { name: "Such", attributes: [{ name: "Title", type: "String" }] },
        { name: "Select", attributes: [{ name: "Title", type: "String" }] },
        { name: "NdManageExercise", attributes: [{ name: "Title", type: "String" }] },
        { name: "AddedExercise", attributes: [{ name: "Title", type: "String" }] },
        { name: "ItsDetail", attributes: [{ name: "Title", type: "String" }] }
      ],
      associations: [
        { name: "Workout_Able", parentEntity: "Workout", childEntity: "Able", type: "Reference" },
        { name: "Workout_Exercise", parentEntity: "Workout", childEntity: "Exercise", type: "Reference" },
        { name: "Workout_AddedExercise", parentEntity: "Workout", childEntity: "AddedExercise", type: "Reference" }
      ],
      enumerations: []
    },
    pages: {
      specs: [
        { ref: "able_overview", name: "Able_Overview", entityRef: "MyFirstModule.Able", content: [] },
        { ref: "workout_overview", name: "Workout_Overview", entityRef: "MyFirstModule.Workout", content: [] }
      ]
    }
  };

  const metadata = applyDomainModelReview({
    plan,
    reviewResult: { entities: [], associations: [], warnings: [] },
    stories: [],
    warnings
  });

  assert.deepEqual(plan.domainModel.entities.map((entity) => entity.name), ["Workout", "Exercise"]);
  assert(!plan.domainModel.associations.some((assoc) => assoc.name === "Workout_Able"));
  assert(!plan.domainModel.associations.some((assoc) => assoc.name === "Workout_AddedExercise"));
  assert(!plan.pages.specs.some((page) => page.ref === "able_overview"));
  assert(metadata.droppedEntities.some((entry) => entry.name === "NdManageExercise"));
  assert(metadata.droppedEntities.some((entry) => entry.name === "AddedExercise"));
  assert(metadata.droppedEntities.some((entry) => entry.name === "ItsDetail"));
}

function testDomainReviewDropsCompositeArtifactEntity() {
  const warnings = [];
  const plan = {
    app: {
      navigation: {
        homePageButtons: [{ pageRef: "gymexercise_overview" }, { pageRef: "workout_overview" }],
        menuItems: [{ pageRef: "gymexercise_overview" }, { pageRef: "workout_overview" }]
      }
    },
    domainModel: {
      entities: [
        { name: "Gym", attributes: [{ name: "Name", type: "String" }] },
        { name: "Exercise", attributes: [{ name: "Name", type: "String" }] },
        { name: "Workout", attributes: [{ name: "Name", type: "String" }] },
        { name: "GymExercise", attributes: [{ name: "Title", type: "String" }] }
      ],
      associations: [
        { name: "Workout_Exercise", parentEntity: "Workout", childEntity: "Exercise", type: "ReferenceSet" },
        { name: "Workout_GymExercise", parentEntity: "Workout", childEntity: "GymExercise", type: "Reference" }
      ],
      enumerations: []
    },
    pages: {
      specs: [
        { ref: "gymexercise_overview", name: "GymExercise_Overview", entityRef: "MyFirstModule.GymExercise", content: [] },
        { ref: "gymexercise_newedit", name: "GymExercise_NewEdit", entityRef: "MyFirstModule.GymExercise", content: [] },
        { ref: "workout_overview", name: "Workout_Overview", entityRef: "MyFirstModule.Workout", content: [] }
      ]
    }
  };
  const stories = [
    {
      id: "US01",
      raw: "As an athlete, I want to add exercises to workouts so that each workout has a plan.",
      role: "athlete",
      want: "add exercises to workouts",
      benefit: "each workout has a plan",
      tags: [],
      tokens: []
    }
  ];

  const metadata = applyDomainModelReview({
    plan,
    reviewResult: { entities: [], associations: [], warnings: [] },
    stories,
    warnings
  });

  assert.deepEqual(plan.domainModel.entities.map((entity) => entity.name), ["Gym", "Exercise", "Workout"]);
  assert(!plan.domainModel.associations.some((assoc) => assoc.name === "Workout_GymExercise"));
  assert(!plan.pages.specs.some((page) => page.entityRef === "MyFirstModule.GymExercise"));
  assert(!plan.app.navigation.homePageButtonRefs.includes("gymexercise_overview"));
  assert(metadata.droppedEntities.some((entry) => entry.name === "GymExercise"));
}

function testBaselineDoesNotAutoAssociateCategoryNamedEntities() {
  const draft = buildStoryDrivenBaselineDraft({
    stories: [
      {
        id: "US01",
        raw: "As a coordinator, I want to view tickets and comments.",
        role: "coordinator",
        want: "view tickets and comments",
        benefit: "",
        tags: [],
        tokens: ["coordinator", "view", "tickets", "comments"]
      }
    ],
    moduleName: "MyFirstModule",
    visualNarratorSummary: {
      classNames: ["Ticket", "Comment"],
      classes: [{ name: "Ticket" }, { name: "Comment" }],
      relationships: [],
      keyNouns: [{ term: "Ticket", weight: 2 }, { term: "Comment", weight: 2 }],
      inferredRoles: ["Coordinator"]
    }
  });

  const entityNames = draft.domainModel.entities.map((entity) => entity.name);
  assert(entityNames.includes("Ticket"));
  assert(entityNames.includes("Comment"));
  assert(!draft.domainModel.associations.some((assoc) =>
    [assoc.parentEntity, assoc.childEntity].includes("Ticket") &&
    [assoc.parentEntity, assoc.childEntity].includes("Comment")
  ));
}

async function run() {
  testMissingRequiredFiles();
  testOptionalTxtFilesAreAccepted();
  testAcceptanceCriteriaFileIsAccepted();
  testAppIdIsRequired();
  testCreateAppInputAllowsMissingAppId();
  testBpmnWarning();
  testNormalizeGeneratedPlanProducesValidPlan();
  testNormalizeGeneratedPlanNormalizesReferenceSetLookupToDropdownInput();
  testNormalizeGeneratedPlanDropsTitleOnlyPlaceholderPages();
  testNormalizeGeneratedPlanSanitizesNavigationIcons();
  testNormalizeGeneratedPlanAugmentsNameOnlyEntities();
  testNormalizeGeneratedPlanUsesOnlyGenericDefaultsForCategoryNames();
  testNormalizeGeneratedPlanFiltersInstructionalRoleNames();
  testWorkflowScaffoldPrefersExplicitContextAndFinalStartRepair();
  testDomainReviewDropsSpecificDuplicateGenericEntities();
  testNavigationBackfillsCoreOverviewPages();
  testFinalPageRepairDropsInvalidPageSpecsBeforeNavigation();
  testNormalizeGeneratedPlanReconcilesStalePageAttributeRefs();
  testNormalizeGeneratedPlanSanitizesAttributeNames();
  testCoverageAttributesAcceptOnlyStoryBackedEvidence();
  testCoverageAttributesKeepPlaceholderWhenEvidenceIsWeak();
  testNormalizeGeneratedPlanDropsUnbuildableFlowActions();
  testNormalizeGeneratedPlanDropsSemanticallyInvalidMicroflowAndRefs();
  testNormalizeGeneratedPlanRepairsConceptualMicroflowDslAliases();
  testNormalizeGeneratedPlanDropsInvalidFlowExpressions();
  testNormalizeGeneratedPlanQuotesCreateVariableStringInitialValue();
  testNormalizeGeneratedPlanForcesPrototypeSecurity();
  testNormalizeGeneratedPlanCoercesEntityParameterType();
  testNormalizeGeneratedPlanSynthesizesSecurityFromStoriesAndDomainInfo();
  testNormalizeGeneratedPlanCanonicalizesSemanticAssociationTypes();
  testGeneratorCliDefaultsToVisualNarrator();
  testSeparatePrecomputeCliDefaults();
  testE2eCliDefaultsToVisualNarrator();
  testSeparateVisualNarratorPrecomputeWritesCanonicalArtifacts();
  testSeparateProcessVisualizerPrecomputeWritesCanonicalArtifacts();
  testPreprocessingPrefersInputArtifactsOverMockAndInlineRuns();
  testPreprocessingFallsBackToInlineWhenArtifactsAbsent();
  testCommanderOutputParsingHandlesSdkLogs();
  testE2ePlanCheckerFailureSummaryIncludesStubFlags();
  testCoverageGateDetailsUseStoryTextFallback();
  testProcessVisualizerFailureCanDegradeGracefully();
  testProcessVisualizerUsesDedicatedModel();
  await testLlmRetryHelperRetriesFailures();
  await testCallOllamaGenerateReadsStreamingResponses();
  await testFirstLlmFailureAbortsGeneration();
  await testGeneratePlanRunsMockedDomainModelReviewPass();
  await testGeneratePlanSanitizesMalformedPagePassOutput();
  await testGeneratePlanContinuesWhenPagePassReturnsInvalidJson();
  await testGeneratePlanDebugStopAfterPagePassWritesArtifacts();
  testVisualNarratorPromptTextUsesStructuredEvidence();
  testOllamaPromptOrdersDomainRulesBeforePageRules();
  testBaselineGeneralizesToCaseManagement();
  testBaselineGeneralizesToStaffAdmin();
  testBaselineKeepsNeutralVerbObjectExtraction();
  testBaselineUsesExplicitDomainInfoEntityLabels();
  testProcessTaskActionsDoNotCreateBaselineEntities();
  testBaselineTreatsVisualNarratorAsSupportingEvidence();
  testWorkflowScaffoldRepairsPlaceholderTaskPages();
  testBaselineUsesStandardHomeDashboardAndPopupPatterns();
  testNormalizeGeneratedPlanRepairsDanglingGeneratedNewEditRefs();
  testNormalizeGeneratedPlanCapturesMalformedAssociationCandidates();
  testDomainReviewRepairsMalformedAssociationCandidate();
  testDomainReviewRejectsMalformedAssociationCandidateWithMissingEntity();
  testDomainReviewAppliesMissingEntityWarningRecommendation();
  testNormalizeGeneratedPlanRemovesSyntheticRolesAndCreatesRoleEntities();
  testNormalizeGeneratedPlanStripsModuleQualifiedRoleNamesAndDropsDuplicateEntities();
  testNormalizeGeneratedPlanStripsRoleSuffixAndDropsDuplicateRoleEntities();
  testNormalizeGeneratedPlanRenamesEnumerationCollidingWithEntity();
  testNormalizeGeneratedPlanStripsLlmDemoUsers();
  testAssociationGenerationAddsValidAssociationsAndRejectsInvalidEndpoints();
  testAssociationGapAuditFindsUnlinkedAndCoMentionedEntities();
  testAssociationGapAuditSuppressesExistingAssociations();
  await testAssociationGenerationRepairPassAddsMissingAssociation();
  await testAssociationGenerationRepairPassCanOverrideHintDirection();
  await testAssociationGenerationUnavailableKeepsReviewedAssociations();
  testBooleanDefaultsArePreservedAndDefaultedFalse();
  testEntityPassNormalizationDoesNotExpandNameFallback();
  await testMultiPassEntityPassReplacesBaselineFallbackAttributes();
  testCoverageDoesNotDefaultToTaskDomain();
  testDomainReviewPrunesUnsupportedEntityPagesAndNavigation();
  testStoryBackedAssociationRepairAddsWorkoutExerciseSelectorIntent();
  testStoryBackedAssociationRepairResolvesHeadReferenceToCompoundEntity();
  testDomainReviewDoesNotApplyDeterministicAssociationsByDefault();
  testDomainReviewKeepsStoryBackedCompoundEntityDropVerdict();
  testDomainReviewDropsGenericAndParserArtifactEntities();
  testDomainReviewDropsCompositeArtifactEntity();
  testBaselineDoesNotAutoAssociateCategoryNamedEntities();
  console.log("plan generator unit tests: OK");
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { run };
