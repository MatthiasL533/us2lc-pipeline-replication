module.exports = [
  {
    type: "associationInput",
    acceptedProperties: [
      "entityRef",
      "entity",
      "targetEntityRef",
      "targetEntity",
      "associationRef",
      "association",
      "displayAttributeRef",
      "displayAttribute",
      "attributeRef",
      "attribute",
      "label",
      "xPathConstraint",
      "renderMode",
      "mode"
    ],
    requiredContext: ["model", "domainmodels", "container"],
    failureMessage: "associationInput requires association/entity context and a container."
  },
  {
    type: "associationSetInput",
    acceptedProperties: [
      "entityRef",
      "entity",
      "targetEntityRef",
      "targetEntity",
      "associationRef",
      "association",
      "displayAttributeRef",
      "displayAttribute",
      "attributeRef",
      "attribute",
      "label",
      "xPathConstraint"
    ],
    requiredContext: ["model", "domainmodels", "container"],
    failureMessage: "associationSetInput requires association/entity context and a container."
  }
];
