function requireSdkPackage(pkgName) {
  return require(pkgName);
}

function loadSdk() {
  const platform = requireSdkPackage("mendixplatformsdk");
  const model = requireSdkPackage("mendixmodelsdk");
  return { platform, model };
}

function loadModelNamespaces() {
  const sdk = requireSdkPackage("mendixmodelsdk");
  return {
    microflows: sdk.microflows,
    workflows: sdk.workflows,
    settings: sdk.settings
  };
}

function clearList(list) {
  if (!list) return;
  if (typeof list.replace === "function") {
    list.replace([]);
    return;
  }
  if (typeof list.clear === "function") {
    list.clear();
    return;
  }
  if (Array.isArray(list)) {
    list.length = 0;
  }
}

function toUniqueStrings(values) {
  return [...new Set((values || []).filter((v) => typeof v === "string" && v.length > 0))];
}

async function findModule(model, moduleName) {
  function resolveModuleFromFolderBase(folderBase) {
    let current = folderBase || null;
    let guard = 0;
    while (current && guard < 20) {
      if (current.containerAsModule && current.containerAsModule.name) {
        return current.containerAsModule;
      }
      if (current.containerAsFolder && current.containerAsFolder.containerAsModule && current.containerAsFolder.containerAsModule.name) {
        return current.containerAsFolder.containerAsModule;
      }
      if (current.containerAsFolder && current.containerAsFolder.containerAsFolderBase) {
        current = current.containerAsFolder.containerAsFolderBase;
        guard += 1;
        continue;
      }
      break;
    }
    return null;
  }

  if (typeof model.allWorkflows === "function") {
    for (const wf of model.allWorkflows()) {
      const mod = resolveModuleFromFolderBase(wf && wf.containerAsFolderBase);
      if (mod && mod.name === moduleName) {
        return mod;
      }
    }
  }

  if (typeof model.allDomainModels === "function") {
    const dmIface = model
      .allDomainModels()
      .find((dm) => dm && dm.containerAsModule && dm.containerAsModule.name === moduleName);
    if (dmIface) {
      const dm = typeof dmIface.load === "function" ? await dmIface.load() : dmIface;
      if (dm && dm.containerAsModule) return dm.containerAsModule;
    }
  }

  const moduleIface = model.allModules().find((m) => m.name === moduleName);
  if (!moduleIface) return null;
  if (typeof moduleIface.load === "function") {
    try {
      const loaded = await moduleIface.load();
      if (loaded) return loaded;
    } catch (_err) {
      // Fallback to iface below.
    }
  }
  return moduleIface;
}

async function findOrCreateProjectSettings(model, settings) {
  const existingIface =
    typeof model.allProjectSettings === "function" ? model.allProjectSettings()[0] || null : null;

  if (existingIface) {
    return typeof existingIface.load === "function" ? existingIface.load() : existingIface;
  }

  if (!settings || !settings.ProjectSettings || typeof settings.ProjectSettings.createIn !== "function") {
    throw new Error("ProjectSettings.createIn is unavailable in this SDK version.");
  }

  const projectIface = typeof model.allProjects === "function" ? model.allProjects()[0] || null : null;
  if (!projectIface) {
    throw new Error("Could not create project settings: no project found in model.");
  }

  const project = typeof projectIface.load === "function" ? await projectIface.load() : projectIface;
  return settings.ProjectSettings.createIn(project);
}

function findProjectSettingsPart(projectSettings, ctor) {
  const parts = Array.isArray(projectSettings && projectSettings.settingsParts) ? projectSettings.settingsParts : [];
  return parts.find((part) => part instanceof ctor) || null;
}

function resolveEntityReference(model, moduleName, rawEntityRef) {
  if (!rawEntityRef) return null;
  const raw = String(rawEntityRef).trim();
  if (!raw) return null;

  const candidates = [];
  const simple = raw.includes(".") ? raw.split(".").pop() : raw;

  if (raw.includes(".")) candidates.push(raw);
  if (moduleName && simple) candidates.push(`${moduleName}.${simple}`);

  if (typeof model.allDomainModels === "function" && simple) {
    for (const dm of model.allDomainModels()) {
      const mod = dm && dm.containerAsModule;
      if (mod && mod.name) candidates.push(`${mod.name}.${simple}`);
    }
  }

  for (const qname of toUniqueStrings(candidates)) {
    const entity = model.findEntityByQualifiedName(qname);
    if (entity) return entity;
  }

  return null;
}

