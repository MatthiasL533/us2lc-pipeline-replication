const { normalizeActionType: normalizeActionTypeShared } = require("./lib/action-normalization");
const {
  createSequenceFlowBetween: createSequenceFlowBetweenShared,
  setSequenceFlowBooleanCaseValue: setSequenceFlowBooleanCaseValueShared,
  validateDecisionBranchFlows: validateDecisionBranchFlowsShared
} = require("./lib/sequence-flow");
const {
  resolveEntityReference: resolveEntityReferenceShared,
  resolveAttributeReference: resolveAttributeReferenceShared,
  resolveMicroflowByReference: resolveMicroflowByReferenceShared,
  resolveNanoflowByReference: resolveNanoflowByReferenceShared,
  toQualifiedName
} = require("./lib/ref-resolution");

function requireSdkPackage(pkgName) {
  return require(pkgName);
}

function loadSdk() {
  const platform = requireSdkPackage("mendixplatformsdk");
  const model = requireSdkPackage("mendixmodelsdk");
  return { platform, model };
}

function loadModelNamespaces() {
  const sdk = requireSdkPackage("mendixmodelsdk");
  return {
    microflows: sdk.microflows,
    datatypes: sdk.datatypes,
    texts: sdk.texts
  };
}

function createText(texts, model, value, languageCode = "en_US") {
  const t = texts.Text.create(model);
  const tr = texts.Translation.create(model);
  tr.languageCode = languageCode;
  tr.text = String(value || "");
  t.translations.push(tr);
  return t;
}

function clearList(list) {
  if (!list) return;
  if (typeof list.replace === "function") {
    list.replace([]);
    return;
  }
  if (typeof list.clear === "function") {
    list.clear();
    return;
  }
  if (Array.isArray(list)) {
    list.length = 0;
  }
}

async function findModule(model, moduleName) {
  function resolveModuleFromFolderBase(folderBase) {
    let current = folderBase || null;
    let guard = 0;
    while (current && guard < 20) {
      if (current.containerAsModule && current.containerAsModule.name) {
        return current.containerAsModule;
      }
      if (current.containerAsFolder && current.containerAsFolder.containerAsModule && current.containerAsFolder.containerAsModule.name) {
        return current.containerAsFolder.containerAsModule;
      }
      if (current.containerAsFolder && current.containerAsFolder.containerAsFolderBase) {
        current = current.containerAsFolder.containerAsFolderBase;
        guard += 1;
        continue;
      }
      break;
    }
    return null;
  }

  if (typeof model.allMicroflows === "function") {
    for (const mf of model.allMicroflows()) {
      const mod = resolveModuleFromFolderBase(mf && mf.containerAsFolderBase);
      if (mod && mod.name === moduleName) {
        return mod;
      }
    }
  }

  if (typeof model.allNanoflows === "function") {
    for (const nf of model.allNanoflows()) {
      const mod = resolveModuleFromFolderBase(nf && nf.containerAsFolderBase);
      if (mod && mod.name === moduleName) {
        return mod;
      }
    }
  }

  if (typeof model.allDomainModels === "function") {
    const dmIface = model
      .allDomainModels()
      .find((dm) => dm && dm.containerAsModule && dm.containerAsModule.name === moduleName);
    if (dmIface) {
      const dm = typeof dmIface.load === "function" ? await dmIface.load() : dmIface;
      if (dm && dm.containerAsModule) return dm.containerAsModule;
    }
  }

  const moduleIface = model.allModules().find((m) => m.name === moduleName);
  if (!moduleIface) return null;
  if (typeof moduleIface.load === "function") {
    try {
      const loaded = await moduleIface.load();
      if (loaded) return loaded;
    } catch (_err) {
      // Fallback to iface below.
    }
  }
  return moduleIface;
}

function toUniqueStrings(values) {
  return [...new Set((values || []).filter((v) => typeof v === "string" && v.length > 0))];
}

function resolveEntityReference(model, moduleName, rawEntityRef) {
  return resolveEntityReferenceShared(model, moduleName, rawEntityRef);
}

function resolveAttributeReference({ model, entity, rawAttributeRef }) {
  return resolveAttributeReferenceShared({ model, entity, rawAttributeRef });
}

async function deleteMicroflowIfExists(model, moduleName, name) {
  const iface = model
    .allMicroflows()
    .find(
      (mf) =>
        mf.name === name &&
        mf.containerAsFolderBase &&
        mf.containerAsFolderBase.containerAsModule &&
        mf.containerAsFolderBase.containerAsModule.name === moduleName
    );
  if (!iface) return;
  const loaded = typeof iface.load === "function" ? await iface.load() : iface;
  loaded.delete();
}

async function deleteNanoflowIfExists(model, moduleName, name) {
  const iface = model
    .allNanoflows()
    .find(
      (nf) =>
        nf.name === name &&
        nf.containerAsFolderBase &&
        nf.containerAsFolderBase.containerAsModule &&
        nf.containerAsFolderBase.containerAsModule.name === moduleName
    );
  if (!iface) return;
  const loaded = typeof iface.load === "function" ? await iface.load() : iface;
  loaded.delete();
}

function normalizeDataTypeSpec(typeSpec) {
  if (!typeSpec) return { kind: "Void" };

  if (typeof typeSpec === "string") {
    const raw = typeSpec.trim();
    if (!raw) return { kind: "Void" };

    if (raw.includes(":")) {
      const [kind, entityRef] = raw.split(":");
      return { kind: kind.trim(), entityRef: entityRef ? entityRef.trim() : "" };
    }

    return { kind: raw };
  }

  if (typeof typeSpec === "object") {
    return {
      kind: String(typeSpec.kind || "Void"),
      entityRef: typeSpec.entityRef ? String(typeSpec.entityRef) : "",
      enumerationRef: typeSpec.enumerationRef ? String(typeSpec.enumerationRef) : ""
    };
  }

  return { kind: "Void" };
}

