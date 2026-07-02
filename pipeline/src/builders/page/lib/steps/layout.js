function handleLayoutStep({
  step,
  pages,
  texts,
  model,
  domainmodels,
  customwidgets,
  moduleName,
  pageSpec,
  pageContext,
  container,
  pagesByRef,
  pageMetaByRef,
  microflowRefsByRef,
  nanoflowRefsByRef,
  workflowRefsByRef,
  dataGrid2Context,
  deps
}) {
  if (!step || !step.type) return null;

  if (step.type === "filterToolbar") {
    const containerWidget = deps.createWidgetByClassName({
      pages,
      className: "DivContainer",
      container,
      createMethod: step.createMethod || ""
    });
    deps.ensureWidgetName(containerWidget, step.name || step.autoName || "filter_toolbar");
    deps.applyWidgetProps(containerWidget, step.props);

    const bindings = step.bindings || {};
    const stateEntityRef = step.stateEntityRef || step.entityRef || pageSpec.entityRef || "";
    const statusAttr = bindings.statusAttributeRef || "";
    const searchAttr = bindings.searchTextAttributeRef || "";
    const implicitContent = [];

    if (statusAttr) {
      implicitContent.push({
        type: "attributeInput",
        entityRef: stateEntityRef,
        attributeRef: statusAttr,
        label: bindings.statusLabel || "Status",
        events: step.onChangeMicroflowRef
          ? { onChangeMicroflowRef: step.onChangeMicroflowRef, callType: step.callType || "synchronous" }
          : undefined
      });
    }
    if (searchAttr) {
      implicitContent.push({
        type: "attributeInput",
        entityRef: stateEntityRef,
        attributeRef: searchAttr,
        label: bindings.searchLabel || "Search",
        events: step.onChangeMicroflowRef
          ? { onChangeMicroflowRef: step.onChangeMicroflowRef, callType: step.callType || "synchronous" }
          : undefined
      });
    }
    if (step.onChangeMicroflowRef) {
      implicitContent.push({
        type: "callMicroflowButton",
        caption: step.refreshCaption || "Apply",
        microflowRef: step.onChangeMicroflowRef
      });
    }

    deps.addNestedContentSteps({
      pages,
      texts,
      model,
      domainmodels,
      customwidgets,
      moduleName,
      pageSpec,
      pageContext,
      content: Array.isArray(step.content) && step.content.length > 0 ? step.content : implicitContent,
      container: containerWidget,
      pagesByRef,
      pageMetaByRef,
      microflowRefsByRef,
      nanoflowRefsByRef,
      workflowRefsByRef,
      dataGrid2Context,
      autoNamePrefix: `${deps.toSafeName(pageSpec.name || "page")}_filter_toolbar`
    });

    return containerWidget;
  }

  if (step.type === "widget") {
    const widget = deps.createWidgetByClassName({
      pages,
      className: step.className,
      container,
      createMethod: step.createMethod || ""
    });

    deps.applyWidgetProps(widget, step.props);
    deps.ensureWidgetName(widget, step.name || step.autoName || deps.toSafeName(step.className || "widget"));
    return widget;
  }

  return null;
}

module.exports = {
  handleLayoutStep
};