async function ensureWorkflowProjectSettings({ model, settings }) {
  if (!settings || !settings.WorkflowsProjectSettingsPart) return null;

  const projectSettings = await findOrCreateProjectSettings(model, settings);
  let workflowSettings = findProjectSettingsPart(projectSettings, settings.WorkflowsProjectSettingsPart);
  if (!workflowSettings) {
    if (typeof settings.WorkflowsProjectSettingsPart.createIn !== "function") {
      throw new Error("WorkflowsProjectSettingsPart.createIn is unavailable in this SDK version.");
    }
    workflowSettings = settings.WorkflowsProjectSettingsPart.createIn(projectSettings);
  }

  const accountEntity =
    (typeof model.findEntityByQualifiedName === "function" && model.findEntityByQualifiedName("Administration.Account")) || null;
  if (accountEntity && "userEntity" in workflowSettings) {
    workflowSettings.userEntity = accountEntity;
  }

  return workflowSettings;
}

function setRawByNameReference(target, propName, qname) {
  if (!target || !propName || !qname) return false;

  const candidates = [
    `__${propName}`,
    `_${propName}`,
    `_${propName.charAt(0).toUpperCase()}${propName.slice(1)}`,
    `__${propName.charAt(0).toUpperCase()}${propName.slice(1)}`
  ];

  for (const key of candidates) {
    const ref = target[key];
    if (ref && typeof ref.updateWithRawValue === "function") {
      ref.updateWithRawValue(qname);
      return true;
    }
  }

  return false;
}

function resolveWorkflowQualifiedName(moduleName, refOrName) {
  if (!refOrName) return "";
  const raw = String(refOrName).trim();
  if (!raw) return "";
  if (raw.includes(".")) return raw;
  return `${moduleName}.${raw}`;
}

function resolveMicroflowByReference({ model, moduleName, ref, microflowRefsByRef = {} }) {
  if (!ref) return null;
  const raw = String(ref).trim();
  if (!raw) return null;

  const mappedQname = microflowRefsByRef[raw] || "";
  if (mappedQname) {
    const mapped = model.findMicroflowByQualifiedName(mappedQname);
    if (mapped) return mapped;
  }

  if (raw.includes(".")) {
    const direct = model.findMicroflowByQualifiedName(raw);
    if (direct) return direct;
  }

  const inModule = model.findMicroflowByQualifiedName(`${moduleName}.${raw}`);
  if (inModule) return inModule;

  return model.allMicroflows().find((mf) => mf.name === raw) || null;
}

function collectMicroflowParameters(handler) {
  const objects =
    handler && handler.objectCollection && Array.isArray(handler.objectCollection.objects)
      ? handler.objectCollection.objects
      : [];
  return objects.filter((item) => item && item.structureTypeName === "Microflows$MicroflowParameterObject");
}

function syncServiceTaskParameterMappings({
  workflows,
  model,
  activity,
  handler,
  workflowParameterName = "WorkflowContext",
  step = {}
}) {
  if (!activity || !Array.isArray(activity.parameterMappings) || !workflows || !workflows.MicroflowCallParameterMapping) {
    return;
  }

  clearList(activity.parameterMappings);

  const handlerParameters = collectMicroflowParameters(handler);
  if (handlerParameters.length === 0) return;

  const configuredMappings =
    (step.handlerParameterExpressions && typeof step.handlerParameterExpressions === "object" && step.handlerParameterExpressions) ||
    (step.parameterExpressions && typeof step.parameterExpressions === "object" && step.parameterExpressions) ||
    {};
  const workflowContextExpression = `$${String(workflowParameterName || "WorkflowContext").trim() || "WorkflowContext"}`;

  for (const parameter of handlerParameters) {
    const explicit = configuredMappings[parameter.name];
    const expression =
      (explicit !== undefined && explicit !== null ? String(explicit).trim() : "") ||
      (handlerParameters.length === 1 ? workflowContextExpression : parameter.name === workflowParameterName ? workflowContextExpression : "");
    if (!expression) continue;

    const mapping = workflows.MicroflowCallParameterMapping.create(model);
    mapping.parameter = parameter;
    mapping.expression = expression;
    activity.parameterMappings.push(mapping);
  }
}

