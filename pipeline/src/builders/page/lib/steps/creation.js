function handleCreationStep({
  step,
  pages,
  texts,
  model,
  domainmodels,
  moduleName,
  pageSpec,
  container,
  pagesByRef,
  pageMetaByRef,
  deps
}) {
  if (!step || !step.type) return null;

  if (step.type === "createObjectButton") {
    const entity = deps.resolveEntityForStep({ model, moduleName, pageSpec, step });
    if (!entity) {
      throw new Error("createObjectButton requires entityRef on step or page.");
    }

    const targetPage = step.targetPageRef ? pagesByRef[step.targetPageRef] : null;
    if (step.targetPageRef && !targetPage) {
      throw new Error(`createObjectButton target "${step.targetPageRef}" not found.`);
    }

    const button = deps.addCreateObjectButton({
      pages,
      texts,
      model,
      domainmodels,
      container,
      caption: step.caption || "New",
      entity,
      targetPage,
      targetMeta: deps.getTargetPageMeta(step, targetPage, pageMetaByRef)
    });

    deps.applyWidgetProps(button, step.props);
    deps.ensureWidgetName(button, step.name || step.autoName || "create_object_button");
    return button;
  }

  return null;
}

module.exports = {
  handleCreationStep
};