function normalizeDataTypeSpecForModel({ model, moduleName, typeSpec }) {
  const spec = normalizeDataTypeSpec(typeSpec);
  const kind = String(spec.kind || "").trim();
  const lower = kind.toLowerCase();
  const supportedKinds = new Set(["void", "string", "boolean", "integer", "long", "decimal", "datetime", "object", "list", "enum", "enumeration"]);
  if (!supportedKinds.has(lower) && resolveEntityReference(model, moduleName, kind)) {
    return { kind: "Object", entityRef: kind };
  }
  return spec;
}

function resolveDataTypeCtor(datatypes, kind) {
  const normalized = String(kind || "Void").toLowerCase();
  if (normalized === "void") return datatypes.VoidType;
  if (normalized === "string") return datatypes.StringType;
  if (normalized === "boolean") return datatypes.BooleanType;
  if (normalized === "integer" || normalized === "long") return datatypes.IntegerType;
  if (normalized === "decimal") return datatypes.DecimalType;
  if (normalized === "datetime") return datatypes.DateTimeType;
  if (normalized === "object") return datatypes.ObjectType;
  if (normalized === "list") return datatypes.ListType;
  if (normalized === "enum" || normalized === "enumeration") return datatypes.EnumerationType;
  throw new Error(`Unsupported microflow data type kind "${kind}".`);
}

function createTypeOnContainer({ datatypes, model, container, typeSpec, moduleName, createMethods = [] }) {
  const spec = normalizeDataTypeSpecForModel({ model, moduleName, typeSpec });
  const ctor = resolveDataTypeCtor(datatypes, spec.kind);
  if (!ctor) {
    throw new Error(`Data type constructor unavailable for kind "${spec.kind}".`);
  }

  let created = null;
  const methodCandidates = [
    ...createMethods,
    "createInCreateVariableActionUnderVariableType",
    "createInMicroflowParameterObjectUnderVariableType",
    "createInMicroflowBaseUnderMicroflowReturnType",
    "createInMicroflowParameterBaseUnderParameterType"
  ];

  for (const methodName of methodCandidates) {
    if (typeof ctor[methodName] !== "function") continue;
    try {
      created = ctor[methodName](container);
      break;
    } catch (_err) {
      // Continue with fallbacks.
    }
  }

  if (!created && typeof ctor.create === "function") {
    created = ctor.create(model);
  }

  if (!created) {
    throw new Error(`Could not create data type "${spec.kind}" for microflow document.`);
  }

  const normalizedKind = spec.kind.toLowerCase();

  if (normalizedKind === "object" || normalizedKind === "list") {
    const entity = resolveEntityReference(model, moduleName, spec.entityRef);
    if (!entity) {
      throw new Error(`Could not resolve entity "${spec.entityRef || ""}" for ${spec.kind} microflow data type.`);
    }
    created.entity = entity;
  }

  if ((normalizedKind === "enum" || normalizedKind === "enumeration") && spec.enumerationRef) {
    const enumeration =
      model.findEnumerationByQualifiedName(spec.enumerationRef) ||
      model.findEnumerationByQualifiedName(`${moduleName}.${spec.enumerationRef}`);
    if (!enumeration) {
      throw new Error(`Could not resolve enumeration "${spec.enumerationRef}" for microflow return type.`);
    }
    created.enumeration = enumeration;
  }

  if (container && "microflowReturnType" in container) {
    try {
      container.microflowReturnType = created;
    } catch (_err) {
      // Already attached via createIn method.
    }
  }

  if (container && "parameterType" in container) {
    try {
      container.parameterType = created;
    } catch (_err) {
      // Already attached via createIn method.
    }
  }

  if (container && "variableType" in container) {
    try {
      container.variableType = created;
    } catch (_err) {
      // Already attached via createIn method.
    }
  }

  return created;
}

function resolveMicroflowByReference({ model, moduleName, ref, microflowRefsByRef = {}, createdByRef = {} }) {
  return resolveMicroflowByReferenceShared({ model, moduleName, ref, microflowRefsByRef, createdByRef });
}

function resolveNanoflowByReference({ model, moduleName, ref, nanoflowRefsByRef = {}, createdByRef = {} }) {
  return resolveNanoflowByReferenceShared({ model, moduleName, ref, nanoflowRefsByRef, createdByRef });
}

function clearMicroflowBody(document) {
  clearList(document.objectCollection && document.objectCollection.objects);
  clearList(document.flows);
}

function createSequenceFlowBetween(microflows, document, origin, destination) {
  return createSequenceFlowBetweenShared(microflows, document, origin, destination);
}

function setSequenceFlowBooleanCaseValue(microflows, flow, boolValue) {
  return setSequenceFlowBooleanCaseValueShared(microflows, flow, boolValue);
}

function normalizeActionType(raw) {
  return normalizeActionTypeShared(raw);
}

function isNanoflowDocument(document) {
  if (!document) return false;
  if (document.structureTypeName === "Microflows$Nanoflow") return true;
  if (document.constructor && document.constructor.name === "Nanoflow") return true;
  return false;
}

function resolveErrorHandlingType(microflows, raw) {
  if (!raw || !microflows || !microflows.ErrorHandlingType) return null;
  const value = String(raw).trim().toLowerCase();
  if (!value) return null;

  const map = {
    rollback: "Rollback",
    custom: "Custom",
    customwithoutrollback: "CustomWithoutRollBack",
    custom_without_rollback: "CustomWithoutRollBack",
    continue: "Continue",
    abort: "Abort"
  };

  const key = map[value];
  if (!key) return null;
  return microflows.ErrorHandlingType[key] || null;
}

