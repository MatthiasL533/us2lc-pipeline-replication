const fs = require("fs");
const path = require("path");
const { buildStepHandlerRegistry, validateStepSpecAgainstRegistry, normalizeStepType } = require("./lib/guards");
const textStepDefs = require("./lib/steps/text");
const navigationStepDefs = require("./lib/steps/navigation");
const dataViewStepDefs = require("./lib/steps/data-view");
const lookupStepDefs = require("./lib/steps/lookup");
const actionStepDefs = require("./lib/steps/actions");
const layoutLib = require("./lib/layout");
const contextLib = require("./lib/context");
const refResolutionLib = require("./lib/ref-resolution");

function requireSdkPackage(pkgName) {
  return require(pkgName);
}

function loadSdk() {
  const platform = requireSdkPackage("mendixplatformsdk");
  const model = requireSdkPackage("mendixmodelsdk");
  return { platform, model };
}

function createText(texts, model, value, languageCode = "en_US") {
  const t = texts.Text.create(model);
  const tr = texts.Translation.create(model);
  tr.languageCode = languageCode;
  tr.text = String(value || "");
  t.translations.push(tr);
  return t;
}

function createClientTemplate(pages, texts, model, value, languageCode = "en_US") {
  const template = pages.ClientTemplate.create(model);
  template.template = createText(texts, model, value, languageCode);
  return template;
}

function discoverCreatableWidgets(pages, createMethod = "createInLayoutCallArgumentUnderWidgets") {
  return layoutLib.discoverCreatableWidgets(pages, createMethod);
}

function getContainerTypeName(container) {
  return layoutLib.getContainerTypeName(container);
}

function rankCreateMethod(methodName, containerTypeName) {
  return layoutLib.rankCreateMethod(methodName, containerTypeName);
}

function discoverCreateMethodsForContainer(ctor, container) {
  return layoutLib.discoverCreateMethodsForContainer(ctor, container);
}

function createWidgetByClassName({ pages, className, container, createMethod = "" }) {
  const ctor = pages[className];
  if (!ctor) {
    throw new Error(`Unknown widget class "${className}" in pages namespace.`);
  }

  if (createMethod) {
    if (typeof ctor[createMethod] !== "function") {
      throw new Error(`Class "${className}" does not support ${createMethod}.`);
    }
    return ctor[createMethod](container);
  }

  const methods = discoverCreateMethodsForContainer(ctor, container);
  const errors = [];
  for (const method of methods) {
    try {
      return ctor[method](container);
    } catch (err) {
      errors.push(`${method}: ${err && err.message ? err.message : err}`);
    }
  }

  const details = errors.length ? ` Tried methods: ${errors.join(" | ")}` : "";
  throw new Error(`Could not create widget "${className}".${details}`);
}

function createCustomWidget({ customwidgets, container, createMethod = "" }) {
  const ctor = customwidgets && customwidgets.CustomWidget;
  if (!ctor) {
    throw new Error("CustomWidget support is unavailable in this SDK build.");
  }

  if (createMethod) {
    if (typeof ctor[createMethod] !== "function") {
      throw new Error(`CustomWidget does not support ${createMethod}.`);
    }
    return ctor[createMethod](container);
  }

  const methods = discoverCreateMethodsForContainer(ctor, container);
  const errors = [];
  for (const method of methods) {
    try {
      return ctor[method](container);
    } catch (err) {
      errors.push(`${method}: ${err && err.message ? err.message : err}`);
    }
  }

  const details = errors.length ? ` Tried methods: ${errors.join(" | ")}` : "";
  throw new Error(`Could not create CustomWidget.${details}`);
}

function setLayoutArgParameterRawQname(arg, qname) {
  const internalRef = arg && (arg.__parameter || arg._parameter || arg["__parameter"] || arg["_parameter"]);
  if (!internalRef || typeof internalRef.updateWithRawValue !== "function") return false;
  internalRef.updateWithRawValue(qname);
  return true;
}

function setByNameReferenceRaw(element, propName, qname) {
  if (!element || !propName || !qname) return false;
  const candidates = [
    `__${propName}`,
    `_${propName}`,
    `__${propName.charAt(0).toUpperCase()}${propName.slice(1)}`,
    `_${propName.charAt(0).toUpperCase()}${propName.slice(1)}`
  ];

  for (const key of candidates) {
    const ref = element[key];
    if (ref && typeof ref.updateWithRawValue === "function") {
      ref.updateWithRawValue(qname);
      return true;
    }
  }
  return false;
}

function getLayoutArgParameterQname(arg) {
  if (!arg) return null;
  if (arg.parameterQualifiedName) return arg.parameterQualifiedName;

  const internalRef = arg.__parameter || arg._parameter || arg["__parameter"] || arg["_parameter"];
  if (internalRef && typeof internalRef.qualifiedName === "function") {
    const qname = internalRef.qualifiedName();
    if (qname) return qname;
  }

  if (typeof arg.toJSON === "function") {
    try {
      const raw = arg.toJSON();
      if (raw && typeof raw.parameter === "string" && raw.parameter.length > 0) return raw.parameter;
    } catch (_err) {
      // ignore
    }
  }

  return null;
}

function layoutRefMatches(layoutRef, targetLayout) {
  if (!layoutRef || !targetLayout) return false;
  if (layoutRef.id && targetLayout.id && layoutRef.id === targetLayout.id) return true;
  if (layoutRef.qualifiedName && targetLayout.qualifiedName && layoutRef.qualifiedName === targetLayout.qualifiedName) {
    return true;
  }
  if (layoutRef.name && targetLayout.name && layoutRef.name === targetLayout.name) return true;
  return false;
}

function entityRefMatches(left, right) {
  if (!left || !right) return false;
  if (left.id && right.id && left.id === right.id) return true;
  if (left.qualifiedName && right.qualifiedName && left.qualifiedName === right.qualifiedName) return true;
  if (left.name && right.name && left.name === right.name) return true;
  return false;
}

async function findModule(model, moduleName) {
  const moduleIface =
    typeof model.allModules === "function"
      ? model.allModules().find((m) => m && m.name === moduleName)
      : null;
  if (!moduleIface) return null;
  return typeof moduleIface.load === "function" ? moduleIface.load() : moduleIface;
}

function getRoleQualifiedName(role, moduleName) {
  if (!role) return "";
  if (typeof role.qualifiedName === "string" && role.qualifiedName.length > 0) return role.qualifiedName;
  if (role.name && moduleName) return `${moduleName}.${role.name}`;
  return "";
}

function resolveModuleRoleReferences({ model, moduleName, refs = [], availableRoles = [] }) {
  const results = [];
  const seen = new Set();
  const byQname = new Map();
  const byName = new Map();

  for (const role of availableRoles) {
    const qname = getRoleQualifiedName(role, moduleName);
    if (qname) byQname.set(qname, role);
    if (role && role.name) byName.set(role.name, role);
  }

  function push(role) {
    if (!role) return;
    const key = role.id || getRoleQualifiedName(role, moduleName) || role.name;
    if (!key || seen.has(key)) return;
    seen.add(key);
    results.push(role);
  }

  for (const rawRef of refs) {
    const ref = String(rawRef || "").trim();
    if (!ref) continue;

    let found = null;
    if (ref.includes(".") && typeof model.findModuleRoleByQualifiedName === "function") {
      found = model.findModuleRoleByQualifiedName(ref);
    }
    if (!found && moduleName && typeof model.findModuleRoleByQualifiedName === "function") {
      found = model.findModuleRoleByQualifiedName(`${moduleName}.${ref}`);
    }
    if (!found && byQname.has(ref)) found = byQname.get(ref);
    if (!found && byName.has(ref)) found = byName.get(ref);

    push(found);
  }

  return results;
}

async function getOrCreateModuleRolesForPages({ module, moduleName, security }) {
  if (!module) return [];

  let loadedModule = module;
  if (loadedModule && typeof loadedModule.load === "function") {
    loadedModule = await loadedModule.load();
  }

  let moduleSecurity = loadedModule && loadedModule.moduleSecurity ? loadedModule.moduleSecurity : null;
  if (
    !moduleSecurity &&
    security &&
    security.ModuleSecurity &&
    typeof security.ModuleSecurity.createIn === "function"
  ) {
    moduleSecurity = security.ModuleSecurity.createIn(loadedModule);
  }
  if (moduleSecurity && typeof moduleSecurity.load === "function") {
    moduleSecurity = await moduleSecurity.load();
  }

  let roles = moduleSecurity && moduleSecurity.moduleRoles ? [...moduleSecurity.moduleRoles] : [];

  if (roles.length === 0 && security && security.ModuleRole && typeof security.ModuleRole.createIn === "function" && moduleSecurity) {
    const generatedRole = security.ModuleRole.createIn(moduleSecurity);
    generatedRole.name = "GeneratedUser";
    roles = [generatedRole];
  }

  return roles;
}

function applyPageAllowedRoles({
  page,
  pageSpec = {},
  model,
  moduleName,
  availableModuleRoles = []
}) {
  if (!page || !("allowedRoles" in page) || !page.allowedRoles) return;

  const explicitRefs = Array.isArray(pageSpec.allowedRoles)
    ? pageSpec.allowedRoles
    : Array.isArray(pageSpec.allowedModuleRoles)
      ? pageSpec.allowedModuleRoles
      : [];

  const rolesToAssign =
    explicitRefs.length > 0
      ? resolveModuleRoleReferences({
          model,
          moduleName,
          refs: explicitRefs,
          availableRoles: availableModuleRoles
        })
      : availableModuleRoles;

  if (!Array.isArray(rolesToAssign) || rolesToAssign.length === 0) return;

  clearList(page.allowedRoles);
  for (const role of rolesToAssign) {
    page.allowedRoles.push(role);
  }
}

async function createPageInModuleContainer({ pages, model, moduleName, module, pageNameForError }) {
  const targetModule = module || (await findModule(model, moduleName));
  if (!targetModule) {
    throw new Error(`Could not create page "${pageNameForError}": module "${moduleName}" was not found.`);
  }

  // Keep containment strict and deterministic: always create pages in a loaded Module.
  const loadedModule =
    typeof targetModule.load === "function" ? await targetModule.load() : targetModule;

  try {
    return pages.Page.createIn(loadedModule);
  } catch (err) {
    const moduleLabel = loadedModule && loadedModule.name ? loadedModule.name : moduleName;
    throw new Error(
      `Could not create page "${pageNameForError}" in module "${moduleLabel}": ${
        err && err.message ? err.message : err
      }`
    );
  }
}

async function findLayout(model, layoutQualifiedName) {
  let layoutIface = null;
  if (layoutQualifiedName) {
    layoutIface = model.findLayoutByQualifiedName(layoutQualifiedName);
  }
  if (!layoutIface && layoutQualifiedName) {
    const simple = layoutQualifiedName.split(".").pop();
    layoutIface = model.allLayouts().find((l) => l.name === simple) || null;
  }
  if (!layoutIface) return null;
  return typeof layoutIface.load === "function" ? layoutIface.load() : layoutIface;
}

async function deriveLayoutParameterQnameFromExistingUsage(model, layout) {
  for (const pageIface of model.allPages()) {
    let page = null;
    try {
      page = typeof pageIface.load === "function" ? await pageIface.load() : pageIface;
    } catch (_err) {
      continue;
    }
    if (!page.layoutCall || !layoutRefMatches(page.layoutCall.layout, layout)) continue;
    if (!page.layoutCall.arguments || page.layoutCall.arguments.length === 0) continue;
    const qname = getLayoutArgParameterQname(page.layoutCall.arguments[0]);
    if (qname) return qname;
  }

  for (const templateIface of model.allPageTemplates()) {
    let template = null;
    try {
      template = typeof templateIface.load === "function" ? await templateIface.load() : templateIface;
    } catch (_err) {
      continue;
    }
    if (!template.layoutCall || !layoutRefMatches(template.layoutCall.layout, layout)) continue;
    if (!template.layoutCall.arguments || template.layoutCall.arguments.length === 0) continue;
    const qname = getLayoutArgParameterQname(template.layoutCall.arguments[0]);
    if (qname) return qname;
  }

  return null;
}

async function resolveLayoutArgumentConfig({
  model,
  layoutQualifiedName,
  layoutParameterQname = "",
  fallbackParameterNames = []
}) {
  const layout = await findLayout(model, layoutQualifiedName);
  if (!layout) {
    throw new Error(`Layout "${layoutQualifiedName}" not found.`);
  }

  let resolvedLayoutParameterQname =
    layoutParameterQname || (await deriveLayoutParameterQnameFromExistingUsage(model, layout));

  if (!resolvedLayoutParameterQname) {
    const candidateNames = [
      ...new Set(
        (fallbackParameterNames || []).concat(["Main", "Content", "content", "MainContent", "main"]).filter(Boolean)
      )
    ];
    for (const candidateName of candidateNames) {
      const qname = `${layout.qualifiedName}.${candidateName}`;
      if (model.findLayoutParameterByQualifiedName(qname)) {
        resolvedLayoutParameterQname = qname;
        break;
      }
    }
  }

  if (!resolvedLayoutParameterQname) {
    throw new Error(
      `Could not derive layout parameter qname for "${layout.qualifiedName}". ` +
        "Provide layoutParameterQname explicitly."
    );
  }

  return { layout, layoutParameterQname: resolvedLayoutParameterQname };
}

async function deletePageIfExists(model, moduleName, pageName) {
  const pageIface = model.allPages().find((p) => {
    if (!p || p.name !== pageName) return false;
    try {
      return (
        p.containerAsFolderBase &&
        p.containerAsFolderBase.containerAsModule &&
        p.containerAsFolderBase.containerAsModule.name === moduleName
      );
    } catch (_err) {
      const qname = String((p && p.qualifiedName) || "");
      return qname.split(".")[0] === moduleName;
    }
  });
  if (!pageIface) return;
  if (typeof pageIface.delete === "function") {
    pageIface.delete();
    return;
  }
  const page = typeof pageIface.load === "function" ? await pageIface.load() : pageIface;
  page.delete();
}

function toUniqueStrings(values) {
  return contextLib.toUniqueStrings(values);
}

function getEntityQualifiedName(entity) {
  if (!entity) return "";
  if (typeof entity.qualifiedName === "string" && entity.qualifiedName.length > 0) return entity.qualifiedName;
  if (
    entity.name &&
    entity.containerAsDomainModel &&
    entity.containerAsDomainModel.containerAsModule &&
    entity.containerAsDomainModel.containerAsModule.name
  ) {
    return `${entity.containerAsDomainModel.containerAsModule.name}.${entity.name}`;
  }
  return "";
}

function resolveEntityReference(model, moduleName, rawEntityRef) {
  if (!rawEntityRef) return null;
  const raw = String(rawEntityRef).trim();
  if (!raw) return null;

  const candidates = [];
  const simple = raw.includes(".") ? raw.split(".").pop() : raw;

  if (raw.includes(".")) candidates.push(raw);
  if (moduleName && simple) candidates.push(`${moduleName}.${simple}`);

  if (typeof model.allDomainModels === "function" && simple) {
    for (const dm of model.allDomainModels()) {
      const mod = dm && dm.containerAsModule;
      if (mod && mod.name) candidates.push(`${mod.name}.${simple}`);
    }
  }

  for (const qname of toUniqueStrings(candidates)) {
    const entity = model.findEntityByQualifiedName(qname);
    if (entity) return entity;
  }

  return null;
}

function normalizeEntityQualifiedName(rawEntityRef, moduleName) {
  return refResolutionLib.normalizeEntityQualifiedName(rawEntityRef, moduleName);
}

function resolveAttributeReference({ model, entity, rawAttributeRef }) {
  if (!rawAttributeRef) return null;
  const raw = String(rawAttributeRef).trim();
  if (!raw) return null;

  const entityQname = getEntityQualifiedName(entity);
  const candidates = [raw];
  if (!raw.includes(".") && entityQname) {
    candidates.unshift(`${entityQname}.${raw}`);
  }

  for (const qname of toUniqueStrings(candidates)) {
    const attr = model.findAttributeByQualifiedName(qname);
    if (attr) return attr;
  }

  return null;
}

function getAssociationQualifiedName(association) {
  if (!association) return "";
  if (typeof association.qualifiedName === "string" && association.qualifiedName.length > 0) {
    return association.qualifiedName;
  }
  if (
    association.name &&
    association.containerAsDomainModel &&
    association.containerAsDomainModel.containerAsModule &&
    association.containerAsDomainModel.containerAsModule.name
  ) {
    return `${association.containerAsDomainModel.containerAsModule.name}.${association.name}`;
  }
  return "";
}

function associationTypeToString(association) {
  const value = association ? association.type : null;
  if (!value) return "";
  if (typeof value === "string") return value.toLowerCase();
  if (typeof value === "object") {
    if (typeof value.name === "string" && value.name) return value.name.toLowerCase();
    if (typeof value.literalName === "string" && value.literalName) return value.literalName.toLowerCase();
    if (typeof value.qualifiedTsTypeName === "string" && value.qualifiedTsTypeName) {
      return value.qualifiedTsTypeName.toLowerCase();
    }
  }
  try {
    return String(value).toLowerCase();
  } catch (_err) {
    return "";
  }
}

function isReferenceSetAssociation(association) {
  const type = associationTypeToString(association);
  return type.includes("referenceset") || type.includes("many-to-many");
}

function collectAssociationsFromModel(model) {
  if (!model || typeof model.allDomainModels !== "function") return [];
  const out = [];
  for (const dm of model.allDomainModels()) {
    const associations = toArrayFromList(tryReadProperty(dm, "associations"));
    for (const assoc of associations) {
      if (assoc) out.push(assoc);
    }
  }
  return out;
}

function resolveAssociationReference({ model, moduleName, rawAssociationRef }) {
  if (!rawAssociationRef) return null;
  const raw = String(rawAssociationRef).trim();
  if (!raw) return null;

  const candidates = [];
  const simple = raw.includes(".") ? raw.split(".").pop() : raw;
  if (raw.includes(".")) candidates.push(raw);
  if (moduleName && simple) candidates.push(`${moduleName}.${simple}`);

  for (const qname of toUniqueStrings(candidates)) {
    if (typeof model.findAssociationByQualifiedName === "function") {
      const assoc = model.findAssociationByQualifiedName(qname);
      if (assoc) return assoc;
    }
  }

  const allAssociations = collectAssociationsFromModel(model);
  for (const assoc of allAssociations) {
    const qname = getAssociationQualifiedName(assoc);
    if (qname && candidates.includes(qname)) return assoc;
    if (assoc.name === simple) return assoc;
  }

  return null;
}

function findLookupAssociation({
  model,
  moduleName,
  contextEntity = null,
  targetEntity = null,
  rawAssociationRef = "",
  expectsReferenceSet = false
}) {
  let candidates = [];
  if (rawAssociationRef) {
    const explicit = resolveAssociationReference({ model, moduleName, rawAssociationRef });
    if (!explicit) {
      throw new Error(`Could not resolve association "${rawAssociationRef}".`);
    }
    candidates = [explicit];
  } else {
    if (!contextEntity || !targetEntity) {
      throw new Error(
        "Lookup input requires either associationRef or targetEntityRef with a valid page/data-view context entity."
      );
    }

    const allAssociations = collectAssociationsFromModel(model);
    candidates = allAssociations.filter((assoc) => {
      const parent = assoc ? assoc.parent : null;
      const child = assoc ? assoc.child : null;
      const contextIsParent = entityRefMatches(parent, contextEntity);
      const contextIsChild = entityRefMatches(child, contextEntity);
      const targetIsParent = entityRefMatches(parent, targetEntity);
      const targetIsChild = entityRefMatches(child, targetEntity);

      if (expectsReferenceSet) {
        return (contextIsParent && targetIsChild) || (contextIsChild && targetIsParent);
      }
      return contextIsChild && targetIsParent;
    });
  }

  const typedCandidates = candidates.filter((assoc) =>
    expectsReferenceSet ? isReferenceSetAssociation(assoc) : !isReferenceSetAssociation(assoc)
  );

  if (typedCandidates.length === 0) {
    if (expectsReferenceSet) {
      throw new Error("Could not find a reference-set association for this lookup.");
    }
    throw new Error("Could not find a reference association for this lookup.");
  }
  if (typedCandidates.length > 1) {
    const names = typedCandidates.map((a) => getAssociationQualifiedName(a) || a.name || "<unnamed>");
    throw new Error(`Lookup association is ambiguous. Provide associationRef explicitly. Candidates: ${names.join(", ")}`);
  }

  return typedCandidates[0];
}

function resolveLookupDestinationEntity({ association, contextEntity, targetEntity = null }) {
  if (!association) return null;
  const parent = association.parent || null;
  const child = association.child || null;

  if (targetEntity) {
    if (entityRefMatches(parent, targetEntity)) return parent;
    if (entityRefMatches(child, targetEntity)) return child;
    return null;
  }

  if (contextEntity) {
    if (entityRefMatches(parent, contextEntity)) return child;
    if (entityRefMatches(child, contextEntity)) return parent;
  }

  return parent || child || null;
}

function collectEntityAttributes(entity) {
  if (!entity) return [];
  return toArrayFromList(tryReadProperty(entity, "attributes"));
}

function getAttributeTypeName(attribute) {
  if (!attribute || !attribute.type) return "";
  if (typeof attribute.type.structureTypeName === "string" && attribute.type.structureTypeName.length > 0) {
    return attribute.type.structureTypeName.toLowerCase();
  }
  if (attribute.type.constructor && typeof attribute.type.constructor.name === "string") {
    return attribute.type.constructor.name.toLowerCase();
  }
  return "";
}

function isDisplayFriendlyAttribute(attribute) {
  const typeName = getAttributeTypeName(attribute);
  return (
    typeName.includes("stringattributetype") ||
    typeName.includes("enumattributetype") ||
    typeName.includes("autonumber") ||
    typeName.includes("integerattributetype") ||
    typeName.includes("longattributetype")
  );
}

