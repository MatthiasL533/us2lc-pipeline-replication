const STEP_ALIASES = Object.freeze({
  referenceSelector: "associationInput",
  referenceSetSelector: "associationSetInput"
});

const SUPPORTED_STEPS = Object.freeze([
  "dynamicText",
  "buttonToPage",
  "createObjectButton",
  "listView",
  "dataView",
  "associationInput",
  "associationSetInput",
  "dataGrid",
  "filterToolbar",
  "attributeInput",
  "saveChangesButton",
  "cancelChangesButton",
  "callMicroflowButton",
  "callNanoflowButton",
  "callWorkflowButton",
  "showUserTaskPageButton",
  "setTaskOutcomeButton",
  "deleteObjectButton",
  "closePageButton",
  "openLinkButton",
  "widget"
]);

function normalizeStepType(rawType) {
  const t = String(rawType || "").trim();
  if (!t) return "";
  return STEP_ALIASES[t] || t;
}

function isSupportedStepType(rawType) {
  const t = normalizeStepType(rawType);
  return SUPPORTED_STEPS.includes(t);
}

function assertSupportedStepType(rawType) {
  if (!isSupportedStepType(rawType)) {
    throw new Error(`Unsupported content step type "${rawType}".`);
  }
}

module.exports = {
  STEP_ALIASES,
  SUPPORTED_STEPS,
  normalizeStepType,
  isSupportedStepType,
  assertSupportedStepType
};
