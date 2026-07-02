const path = require("path");
const pageBuilderTemplate = require(path.join(__dirname, "builders", "page", "page-builder-template"));

async function applyPagesPlanToModel({
  model,
  moduleName = "MyFirstModule",
  layoutQualifiedName = "Atlas_Core.Atlas_Default",
  layoutParameterQname = "",
  pagesPlan = {},
  deleteExisting = true,
  dg2Cleanup = true,
  microflowRefsByRef = {},
  nanoflowRefsByRef = {},
  workflowRefsByRef = {}
}) {
  const { model: sdkModel } = pageBuilderTemplate.loadSdk();
  const pageSpecs = pagesPlan.specs || pagesPlan.pageSpecs || [];

  return pageBuilderTemplate.applyPagePlanToModel({
    model,
    pages: sdkModel.pages,
    texts: sdkModel.texts,
    domainmodels: sdkModel.domainmodels,
    customwidgets: sdkModel.customwidgets,
    datatypes: sdkModel.datatypes,
    security: sdkModel.security,
    moduleName,
    layoutQualifiedName,
    layoutParameterQname: layoutParameterQname || pagesPlan.layoutParameterQname || "",
    pageSpecs,
    deleteExisting,
    dg2Cleanup,
    microflowRefsByRef,
    nanoflowRefsByRef,
    workflowRefsByRef
  });
}

module.exports = {
  applyPagesPlanToModel
};
