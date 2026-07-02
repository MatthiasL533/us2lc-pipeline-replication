const COMMON_PROPERTIES = new Set(["type", "name", "autoName", "props", "createMethod"]);

const STEP_ALIASES = {
  referenceSelector: "associationInput",
  referenceSetSelector: "associationSetInput"
};

function normalizeStepType(rawType = "") {
  const raw = String(rawType || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  return STEP_ALIASES[lower] || raw;
}

function buildStepHandlerRegistry(stepDefinitions = []) {
  const registry = {};
  for (const def of stepDefinitions) {
    if (!def || typeof def !== "object" || !def.type) continue;
    registry[String(def.type)] = {
      type: String(def.type),
      acceptedProperties: new Set([...(def.acceptedProperties || []), ...COMMON_PROPERTIES]),
      requiredContext: Array.isArray(def.requiredContext) ? def.requiredContext : [],
      failureMessage: def.failureMessage || `Invalid step configuration for "${def.type}".`
    };
  }
  return registry;
}

function validateStepSpecAgainstRegistry({ step, entry, context = {} }) {
  if (!entry) {
    return {
      ok: false,
      message: `Unsupported content step type "${step && step.type ? step.type : ""}".`
    };
  }

  for (const contextKey of entry.requiredContext) {
    if (context[contextKey] === undefined || context[contextKey] === null) {
      return {
        ok: true,
        message: "",
        warnings: [`${entry.failureMessage} Missing context: ${contextKey}.`]
      };
    }
  }

  const unknown = Object.keys(step || {}).filter((key) => !entry.acceptedProperties.has(key));
  if (unknown.length > 0) {
    return {
      ok: true,
      message: "",
      warnings: [`Ignored unrecognized properties for "${entry.type}": ${unknown.join(", ")}.`]
    };
  }

  return { ok: true, message: "" };
}

module.exports = {
  COMMON_PROPERTIES,
  STEP_ALIASES,
  normalizeStepType,
  buildStepHandlerRegistry,
  validateStepSpecAgainstRegistry
};
