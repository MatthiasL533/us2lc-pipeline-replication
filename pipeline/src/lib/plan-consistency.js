const crypto = require("crypto");

const { parseSpecs } = require("./pack-merger");
const { buildArtifactCounts } = require("./plan-checker");

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableClone(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableClone(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "generatedAt" || key === "startedAt" || key === "finishedAt") continue;
    out[key] = stableClone(value[key]);
  }
  return out;
}

function normalizeNamedArray(items = [], sortFn) {
  return safeArray(items)
    .map((item) => stableClone(item))
    .sort(sortFn);
}

function normalizePlan(plan = {}) {
  const out = stableClone(plan);

  if (out.meta && typeof out.meta === "object") {
    delete out.meta.generatedAt;
    delete out.meta.startedAt;
    delete out.meta.finishedAt;
  }

  if (out.domainModel && typeof out.domainModel === "object") {
    out.domainModel.entities = normalizeNamedArray(out.domainModel.entities, (a, b) =>
      String(a && a.name || "").localeCompare(String(b && b.name || ""))
    );
    out.domainModel.associations = normalizeNamedArray(out.domainModel.associations, (a, b) =>
      `${a && a.parentEntity || ""}:${a && a.childEntity || ""}:${a && a.name || ""}`.localeCompare(
        `${b && b.parentEntity || ""}:${b && b.childEntity || ""}:${b && b.name || ""}`
      )
    );
    out.domainModel.enumerations = normalizeNamedArray(out.domainModel.enumerations, (a, b) =>
      String(a && a.name || "").localeCompare(String(b && b.name || ""))
    );
  }

  for (const key of ["pages", "microflows", "nanoflows", "workflows"]) {
    if (out[key] && typeof out[key] === "object" && Array.isArray(out[key].specs)) {
      out[key].specs = normalizeNamedArray(out[key].specs, (a, b) =>
        String(a && (a.ref || a.name) || "").localeCompare(String(b && (b.ref || b.name) || ""))
      );
    }
  }

  return out;
}

function fingerprint(value) {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

function toSet(values) {
  return new Set(values.filter(Boolean));
}

function jaccard(a, b) {
  const setA = a instanceof Set ? a : toSet(a);
  const setB = b instanceof Set ? b : toSet(b);
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of setA) {
    if (setB.has(value)) intersection += 1;
  }
  return intersection / union.size;
}

function collectPageStepTypes(steps = [], out = []) {
  for (const step of safeArray(steps)) {
    if (!step || typeof step !== "object") continue;
    if (step.type) out.push(String(step.type));
    collectPageStepTypes(step.content, out);
    collectPageStepTypes(step.templateContent, out);
    collectPageStepTypes(step.itemContent, out);
  }
  return out;
}

function buildShape(plan = {}) {
  const normalized = normalizePlan(plan);
  const entities = safeArray(normalized.domainModel && normalized.domainModel.entities).map((entity) => entity.name);
  const associations = safeArray(normalized.domainModel && normalized.domainModel.associations).map((assoc) =>
    [assoc.parentEntity, assoc.childEntity, assoc.name].join("->")
  );
  const pages = parseSpecs(normalized.pages).map((page) => page.ref || page.name);
  const workflows = parseSpecs(normalized.workflows).map((wf) => wf.ref || wf.name);
  const microflows = parseSpecs(normalized.microflows).map((mf) => mf.ref || mf.name);
  const pageStepTypes = parseSpecs(normalized.pages).flatMap((page) => collectPageStepTypes(page && page.content));

  return {
    canonicalPlan: normalized,
    canonicalFingerprint: fingerprint(normalized),
    domainFingerprint: fingerprint({
      entities: safeArray(normalized.domainModel && normalized.domainModel.entities),
      associations: safeArray(normalized.domainModel && normalized.domainModel.associations),
      enumerations: safeArray(normalized.domainModel && normalized.domainModel.enumerations)
    }),
    pageFingerprint: fingerprint(parseSpecs(normalized.pages)),
    flowFingerprint: fingerprint({
      microflows: parseSpecs(normalized.microflows),
      nanoflows: parseSpecs(normalized.nanoflows),
      workflows: parseSpecs(normalized.workflows)
    }),
    entityNames: toSet(entities),
    associationNames: toSet(associations),
    pageNames: toSet(pages),
    pageStepTypes: toSet(pageStepTypes),
    artifactCounts: buildArtifactCounts(plan)
  };
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values) {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
}

