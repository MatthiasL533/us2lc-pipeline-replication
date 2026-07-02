module.exports = [
  {
    type: "dataView",
    acceptedProperties: [
      "entityRef",
      "entity",
      "pageParameterName",
      "xPathConstraint",
      "sourceType",
      "dataSource",
      "labelWidth",
      "showFooter",
      "content"
    ],
    requiredContext: ["model", "domainmodels", "container"],
    failureMessage: "dataView requires model/domain context and a target container."
  },
  {
    type: "listView",
    acceptedProperties: [
      "entityRef",
      "entity",
      "xPathConstraint",
      "sourceType",
      "dataSource",
      "pageSize",
      "numberOfRows",
      "numberOfColumns",
      "templateContent",
      "content",
      "itemContent",
      "rowClickTargetPageRef",
      "autoRowClickToDetail"
    ],
    requiredContext: ["model", "domainmodels", "pagesByRef", "container"],
    failureMessage: "listView requires entity context, pagesByRef, and a target container."
  },
  {
    type: "filterToolbar",
    acceptedProperties: [
      "bindings",
      "stateEntityRef",
      "entityRef",
      "onChangeMicroflowRef",
      "callType",
      "refreshCaption",
      "content"
    ],
    requiredContext: ["container"],
    failureMessage: "filterToolbar requires a container and optional binding configuration."
  },
  {
    type: "attributeInput",
    acceptedProperties: [
      "entityRef",
      "entity",
      "attributeRef",
      "attribute",
      "attributeName",
      "label",
      "autoLabel",
      "events"
    ],
    requiredContext: ["model", "domainmodels", "container"],
    failureMessage: "attributeInput requires model/domain context and an attribute reference."
  },
  {
    type: "widget",
    acceptedProperties: ["className", "widgetId", "widgetName", "propertyTypes", "props"],
    requiredContext: ["pages", "container"],
    failureMessage: "widget requires className or widgetId and a target container."
  }
];
