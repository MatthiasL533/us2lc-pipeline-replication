const fs = require("fs");
const path = require("path");

const { parseSpecs } = require("./pack-merger");
const { validatePlan } = require("./validation");
const { loadInputBundle, evaluateStoryCoverage } = require("../plan-generator");
const { normalizeNavigationConfig } = require("./navigation-contract");

const PLACEHOLDER_ENTITY_NAMES = new Set(["entity", "data", "item", "record", "thing", "object"]);
const ALLOWED_EXTERNAL_ENTITY_PREFIXES = ["System.", "Administration."];

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isAllowedExternalEntityRef(ref) {
  const value = String(ref || "").trim();
  if (!value) return false;
  return ALLOWED_EXTERNAL_ENTITY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function countPageSteps(steps = []) {
  let count = 0;
  for (const step of safeArray(steps)) {
    if (!step || typeof step !== "object") continue;
    count += 1;
    count += countPageSteps(step.content);
    count += countPageSteps(step.templateContent);
    count += countPageSteps(step.itemContent);
    count += countPageSteps(step.columns);
  }
  return count;
}

function collectPageStepTypes(steps = [], out = new Set()) {
  for (const step of safeArray(steps)) {
    if (!step || typeof step !== "object") continue;
    if (typeof step.type === "string" && step.type.trim()) out.add(step.type.trim());
    collectPageStepTypes(step.content, out);
    collectPageStepTypes(step.templateContent, out);
    collectPageStepTypes(step.itemContent, out);
  }
  return out;
}

function hasUsefulPageContent(page) {
  const types = collectPageStepTypes(page && page.content);
  const useful = [
    "dataView",
    "dataGrid",
    "listView",
    "attributeInput",
    "associationInput",
    "associationSetInput",
    "buttonToPage",
    "createObjectButton",
    "saveChangesButton",
    "widget",
    "filterToolbar"
  ];
  return useful.some((type) => types.has(type));
}

function buildArtifactCounts(plan = {}) {
  return {
    entities: safeArray(plan.domainModel && plan.domainModel.entities).length,
    associations: safeArray(plan.domainModel && plan.domainModel.associations).length,
    enumerations: safeArray(plan.domainModel && plan.domainModel.enumerations).length,
    pages: parseSpecs(plan.pages).length,
    microflows: parseSpecs(plan.microflows).length,
    nanoflows: parseSpecs(plan.nanoflows).length,
    workflows: parseSpecs(plan.workflows).length
  };
}

function checkRequiredSections(plan = {}) {
  const sections = {
    app: Boolean(plan.app && typeof plan.app === "object"),
    appModuleName: Boolean(plan.app && typeof plan.app.moduleName === "string" && plan.app.moduleName.trim()),
    hasBuildSection: Boolean(
      plan.domainModel || plan.security || plan.pages || plan.microflows || plan.nanoflows || plan.workflows
    ),
    navigationContractPresent: true
  };

  const generatedBy = String((plan.meta && plan.meta.generatedBy) || "").trim();
  const planVersion = String((plan.meta && plan.meta.planVersion) || "").trim();
  const shouldRequireNavigation =
    Boolean(plan.pages) &&
    (generatedBy === "pipeline.plan-generator" || /^1\.[1-9]\d*\./.test(planVersion) || /^1\.1\./.test(planVersion));

  if (shouldRequireNavigation) {
    const navigation = normalizeNavigationConfig(plan.app && plan.app.navigation ? plan.app.navigation : {});
    sections.navigationContractPresent = Boolean(
      navigation &&
      Array.isArray(navigation.homePageButtons) &&
      navigation.homePageButtons.length > 0 &&
      Array.isArray(navigation.menuItems) &&
      navigation.menuItems.length > 0
    );
  }

  return sections;
}

function checkReferenceIntegrity(plan = {}) {
  const issues = [];
  const pages = parseSpecs(plan.pages);
  const navigation = normalizeNavigationConfig(plan.app && plan.app.navigation ? plan.app.navigation : {});
  const pageRefs = new Set(
    pages.flatMap((page) => [page && page.ref, page && page.name]).filter((value) => typeof value === "string" && value)
  );
  const entityRefs = new Set(
    safeArray(plan.domainModel && plan.domainModel.entities)
      .map((entity) => String(entity && entity.name || "").trim())
      .filter(Boolean)
      .flatMap((name) => [name, `${plan.app && plan.app.moduleName ? plan.app.moduleName : ""}.${name}`.replace(/^\./, "")])
  );
  const microflowRefs = new Set(
    parseSpecs(plan.microflows)
      .flatMap((mf) => [mf && mf.ref, mf && mf.name])
      .filter((value) => typeof value === "string" && value)
  );
  const workflowRefs = new Set(
    parseSpecs(plan.workflows)
      .flatMap((wf) => [wf && wf.ref, wf && wf.name])
      .filter((value) => typeof value === "string" && value)
  );

  for (const page of pages) {
    if (!page || typeof page !== "object") continue;
    if (page.entityRef && !entityRefs.has(page.entityRef) && !isAllowedExternalEntityRef(page.entityRef)) {
      issues.push(`pages.${page.ref || page.name || "unknown"}.entityRef points to missing entity: ${page.entityRef}`);
    }
    walkPageSteps(page.content, (step) => {
      if (step.pageRef && !pageRefs.has(step.pageRef)) {
        issues.push(`pages.${page.ref || page.name || "unknown"} step pageRef points to missing page: ${step.pageRef}`);
      }
      if (step.targetPageRef && !pageRefs.has(step.targetPageRef)) {
        issues.push(
          `pages.${page.ref || page.name || "unknown"} step targetPageRef points to missing page: ${step.targetPageRef}`
        );
      }
      if (step.rowClickTargetPageRef && !pageRefs.has(step.rowClickTargetPageRef)) {
        issues.push(
          `pages.${page.ref || page.name || "unknown"} step rowClickTargetPageRef points to missing page: ${step.rowClickTargetPageRef}`
        );
      }
      if (step.microflowRef && !microflowRefs.has(step.microflowRef)) {
        issues.push(
          `pages.${page.ref || page.name || "unknown"} step microflowRef points to missing microflow: ${step.microflowRef}`
        );
      }
      if (step.workflowRef && !workflowRefs.has(step.workflowRef)) {
        issues.push(
          `pages.${page.ref || page.name || "unknown"} step workflowRef points to missing workflow: ${step.workflowRef}`
        );
      }
      if (step.entityRef && !entityRefs.has(step.entityRef) && !isAllowedExternalEntityRef(step.entityRef)) {
        issues.push(`pages.${page.ref || page.name || "unknown"} step entityRef points to missing entity: ${step.entityRef}`);
      }
    });
  }

  for (const entry of [...(navigation.homePageButtons || []), ...(navigation.menuItems || [])]) {
    if (!pageRefs.has(entry.pageRef)) {
      issues.push(`app.navigation entry points to missing page: ${entry.pageRef}`);
    }
  }

  return {
    ok: issues.length === 0,
    issueCount: issues.length,
    issues
  };
}

function walkPageSteps(steps = [], visit) {
  for (const step of safeArray(steps)) {
    if (!step || typeof step !== "object") continue;
    visit(step);
    walkPageSteps(step.content, visit);
    walkPageSteps(step.templateContent, visit);
    walkPageSteps(step.itemContent, visit);
  }
}

function checkStubFlags(plan = {}) {
  const flags = [];
  const pages = parseSpecs(plan.pages);
  const entities = safeArray(plan.domainModel && plan.domainModel.entities);
  const counts = buildArtifactCounts(plan);

  if (counts.entities === 0 && counts.pages === 0 && counts.microflows === 0 && counts.workflows === 0) {
    flags.push("plan_has_no_artifacts");
  }

  for (const entity of entities) {
    const name = String(entity && entity.name || "").trim();
    const attrs = safeArray(entity && entity.attributes);
    if (PLACEHOLDER_ENTITY_NAMES.has(name.toLowerCase())) {
      flags.push(`placeholder_entity_name:${name}`);
    }
    if (attrs.length === 0) {
      flags.push(`entity_without_attributes:${name || "unknown"}`);
      continue;
    }
    if (attrs.length === 1 && /^name$/i.test(String(attrs[0] && attrs[0].name || ""))) {
      flags.push(`entity_only_name_attribute:${name || "unknown"}`);
    }
  }

  for (const page of pages) {
    const pageId = page && (page.ref || page.name) || "unknown";
    if (countPageSteps(page && page.content) === 0) {
      flags.push(`page_without_content:${pageId}`);
      continue;
    }
    if (!hasUsefulPageContent(page)) {
      flags.push(`page_without_useful_steps:${pageId}`);
    }
  }

  const workflows = parseSpecs(plan.workflows);
  for (const workflow of workflows) {
    const refs = [];
    collectWorkflowUserRoles(workflow && workflow.steps, refs);
    for (const ref of refs) {
      if (String(ref).trim().toLowerCase() === "user" || String(ref).trim().toLowerCase() === "role") {
        flags.push(`placeholder_workflow_user_role:${workflow && workflow.name ? workflow.name : "unknown"}`);
      }
    }
  }

  return {
    ok: flags.length === 0,
    flags
  };
}

function collectWorkflowUserRoles(steps = [], out = []) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== "object") continue;
    const refs = Array.isArray(step.userRoleRefs)
      ? step.userRoleRefs
      : Array.isArray(step.targetUserRoleRefs)
        ? step.targetUserRoleRefs
        : Array.isArray(step.allowedUserRoles)
          ? step.allowedUserRoles
          : [];
    out.push(...refs);
    for (const outcome of Array.isArray(step.outcomes) ? step.outcomes : []) {
      collectWorkflowUserRoles(outcome && outcome.steps, out);
    }
  }
  return out;
}

