function handleInputStep({
  step,
  pages,
  texts,
  model,
  domainmodels,
  moduleName,
  pageSpec,
  pageContext,
  container,
  microflowRefsByRef,
  nanoflowRefsByRef,
  deps
}) {
  if (!step || !step.type) return null;

  if (step.type === "attributeInput") {
    return deps.addAttributeInputWidget({
      pages,
      texts,
      model,
      domainmodels,
      moduleName,
      pageSpec,
      pageContext,
      container,
      step,
      microflowRefsByRef,
      nanoflowRefsByRef
    });
  }

  return null;
}

module.exports = {
  handleInputStep
};
