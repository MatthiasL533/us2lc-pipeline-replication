const path = require("path");
const { loadPlanFile } = require("./plan-loader");

function parseSpecs(section = {}) {
  if (Array.isArray(section.specs)) return section.specs;
  if (Array.isArray(section.items)) return section.items;
  return [];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeArray(a, b) {
  return [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
}

function mergeSpecSection(base = {}, extra = {}) {
  const out = { ...(base || {}) };
  if (out.clearExisting === undefined && extra.clearExisting !== undefined) {
    out.clearExisting = extra.clearExisting;
  }

  const mergedSpecs = mergeArray(parseSpecs(base), parseSpecs(extra));
  if (mergedSpecs.length > 0) {
    out.specs = mergedSpecs;
  }

  return out;
}

function mergeDomainModel(base = {}, extra = {}) {
  const out = { ...(base || {}) };

  if (out.clearExisting === undefined && extra.clearExisting !== undefined) {
    out.clearExisting = extra.clearExisting;
  }
  if (out.clearExistingEnumerations === undefined && extra.clearExistingEnumerations !== undefined) {
    out.clearExistingEnumerations = extra.clearExistingEnumerations;
  }

  out.entities = mergeArray(base.entities, extra.entities);
  out.associations = mergeArray(base.associations, extra.associations);
  out.enumerations = mergeArray(base.enumerations, extra.enumerations);

  return out;
}

function mergePersonas(base = {}, extra = {}) {
  const out = { ...(base || {}) };
  if (out.enabled === undefined && extra.enabled !== undefined) {
    out.enabled = extra.enabled;
  }
  out.specs = mergeArray(base.specs, extra.specs);
  return out;
}

function mergePlanWithPack(basePlan = {}, packPlan = {}) {
  const merged = cloneJson(basePlan);

  if (packPlan.domainModel) {
    merged.domainModel = mergeDomainModel(merged.domainModel || {}, packPlan.domainModel || {});
  }

  if (packPlan.microflows) {
    merged.microflows = mergeSpecSection(merged.microflows || {}, packPlan.microflows || {});
  }

  if (packPlan.nanoflows) {
    merged.nanoflows = mergeSpecSection(merged.nanoflows || {}, packPlan.nanoflows || {});
  }

  if (packPlan.workflows) {
    merged.workflows = mergeSpecSection(merged.workflows || {}, packPlan.workflows || {});
  }

  if (packPlan.pages) {
    merged.pages = mergeSpecSection(merged.pages || {}, packPlan.pages || {});
  }

  if (packPlan.personas) {
    merged.personas = mergePersonas(merged.personas || {}, packPlan.personas || {});
  }

  if (packPlan.verification) {
    merged.verification = {
      ...(merged.verification || {}),
      ...(packPlan.verification || {})
    };
  }

  return merged;
}

function normalizePackRefs(plan) {
  if (!plan || !plan.packs) return [];

  if (Array.isArray(plan.packs)) {
    return plan.packs.filter((x) => typeof x === "string" && x.length > 0);
  }

  if (plan.packs && typeof plan.packs === "object") {
    if (Array.isArray(plan.packs.refs)) {
      return plan.packs.refs.filter((x) => typeof x === "string" && x.length > 0);
    }
  }

  return [];
}

function applyPackRefs(plan, options = {}) {
  const base = cloneJson(plan || {});
  const planDirectory = options.planDirectory || process.cwd();
  const refs = normalizePackRefs(base);

  if (refs.length === 0) {
    return {
      plan: base,
      appliedPackPaths: []
    };
  }

  let merged = base;
  const appliedPackPaths = [];

  for (const ref of refs) {
    const abs = path.isAbsolute(ref) ? ref : path.resolve(planDirectory, ref);
    const pack = loadPlanFile(abs);
    merged = mergePlanWithPack(merged, pack);
    appliedPackPaths.push(abs);
  }

  return {
    plan: merged,
    appliedPackPaths
  };
}

module.exports = {
  parseSpecs,
  cloneJson,
  mergeArray,
  mergeSpecSection,
  mergeDomainModel,
  mergePersonas,
  mergePlanWithPack,
  normalizePackRefs,
  applyPackRefs
};