function applyActionErrorHandlingForContext({ microflows, document, action, actionSpec = {} }) {
  if (!action || !("errorHandlingType" in action)) return;

  const explicit =
    resolveErrorHandlingType(microflows, actionSpec.errorHandlingType) ||
    resolveErrorHandlingType(microflows, actionSpec.errorHandling);
  if (explicit) {
    action.errorHandlingType = explicit;
    return;
  }

  // Mendix nanoflows do not support Rollback for client-side actions like Show Message.
  // Set a safe default to avoid CE6035.
  if (isNanoflowDocument(document)) {
    const safeDefault =
      (microflows.ErrorHandlingType && microflows.ErrorHandlingType.Abort) ||
      (microflows.ErrorHandlingType && microflows.ErrorHandlingType.Continue) ||
      (microflows.ErrorHandlingType && microflows.ErrorHandlingType.CustomWithoutRollBack) ||
      (microflows.ErrorHandlingType && microflows.ErrorHandlingType.Custom) ||
      null;
    if (safeDefault) {
      action.errorHandlingType = safeDefault;
    }
  }
}

function normalizeMemberChangeType(microflows, rawType) {
  if (!microflows || !microflows.ChangeActionItemType) return null;
  const raw = String(rawType || "").trim().toLowerCase();
  if (!raw) return microflows.ChangeActionItemType.Set || null;
  if (raw === "set") return microflows.ChangeActionItemType.Set || null;
  if (raw === "add") return microflows.ChangeActionItemType.Add || null;
  if (raw === "remove") return microflows.ChangeActionItemType.Remove || null;
  return microflows.ChangeActionItemType.Set || null;
}

function normalizeAggregateFunction(microflows, rawType) {
  if (!microflows || !microflows.AggregateFunctionEnum) return null;
  const raw = String(rawType || "Count").trim().toLowerCase();
  if (!raw) return microflows.AggregateFunctionEnum.Count || null;
  if (raw === "count") return microflows.AggregateFunctionEnum.Count || null;
  if (raw === "sum") return microflows.AggregateFunctionEnum.Sum || null;
  if (raw === "average" || raw === "avg") return microflows.AggregateFunctionEnum.Average || null;
  if (raw === "minimum" || raw === "min") return microflows.AggregateFunctionEnum.Minimum || null;
  if (raw === "maximum" || raw === "max") return microflows.AggregateFunctionEnum.Maximum || null;
  if (raw === "all") return microflows.AggregateFunctionEnum.All || null;
  if (raw === "any") return microflows.AggregateFunctionEnum.Any || null;
  if (raw === "reduce") return microflows.AggregateFunctionEnum.Reduce || null;
  return microflows.AggregateFunctionEnum.Count || null;
}

function normalizeCommitEnum(microflows, rawCommit) {
  if (!microflows || !microflows.CommitEnum) return null;
  if (rawCommit === undefined || rawCommit === null) return null;

  if (typeof rawCommit === "boolean") {
    return rawCommit ? microflows.CommitEnum.Yes || null : microflows.CommitEnum.No || null;
  }

  const raw = String(rawCommit).trim().toLowerCase();
  if (!raw) return null;
  if (raw === "yes" || raw === "true" || raw === "with_events") return microflows.CommitEnum.Yes || null;
  if (raw === "yeswithoutevents" || raw === "without_events" || raw === "noevents") {
    return microflows.CommitEnum.YesWithoutEvents || null;
  }
  if (raw === "no" || raw === "false") return microflows.CommitEnum.No || null;
  return null;
}

function resolveDecisionBranches(actionSpec = {}) {
  const whenTrue =
    actionSpec.whenTrue ||
    actionSpec.trueActions ||
    actionSpec.then ||
    actionSpec.onTrue ||
    actionSpec.trueBranch ||
    [];
  const whenFalse =
    actionSpec.whenFalse ||
    actionSpec.falseActions ||
    actionSpec.else ||
    actionSpec.onFalse ||
    actionSpec.falseBranch ||
    [];

  return {
    whenTrue: Array.isArray(whenTrue) ? whenTrue : [],
    whenFalse: Array.isArray(whenFalse) ? whenFalse : []
  };
}

function inferVariableEntityFromTypeSpec({ model, moduleName, typeSpec }) {
  const normalized = normalizeDataTypeSpecForModel({ model, moduleName, typeSpec });
  const kind = String(normalized.kind || "").trim().toLowerCase();
  if (kind !== "object" && kind !== "list") return null;
  return resolveEntityReference(model, moduleName, normalized.entityRef);
}