function resolvePageByReference({ model, moduleName, ref, pageRefsByRef = {} }) {
  if (!ref) return { page: null, qname: "" };
  const raw = String(ref).trim();
  if (!raw) return { page: null, qname: "" };

  const mappedQname = pageRefsByRef[raw] || "";
  if (mappedQname) {
    const mapped = model.findPageByQualifiedName(mappedQname);
    return { page: mapped || null, qname: mappedQname };
  }

  if (raw.includes(".")) {
    const direct = model.findPageByQualifiedName(raw);
    return { page: direct || null, qname: raw };
  }

  const inModuleQname = `${moduleName}.${raw}`;
  const inModule = model.findPageByQualifiedName(inModuleQname);
  if (inModule) return { page: inModule, qname: inModuleQname };

  const byName = model.allPages().find((p) => p.name === raw);
  if (byName) {
    const qname = byName.qualifiedName || `${moduleName}.${raw}`;
    return { page: byName, qname };
  }

  return { page: null, qname: inModuleQname };
}

function normalizeWorkflowUserRoleRefs(step = {}) {
  const refs = Array.isArray(step.userRoleRefs)
    ? step.userRoleRefs
    : Array.isArray(step.targetUserRoleRefs)
      ? step.targetUserRoleRefs
      : Array.isArray(step.allowedUserRoles)
        ? step.allowedUserRoles
        : [];
  return [...new Set(refs.map((ref) => String(ref || "").trim()).filter(Boolean))];
}

function toUserRoleTokenName(rawRef = "") {
  const name = String(rawRef || "").trim().split(".").pop() || "";
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(
      `Workflow user role "${rawRef}" cannot be converted to a deterministic Mendix user-role token. ` +
        "Use only letters, digits, and underscores, or provide userAssignmentXPath explicitly."
    );
  }
  return name;
}

function buildUserTaskAssignmentXPath(step = {}) {
  const explicitXPath =
    step.userAssignmentXPath ||
    step.userTargetingXPath ||
    step.userSourceXPath ||
    "";
  if (String(explicitXPath || "").trim()) {
    return String(explicitXPath).trim();
  }

  const roleRefs = normalizeWorkflowUserRoleRefs(step);
  if (roleRefs.length === 0) {
    return "[not(IsAnonymous)]";
  }

  const roleClauses = roleRefs.map((roleRef) => `System.UserRoles = '[%UserRole_${toUserRoleTokenName(roleRef)}%]'`);
  return `[not(IsAnonymous) and (${roleClauses.join(" or ")})]`;
}

async function deleteWorkflowIfExists(model, moduleName, name) {
  const workflowIface = model
    .allWorkflows()
    .find(
      (wf) =>
        wf.name === name &&
        wf.containerAsFolderBase &&
        wf.containerAsFolderBase.containerAsModule &&
        wf.containerAsFolderBase.containerAsModule.name === moduleName
    );

  if (!workflowIface) return;
  const loaded = typeof workflowIface.load === "function" ? await workflowIface.load() : workflowIface;
  loaded.delete();
}

function normalizeStepType(type) {
  const raw = String(type || "").trim();
  if (!raw) return "";

  const lower = raw.toLowerCase();
  if (lower === "start" || lower === "startevent" || lower === "start_event") return "start";
  if (lower === "end" || lower === "endevent" || lower === "end_event") return "end";
  if (lower === "usertask" || lower === "user_task") return "userTask";
  if (lower === "servicetask" || lower === "service_task" || lower === "callmicroflowtask") return "serviceTask";
  if (lower === "exclusivegateway" || lower === "exclusive_gateway" || lower === "decision") {
    return "exclusiveGateway";
  }

  return raw;
}

function createWorkflowDocument({ workflows, module, moduleName, spec }) {
  const workflow = workflows.Workflow.createIn(module);
  workflow.name = spec.name;
  workflow.title = spec.title || spec.name;

  if (workflow.workflowName && "text" in workflow.workflowName) {
    workflow.workflowName.text = spec.displayName || spec.name;
  }

  if (workflow.workflowDescription && "text" in workflow.workflowDescription) {
    workflow.workflowDescription.text = spec.description || "Generated by workflow builder";
  }

  const contextEntityRef =
    (spec.bindings && spec.bindings.contextEntityRef) ||
    spec.contextEntityRef ||
    spec.parameterEntityRef ||
    "";

  if (!contextEntityRef) {
    throw new Error(`Workflow "${spec.name}" is missing bindings.contextEntityRef in strict deterministic mode.`);
  }

  const entity = resolveEntityReference(workflow.model, moduleName, contextEntityRef);
  if (!entity) {
    throw new Error(`Could not resolve workflow context entity "${contextEntityRef}" for "${spec.name}".`);
  }

  if (!workflow.parameter) {
    throw new Error(`Workflow "${spec.name}" has no parameter part available in this SDK version.`);
  }

  workflow.parameter.entity = entity;

  const parameterName =
    (spec.bindings && spec.bindings.contextParameterName) ||
    spec.contextParameterName ||
    workflow.parameter.name ||
    "WorkflowContext";
  workflow.parameter.name = parameterName;

  clearList(workflow.flow && workflow.flow.activities);

  return workflow;
}

