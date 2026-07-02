function handleDataContainerStep({
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

  if (step.type === "dataView") {
    const sourceCfg = deps.normalizeDataSourceStep(step);
    let entity = deps.resolveEntityForStep({ model, moduleName, pageSpec, step });

    const requestedParamName = step.pageParameterName || pageSpec.pageParameterName || "";
    const pageParameterEntry =
      (pageContext && requestedParamName && pageContext.byName ? pageContext.byName[requestedParamName] : null) ||
      (pageContext && pageContext.defaultEntry ? pageContext.defaultEntry : null);

    if (!entity && pageParameterEntry) {
      entity = pageParameterEntry.entity;
    }

    if (!entity) {
      throw new Error("dataView requires entityRef or a page parameter context.");
    }

    const widget = deps.createWidgetByClassName({
      pages,
      className: "DataView",
      container,
      createMethod: step.createMethod || ""
    });

    const hasUnresolvedPageParameterEntity = pageParameterEntry && pageParameterEntry.resolvedEntity === false;
    const dataSourceEntity = hasUnresolvedPageParameterEntity ? null : entity;
    const dataSourceEntityQname =
      hasUnresolvedPageParameterEntity && pageParameterEntry.entity
        ? String(pageParameterEntry.entity.qualifiedName || "")
        : "";

    deps.configureDataSource({
      domainmodels,
      dataSource: widget.dataSource,
      entity: dataSourceEntity,
      entityQname: dataSourceEntityQname,
      xPathConstraint: sourceCfg.xPathConstraint,
      dataSourceProps: sourceCfg.props
    });

    if (pageParameterEntry && pageParameterEntry.parameter) {
      const bound = deps.bindEntityPathSourceToPageParameter({
        pages,
        dataSource: widget.dataSource,
        pageParameter: pageParameterEntry.parameter
      });
      if (!bound) {
        throw new Error(
          `Could not bind DataView to page parameter "${pageParameterEntry.parameter.name}". Check SDK version compatibility.`
        );
      }
    }

    if (typeof step.labelWidth === "number" && "labelWidth" in widget) {
      widget.labelWidth = step.labelWidth;
    }
    if (typeof step.showFooter === "boolean" && "showFooter" in widget) {
      widget.showFooter = step.showFooter;
    }

    deps.applyWidgetProps(widget, step.props);
    deps.ensureWidgetName(widget, step.name || step.autoName || "data_view");

    deps.addNestedContentSteps({
      pages,
      texts,
      model,
      domainmodels,
      customwidgets,
      moduleName,
      pageSpec,
      pageContext,
      content: step.content,
      container: widget,
      pagesByRef,
      pageMetaByRef,
      microflowRefsByRef,
      nanoflowRefsByRef,
      workflowRefsByRef,
      dataGrid2Context,
      autoNamePrefix: `${deps.toSafeName(pageSpec.name || "page")}_data_view`
    });

    return widget;
  }

  if (step.type === "listView") {
    const entity = deps.resolveEntityForStep({ model, moduleName, pageSpec, step });
    const entityQname = deps.normalizeEntityQualifiedName(
      step.entityRef || step.entity || pageSpec.entityRef || pageSpec.entity || "",
      moduleName
    );
    if (!entity && !entityQname) {
      throw new Error("listView requires entityRef on step or page.");
    }
    return deps.createListViewWidgetFromGridStep({
      pages,
      texts,
      model,
      domainmodels,
      moduleName,
      pageSpec,
      container,
      step,
      entity,
      entityQname,
      pagesByRef,
      pageMetaByRef,
      pageContext,
      microflowRefsByRef,
      nanoflowRefsByRef,
      workflowRefsByRef
    });
  }

  return null;
}

module.exports = {
  handleDataContainerStep
};
