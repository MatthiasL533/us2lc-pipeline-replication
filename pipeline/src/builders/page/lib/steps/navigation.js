module.exports = [
  {
    type: "buttonToPage",
    acceptedProperties: ["caption", "targetPageRef", "parameterMappings"],
    requiredContext: ["pagesByRef"],
    failureMessage: "buttonToPage requires targetPageRef and page reference context."
  },
  {
    type: "closePageButton",
    acceptedProperties: ["caption", "numberOfPagesToClose"],
    requiredContext: ["container"],
    failureMessage: "closePageButton requires an action-capable container."
  },
  {
    type: "openLinkButton",
    acceptedProperties: ["caption", "url", "address", "linkType"],
    requiredContext: ["container"],
    failureMessage: "openLinkButton requires url/address and an action-capable container."
  }
];
