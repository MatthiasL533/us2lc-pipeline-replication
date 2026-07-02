const { normalizeAssociationType, supportedAssociationTypeDescription } = require("./lib/association-types");

function requireSdkPackage(pkgName) {
  return require(pkgName);
}

function loadModelNamespaces() {
  const sdk = requireSdkPackage("mendixmodelsdk");
  return {
    domainmodels: sdk.domainmodels,
    enumerations: sdk.enumerations,
    texts: sdk.texts
  };
}

function createText(texts, model, value, languageCode = "en_US") {
  const t = texts.Text.create(model);
  const tr = texts.Translation.create(model);
  tr.languageCode = languageCode;
  tr.text = value;
  t.translations.push(tr);
  return t;
}

async function findModuleDomainModel(model, moduleName) {
  const dmIface = model
    .allDomainModels()
    .find((dm) => dm.containerAsModule && dm.containerAsModule.name === moduleName);
  if (!dmIface) return null;
  return typeof dmIface.load === "function" ? dmIface.load() : dmIface;
}

function wipeDomainModel(domainModel) {
  for (const assoc of [...domainModel.associations]) assoc.delete();
  for (const entity of [...domainModel.entities]) entity.delete();
}

async function deleteModuleEnumerations(model, moduleName, names) {
  const set = names && names.length ? new Set(names) : null;
  const enumIfaces = model.allEnumerations();
  for (const eIface of enumIfaces) {
    const mod =
      eIface.containerAsFolderBase && eIface.containerAsFolderBase.containerAsModule
        ? eIface.containerAsFolderBase.containerAsModule
        : null;
    if (!mod || mod.name !== moduleName) continue;
    if (set && !set.has(eIface.name)) continue;
    const e = typeof eIface.load === "function" ? await eIface.load() : eIface;
    e.delete();
  }
}

function normalizeTypeDef(typeDef) {
  if (typeof typeDef === "string") {
    if (typeDef.startsWith("Enum:")) return { kind: "Enum", enumName: typeDef.split(":")[1] };
    if (typeDef.startsWith("Enumeration:")) return { kind: "Enum", enumName: typeDef.split(":")[1] };
    return { kind: typeDef };
  }

  if (typeDef && typeof typeDef === "object") {
    if (typeDef.enum) return { kind: "Enum", enumName: typeDef.enum };
    if (typeDef.kind === "Enum" && typeDef.enumName) return { kind: "Enum", enumName: typeDef.enumName };
    if (typeDef.kind) return { kind: typeDef.kind };
  }

  return { kind: "String" };
}

function normalizeDefaultValue(normalizedType, defaultValue) {
  const kind = normalizedType.kind;

  if (kind === "Boolean") {
    if (defaultValue === undefined || defaultValue === null) return "false";
    if (typeof defaultValue === "boolean") return defaultValue ? "true" : "false";
    const text = String(defaultValue).toLowerCase();
    if (text === "true" || text === "false") return text;
    return "false";
  }

  if (defaultValue === undefined || defaultValue === null) return null;

  if (kind === "Integer" || kind === "Long" || kind === "AutoNumber" || kind === "Decimal") {
    return String(defaultValue);
  }

  if (kind === "DateTime") {
    return String(defaultValue);
  }

  if (kind === "String" || kind === "UUID") {
    return String(defaultValue);
  }

  if (kind === "Enum") {
    return String(defaultValue);
  }

  return String(defaultValue);
}

