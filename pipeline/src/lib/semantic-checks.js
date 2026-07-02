const { parseSpecs } = require("./pack-merger");

function normalizeEntityRef(rawRef = "", moduleName = "") {
  const raw = String(rawRef || "").trim();
  if (!raw) return "";
  if (raw.includes(".")) return raw;
  return moduleName ? `${moduleName}.${raw}` : raw;
}

function normalizePageParameterSpecs(pageSpec = {}) {
  if (Array.isArray(pageSpec.pageParameters)) return pageSpec.pageParameters;
  if (Array.isArray(pageSpec.parameters)) return pageSpec.parameters;
  if (pageSpec.parameterEntityRef || pageSpec.pageParameterEntityRef || pageSpec.contextEntityRef) {
    return [
      {
        name: pageSpec.parameterName || "",
        entityRef: pageSpec.parameterEntityRef || pageSpec.pageParameterEntityRef || pageSpec.contextEntityRef || "",
        required: pageSpec.parameterRequired !== false
      }
    ];
  }
  return [];
}

function collectRequiredPageParameterEntities(pageSpec = {}, moduleName = "") {
  const params = normalizePageParameterSpecs(pageSpec);
  const entities = [];
  for (const param of params) {
    const isRequired = param.required !== false;
    if (!isRequired) continue;
    const entity = normalizeEntityRef(param.entityRef || param.entity || "", moduleName);
    if (entity) entities.push(entity);
  }
  return [...new Set(entities)];
}

function pageHasWorkflowUserTaskParameter(pageSpec = {}, moduleName = "") {
  const params = normalizePageParameterSpecs(pageSpec);
  for (const param of params) {
    const entity = normalizeEntityRef(param.entityRef || param.entity || "", moduleName);
    if (entity === "System.WorkflowUserTask") return true;
  }
  return false;
}

function collectStepChildren(step = {}) {
  const children = [];
  if (Array.isArray(step.content)) {
    children.push(...step.content);
  }
  if (Array.isArray(step.templateContent)) {
    children.push(...step.templateContent);
  }
  if (Array.isArray(step.itemContent)) {
    children.push(...step.itemContent);
  }
  return children;
}

function walkPageSteps(steps = [], visit, pathParts = []) {
  const source = Array.isArray(steps) ? steps : [];
  for (let i = 0; i < source.length; i++) {
    const step = source[i] || {};
    const label = `${String(step.type || "step")}[${i}]`;
    const path = [...pathParts, label];
    visit(step, path);
    const children = collectStepChildren(step);
    if (children.length > 0) {
      walkPageSteps(children, visit, path);
    }
  }
}

function hasAssociationLookupSteps(pagesSection = {}) {
  const pageSpecs = parseSpecs(pagesSection);
  const lookupTypes = new Set(["associationinput", "associationsetinput", "referenceselector", "referencesetselector"]);

  for (const page of pageSpecs) {
    if (!page || typeof page !== "object") continue;
    let found = false;
    walkPageSteps(page.content || [], (step) => {
      const type = String(step && step.type ? step.type : "").trim().toLowerCase();
      if (lookupTypes.has(type)) {
        found = true;
      }
    });
    if (found) return true;
  }

  return false;
}

function buildWorkflowContextMap(plan, moduleName) {
  const out = {};
  for (const spec of parseSpecs(plan.workflows)) {
    if (!spec || typeof spec !== "object") continue;
    const ctx =
      (spec.bindings && spec.bindings.contextEntityRef) ||
      spec.contextEntityRef ||
      spec.parameterEntityRef ||
      "";
    const normalized = normalizeEntityRef(ctx, moduleName);
    if (!normalized) continue;

    if (spec.ref) out[String(spec.ref)] = normalized;
    if (spec.name) {
      out[String(spec.name)] = normalized;
      out[`${moduleName}.${spec.name}`] = normalized;
    }
  }
  return out;
}

function findPageSpecByToken(pageSpecs = [], token = "") {
  const raw = String(token || "").trim();
  if (!raw) return null;
  for (const page of pageSpecs) {
    if (!page || typeof page !== "object") continue;
    if (page.ref === raw || page.name === raw) return page;
    if (raw.includes(".") && page.name && raw.split(".").pop() === page.name) return page;
  }
  return null;
}

function collectWorkflowStepsRecursively(steps = [], out = []) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== "object") continue;
    out.push(step);
    const outcomes = Array.isArray(step.outcomes) ? step.outcomes : [];
    for (const outcome of outcomes) {
      const branchSteps = Array.isArray(outcome && outcome.steps) ? outcome.steps : [];
      collectWorkflowStepsRecursively(branchSteps, out);
    }
  }
  return out;
}