function normalizeMemberName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function resolveLookupDisplayAttribute({ model, targetEntity, rawDisplayAttributeRef = "" }) {
  if (!targetEntity) return null;

  if (rawDisplayAttributeRef) {
    const explicit = resolveAttributeReference({
      model,
      entity: targetEntity,
      rawAttributeRef: rawDisplayAttributeRef
    });
    if (!explicit) {
      throw new Error(
        `Could not resolve display attribute "${rawDisplayAttributeRef}" on entity "${getEntityQualifiedName(targetEntity)}".`
      );
    }
    return explicit;
  }

  const attributes = collectEntityAttributes(targetEntity);
  if (attributes.length === 0) return null;

  const byNormalizedName = new Map();
  for (const attr of attributes) {
    if (!attr || !attr.name) continue;
    byNormalizedName.set(normalizeMemberName(attr.name), attr);
  }

  const preferredNames = [
    "name",
    "title",
    "displayname",
    "description",
    "code",
    "number",
    "identifier",
    "id"
  ];
  for (const candidate of preferredNames) {
    const attr = byNormalizedName.get(normalizeMemberName(candidate));
    if (attr) return attr;
  }

  const idSuffixAttr = attributes.find((attr) => normalizeMemberName(attr.name || "").endsWith("id"));
  if (idSuffixAttr) return idSuffixAttr;

  const friendlyAttr = attributes.find((attr) => isDisplayFriendlyAttribute(attr));
  if (friendlyAttr) return friendlyAttr;

  return attributes[0] || null;
}

function bindLookupAttributeRefOnWidget({
  domainmodels,
  widget,
  association,
  targetEntity,
  displayAttribute
}) {
  if (!domainmodels || !widget || !association || !targetEntity || !displayAttribute) return false;
  if (!("attributeRef" in widget)) return false;
  if (!domainmodels.AttributeRef || typeof domainmodels.AttributeRef.createInMemberWidgetUnderAttributeRef !== "function") {
    return false;
  }

  try {
    const attributeRef = domainmodels.AttributeRef.createInMemberWidgetUnderAttributeRef(widget);
    attributeRef.attribute = displayAttribute;

    const canCreateEntityRef =
      domainmodels.IndirectEntityRef &&
      typeof domainmodels.IndirectEntityRef.createInMemberRefUnderEntityRef === "function" &&
      domainmodels.EntityRefStep &&
      typeof domainmodels.EntityRefStep.createIn === "function";
    if (canCreateEntityRef) {
      const entityRef = domainmodels.IndirectEntityRef.createInMemberRefUnderEntityRef(attributeRef);
      const step = domainmodels.EntityRefStep.createIn(entityRef);
      step.association = association;
      step.destinationEntity = targetEntity;
    }

    return true;
  } catch (_err) {
    return false;
  }
}

function ensureAssociationSelectorXPathSource({ pages, widget, xPathConstraint }) {
  if (!widget || !("selectorSource" in widget)) return;

  let source = null;
  try {
    source = widget.selectorSource;
  } catch (_err) {
    source = null;
  }

  if (!source || source.structureTypeName !== "Pages$SelectorXPathSource") {
    if (pages.SelectorXPathSource && typeof pages.SelectorXPathSource.createIn === "function") {
      source = pages.SelectorXPathSource.createIn(widget);
    }
  }

  if (source && xPathConstraint !== undefined && xPathConstraint !== null && "xPathConstraint" in source) {
    source.xPathConstraint = String(xPathConstraint);
  }
}

function resolveEntityForStep({ model, moduleName, pageSpec = {}, step = {} }) {
  const rawRef = step.entityRef || step.entity || pageSpec.entityRef || pageSpec.entity || "";
  if (!rawRef) return null;
  return resolveEntityReference(model, moduleName, rawRef);
}

function resolveQualifiedNameRef({ model, moduleName, rawRef, mappedQname, finder, allGetter }) {
  if (!rawRef && !mappedQname) return null;

  const candidates = [];
  const mapped = typeof mappedQname === "string" ? mappedQname.trim() : "";
  const raw = typeof rawRef === "string" ? rawRef.trim() : "";

  if (mapped) candidates.push(mapped);
  if (raw && raw.includes(".")) candidates.push(raw);
  if (raw && moduleName) candidates.push(`${moduleName}.${raw}`);

  for (const qname of toUniqueStrings(candidates)) {
    const item = finder(qname);
    if (item) return item;
  }

  if (raw && typeof allGetter === "function") {
    const byName = allGetter().find((item) => item && item.name === raw);
    if (byName) return byName;
  }

  return null;
}

function resolveMicroflowReference({ model, moduleName, step = {}, microflowRefsByRef = {} }) {
  const rawRef = step.microflowRef || step.targetRef || step.microflow || step.target || "";
  const mappedQname = rawRef ? microflowRefsByRef[rawRef] || "" : "";
  if (typeof model.findMicroflowByQualifiedName !== "function") return null;
  return resolveQualifiedNameRef({
    model,
    moduleName,
    rawRef: step.microflowQualifiedName || rawRef,
    mappedQname,
    finder: (qname) => model.findMicroflowByQualifiedName(qname),
    allGetter: () => (typeof model.allMicroflows === "function" ? model.allMicroflows() : [])
  });
}

function resolveNanoflowReference({ model, moduleName, step = {}, nanoflowRefsByRef = {} }) {
  const rawRef = step.nanoflowRef || step.targetRef || step.nanoflow || step.target || "";
  const mappedQname = rawRef ? nanoflowRefsByRef[rawRef] || "" : "";
  if (typeof model.findNanoflowByQualifiedName !== "function") return null;
  return resolveQualifiedNameRef({
    model,
    moduleName,
    rawRef: step.nanoflowQualifiedName || rawRef,
    mappedQname,
    finder: (qname) => model.findNanoflowByQualifiedName(qname),
    allGetter: () => (typeof model.allNanoflows === "function" ? model.allNanoflows() : [])
  });
}

function resolveWorkflowReference({ model, moduleName, step = {}, workflowRefsByRef = {} }) {
  const rawRef = step.workflowRef || step.targetRef || step.workflow || step.target || "";
  const mappedQname = rawRef ? workflowRefsByRef[rawRef] || "" : "";
  if (typeof model.findWorkflowByQualifiedName !== "function") return null;
  return resolveQualifiedNameRef({
    model,
    moduleName,
    rawRef: step.workflowQualifiedName || rawRef,
    mappedQname,
    finder: (qname) => model.findWorkflowByQualifiedName(qname),
    allGetter: () => (typeof model.allWorkflows === "function" ? model.allWorkflows() : [])
  });
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

function applyWidgetProps(widget, props) {
  if (!props) return;

  for (const [key, value] of Object.entries(props)) {
    let normalized = value;

    if (key === "editability" && typeof normalized === "boolean") {
      normalized = normalized ? "Always" : "Never";
    }
    if ((key === "editable" || key === "editability") && typeof normalized === "string") {
      const lower = normalized.trim().toLowerCase();
      if (lower === "always") normalized = "Always";
      else if (lower === "never") normalized = "Never";
      else if (lower === "conditionally" || lower === "conditional") normalized = "Conditional";
    }

    try {
      widget[key] = normalized;
    } catch (err) {
      if ((key === "editable" || key === "editability") && typeof value === "boolean") {
        widget[key] = value ? "Always" : "Never";
      } else {
        throw err;
      }
    }
  }
}

function toSafeName(value, fallback = "item") {
  return contextLib.toSafeName(value, fallback);
}

function toHumanLabel(value) {
  return contextLib.toHumanLabel(value);
}

function normalizeRoleRefs(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function applyConditionalVisibilityToWidget({
  pages,
  widget,
  model,
  moduleName,
  allowedRoles = [],
  availableModuleRoles = []
}) {
  if (!widget || !Array.isArray(allowedRoles) || allowedRoles.length === 0) return false;
  if (!("conditionalVisibilitySettings" in widget)) return false;

  const roles = resolveModuleRoleReferences({
    model,
    moduleName,
    refs: normalizeRoleRefs(allowedRoles),
    availableRoles: availableModuleRoles
  });
  if (!Array.isArray(roles) || roles.length === 0) return false;

  let settings = widget.conditionalVisibilitySettings || null;
  if (
    !settings &&
    pages &&
    pages.ConditionalVisibilitySettings &&
    typeof pages.ConditionalVisibilitySettings.createIn === "function"
  ) {
    settings = pages.ConditionalVisibilitySettings.createIn(widget);
  }
  if (!settings || !("moduleRoles" in settings)) return false;

  clearList(settings.moduleRoles);
  for (const role of roles) {
    settings.moduleRoles.push(role);
  }
  return true;
}

function resolveWidgetValueTypeEnum(customwidgets, typeName) {
  if (!customwidgets || !customwidgets.WidgetValueTypeEnum) {
    throw new Error("WidgetValueTypeEnum is unavailable in this SDK version.");
  }
  const enumValue = customwidgets.WidgetValueTypeEnum[typeName];
  if (!enumValue) {
    throw new Error(`Unsupported custom widget value type "${typeName}".`);
  }
  return enumValue;
}

function createWidgetPropertyType({
  customwidgets,
  model,
  objectType,
  key,
  caption = "",
  valueType,
  isList = false,
  required = false,
  defaultValue = "",
  dataSourceProperty = "",
  selectionTypes = [],
  enumerationValues = [],
  expressionReturnType = "",
  buildObjectType = null
}) {
  const propertyType = customwidgets.WidgetPropertyType.createIn(objectType);
  propertyType.key = key;
  propertyType.caption = caption || key;
  propertyType.category = "";
  propertyType.description = "";
  propertyType.isDefault = false;

  const vType = customwidgets.WidgetValueType.createIn(propertyType);
  vType.type = resolveWidgetValueTypeEnum(customwidgets, valueType);
  if ("isList" in vType) vType.isList = Boolean(isList);
  if ("required" in vType) vType.required = Boolean(required);
  if (defaultValue !== undefined && "defaultValue" in vType) {
    vType.defaultValue = String(defaultValue);
  }
  if (dataSourceProperty && "dataSourceProperty" in vType) {
    vType.dataSourceProperty = dataSourceProperty;
  }

  if (valueType === "Expression") {
    const returnTypeName = String(expressionReturnType || "Boolean").trim();
    const returnEnum =
      customwidgets.WidgetReturnTypeEnum && customwidgets.WidgetReturnTypeEnum[returnTypeName]
        ? customwidgets.WidgetReturnTypeEnum[returnTypeName]
        : customwidgets.WidgetReturnTypeEnum && customwidgets.WidgetReturnTypeEnum.Boolean
          ? customwidgets.WidgetReturnTypeEnum.Boolean
          : null;
    if (returnEnum && customwidgets.WidgetReturnType) {
      const rt = customwidgets.WidgetReturnType.createIn(vType);
      rt.type = returnEnum;
      if ("isList" in rt) rt.isList = false;
      if ("entityProperty" in rt) rt.entityProperty = "";
    }
  }

  if (Array.isArray(selectionTypes) && selectionTypes.length > 0 && "selectionTypes" in vType) {
    clearList(vType.selectionTypes);
    for (const name of selectionTypes) {
      const enumValue =
        customwidgets.CustomWidgetSelectionType && customwidgets.CustomWidgetSelectionType[name]
          ? customwidgets.CustomWidgetSelectionType[name]
          : null;
      if (enumValue) vType.selectionTypes.push(enumValue);
    }
  }

  if (Array.isArray(enumerationValues) && enumerationValues.length > 0 && "enumerationValues" in vType) {
    clearList(vType.enumerationValues);
    for (const item of enumerationValues) {
      const enumItem = customwidgets.WidgetEnumerationValue.createIn(vType);
      enumItem.key = String(item);
      enumItem.caption = toHumanLabel(String(item));
    }
  }

  if (typeof buildObjectType === "function" && "objectType" in vType) {
    const nestedObjectType = customwidgets.WidgetObjectType.createInWidgetValueTypeUnderObjectType(vType);
    buildObjectType(nestedObjectType, { customwidgets, model });
  }

  return propertyType;
}

function createWidgetPropertyValue({ customwidgets, widgetObject, propertyType }) {
  const property = customwidgets.WidgetProperty.createIn(widgetObject);
  property.type = propertyType;
  const value = customwidgets.WidgetValue.createIn(property);
  if (propertyType.valueType) {
    value.type = propertyType.valueType;
  }
  return value;
}

function setWidgetValuePrimitive(value, rawValue) {
  if (!value || !("primitiveValue" in value)) return;
  if (rawValue === undefined || rawValue === null) return;

  if (typeof rawValue === "boolean") {
    value.primitiveValue = rawValue ? "true" : "false";
    return;
  }
  value.primitiveValue = String(rawValue);
}

function setWidgetValueAttributeRef({ domainmodels, value, attribute }) {
  if (!value || !attribute) return false;

  if ("attributeRef" in value && value.attributeRef) {
    value.attributeRef.attribute = attribute;
    return true;
  }

  if (
    domainmodels &&
    domainmodels.AttributeRef &&
    typeof domainmodels.AttributeRef.createInWidgetValueUnderAttributeRef === "function"
  ) {
    const ref = domainmodels.AttributeRef.createInWidgetValueUnderAttributeRef(value);
    ref.attribute = attribute;
    return true;
  }

  return false;
}

function setWidgetValueTextTemplate({ pages, texts, model, value, text }) {
  if (!value) return false;
  const normalized = String(text || "").trim();
  if (!normalized) return false;

  if ("textTemplate" in value && value.textTemplate) {
    value.textTemplate.template = createText(texts, model, normalized);
    return true;
  }

  if (pages.ClientTemplate && typeof pages.ClientTemplate.createInWidgetValueUnderTextTemplate === "function") {
    const template = pages.ClientTemplate.createInWidgetValueUnderTextTemplate(value);
    template.template = createText(texts, model, normalized);
    return true;
  }

  return false;
}

function setWidgetValueXPathSource({ customwidgets, domainmodels, value, entity, xPathConstraint, dataSourceProps }) {
  if (!value) return false;
  if (
    !customwidgets ||
    !customwidgets.CustomWidgetXPathSource ||
    typeof customwidgets.CustomWidgetXPathSource.createInWidgetValueUnderDataSource !== "function"
  ) {
    return false;
  }

  const source = customwidgets.CustomWidgetXPathSource.createInWidgetValueUnderDataSource(value);
  configureDataSource({
    domainmodels,
    dataSource: source,
    entity,
    xPathConstraint,
    dataSourceProps
  });

  return true;
}

function setWidgetValueMicroflowRef({ value, microflow }) {
  if (!value || !microflow) return false;
  if ("microflow" in value) {
    value.microflow = microflow;
    return true;
  }
  return false;
}

function setWidgetValueNanoflowRef({ value, nanoflow }) {
  if (!value || !nanoflow) return false;
  if ("nanoflow" in value) {
    value.nanoflow = nanoflow;
    return true;
  }
  return false;
}

function toArrayFromList(list) {
  if (!list) return [];
  if (Array.isArray(list)) return list.filter(Boolean);
  if (typeof list.slice === "function") {
    try {
      return list.slice().filter(Boolean);
    } catch (_err) {
      // Fall through.
    }
  }
  const result = [];
  if (typeof list.forEach === "function") {
    list.forEach((item) => {
      if (item) result.push(item);
    });
  }
  return result;
}

function tryReadProperty(obj, propName) {
  if (!obj || !propName) return null;
  try {
    return obj[propName];
  } catch (_err) {
    return null;
  }
}

function getLayoutCallArgumentRootWidgets(arg) {
  const roots = [];
  const listWidgets = toArrayFromList(tryReadProperty(arg, "widgets"));
  roots.push(...listWidgets);
  // Deprecated in newer Mendix versions; read defensively.
  const singleWidget = tryReadProperty(arg, "widget");
  if (singleWidget) roots.push(singleWidget);
  return roots;
}

function collectChildWidgets(widget) {
  const children = [];
  if (!widget) return children;

  const listProps = [
    "widgets",
    "footerWidgets",
    "leftWidgets",
    "rightWidgets",
    "firstWidgets",
    "secondWidgets",
    "sidebarWidgets",
    "items",
    "templates",
    "tabPages"
  ];
  const singleProps = ["widget", "footerWidget", "leftWidget", "rightWidget", "firstWidget", "secondWidget"];

  for (const prop of listProps) {
    const values = toArrayFromList(tryReadProperty(widget, prop));
    if (values.length === 0) continue;
    for (const value of values) {
      children.push(value);
      if (value && typeof value === "object") {
        const nestedSingle = tryReadProperty(value, "widget");
        if (nestedSingle) children.push(nestedSingle);
        const nestedList = toArrayFromList(tryReadProperty(value, "widgets"));
        if (nestedList.length > 0) children.push(...nestedList);
      }
    }
  }

  for (const prop of singleProps) {
    const child = tryReadProperty(widget, prop);
    if (child) children.push(child);
  }

  return children;
}

function walkWidgets(rootWidgets, visit) {
  const stack = [...toArrayFromList(rootWidgets)];
  const seen = new Set();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    const id = current.id || null;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);

    visit(current);
    stack.push(...collectChildWidgets(current));
  }
}

function repairCustomWidgetExpressionTypes({ customwidgets, widget }) {
  if (!widget || widget.structureTypeName !== "CustomWidgets$CustomWidget") return 0;
  if (!widget.object || !widget.object.properties) return 0;
  if (!customwidgets || !customwidgets.WidgetValueTypeEnum || !customwidgets.WidgetReturnTypeEnum) return 0;

  let repaired = 0;
  for (const property of toArrayFromList(widget.object.properties)) {
    const propertyType = property && property.type ? property.type : null;
    const valueType = propertyType && propertyType.valueType ? propertyType.valueType : null;
    if (!valueType || !("type" in valueType)) continue;
    if (valueType.type !== customwidgets.WidgetValueTypeEnum.Expression) continue;

    if (!valueType.returnType && customwidgets.WidgetReturnType && typeof customwidgets.WidgetReturnType.createIn === "function") {
      const returnType = customwidgets.WidgetReturnType.createIn(valueType);
      returnType.type = customwidgets.WidgetReturnTypeEnum.Boolean;
      if ("isList" in returnType) returnType.isList = false;
      if ("entityProperty" in returnType) returnType.entityProperty = "";
      repaired += 1;
    }
  }

  return repaired;
}

async function sanitizeModuleCustomWidgetExpressions({ model, moduleName, customwidgets }) {
  if (!model || !moduleName || !customwidgets || typeof model.allPages !== "function") {
    return { repairedExpressionTypes: 0 };
  }

  let repairedExpressionTypes = 0;
  const pageIfaces = model.allPages();

  for (const pageIface of pageIfaces) {
    let inTargetModule = false;
    try {
      inTargetModule =
        Boolean(pageIface && pageIface.containerAsFolderBase && pageIface.containerAsFolderBase.containerAsModule) &&
        pageIface.containerAsFolderBase.containerAsModule.name === moduleName;
    } catch (_err) {
      inTargetModule = false;
    }
    if (!inTargetModule) continue;

    let page = null;
    try {
      page = typeof pageIface.load === "function" ? await pageIface.load() : pageIface;
    } catch (_err) {
      // Some existing pages may be broken by prior custom-widget metadata issues.
      // Skip them here; cleanup/deletion can still remove them by interface.
      continue;
    }
    if (!page || !page.layoutCall || !page.layoutCall.arguments) continue;

    const roots = [];
    for (const arg of toArrayFromList(page.layoutCall.arguments)) {
      if (!arg) continue;
      roots.push(...getLayoutCallArgumentRootWidgets(arg));
    }

    walkWidgets(roots, (widget) => {
      repairedExpressionTypes += repairCustomWidgetExpressionTypes({ customwidgets, widget });
    });
  }

  return { repairedExpressionTypes };
}

function resolveInputLabel(step, attribute, rawAttributeRef) {
  if (typeof step.label === "string" && step.label.trim().length > 0) {
    return step.label.trim();
  }

  if (step.autoLabel === false || step.showLabel === false) {
    return "";
  }

  const source = (attribute && attribute.name) || rawAttributeRef || step.name || "Field";
  return toHumanLabel(source);
}

function ensureWidgetName(widget, preferredName) {
  if (!widget || !("name" in widget)) return;
  const finalName = preferredName || "widget";
  try {
    if (!widget.name || String(widget.name).trim() === "") {
      widget.name = finalName;
    }
  } catch (_err) {
    // ignore if assignment unsupported
  }
}

function setEntityRefOnDataSource({ domainmodels, dataSource, entity, entityQname = "" }) {
  if (!dataSource || !("entityRef" in dataSource)) return;
  const hasEntity = Boolean(entity);
  const hasEntityQname = typeof entityQname === "string" && entityQname.length > 0;
  if (!hasEntity && !hasEntityQname) return;

  if (dataSource.entityRef) {
    if (hasEntity) {
      dataSource.entityRef.entity = entity;
      return;
    }
    if (hasEntityQname) {
      const setRaw = setByNameReferenceRaw(dataSource.entityRef, "entity", entityQname);
      if (setRaw) return;
    }
    return;
  }

  if (!domainmodels || !domainmodels.DirectEntityRef || !domainmodels.DirectEntityRef.createInEntityPathSourceUnderEntityRef) {
    throw new Error("DirectEntityRef is unavailable in this SDK version.");
  }

  const ref = domainmodels.DirectEntityRef.createInEntityPathSourceUnderEntityRef(dataSource);
  if (hasEntity) {
    ref.entity = entity;
    return;
  }
  const setRaw = setByNameReferenceRaw(ref, "entity", entityQname);
  if (!setRaw) {
    throw new Error(`Could not bind data source entity reference "${entityQname}".`);
  }
}

function configureDataSource({ domainmodels, dataSource, entity, entityQname = "", xPathConstraint, dataSourceProps }) {
  if (!dataSource) return;

  if (entity || entityQname) {
    setEntityRefOnDataSource({ domainmodels, dataSource, entity, entityQname });
  }

  if (xPathConstraint !== undefined && xPathConstraint !== null && "xPathConstraint" in dataSource) {
    dataSource.xPathConstraint = xPathConstraint;
  }

  applyWidgetProps(dataSource, dataSourceProps);
}