function createActionActivityForSpec({
  microflows,
  datatypes,
  texts,
  model,
  moduleName,
  document,
  objectCollection,
  actionSpec,
  microflowRefsByRef,
  nanoflowRefsByRef,
  createdMicroflowsByRef,
  createdNanoflowsByRef,
  variableEntityByName
}) {
  const type = normalizeActionType(actionSpec.type);
  if (!type) {
    throw new Error("Each microflow action must include a type.");
  }

  if (type === "decision" || type === "returnValue") {
    return { type, activity: null };
  }

  const activity = microflows.ActionActivity.createIn(objectCollection);
  if (actionSpec.caption) {
    activity.caption = String(actionSpec.caption);
    activity.autoGenerateCaption = false;
  }

  if (type === "showMessage") {
    const show = microflows.ShowMessageAction.createIn(activity);
    applyActionErrorHandlingForContext({ microflows, document, action: show, actionSpec });
    const template = microflows.TextTemplate.createInShowMessageActionUnderTemplate(show);
    template.text = createText(texts, model, actionSpec.message || actionSpec.text || "Generated action");

    if (actionSpec.blocking !== undefined && "blocking" in show) {
      show.blocking = Boolean(actionSpec.blocking);
    }

    if (actionSpec.messageType && microflows.ShowMessageType && microflows.ShowMessageType[actionSpec.messageType]) {
      show.type = microflows.ShowMessageType[actionSpec.messageType];
    }

    return { type, activity };
  }

  if (type === "callMicroflow") {
    const callAction = microflows.MicroflowCallAction.createIn(activity);
    applyActionErrorHandlingForContext({ microflows, document, action: callAction, actionSpec });
    const call = microflows.MicroflowCall.createIn(callAction);

    const target = resolveMicroflowByReference({
      model,
      moduleName,
      ref: actionSpec.microflowRef || actionSpec.targetRef || actionSpec.microflowQualifiedName || actionSpec.target,
      microflowRefsByRef,
      createdByRef: createdMicroflowsByRef
    });

    if (!target) {
      throw new Error(
        `Could not resolve callMicroflow target "${
          actionSpec.microflowRef || actionSpec.targetRef || actionSpec.microflowQualifiedName || actionSpec.target || ""
        }" in "${document.name}".`
      );
    }

    call.microflow = target;

    if (Array.isArray(actionSpec.parameterMappings) && actionSpec.parameterMappings.length > 0) {
      throw new Error(
        `Action "callMicroflow" in "${document.name}" specifies parameterMappings, ` +
          "but v1 builder currently supports only no-parameter microflow calls."
      );
    }

    return { type, activity };
  }

  if (type === "callNanoflow") {
    const callAction = microflows.NanoflowCallAction.createIn(activity);
    applyActionErrorHandlingForContext({ microflows, document, action: callAction, actionSpec });
    const call = microflows.NanoflowCall.createIn(callAction);

    const target = resolveNanoflowByReference({
      model,
      moduleName,
      ref: actionSpec.nanoflowRef || actionSpec.targetRef || actionSpec.nanoflowQualifiedName || actionSpec.target,
      nanoflowRefsByRef,
      createdByRef: createdNanoflowsByRef
    });

    if (!target) {
      throw new Error(
        `Could not resolve callNanoflow target "${
          actionSpec.nanoflowRef || actionSpec.targetRef || actionSpec.nanoflowQualifiedName || actionSpec.target || ""
        }" in "${document.name}".`
      );
    }

    call.nanoflow = target;

    if (Array.isArray(actionSpec.parameterMappings) && actionSpec.parameterMappings.length > 0) {
      throw new Error(
        `Action "callNanoflow" in "${document.name}" specifies parameterMappings, ` +
          "but v1 builder currently supports only no-parameter nanoflow calls."
      );
    }

    return { type, activity };
  }

  if (type === "retrieveList" || type === "retrieveObject") {
    const retrieve = microflows.RetrieveAction.createIn(activity);
    applyActionErrorHandlingForContext({ microflows, document, action: retrieve, actionSpec });

    const source = microflows.DatabaseRetrieveSource.createIn(retrieve);
    const entityRef = actionSpec.entityRef || actionSpec.entity || actionSpec.fromEntityRef || actionSpec.fromEntity || "";
    const entity = resolveEntityReference(model, moduleName, entityRef);
    if (!entity) {
      throw new Error(
        `Action "${type}" in "${document.name}" could not resolve entity "${entityRef}".`
      );
    }
    source.entity = entity;
    if (actionSpec.xPathConstraint !== undefined && "xPathConstraint" in source) {
      source.xPathConstraint = String(actionSpec.xPathConstraint || "");
    }
    if (source.range && "singleObject" in source.range) {
      source.range.singleObject = type === "retrieveObject";
    }

    const outputVariableName =
      actionSpec.outputVariableName ||
      actionSpec.variableName ||
      actionSpec.name ||
      `${entity.name}_${type === "retrieveObject" ? "Object" : "List"}`;
    if (Object.prototype.hasOwnProperty.call(variableEntityByName, String(outputVariableName))) {
      throw new Error(
        `Action "${type}" in "${document.name}" defines duplicate output variable "${String(outputVariableName)}".`
      );
    }
    retrieve.outputVariableName = String(outputVariableName);
    variableEntityByName[String(outputVariableName)] = entity;

    return { type, activity };
  }

  if (type === "createObject") {
    const createObject = microflows.CreateObjectAction.createIn(activity);
    applyActionErrorHandlingForContext({ microflows, document, action: createObject, actionSpec });

    const entityRef = actionSpec.entityRef || actionSpec.entity || "";
    const entity = resolveEntityReference(model, moduleName, entityRef);
    if (!entity) {
      throw new Error(
        `Action "createObject" in "${document.name}" could not resolve entity "${entityRef}".`
      );
    }
    createObject.entity = entity;

    const outputVariableName =
      actionSpec.outputVariableName ||
      actionSpec.variableName ||
      actionSpec.name ||
      `${entity.name}New`;
    if (Object.prototype.hasOwnProperty.call(variableEntityByName, String(outputVariableName))) {
      throw new Error(
        `Action "createObject" in "${document.name}" defines duplicate output variable "${String(outputVariableName)}".`
      );
    }
    createObject.outputVariableName = String(outputVariableName);
    variableEntityByName[String(outputVariableName)] = entity;

    return { type, activity };
  }

  if (type === "aggregateList") {
    const aggregate = microflows.AggregateListAction.createIn(activity);
    applyActionErrorHandlingForContext({ microflows, document, action: aggregate, actionSpec });

    const inputListVariableName =
      actionSpec.inputListVariableName ||
      actionSpec.listVariableName ||
      actionSpec.sourceListVariableName ||
      actionSpec.input ||
      "";
    if (!inputListVariableName) {
      throw new Error(`Action "aggregateList" in "${document.name}" requires inputListVariableName/listVariableName.`);
    }
    aggregate.inputListVariableName = String(inputListVariableName);

    const functionName = actionSpec.function || actionSpec.aggregateFunction || "Count";
    const aggregateFunction = normalizeAggregateFunction(microflows, functionName);
    if (!aggregateFunction) {
      throw new Error(`Action "aggregateList" in "${document.name}" uses unsupported function "${functionName}".`);
    }
    aggregate.aggregateFunction = aggregateFunction;

    const requiresAttribute = !(
      aggregateFunction === microflows.AggregateFunctionEnum.Count ||
      aggregateFunction === microflows.AggregateFunctionEnum.All ||
      aggregateFunction === microflows.AggregateFunctionEnum.Any ||
      aggregateFunction === microflows.AggregateFunctionEnum.Reduce
    );
    const attrRef = actionSpec.attributeRef || actionSpec.attribute || actionSpec.memberRef || actionSpec.member || "";
    if (requiresAttribute && !attrRef) {
      throw new Error(
        `Action "aggregateList" in "${document.name}" using function "${functionName}" requires attributeRef.`
      );
    }
    if (attrRef) {
      const resolvedEntity = variableEntityByName[String(inputListVariableName)] || null;
      const attr = resolveAttributeReference({
        model,
        entity: resolvedEntity,
        rawAttributeRef: attrRef
      });
      if (!attr) {
        throw new Error(
          `Action "aggregateList" in "${document.name}" could not resolve attribute "${attrRef}".`
        );
      }
      aggregate.attribute = attr;
    }

    const expression = actionSpec.expression || actionSpec.valueExpression || "";
    if (expression && "expression" in aggregate) {
      aggregate.expression = String(expression);
      if ("useExpression" in aggregate) {
        aggregate.useExpression = true;
      }
    }
    if (
      aggregateFunction === microflows.AggregateFunctionEnum.Reduce &&
      actionSpec.reduceInitialValueExpression !== undefined &&
      "reduceInitialValueExpression" in aggregate
    ) {
      aggregate.reduceInitialValueExpression = String(actionSpec.reduceInitialValueExpression || "");
    }

    const outputVariableName =
      actionSpec.outputVariableName ||
      actionSpec.variableName ||
      actionSpec.name ||
      `${inputListVariableName}Count`;
    if (Object.prototype.hasOwnProperty.call(variableEntityByName, String(outputVariableName))) {
      throw new Error(
        `Action "aggregateList" in "${document.name}" defines duplicate output variable "${String(outputVariableName)}".`
      );
    }
    aggregate.outputVariableName = String(outputVariableName);
    variableEntityByName[String(outputVariableName)] = null;

    return { type, activity };
  }

  if (type === "createVariable") {
    const action = microflows.CreateVariableAction.createIn(activity);
    applyActionErrorHandlingForContext({ microflows, document, action, actionSpec });

    const variableName = actionSpec.name || actionSpec.variableName || actionSpec.targetVariableName || "";
    if (!variableName) {
      throw new Error(`Action "createVariable" in "${document.name}" requires name or variableName.`);
    }
    if (Object.prototype.hasOwnProperty.call(variableEntityByName, String(variableName))) {
      throw new Error(`Action "createVariable" in "${document.name}" defines duplicate variable "${String(variableName)}".`);
    }
    action.variableName = String(variableName);

    createTypeOnContainer({
      datatypes,
      model,
      container: action,
      typeSpec: actionSpec.variableType || actionSpec.dataType || actionSpec.returnType || { kind: "String" },
      moduleName,
      createMethods: ["createInCreateVariableActionUnderVariableType"]
    });

    const initialValueExpression =
      actionSpec.initialValueExpression !== undefined
        ? actionSpec.initialValueExpression
        : actionSpec.valueExpression !== undefined
          ? actionSpec.valueExpression
          : actionSpec.expression !== undefined
            ? actionSpec.expression
            : "";
    if (initialValueExpression !== undefined && "initialValue" in action) {
      action.initialValue = String(initialValueExpression || "");
    }

    const entity = inferVariableEntityFromTypeSpec({
      model,
      moduleName,
      typeSpec: actionSpec.variableType || actionSpec.dataType || actionSpec.returnType || {}
    });
    variableEntityByName[String(variableName)] = entity || null;

    return { type, activity };
  }

  if (type === "changeVariable") {
    const action = microflows.ChangeVariableAction.createIn(activity);
    applyActionErrorHandlingForContext({ microflows, document, action, actionSpec });

    const variableName =
      actionSpec.name || actionSpec.variableName || actionSpec.changeVariableName || actionSpec.targetVariableName || "";
    if (!variableName) {
      throw new Error(`Action "changeVariable" in "${document.name}" requires variableName.`);
    }
    action.changeVariableName = String(variableName);
    action.value = String(actionSpec.valueExpression || actionSpec.expression || "");

    return { type, activity };
  }

  if (type === "changeObject") {
    const action = microflows.ChangeObjectAction.createIn(activity);
    applyActionErrorHandlingForContext({ microflows, document, action, actionSpec });

    const targetVariableName =
      actionSpec.targetVariableName ||
      actionSpec.objectVariableName ||
      actionSpec.variableName ||
      actionSpec.changeVariableName ||
      "";
    if (!targetVariableName) {
      throw new Error(`Action "changeObject" in "${document.name}" requires targetVariableName/objectVariableName.`);
    }
    action.changeVariableName = String(targetVariableName);

    const resolvedEntity =
      resolveEntityReference(model, moduleName, actionSpec.entityRef || actionSpec.entity || "") ||
      variableEntityByName[String(targetVariableName)] ||
      null;
    if (!resolvedEntity) {
      throw new Error(
        `Action "changeObject" in "${document.name}" targets variable "${String(
          targetVariableName
        )}" without a resolved entity (null-target guard).`
      );
    }

    const changes = Array.isArray(actionSpec.changes)
      ? actionSpec.changes
      : Array.isArray(actionSpec.members)
        ? actionSpec.members
        : [];
    if (changes.length === 0) {
      throw new Error(`Action "changeObject" in "${document.name}" requires a non-empty changes array.`);
    }

    clearList(action.items);
    for (const changeSpec of changes) {
      const change = microflows.MemberChange.createIn(action);

      const attrRef =
        changeSpec.attributeRef ||
        changeSpec.attribute ||
        changeSpec.memberRef ||
        changeSpec.member ||
        "";
      const attr = resolveAttributeReference({
        model,
        entity: resolvedEntity,
        rawAttributeRef: attrRef
      });
      if (!attr) {
        throw new Error(
          `Action "changeObject" in "${document.name}" could not resolve attribute "${attrRef}".`
        );
      }
      change.attribute = attr;
      change.type = normalizeMemberChangeType(microflows, changeSpec.changeType || changeSpec.type);
      change.value = String(changeSpec.valueExpression || changeSpec.expression || "");
    }

    const commitEnum = normalizeCommitEnum(microflows, actionSpec.commit);
    if (commitEnum && "commit" in action) {
      action.commit = commitEnum;
    }
    if (actionSpec.refreshInClient !== undefined && "refreshInClient" in action) {
      action.refreshInClient = Boolean(actionSpec.refreshInClient);
    }

    return { type, activity };
  }

  if (type === "commitObject") {
    const action = microflows.CommitAction.createIn(activity);
    applyActionErrorHandlingForContext({ microflows, document, action, actionSpec });

    const targetVariableName =
      actionSpec.variableName || actionSpec.targetVariableName || actionSpec.objectVariableName || "";
    if (!targetVariableName) {
      throw new Error(`Action "commitObject" in "${document.name}" requires variableName/targetVariableName.`);
    }

    action.commitVariableName = String(targetVariableName);
    if (actionSpec.withEvents !== undefined && "withEvents" in action) {
      action.withEvents = Boolean(actionSpec.withEvents);
    }
    if (actionSpec.refreshInClient !== undefined && "refreshInClient" in action) {
      action.refreshInClient = Boolean(actionSpec.refreshInClient);
    }

    return { type, activity };
  }

  throw new Error(`Unsupported microflow action type "${type}" in "${document.name}".`);
}