function deriveDataViewContextEntity(step, pageSpec, moduleName) {
  const direct = normalizeEntityRef(step.entityRef || step.entity || "", moduleName);
  if (direct) return direct;

  const pageParamName = String(step.pageParameterName || pageSpec.pageParameterName || "").trim();
  if (!pageParamName) return "";
  const params = normalizePageParameterSpecs(pageSpec);
  const match = params.find((p) => String(p.name || "").trim() === pageParamName);
  return normalizeEntityRef((match && (match.entityRef || match.entity)) || "", moduleName);
}

function collectWorkflowContextViolationsForPage({
  pageSpec,
  moduleName,
  workflowContextByToken
}) {
  const violations = [];

  function walkWithContext(steps, currentContext, pathParts, insideDataContainer = false) {
    const source = Array.isArray(steps) ? steps : [];
    for (let i = 0; i < source.length; i++) {
      const step = source[i] || {};
      const label = `${String(step.type || "step")}[${i}]`;
      const path = [...pathParts, label];
      let nextContext = currentContext;
      let nextInsideDataContainer = insideDataContainer;

      if (step.type === "dataView") {
        const contextFromDataView = deriveDataViewContextEntity(step, pageSpec, moduleName);
        if (contextFromDataView) {
          nextContext = contextFromDataView;
        }
        nextInsideDataContainer = true;
      }

      if (step.type === "listView" || step.type === "dataGrid") {
        const contextFromCollection = normalizeEntityRef(step.entityRef || step.entity || "", moduleName);
        if (contextFromCollection) {
          nextContext = contextFromCollection;
        }
        nextInsideDataContainer = true;
      }

      if (step.type === "callWorkflowButton") {
        const token = step.workflowRef || step.workflowQualifiedName || step.workflow || step.target || "";
        const expected =
          workflowContextByToken[token] ||
          workflowContextByToken[normalizeEntityRef(token, moduleName)] ||
          null;
        if (expected) {
          if (!nextContext) {
            violations.push(
              `Page "${pageSpec.name}" has callWorkflowButton at ${path.join(" > ")} with no data context; expected "${expected}".`
            );
          } else if (normalizeEntityRef(nextContext, moduleName) !== expected) {
            violations.push(
              `Page "${pageSpec.name}" has callWorkflowButton at ${path.join(
                " > "
              )} with context "${nextContext}", expected "${expected}".`
            );
          }
        }
      }

      if (step.type === "showUserTaskPageButton" || step.type === "setTaskOutcomeButton") {
        const expected = "System.WorkflowUserTask";
        if (!nextInsideDataContainer) {
          violations.push(
            `Page "${pageSpec.name}" has ${step.type} at ${path.join(
              " > "
            )} outside a data container; expected "${expected}" context.`
          );
        } else if (normalizeEntityRef(nextContext, moduleName) !== expected) {
          violations.push(
            `Page "${pageSpec.name}" has ${step.type} at ${path.join(
              " > "
            )} with context "${nextContext}", expected "${expected}".`
          );
        }
      }

      const children = collectStepChildren(step);
      if (children.length > 0) {
        walkWithContext(children, nextContext, path, nextInsideDataContainer);
      }
    }
  }

  const rootContext =
    normalizeEntityRef(pageSpec.entityRef || pageSpec.entity || "", moduleName) ||
    collectRequiredPageParameterEntities(pageSpec, moduleName)[0] ||
    "";

  walkWithContext(pageSpec.content || [], rootContext, [pageSpec.name || "Page"]);
  return violations;
}

