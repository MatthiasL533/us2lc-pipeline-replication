function normalizeActionType(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";

  const direct = t.toLowerCase();
  if (direct === "showmessage" || direct === "show_message") return "showMessage";
  if (direct === "callmicroflow" || direct === "microflowcall" || direct === "call_microflow") return "callMicroflow";
  if (direct === "callnanoflow" || direct === "nanoflowcall" || direct === "call_nanoflow") return "callNanoflow";
  if (direct === "retrievelist" || direct === "retrieve_list") return "retrieveList";
  if (direct === "retrieveobject" || direct === "retrieve_object") return "retrieveObject";
  if (direct === "createobject" || direct === "create_object") return "createObject";
  if (direct === "aggregatelist" || direct === "aggregate_list") return "aggregateList";
  if (direct === "createvariable" || direct === "create_variable") return "createVariable";
  if (direct === "changevariable" || direct === "change_variable") return "changeVariable";
  if (direct === "decision" || direct === "if") return "decision";
  if (direct === "changeobject" || direct === "change_object") return "changeObject";
  if (direct === "commitobject" || direct === "commit_object") return "commitObject";
  if (direct === "returnvalue" || direct === "return_value") return "returnValue";
  return t;
}

module.exports = {
  normalizeActionType
};