function createParameterObjects({
  microflows,
  datatypes,
  model,
  moduleName,
  document,
  spec,
  variableEntityByName
}) {
  const params = Array.isArray(spec.parameters) ? spec.parameters : [];
  if (params.length === 0) return;

  const objectCollection = document.objectCollection;
  for (const paramSpec of params) {
    if (!paramSpec || typeof paramSpec !== "object") continue;
    const name = String(paramSpec.name || "").trim();
    if (!name) {
      throw new Error(`Microflow "${document.name}" contains a parameter without a name.`);
    }
    if (Object.prototype.hasOwnProperty.call(variableEntityByName, name)) {
      throw new Error(`Microflow "${document.name}" contains duplicate parameter/variable name "${name}".`);
    }

    const paramObject = microflows.MicroflowParameterObject.createIn(objectCollection);
    paramObject.name = name;
    if ("documentation" in paramObject && paramSpec.documentation) {
      paramObject.documentation = String(paramSpec.documentation);
    }
    if ("isRequired" in paramObject) {
      paramObject.isRequired = paramSpec.required !== false;
    }
    if ("defaultValue" in paramObject && paramSpec.defaultValue !== undefined) {
      paramObject.defaultValue = String(paramSpec.defaultValue);
    }

    createTypeOnContainer({
      datatypes,
      model,
      container: paramObject,
      typeSpec: paramSpec.type || paramSpec.parameterType || { kind: "String" },
      moduleName,
      createMethods: ["createInMicroflowParameterObjectUnderVariableType"]
    });

    const entity = inferVariableEntityFromTypeSpec({
      model,
      moduleName,
      typeSpec: paramSpec.type || paramSpec.parameterType || {}
    });
    variableEntityByName[name] = entity || null;
  }
}

