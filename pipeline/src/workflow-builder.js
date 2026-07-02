const path = require("path");

const workflowBuilderTemplate = require(path.join(
  __dirname,
  "builders",
  "workflow",
  "workflow-builder-template"
));

async function applyWorkflowsPlanToModel({
  model,
  moduleName = "MyFirstModule",
  workflowsPlan = {},
  deleteExisting = true,
  microflowRefsByRef = {},
  pageRefsByRef = {}
}) {
  return workflowBuilderTemplate.applyWorkflowPlanToModel({
    model,
    moduleName,
    workflowsPlan,
    deleteExisting,
    microflowRefsByRef,
    pageRefsByRef
  });
}

module.exports = {
  applyWorkflowsPlanToModel
};