function createStartActivity(workflows, flow, step) {
  const activity = workflows.StartWorkflowActivity.createInFlowUnderActivities(flow);
  activity.name = step.name || step.id || "Start";
  activity.caption = step.caption || step.name || "Start";
  return activity;
}

function createEndActivity(workflows, flow, step) {
  const activity = workflows.EndWorkflowActivity.createInFlowUnderActivities(flow);
  activity.name = step.name || step.id || "End";
  activity.caption = step.caption || step.name || "End";
  return activity;
}

function createActivityInFlow(workflows, className, flow) {
  const ctor = workflows && workflows[className];
  if (!ctor) {
    throw new Error(`Workflow activity class "${className}" is unavailable in this SDK version.`);
  }

  const helperName = "createInFlowUnderActivities";
  if (typeof ctor[helperName] === "function") {
    try {
      return ctor[helperName](flow);
    } catch (err) {
      const message = String(err && err.message || err || "");
      if (!/illegal .*createIn|createIn method|can no longer be instantiated|removed since Mendix version/i.test(message)) {
        throw err;
      }
    }
  }

  if (typeof ctor.create !== "function") {
    throw new Error(`Workflow activity class "${className}" cannot be created in this SDK version.`);
  }

  const model = flow && flow.model;
  if (!model) {
    throw new Error(`Could not create workflow activity "${className}": flow has no model reference.`);
  }

  let activity;
  try {
    activity = ctor.create(model);
  } catch (err) {
    const message = String(err && err.message || err || "");
    if (/can no longer be instantiated|removed since Mendix version/i.test(message)) {
      const wrapped = new Error(`Workflow activity class "${className}" is not instantiable in this Mendix version: ${message}`);
      wrapped.code = "WORKFLOW_ACTIVITY_REMOVED";
      throw wrapped;
    }
    throw err;
  }
  if (!flow.activities || typeof flow.activities.push !== "function") {
    throw new Error(`Could not attach workflow activity "${className}": flow.activities is not mutable.`);
  }
  flow.activities.push(activity);
  return activity;
}

function createServiceTaskActivity({
  workflows,
  flow,
  step,
  model,
  moduleName,
  microflowRefsByRef,
  workflowParameterName = "WorkflowContext"
}) {
  const activity = createActivityInFlow(workflows, "CallMicroflowTask", flow);
  activity.name = step.name || step.id || "ServiceTask";
  activity.caption = step.caption || step.name || "Service task";

  const handlerRef =
    step.handlerMicroflowRef || step.microflowRef || step.handlerRef || step.handlerMicroflowQualifiedName || "";
  if (!handlerRef) {
    throw new Error(
      `Service task "${activity.name}" has no handlerMicroflowRef/handlerMicroflowQualifiedName in strict mode.`
    );
  }

  const handler = resolveMicroflowByReference({
    model,
    moduleName,
    ref: handlerRef,
    microflowRefsByRef
  });

  if (!handler) {
    throw new Error(`Could not resolve service task handler microflow "${handlerRef}" for "${activity.name}".`);
  }

  activity.microflow = handler;
  syncServiceTaskParameterMappings({
    workflows,
    model,
    activity,
    handler,
    workflowParameterName,
    step
  });
  return activity;
}

