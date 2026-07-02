module.exports = [
  {
    type: "saveChangesButton",
    acceptedProperties: ["caption", "closePage", "syncAutomatically"],
    requiredContext: ["container"],
    failureMessage: "saveChangesButton requires an action-capable container."
  },
  {
    type: "cancelChangesButton",
    acceptedProperties: ["caption"],
    requiredContext: ["container"],
    failureMessage: "cancelChangesButton requires an action-capable container."
  },
  {
    type: "createObjectButton",
    acceptedProperties: ["caption", "entityRef", "entity", "targetPageRef"],
    requiredContext: ["model", "domainmodels", "pagesByRef", "container"],
    failureMessage: "createObjectButton requires entity context and optional page target resolution."
  },
  {
    type: "callMicroflowButton",
    acceptedProperties: ["caption", "microflowRef", "microflowQualifiedName", "target"],
    requiredContext: ["model", "container"],
    failureMessage: "callMicroflowButton requires a resolvable microflow target."
  },
  {
    type: "callNanoflowButton",
    acceptedProperties: ["caption", "nanoflowRef", "nanoflowQualifiedName", "target"],
    requiredContext: ["model", "container"],
    failureMessage: "callNanoflowButton requires a resolvable nanoflow target."
  },
  {
    type: "callWorkflowButton",
    acceptedProperties: ["caption", "workflowRef", "workflowQualifiedName", "workflow", "target", "closePage"],
    requiredContext: ["model", "container"],
    failureMessage: "callWorkflowButton requires a resolvable workflow target."
  },
  {
    type: "showUserTaskPageButton",
    acceptedProperties: ["caption", "assignOnOpen", "openWhenAssigned"],
    requiredContext: ["container"],
    failureMessage: "showUserTaskPageButton requires an action-capable container in WorkflowUserTask context."
  },
  {
    type: "setTaskOutcomeButton",
    acceptedProperties: ["caption", "outcomeValue", "outcome", "value", "closePage", "commit"],
    requiredContext: ["container"],
    failureMessage: "setTaskOutcomeButton requires an action-capable container."
  },
  {
    type: "deleteObjectButton",
    acceptedProperties: ["caption", "closePage"],
    requiredContext: ["container"],
    failureMessage: "deleteObjectButton requires an action-capable container."
  },
  {
    type: "dataGrid",
    acceptedProperties: [
      "columns",
      "xPathConstraint",
      "entityRef",
      "entity",
      "pageSize",
      "numberOfRows",
      "dataSource",
      "search",
      "rowClickTargetPageRef",
      "controlBarButtons",
      "widgetMode",
      "mode"
    ],
    requiredContext: ["container"],
    failureMessage: "dataGrid requires deterministic DG2-compatible configuration."
  }
];
