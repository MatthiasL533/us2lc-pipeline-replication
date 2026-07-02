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

function createSequenceFlowBetween(microflows, document, origin, destination) {
  const flow = microflows.SequenceFlow.createIn(document);
  flow.origin = origin;
  flow.destination = destination;
  return flow;
}

function setSequenceFlowBooleanCaseValue(microflows, flow, boolValue) {
  if (!flow || !microflows) return;
  const literal = boolValue ? "true" : "false";
  if (typeof microflows.EnumerationCase?.createInSequenceFlowUnderCaseValues !== "function") {
    throw new Error(
      "Current Mendix Model SDK does not expose SequenceFlow.caseValues APIs required by this generator."
    );
  }
  clearList(flow.caseValues);
  const c = microflows.EnumerationCase.createInSequenceFlowUnderCaseValues(flow);
  c.value = literal;
}

function hasBooleanCase(flow, expected) {
  if (!flow) return false;
  const rawExpected = expected ? "true" : "false";

  const asArray = Array.isArray(flow.caseValues)
    ? flow.caseValues
    : flow.caseValues && typeof flow.caseValues.slice === "function"
      ? flow.caseValues.slice()
      : [];
  if (asArray.length > 0) {
    return asArray.some((item) => item && String(item.value || "").toLowerCase() === rawExpected);
  }

  return false;
}

function validateDecisionBranchFlows(split, allFlows = []) {
  const outgoing = (Array.isArray(allFlows) ? allFlows : []).filter((f) => f && f.origin === split);
  const trueCount = outgoing.filter((flow) => hasBooleanCase(flow, true)).length;
  const falseCount = outgoing.filter((flow) => hasBooleanCase(flow, false)).length;

  return {
    ok: trueCount === 1 && falseCount === 1,
    trueCount,
    falseCount,
    outgoingCount: outgoing.length
  };
}

module.exports = {
  createSequenceFlowBetween,
  setSequenceFlowBooleanCaseValue,
  validateDecisionBranchFlows
};