function createAttributeType(domainmodels, attribute, typeDef, enumDocsByName) {
  const normalized = normalizeTypeDef(typeDef);
  const kind = normalized.kind;

  if (kind === "String" || kind === "UUID") {
    return domainmodels.StringAttributeType.createInAttributeUnderType(attribute);
  }
  if (kind === "Integer") {
    return domainmodels.IntegerAttributeType.createInAttributeUnderType(attribute);
  }
  if (kind === "Long") {
    return domainmodels.LongAttributeType.createInAttributeUnderType(attribute);
  }
  if (kind === "AutoNumber") {
    return domainmodels.AutoNumberAttributeType.createInAttributeUnderType(attribute);
  }
  if (kind === "Decimal") {
    return domainmodels.DecimalAttributeType.createInAttributeUnderType(attribute);
  }
  if (kind === "Boolean") {
    return domainmodels.BooleanAttributeType.createInAttributeUnderType(attribute);
  }
  if (kind === "DateTime") {
    return domainmodels.DateTimeAttributeType.createInAttributeUnderType(attribute);
  }
  if (kind === "Enum") {
    const enumName = normalized.enumName;
    const enumDoc = enumDocsByName.get(enumName);
    if (!enumDoc) {
      throw new Error(`Enumeration "${enumName}" not found for attribute "${attribute.name}"`);
    }
    const enumType = domainmodels.EnumerationAttributeType.createInAttributeUnderType(attribute);
    enumType.enumeration = enumDoc;
    return enumType;
  }

  throw new Error(`Unsupported attribute type "${kind}" for "${attribute.name}"`);
}

function applyAttributeDefaultValue(attribute, attrSpec) {
  if (!attribute || !attribute.value || !("defaultValue" in attribute.value)) return;

  const normalizedType = normalizeTypeDef(attrSpec.type || "String");
  let candidateDefault = attrSpec.defaultValue;

  const normalized = normalizeDefaultValue(normalizedType, candidateDefault);
  if (normalized !== null) {
    attribute.value.defaultValue = normalized;
  }
}

function addRequiredValidationRule(domainmodels, texts, model, entity, attribute) {
  const vr = domainmodels.ValidationRule.createIn(entity);
  vr.attribute = attribute;
  vr.ruleInfo = domainmodels.RequiredRuleInfo.createIn(vr);
  vr.errorMessage = createText(texts, model, `${entity.name}.${attribute.name} is required`);
}

function resolveEntityRef(entitiesByName, ref) {
  if (entitiesByName.has(ref)) return entitiesByName.get(ref);
  if (typeof ref === "string" && ref.includes(".")) {
    const simple = ref.split(".").pop();
    if (entitiesByName.has(simple)) return entitiesByName.get(simple);
  }
  return null;
}

function resolveAssociationType(domainmodels, type) {
  const normalized = normalizeAssociationType(type);
  if (!normalized.ok) {
    throw new Error(
      `Unsupported association type "${type}". Expected ${supportedAssociationTypeDescription()}.`
    );
  }
  if (normalized.type === "ReferenceSet") {
    return domainmodels.AssociationType.ReferenceSet;
  }
  if (normalized.type === "Reference") {
    return domainmodels.AssociationType.Reference;
  }
  throw new Error(
    `Unsupported association type "${type}". Expected ${supportedAssociationTypeDescription()}.`
  );
}

function resolveAssociationOwner(domainmodels, owner, options = {}) {
  const isSelfReferential = options && options.isSelfReferential === true;
  if (isSelfReferential) {
    return domainmodels.AssociationOwner.Default;
  }
  const normalized = String(owner || "Both").toLowerCase();
  if (normalized === "both") return domainmodels.AssociationOwner.Both;
  if (normalized === "default") return domainmodels.AssociationOwner.Default;
  throw new Error(`Unsupported association owner "${owner}". Expected "Both" or "Default".`);
}

async function ensureEnumerations({
  model,
  module,
  moduleName,
  plan,
  clearExistingEnumerations,
  enumerations,
  texts
}) {
  const enumSpecs = plan.enumerations || [];
  if (!enumSpecs.length) return new Map();

  if (clearExistingEnumerations) {
    await deleteModuleEnumerations(
      model,
      moduleName,
      enumSpecs.map((e) => e.name)
    );
  }

  const enumDocsByName = new Map();
  for (const enumSpec of enumSpecs) {
    const enumDoc = enumerations.Enumeration.createIn(module);
    enumDoc.name = enumSpec.name;

    for (const rawValue of enumSpec.values || []) {
      const valueSpec = typeof rawValue === "string" ? { name: rawValue, caption: rawValue } : rawValue;
      const value = enumerations.EnumerationValue.createIn(enumDoc);
      value.name = valueSpec.name;
      value.caption = createText(texts, model, valueSpec.caption || valueSpec.name);
    }

    enumDocsByName.set(enumSpec.name, enumDoc);
  }

  return enumDocsByName;
}