function buildActionSequence({
  microflows,
  datatypes,
  texts,
  model,
  moduleName,
  document,
  spec,
  actions,
  previousObject,
  microflowRefsByRef,
  nanoflowRefsByRef,
  createdMicroflowsByRef,
  createdNanoflowsByRef,
  variableEntityByName,
  state,
  depth = 0,
  branchCaseValueForFirstFlow = null
}) {
  if (depth > 50) {
    throw new Error(`Microflow "${document.name}" exceeded max decision nesting depth (50).`);
  }

  let current = previousObject;
  const sequence = Array.isArray(actions) ? actions : [];

  for (const rawAction of sequence) {
    const actionSpec = rawAction || {};
    const actionType = normalizeActionType(actionSpec.type);

    if (!actionType) {
      throw new Error(`Each action in "${document.name}" must have a type.`);
    }

    if (actionType === "returnValue") {
      state.returnExpression = String(actionSpec.valueExpression || actionSpec.expression || "");
      continue;
    }

    if (actionType === "decision") {
      const split = microflows.ExclusiveSplit.createIn(document.objectCollection);
      if (actionSpec.caption) {
        split.caption = String(actionSpec.caption);
      }

      const conditionExpression = String(actionSpec.conditionExpression || actionSpec.expression || "false");
      if (split.splitCondition && "expression" in split.splitCondition) {
        split.splitCondition.expression = conditionExpression;
      }

      createSequenceFlowBetween(microflows, document, current, split);

      const branches = resolveDecisionBranches(actionSpec);
      const merge = microflows.ExclusiveMerge.createIn(document.objectCollection);

      const trueTail = buildActionSequence({
        microflows,
        datatypes,
        texts,
        model,
        moduleName,
        document,
        spec,
        actions: branches.whenTrue,
        previousObject: split,
        microflowRefsByRef,
        nanoflowRefsByRef,
        createdMicroflowsByRef,
        createdNanoflowsByRef,
        variableEntityByName,
        state,
        depth: depth + 1,
        branchCaseValueForFirstFlow: true
      });

      const falseTail = buildActionSequence({
        microflows,
        datatypes,
        texts,
        model,
        moduleName,
        document,
        spec,
        actions: branches.whenFalse,
        previousObject: split,
        microflowRefsByRef,
        nanoflowRefsByRef,
        createdMicroflowsByRef,
        createdNanoflowsByRef,
        variableEntityByName,
        state,
        depth: depth + 1,
        branchCaseValueForFirstFlow: false
      });

      if (trueTail === split) {
        const trueFlow = createSequenceFlowBetween(microflows, document, split, merge);
        setSequenceFlowBooleanCaseValue(microflows, trueFlow, true);
      } else {
        createSequenceFlowBetween(microflows, document, trueTail, merge);
      }
      if (falseTail === split) {
        const falseFlow = createSequenceFlowBetween(microflows, document, split, merge);
        setSequenceFlowBooleanCaseValue(microflows, falseFlow, false);
      } else {
        createSequenceFlowBetween(microflows, document, falseTail, merge);
      }
      const branchValidation = validateDecisionBranchFlowsShared(split, document.flows);
      if (!branchValidation.ok) {
        throw new Error(
          `Decision in "${document.name}" must have exactly one true and one false outgoing flow; got true=${branchValidation.trueCount}, false=${branchValidation.falseCount}.`
        );
      }

      current = merge;
      continue;
    }

    const created = createActionActivityForSpec({
      microflows,
      datatypes,
      texts,
      model,
      moduleName,
      document,
      objectCollection: document.objectCollection,
      actionSpec,
      microflowRefsByRef,
      nanoflowRefsByRef,
      createdMicroflowsByRef,
      createdNanoflowsByRef,
      variableEntityByName
    });

    if (!created || !created.activity) continue;
    const flow = createSequenceFlowBetween(microflows, document, current, created.activity);
    if (current === previousObject && branchCaseValueForFirstFlow !== null) {
      setSequenceFlowBooleanCaseValue(microflows, flow, Boolean(branchCaseValueForFirstFlow));
      branchCaseValueForFirstFlow = null;
    }
    current = created.activity;
  }

  return current;
}