function applyUserTaskPage({ activity, model, moduleName, pageRefsByRef, step }) {
  const rawRef =
    step.taskPageQualifiedName || step.taskPageRef || step.pageQualifiedName || step.pageRef || step.taskPage || "";

  if (!rawRef) {
    throw new Error(
      `User task "${activity.name}" is missing taskPageRef/taskPageQualifiedName. ` +
        "In v1 strict mode this must point to an existing page or deterministic qualified name."
    );
  }

  const { page, qname } = resolvePageByReference({
    model,
    moduleName,
    ref: rawRef,
    pageRefsByRef
  });

  if (page) {
    activity.taskPage.page = page;
    return;
  }

  const updated = setRawByNameReference(activity.taskPage, "page", qname);
  if (!updated) {
    throw new Error(
      `Could not bind user task page reference "${rawRef}" (resolved qname "${qname}") for "${activity.name}".`
    );
  }
}

function createUserTaskActivity({ workflows, flow, step, model, moduleName, pageRefsByRef }) {
  const activity = workflows.SingleUserTaskActivity.createInFlowUnderActivities(flow);
  activity.name = step.name || step.id || "UserTask";
  activity.caption = step.caption || step.name || "User task";

  applyStringTemplate({
    template: activity.taskName,
    text: step.taskName || step.name || activity.name,
    args: step.taskNameArgs || step.taskNameArguments || []
  });

  applyStringTemplate({
    template: activity.taskDescription,
    text: step.taskDescription || "Generated user task",
    args: step.taskDescriptionArgs || step.taskDescriptionArguments || []
  });

  // Mendix requires valid user assignment targeting for user tasks.
  // In Mx 11.2+ this is userTargeting (XPathUserTargeting by default),
  // in earlier versions it is userSource.
  const assignmentXPath = buildUserTaskAssignmentXPath(step);

  if (activity.userTargeting && "xPathConstraint" in activity.userTargeting) {
    activity.userTargeting.xPathConstraint = assignmentXPath;
  } else if (activity.userSource && "xPathConstraint" in activity.userSource) {
    activity.userSource.xPathConstraint = assignmentXPath;
  }

  applyUserTaskPage({ activity, model, moduleName, pageRefsByRef, step });
  return activity;
}

function applyStringTemplate({ template, text = "", args = [] }) {
  if (!template || !("text" in template)) return;
  template.text = String(text || "");

  if (!("arguments" in template)) return;
  clearList(template.arguments);

  const expressions = Array.isArray(args) ? args : [];
  if (expressions.length === 0) return;

  const sdk = requireSdkPackage("mendixmodelsdk");
  const microflows = sdk.microflows || null;
  if (!microflows || !microflows.TemplateArgument || typeof microflows.TemplateArgument.createIn !== "function") {
    return;
  }

  for (const rawExpression of expressions) {
    const expression = String(rawExpression || "").trim();
    if (!expression) continue;
    const argument = microflows.TemplateArgument.createIn(template);
    argument.expression = expression;
  }
}

function createExclusiveGatewayActivity(workflows, flow, step) {
  const activity = workflows.ExclusiveSplitActivity.createInFlowUnderActivities(flow);
  activity.name = step.name || step.id || "Decision";
  activity.caption = step.caption || step.name || "Decision";
  activity.expression = step.expression || "true";
  return activity;
}

function createConditionOutcome(workflows, gateway, outcomeSpec) {
  const rawCond = outcomeSpec && outcomeSpec.conditionExpression !== undefined
    ? outcomeSpec.conditionExpression
    : outcomeSpec && outcomeSpec.condition;

  if (typeof rawCond === "boolean") {
    const outcome = workflows.BooleanConditionOutcome.createIn(gateway);
    outcome.value = rawCond;
    return outcome;
  }

  if (typeof rawCond === "string") {
    const trimmed = rawCond.trim().toLowerCase();
    if (trimmed === "true" || trimmed === "false") {
      const outcome = workflows.BooleanConditionOutcome.createIn(gateway);
      outcome.value = trimmed === "true";
      return outcome;
    }
  }

  return workflows.VoidConditionOutcome.createIn(gateway);
}

function createUserTaskOutcome(workflows, userTask, value = "Complete") {
  const outcome = workflows.UserTaskOutcome.createInUserTaskActivityUnderOutcomes(userTask);
  outcome.value = String(value || "Complete");
  return outcome;
}

function validateBooleanGatewayOutcomes(outcomes = [], activityName = "exclusiveGateway") {
  const normalized = (Array.isArray(outcomes) ? outcomes : [])
    .map((outcome) => {
      const raw = outcome && outcome.conditionExpression !== undefined ? outcome.conditionExpression : outcome && outcome.condition;
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "string") {
        const lower = raw.trim().toLowerCase();
        if (lower === "true") return true;
        if (lower === "false") return false;
      }
      return null;
    })
    .filter((v) => v !== null);

  if (normalized.length === 0) return;

  const trueCount = normalized.filter((v) => v === true).length;
  const falseCount = normalized.filter((v) => v === false).length;
  if (trueCount !== 1 || falseCount !== 1) {
    throw new Error(
      `Exclusive gateway \"${activityName}\" must define exactly one true and one false outcome (got true=${trueCount}, false=${falseCount}).`
    );
  }
}