function runGeneratedModuleSemanticChecks({ plan, moduleName }) {
  const verification = (plan && plan.verification) || {};
  const semanticChecks = verification.semanticChecks || {};
  const ciMode = process.env.CI === "1" || String(process.env.CI || "").toLowerCase() === "true";
  const enabled = {
    uniqueWidgetNames: semanticChecks.uniqueWidgetNames === true || (ciMode && semanticChecks.uniqueWidgetNames !== false),
    pageParameterCompatibility:
      semanticChecks.pageParameterCompatibility === true || (ciMode && semanticChecks.pageParameterCompatibility !== false),
    workflowBindings: semanticChecks.workflowBindings === true || (ciMode && semanticChecks.workflowBindings !== false),
    securitySystemRoles:
      semanticChecks.securitySystemRoles === true || (ciMode && semanticChecks.securitySystemRoles !== false)
  };

  if (
    !enabled.uniqueWidgetNames &&
    !enabled.pageParameterCompatibility &&
    !enabled.workflowBindings &&
    !enabled.securitySystemRoles
  ) {
    return {
      enabled: false,
      ok: true,
      errors: []
    };
  }

  const errors = [];
  const pages = parseSpecs(plan.pages);
  const workflows = parseSpecs(plan.workflows);

  if (enabled.uniqueWidgetNames) {
    for (const page of pages) {
      if (!page || typeof page !== "object") continue;
      const seen = new Set();
      walkPageSteps(page.content || [], (step, pathParts) => {
        const name = String(step.name || "").trim();
        if (!name) return;
        if (seen.has(name)) {
          errors.push(`Page "${page.name}" has duplicate widget name "${name}" at ${pathParts.join(" > ")}.`);
        } else {
          seen.add(name);
        }
      });
    }
  }

  if (enabled.pageParameterCompatibility) {
    for (const page of pages) {
      if (!page || typeof page !== "object") continue;
      const sourceEntity = normalizeEntityRef(page.entityRef || page.entity || "", moduleName);
      walkPageSteps(page.content || [], (step, pathParts) => {
        if (step.type === "createObjectButton" && step.targetPageRef) {
          const target = findPageSpecByToken(pages, step.targetPageRef);
          if (!target) return;
          const required = collectRequiredPageParameterEntities(target, moduleName);
          if (required.length > 1) {
            errors.push(
              `createObjectButton at ${pathParts.join(" > ")} targets page "${target.name}" with multiple required parameters.`
            );
            return;
          }
          if (required.length === 1) {
            const createEntity = normalizeEntityRef(step.entityRef || sourceEntity, moduleName);
            if (createEntity && createEntity !== required[0]) {
              errors.push(
                `createObjectButton at ${pathParts.join(" > ")} creates "${createEntity}" but target page "${
                  target.name
                }" requires "${required[0]}".`
              );
            }
          }
        }

        if (step.type === "dataGrid" && step.rowClickTargetPageRef) {
          const target = findPageSpecByToken(pages, step.rowClickTargetPageRef);
          if (!target) return;
          const required = collectRequiredPageParameterEntities(target, moduleName);
          if (required.length > 1) {
            errors.push(
              `dataGrid rowClick at ${pathParts.join(" > ")} targets page "${target.name}" with multiple required parameters.`
            );
            return;
          }
          if (required.length === 1) {
            const gridEntity = normalizeEntityRef(step.entityRef || sourceEntity, moduleName);
            if (gridEntity && gridEntity !== required[0]) {
              errors.push(
                `dataGrid rowClick at ${pathParts.join(" > ")} uses entity "${gridEntity}" but target page "${
                  target.name
                }" requires "${required[0]}".`
              );
            }
          }
        }
      });
    }
  }

  if (enabled.workflowBindings) {
    const workflowContextByToken = buildWorkflowContextMap(plan, moduleName);

    for (const workflow of workflows) {
      if (!workflow || typeof workflow !== "object") continue;
      const allSteps = collectWorkflowStepsRecursively(workflow.steps || []);
      for (const step of allSteps) {
        if (String(step.type || "").trim().toLowerCase() !== "usertask") continue;
        const pageToken = step.taskPageRef || step.taskPageQualifiedName || step.pageRef || step.pageQualifiedName || "";
        if (!pageToken) continue;
        const page = findPageSpecByToken(pages, pageToken);
        if (!page) continue;
        if (!pageHasWorkflowUserTaskParameter(page, moduleName)) {
          errors.push(
            `Workflow "${workflow.name}" userTask "${step.name || "<unnamed>"}" targets page "${
              page.name
            }" without a System.WorkflowUserTask page parameter.`
          );
        }
      }
    }

    for (const page of pages) {
      if (!page || typeof page !== "object") continue;
      const contextViolations = collectWorkflowContextViolationsForPage({
        pageSpec: page,
        moduleName,
        workflowContextByToken
      });
      errors.push(...contextViolations);
    }
  }

  return {
    enabled: true,
    ok: errors.length === 0,
    errors
  };
}

module.exports = {
  normalizeEntityRef,
  normalizePageParameterSpecs,
  collectRequiredPageParameterEntities,
  pageHasWorkflowUserTaskParameter,
  collectStepChildren,
  walkPageSteps,
  hasAssociationLookupSteps,
  buildWorkflowContextMap,
  findPageSpecByToken,
  collectWorkflowStepsRecursively,
  deriveDataViewContextEntity,
  collectWorkflowContextViolationsForPage,
  runGeneratedModuleSemanticChecks
};
