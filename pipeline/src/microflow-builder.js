const path = require("path");

const microflowBuilderTemplate = require(path.join(
  __dirname,
  "builders",
  "microflow",
  "microflow-builder-template"
));

async function applyMicroflowsPlanToModel({
  model,
  moduleName = "MyFirstModule",
  microflowsPlan = {},
  nanoflowsPlan = {},
  deleteExisting = true
}) {
  return microflowBuilderTemplate.applyMicroflowPlanToModel({
    model,
    moduleName,
    microflowsPlan,
    nanoflowsPlan,
    deleteExisting
  });
}

module.exports = {
  applyMicroflowsPlanToModel
};