function createEntities({
  domainModel,
  model,
  plan,
  domainmodels,
  texts,
  enumDocsByName
}) {
  const entitiesByName = new Map();
  let autoX = 120;
  let autoY = 120;

  for (const entitySpec of plan.entities || []) {
    const entity = domainmodels.Entity.createIn(domainModel);
    entity.name = entitySpec.name;
    entity.documentation = entitySpec.documentation || "";
    entity.location = entitySpec.location || { x: autoX, y: autoY };

    autoX += 160;
    if (autoX > 900) {
      autoX = 120;
      autoY += 160;
    }

    for (const attrSpec of entitySpec.attributes || []) {
      const attribute = domainmodels.Attribute.createIn(entity);
      attribute.name = attrSpec.name;
      attribute.documentation = attrSpec.documentation || "";
      createAttributeType(domainmodels, attribute, attrSpec.type || "String", enumDocsByName);
      applyAttributeDefaultValue(attribute, attrSpec);
      if (attrSpec.required === true) {
        addRequiredValidationRule(domainmodels, texts, model, entity, attribute);
      }
    }

    entitiesByName.set(entity.name, entity);
  }

  return entitiesByName;
}

function createAssociations({ domainModel, plan, domainmodels, entitiesByName }) {
  for (const assocSpec of plan.associations || []) {
    const parent = resolveEntityRef(entitiesByName, assocSpec.parentEntity || assocSpec.from);
    const child = resolveEntityRef(entitiesByName, assocSpec.childEntity || assocSpec.to);

    if (!parent || !child) {
      throw new Error(
        `Association references missing entities: parent="${assocSpec.parentEntity || assocSpec.from}", child="${assocSpec.childEntity || assocSpec.to}"`
      );
    }

    const association = domainmodels.Association.createIn(domainModel);
    association.name = assocSpec.name || `${parent.name}_${child.name}`;
    association.documentation = assocSpec.documentation || "";
    association.parent = parent;
    association.child = child;
    association.type = resolveAssociationType(domainmodels, assocSpec.type);
    association.owner = resolveAssociationOwner(domainmodels, assocSpec.owner, {
      isSelfReferential: parent.id === child.id
    });
  }
}

async function applyDomainModelPlanToModel({
  model,
  moduleName = "MyFirstModule",
  domainModelPlan = {},
  deleteExisting = true
}) {
  const { domainmodels, enumerations, texts } = loadModelNamespaces();

  const domainModel = await findModuleDomainModel(model, moduleName);
  if (!domainModel) {
    throw new Error(`Domain model for module "${moduleName}" not found.`);
  }

  const module = domainModel.containerAsModule;
  const shouldClear = domainModelPlan.clearExisting !== undefined ? domainModelPlan.clearExisting : deleteExisting;
  const clearEnums =
    domainModelPlan.clearExistingEnumerations !== undefined
      ? domainModelPlan.clearExistingEnumerations
      : shouldClear;

  if (shouldClear) {
    wipeDomainModel(domainModel);
  }

  const enumDocsByName = await ensureEnumerations({
    model,
    module,
    moduleName,
    plan: domainModelPlan,
    clearExistingEnumerations: clearEnums,
    enumerations,
    texts
  });

  const entitiesByName = createEntities({
    domainModel,
    model,
    plan: domainModelPlan,
    domainmodels,
    texts,
    enumDocsByName
  });

  createAssociations({
    domainModel,
    plan: domainModelPlan,
    domainmodels,
    entitiesByName
  });

  return {
    moduleName,
    entitiesCreated: (domainModelPlan.entities || []).length,
    associationsCreated: (domainModelPlan.associations || []).length,
    enumerationsCreated: (domainModelPlan.enumerations || []).length
  };
}

module.exports = {
  applyDomainModelPlanToModel,
  loadModelNamespaces,
  _private: {
    normalizeTypeDef,
    normalizeDefaultValue,
    applyAttributeDefaultValue
  }
};