function setEntityRefOnCreateObjectAction({ domainmodels, action, entity }) {
  if (!action || !entity || !("entityRef" in action)) return;

  if (action.entityRef) {
    action.entityRef.entity = entity;
    return;
  }

  if (
    !domainmodels ||
    !domainmodels.DirectEntityRef ||
    !domainmodels.DirectEntityRef.createInCreateObjectClientActionUnderEntityRef
  ) {
    throw new Error("DirectEntityRef for CreateObjectClientAction is unavailable in this SDK version.");
  }

  const ref = domainmodels.DirectEntityRef.createInCreateObjectClientActionUnderEntityRef(action);
  ref.entity = entity;
}

function normalizePageParameterSpecs(pageSpec = {}) {
  if (Array.isArray(pageSpec.pageParameters)) return pageSpec.pageParameters;
  if (Array.isArray(pageSpec.parameters)) return pageSpec.parameters;

  const rawEntityRef =
    pageSpec.parameterEntityRef || pageSpec.pageParameterEntityRef || pageSpec.contextEntityRef || "";
  if (!rawEntityRef) return [];

  return [
    {
      entityRef: rawEntityRef,
      name: pageSpec.parameterName || "",
      required: pageSpec.parameterRequired !== false
    }
  ];
}

function createPageParameterEntries({ pages, datatypes, model, moduleName, page, pageSpec = {} }) {
  const specs = normalizePageParameterSpecs(pageSpec);

  const result = {
    entries: [],
    byName: {},
    requiredEntries: [],
    defaultEntry: null
  };

  if (!specs.length) return result;

  if (!pages.PageParameter || typeof pages.PageParameter.createIn !== "function") {
    throw new Error("PageParameter is not available in this SDK version.");
  }
  if (!datatypes || !datatypes.ObjectType || typeof datatypes.ObjectType.createInPageParameterUnderParameterType !== "function") {
    throw new Error("datatypes.ObjectType is not available to create object page parameters.");
  }

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i] || {};
    const rawEntityRef = spec.entityRef || spec.entity || "";
    const entityQname = normalizeEntityQualifiedName(rawEntityRef, moduleName);
    const entity = resolveEntityReference(model, moduleName, rawEntityRef);
    if (!entity) {
      if (!entityQname) {
        throw new Error(
          `Could not resolve page parameter entity "${rawEntityRef}" on page "${pageSpec.name || page.name}".`
        );
      }
    }

    const parameter = pages.PageParameter.createIn(page);
    const parameterNameFallback = entity ? entity.name : entityQname.split(".").pop();
    parameter.name = String(spec.name || parameterNameFallback || `Parameter_${i + 1}`);

    const type = datatypes.ObjectType.createInPageParameterUnderParameterType(parameter);
    if (entity) {
      type.entity = entity;
    } else {
      const setRaw = setByNameReferenceRaw(type, "entity", entityQname);
      if (!setRaw) {
        throw new Error(
          `Could not bind page parameter entity "${entityQname}" on page "${pageSpec.name || page.name}".`
        );
      }
    }

    if ("isRequired" in parameter) {
      parameter.isRequired = spec.required !== false;
    }

    const required = "isRequired" in parameter ? parameter.isRequired !== false : spec.required !== false;
    const resolvedEntity = Boolean(entity);
    const entryEntity =
      entity ||
      {
        name: entityQname.split(".").pop(),
        qualifiedName: entityQname,
        id: ""
      };

    const entry = { parameter, entity: entryEntity, required, resolvedEntity };

    result.entries.push(entry);
    result.byName[parameter.name] = entry;
    if (required) result.requiredEntries.push(entry);
  }

  result.defaultEntry = result.entries[0] || null;
  return result;
}

function bindEntityPathSourceToPageParameter({ pages, dataSource, pageParameter }) {
  if (!dataSource || !pageParameter) return false;

  if ("pageParameter" in dataSource) {
    try {
      dataSource.pageParameter = pageParameter;
      return true;
    } catch (_err) {
      // On newer metamodels use sourceVariable.
    }
  }

  if (!("sourceVariable" in dataSource)) return false;

  let sourceVariable = dataSource.sourceVariable || null;
  if (!sourceVariable) {
    if (pages.PageVariable && typeof pages.PageVariable.createInEntityPathSourceUnderSourceVariable === "function") {
      sourceVariable = pages.PageVariable.createInEntityPathSourceUnderSourceVariable(dataSource);
    }
  }

  if (!sourceVariable || !("pageParameter" in sourceVariable)) return false;
  sourceVariable.pageParameter = pageParameter;
  return true;
}

function getTemplateContentFromStep(step) {
  if (!step) return [];
  if (Array.isArray(step.templateContent)) return step.templateContent;
  if (Array.isArray(step.itemContent)) return step.itemContent;
  return [];
}

function buildGridFallbackTemplateContent(step) {
  const columns = Array.isArray(step.columns) ? step.columns : [];
  if (columns.length === 0) {
    return [{ type: "dynamicText", text: "Item", renderMode: "Paragraph" }];
  }

  return columns.map((colSpec) => ({
    type: "attributeInput",
    attributeRef: colSpec.attributeRef || colSpec.attribute || colSpec.attributeName || ""
  }));
}

function normalizeDataSourceStep(step = {}) {
  const fromObject = step.dataSource && typeof step.dataSource === "object" ? step.dataSource : {};
  const xPathConstraint =
    fromObject.xPathConstraint !== undefined ? fromObject.xPathConstraint : step.xPathConstraint;

  return {
    type: fromObject.type || "",
    xPathConstraint,
    props: fromObject.props || step.dataSourceProps || {}
  };
}

function normalizeDataGridSearchSpec(step = {}) {
  const base =
    step.search && typeof step.search === "object"
      ? { ...step.search, fields: Array.isArray(step.search.fields) ? [...step.search.fields] : [] }
      : { enabled: false, fields: [] };

  const explicitFilters = Array.isArray(step.filters) ? step.filters : [];
  if (base.fields.length === 0 && explicitFilters.length > 0) {
    base.enabled = true;
    base.fields = explicitFilters
      .filter((f) => f && typeof f === "object" && (f.attributeRef || f.attribute || f.attributeName))
      .map((f) => ({
        attributeRef: f.attributeRef || f.attribute || f.attributeName,
        fieldType: f.fieldType || f.type || "contains",
        operator: f.operator,
        caption: f.caption || f.label || "",
        placeholder: f.placeholder || "",
        allowMultipleSelect: f.allowMultipleSelect,
        xPathConstraint: f.xPathConstraint
      }));
  }

  return base;
}

const DATA_GRID_2_WIDGET_ID_CANDIDATES = [
  "com.mendix.widget.web.datagrid.Datagrid",
  "com.mendix.widget.web.datagrid.DataGrid",
  "com.mendix.widget.web.datagrid2.Datagrid2",
  "com.mendix.widget.web.datagrid2.DataGrid2",
  "com.mendix.widget.web.datagrid2",
  "com.mendix.widgets.web.datagrid2",
  "com.mendix.widgets.web.datagrid2.DataGrid2",
  "DataWidgets.DataGrid2",
  "DataWidgets.DataGrid",
  "DataWidgets.Datagrid2"
];

function normalizeDataGrid2WidgetId(rawId = "") {
  const raw = String(rawId || "").trim();
  if (!raw) return "";
  const normalized = raw.toLowerCase();
  if (normalized === "datagrid2" || normalized === "data_grid_2" || normalized === "datagrid" || normalized === "dg2") {
    return "com.mendix.widget.web.datagrid.Datagrid";
  }
  return raw;
}

function normalizeWidgetIdForMatch(rawId = "") {
  return String(normalizeDataGrid2WidgetId(rawId) || "").trim().toLowerCase();
}

function toWidgetValueTypeName(valueType) {
  if (!valueType) return "";

  const directType = tryReadProperty(valueType, "type");
  if (typeof directType === "string" && directType) return directType;
  if (directType && typeof directType === "object") {
    const enumName = tryReadProperty(directType, "name");
    if (typeof enumName === "string" && enumName) return enumName;
    const literalName = tryReadProperty(directType, "literalName");
    if (typeof literalName === "string" && literalName) return literalName;
    const qname = tryReadProperty(directType, "qualifiedTsTypeName");
    if (typeof qname === "string" && qname) {
      const parts = qname.split(".");
      return parts[parts.length - 1] || qname;
    }
  }

  if (typeof valueType.toJSON === "function") {
    try {
      const raw = valueType.toJSON();
      if (raw && typeof raw.type === "string" && raw.type) return raw.type;
    } catch (_err) {
      // ignore
    }
  }

  return "";
}

function isWidgetValueType(customwidgets, valueType, typeName) {
  if (!valueType || !typeName) return false;
  const enumValue =
    customwidgets &&
    customwidgets.WidgetValueTypeEnum &&
    customwidgets.WidgetValueTypeEnum[typeName]
      ? customwidgets.WidgetValueTypeEnum[typeName]
      : null;
  if (enumValue && valueType.type === enumValue) return true;
  const normalizedActual = toWidgetValueTypeName(valueType).toLowerCase();
  const normalizedExpected = String(typeName).toLowerCase();
  if (!normalizedActual) return false;
  if (normalizedActual === normalizedExpected) return true;
  // Be tolerant of minor naming variants.
  if (normalizedActual.includes(normalizedExpected)) return true;
  return false;
}

function getWidgetPropertyTypeByKey(objectType, key) {
  const normalizedKey = String(key || "").trim();
  if (!objectType || !normalizedKey) return null;
  return toArrayFromList(objectType.propertyTypes).find((propertyType) => String(propertyType && propertyType.key || "").trim() === normalizedKey) || null;
}

function ensureWidgetObjectType(customwidgets, widgetType) {
  if (!customwidgets || !widgetType) return null;
  if (widgetType.objectType) return widgetType.objectType;
  if (
    !customwidgets.WidgetObjectType ||
    typeof customwidgets.WidgetObjectType.createInCustomWidgetTypeUnderObjectType !== "function"
  ) {
    return null;
  }
  return customwidgets.WidgetObjectType.createInCustomWidgetTypeUnderObjectType(widgetType);
}

function normalizeCustomWidgetPropertyTypeSpec(spec = {}) {
  if (!spec || typeof spec !== "object") return null;
  const key = String(spec.key || "").trim();
  const valueType = String(spec.valueType || "").trim();
  if (!key || !valueType) return null;
  return {
    key,
    caption: String(spec.caption || spec.label || key).trim() || key,
    valueType,
    isList: Boolean(spec.isList),
    required: Boolean(spec.required),
    defaultValue: spec.defaultValue !== undefined ? spec.defaultValue : "",
    dataSourceProperty: String(spec.dataSourceProperty || "").trim(),
    selectionTypes: Array.isArray(spec.selectionTypes) ? spec.selectionTypes : [],
    enumerationValues: Array.isArray(spec.enumerationValues) ? spec.enumerationValues : [],
    expressionReturnType: String(spec.expressionReturnType || "").trim(),
    propertyTypes: Array.isArray(spec.propertyTypes) ? spec.propertyTypes : []
  };
}

function applyCustomWidgetPropertyTypeSpecs({
  customwidgets,
  model,
  objectType,
  propertyTypeSpecs = []
}) {
  if (!objectType || !Array.isArray(propertyTypeSpecs) || propertyTypeSpecs.length === 0) return;

  clearList(objectType.propertyTypes);
  for (const rawSpec of propertyTypeSpecs) {
    const spec = normalizeCustomWidgetPropertyTypeSpec(rawSpec);
    if (!spec) continue;
    createWidgetPropertyType({
      customwidgets,
      model,
      objectType,
      key: spec.key,
      caption: spec.caption,
      valueType: spec.valueType,
      isList: spec.isList,
      required: spec.required,
      defaultValue: spec.defaultValue,
      dataSourceProperty: spec.dataSourceProperty,
      selectionTypes: spec.selectionTypes,
      enumerationValues: spec.enumerationValues,
      expressionReturnType: spec.expressionReturnType,
      buildObjectType:
        spec.propertyTypes.length > 0
          ? (nestedObjectType) =>
              applyCustomWidgetPropertyTypeSpecs({
                customwidgets,
                model,
                objectType: nestedObjectType,
                propertyTypeSpecs: spec.propertyTypes
              })
          : null
    });
  }
}

function resolveCustomWidgetContextEntity({ model, moduleName, pageSpec, pageContext, step }) {
  return (
    resolveEntityForStep({ model, moduleName, pageSpec, step }) ||
    (pageContext && pageContext.defaultEntry ? pageContext.defaultEntry.entity : null)
  );
}

function normalizeBuiltInChartWidgetId(rawWidgetId) {
  const raw = String(rawWidgetId || "").trim();
  if (!raw) return "";

  const normalized = raw.toLowerCase();
  const chartTypeMap = new Map([
    ["barchart", "com.mendix.charts.web.BarChart"],
    ["columnchart", "com.mendix.charts.web.ColumnChart"],
    ["linechart", "com.mendix.charts.web.LineChart"],
    ["piechart", "com.mendix.charts.web.PieChart"],
    ["areachart", "com.mendix.charts.web.AreaChart"],
    ["timeseries", "com.mendix.charts.web.TimeSeries"],
    ["timeserieschart", "com.mendix.charts.web.TimeSeries"]
  ]);

  if (normalized.startsWith("com.mendix.charts.")) {
    return raw;
  }

  const lastToken = raw.split(".").pop() || raw;
  const compact = lastToken.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (chartTypeMap.has(compact)) {
    return chartTypeMap.get(compact);
  }

  if (compact.startsWith("sample") && chartTypeMap.has(compact.replace(/^sample/, ""))) {
    return chartTypeMap.get(compact.replace(/^sample/, ""));
  }

  return raw;
}

function chooseDataGridMode(step = {}) {
  const explicit = String(step.widgetMode || step.mode || "").trim().toLowerCase();
  if (["classic", "datagrid", "data_grid", "grid"].includes(explicit)) {
    return "classic";
  }
  if (["datagrid2", "data_grid_2", "dg2"].includes(explicit)) {
    return "datagrid2";
  }
  const hasSearch = Array.isArray(step.search && step.search.fields) && step.search.fields.length > 0;
  const hasRowClick = Boolean(String(step.rowClickTargetPageRef || "").trim());
  return hasSearch || hasRowClick ? "classic" : "datagrid2";
}

function summarizeWidgetTypeMetadata(widgetType) {
  if (!widgetType || !widgetType.objectType) return "no-object-type";
  const rootTypes = toArrayFromList(widgetType.objectType.propertyTypes);
  if (rootTypes.length === 0) return "no-root-property-types";

  const parts = rootTypes.map((pt) => {
    const key = String((pt && pt.key) || "<no-key>");
    const valueType = pt && pt.valueType ? pt.valueType : null;
    const vtName = toWidgetValueTypeName(valueType) || "<no-type>";
    const isList = Boolean(valueType && valueType.isList);
    let label = `${key}:${vtName}${isList ? "[]" : ""}`;

    const nestedTypes = toArrayFromList(valueType && valueType.objectType ? valueType.objectType.propertyTypes : []);
    if (nestedTypes.length > 0) {
      const nestedSummary = nestedTypes
        .map((npt) => {
          const nk = String((npt && npt.key) || "<no-key>");
          const nvt = toWidgetValueTypeName(npt && npt.valueType ? npt.valueType : null) || "<no-type>";
          return `${nk}:${nvt}`;
        })
        .join(",");
      label += `{${nestedSummary}}`;
    }
    return label;
  });

  return parts.join(" | ");
}

function ensureFallbackDataGrid2PropertyTypes({ customwidgets, model, widgetType }) {
  if (!customwidgets || !widgetType) return false;
  if (!widgetType.objectType) {
    if (
      !customwidgets.WidgetObjectType ||
      typeof customwidgets.WidgetObjectType.createInCustomWidgetTypeUnderObjectType !== "function"
    ) {
      return false;
    }
    customwidgets.WidgetObjectType.createInCustomWidgetTypeUnderObjectType(widgetType);
  }
  const objectType = widgetType.objectType;
  if (!objectType) return false;

  const existing = toArrayFromList(objectType.propertyTypes);
  if (existing.length > 0) return false;

  createWidgetPropertyType({
    customwidgets,
    model,
    objectType,
    key: "dataSource",
    caption: "Data source",
    valueType: "DataSource",
    isList: false,
    required: true
  });

  createWidgetPropertyType({
    customwidgets,
    model,
    objectType,
    key: "columns",
    caption: "Columns",
    valueType: "Object",
    isList: true,
    required: true,
    dataSourceProperty: "dataSource",
    buildObjectType: (columnObjectType) => {
      createWidgetPropertyType({
        customwidgets,
        model,
        objectType: columnObjectType,
        key: "attribute",
        caption: "Attribute",
        valueType: "Attribute",
        required: true,
        dataSourceProperty: "dataSource"
      });
      createWidgetPropertyType({
        customwidgets,
        model,
        objectType: columnObjectType,
        key: "header",
        caption: "Header",
        valueType: "TextTemplate",
        required: false
      });
    }
  });

  createWidgetPropertyType({
    customwidgets,
    model,
    objectType,
    key: "pageSize",
    caption: "Page size",
    valueType: "Integer",
    required: false,
    defaultValue: "20"
  });

  return true;
}

function chooseFallbackDataGrid2WidgetId({ discoveredGridLikeIds = [], normalizedCandidates = [] }) {
  const discovered = [...new Set((discoveredGridLikeIds || []).filter(Boolean))];
  const nonFilterDiscovered = discovered.filter((id) => !/filter/i.test(String(id || "")));
  const candidates = nonFilterDiscovered.length > 0 ? nonFilterDiscovered : discovered;

  const preferredDiscovered = candidates.find((id) => /(?:^|\.)datagrid2?$/i.test(String(id || "")));
  if (preferredDiscovered) return preferredDiscovered;

  const preferredByName = candidates.find((id) => /datagrid2|datagrid/i.test(String(id || "")));
  if (preferredByName) return preferredByName;

  if (nonFilterDiscovered.length > 0) return nonFilterDiscovered[0];
  if (Array.isArray(normalizedCandidates) && normalizedCandidates.length > 0) return normalizedCandidates[0];
  return "";
}

function hasNestedAttributePropertyType(customwidgets, propertyType) {
  if (!propertyType || !propertyType.valueType || !propertyType.valueType.objectType) return false;
  const nested = toArrayFromList(propertyType.valueType.objectType.propertyTypes);
  return nested.some((pt) => pt && pt.valueType && isWidgetValueType(customwidgets, pt.valueType, "Attribute"));
}

function findRootDataSourcePropertyType(customwidgets, rootPropertyTypes = []) {
  return rootPropertyTypes.find(
    (pt) => pt && pt.valueType && isWidgetValueType(customwidgets, pt.valueType, "DataSource")
  );
}

function findRootColumnsPropertyType(customwidgets, rootPropertyTypes = []) {
  return rootPropertyTypes.find(
    (pt) =>
      pt &&
      pt.valueType &&
      isWidgetValueType(customwidgets, pt.valueType, "Object") &&
      Boolean(pt.valueType.isList) &&
      hasNestedAttributePropertyType(customwidgets, pt)
  );
}

function findColumnAttributePropertyType(customwidgets, columnsPropertyType) {
  const nested = toArrayFromList(
    columnsPropertyType && columnsPropertyType.valueType && columnsPropertyType.valueType.objectType
      ? columnsPropertyType.valueType.objectType.propertyTypes
      : []
  );
  return nested.find((pt) => pt && pt.valueType && isWidgetValueType(customwidgets, pt.valueType, "Attribute"));
}

function findColumnHeaderPropertyType(customwidgets, columnsPropertyType) {
  const nested = toArrayFromList(
    columnsPropertyType && columnsPropertyType.valueType && columnsPropertyType.valueType.objectType
      ? columnsPropertyType.valueType.objectType.propertyTypes
      : []
  );
  return nested.find((pt) => pt && pt.valueType && isWidgetValueType(customwidgets, pt.valueType, "TextTemplate"));
}

function findRootIntegerPropertyType(customwidgets, rootPropertyTypes = [], preferredKey = "") {
  const preferred = String(preferredKey || "").trim().toLowerCase();
  if (preferred) {
    const byKey = rootPropertyTypes.find(
      (pt) =>
        pt &&
        typeof pt.key === "string" &&
        pt.key.toLowerCase() === preferred &&
        pt.valueType &&
        isWidgetValueType(customwidgets, pt.valueType, "Integer")
    );
    if (byKey) return byKey;
  }

  const byContains = rootPropertyTypes.find(
    (pt) =>
      pt &&
      typeof pt.key === "string" &&
      pt.key.toLowerCase().includes("pagesize") &&
      pt.valueType &&
      isWidgetValueType(customwidgets, pt.valueType, "Integer")
  );
  if (byContains) return byContains;
  return null;
}

function isUsableDataGrid2TypeMetadata(customwidgets, widgetType) {
  if (!widgetType || !widgetType.objectType) return false;
  const rootPropertyTypes = toArrayFromList(widgetType.objectType.propertyTypes);
  if (rootPropertyTypes.length === 0) return false;
  const dataSourcePropertyType = findRootDataSourcePropertyType(customwidgets, rootPropertyTypes);
  const columnsPropertyType = findRootColumnsPropertyType(customwidgets, rootPropertyTypes);
  const columnAttributePropertyType = findColumnAttributePropertyType(customwidgets, columnsPropertyType);
  return Boolean(dataSourcePropertyType && columnsPropertyType && columnAttributePropertyType);
}

function collectStepChildren(step = {}) {
  const children = [];
  if (Array.isArray(step.content)) children.push(...step.content);
  if (Array.isArray(step.templateContent)) children.push(...step.templateContent);
  if (Array.isArray(step.itemContent)) children.push(...step.itemContent);
  return children;
}