function buildStepsInFlow({ workflows, flow, steps, context, depth = 0 }) {
  if (depth > 100) {
    throw new Error("Workflow DSL nesting depth exceeded safe limit (100).");
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    return;
  }

  for (let i = 0; i < steps.length; i++) {
    const rawStep = steps[i] || {};
    const step = { ...rawStep, type: normalizeStepType(rawStep.type) };

    if (!step.type) {
      throw new Error("Workflow DSL step missing required field: type.");
    }

    if (step.type === "start") {
      createStartActivity(workflows, flow, step);
      continue;
    }

    if (step.type === "end") {
      createEndActivity(workflows, flow, step);
      if (i !== steps.length - 1) {
        throw new Error("Workflow DSL has steps after an end step, which is not deterministic.");
      }
      return;
    }

    if (step.type === "serviceTask") {
      let activity = null;
      try {
        activity = createServiceTaskActivity({
          workflows,
          flow,
          step,
          model: context.model,
          moduleName: context.moduleName,
          microflowRefsByRef: context.microflowRefsByRef,
          workflowParameterName: context.workflowParameterName
        });
      } catch (err) {
        if (!err || err.code !== "WORKFLOW_ACTIVITY_REMOVED") {
          throw err;
        }
        buildStepsInFlow({
          workflows,
          flow,
          steps: steps.slice(i + 1),
          context,
          depth: depth + 1
        });
        return;
      }

      const outcome = workflows.VoidConditionOutcome.createIn(activity);
      const remainder = steps.slice(i + 1);
      buildStepsInFlow({
        workflows,
        flow: outcome.flow,
        steps: remainder,
        context,
        depth: depth + 1
      });
      return;
    }

    if (step.type === "userTask") {
      const activity = createUserTaskActivity({
        workflows,
        flow,
        step,
        model: context.model,
        moduleName: context.moduleName,
        pageRefsByRef: context.pageRefsByRef
      });

      const providedOutcomes = Array.isArray(step.outcomes) ? step.outcomes : [];

      if (providedOutcomes.length === 0) {
        const outcome = createUserTaskOutcome(workflows, activity, "Complete");
        const remainder = steps.slice(i + 1);
        buildStepsInFlow({
          workflows,
          flow: outcome.flow,
          steps: remainder,
          context,
          depth: depth + 1
        });
        return;
      }

      for (let oi = 0; oi < providedOutcomes.length; oi++) {
        const outcomeSpec = providedOutcomes[oi] || {};
        const outcome = createUserTaskOutcome(
          workflows,
          activity,
          outcomeSpec.value || outcomeSpec.name || `Outcome_${oi + 1}`
        );

        const branchSteps = Array.isArray(outcomeSpec.steps)
          ? outcomeSpec.steps
          : oi === 0
            ? steps.slice(i + 1)
            : [];

        buildStepsInFlow({
          workflows,
          flow: outcome.flow,
          steps: branchSteps,
          context,
          depth: depth + 1
        });
      }

      return;
    }

    if (step.type === "exclusiveGateway") {
      const activity = createExclusiveGatewayActivity(workflows, flow, step);
      const providedOutcomes = Array.isArray(step.outcomes) ? step.outcomes : [];
      validateBooleanGatewayOutcomes(providedOutcomes, activity.name || step.name || "exclusiveGateway");

      if (providedOutcomes.length === 0) {
        const fallback = createConditionOutcome(workflows, activity, { condition: null });
        const remainder = steps.slice(i + 1);
        buildStepsInFlow({
          workflows,
          flow: fallback.flow,
          steps: remainder,
          context,
          depth: depth + 1
        });
        return;
      }

      for (let oi = 0; oi < providedOutcomes.length; oi++) {
        const outcomeSpec = providedOutcomes[oi] || {};
        const outcome = createConditionOutcome(workflows, activity, outcomeSpec);

        const branchSteps = Array.isArray(outcomeSpec.steps)
          ? outcomeSpec.steps
          : oi === 0
            ? steps.slice(i + 1)
            : [];

        buildStepsInFlow({
          workflows,
          flow: outcome.flow,
          steps: branchSteps,
          context,
          depth: depth + 1
        });
      }

      return;
    }

    throw new Error(`Unsupported workflow DSL step type "${step.type}".`);
  }
}