function resolveStories({ plan, planPath, inputDir }) {
  const candidateInputDir = inputDir || "";
  if (!candidateInputDir) {
    return { score: null, covered: null, total: null, source: "missing" };
  }

  try {
    const bundle = loadInputBundle(candidateInputDir);
    const coverage = evaluateStoryCoverage(plan, bundle.stories);
    return {
      score: coverage.score,
      covered: coverage.covered,
      total: coverage.total,
      source: "recomputed"
    };
  } catch (_err) {
    return { score: null, covered: null, total: null, source: "missing" };
  }
}

function checkPlanObject(plan, options = {}) {
  const validationErrors = validatePlan(plan);
  const requiredSectionsPresent = checkRequiredSections(plan);
  const referenceIntegrity = checkReferenceIntegrity(plan);
  const stubFlags = checkStubFlags(plan);
  const coverage = resolveStories({ plan, planPath: options.planPath, inputDir: options.inputDir });
  const schemaValid = validationErrors.length === 0;

  return {
    ok: schemaValid && referenceIntegrity.ok && stubFlags.ok,
    jsonParseValid: true,
    schemaValid,
    validationErrors,
    requiredSectionsPresent,
    storyCoverageScore: coverage.score,
    storyCoverageCovered: coverage.covered,
    storyCoverageTotal: coverage.total,
    storyCoverageSource: coverage.source,
    artifactCounts: buildArtifactCounts(plan),
    referenceIntegrity,
    stubFlags
  };
}

function checkPlanFile(planPath, options = {}) {
  try {
    const plan = readJsonFile(planPath);
    return {
      planPath: path.resolve(planPath),
      ...checkPlanObject(plan, { ...options, planPath })
    };
  } catch (err) {
    return {
      ok: false,
      planPath: path.resolve(planPath),
      jsonParseValid: false,
      schemaValid: false,
      validationErrors: [`Invalid JSON: ${err.message}`],
      requiredSectionsPresent: {
        app: false,
        appModuleName: false,
        hasBuildSection: false,
        navigationContractPresent: false
      },
      storyCoverageScore: null,
      storyCoverageCovered: null,
      storyCoverageTotal: null,
      storyCoverageSource: "missing",
      artifactCounts: buildArtifactCounts({}),
      referenceIntegrity: { ok: false, issueCount: 0, issues: [] },
      stubFlags: { ok: false, flags: ["invalid_json"] }
    };
  }
}

module.exports = {
  buildArtifactCounts,
  checkPlanObject,
  checkPlanFile,
  checkReferenceIntegrity,
  checkRequiredSections,
  checkStubFlags
};
