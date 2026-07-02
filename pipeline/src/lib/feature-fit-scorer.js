const fs = require("fs");
const path = require("path");

const { parseSpecs } = require("./pack-merger");
const { checkPlanObject } = require("./plan-checker");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toSet(values) {
  return new Set(
    safeArray(values)
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
}

function matchRate(required = [], availableSet) {
  const requested = safeArray(required);
  if (requested.length === 0) return 1;
  let matched = 0;
  for (const item of requested) {
    if (availableSet.has(String(item))) matched += 1;
  }
  return matched / requested.length;
}

function collectPlanSignals(plan = {}) {
  const entities = safeArray(plan.domainModel && plan.domainModel.entities).map((entity) => String(entity.name || "").trim());
  const associations = safeArray(plan.domainModel && plan.domainModel.associations).map((assoc) => ({
    name: String(assoc.name || "").trim(),
    parentEntity: String(assoc.parentEntity || "").trim(),
    childEntity: String(assoc.childEntity || "").trim()
  }));
  const pages = parseSpecs(plan.pages).map((page) => ({
    ref: String(page.ref || page.name || "").trim(),
    name: String(page.name || "").trim(),
    entityRef: String(page.entityRef || "").trim()
  }));
  const entitySet = toSet(entities);
  const pageRefSet = toSet(pages.map((page) => page.ref).filter(Boolean));
  const pageNameSet = toSet(pages.map((page) => page.name).filter(Boolean));
  const combinedPageSet = new Set([...pageRefSet, ...pageNameSet]);
  const nav = plan.app && plan.app.navigation ? plan.app.navigation : {};

  return {
    entities,
    entitySet,
    associations,
    associationTriples: new Set(
      associations.map((assoc) => [assoc.parentEntity, assoc.childEntity, assoc.name].join("->"))
    ),
    pages,
    pageSet: combinedPageSet,
    homePageButtonRefs: toSet(nav.homePageButtonRefs),
    navigationItemRefs: toSet(nav.navigationItemRefs),
    microflowCount: parseSpecs(plan.microflows).length,
    workflowCount: parseSpecs(plan.workflows).length,
    nanoflowCount: parseSpecs(plan.nanoflows).length
  };
}

function evaluateRequiredAssociations(required = [], associationTriples) {
  const matched = [];
  const missing = [];
  for (const assoc of safeArray(required)) {
    const triple = [assoc.parentEntity || "", assoc.childEntity || "", assoc.name || ""].join("->");
    if (associationTriples.has(triple)) matched.push(triple);
    else missing.push(triple);
  }
  return {
    matched,
    missing,
    score: required.length > 0 ? matched.length / required.length : 1
  };
}

function weightedAverage(items) {
  let totalWeight = 0;
  let totalScore = 0;
  for (const item of items) {
    totalWeight += item.weight;
    totalScore += item.score * item.weight;
  }
  if (totalWeight <= 0) return 0;
  return totalScore / totalWeight;
}

function buildDetailPageRefCandidates(entity) {
  const base = String(entity || "").toLowerCase();
  return [`${base}_detail`, `${base}_newedit`];
}

function scorePlanAgainstRubric(plan, rubric, options = {}) {
  const checker = options.checker || checkPlanObject(plan, { inputDir: options.inputDir || "" });
  const signals = collectPlanSignals(plan);
  const domain = rubric.domain || {};
  const relationships = rubric.relationships || {};
  const pages = rubric.pages || {};
  const navigation = rubric.navigation || {};
  const constraints = rubric.constraints || {};
  const weights = {
    domain: 0.35,
    relationships: 0.2,
    pages: 0.25,
    navigation: 0.1,
    mendixSuitability: 0.1,
    ...(rubric.weights || {})
  };

  const requiredEntities = safeArray(domain.requiredEntities).map(String);
  const preferredEntities = safeArray(domain.preferredEntities).map(String);
  const forbiddenEntities = safeArray(domain.forbiddenEntities).map(String);
  const allowedEntities = safeArray(domain.allowedEntities).map(String);
  const requiredPageRefs = safeArray(pages.requiredPageRefs).map(String);
  const requiredOverviewEntities = safeArray(pages.requiredOverviewEntities).map(String);
  const requiredDetailEntities = safeArray(pages.requiredDetailEntities).map(String);
  const requiredHomePageButtonRefs = safeArray(navigation.requiredHomePageButtonRefs).map(String);
  const requiredNavigationItemRefs = safeArray(navigation.requiredNavigationItemRefs).map(String);

  const requiredEntityRate = matchRate(requiredEntities, signals.entitySet);
  const preferredEntityRate = preferredEntities.length > 0 ? matchRate(preferredEntities, signals.entitySet) : 1;
  const forbiddenEntityHits = forbiddenEntities.filter((entity) => signals.entitySet.has(entity));
  const allowedUnexpectedEntities = allowedEntities.length > 0
    ? signals.entities.filter((entity) => !allowedEntities.includes(entity))
    : [];
  const domainPenalty = Math.min(1, (forbiddenEntityHits.length + allowedUnexpectedEntities.length) / Math.max(1, signals.entities.length));
  const domainFitScore = Math.max(0, requiredEntityRate * 0.75 + preferredEntityRate * 0.25 - domainPenalty * 0.5);

  const assocResult = evaluateRequiredAssociations(relationships.requiredAssociations || [], signals.associationTriples);
  const relationshipFitScore = assocResult.score;

  const requiredPageRate = matchRate(requiredPageRefs, signals.pageSet);
  const overviewRefs = requiredOverviewEntities.map((entity) => `${String(entity).toLowerCase()}_overview`);
  const detailRefs = requiredDetailEntities.flatMap((entity) => buildDetailPageRefCandidates(entity));
  const overviewRate = overviewRefs.length > 0 ? matchRate(overviewRefs, signals.pageSet) : 1;
  const detailRate = requiredDetailEntities.length > 0
    ? requiredDetailEntities.filter((entity) => {
      const candidates = buildDetailPageRefCandidates(entity);
      return candidates.some((ref) => signals.pageSet.has(ref));
    }).length / requiredDetailEntities.length
    : 1;
  const pageTaskFitScore = weightedAverage([
    { score: requiredPageRate, weight: 0.4 },
    { score: overviewRate, weight: 0.3 },
    { score: detailRate, weight: 0.3 }
  ]);

  const navigationFitScore = weightedAverage([
    {
      score: matchRate(requiredHomePageButtonRefs, signals.homePageButtonRefs),
      weight: 0.5
    },
    {
      score: matchRate(requiredNavigationItemRefs, signals.navigationItemRefs),
      weight: 0.5
    }
  ]);

  const suitabilityPenalties = [];
  if (constraints.forbidWorkflows !== false && signals.workflowCount > 0) {
    suitabilityPenalties.push(`workflow_count:${signals.workflowCount}`);
  }
  if (constraints.forbidMicroflows === true && signals.microflowCount > 0) {
    suitabilityPenalties.push(`microflow_count:${signals.microflowCount}`);
  }
  if (constraints.forbidNanoflows === true && signals.nanoflowCount > 0) {
    suitabilityPenalties.push(`nanoflow_count:${signals.nanoflowCount}`);
  }
  if (checker.stubFlags && Array.isArray(checker.stubFlags.flags)) {
    suitabilityPenalties.push(...checker.stubFlags.flags.map((flag) => `stub:${flag}`));
  }
  if (checker.referenceIntegrity && Array.isArray(checker.referenceIntegrity.issues)) {
    suitabilityPenalties.push(...checker.referenceIntegrity.issues.map((issue) => `ref:${issue}`));
  }
  const suitabilityPenaltyFactor = Math.min(1, suitabilityPenalties.length / 10);
  const mendixSuitabilityScore = Math.max(0, 1 - suitabilityPenaltyFactor);

  const featureFitScore = weightedAverage([
    { score: domainFitScore, weight: weights.domain },
    { score: relationshipFitScore, weight: weights.relationships },
    { score: pageTaskFitScore, weight: weights.pages },
    { score: navigationFitScore, weight: weights.navigation },
    { score: mendixSuitabilityScore, weight: weights.mendixSuitability }
  ]);

  const matchedRequirements = {
    requiredEntities: requiredEntities.filter((entity) => signals.entitySet.has(entity)),
    preferredEntities: preferredEntities.filter((entity) => signals.entitySet.has(entity)),
    requiredAssociations: assocResult.matched,
    requiredPageRefs: requiredPageRefs.filter((ref) => signals.pageSet.has(ref)),
    requiredHomePageButtonRefs: requiredHomePageButtonRefs.filter((ref) => signals.homePageButtonRefs.has(ref)),
    requiredNavigationItemRefs: requiredNavigationItemRefs.filter((ref) => signals.navigationItemRefs.has(ref))
  };

  const missingRequirements = {
    requiredEntities: requiredEntities.filter((entity) => !signals.entitySet.has(entity)),
    requiredAssociations: assocResult.missing,
    requiredPageRefs: requiredPageRefs.filter((ref) => !signals.pageSet.has(ref)),
    requiredOverviewPageRefs: overviewRefs.filter((ref) => !signals.pageSet.has(ref)),
    requiredDetailPageRefs: requiredDetailEntities.filter((entity) => {
      const candidates = buildDetailPageRefCandidates(entity);
      return !candidates.some((ref) => signals.pageSet.has(ref));
    }).flatMap((entity) => buildDetailPageRefCandidates(entity)),
    requiredHomePageButtonRefs: requiredHomePageButtonRefs.filter((ref) => !signals.homePageButtonRefs.has(ref)),
    requiredNavigationItemRefs: requiredNavigationItemRefs.filter((ref) => !signals.navigationItemRefs.has(ref))
  };

  const unexpectedArtifacts = {
    forbiddenEntitiesPresent: forbiddenEntityHits,
    entitiesOutsideAllowedSet: allowedUnexpectedEntities,
    suitabilityPenalties
  };

  return {
    ok: true,
    rubricId: rubric.id || "",
    rubricTitle: rubric.title || "",
    builderScope: rubric.builderScope || {},
    featureFitScore,
    domainFitScore,
    relationshipFitScore,
    pageTaskFitScore,
    navigationFitScore,
    mendixSuitabilityScore,
    matchedRequirements,
    missingRequirements,
    unexpectedArtifacts
  };
}

function scorePlanFileAgainstRubric({ planPath, rubricPath, inputDir = "" }) {
  const plan = readJson(planPath);
  const rubric = readJson(rubricPath);
  const checker = checkPlanObject(plan, { planPath, inputDir });
  return scorePlanAgainstRubric(plan, rubric, { checker, inputDir });
}

module.exports = {
  collectPlanSignals,
  scorePlanAgainstRubric,
  scorePlanFileAgainstRubric
};