function analyzePlanConsistency(runs = [], options = {}) {
  const validRuns = runs.filter((run) => run && run.plan && run.checker && run.checker.jsonParseValid);
  const shapes = validRuns.map((run) => ({
    runId: run.runId,
    ...buildShape(run.plan)
  }));

  if (shapes.length === 0) {
    return {
      ok: false,
      model: options.model || "",
      runCount: 0,
      exactMatchRate: 0,
      entityNameOverlapMean: 0,
      associationOverlapMean: 0,
      pageOverlapMean: 0,
      pageStepTypeOverlapMean: 0,
      artifactCountVariance: {},
      consistencyScore: 0,
      fingerprints: {
        canonical: [],
        domain: [],
        pages: [],
        flows: []
      }
    };
  }

  const pairwise = [];
  for (let i = 0; i < shapes.length; i += 1) {
    for (let j = i + 1; j < shapes.length; j += 1) {
      const left = shapes[i];
      const right = shapes[j];
      pairwise.push({
        exactMatch: left.canonicalFingerprint === right.canonicalFingerprint ? 1 : 0,
        entityOverlap: jaccard(left.entityNames, right.entityNames),
        associationOverlap: jaccard(left.associationNames, right.associationNames),
        pageOverlap: jaccard(left.pageNames, right.pageNames),
        pageStepTypeOverlap: jaccard(left.pageStepTypes, right.pageStepTypes)
      });
    }
  }

  const exactMatchRate =
    pairwise.length > 0
      ? mean(pairwise.map((entry) => entry.exactMatch))
      : 1;
  const entityNameOverlapMean = pairwise.length > 0 ? mean(pairwise.map((entry) => entry.entityOverlap)) : 1;
  const associationOverlapMean = pairwise.length > 0 ? mean(pairwise.map((entry) => entry.associationOverlap)) : 1;
  const pageOverlapMean = pairwise.length > 0 ? mean(pairwise.map((entry) => entry.pageOverlap)) : 1;
  const pageStepTypeOverlapMean = pairwise.length > 0 ? mean(pairwise.map((entry) => entry.pageStepTypeOverlap)) : 1;

  const countKeys = ["entities", "associations", "enumerations", "pages", "microflows", "nanoflows", "workflows"];
  const artifactCountVariance = {};
  for (const key of countKeys) {
    artifactCountVariance[key] = variance(shapes.map((shape) => Number(shape.artifactCounts[key] || 0)));
  }

  const consistencyScore = Number(
    (
      exactMatchRate * 0.4 +
      entityNameOverlapMean * 0.2 +
      associationOverlapMean * 0.15 +
      pageOverlapMean * 0.15 +
      pageStepTypeOverlapMean * 0.1
    ).toFixed(4)
  );

  return {
    ok: true,
    model: options.model || "",
    runCount: shapes.length,
    exactMatchRate,
    entityNameOverlapMean,
    associationOverlapMean,
    pageOverlapMean,
    pageStepTypeOverlapMean,
    artifactCountVariance,
    consistencyScore,
    fingerprints: {
      canonical: shapes.map((shape) => shape.canonicalFingerprint),
      domain: shapes.map((shape) => shape.domainFingerprint),
      pages: shapes.map((shape) => shape.pageFingerprint),
      flows: shapes.map((shape) => shape.flowFingerprint)
    }
  };
}

module.exports = {
  analyzePlanConsistency,
  buildShape,
  fingerprint,
  jaccard,
  normalizePlan
};