function buildDocumentBody({
  microflows,
  datatypes,
  texts,
  model,
  moduleName,
  document,
  spec,
  microflowRefsByRef,
  nanoflowRefsByRef,
  createdMicroflowsByRef,
  createdNanoflowsByRef
}) {
  clearMicroflowBody(document);
  const variableEntityByName = {};
  const state = {
    returnExpression: ""
  };

  createParameterObjects({
    microflows,
    datatypes,
    model,
    moduleName,
    document,
    spec,
    variableEntityByName
  });

  const objectCollection = document.objectCollection;
  const start = microflows.StartEvent.createIn(objectCollection);
  const actions = Array.isArray(spec.actions) ? spec.actions : [];

  const tail = buildActionSequence({
    microflows,
    datatypes,
    texts,
    model,
    moduleName,
    document,
    spec,
    actions,
    previousObject: start,
    microflowRefsByRef,
    nanoflowRefsByRef,
    createdMicroflowsByRef,
    createdNanoflowsByRef,
    variableEntityByName,
    state
  });

  const end = microflows.EndEvent.createIn(objectCollection);
  if (state.returnExpression && "returnValue" in end) {
    end.returnValue = state.returnExpression;
  }
  createSequenceFlowBetween(microflows, document, tail, end);
}

function setDocumentReturnType({ datatypes, model, moduleName, document, returnTypeSpec }) {
  createTypeOnContainer({
    datatypes,
    model,
    container: document,
    typeSpec: returnTypeSpec || { kind: "Void" },
    moduleName
  });
}

function getDocumentQualifiedName(document, moduleName) {
  return document.qualifiedName || toQualifiedName(moduleName, document.name);
}

function normalizeSpecs(section = {}) {
  if (Array.isArray(section.specs)) return section.specs;
  if (Array.isArray(section.items)) return section.items;
  return [];
}

function toUniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function getByNameReferenceListQualifiedNames(owner, propertyName) {
  const rawProperty = owner && propertyName ? owner[propertyName] : null;
  if (!rawProperty || typeof rawProperty.qualifiedNames !== "function") {
    return [];
  }
  return toUniqueStrings(rawProperty.qualifiedNames());
}

function replaceByNameReferenceListQualifiedNames(owner, propertyName, qualifiedNames) {
  const rawProperty = owner && propertyName ? owner[propertyName] : null;
  if (!rawProperty || typeof rawProperty.updateWithRawValue !== "function") {
    return false;
  }
  rawProperty.updateWithRawValue(toUniqueStrings(qualifiedNames));
  return true;
}

async function materializeElement(element) {
  if (!element) return null;
  if (typeof element.load === "function") {
    return element.load();
  }
  return element;
}

async function resolveModuleRoleQualifiedNames({ model, moduleName, refs = [] }) {
  const out = [];
  for (const rawRef of Array.isArray(refs) ? refs : []) {
    const ref = String(rawRef || "").trim();
    if (!ref) continue;

    const candidates = [];
    if (ref.includes(".")) candidates.push(ref);
    if (!ref.includes(".") && moduleName) candidates.push(`${moduleName}.${ref}`);
    candidates.push(ref);

    let resolvedQname = "";
    if (typeof model.findModuleRoleByQualifiedName === "function") {
      for (const candidate of candidates) {
        const found = model.findModuleRoleByQualifiedName(candidate);
        if (found) {
          resolvedQname = String(found.qualifiedName || candidate).trim();
          break;
        }
      }
    }

    if (!resolvedQname && typeof model.allModuleRoles === "function") {
      const roleIfaces = Array.isArray(model.allModuleRoles()) ? model.allModuleRoles() : [];
      for (const roleIface of roleIfaces) {
        const role = await materializeElement(roleIface);
        if (!role) continue;
        const roleQname = String(role.qualifiedName || "").trim();
        const roleName = String(role.name || "").trim();
        if (candidates.includes(roleQname) || candidates.includes(roleName)) {
          resolvedQname = roleQname || (moduleName && roleName ? `${moduleName}.${roleName}` : roleName);
          break;
        }
      }
    }

    if (!resolvedQname) {
      throw new Error(`Could not resolve module role "${ref}" for microflow security.`);
    }
    out.push(resolvedQname);
  }

  return toUniqueStrings(out);
}