function pageStepContainsDataGrid2(step = {}) {
  if (!step || typeof step !== "object") return false;
  if (step.type === "dataGrid") return true;
  const children = collectStepChildren(step);
  return children.some((child) => pageStepContainsDataGrid2(child));
}

function pageSpecContainsDataGrid2(pageSpec = {}) {
  const steps = Array.isArray(pageSpec.content) ? pageSpec.content : [];
  return steps.some((step) => pageStepContainsDataGrid2(step));
}

function collectDataGrid2TargetPageNames(pageSpecs = []) {
  const names = [];
  for (const pageSpec of Array.isArray(pageSpecs) ? pageSpecs : []) {
    if (!pageSpec || !pageSpec.name) continue;
    if (pageSpecContainsDataGrid2(pageSpec)) {
      names.push(pageSpec.name);
    }
  }
  return names;
}

function findPageInterfaceByModuleAndName(model, moduleName, pageName) {
  const pageIfaces = typeof model.allPages === "function" ? model.allPages() : [];
  return pageIfaces.find((p) => {
    if (!p || p.name !== pageName) return false;
    try {
      if (p.containerAsFolderBase && p.containerAsFolderBase.containerAsModule) {
        return p.containerAsFolderBase.containerAsModule.name === moduleName;
      }
    } catch (_err) {
      // Fall back to qualified-name based module inference.
    }
    const qname = String((p && p.qualifiedName) || "");
    const inferredModuleName = qname.includes(".") ? qname.split(".")[0] : "";
    return inferredModuleName === moduleName;
  });
}

async function cleanupPlannedDataGrid2Pages({
  model,
  moduleName,
  pageSpecs = [],
  enabled = true
}) {
  const targetedPageNames = collectDataGrid2TargetPageNames(pageSpecs);
  const summary = {
    enabled: Boolean(enabled),
    targetedPageNames,
    deletedPageNames: [],
    failed: []
  };

  if (!enabled || targetedPageNames.length === 0) {
    return summary;
  }

  for (const pageName of targetedPageNames) {
    const pageIface = findPageInterfaceByModuleAndName(model, moduleName, pageName);
    if (!pageIface) continue;

    try {
      if (typeof pageIface.delete === "function") {
        pageIface.delete();
      } else {
        const loadedPage = typeof pageIface.load === "function" ? await pageIface.load() : pageIface;
        loadedPage.delete();
      }
      summary.deletedPageNames.push(pageName);
    } catch (err) {
      summary.failed.push({
        pageName,
        message: err && err.message ? err.message : String(err)
      });
    }
  }

  return summary;
}

function validateMinimalDataGrid2Step(step = {}) {
  const allowedKeys = new Set([
    "type",
    "name",
    "autoName",
    "widgetMode",
    "mode",
    "entityRef",
    "xPathConstraint",
    "pageSize",
    "numberOfRows",
    "columns",
    "dataSource",
    "createMethod"
  ]);

  const unsupportedKeys = Object.keys(step || {}).filter((key) => !allowedKeys.has(key));
  if (unsupportedKeys.length > 0) {
    throw new Error(
      `Data Grid 2 minimal mode does not support: ${unsupportedKeys.join(", ")}. ` +
        "Supported keys: name, widgetMode, entityRef, xPathConstraint, pageSize, columns, dataSource."
    );
  }

  const mode = String(step.widgetMode || step.mode || "datagrid2").trim().toLowerCase();
  if (!["datagrid2", "data_grid_2", "dg2", ""].includes(mode)) {
    throw new Error(
      `Unsupported dataGrid widgetMode "${step.widgetMode}". Only minimal Data Grid 2 is supported.`
    );
  }

  if (!Array.isArray(step.columns) || step.columns.length === 0) {
    throw new Error("Data Grid 2 requires columns with at least one attributeRef.");
  }

  const invalidColumn = step.columns.find((col) => {
    if (!col || typeof col !== "object") return true;
    const keys = Object.keys(col);
    const allowed = new Set(["attributeRef", "attribute", "attributeName", "caption", "label"]);
    if (keys.some((k) => !allowed.has(k))) return true;
    return !String(col.attributeRef || col.attribute || col.attributeName || "").trim();
  });
  if (invalidColumn) {
    throw new Error(
      "Each Data Grid 2 column must contain attributeRef (or attribute/attributeName) and only optional caption."
    );
  }

  if (step.dataSource !== undefined) {
    if (!step.dataSource || typeof step.dataSource !== "object") {
      throw new Error("Data Grid 2 dataSource must be an object when provided.");
    }
    const dsKeys = Object.keys(step.dataSource);
    const allowedDsKeys = new Set(["type", "xPathConstraint"]);
    const invalidDsKeys = dsKeys.filter((k) => !allowedDsKeys.has(k));
    if (invalidDsKeys.length > 0) {
      throw new Error(
        `Data Grid 2 dataSource only supports keys "type" and "xPathConstraint" in minimal mode. Found: ${invalidDsKeys.join(
          ", "
        )}.`
      );
    }
    if (step.dataSource.type !== undefined) {
      const dsType = String(step.dataSource.type || "").trim().toLowerCase();
      if (dsType && !["database", "xpath"].includes(dsType)) {
        throw new Error(`Data Grid 2 dataSource.type "${step.dataSource.type}" is unsupported. Use "Database" or "XPath".`);
      }
    }
  }
}

function collectDataGrid2WidgetsInRoots(customwidgets, rootWidgets = [], candidateWidgetIds = []) {
  const widgets = [];
  const candidateSet = new Set(candidateWidgetIds.map((id) => normalizeWidgetIdForMatch(id)).filter(Boolean));

  walkWidgets(rootWidgets, (widget) => {
    if (!widget || widget.structureTypeName !== "CustomWidgets$CustomWidget") return;
    const widgetType = tryReadProperty(widget, "type");
    const widgetId = widgetType ? String(tryReadProperty(widgetType, "widgetId") || "").trim() : "";
    if (!widgetType || !widgetId) return;
    const normalizedId = normalizeWidgetIdForMatch(widgetId);
    if (!candidateSet.has(normalizedId)) return;
    widgets.push({ widget, widgetType, widgetId });
  });

  return widgets;
}

function hasModuleByName(model, moduleName) {
  if (!model || typeof model.allModules !== "function") return false;
  return model.allModules().some((m) => m && m.name === moduleName);
}

async function collectCustomWidgetIdsFromModel(model) {
  const ids = new Set();
  const pageIfaces = typeof model.allPages === "function" ? model.allPages() : [];

  for (const pageIface of pageIfaces) {
    let page = null;
    try {
      page = typeof pageIface.load === "function" ? await pageIface.load() : pageIface;
    } catch (_err) {
      continue;
    }
    if (!page || !page.layoutCall || !page.layoutCall.arguments) continue;

    const roots = [];
    for (const arg of toArrayFromList(page.layoutCall.arguments)) {
      if (!arg) continue;
      roots.push(...getLayoutCallArgumentRootWidgets(arg));
    }

    walkWidgets(roots, (widget) => {
      if (!widget || widget.structureTypeName !== "CustomWidgets$CustomWidget") return;
      const widgetType = tryReadProperty(widget, "type");
      const widgetId = widgetType ? String(tryReadProperty(widgetType, "widgetId") || "").trim() : "";
      if (widgetId) ids.add(widgetId);
    });
  }

  return [...ids];
}

function decodePathSegment(segment) {
  const raw = String(segment || "").trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch (_err) {
    return raw;
  }
}

async function collectCustomWidgetIdsFromFilePaths(model) {
  if (!model || typeof model.getFilePaths !== "function") return [];
  let filePaths = [];
  try {
    filePaths = await model.getFilePaths();
  } catch (_err) {
    return [];
  }

  const ids = new Set();
  for (const rawPath of Array.isArray(filePaths) ? filePaths : []) {
    const normalized = String(rawPath || "").replace(/\\/g, "/");
    if (!normalized) continue;

    const patterns = [
      /(?:^|\/)widgets\/([^\/]+)\//i,
      /(?:^|\/)widgets\/([^\/]+)\.mpk$/i,
      /(?:^|\/)deployment\/web\/widgets\/([^\/]+)\//i,
      /(?:^|\/)theme\/web\/widgets\/([^\/]+)\//i
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (!match || !match[1]) continue;
      const candidate = decodePathSegment(match[1]);
      if (!candidate) continue;
      ids.add(candidate);
    }
  }

  return [...ids];
}

async function findExistingDataGrid2TypeMetadata({ model, customwidgets, candidateWidgetIds = [] }) {
  const pageIfaces = typeof model.allPages === "function" ? model.allPages() : [];
  for (const pageIface of pageIfaces) {
    let page = null;
    try {
      page = typeof pageIface.load === "function" ? await pageIface.load() : pageIface;
    } catch (_err) {
      // Skip pages that cannot be loaded; this finder is best-effort only.
      continue;
    }
    if (!page || !page.layoutCall || !page.layoutCall.arguments) continue;

    const roots = [];
    for (const arg of toArrayFromList(page.layoutCall.arguments)) {
      if (!arg) continue;
      roots.push(...getLayoutCallArgumentRootWidgets(arg));
    }

    const foundWidgets = collectDataGrid2WidgetsInRoots(customwidgets, roots, candidateWidgetIds);
    for (const found of foundWidgets) {
      if (isUsableDataGrid2TypeMetadata(customwidgets, found.widgetType)) {
        return {
          widgetId: found.widgetId,
          source: "existingWidget",
          pageName: page.name || ""
        };
      }
    }
  }
  return null;
}

