module.exports = [
  {
    type: "dynamicText",
    acceptedProperties: ["text", "renderMode"],
    requiredContext: ["container"],
    failureMessage: "dynamicText requires text or render settings."
  }
];