function normalizeWorkflowSpecs(section = {}) {
  if (Array.isArray(section.specs)) return section.specs;
  if (Array.isArray(section.items)) return section.items;
  return [];
}

function createNormalizedSpecFromDsl(workflowSpec) {
  if (!Array.isArray(workflowSpec.steps)) {
    throw new Error(
      `Workflow "${workflowSpec.name || "<unnamed>"}" has no steps array. ` +
        "In strict deterministic mode a steps array is required."
    );
  }

  return {
    name: workflowSpec.name,
    ref: workflowSpec.ref,
    title: workflowSpec.title,
    description: workflowSpec.description,
    displayName: workflowSpec.displayName,
    bindings: workflowSpec.bindings || {},
    steps: workflowSpec.steps
  };
}

async function applyWorkflowPlanToModel({
  model,
  moduleName = "MyFirstModule",
  workflowsPlan = {},
  deleteExisting = true,
  microflowRefsByRef = {},
  pageRefsByRef = {}
}) {
  const { workflows, settings } = loadModelNamespaces();
  const module = await findModule(model, moduleName);
  if (!module) {
    throw new Error(`Module "${moduleName}" not found for workflow generation.`);
  }

  await ensureWorkflowProjectSettings({ model, settings });

  const specs = normalizeWorkflowSpecs(workflowsPlan);

  const clearExisting = workflowsPlan.clearExisting !== undefined ? workflowsPlan.clearExisting : deleteExisting;
  if (clearExisting) {
    for (const spec of specs) {
      if (spec && spec.name) {
        await deleteWorkflowIfExists(model, moduleName, spec.name);
      }
    }
  }

  const normalizedSpecs = [];
  for (const spec of specs) {
    if (!spec || typeof spec !== "object") continue;
    if (!spec.name || typeof spec.name !== "string") {
      throw new Error("Each workflow spec requires a string name.");
    }
    if (spec.bpmnSourceId || spec.bpmn) {
      throw new Error(
        `Workflow "${spec.name}" includes BPMN fields, but BPMN is out of scope in this phase. Use DSL steps only.`
      );
    }

    normalizedSpecs.push(createNormalizedSpecFromDsl(spec));
  }

  const workflowRefsByRef = {};
  const createdByRef = {};

  for (const spec of normalizedSpecs) {
    const workflow = createWorkflowDocument({ workflows, module, moduleName, spec });
    const qname = workflow.qualifiedName || resolveWorkflowQualifiedName(moduleName, workflow.name);
    if (spec.ref) {
      workflowRefsByRef[spec.ref] = qname;
      createdByRef[spec.ref] = workflow;
    }
  }

  for (const spec of normalizedSpecs) {
    const workflow = spec.ref ? createdByRef[spec.ref] : null;
    const target = workflow || model.findWorkflowByQualifiedName(resolveWorkflowQualifiedName(moduleName, spec.name));
    if (!target) {
      throw new Error(`Could not load workflow "${spec.name}" after creation.`);
    }

    const context = {
      model,
      moduleName,
      microflowRefsByRef,
      pageRefsByRef,
      workflowRefsByRef,
      workflowParameterName:
        (spec.bindings && spec.bindings.contextParameterName) || spec.contextParameterName || "WorkflowContext"
    };

    clearList(target.flow.activities);

    buildStepsInFlow({
      workflows,
      flow: target.flow,
      steps: spec.steps,
      context
    });
  }

  return {
    moduleName,
    workflowsCreated: normalizedSpecs.length,
    workflowNames: normalizedSpecs.map((s) => s.name),
    workflowRefsByRef
  };
}

module.exports = {
  loadSdk,
  loadModelNamespaces,
  applyWorkflowPlanToModel,
  normalizeStepType,
  resolveEntityReference,
  setRawByNameReference,
  validateBooleanGatewayOutcomes,
  normalizeWorkflowUserRoleRefs,
  buildUserTaskAssignmentXPath,
  applyStringTemplate,
  syncServiceTaskParameterMappings,
  createActivityInFlow,
  buildStepsInFlow
};