async function applyAllowedRolesToDocument({ model, moduleName, document, allowedRoles }) {
  const refs = toUniqueStrings(allowedRoles);
  if (refs.length === 0 || !document) return;

  const qualifiedNames = await resolveModuleRoleQualifiedNames({ model, moduleName, refs });
  if (qualifiedNames.length === 0) return;

  if (replaceByNameReferenceListQualifiedNames(document, "__allowedModuleRoles", qualifiedNames)) {
    return;
  }

  if (Array.isArray(document.allowedModuleRolesQualifiedNames)) {
    document.allowedModuleRolesQualifiedNames = qualifiedNames.slice();
    return;
  }

  throw new Error(`Could not assign allowed module roles to microflow "${document.name}".`);
}

async function applyMicroflowPlanToModel({
  model,
  moduleName = "MyFirstModule",
  microflowsPlan = {},
  nanoflowsPlan = {},
  deleteExisting = true
}) {
  const { microflows, datatypes, texts } = loadModelNamespaces();
  const module = await findModule(model, moduleName);
  if (!module) {
    throw new Error(`Module "${moduleName}" not found for microflow generation.`);
  }

  const microflowSpecs = normalizeSpecs(microflowsPlan);
  const nanoflowSpecs = normalizeSpecs(nanoflowsPlan);

  const clearMicroflows =
    microflowsPlan.clearExisting !== undefined ? microflowsPlan.clearExisting : deleteExisting;
  const clearNanoflows = nanoflowsPlan.clearExisting !== undefined ? nanoflowsPlan.clearExisting : deleteExisting;

  if (clearMicroflows) {
    for (const spec of microflowSpecs) {
      if (spec && spec.name) {
        await deleteMicroflowIfExists(model, moduleName, spec.name);
      }
    }
  }

  if (clearNanoflows) {
    for (const spec of nanoflowSpecs) {
      if (spec && spec.name) {
        await deleteNanoflowIfExists(model, moduleName, spec.name);
      }
    }
  }

  const createdMicroflowsByRef = {};
  const createdNanoflowsByRef = {};
  const microflowRefsByRef = {};
  const nanoflowRefsByRef = {};

  for (const spec of microflowSpecs) {
    if (!spec || typeof spec !== "object") continue;
    if (!spec.name || typeof spec.name !== "string") {
      throw new Error("Each microflow spec requires a string name.");
    }

    const document = microflows.Microflow.createIn(module);
    document.name = spec.name;
    if (spec.documentation && "documentation" in document) {
      document.documentation = String(spec.documentation);
    }

    await applyAllowedRolesToDocument({
      model,
      moduleName,
      document,
      allowedRoles: spec.allowedRoles || spec.allowedModuleRoles || []
    });

    setDocumentReturnType({
      datatypes,
      model,
      moduleName,
      document,
      returnTypeSpec: spec.returnType || { kind: "Void" }
    });

    const qname = getDocumentQualifiedName(document, moduleName);
    if (spec.ref) {
      createdMicroflowsByRef[spec.ref] = document;
      microflowRefsByRef[spec.ref] = qname;
    }
  }

  for (const spec of nanoflowSpecs) {
    if (!spec || typeof spec !== "object") continue;
    if (!spec.name || typeof spec.name !== "string") {
      throw new Error("Each nanoflow spec requires a string name.");
    }

    const document = microflows.Nanoflow.createIn(module);
    document.name = spec.name;
    if (spec.documentation && "documentation" in document) {
      document.documentation = String(spec.documentation);
    }

    await applyAllowedRolesToDocument({
      model,
      moduleName,
      document,
      allowedRoles: spec.allowedRoles || spec.allowedModuleRoles || []
    });

    setDocumentReturnType({
      datatypes,
      model,
      moduleName,
      document,
      returnTypeSpec: spec.returnType || { kind: "Void" }
    });

    const qname = getDocumentQualifiedName(document, moduleName);
    if (spec.ref) {
      createdNanoflowsByRef[spec.ref] = document;
      nanoflowRefsByRef[spec.ref] = qname;
    }
  }

  for (const spec of microflowSpecs) {
    const document = spec.ref ? createdMicroflowsByRef[spec.ref] : null;
    const target = document || model.findMicroflowByQualifiedName(toQualifiedName(moduleName, spec.name));
    if (!target) {
      throw new Error(`Could not load created microflow "${spec.name}".`);
    }

    buildDocumentBody({
      microflows,
      datatypes,
      texts,
      model,
      moduleName,
      document: target,
      spec,
      microflowRefsByRef,
      nanoflowRefsByRef,
      createdMicroflowsByRef,
      createdNanoflowsByRef
    });
  }

  for (const spec of nanoflowSpecs) {
    const document = spec.ref ? createdNanoflowsByRef[spec.ref] : null;
    const target = document || model.findNanoflowByQualifiedName(toQualifiedName(moduleName, spec.name));
    if (!target) {
      throw new Error(`Could not load created nanoflow "${spec.name}".`);
    }

    buildDocumentBody({
      microflows,
      datatypes,
      texts,
      model,
      moduleName,
      document: target,
      spec,
      microflowRefsByRef,
      nanoflowRefsByRef,
      createdMicroflowsByRef,
      createdNanoflowsByRef
    });
  }

  const microflowNames = microflowSpecs.map((s) => s.name);
  const nanoflowNames = nanoflowSpecs.map((s) => s.name);

  return {
    moduleName,
    microflowsCreated: microflowNames.length,
    nanoflowsCreated: nanoflowNames.length,
    microflowNames,
    nanoflowNames,
    microflowRefsByRef,
    nanoflowRefsByRef
  };
}

module.exports = {
  loadSdk,
  loadModelNamespaces,
  applyMicroflowPlanToModel,
  createText,
  normalizeDataTypeSpec,
  normalizeDataTypeSpecForModel,
  resolveEntityReference,
  resolveAttributeReference,
  normalizeActionType,
  isNanoflowDocument,
  resolveErrorHandlingType
};