async function createDataGrid2ProbePage({
  pages,
  texts,
  model,
  moduleName,
  module,
  layout,
  layoutParameterQname
}) {
  const probeName = `__DG2_Probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const page = await createPageInModuleContainer({
    pages,
    model,
    moduleName,
    module,
    pageNameForError: probeName
  });
  page.name = probeName;
  page.title = createText(texts, model, probeName);

  const layoutCall = pages.LayoutCall.createInPageUnderLayoutCall(page);
  layoutCall.layout = layout;

  const arg = pages.LayoutCallArgument.create(model);
  const resolved = setLayoutArgParameterRawQname(arg, layoutParameterQname);
  if (!resolved) {
    throw new Error("Failed to set layout parameter on probe LayoutCallArgument.");
  }
  layoutCall.arguments.push(arg);

  return { page, arg, probeName };
}

async function probeDataGrid2TypeMetadata({
  model,
  pages,
  texts,
  customwidgets,
  moduleName,
  module,
  layout,
  layoutParameterQname,
  candidateWidgetIds = []
}) {
  const attempts = [];
  const probeVariants = [
    { pluginWidget: true, needsEntityContext: true, label: "plugin:true,entity:true" },
    { pluginWidget: false, needsEntityContext: true, label: "plugin:false,entity:true" },
    { pluginWidget: false, needsEntityContext: false, label: "plugin:false,entity:false" }
  ];

  for (const rawCandidate of candidateWidgetIds) {
    const candidateWidgetId = normalizeDataGrid2WidgetId(rawCandidate);
    for (const variant of probeVariants) {
      let probePage = null;
      let usable = false;
      let resolvedWidgetId = candidateWidgetId;

      try {
        probePage = await createDataGrid2ProbePage({
          pages,
          texts,
          model,
          moduleName,
          module,
          layout,
          layoutParameterQname
        });

        const widget = createCustomWidget({
          customwidgets,
          container: probePage.arg
        });
        const widgetType = customwidgets.CustomWidgetType.createIn(widget);
        widgetType.widgetId = candidateWidgetId;
        widgetType.name = "Data Grid 2";
        if ("pluginWidget" in widgetType) widgetType.pluginWidget = Boolean(variant.pluginWidget);
        if ("needsEntityContext" in widgetType) widgetType.needsEntityContext = Boolean(variant.needsEntityContext);

        await model.flushChanges();
        // Reload the probe page unit before checking metadata; pluggable widget
        // property metadata is often materialized after reload.
        const probeQname = `${moduleName}.${probePage.probeName}`;
        const probeIface = typeof model.findPageByQualifiedName === "function" ? model.findPageByQualifiedName(probeQname) : null;
        const loadedProbePage = probeIface ? (typeof probeIface.load === "function" ? await probeIface.load() : probeIface) : null;

        const roots = [];
        if (loadedProbePage && loadedProbePage.layoutCall && loadedProbePage.layoutCall.arguments) {
          for (const arg of toArrayFromList(loadedProbePage.layoutCall.arguments)) {
            if (!arg) continue;
            roots.push(...getLayoutCallArgumentRootWidgets(arg));
          }
        }

        const probeWidgets = collectDataGrid2WidgetsInRoots(customwidgets, roots, [candidateWidgetId]);
        const usableWidget = probeWidgets.find((w) => isUsableDataGrid2TypeMetadata(customwidgets, w.widgetType));
        const metadataSummary =
          probeWidgets.length > 0
            ? probeWidgets.map((w) => summarizeWidgetTypeMetadata(w.widgetType)).join(" || ")
            : summarizeWidgetTypeMetadata(widgetType);
        usable = Boolean(usableWidget);
        if (usableWidget && usableWidget.widgetId) {
          resolvedWidgetId = usableWidget.widgetId;
        }
        attempts.push({
          widgetId: resolvedWidgetId,
          usable,
          variant: variant.label,
          metadata: metadataSummary
        });
      } catch (err) {
        attempts.push({
          widgetId: candidateWidgetId,
          usable: false,
          variant: variant.label,
          message: err && err.message ? err.message : String(err)
        });
      } finally {
        try {
          if (probePage && probePage.page) {
            probePage.page.delete();
            await model.flushChanges();
          }
        } catch (_cleanupErr) {
          // Ignore probe cleanup issues; they should not block normal generation.
        }
      }

      if (usable) {
        return {
          widgetId: resolvedWidgetId,
          source: "probe",
          probeVariant: variant,
          attempts
        };
      }
    }
  }

  return {
    widgetId: "",
    source: "probe",
    attempts
  };
}

async function resolveDataGrid2TypeFromSdk({
  model,
  pages,
  texts,
  customwidgets,
  moduleName,
  module,
  layout,
  layoutParameterQname,
  candidateWidgetIds = DATA_GRID_2_WIDGET_ID_CANDIDATES
}) {
  const discoveredIds = await collectCustomWidgetIdsFromModel(model);
  const discoveredFileIds = await collectCustomWidgetIdsFromFilePaths(model);
  const discoveredGridLikeIds = [...discoveredIds, ...discoveredFileIds].filter((id) =>
    /datagrid|datawidgets|grid2/i.test(String(id || ""))
  );

  const mergedCandidates = [...candidateWidgetIds, ...discoveredGridLikeIds];
  const normalizedCandidates = [];
  const seenByMatch = new Set();
  for (const candidate of mergedCandidates) {
    const normalized = normalizeDataGrid2WidgetId(candidate);
    const matchKey = normalizeWidgetIdForMatch(normalized);
    if (!normalized || !matchKey || seenByMatch.has(matchKey)) continue;
    seenByMatch.add(matchKey);
    normalizedCandidates.push(normalized);
  }

  const fromExisting = await findExistingDataGrid2TypeMetadata({
    model,
    customwidgets,
    candidateWidgetIds: normalizedCandidates
  });
  if (fromExisting && fromExisting.widgetId) {
    return {
      widgetId: fromExisting.widgetId,
      source: fromExisting.source,
      useFallbackSchema: false,
      attempts: [{ widgetId: fromExisting.widgetId, usable: true, source: fromExisting.source }]
    };
  }

  const fromProbe = await probeDataGrid2TypeMetadata({
    model,
    pages,
    texts,
    customwidgets,
    moduleName,
    module,
    layout,
    layoutParameterQname,
    candidateWidgetIds: normalizedCandidates
  });

  if (fromProbe && fromProbe.widgetId) {
    return {
      widgetId: fromProbe.widgetId,
      source: fromProbe.source,
      useFallbackSchema: false,
      probeVariant: fromProbe.probeVariant || null,
      attempts: fromProbe.attempts || []
    };
  }

  const fallbackWidgetId =
    discoveredGridLikeIds.length > 0
      ? chooseFallbackDataGrid2WidgetId({
          discoveredGridLikeIds,
          normalizedCandidates
        })
      : "";
  if (fallbackWidgetId) {
    const fallbackAttempts = [...(fromProbe && fromProbe.attempts ? fromProbe.attempts : [])];
    fallbackAttempts.push({
      widgetId: fallbackWidgetId,
      usable: true,
      source: "fallbackSchema",
      message: "Using synthesized minimal DG2 property schema because SDK metadata remained empty."
    });
    return {
      widgetId: fallbackWidgetId,
      source: "fallbackSchema",
      useFallbackSchema: true,
      attempts: fallbackAttempts
    };
  }

  const attemptSummary = (fromProbe && fromProbe.attempts ? fromProbe.attempts : [])
    .map((a) => {
      const base = `${a.widgetId}${a.variant ? ` (${a.variant})` : ""}: ${
        a.usable ? "usable" : a.message || "metadata unavailable"
      }`;
      if (a.metadata) {
        return `${base} [${a.metadata}]`;
      }
      return base;
    })
    .join("; ");
  const discoveredSummary = discoveredGridLikeIds.length > 0 ? [...new Set(discoveredGridLikeIds)].join(", ") : "none";
  const hasDataWidgetsModule = hasModuleByName(model, "DataWidgets");
  const setupHint = hasDataWidgetsModule
    ? "DataWidgets module exists, but DG2 metadata could not be materialized. Ensure a supported Data Grid 2 widget package version is installed in this app."
    : "DataWidgets module was not found. Install Marketplace module 'Data Widgets' (Data Grid 2) in the app, commit, then rerun.";

  throw new Error(
    `DG2 metadata not resolvable via SDK for this app. Attempts: ${attemptSummary || "none"}. ` +
      `Discovered grid-like widget IDs in app: ${discoveredSummary}. ${setupHint}`
  );
}

function detectAttributeKind(attribute) {
  if (!attribute || !attribute.type || !attribute.type.structureTypeName) return "String";
  const typeName = String(attribute.type.structureTypeName);
  if (typeName.includes("Boolean")) return "Boolean";
  if (typeName.includes("Enumeration")) return "Enum";
  if (typeName.includes("DateTime")) return "DateTime";
  return "String";
}

function bindAttributeRef(domainmodels, widget, attribute) {
  if (!widget || !attribute || !("attributeRef" in widget)) return;

  if (widget.attributeRef) {
    widget.attributeRef.attribute = attribute;
    return;
  }

  if (!domainmodels || !domainmodels.AttributeRef || !domainmodels.AttributeRef.createInAttributeWidgetUnderAttributeRef) {
    return;
  }

  const ref = domainmodels.AttributeRef.createInAttributeWidgetUnderAttributeRef(widget);
  ref.attribute = attribute;
}

function bindAttributeRefRaw(domainmodels, widget, attributeQname) {
  if (!widget || !attributeQname || !("attributeRef" in widget)) return false;

  if (widget.attributeRef) {
    return setByNameReferenceRaw(widget.attributeRef, "attribute", attributeQname);
  }

  if (!domainmodels || !domainmodels.AttributeRef || !domainmodels.AttributeRef.createInAttributeWidgetUnderAttributeRef) {
    return false;
  }

  const ref = domainmodels.AttributeRef.createInAttributeWidgetUnderAttributeRef(widget);
  return setByNameReferenceRaw(ref, "attribute", attributeQname);
}

function bindAttributeRefOnSearchField(domainmodels, field, attribute) {
  if (!field || !attribute || !("attributeRef" in field)) return;

  if (field.attributeRef) {
    field.attributeRef.attribute = attribute;
    return;
  }

  if (
    !domainmodels ||
    !domainmodels.AttributeRef ||
    typeof domainmodels.AttributeRef.createInSingleSearchFieldUnderAttributeRef !== "function"
  ) {
    return;
  }

  const ref = domainmodels.AttributeRef.createInSingleSearchFieldUnderAttributeRef(field);
  ref.attribute = attribute;
}

function resolveSearchFieldOperator(pages, rawOperator) {
  if (!pages || !pages.SearchFieldOperator) return null;
  const raw = String(rawOperator || "").trim().toLowerCase();
  if (!raw) return pages.SearchFieldOperator.Contains || null;

  if (raw === "contains") return pages.SearchFieldOperator.Contains || null;
  if (raw === "startswith" || raw === "starts_with") return pages.SearchFieldOperator.StartsWith || null;
  if (raw === "equal" || raw === "eq") return pages.SearchFieldOperator.Equal || null;
  if (raw === "notequal" || raw === "not_equal" || raw === "ne") return pages.SearchFieldOperator.NotEqual || null;
  if (raw === "greater" || raw === "gt") return pages.SearchFieldOperator.Greater || null;
  if (raw === "greaterorequal" || raw === "greater_or_equal" || raw === "gte") {
    return pages.SearchFieldOperator.GreaterOrEqual || null;
  }
  if (raw === "smaller" || raw === "lt") return pages.SearchFieldOperator.Smaller || null;
  if (raw === "smallerorequal" || raw === "smaller_or_equal" || raw === "lte") {
    return pages.SearchFieldOperator.SmallerOrEqual || null;
  }

  return pages.SearchFieldOperator.Contains || null;
}

function resolveSearchBarType(pages, rawType, enabled) {
  if (!pages || !pages.SearchBarTypeEnum) return null;
  if (enabled === false) return pages.SearchBarTypeEnum.None || null;

  const raw = String(rawType || "").trim().toLowerCase();
  if (!raw) return pages.SearchBarTypeEnum.AlwaysOpen || pages.SearchBarTypeEnum.FoldableClosed || null;

  if (raw === "none") return pages.SearchBarTypeEnum.None || null;
  if (raw === "alwaysopen" || raw === "always_open" || raw === "always") {
    return pages.SearchBarTypeEnum.AlwaysOpen || null;
  }
  if (raw === "foldableopen" || raw === "foldable_open" || raw === "open") {
    return pages.SearchBarTypeEnum.FoldableOpen || null;
  }
  if (raw === "foldableclosed" || raw === "foldable_closed" || raw === "closed") {
    return pages.SearchBarTypeEnum.FoldableClosed || null;
  }

  return pages.SearchBarTypeEnum.AlwaysOpen || pages.SearchBarTypeEnum.FoldableClosed || null;
}

function getTargetPageMeta(step = {}, targetPage, pageMetaByRef = {}) {
  const ref =
    String(step.targetPageRef || "").trim() ||
    String(step.rowClickTargetPageRef || "").trim() ||
    String(step.pageRef || "").trim();
  return pageMetaByRef[ref] || pageMetaByRef[targetPage && targetPage.name] || null;
}

function normalizePageNameForMatch(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function inferListViewRowClickTarget({ pageSpec = {}, entity = null, pagesByRef = {}, pageMetaByRef = {} }) {
  if (!entity) return null;

  const currentPageName = String(pageSpec.name || "");
  const entityKey = normalizePageNameForMatch(entity.name || entity.qualifiedName || "");
  const currentPageKey = normalizePageNameForMatch(currentPageName);

  const uniquePages = [];
  const seen = new Set();
  for (const page of Object.values(pagesByRef || {})) {
    if (!page || !page.name) continue;
    const id = page.id || page.name;
    if (seen.has(id)) continue;
    seen.add(id);
    uniquePages.push(page);
  }

  const candidates = uniquePages
    .filter((page) => {
      if (!page || !page.name) return false;
      if (page.name === currentPageName) return false;
      const meta = pageMetaByRef[page.name];
      if (!meta || !Array.isArray(meta.requiredEntries) || meta.requiredEntries.length !== 1) return false;
      return entityRefMatches(meta.requiredEntries[0].entity, entity);
    })
    .map((page) => ({ page, meta: pageMetaByRef[page.name] || null }));

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const expectedFromOverview = currentPageKey.includes("overview")
    ? currentPageKey.replace("overview", "detail")
    : "";

  if (expectedFromOverview) {
    const byOverviewMatch = candidates.find((candidate) => normalizePageNameForMatch(candidate.page.name) === expectedFromOverview);
    if (byOverviewMatch) return byOverviewMatch;
  }

  const byEntityDetail = candidates.find((candidate) => {
    const key = normalizePageNameForMatch(candidate.page.name);
    return key === `${entityKey}detail` || (key.includes(entityKey) && key.includes("detail"));
  });
  if (byEntityDetail) return byEntityDetail;

  const editLikeMatches = candidates.filter((candidate) => {
    const key = normalizePageNameForMatch(candidate.page.name);
    return key.includes(entityKey) && (key.includes("edit") || key.includes("detail"));
  });
  if (editLikeMatches.length === 1) return editLikeMatches[0];

  return null;
}

function configurePageSettingsForTarget({
  pages,
  settings,
  targetPage,
  targetMeta,
  explicitMappings,
  defaultExpression = "",
  sourceEntity = null,
  allowImplicitSingleSelectionBinding = false
}) {
  if (!settings) {
    throw new Error("Could not configure page settings.");
  }

  settings.page = targetPage;

  const requiredEntries = targetMeta && Array.isArray(targetMeta.requiredEntries) ? targetMeta.requiredEntries : [];
  if (requiredEntries.length === 0) return;

  if (!pages.PageParameterMapping || typeof pages.PageParameterMapping.createIn !== "function") {
    throw new Error("PageParameterMapping is not available in this SDK version.");
  }

  if (!("parameterMappings" in settings)) {
    throw new Error(`Target page "${targetPage.name}" requires parameters, but PageSettings has no parameterMappings.`);
  }

  const mappings = explicitMappings && typeof explicitMappings === "object" ? explicitMappings : {};
  const hasExplicitMappings = Object.keys(mappings).length > 0;

  if (
    allowImplicitSingleSelectionBinding &&
    !hasExplicitMappings &&
    requiredEntries.length === 1 &&
    sourceEntity &&
    entityRefMatches(requiredEntries[0].entity, sourceEntity)
  ) {
    clearList(settings.parameterMappings);
    return;
  }

  clearList(settings.parameterMappings);

  for (const entry of requiredEntries) {
    const parameterName = entry.parameter.name;
    const arg = mappings[parameterName] !== undefined ? String(mappings[parameterName]) : defaultExpression;
    if (!arg) {
      throw new Error(
        `Target page "${targetPage.name}" requires parameter "${parameterName}". ` +
          "Provide step.parameterMappings or use a context-driven action (row click/create object)."
      );
    }

    const mapping = pages.PageParameterMapping.createIn(settings);
    mapping.parameter = entry.parameter;
    mapping.argument = arg;
  }
}

function setWidgetValuePageAction({
  pages,
  value,
  targetPage,
  targetMeta,
  parameterMappings = null,
  defaultExpression = "$currentObject"
}) {
  if (
    !pages.PageClientAction ||
    typeof pages.PageClientAction.createInWidgetValueUnderAction !== "function"
  ) {
    throw new Error("PageClientAction for custom widget actions is unavailable in this SDK version.");
  }

  const action = pages.PageClientAction.createInWidgetValueUnderAction(value);
  const settings =
    action.pageSettings ||
    (pages.PageSettings && typeof pages.PageSettings.createInPageClientActionUnderPageSettings === "function"
      ? pages.PageSettings.createInPageClientActionUnderPageSettings(action)
      : null);

  configurePageSettingsForTarget({
    pages,
    settings,
    targetPage,
    targetMeta,
    explicitMappings: parameterMappings,
    defaultExpression
  });

  return action;
}

function addDynamicText({ pages, texts, model, container, text, renderMode = "Paragraph" }) {
  const widget = createWidgetByClassName({
    pages,
    className: "DynamicText",
    container
  });

  widget.content = createClientTemplate(pages, texts, model, text);
  if (pages.TextRenderMode && pages.TextRenderMode[renderMode]) {
    widget.renderMode = pages.TextRenderMode[renderMode];
  }

  return widget;
}

function addButtonToPage({ pages, texts, model, container, caption, targetPage, targetMeta, parameterMappings = null }) {
  const button = createWidgetByClassName({
    pages,
    className: "ActionButton",
    container
  });

  button.caption = createClientTemplate(pages, texts, model, caption);

  const action = pages.PageClientAction.createInActionButtonUnderAction(button);
  const settings =
    action.pageSettings ||
    (pages.PageSettings && typeof pages.PageSettings.createInPageClientActionUnderPageSettings === "function"
      ? pages.PageSettings.createInPageClientActionUnderPageSettings(action)
      : null);

  configurePageSettingsForTarget({
    pages,
    settings,
    targetPage,
    targetMeta,
    explicitMappings: parameterMappings,
    defaultExpression: ""
  });

  return button;
}

function addCreateObjectButton({
  pages,
  texts,
  model,
  domainmodels,
  container,
  caption,
  entity,
  targetPage,
  targetMeta
}) {
  if (!pages.CreateObjectClientAction || typeof pages.CreateObjectClientAction.createInActionButtonUnderAction !== "function") {
    throw new Error("CreateObjectClientAction is not available in this SDK version.");
  }

  const button = createWidgetByClassName({
    pages,
    className: "ActionButton",
    container
  });

  button.caption = createClientTemplate(pages, texts, model, caption || "New");
  const action = pages.CreateObjectClientAction.createInActionButtonUnderAction(button);
  setEntityRefOnCreateObjectAction({ domainmodels, action, entity });

  if (targetPage) {
    const settings =
      action.pageSettings ||
      (pages.PageSettings && typeof pages.PageSettings.createInCreateObjectClientActionUnderPageSettings === "function"
        ? pages.PageSettings.createInCreateObjectClientActionUnderPageSettings(action)
        : null);

    if (!settings) {
      throw new Error("Could not configure page settings for createObjectButton.");
    }

    settings.page = targetPage;

    const requiredEntries = targetMeta && Array.isArray(targetMeta.requiredEntries) ? targetMeta.requiredEntries : [];
    if (requiredEntries.length > 1) {
      throw new Error(
        `createObjectButton target "${targetPage.name}" has multiple required parameters. ` +
          "Use a page with one required object parameter."
      );
    }

    if (requiredEntries.length === 1) {
      const targetEntity = requiredEntries[0].entity;
      const sourceEntity = entity;
      const sourceQname = getEntityQualifiedName(sourceEntity) || sourceEntity.name || "";
      const targetQname = getEntityQualifiedName(targetEntity) || targetEntity.name || "";

      const idMismatch =
        sourceEntity &&
        targetEntity &&
        sourceEntity.id &&
        targetEntity.id &&
        sourceEntity.id !== targetEntity.id;
      const qnameMismatch =
        !idMismatch && sourceQname && targetQname && sourceQname !== targetQname;

      if (idMismatch || qnameMismatch) {
        throw new Error(
          `createObjectButton entity mismatch: created entity "${sourceQname}" does not match ` +
            `target page parameter entity "${targetQname}" on "${targetPage.name}".`
        );
      }
    }
  }

  return button;
}

function createActionButton({ pages, texts, model, container, caption }) {
  const button = createWidgetByClassName({
    pages,
    className: "ActionButton",
    container
  });
  button.caption = createClientTemplate(pages, texts, model, caption);
  return button;
}

function addCallMicroflowButton({ pages, texts, model, container, caption, microflow }) {
  if (!pages.MicroflowClientAction || typeof pages.MicroflowClientAction.createInActionButtonUnderAction !== "function") {
    throw new Error("MicroflowClientAction is not available in this SDK version.");
  }

  const button = createActionButton({ pages, texts, model, container, caption: caption || "Run" });
  const action = pages.MicroflowClientAction.createInActionButtonUnderAction(button);
  if (!action.microflowSettings) {
    throw new Error("MicroflowClientAction is missing microflowSettings in this SDK version.");
  }
  action.microflowSettings.microflow = microflow;
  return button;
}

function addCallNanoflowButton({ pages, texts, model, container, caption, nanoflow }) {
  if (!pages.CallNanoflowClientAction || typeof pages.CallNanoflowClientAction.createInActionButtonUnderAction !== "function") {
    throw new Error("CallNanoflowClientAction is not available in this SDK version.");
  }

  const button = createActionButton({ pages, texts, model, container, caption: caption || "Run client flow" });
  const action = pages.CallNanoflowClientAction.createInActionButtonUnderAction(button);
  action.nanoflow = nanoflow;
  return button;
}

function addCallWorkflowButton({ pages, texts, model, container, caption, workflow }) {
  if (!pages.CallWorkflowClientAction || typeof pages.CallWorkflowClientAction.createInActionButtonUnderAction !== "function") {
    throw new Error("CallWorkflowClientAction is not available in this SDK version.");
  }

  const button = createActionButton({ pages, texts, model, container, caption: caption || "Start workflow" });
  const action = pages.CallWorkflowClientAction.createInActionButtonUnderAction(button);
  if (workflow) {
    action.workflow = workflow;
  }
  return button;
}

function addOpenUserTaskButton({
  pages,
  texts,
  model,
  container,
  caption,
  assignOnOpen = true,
  openWhenAssigned = false
}) {
  if (!pages.OpenUserTaskClientAction || typeof pages.OpenUserTaskClientAction.createInActionButtonUnderAction !== "function") {
    throw new Error("OpenUserTaskClientAction is not available in this SDK version.");
  }

  const button = createActionButton({ pages, texts, model, container, caption: caption || "Open task" });
  const action = pages.OpenUserTaskClientAction.createInActionButtonUnderAction(button);

  if ("assignOnOpen" in action) {
    action.assignOnOpen = Boolean(assignOnOpen);
  }
  if ("openWhenAssigned" in action) {
    action.openWhenAssigned = Boolean(openWhenAssigned);
  }

  return button;
}

function addSetTaskOutcomeButton({
  pages,
  texts,
  model,
  container,
  caption,
  outcomeValue,
  closePage = true,
  commit = true
}) {
  if (!pages.SetTaskOutcomeClientAction || typeof pages.SetTaskOutcomeClientAction.createInActionButtonUnderAction !== "function") {
    throw new Error("SetTaskOutcomeClientAction is not available in this SDK version.");
  }

  const button = createActionButton({
    pages,
    texts,
    model,
    container,
    caption: caption || outcomeValue || "Complete task"
  });
  const action = pages.SetTaskOutcomeClientAction.createInActionButtonUnderAction(button);

  if ("outcomeValue" in action) {
    action.outcomeValue = String(outcomeValue || "Complete");
  }
  if ("closePage" in action) {
    action.closePage = Boolean(closePage);
  }
  if ("commit" in action) {
    action.commit = Boolean(commit);
  }

  return button;
}

function addDeleteObjectButton({ pages, texts, model, container, caption, closePage = false }) {
  if (!pages.DeleteClientAction || typeof pages.DeleteClientAction.createInActionButtonUnderAction !== "function") {
    throw new Error("DeleteClientAction is not available in this SDK version.");
  }

  const button = createActionButton({ pages, texts, model, container, caption: caption || "Delete" });
  const action = pages.DeleteClientAction.createInActionButtonUnderAction(button);
  if ("closePage" in action) {
    action.closePage = Boolean(closePage);
  }
  return button;
}

function addClosePageButton({ pages, texts, model, container, caption, numberOfPagesToClose = "1" }) {
  if (!pages.ClosePageClientAction || typeof pages.ClosePageClientAction.createInActionButtonUnderAction !== "function") {
    throw new Error("ClosePageClientAction is not available in this SDK version.");
  }

  const button = createActionButton({ pages, texts, model, container, caption: caption || "Close" });
  const action = pages.ClosePageClientAction.createInActionButtonUnderAction(button);
  if ("numberOfPagesToClose" in action) {
    action.numberOfPagesToClose = String(numberOfPagesToClose || "1");
  }
  return button;
}

function addOpenLinkButton({ pages, texts, model, container, caption, url, linkType = "Web" }) {
  if (!pages.OpenLinkClientAction || typeof pages.OpenLinkClientAction.createInActionButtonUnderAction !== "function") {
    throw new Error("OpenLinkClientAction is not available in this SDK version.");
  }

  const button = createActionButton({ pages, texts, model, container, caption: caption || "Open link" });
  const action = pages.OpenLinkClientAction.createInActionButtonUnderAction(button);
  if (!action.address) {
    throw new Error("OpenLinkClientAction.address is unavailable in this SDK version.");
  }

  action.address.isDynamic = false;
  action.address.value = String(url || "");

  if (pages.LinkType && pages.LinkType[linkType]) {
    action.linkType = pages.LinkType[linkType];
  }

  return button;
}

function configureGridSearchBar({
  pages,
  texts,
  model,
  domainmodels,
  moduleName,
  entity,
  dataSource,
  searchSpec = {}
}) {
  if (!dataSource || !("searchBar" in dataSource)) return;
  if (!searchSpec || typeof searchSpec !== "object") return;

  const searchBar = dataSource.searchBar || (pages.SearchBar ? pages.SearchBar.create(dataSource.model) : null);
  if (!searchBar) return;
  dataSource.searchBar = searchBar;

  const searchBarType = resolveSearchBarType(pages, searchSpec.type, searchSpec.enabled !== false);
  if (searchBarType && "type" in searchBar) {
    searchBar.type = searchBarType;
  }

  if (searchSpec.waitForSearch !== undefined && "waitForSearch" in searchBar) {
    searchBar.waitForSearch = Boolean(searchSpec.waitForSearch);
  }

  if (!Array.isArray(searchBar.items)) return;
  clearList(searchBar.items);

  const fields = Array.isArray(searchSpec.fields) ? searchSpec.fields : [];
  const usedNames = new Set();
  for (const fieldSpec of fields) {
    if (!fieldSpec || typeof fieldSpec !== "object") continue;
    const attr = resolveAttributeReference({
      model,
      entity,
      rawAttributeRef: fieldSpec.attributeRef || fieldSpec.attribute || fieldSpec.attributeName
    });
    if (!attr) continue;

    const fieldType = String(fieldSpec.fieldType || "contains").trim().toLowerCase();
    const attributeKind = detectAttributeKind(attr);
    const wantsDropDown = fieldType === "dropdown" || fieldType === "enumdropdown" || fieldType === "booleandropdown";
    const isDropDown = wantsDropDown && (attributeKind === "Enum" || attributeKind === "Boolean");

    let searchField = null;
    if (isDropDown && pages.DropDownSearchField && typeof pages.DropDownSearchField.createIn === "function") {
      searchField = pages.DropDownSearchField.createIn(searchBar);
      if (fieldSpec.xPathConstraint && "xPathConstraint" in searchField) {
        searchField.xPathConstraint = String(fieldSpec.xPathConstraint);
      }
      if (fieldSpec.allowMultipleSelect !== undefined && "allowMultipleSelect" in searchField) {
        searchField.allowMultipleSelect = Boolean(fieldSpec.allowMultipleSelect);
      }
    } else if (pages.ComparisonSearchField && typeof pages.ComparisonSearchField.createIn === "function") {
      searchField = pages.ComparisonSearchField.createIn(searchBar);
      const operator =
        resolveSearchFieldOperator(pages, fieldSpec.operator || fieldSpec.fieldType || "contains") || null;
      if (operator && "operator" in searchField) {
        searchField.operator = operator;
      }
    }

    if (!searchField) continue;
    bindAttributeRefOnSearchField(domainmodels, searchField, attr);

    const caption = fieldSpec.caption || fieldSpec.label || toHumanLabel(attr.name || fieldSpec.attributeRef || "");
    if (caption) {
      if ("caption" in searchField) {
        searchField.caption = createText(texts, model, caption);
      }
      if ("placeholder" in searchField && fieldSpec.placeholder) {
        searchField.placeholder = createText(texts, model, String(fieldSpec.placeholder));
      }
    }

    if ("name" in searchField) {
      const baseName = toSafeName(`search_${fieldSpec.name || attr.name || "field"}`, "search_field");
      let finalName = baseName;
      let suffix = 2;
      while (usedNames.has(finalName)) {
        finalName = `${baseName}_${suffix}`;
        suffix += 1;
      }
      usedNames.add(finalName);
      searchField.name = finalName;
    }
  }
}

function createClassicGridDefaultButton({
  pages,
  texts,
  model,
  grid,
  targetPage,
  targetMeta,
  sourceEntity = null
}) {
  if (!targetPage) return null;
  if (!pages.GridControlBar || typeof pages.GridControlBar.createIn !== "function") {
    throw new Error("GridControlBar is unavailable in this SDK version.");
  }
  if (!pages.GridActionButton || typeof pages.GridActionButton.createIn !== "function") {
    throw new Error("GridActionButton is unavailable in this SDK version.");
  }
  if (!pages.PageClientAction || typeof pages.PageClientAction.createInGridActionButtonUnderAction !== "function") {
    throw new Error("PageClientAction for GridActionButton is unavailable in this SDK version.");
  }

  const controlBar = grid.controlBar || pages.GridControlBar.createIn(grid);
  const button = pages.GridActionButton.createIn(controlBar);
  button.caption = createClientTemplate(pages, texts, model, targetPage.name ? `Open ${toHumanLabel(targetPage.name)}` : "Open");
  ensureWidgetName(button, toSafeName(targetPage.name ? `open_${targetPage.name}` : "grid_open_button", "grid_open_button"));

  const action = pages.PageClientAction.createInGridActionButtonUnderAction(button);
  const settings =
    action.pageSettings ||
    (pages.PageSettings && typeof pages.PageSettings.createInPageClientActionUnderPageSettings === "function"
      ? pages.PageSettings.createInPageClientActionUnderPageSettings(action)
      : null);

  configurePageSettingsForTarget({
    pages,
    settings,
    targetPage,
    targetMeta,
    explicitMappings: null,
    defaultExpression: "",
    sourceEntity,
    allowImplicitSingleSelectionBinding: true
  });

  if ("selectionMode" in grid && pages.GridSelectionMode && pages.GridSelectionMode.Single) {
    grid.selectionMode = pages.GridSelectionMode.Single;
  }
  if ("defaultButton" in controlBar) {
    controlBar.defaultButton = button;
  }
  if ("defaultButtonTrigger" in grid && pages.ClickTypeType && pages.ClickTypeType.DoubleClick) {
    grid.defaultButtonTrigger = pages.ClickTypeType.DoubleClick;
  }

  return button;
}

function ensureGridControlBar({ pages, grid }) {
  if (!pages.GridControlBar || typeof pages.GridControlBar.createIn !== "function") {
    throw new Error("GridControlBar is unavailable in this SDK version.");
  }
  return grid.controlBar || pages.GridControlBar.createIn(grid);
}

function createGridActionButtonBase({ pages, texts, model, controlBar, caption }) {
  if (!pages.GridActionButton || typeof pages.GridActionButton.createIn !== "function") {
    throw new Error("GridActionButton is unavailable in this SDK version.");
  }
  const button = pages.GridActionButton.createIn(controlBar);
  button.caption = createClientTemplate(pages, texts, model, caption || "Action");
  ensureWidgetName(button, toSafeName(String(caption || "grid_action_button"), "grid_action_button"));
  return button;
}

function addGridCreateObjectButton({
  pages,
  texts,
  model,
  domainmodels,
  grid,
  caption,
  entity,
  targetPage,
  targetMeta
}) {
  if (!pages.CreateObjectClientAction || typeof pages.CreateObjectClientAction.createInGridActionButtonUnderAction !== "function") {
    throw new Error("CreateObjectClientAction for GridActionButton is unavailable in this SDK version.");
  }

  const controlBar = ensureGridControlBar({ pages, grid });
  const button = createGridActionButtonBase({ pages, texts, model, controlBar, caption: caption || "New" });
  const action = pages.CreateObjectClientAction.createInGridActionButtonUnderAction(button);
  setEntityRefOnCreateObjectAction({ domainmodels, action, entity });

  if (targetPage) {
    const settings =
      action.pageSettings ||
      (pages.PageSettings && typeof pages.PageSettings.createInCreateObjectClientActionUnderPageSettings === "function"
        ? pages.PageSettings.createInCreateObjectClientActionUnderPageSettings(action)
        : null);

    if (!settings) {
      throw new Error("Could not configure page settings for dataGrid createObjectButton.");
    }

    settings.page = targetPage;

    const requiredEntries = targetMeta && Array.isArray(targetMeta.requiredEntries) ? targetMeta.requiredEntries : [];
    if (requiredEntries.length > 1) {
      throw new Error(
        `dataGrid createObjectButton target "${targetPage.name}" has multiple required parameters. ` +
          "Use a page with one required object parameter."
      );
    }

    if (requiredEntries.length === 1) {
      const targetEntity = requiredEntries[0].entity;
      const sourceEntity = entity;
      const sourceQname = getEntityQualifiedName(sourceEntity) || sourceEntity.name || "";
      const targetQname = getEntityQualifiedName(targetEntity) || targetEntity.name || "";

      const idMismatch =
        sourceEntity &&
        targetEntity &&
        "id" in sourceEntity &&
        "id" in targetEntity &&
        sourceEntity.id &&
        targetEntity.id &&
        sourceEntity.id !== targetEntity.id;
      const nameMismatch = sourceQname && targetQname && sourceQname !== targetQname;
      if (idMismatch || nameMismatch) {
        throw new Error(
          `dataGrid createObjectButton entity mismatch: created entity "${sourceQname}" does not match ` +
            `target page parameter entity "${targetQname}".`
        );
      }
    }
  }

  return button;
}

function addGridDeleteObjectButton({ pages, texts, model, grid, caption, closePage = false }) {
  if (!pages.DeleteClientAction || typeof pages.DeleteClientAction.createInGridActionButtonUnderAction !== "function") {
    throw new Error("DeleteClientAction for GridActionButton is not available in this SDK version.");
  }

  const controlBar = ensureGridControlBar({ pages, grid });
  const button = createGridActionButtonBase({ pages, texts, model, controlBar, caption: caption || "Delete" });
  const action = pages.DeleteClientAction.createInGridActionButtonUnderAction(button);
  if ("closePage" in action) {
    action.closePage = Boolean(closePage);
  }
  if ("selectionMode" in grid && pages.GridSelectionMode && pages.GridSelectionMode.Single) {
    grid.selectionMode = pages.GridSelectionMode.Single;
  }
  return button;
}

function addClassicGridControlBarButtons({
  pages,
  texts,
  model,
  domainmodels,
  grid,
  step,
  entity,
  pagesByRef,
  pageMetaByRef
}) {
  const buttons = Array.isArray(step.controlBarButtons) ? step.controlBarButtons : [];
  for (const buttonSpec of buttons) {
    if (!buttonSpec || typeof buttonSpec !== "object") continue;
    const type = String(buttonSpec.type || "").trim();

    if (type === "createObjectButton") {
      const targetPage = buttonSpec.targetPageRef ? pagesByRef[buttonSpec.targetPageRef] : null;
      if (buttonSpec.targetPageRef && !targetPage) {
        throw new Error(`dataGrid createObjectButton target "${buttonSpec.targetPageRef}" not found.`);
      }
      addGridCreateObjectButton({
        pages,
        texts,
        model,
        domainmodels,
        grid,
        caption: buttonSpec.caption || "New",
        entity,
        targetPage,
        targetMeta: getTargetPageMeta(buttonSpec, targetPage, pageMetaByRef)
      });
      continue;
    }

    if (type === "deleteObjectButton") {
      addGridDeleteObjectButton({
        pages,
        texts,
        model,
        grid,
        caption: buttonSpec.caption || "Delete",
        closePage: buttonSpec.closePage === true
      });
      continue;
    }

    throw new Error(`Unsupported dataGrid controlBarButton type "${type}".`);
  }
}

function createClassicDataGridFromStep({
  pages,
  texts,
  model,
  domainmodels,
  moduleName,
  pageSpec,
  pageContext,
  container,
  step,
  entity,
  pagesByRef,
  pageMetaByRef
}) {
  const widget = createWidgetByClassName({
    pages,
    className: "DataGrid",
    container,
    createMethod: step.createMethod || ""
  });

  const sourceCfg = normalizeDataSourceStep(step);
  configureDataSource({
    domainmodels,
    dataSource: widget.dataSource,
    entity,
    xPathConstraint: sourceCfg.xPathConstraint,
    dataSourceProps: sourceCfg.props
  });

  const numberOfRows = typeof step.pageSize === "number" ? step.pageSize : step.numberOfRows;
  if (typeof numberOfRows === "number" && "numberOfRows" in widget) {
    widget.numberOfRows = Math.max(1, numberOfRows);
  }
  if ("showPagingBar" in widget && pages.ShowPagingBarType && pages.ShowPagingBarType.Yes) {
    widget.showPagingBar = pages.ShowPagingBarType.Yes;
  }
  if ("caption" in widget && step.caption) {
    widget.caption = createClientTemplate(pages, texts, model, step.caption);
  }

  const searchSpec = normalizeDataGridSearchSpec(step);
  if (searchSpec.enabled !== false && Array.isArray(searchSpec.fields) && searchSpec.fields.length > 0) {
    configureGridSearchBar({
      pages,
      texts,
      model,
      domainmodels,
      moduleName,
      entity,
      dataSource: widget.dataSource,
      searchSpec
    });
  }

  clearList(widget.columns);
  let columnCount = 0;
  for (const colSpec of Array.isArray(step.columns) ? step.columns : []) {
    const rawAttributeRef = colSpec.attributeRef || colSpec.attribute || colSpec.attributeName || "";
    const attribute = resolveAttributeReference({
      model,
      entity,
      rawAttributeRef
    });
    if (!attribute) {
      throw new Error(`Could not resolve dataGrid column attribute "${rawAttributeRef}".`);
    }

    if (!pages.GridColumn || typeof pages.GridColumn.createIn !== "function") {
      throw new Error("GridColumn is unavailable in this SDK version.");
    }

    const column = pages.GridColumn.createIn(widget);
    bindAttributeRef(domainmodels, column, attribute);
    column.name = toSafeName(colSpec.name || attribute.name || `grid_column_${columnCount + 1}`, `grid_column_${columnCount + 1}`);
    if ("caption" in column) {
      column.caption = createText(texts, model, colSpec.caption || colSpec.label || toHumanLabel(attribute.name));
    }
    columnCount += 1;
  }

  if (columnCount === 0) {
    throw new Error("dataGrid requires at least one resolvable column.");
  }

  const rowClickTargetRef = String(step.rowClickTargetPageRef || "").trim();
  if (rowClickTargetRef) {
    const targetPage = pagesByRef[rowClickTargetRef];
    if (!targetPage) {
      throw new Error(`dataGrid rowClick target "${rowClickTargetRef}" not found.`);
    }
    createClassicGridDefaultButton({
      pages,
      texts,
      model,
      grid: widget,
      targetPage,
      targetMeta: getTargetPageMeta({ targetPageRef: rowClickTargetRef }, targetPage, pageMetaByRef),
      sourceEntity: entity
    });
  }

  addClassicGridControlBarButtons({
    pages,
    texts,
    model,
    domainmodels,
    grid: widget,
    step,
    entity,
    pagesByRef,
    pageMetaByRef
  });

  applyWidgetProps(widget, step.props);
  ensureWidgetName(widget, step.name || step.autoName || "data_grid");
  return widget;
}

function configureCustomWidgetPropertyValue({
  pages,
  texts,
  model,
  domainmodels,
  customwidgets,
  moduleName,
  pageSpec,
  pageContext,
  step,
  widgetObject,
  propertyType,
  rawValue,
  pagesByRef,
  pageMetaByRef,
  microflowRefsByRef = {},
  nanoflowRefsByRef = {}
}) {
  const valueTypeName = toWidgetValueTypeName(propertyType && propertyType.valueType).toLowerCase();
  const isList = Boolean(propertyType && propertyType.valueType && propertyType.valueType.isList);
  const values = isList ? (Array.isArray(rawValue) ? rawValue : []) : [rawValue];

  if (!valueTypeName) {
    throw new Error(`Custom widget property "${propertyType && propertyType.key}" has no value type metadata.`);
  }

  const createValue = () =>
    createWidgetPropertyValue({
      customwidgets,
      widgetObject,
      propertyType
    });

  if (valueTypeName === "object") {
    const nestedPropertyTypes = toArrayFromList(
      propertyType && propertyType.valueType && propertyType.valueType.objectType
        ? propertyType.valueType.objectType.propertyTypes
        : []
    );
    const inputObjects = isList ? values : [rawValue];
    const value = createValue();
    for (const item of inputObjects) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (!customwidgets.WidgetObject || typeof customwidgets.WidgetObject.createInWidgetValueUnderObjects !== "function") {
        throw new Error(`Custom widget property "${propertyType.key}" requires nested object support.`);
      }
      const object = customwidgets.WidgetObject.createInWidgetValueUnderObjects(value);
      if (propertyType.valueType && propertyType.valueType.objectType) {
        object.type = propertyType.valueType.objectType;
      }
      for (const [nestedKey, nestedRawValue] of Object.entries(item)) {
        const nestedType = nestedPropertyTypes.find((candidate) => String(candidate && candidate.key || "").trim() === nestedKey);
        if (!nestedType) continue;
        configureCustomWidgetPropertyValue({
          pages,
          texts,
          model,
          domainmodels,
          customwidgets,
          moduleName,
          pageSpec,
          pageContext,
          step,
          widgetObject: object,
          propertyType: nestedType,
          rawValue: nestedRawValue,
          pagesByRef,
          pageMetaByRef,
          microflowRefsByRef,
          nanoflowRefsByRef
        });
      }
    }
    return;
  }

  const contextEntity = resolveCustomWidgetContextEntity({ model, moduleName, pageSpec, pageContext, step });
  for (const item of values) {
    if (item === undefined || item === null) continue;
    const value = createValue();

    if (["string", "integer", "decimal", "boolean", "enumeration", "entityconstraint", "selection", "expression"].includes(valueTypeName)) {
      setWidgetValuePrimitive(value, item);
      continue;
    }

    if (["texttemplate", "translatablestring"].includes(valueTypeName)) {
      if (!setWidgetValueTextTemplate({ pages, texts, model, value, text: item })) {
        setWidgetValuePrimitive(value, item);
      }
      continue;
    }

    if (valueTypeName === "attribute") {
      const attributeRef =
        typeof item === "string"
          ? item
          : item && typeof item === "object"
            ? item.attributeRef || item.attribute || item.attributeName || ""
            : "";
      const attribute = resolveAttributeReference({
        model,
        entity: contextEntity,
        rawAttributeRef: attributeRef
      });
      if (!attribute || !setWidgetValueAttributeRef({ domainmodels, value, attribute })) {
        throw new Error(`Could not bind custom widget attribute property "${propertyType.key}" to "${attributeRef}".`);
      }
      continue;
    }

    if (valueTypeName === "datasource") {
      const sourceSpec = item && typeof item === "object" ? item : {};
      const sourceEntity =
        resolveEntityReference(model, moduleName, sourceSpec.entityRef || sourceSpec.entity || "") || contextEntity;
      if (
        !setWidgetValueXPathSource({
          customwidgets,
          domainmodels,
          value,
          entity: sourceEntity,
          xPathConstraint: sourceSpec.xPathConstraint,
          dataSourceProps: sourceSpec.props || {}
        })
      ) {
        throw new Error(`Could not configure custom widget datasource property "${propertyType.key}".`);
      }
      continue;
    }

    if (valueTypeName === "action") {
      const actionSpec = item && typeof item === "object" ? item : {};
      const targetRef = String(actionSpec.pageRef || actionSpec.targetPageRef || "").trim();
      const targetPage = targetRef ? pagesByRef[targetRef] : null;
      if (!targetPage) {
        throw new Error(`Custom widget action property "${propertyType.key}" requires pageRef.`);
      }
      setWidgetValuePageAction({
        pages,
        value,
        targetPage,
        targetMeta: getTargetPageMeta({ targetPageRef: targetRef }, targetPage, pageMetaByRef),
        parameterMappings: actionSpec.parameterMappings || null,
        defaultExpression: actionSpec.defaultExpression || "$currentObject"
      });
      continue;
    }

    if (valueTypeName === "microflow") {
      const microflow = resolveMicroflowReference({
        model,
        moduleName,
        step:
          typeof item === "string"
            ? { microflowRef: item }
            : {
                microflowRef: item.microflowRef || item.ref || "",
                microflowQualifiedName: item.microflowQualifiedName || item.qualifiedName || ""
              },
        microflowRefsByRef
      });
      if (!microflow || !setWidgetValueMicroflowRef({ value, microflow })) {
        throw new Error(`Could not resolve custom widget microflow property "${propertyType.key}".`);
      }
      continue;
    }

    if (valueTypeName === "nanoflow") {
      const nanoflow = resolveNanoflowReference({
        model,
        moduleName,
        step:
          typeof item === "string"
            ? { nanoflowRef: item }
            : {
                nanoflowRef: item.nanoflowRef || item.ref || "",
                nanoflowQualifiedName: item.nanoflowQualifiedName || item.qualifiedName || ""
              },
        nanoflowRefsByRef
      });
      if (!nanoflow || !setWidgetValueNanoflowRef({ value, nanoflow })) {
        throw new Error(`Could not resolve custom widget nanoflow property "${propertyType.key}".`);
      }
      continue;
    }

    throw new Error(
      `Custom widget property "${propertyType.key}" uses unsupported value type "${valueTypeName}" in deterministic mode.`
    );
  }
}

function createGenericCustomWidgetFromStep({
  pages,
  texts,
  model,
  domainmodels,
  customwidgets,
  moduleName,
  pageSpec,
  pageContext,
  container,
  step,
  pagesByRef,
  pageMetaByRef,
  microflowRefsByRef = {},
  nanoflowRefsByRef = {}
}) {
  if (!customwidgets || !customwidgets.CustomWidgetType) {
    throw new Error("Custom widget support is unavailable in this SDK build.");
  }

  const widget = createCustomWidget({
    customwidgets,
    container,
    createMethod: step.createMethod || ""
  });
  ensureWidgetName(widget, step.name || step.autoName || toSafeName(step.widgetName || step.widgetId || "widget"));

  const widgetType = customwidgets.CustomWidgetType.createIn(widget);
  const normalizedWidgetId = normalizeBuiltInChartWidgetId(step.widgetId);
  widgetType.widgetId = normalizedWidgetId;
  widgetType.name = step.widgetName || step.className || normalizedWidgetId;
  if ("pluginWidget" in widgetType) {
    widgetType.pluginWidget = true;
  }

  const objectType = ensureWidgetObjectType(customwidgets, widgetType);
  if (!objectType) {
    throw new Error(`Could not initialize object type metadata for custom widget "${step.widgetId}".`);
  }

  if (Array.isArray(step.propertyTypes) && step.propertyTypes.length > 0) {
    applyCustomWidgetPropertyTypeSpecs({
      customwidgets,
      model,
      objectType,
      propertyTypeSpecs: step.propertyTypes
    });
  }

  const widgetObject = widget.object || customwidgets.WidgetObject.createInCustomWidgetUnderObject(widget);
  widgetObject.type = widgetType.objectType || objectType;
  clearList(widgetObject.properties);

  const propSpecs = step.props && typeof step.props === "object" ? step.props : {};
  const rootPropertyTypes = toArrayFromList(widgetObject.type && widgetObject.type.propertyTypes ? widgetObject.type.propertyTypes : []);
  for (const [key, rawValue] of Object.entries(propSpecs)) {
    const propertyType = rootPropertyTypes.find((candidate) => String(candidate && candidate.key || "").trim() === key);
    if (!propertyType) {
      throw new Error(`Custom widget "${normalizedWidgetId}" does not expose property "${key}".`);
    }
    configureCustomWidgetPropertyValue({
      pages,
      texts,
      model,
      domainmodels,
      customwidgets,
      moduleName,
      pageSpec,
      pageContext,
      step,
      widgetObject,
      propertyType,
      rawValue,
      pagesByRef,
      pageMetaByRef,
      microflowRefsByRef,
      nanoflowRefsByRef
    });
  }

  return widget;
}

function bindAttributeInputEvents({
  pages,
  model,
  moduleName,
  widget,
  step,
  microflowRefsByRef = {},
  nanoflowRefsByRef = {}
}) {
  if (!step || typeof step !== "object" || !step.events || typeof step.events !== "object") return;
  if (!widget || !("onChangeAction" in widget)) return;

  const events = step.events;
  const onChangeMicroflowRef = events.onChangeMicroflowRef || events.onChangeMicroflowQualifiedName || "";
  const onChangeNanoflowRef = events.onChangeNanoflowRef || events.onChangeNanoflowQualifiedName || "";

  if (onChangeMicroflowRef && onChangeNanoflowRef) {
    throw new Error(
      `attributeInput "${step.name || step.attributeRef || ""}" cannot specify both onChangeMicroflowRef and onChangeNanoflowRef.`
    );
  }

  if (onChangeMicroflowRef) {
    const mf = resolveMicroflowReference({
      model,
      moduleName,
      step: {
        microflowRef: events.onChangeMicroflowRef || "",
        microflowQualifiedName: events.onChangeMicroflowQualifiedName || ""
      },
      microflowRefsByRef
    });
    if (!mf) {
      throw new Error(
        `attributeInput onChangeMicroflowRef "${events.onChangeMicroflowRef || events.onChangeMicroflowQualifiedName}" not found.`
      );
    }

    if (
      !pages.MicroflowClientAction ||
      typeof pages.MicroflowClientAction.createInAttributeWidgetUnderOnChangeAction !== "function"
    ) {
      throw new Error("MicroflowClientAction.onChange is not available in this SDK version.");
    }

    const action = pages.MicroflowClientAction.createInAttributeWidgetUnderOnChangeAction(widget);
    if (!action.microflowSettings) {
      throw new Error("MicroflowClientAction is missing microflowSettings for onChange binding.");
    }
    action.microflowSettings.microflow = mf;

    const callType = String(events.callType || "synchronous").trim().toLowerCase();
    if ("asynchronous" in action.microflowSettings) {
      action.microflowSettings.asynchronous = callType === "asynchronous" || callType === "async";
    }
    return;
  }

  if (onChangeNanoflowRef) {
    const nf = resolveNanoflowReference({
      model,
      moduleName,
      step: {
        nanoflowRef: events.onChangeNanoflowRef || "",
        nanoflowQualifiedName: events.onChangeNanoflowQualifiedName || ""
      },
      nanoflowRefsByRef
    });
    if (!nf) {
      throw new Error(
        `attributeInput onChangeNanoflowRef "${events.onChangeNanoflowRef || events.onChangeNanoflowQualifiedName}" not found.`
      );
    }

    if (
      !pages.CallNanoflowClientAction ||
      typeof pages.CallNanoflowClientAction.createInAttributeWidgetUnderOnChangeAction !== "function"
    ) {
      throw new Error("CallNanoflowClientAction.onChange is not available in this SDK version.");
    }

    const action = pages.CallNanoflowClientAction.createInAttributeWidgetUnderOnChangeAction(widget);
    action.nanoflow = nf;
  }
}

function addAttributeInputWidget({
  pages,
  texts,
  model,
  domainmodels,
  moduleName,
  pageSpec,
  pageContext,
  container,
  step,
  microflowRefsByRef = {},
  nanoflowRefsByRef = {}
}) {
  const entity =
    resolveEntityForStep({ model, moduleName, pageSpec, step }) ||
    (pageContext && pageContext.defaultEntry ? pageContext.defaultEntry.entity : null);
  const entityQname =
    getEntityQualifiedName(entity) ||
    normalizeEntityQualifiedName(step.entityRef || step.entity || pageSpec.entityRef || pageSpec.entity || "", moduleName) ||
    (pageContext && pageContext.defaultEntry && pageContext.defaultEntry.entity
      ? String(pageContext.defaultEntry.entity.qualifiedName || "")
      : "");

  if (!entity && !entityQname) {
    throw new Error("attributeInput requires an entityRef on step/page or a page parameter context.");
  }

  const rawAttributeRef = step.attributeRef || step.attribute || step.attributeName;
  const attribute = resolveAttributeReference({ model, entity, rawAttributeRef });
  const attributeQname = !attribute && entityQname && rawAttributeRef ? `${entityQname}.${String(rawAttributeRef).trim()}` : "";
  if (!attribute && !attributeQname) {
    throw new Error(`Could not resolve attribute "${rawAttributeRef}".`);
  }

  const kind = detectAttributeKind(attribute);
  const className =
    kind === "Boolean" ? "CheckBox" : kind === "Enum" ? "RadioButtonGroup" : kind === "DateTime" ? "DatePicker" : "TextBox";

  const widget = createWidgetByClassName({
    pages,
    className,
    container,
    createMethod: step.createMethod || ""
  });

  if (attribute) {
    bindAttributeRef(domainmodels, widget, attribute);
  } else {
    const bound = bindAttributeRefRaw(domainmodels, widget, attributeQname);
    if (!bound) {
      throw new Error(`Could not resolve attribute "${rawAttributeRef}".`);
    }
  }

  const resolvedLabel = resolveInputLabel(step, attribute, rawAttributeRef);
  if (resolvedLabel) {
    if ("labelTemplate" in widget) {
      widget.labelTemplate = createClientTemplate(pages, texts, model, resolvedLabel);
    } else if ("label" in widget) {
      widget.label = createText(texts, model, resolvedLabel);
    } else if ("labelCaption" in widget) {
      widget.labelCaption = createText(texts, model, resolvedLabel);
    }
  }

  bindAttributeInputEvents({
    pages,
    model,
    moduleName,
    widget,
    step,
    microflowRefsByRef,
    nanoflowRefsByRef
  });

  applyWidgetProps(widget, step.props);
  ensureWidgetName(widget, step.name || step.autoName || toSafeName(rawAttributeRef, "field"));

  return widget;
}

function addNestedContentSteps({
  pages,
  texts,
  model,
  domainmodels,
  customwidgets,
  moduleName,
  pageSpec,
  pageContext,
  content,
  container,
  pagesByRef,
  pageMetaByRef,
  microflowRefsByRef = {},
  nanoflowRefsByRef = {},
  workflowRefsByRef = {},
  dataGrid2Context = null,
  autoNamePrefix = "nested"
}) {
  const steps = Array.isArray(content) ? content : [];
  for (let i = 0; i < steps.length; i++) {
    const nested = { ...steps[i] };
    nested.autoName = nested.autoName || `${autoNamePrefix}_${toSafeName(nested.type)}_${i + 1}`;
    addContentStep({
      pages,
      texts,
      model,
      domainmodels,
      customwidgets,
      moduleName,
      pageSpec,
      pageContext,
      container,
      step: nested,
      pagesByRef,
      pageMetaByRef,
      microflowRefsByRef,
      nanoflowRefsByRef,
      workflowRefsByRef,
      dataGrid2Context
    });
  }
}

function createListViewWidgetFromGridStep({
  pages,
  texts,
  model,
  domainmodels,
  moduleName,
  pageSpec,
  container,
  step,
  entity,
  entityQname = "",
  pagesByRef,
  pageMetaByRef,
  pageContext,
  microflowRefsByRef,
  nanoflowRefsByRef,
  workflowRefsByRef
}) {
  const sourceCfg = normalizeDataSourceStep(step);

  const widget = createWidgetByClassName({
    pages,
    className: "ListView",
    container,
    createMethod: step.createMethod || ""
  });

  configureDataSource({
    domainmodels,
    dataSource: widget.dataSource,
    entity,
    entityQname,
    xPathConstraint: sourceCfg.xPathConstraint,
    dataSourceProps: sourceCfg.props
  });

  const pageSize = typeof step.pageSize === "number" ? step.pageSize : step.numberOfRows;
  if (typeof pageSize === "number" && "pageSize" in widget) {
    widget.pageSize = pageSize;
  }
  if (typeof step.numberOfColumns === "number" && "numberOfColumns" in widget) {
    widget.numberOfColumns = step.numberOfColumns;
  }

  applyWidgetProps(widget, step.props);
  ensureWidgetName(widget, step.name || step.autoName || "data_grid");

  const templateContent = getTemplateContentFromStep(step);
  const content = templateContent.length > 0 ? templateContent : buildGridFallbackTemplateContent(step);

  addNestedContentSteps({
    pages,
    texts,
    model,
    domainmodels,
    moduleName,
    pageSpec,
    pageContext,
    content,
    container: widget,
    pagesByRef,
    pageMetaByRef,
    microflowRefsByRef,
    nanoflowRefsByRef,
    workflowRefsByRef,
    autoNamePrefix: `${toSafeName(pageSpec.name)}_${toSafeName(step.name || step.autoName || widget.name || "list")}_list_item`
  });

  let rowClickTargetPage = null;
  let rowClickTargetMeta = null;

  if (step.rowClickTargetPageRef) {
    rowClickTargetPage = pagesByRef[step.rowClickTargetPageRef];
    if (!rowClickTargetPage) {
      throw new Error(`rowClickTargetPageRef "${step.rowClickTargetPageRef}" not found.`);
    }
    rowClickTargetMeta = getTargetPageMeta({ targetPageRef: step.rowClickTargetPageRef }, rowClickTargetPage, pageMetaByRef);
  } else if (step.autoRowClickToDetail !== false) {
    const inferred = inferListViewRowClickTarget({
      pageSpec,
      entity,
      pagesByRef,
      pageMetaByRef
    });
    if (inferred) {
      rowClickTargetPage = inferred.page;
      rowClickTargetMeta = inferred.meta;
    }
  }

  if (rowClickTargetPage) {

    if (!pages.PageClientAction || typeof pages.PageClientAction.createInListViewUnderClickAction !== "function") {
      throw new Error("PageClientAction for ListView click is not available in this SDK version.");
    }

    const action = pages.PageClientAction.createInListViewUnderClickAction(widget);
    const settings =
      action.pageSettings ||
      (pages.PageSettings && typeof pages.PageSettings.createInPageClientActionUnderPageSettings === "function"
        ? pages.PageSettings.createInPageClientActionUnderPageSettings(action)
        : null);

    configurePageSettingsForTarget({
      pages,
      settings,
      targetPage: rowClickTargetPage,
      targetMeta: rowClickTargetMeta,
      explicitMappings: null,
      defaultExpression: "$currentObject"
    });
  }

  return widget;
}

function configureDataGrid2WidgetFromStep({
  pages,
  texts,
  model,
  domainmodels,
  customwidgets,
  widget,
  widgetType,
  step,
  entity,
  useFallbackSchema = false
}) {
  if (!widgetType || !widgetType.objectType) {
    throw new Error("Data Grid 2 widget type metadata is missing objectType.");
  }

  let rootPropertyTypes = toArrayFromList(widgetType.objectType.propertyTypes);
  if (rootPropertyTypes.length === 0 && useFallbackSchema) {
    ensureFallbackDataGrid2PropertyTypes({
      customwidgets,
      model,
      widgetType
    });
    rootPropertyTypes = toArrayFromList(widgetType.objectType.propertyTypes);
  }
  if (rootPropertyTypes.length === 0) {
    throw new Error(
      `Data Grid 2 metadata is empty for widgetId "${widgetType.widgetId}". ` +
        "Could not configure datasource/columns."
    );
  }

  const dataSourcePropertyType = findRootDataSourcePropertyType(customwidgets, rootPropertyTypes);
  const columnsPropertyType = findRootColumnsPropertyType(customwidgets, rootPropertyTypes);
  const columnAttributePropertyType = findColumnAttributePropertyType(customwidgets, columnsPropertyType);
  const columnHeaderPropertyType = findColumnHeaderPropertyType(customwidgets, columnsPropertyType);
  const pageSizePropertyType = findRootIntegerPropertyType(customwidgets, rootPropertyTypes, "pageSize");

  if (!dataSourcePropertyType) {
    throw new Error(`Could not resolve Data Grid 2 datasource property for widgetId "${widgetType.widgetId}".`);
  }
  if (!columnsPropertyType || !columnAttributePropertyType) {
    throw new Error(`Could not resolve Data Grid 2 columns property for widgetId "${widgetType.widgetId}".`);
  }

  const widgetObject = widget.object || customwidgets.WidgetObject.createInCustomWidgetUnderObject(widget);
  widgetObject.type = widgetType.objectType;
  clearList(widgetObject.properties);

  const sourceCfg = normalizeDataSourceStep(step);
  const dataSourceValue = createWidgetPropertyValue({
    customwidgets,
    widgetObject,
    propertyType: dataSourcePropertyType
  });
  const dataSourceBound = setWidgetValueXPathSource({
    customwidgets,
    domainmodels,
    value: dataSourceValue,
    entity,
    xPathConstraint: sourceCfg.xPathConstraint
  });
  if (!dataSourceBound) {
    throw new Error("Could not configure Data Grid 2 datasource in this SDK version.");
  }

  const columnsValue = createWidgetPropertyValue({
    customwidgets,
    widgetObject,
    propertyType: columnsPropertyType
  });

  let resolvedColumnCount = 0;
  for (const colSpec of Array.isArray(step.columns) ? step.columns : []) {
    const rawAttributeRef = colSpec.attributeRef || colSpec.attribute || colSpec.attributeName || "";
    const attribute = resolveAttributeReference({
      model,
      entity,
      rawAttributeRef
    });
    if (!attribute) {
      throw new Error(`Could not resolve Data Grid 2 column attribute "${rawAttributeRef}".`);
    }

    const columnObject = customwidgets.WidgetObject.createInWidgetValueUnderObjects(columnsValue);
    if (columnsPropertyType.valueType && columnsPropertyType.valueType.objectType) {
      columnObject.type = columnsPropertyType.valueType.objectType;
    }

    const attrValue = createWidgetPropertyValue({
      customwidgets,
      widgetObject: columnObject,
      propertyType: columnAttributePropertyType
    });
    const attrBound = setWidgetValueAttributeRef({
      domainmodels,
      value: attrValue,
      attribute
    });
    if (!attrBound) {
      throw new Error(`Could not bind Data Grid 2 column attribute "${rawAttributeRef}".`);
    }

    const caption = colSpec.caption || colSpec.label || toHumanLabel(attribute.name || rawAttributeRef);
    if (caption && columnHeaderPropertyType) {
      const headerValue = createWidgetPropertyValue({
        customwidgets,
        widgetObject: columnObject,
        propertyType: columnHeaderPropertyType
      });
      setWidgetValueTextTemplate({
        pages,
        texts,
        model,
        value: headerValue,
        text: caption
      });
    }

    resolvedColumnCount += 1;
  }

  if (resolvedColumnCount === 0) {
    throw new Error("Data Grid 2 could not resolve any valid columns.");
  }

  const pageSizeRaw = typeof step.pageSize === "number" ? step.pageSize : step.numberOfRows;
  if (typeof pageSizeRaw === "number" && !pageSizePropertyType) {
    throw new Error(
      `Data Grid 2 pageSize was provided, but no page-size property was found for widgetId "${widgetType.widgetId}".`
    );
  }
  if (pageSizePropertyType && typeof pageSizeRaw === "number") {
    const pageSizeValue = createWidgetPropertyValue({
      customwidgets,
      widgetObject,
      propertyType: pageSizePropertyType
    });
    setWidgetValuePrimitive(pageSizeValue, Math.max(1, pageSizeRaw));
  }
}

function createDataGrid2FromStep({
  customwidgets,
  container,
  step,
  entity,
  dataGrid2Context = null
}) {
  if (!customwidgets) {
    throw new Error("Data Grid 2 generation requires CustomWidgets metamodel support.");
  }
  if (!dataGrid2Context || !dataGrid2Context.widgetId) {
    throw new Error("Data Grid 2 metadata context is missing. Resolve widget metadata before page generation.");
  }

  validateMinimalDataGrid2Step(step);

  const widget = createCustomWidget({
    customwidgets,
    container,
    createMethod: step.createMethod || ""
  });
  ensureWidgetName(widget, step.name || step.autoName || "data_grid_2");

  const widgetType = customwidgets.CustomWidgetType.createIn(widget);
  widgetType.widgetId = dataGrid2Context.widgetId;
  widgetType.name = "Data Grid 2";
  const probeVariant = dataGrid2Context.probeVariant || {};
  if ("pluginWidget" in widgetType) {
    widgetType.pluginWidget =
      probeVariant.pluginWidget !== undefined ? Boolean(probeVariant.pluginWidget) : true;
  }
  if ("needsEntityContext" in widgetType) {
    widgetType.needsEntityContext =
      probeVariant.needsEntityContext !== undefined ? Boolean(probeVariant.needsEntityContext) : true;
  }

  if (Array.isArray(dataGrid2Context.pendingWidgets)) {
    dataGrid2Context.pendingWidgets.push({
      widget,
      widgetType,
      step: { ...step },
      entity,
      useFallbackSchema: Boolean(dataGrid2Context.useFallbackSchema)
    });
  }

  return widget;
}

const STEP_HANDLER_REGISTRY = buildStepHandlerRegistry([
  ...textStepDefs,
  ...navigationStepDefs,
  ...dataViewStepDefs,
  ...lookupStepDefs,
  ...actionStepDefs
]);

function stepNeedsPageResolution(step) {
  if (!step || !step.type) return false;
  if (step.type === "buttonToPage" && step.targetPageRef) return true;
  if (step.type === "createObjectButton" && step.targetPageRef) return true;
  if (step.type === "dataGrid" && step.rowClickTargetPageRef) return true;
  if (step.type === "listView") return true;
  return false;
}

function addContentStepLegacy({
  pages,
  texts,
  model,
  domainmodels,
  customwidgets,
  moduleName,
  pageSpec = {},
  pageContext = null,
  container,
  step,
  pagesByRef,
  pageMetaByRef = {},
  microflowRefsByRef = {},
  nanoflowRefsByRef = {},
  workflowRefsByRef = {},
  dataGrid2Context = null
}) {
  if (!step || !step.type) {
    throw new Error("Each content step must include a 'type'.");
  }

  if (step.type === "dynamicText") {
    const widget = addDynamicText({
      pages,
      texts,
      model,
      container,
      text: step.text || "",
      renderMode: step.renderMode || "Paragraph"
    });
    ensureWidgetName(widget, step.name || step.autoName || "text");
    return widget;
  }

  if (step.type === "dataView") {
    const sourceCfg = normalizeDataSourceStep(step);
    let entity = resolveEntityForStep({ model, moduleName, pageSpec, step });

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

    const widget = createWidgetByClassName({
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

    configureDataSource({
      domainmodels,
      dataSource: widget.dataSource,
      entity: dataSourceEntity,
      entityQname: dataSourceEntityQname,
      xPathConstraint: sourceCfg.xPathConstraint,
      dataSourceProps: sourceCfg.props
    });

    if (pageParameterEntry && pageParameterEntry.parameter) {
      const bound = bindEntityPathSourceToPageParameter({
        pages,
        dataSource: widget.dataSource,
        pageParameter: pageParameterEntry.parameter
      });
      if (!bound) {
        throw new Error(
          `Could not bind DataView to page parameter "${pageParameterEntry.parameter.name}". ` +
            "Check SDK version compatibility."
        );
      }
    }

    if (typeof step.labelWidth === "number" && "labelWidth" in widget) {
      widget.labelWidth = step.labelWidth;
    }
    if (typeof step.showFooter === "boolean" && "showFooter" in widget) {
      widget.showFooter = step.showFooter;
    }

    applyWidgetProps(widget, step.props);
    ensureWidgetName(widget, step.name || step.autoName || "data_view");

    addNestedContentSteps({
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
      autoNamePrefix: `${toSafeName(pageSpec.name || "page")}_data_view`
    });

    return widget;
  }

  if (step.type === "listView") {
    const entity = resolveEntityForStep({ model, moduleName, pageSpec, step });
    const entityQname = normalizeEntityQualifiedName(step.entityRef || step.entity || pageSpec.entityRef || pageSpec.entity || "", moduleName);
    if (!entity && !entityQname) {
      throw new Error("listView requires entityRef on step or page.");
    }
    return createListViewWidgetFromGridStep({
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

  if (step.type === "associationInput" || step.type === "referenceSelector") {
    const contextEntity =
      resolveEntityForStep({ model, moduleName, pageSpec, step }) ||
      (pageContext && pageContext.defaultEntry ? pageContext.defaultEntry.entity : null);
    if (!contextEntity) {
      throw new Error("associationInput requires an entityRef on step/page or a dataView page parameter context.");
    }

    const targetEntity = resolveEntityReference(model, moduleName, step.targetEntityRef || step.targetEntity || "");
    const association = findLookupAssociation({
      model,
      moduleName,
      contextEntity,
      targetEntity,
      rawAssociationRef: step.associationRef || step.association || "",
      expectsReferenceSet: false
    });

    const resolvedTargetEntity = resolveLookupDestinationEntity({
      association,
      contextEntity,
      targetEntity
    });
    if (!resolvedTargetEntity) {
      throw new Error(
        `Could not resolve lookup target entity for association "${getAssociationQualifiedName(association) || association.name}".`
      );
    }

    const displayAttribute = resolveLookupDisplayAttribute({
      model,
      targetEntity: resolvedTargetEntity,
      rawDisplayAttributeRef:
        step.displayAttributeRef || step.displayAttribute || step.attributeRef || step.attribute || ""
    });
    if (!displayAttribute) {
      throw new Error(
        `Could not resolve a display attribute on lookup target entity "${getEntityQualifiedName(resolvedTargetEntity)}".`
      );
    }

    const widget = createWidgetByClassName({
      pages,
      className: "ReferenceSelector",
      container,
      createMethod: step.createMethod || ""
    });

    const bound = bindLookupAttributeRefOnWidget({
      domainmodels,
      widget,
      association,
      targetEntity: resolvedTargetEntity,
      displayAttribute
    });
    if (!bound) {
      throw new Error(
        `Could not bind association "${getAssociationQualifiedName(association) || association.name}" to reference selector.`
      );
    }

    ensureAssociationSelectorXPathSource({
      pages,
      widget,
      xPathConstraint: step.xPathConstraint
    });

    const mode = String(step.renderMode || step.mode || "").trim();
    if (mode && "renderMode" in widget && pages.ReferenceSelectorRenderModeType && pages.ReferenceSelectorRenderModeType[mode]) {
      widget.renderMode = pages.ReferenceSelectorRenderModeType[mode];
    }

    const resolvedLabel =
      (typeof step.label === "string" && step.label.trim().length > 0
        ? step.label.trim()
        : resolvedTargetEntity
          ? `Select ${toHumanLabel(resolvedTargetEntity.name)}`
          : `Select ${toHumanLabel(association.parent && association.parent.name ? association.parent.name : association.name)}`);
    if (resolvedLabel) {
      if ("labelTemplate" in widget) {
        widget.labelTemplate = createClientTemplate(pages, texts, model, resolvedLabel);
      } else if ("label" in widget) {
        widget.label = createText(texts, model, resolvedLabel);
      } else if ("labelCaption" in widget) {
        widget.labelCaption = createText(texts, model, resolvedLabel);
      }
    }

    applyWidgetProps(widget, step.props);
    ensureWidgetName(widget, step.name || step.autoName || "association_input");
    return widget;
  }

  if (step.type === "associationSetInput" || step.type === "referenceSetSelector") {
    const contextEntity =
      resolveEntityForStep({ model, moduleName, pageSpec, step }) ||
      (pageContext && pageContext.defaultEntry ? pageContext.defaultEntry.entity : null);
    if (!contextEntity) {
      throw new Error("associationSetInput requires an entityRef on step/page or a dataView page parameter context.");
    }

    const targetEntity = resolveEntityReference(model, moduleName, step.targetEntityRef || step.targetEntity || "");
    const association = findLookupAssociation({
      model,
      moduleName,
      contextEntity,
      targetEntity,
      rawAssociationRef: step.associationRef || step.association || "",
      expectsReferenceSet: true
    });

    const resolvedTargetEntity = resolveLookupDestinationEntity({
      association,
      contextEntity,
      targetEntity
    });
    if (!resolvedTargetEntity) {
      throw new Error(
        `Could not resolve lookup target entity for association set "${getAssociationQualifiedName(association) || association.name}".`
      );
    }

    const displayAttribute = resolveLookupDisplayAttribute({
      model,
      targetEntity: resolvedTargetEntity,
      rawDisplayAttributeRef:
        step.displayAttributeRef || step.displayAttribute || step.attributeRef || step.attribute || ""
    });
    if (!displayAttribute) {
      throw new Error(
        `Could not resolve a display attribute on lookup target entity "${getEntityQualifiedName(resolvedTargetEntity)}".`
      );
    }

    const widget = createWidgetByClassName({
      pages,
      className: "InputReferenceSetSelector",
      container,
      createMethod: step.createMethod || ""
    });

    const bound = bindLookupAttributeRefOnWidget({
      domainmodels,
      widget,
      association,
      targetEntity: resolvedTargetEntity,
      displayAttribute
    });
    if (!bound) {
      throw new Error(
        `Could not bind association set "${getAssociationQualifiedName(association) || association.name}" to input reference-set selector for context entity "${getEntityQualifiedName(contextEntity)}" and target entity "${getEntityQualifiedName(resolvedTargetEntity)}".`
      );
    }

    ensureAssociationSelectorXPathSource({
      pages,
      widget,
      xPathConstraint: step.xPathConstraint
    });

    const resolvedLabel =
      (typeof step.label === "string" && step.label.trim().length > 0
        ? step.label.trim()
        : resolvedTargetEntity
          ? `Select ${toHumanLabel(resolvedTargetEntity.name)}`
          : `Select ${toHumanLabel(association.parent && association.parent.name ? association.parent.name : association.name)}`);
    if (resolvedLabel) {
      if ("labelTemplate" in widget) {
        widget.labelTemplate = createClientTemplate(pages, texts, model, resolvedLabel);
      } else if ("label" in widget) {
        widget.label = createText(texts, model, resolvedLabel);
      } else if ("labelCaption" in widget) {
        widget.labelCaption = createText(texts, model, resolvedLabel);
      }
    }

    applyWidgetProps(widget, step.props);
    ensureWidgetName(widget, step.name || step.autoName || "association_set_input");
    return widget;
  }

  if (step.type === "dataGrid") {
    const entity = resolveEntityForStep({ model, moduleName, pageSpec, step });
    if (!entity) {
      throw new Error("dataGrid requires entityRef on step or page.");
    }

    const mode = chooseDataGridMode(step);
    if (mode === "classic") {
      return createClassicDataGridFromStep({
        pages,
        texts,
        model,
        domainmodels,
        moduleName,
        pageSpec,
        pageContext,
        container,
        step,
        entity,
        pagesByRef,
        pageMetaByRef
      });
    }

    return createDataGrid2FromStep({
      customwidgets,
      container,
      step,
      entity,
      dataGrid2Context
    });
  }

  if (step.type === "filterToolbar") {
    const containerWidget = createWidgetByClassName({
      pages,
      className: "DivContainer",
      container,
      createMethod: step.createMethod || ""
    });
    ensureWidgetName(containerWidget, step.name || step.autoName || "filter_toolbar");
    applyWidgetProps(containerWidget, step.props);

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

    const toolbarContent = Array.isArray(step.content) && step.content.length > 0 ? step.content : implicitContent;
    const stateEntity = stateEntityRef
      ? resolveEntityReference({
          model,
          moduleName,
          rawEntityRef: stateEntityRef
        })
      : null;

    if (stateEntity) {
      const dataViewStep = {
        type: "dataView",
        entityRef: stateEntityRef,
        content: toolbarContent
      };
      addNestedContentSteps({
        pages,
        texts,
        model,
        domainmodels,
        customwidgets,
        moduleName,
        pageSpec,
        pageContext,
        content: [dataViewStep],
        container: containerWidget,
        pagesByRef,
        pageMetaByRef,
        microflowRefsByRef,
        nanoflowRefsByRef,
        workflowRefsByRef,
        dataGrid2Context,
        autoNamePrefix: `${toSafeName(pageSpec.name || "page")}_filter_toolbar`
      });
    } else {
      addNestedContentSteps({
        pages,
        texts,
        model,
        domainmodels,
        customwidgets,
        moduleName,
        pageSpec,
        pageContext,
        content: toolbarContent,
        container: containerWidget,
        pagesByRef,
        pageMetaByRef,
        microflowRefsByRef,
        nanoflowRefsByRef,
        workflowRefsByRef,
        dataGrid2Context,
        autoNamePrefix: `${toSafeName(pageSpec.name || "page")}_filter_toolbar`
      });
    }

    return containerWidget;
  }

  if (step.type === "attributeInput") {
    return addAttributeInputWidget({
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

  if (step.type === "saveChangesButton") {
    if (!pages.SaveChangesClientAction || typeof pages.SaveChangesClientAction.createInActionButtonUnderAction !== "function") {
      throw new Error("SaveChangesClientAction is not available in this SDK version.");
    }

    const button = createWidgetByClassName({
      pages,
      className: "ActionButton",
      container,
      createMethod: step.createMethod || ""
    });

    button.caption = createClientTemplate(pages, texts, model, step.caption || "Save");
    const action = pages.SaveChangesClientAction.createInActionButtonUnderAction(button);
    if ("closePage" in action) {
      action.closePage = step.closePage !== false;
    }
    if (step.syncAutomatically !== undefined && "syncAutomatically" in action) {
      action.syncAutomatically = Boolean(step.syncAutomatically);
    }
    applyWidgetProps(button, step.props);
    ensureWidgetName(button, step.name || step.autoName || "save_button");
    return button;
  }

  if (step.type === "cancelChangesButton") {
    if (!pages.CancelChangesClientAction || typeof pages.CancelChangesClientAction.createInActionButtonUnderAction !== "function") {
      throw new Error("CancelChangesClientAction is not available in this SDK version.");
    }

    const button = createWidgetByClassName({
      pages,
      className: "ActionButton",
      container,
      createMethod: step.createMethod || ""
    });

    button.caption = createClientTemplate(pages, texts, model, step.caption || "Cancel");
    pages.CancelChangesClientAction.createInActionButtonUnderAction(button);
    applyWidgetProps(button, step.props);
    ensureWidgetName(button, step.name || step.autoName || "cancel_button");
    return button;
  }

  if (step.type === "createObjectButton") {
    const entity = resolveEntityForStep({ model, moduleName, pageSpec, step });
    if (!entity) {
      throw new Error("createObjectButton requires entityRef on step or page.");
    }

    const targetPage = step.targetPageRef ? pagesByRef[step.targetPageRef] : null;
    if (step.targetPageRef && !targetPage) {
      throw new Error(`createObjectButton target "${step.targetPageRef}" not found.`);
    }

    const button = addCreateObjectButton({
      pages,
      texts,
      model,
      domainmodels,
      container,
      caption: step.caption || "New",
      entity,
      targetPage,
      targetMeta: getTargetPageMeta(step, targetPage, pageMetaByRef)
    });

    applyWidgetProps(button, step.props);
    ensureWidgetName(button, step.name || step.autoName || "create_object_button");
    return button;
  }

  if (step.type === "buttonToPage") {
    const targetPage = pagesByRef[step.targetPageRef];
    if (!targetPage) {
      throw new Error(`buttonToPage target "${step.targetPageRef}" not found.`);
    }

    const button = addButtonToPage({
      pages,
      texts,
      model,
      container,
      caption: step.caption || "Open page",
      targetPage,
      targetMeta: getTargetPageMeta(step, targetPage, pageMetaByRef),
      parameterMappings: step.parameterMappings || null
    });

    applyWidgetProps(button, step.props);
    ensureWidgetName(button, step.name || step.autoName || "action_button");
    return button;
  }

  if (step.type === "callMicroflowButton") {
    const microflow = resolveMicroflowReference({ model, moduleName, step, microflowRefsByRef });
    if (!microflow) {
      throw new Error(
        `callMicroflowButton target "${step.microflowRef || step.microflowQualifiedName || step.target || ""}" not found.`
      );
    }

    const button = addCallMicroflowButton({
      pages,
      texts,
      model,
      container,
      caption: step.caption || "Run microflow",
      microflow
    });

    applyWidgetProps(button, step.props);
    ensureWidgetName(button, step.name || step.autoName || "call_microflow_button");
    return button;
  }

  if (step.type === "callNanoflowButton") {
    const nanoflow = resolveNanoflowReference({ model, moduleName, step, nanoflowRefsByRef });
    if (!nanoflow) {
      throw new Error(
        `callNanoflowButton target "${step.nanoflowRef || step.nanoflowQualifiedName || step.target || ""}" not found.`
      );
    }

    const button = addCallNanoflowButton({
      pages,
      texts,
      model,
      container,
      caption: step.caption || "Run nanoflow",
      nanoflow
    });

    applyWidgetProps(button, step.props);
    ensureWidgetName(button, step.name || step.autoName || "call_nanoflow_button");
    return button;
  }

  if (step.type === "callWorkflowButton") {
    const workflow = resolveWorkflowReference({ model, moduleName, step, workflowRefsByRef });
    const workflowToken = step.workflowRef || step.workflowQualifiedName || step.workflow || step.target || "";
    const workflowQname =
      step.workflowQualifiedName ||
      workflowRefsByRef[workflowToken] ||
      (workflowToken.includes(".") ? workflowToken : `${moduleName}.${workflowToken}`);

    const button = addCallWorkflowButton({
      pages,
      texts,
      model,
      container,
      caption: step.caption || "Start workflow",
      workflow: workflow || null
    });

    if (!workflow) {
      const action = button.action || null;
      const applied = action ? setByNameReferenceRaw(action, "workflow", workflowQname) : false;
      if (!applied) {
        throw new Error(
          `callWorkflowButton target "${step.workflowRef || step.workflowQualifiedName || step.target || ""}" not found.`
        );
      }
    }

    if (button.action && "closePage" in button.action && step.closePage !== undefined) {
      button.action.closePage = Boolean(step.closePage);
    }

    applyWidgetProps(button, step.props);
    ensureWidgetName(button, step.name || step.autoName || "call_workflow_button");
    return button;
  }

  if (step.type === "showUserTaskPageButton") {
    const button = addOpenUserTaskButton({
      pages,
      texts,
      model,
      container,
      caption: step.caption || "Open task",
      assignOnOpen: step.assignOnOpen !== undefined ? step.assignOnOpen : true,
      openWhenAssigned: step.openWhenAssigned !== undefined ? step.openWhenAssigned : true
    });

    applyWidgetProps(button, step.props);
    ensureWidgetName(button, step.name || step.autoName || "open_user_task_button");
    return button;
  }

  if (step.type === "setTaskOutcomeButton") {
    const button = addSetTaskOutcomeButton({
      pages,
      texts,
      model,
      container,
      caption: step.caption || "Complete task",
      outcomeValue: step.outcomeValue || step.outcome || step.value || "Complete",
      closePage: step.closePage !== undefined ? step.closePage : true,
      commit: step.commit !== undefined ? step.commit : true
    });

    applyWidgetProps(button, step.props);
    ensureWidgetName(button, step.name || step.autoName || "set_task_outcome_button");
    return button;
  }

  if (step.type === "deleteObjectButton") {
    const button = addDeleteObjectButton({
      pages,
      texts,
      model,
      container,
      caption: step.caption || "Delete",
      closePage: step.closePage === true
    });

    applyWidgetProps(button, step.props);
    ensureWidgetName(button, step.name || step.autoName || "delete_object_button");
    return button;
  }

  if (step.type === "closePageButton") {
    const button = addClosePageButton({
      pages,
      texts,
      model,
      container,
      caption: step.caption || "Close",
      numberOfPagesToClose: step.numberOfPagesToClose || "1"
    });

    applyWidgetProps(button, step.props);
    ensureWidgetName(button, step.name || step.autoName || "close_page_button");
    return button;
  }

  if (step.type === "openLinkButton") {
    const button = addOpenLinkButton({
      pages,
      texts,
      model,
      container,
      caption: step.caption || "Open link",
      url: step.url || step.address || "",
      linkType: step.linkType || "Web"
    });

    applyWidgetProps(button, step.props);
    ensureWidgetName(button, step.name || step.autoName || "open_link_button");
    return button;
  }

  if (step.type === "widget") {
    if (step.widgetId) {
      return createGenericCustomWidgetFromStep({
        pages,
        texts,
        model,
        domainmodels,
        customwidgets,
        moduleName,
        pageSpec,
        pageContext,
        container,
        step,
        pagesByRef,
        pageMetaByRef,
        microflowRefsByRef,
        nanoflowRefsByRef
      });
    }

    const widget = createWidgetByClassName({
      pages,
      className: step.className,
      container,
      createMethod: step.createMethod || ""
    });

    applyWidgetProps(widget, step.props);
    ensureWidgetName(widget, step.name || step.autoName || toSafeName(step.className || "widget"));
    return widget;
  }

  throw new Error(`Unsupported content step type "${step.type}".`);
}

function addContentStep(args) {
  const step = args && args.step ? args.step : null;
  if (!step || !step.type) {
    throw new Error("Each content step must include a 'type'.");
  }

  const normalizedType = normalizeStepType(step.type);
  const effectiveStep = normalizedType === step.type ? step : { ...step, type: normalizedType };
  const entry = STEP_HANDLER_REGISTRY[effectiveStep.type] || null;

  if (!entry) {
    throw new Error(`Unsupported content step type "${step.type}".`);
  }

  const guard = validateStepSpecAgainstRegistry({
    step: effectiveStep,
    entry,
    context: {
      container: args.container,
      model: args.model,
      pages: args.pages,
      domainmodels: args.domainmodels,
      pagesByRef: args.pagesByRef
    }
  });
  if (!guard.ok) {
    throw new Error(guard.message);
  }

  return addContentStepLegacy({
    ...args,
    step: effectiveStep
  });
}

async function createPageFromSpec({
  model,
  pages,
  texts,
  domainmodels,
  customwidgets,
  datatypes,
  moduleName,
  module,
  layout,
  pageSpec,
  layoutParameterQname,
  pagesByRef,
  pageMetaByRef,
  microflowRefsByRef,
  nanoflowRefsByRef,
  workflowRefsByRef,
  dataGrid2Context = null,
  availableModuleRoles = []
}) {
  const page = await createPageInModuleContainer({
    pages,
    model,
    moduleName,
    module,
    pageNameForError: pageSpec.name
  });
  page.name = pageSpec.name;
  page.title = createText(texts, model, pageSpec.title || pageSpec.name);
  applyPageAllowedRoles({
    page,
    pageSpec,
    model,
    moduleName,
    availableModuleRoles
  });

  const pageLayoutQname = String(pageSpec.layoutQualifiedName || layout.qualifiedName || "").trim();
  const resolvedLayoutConfig =
    pageLayoutQname && pageLayoutQname !== String(layout.qualifiedName || "").trim()
      ? await resolveLayoutArgumentConfig({
          model,
          layoutQualifiedName: pageLayoutQname,
          layoutParameterQname: pageSpec.layoutParameterQname || "",
          fallbackParameterNames: [String(layoutParameterQname || "").split(".").pop()]
        })
      : {
          layout,
          layoutParameterQname: pageSpec.layoutParameterQname || layoutParameterQname
        };

  const layoutCall = pages.LayoutCall.createInPageUnderLayoutCall(page);
  layoutCall.layout = resolvedLayoutConfig.layout;

  const arg = pages.LayoutCallArgument.create(model);
  const resolved = setLayoutArgParameterRawQname(arg, resolvedLayoutConfig.layoutParameterQname);
  if (!resolved) {
    throw new Error("Failed to set layout parameter on LayoutCallArgument.");
  }
  layoutCall.arguments.push(arg);

  const pageContext = createPageParameterEntries({
    pages,
    datatypes,
    model,
    moduleName,
    page,
    pageSpec
  });

  if (pageSpec.ref) pageMetaByRef[pageSpec.ref] = pageContext;
  pageMetaByRef[pageSpec.name] = pageContext;

  const immediateSteps = (pageSpec.content || []).filter((s) => !stepNeedsPageResolution(s));
  for (let i = 0; i < immediateSteps.length; i++) {
    const step = { ...immediateSteps[i] };
    step.autoName = step.autoName || `${toSafeName(pageSpec.name)}_${toSafeName(step.type)}_${i + 1}`;

    addContentStep({
      pages,
      texts,
      model,
      domainmodels,
      customwidgets,
      moduleName,
      pageSpec,
      pageContext,
      container: arg,
      step,
      pagesByRef,
      pageMetaByRef,
      microflowRefsByRef,
      nanoflowRefsByRef,
      workflowRefsByRef,
      dataGrid2Context
    });
  }

  return { page, pageContext };
}

async function applyPagePlanToModel({
  model,
  pages,
  texts,
  domainmodels,
  customwidgets,
  datatypes,
  security,
  moduleName = "MyFirstModule",
  layoutQualifiedName = "Atlas_Core.Atlas_Default",
  layoutParameterQname = "",
  pageSpecs = [],
  deleteExisting = true,
  dg2Cleanup = true,
  microflowRefsByRef = {},
  nanoflowRefsByRef = {},
  workflowRefsByRef = {}
}) {
  const module = await findModule(model, moduleName);
  if (!module) throw new Error(`Module "${moduleName}" not found.`);

  const { layout, layoutParameterQname: resolvedLayoutParameterQname } = await resolveLayoutArgumentConfig({
    model,
    layoutQualifiedName,
    layoutParameterQname
  });

  await sanitizeModuleCustomWidgetExpressions({
    model,
    moduleName,
    customwidgets
  });

  const dg2CleanupSummary = await cleanupPlannedDataGrid2Pages({
    model,
    moduleName,
    pageSpecs,
    enabled: dg2Cleanup !== false
  });

  const deletedByCleanup = new Set(dg2CleanupSummary.deletedPageNames);

  const hasDataGrid2Steps = collectDataGrid2TargetPageNames(pageSpecs).length > 0;
  const dataGrid2Context = {
    enabled: hasDataGrid2Steps,
    widgetId: "",
    resolvedFrom: "",
    useFallbackSchema: false,
    probeVariant: null,
    attempts: [],
    pendingWidgets: []
  };

  if (hasDataGrid2Steps) {
    const resolved = await resolveDataGrid2TypeFromSdk({
      model,
      pages,
      texts,
      customwidgets,
      moduleName,
      module,
      layout,
      layoutParameterQname: resolvedLayoutParameterQname
    });
    dataGrid2Context.widgetId = resolved.widgetId;
    dataGrid2Context.resolvedFrom = resolved.source || "";
    dataGrid2Context.useFallbackSchema = Boolean(resolved.useFallbackSchema);
    dataGrid2Context.probeVariant = resolved.probeVariant || null;
    dataGrid2Context.attempts = Array.isArray(resolved.attempts) ? resolved.attempts : [];
  }

  if (deleteExisting) {
    for (const pageSpec of pageSpecs) {
      if (deletedByCleanup.has(pageSpec.name)) continue;
      await deletePageIfExists(model, moduleName, pageSpec.name);
    }
  }

  const pagesByRef = {};
  const pageMetaByRef = {};
  const availableModuleRoles = await getOrCreateModuleRolesForPages({
    module,
    moduleName,
    security
  });

  for (const spec of pageSpecs) {
    const created = await createPageFromSpec({
      model,
      pages,
      texts,
      domainmodels,
      customwidgets,
      datatypes,
      moduleName,
      module,
      layout,
      pageSpec: spec,
      layoutParameterQname: resolvedLayoutParameterQname,
      pagesByRef,
      pageMetaByRef,
      microflowRefsByRef,
      nanoflowRefsByRef,
      workflowRefsByRef,
      dataGrid2Context,
      availableModuleRoles
    });

    if (spec.ref) pagesByRef[spec.ref] = created.page;
    pagesByRef[spec.name] = created.page;

    if (created.pageContext) {
      if (spec.ref) pageMetaByRef[spec.ref] = created.pageContext;
      pageMetaByRef[spec.name] = created.pageContext;
    }
  }

  for (const spec of pageSpecs) {
    if (!spec.content || spec.content.length === 0) continue;

    const page = pagesByRef[spec.ref] || pagesByRef[spec.name];
    if (!page || !page.layoutCall || page.layoutCall.arguments.length === 0) continue;

    const arg = page.layoutCall.arguments[0];
    const pageContext = pageMetaByRef[spec.ref] || pageMetaByRef[spec.name] || null;

    const deferredSteps = spec.content.filter((s) => stepNeedsPageResolution(s));
    for (let i = 0; i < deferredSteps.length; i++) {
      const step = { ...deferredSteps[i] };
      step.autoName = step.autoName || `${toSafeName(spec.name)}_${toSafeName(step.type)}_${i + 1}`;

      addContentStep({
        pages,
        texts,
        model,
        domainmodels,
        customwidgets,
        moduleName,
        pageSpec: spec,
        pageContext,
        container: arg,
        step,
        pagesByRef,
        pageMetaByRef,
        microflowRefsByRef,
        nanoflowRefsByRef,
        workflowRefsByRef,
        dataGrid2Context
      });
    }
  }

  if (dataGrid2Context.pendingWidgets.length > 0) {
    await model.flushChanges();
    for (const pending of dataGrid2Context.pendingWidgets) {
      configureDataGrid2WidgetFromStep({
        pages,
        texts,
        model,
        domainmodels,
        customwidgets,
        widget: pending.widget,
        widgetType: pending.widgetType,
        step: pending.step,
        entity: pending.entity,
        useFallbackSchema: Boolean(pending.useFallbackSchema || dataGrid2Context.useFallbackSchema)
      });
    }
  }

  return {
    moduleName,
    layoutQualifiedName: layout.qualifiedName,
    layoutParameterQname: resolvedLayoutParameterQname,
    pageNames: pageSpecs.map((p) => p.name),
    dg2Cleanup: dg2CleanupSummary,
    dataGrid2: {
      enabled: dataGrid2Context.enabled,
      widgetId: dataGrid2Context.widgetId || "",
      resolvedFrom: dataGrid2Context.resolvedFrom || "",
      useFallbackSchema: dataGrid2Context.useFallbackSchema,
      probeVariant: dataGrid2Context.probeVariant || null,
      configuredWidgets: dataGrid2Context.pendingWidgets.length,
      attempts: dataGrid2Context.attempts
    }
  };
}

async function runPagePlan({
  appId,
  branch = "main",
  moduleName = "MyFirstModule",
  layoutQualifiedName = "Atlas_Core.Atlas_Default",
  layoutParameterQname = "",
  pageSpecs = [],
  deleteExisting = true,
  dg2Cleanup = true,
  commit = false,
  commitMessage = "Generate pages using generic page-builder template",
  token = process.env.MENDIX_TOKEN || process.env.MENDIX_PAT
}) {
  const { platform, model: sdkModel } = loadSdk();
  const { MendixPlatformClient, setPlatformConfig } = platform;
  const { pages, texts, domainmodels, customwidgets, datatypes, security } = sdkModel;

  if (token) setPlatformConfig({ mendixToken: token });

  const client = new MendixPlatformClient();
  const app = client.getApp(appId);
  const workingCopy = await app.createTemporaryWorkingCopy(branch);
  const model = await workingCopy.openModel();

  const pageSummary = await applyPagePlanToModel({
    model,
    pages,
    texts,
    domainmodels,
    customwidgets,
    datatypes,
    security,
    moduleName,
    layoutQualifiedName,
    layoutParameterQname,
    pageSpecs,
    deleteExisting,
    dg2Cleanup
  });

  await model.flushChanges();
  if (commit) {
    await workingCopy.commitToRepository(branch, { commitMessage });
  }

  return {
    committed: commit,
    workingCopyId: workingCopy.workingCopyId || null,
    layoutParameterQname: pageSummary.layoutParameterQname,
    pageNames: pageSummary.pageNames
  };
}

function defaultPlan() {
  return {
    appId: process.env.MENDIX_APP_ID || "",
    branch: process.env.MENDIX_BRANCH || "main",
    moduleName: process.env.MENDIX_MODULE || "MyFirstModule",
    layoutQualifiedName: process.env.MENDIX_LAYOUT_QUALIFIED || "Atlas_Core.Atlas_Default",
    layoutParameterQname: process.env.MENDIX_LAYOUT_PARAMETER_QNAME || "",
    deleteExisting: true,
    commit: false,
    pageSpecs: [
      {
        ref: "page_1",
        name: "page_1",
        title: "Page 1",
        content: [
          { type: "dynamicText", text: "Generated with the page builder template.", renderMode: "H2" },
          { type: "dynamicText", text: "This page can be fully described by an LLM plan.", renderMode: "Paragraph" },
          { type: "buttonToPage", caption: "Go to page 2", targetPageRef: "page_2" }
        ]
      },
      {
        ref: "page_2",
        name: "page_2",
        title: "Page 2",
        content: [
          { type: "dynamicText", text: "Page 2 created from the same template.", renderMode: "H2" },
          { type: "buttonToPage", caption: "Back to page 1", targetPageRef: "page_1" }
        ]
      }
    ]
  };
}

function loadPlanFromFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

async function cliMain() {
  const argPath = process.argv[2];
  const plan = argPath ? loadPlanFromFile(argPath) : defaultPlan();

  if (!plan.appId) {
    throw new Error("No appId provided. Set MENDIX_APP_ID or pass a plan JSON file with appId.");
  }

  const result = await runPagePlan(plan);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  cliMain().catch((err) => {
    console.error("Failed:", err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = {
  loadSdk,
  createText,
  createClientTemplate,
  discoverCreatableWidgets,
  createWidgetByClassName,
  getLayoutArgParameterQname,
  setLayoutArgParameterRawQname,
  deriveLayoutParameterQnameFromExistingUsage,
  applyPagePlanToModel,
  validateMinimalDataGrid2Step,
  isUsableDataGrid2TypeMetadata,
  addDynamicText,
  addButtonToPage,
  addContentStep,
  runPagePlan,
  defaultPlan
};
