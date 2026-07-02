const fs = require("fs");
const path = require("path");

const { parseSpecs, normalizePackRefs } = require("./pack-merger");
const { normalizeAssociationType, supportedAssociationTypeDescription } = require("./association-types");
const { normalizeEntityRef } = require("./semantic-checks");
const { normalizeNavigationConfig, normalizeRoleRefs, trimToString } = require("./navigation-contract");
const { isHomeIconName } = require("./glyphicons");

const RESERVED_ATTRIBUTE_NAMES = new Set(["id", "owner", "changedby", "changeddate", "createddate"]);
const RESERVED_SECURITY_USER_ROLE_NAMES = new Set(["administrator", "user"]);
const VALID_MENDIX_IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const SUPPORTED_PAGE_STEP_TYPES = new Set([
  "dynamicText",
  "buttonToPage",
  "createObjectButton",
  "listView",
  "dataGrid",
  "dataView",
  "associationInput",
  "associationSetInput",
  "referenceSelector",
  "referenceSetSelector",
  "filterToolbar",
  "attributeInput",
  "saveChangesButton",
  "cancelChangesButton",
  "callMicroflowButton",
  "callNanoflowButton",
  "callWorkflowButton",
  "showUserTaskPageButton",
  "setTaskOutcomeButton",
  "deleteObjectButton",
  "closePageButton",
  "openLinkButton",
  "widget"
]);
const SUPPORTED_MICROFLOW_ACTION_TYPES = new Set([
  "showMessage",
  "callMicroflow",
  "callNanoflow",
  "retrieveList",
  "retrieveObject",
  "createObject",
  "aggregateList",
  "createVariable",
  "changeVariable",
  "decision",
  "changeObject",
  "commitObject",
  "returnValue"
]);

function replacementBaseForReservedAttribute(name) {
  const lower = String(name || "").toLowerCase();
  if (lower === "createddate") return "createdOn";
  if (lower === "changeddate") return "changedOn";
  if (lower === "changedby") return "changedByUser";
  if (lower === "owner") return "ownerName";
  if (lower === "id") return "externalId";
  return `${name}Attr`;
}

function buildUniqueAttributeName({ baseName, usedLower }) {
  const base = String(baseName || "attributeValue");
  let candidate = base || "attributeValue";
  let suffix = 1;
  while (usedLower.has(candidate.toLowerCase()) || RESERVED_ATTRIBUTE_NAMES.has(candidate.toLowerCase())) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }
  usedLower.add(candidate.toLowerCase());
  return candidate;
}

function applyReservedWordSanitizationToPlan(plan, moduleName) {
  const out = {
    renamedAttributes: [],
    totalRenamed: 0
  };

  if (!plan || !plan.domainModel || !Array.isArray(plan.domainModel.entities)) {
    return out;
  }

  const renameByEntity = new Map();
  for (const entity of plan.domainModel.entities) {
    if (!entity || !Array.isArray(entity.attributes)) continue;
    const entityName = String(entity.name || "").trim();
    if (!entityName) continue;

    const usedLower = new Set(
      entity.attributes
        .map((a) => String((a && a.name) || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const renames = new Map();

    for (const attr of entity.attributes) {
      if (!attr || typeof attr.name !== "string") continue;
      const oldName = attr.name;
      const lower = oldName.toLowerCase();
      if (!RESERVED_ATTRIBUTE_NAMES.has(lower)) continue;

      usedLower.delete(lower);
      const newName = buildUniqueAttributeName({
        baseName: replacementBaseForReservedAttribute(oldName),
        usedLower
      });
      attr.name = newName;
      renames.set(oldName, newName);
      out.renamedAttributes.push({
        entity: entityName,
        from: oldName,
        to: newName
      });
    }

    if (renames.size > 0) {
      renameByEntity.set(entityName, renames);
    }
  }

  if (renameByEntity.size === 0 || !plan.pages) {
    out.totalRenamed = out.renamedAttributes.length;
    return out;
  }

  const pageSpecs = parseSpecs(plan.pages);

  function tryRewriteAttributeRef(rawRef, entityName) {
    const ref = String(rawRef || "").trim();
    if (!ref) return ref;

    if (ref.includes(".")) {
      const parts = ref.split(".");
      if (parts.length >= 3) {
        const refEntity = parts[parts.length - 2];
        const refAttr = parts[parts.length - 1];
        const mapping = renameByEntity.get(refEntity);
        if (mapping && mapping.has(refAttr)) {
          parts[parts.length - 1] = mapping.get(refAttr);
          return parts.join(".");
        }
      }
      return ref;
    }

    const mapping = renameByEntity.get(entityName);
    if (mapping && mapping.has(ref)) {
      return mapping.get(ref);
    }
    return ref;
  }

  function walkStepsWithEntity(steps, currentEntityName) {
    const source = Array.isArray(steps) ? steps : [];
    for (const step of source) {
      if (!step || typeof step !== "object") continue;

      if (typeof step.attributeRef === "string") {
        step.attributeRef = tryRewriteAttributeRef(step.attributeRef, currentEntityName);
      }
      if (Array.isArray(step.columns)) {
        for (const col of step.columns) {
          if (!col || typeof col !== "object") continue;
          if (typeof col.attributeRef === "string") {
            col.attributeRef = tryRewriteAttributeRef(col.attributeRef, currentEntityName);
          }
        }
      }

      const nextEntityRaw = step.entityRef || step.entity || "";
      const nextEntityRef = normalizeEntityRef(nextEntityRaw, moduleName);
      const nextEntityName = nextEntityRef.includes(".") ? nextEntityRef.split(".").pop() : currentEntityName;

      if (Array.isArray(step.content)) {
        walkStepsWithEntity(step.content, nextEntityName || currentEntityName);
      }
      if (Array.isArray(step.templateContent)) {
        walkStepsWithEntity(step.templateContent, nextEntityName || currentEntityName);
      }
      if (Array.isArray(step.itemContent)) {
        walkStepsWithEntity(step.itemContent, nextEntityName || currentEntityName);
      }
    }
  }

  for (const page of pageSpecs) {
    if (!page || typeof page !== "object") continue;
    const pageEntityRef = normalizeEntityRef(page.entityRef || page.entity || "", moduleName);
    const pageEntityName = pageEntityRef.includes(".") ? pageEntityRef.split(".").pop() : "";
    walkStepsWithEntity(page.content || [], pageEntityName);
  }

  out.totalRenamed = out.renamedAttributes.length;
  return out;
}

function pointerJoin(base, segment) {
  return `${base}/${String(segment).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function normalizePageParameterSpecs(pageSpec = {}) {
  if (!pageSpec || typeof pageSpec !== "object" || Array.isArray(pageSpec)) return [];
  if (Array.isArray(pageSpec.pageParameters)) return pageSpec.pageParameters;
  if (Array.isArray(pageSpec.parameters)) return pageSpec.parameters;
  if (pageSpec.parameterEntityRef || pageSpec.pageParameterEntityRef || pageSpec.contextEntityRef) {
    return [
      {
        name: pageSpec.parameterName || "",
        entityRef: pageSpec.parameterEntityRef || pageSpec.pageParameterEntityRef || pageSpec.contextEntityRef || "",
        required: pageSpec.parameterRequired !== false
      }
    ];
  }
  return [];
}

function collectRequiredPageParameterEntities(pageSpec = {}, moduleName = "") {
  return normalizePageParameterSpecs(pageSpec)
    .filter((param) => param && param.required !== false)
    .map((param) => normalizeEntityRef(param.entityRef || param.entity || "", moduleName))
    .filter(Boolean);
}

function findPageSpecByToken(pages = [], token = "") {
  const raw = trimToString(token);
  if (!raw) return null;
  return (
    pages.find((page) => trimToString(page && page.ref) === raw) ||
    pages.find((page) => trimToString(page && page.name) === raw) ||
    pages.find((page) => trimToString(page && page.qualifiedName) === raw) ||
    null
  );
}

function collectModuleRoleNamesFromPlan(plan = {}) {
  const moduleName = trimToString(plan.app && plan.app.moduleName);
  const names = [];

  for (const rawRole of Array.isArray(plan.security && plan.security.moduleRoles) ? plan.security.moduleRoles : []) {
    const role = trimToString(rawRole);
    if (!role) continue;
    names.push(role.includes(".") ? role.split(".").pop() : role);
  }

  for (const userRole of Array.isArray(plan.security && plan.security.userRoles) ? plan.security.userRoles : []) {
    const moduleRoles = Array.isArray(userRole && userRole.moduleRoles) ? userRole.moduleRoles : [];
    for (const rawRole of moduleRoles) {
      const role = trimToString(rawRole);
      if (!role) continue;
      if (role.includes(".")) {
        const [refModuleName, refRoleName] = role.split(".");
        if (!moduleName || refModuleName === moduleName) names.push(refRoleName || role);
      } else {
        names.push(role);
      }
    }
  }

  return new Set(normalizeRoleRefs(names));
}

function walkPageSteps(steps = [], visit, pathParts = []) {
  const source = Array.isArray(steps) ? steps : [];
  for (let i = 0; i < source.length; i += 1) {
    const step = source[i] || {};
    const stepType = trimToString(step.type) || "step";
    const path = [...pathParts, `${stepType}[${i}]`];
    visit(step, path);
    walkPageSteps(step.content, visit, [...path, "content"]);
    walkPageSteps(step.templateContent, visit, [...path, "templateContent"]);
    walkPageSteps(step.itemContent, visit, [...path, "itemContent"]);
  }
}

function validateRoleRefs({ refs = [], pointer, errors, availableModuleRoles = null }) {
  if (!Array.isArray(refs)) {
    errors.push(`${pointer} must be an array.`);
    return;
  }

  const normalizedRefs = normalizeRoleRefs(refs);
  if (normalizedRefs.length !== refs.length) {
    errors.push(`${pointer} must only contain non-empty unique strings.`);
  }

  if (!(availableModuleRoles instanceof Set) || availableModuleRoles.size === 0) return;

  for (const ref of normalizedRefs) {
    const localName = ref.includes(".") ? ref.split(".").pop() : ref;
    if (!availableModuleRoles.has(localName)) {
      errors.push(`${pointer} contains unknown module role "${ref}".`);
    }
  }
}

function addDuplicateFieldErrors(items, { pointer, field = "name", label = "identifier", errors, getValue = null }) {
  if (!Array.isArray(items)) return;
  const firstByKey = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const value = trimToString(
      typeof getValue === "function"
        ? getValue(item)
        : item && typeof item === "object"
          ? item[field]
          : ""
    );
    if (!value) continue;
    const key = value.toLowerCase();
    if (firstByKey.has(key)) {
      const firstIndex = firstByKey.get(key);
      const fieldSuffix = field ? `.${field}` : "";
      errors.push(
        `${pointer}[${i}]${fieldSuffix} duplicates ${label} "${value}" first defined at ${pointer}[${firstIndex}]${fieldSuffix}.`
      );
      continue;
    }
    firstByKey.set(key, i);
  }
}

function validateMendixIdentifier(value, pointer, label, errors) {
  const name = trimToString(value);
  if (!name) return;
  if (!VALID_MENDIX_IDENTIFIER_RE.test(name)) {
    errors.push(`${pointer} "${name}" is not a valid Mendix ${label}; use letters, numbers, and underscores, starting with a letter.`);
  }
}

function enumValueName(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return value.name || value.value || value.caption || "";
  }
  return "";
}

function roleSpecName(value) {
  if (typeof value === "string") return value;
  return value && typeof value === "object" ? value.name : "";
}

function validateDuplicatePlanIdentifiers(plan, errors) {
  const domainModel = plan.domainModel || {};
  if (Array.isArray(domainModel.entities)) {
    addDuplicateFieldErrors(domainModel.entities, {
      pointer: "domainModel.entities",
      field: "name",
      label: "entity name",
      errors
    });
    for (let i = 0; i < domainModel.entities.length; i += 1) {
      const entity = domainModel.entities[i] || {};
      if (Array.isArray(entity.attributes)) {
        addDuplicateFieldErrors(entity.attributes, {
          pointer: `domainModel.entities[${i}].attributes`,
          field: "name",
          label: `attribute name in entity "${trimToString(entity.name) || i}"`,
          errors
        });
      }
    }
  }

  if (Array.isArray(domainModel.enumerations)) {
    addDuplicateFieldErrors(domainModel.enumerations, {
      pointer: "domainModel.enumerations",
      field: "name",
      label: "enumeration name",
      errors
    });
    for (let i = 0; i < domainModel.enumerations.length; i += 1) {
      const enumeration = domainModel.enumerations[i] || {};
      if (Array.isArray(enumeration.values)) {
        addDuplicateFieldErrors(enumeration.values, {
          pointer: `domainModel.enumerations[${i}].values`,
          field: "",
          label: `enumeration value in "${trimToString(enumeration.name) || i}"`,
          errors,
          getValue: enumValueName
        });
      }
    }
  }

  if (Array.isArray(domainModel.associations)) {
    addDuplicateFieldErrors(domainModel.associations, {
      pointer: "domainModel.associations",
      field: "name",
      label: "association name",
      errors
    });
  }

  const specSections = [
    { key: "pages", label: "page" },
    { key: "microflows", label: "microflow" },
    { key: "nanoflows", label: "nanoflow" },
    { key: "workflows", label: "workflow" }
  ];
  for (const section of specSections) {
    if (!plan[section.key]) continue;
    const specs = parseSpecs(plan[section.key]);
    addDuplicateFieldErrors(specs, {
      pointer: `${section.key}.specs`,
      field: "ref",
      label: `${section.label} ref`,
      errors
    });
    addDuplicateFieldErrors(specs, {
      pointer: `${section.key}.specs`,
      field: "name",
      label: `${section.label} name`,
      errors
    });
  }

  const security = plan.security || {};
  if (Array.isArray(security.moduleRoles)) {
    addDuplicateFieldErrors(security.moduleRoles, {
      pointer: "security.moduleRoles",
      field: "",
      label: "module role name",
      errors,
      getValue: roleSpecName
    });
  }
  if (Array.isArray(security.userRoles)) {
    addDuplicateFieldErrors(security.userRoles, {
      pointer: "security.userRoles",
      field: "name",
      label: "user role name",
      errors
    });
  }
}

function validateIconSpec(icon, pointer, errors) {
  if (icon === undefined || icon === null || icon === "") return;
  const message = `${pointer} only supports the home icon. Omit icon or use { "name": "home" }.`;
  if (typeof icon === "number") {
    errors.push(message);
    return;
  }
  if (typeof icon === "string" && icon.trim()) {
    const trimmed = icon.trim();
    if (isHomeIconName(trimmed)) return;
    errors.push(message);
    return;
  }
  if (icon && typeof icon === "object" && !Array.isArray(icon)) {
    const name = trimToString(icon.name || "");
    const keys = Object.keys(icon).filter((key) => icon[key] !== undefined && icon[key] !== null && icon[key] !== "");
    if (keys.length === 0) {
      return;
    }
    if (keys.length === 1 && keys[0] === "name" && isHomeIconName(name)) {
      return;
    }
    errors.push(message);
    return;
  }
  errors.push(message);
}

const SUPPORTED_CUSTOM_WIDGET_VALUE_TYPES = new Set([
  "Action",
  "Attribute",
  "Association",
  "Boolean",
  "DataSource",
  "Decimal",
  "Entity",
  "EntityConstraint",
  "Enumeration",
  "Expression",
  "Icon",
  "Integer",
  "Microflow",
  "Nanoflow",
  "Object",
  "String",
  "Selection",
  "TextTemplate",
  "TranslatableString",
  "Widgets"
]);

function validateWidgetPropertyTypes(propertyTypes = [], pointer, errors) {
  if (!Array.isArray(propertyTypes)) {
    errors.push(`${pointer} must be an array when provided.`);
    return;
  }

  for (let i = 0; i < propertyTypes.length; i += 1) {
    const propertyType = propertyTypes[i] || {};
    const base = `${pointer}[${i}]`;
    if (!propertyType || typeof propertyType !== "object") {
      errors.push(`${base} must be an object.`);
      continue;
    }
    if (!trimToString(propertyType.key)) {
      errors.push(`${base}.key is required.`);
    }
    const valueType = trimToString(propertyType.valueType);
    if (!valueType) {
      errors.push(`${base}.valueType is required.`);
    } else if (!SUPPORTED_CUSTOM_WIDGET_VALUE_TYPES.has(valueType)) {
      errors.push(`${base}.valueType "${valueType}" is unsupported.`);
    }
    if (propertyType.propertyTypes !== undefined) {
      validateWidgetPropertyTypes(propertyType.propertyTypes, `${base}.propertyTypes`, errors);
    }
  }
}

function validateDataGridStep(step = {}, pointer, errors) {
  const allowedKeys = new Set([
    "type",
    "name",
    "autoName",
    "props",
    "createMethod",
    "widgetMode",
    "mode",
    "entityRef",
    "entity",
    "xPathConstraint",
    "pageSize",
    "numberOfRows",
    "columns",
    "dataSource",
    "rowClickTargetPageRef",
    "search",
    "controlBarButtons"
  ]);

  const invalidKeys = Object.keys(step || {}).filter((key) => !allowedKeys.has(key));
  if (invalidKeys.length > 0) {
    errors.push(`${pointer} contains unsupported dataGrid keys: ${invalidKeys.join(", ")}.`);
  }

  const mode = trimToString(step.widgetMode || step.mode || "datagrid2").toLowerCase();
  if (mode && !["datagrid2", "data_grid_2", "dg2", "classic", "datagrid", "data_grid", "grid"].includes(mode)) {
    errors.push(`${pointer}.widgetMode "${step.widgetMode || step.mode}" is unsupported.`);
  }

  if (!Array.isArray(step.columns) || step.columns.length === 0) {
    errors.push(`${pointer}.columns must be a non-empty array.`);
  } else {
    for (let i = 0; i < step.columns.length; i += 1) {
      const column = step.columns[i] || {};
      const columnPointer = `${pointer}.columns[${i}]`;
      const attributeRef = trimToString(column.attributeRef || column.attribute || column.attributeName);
      if (!attributeRef) {
        errors.push(`${columnPointer} requires attributeRef (or attribute/attributeName).`);
      }
    }
  }

  if (step.search !== undefined) {
    if (!step.search || typeof step.search !== "object" || Array.isArray(step.search)) {
      errors.push(`${pointer}.search must be an object when provided.`);
    } else if (step.search.fields !== undefined) {
      if (!Array.isArray(step.search.fields)) {
        errors.push(`${pointer}.search.fields must be an array when provided.`);
      } else {
        for (let i = 0; i < step.search.fields.length; i += 1) {
          const field = step.search.fields[i] || {};
          const fieldPointer = `${pointer}.search.fields[${i}]`;
          const attributeRef = trimToString(field.attributeRef || field.attribute || field.attributeName);
          if (!attributeRef) {
            errors.push(`${fieldPointer} requires attributeRef (or attribute/attributeName).`);
          }
        }
      }
    }
  }
}

function validateWidgetStep(step = {}, pointer, errors) {
  const className = trimToString(step.className);
  const widgetId = trimToString(step.widgetId);

  if (!className && !widgetId) {
    errors.push(`${pointer} requires className or widgetId.`);
  }
  if (className && widgetId) {
    errors.push(`${pointer} must not specify both className and widgetId.`);
  }

  if (widgetId && step.propertyTypes !== undefined) {
    validateWidgetPropertyTypes(step.propertyTypes, `${pointer}.propertyTypes`, errors);
  }

  if (widgetId && step.props !== undefined && (!step.props || typeof step.props !== "object" || Array.isArray(step.props))) {
    errors.push(`${pointer}.props must be an object when provided for a custom widget.`);
  }
}

function isAllowedOpenLinkUrl(rawUrl) {
  const value = trimToString(rawUrl);
  if (!value) return false;

  let parsed;
  try {
    parsed = new URL(value);
  } catch (_err) {
    return false;
  }

  return ["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol);
}

function validatePageSpecs(plan, errors) {
  if (!plan.pages) return;

  const specs = parseSpecs(plan.pages);
  const pageRefs = new Set();
  const availableModuleRoles = collectModuleRoleNamesFromPlan(plan);
  const moduleName = trimToString(plan && plan.app && plan.app.moduleName) || "MyFirstModule";
  const associationsByRef = new Map();
  const entityByKey = new Map();

  for (const entity of Array.isArray(plan && plan.domainModel && plan.domainModel.entities) ? plan.domainModel.entities : []) {
    const name = trimToString(entity && entity.name);
    if (!name) continue;
    entityByKey.set(name.toLowerCase(), entity);
    entityByKey.set(`${moduleName}.${name}`.toLowerCase(), entity);
  }

  for (const assoc of Array.isArray(plan && plan.domainModel && plan.domainModel.associations) ? plan.domainModel.associations : []) {
    if (!assoc || typeof assoc !== "object") continue;
    for (const key of [assoc.name, assoc.qualifiedName, normalizeEntityRef(assoc.name || "", moduleName)]) {
      const normalized = trimToString(key).toLowerCase();
      if (normalized) associationsByRef.set(normalized, assoc);
    }
  }

  function entityNameFromRef(raw) {
    const normalized = normalizeEntityRef(raw || "", moduleName);
    return normalized ? normalized.split(".").pop() : "";
  }

  function resolveEntity(rawRef) {
    const ref = trimToString(rawRef);
    if (!ref) return null;
    return entityByKey.get(ref.toLowerCase()) ||
      entityByKey.get(normalizeEntityRef(ref, moduleName).toLowerCase()) ||
      entityByKey.get(ref.split(".").pop().toLowerCase()) ||
      null;
  }

  function resolveAttribute(entity, rawRef) {
    const ref = trimToString(rawRef).split(".").pop();
    if (!entity || !ref || !Array.isArray(entity.attributes)) return null;
    return entity.attributes.find((attr) => trimToString(attr && attr.name).toLowerCase() === ref.toLowerCase()) || null;
  }

  function validateAttributeBinding(rawRef, entity, pointer) {
    const ref = trimToString(rawRef);
    if (!ref || !entity) return;
    if (!resolveAttribute(entity, ref)) {
      errors.push(`${pointer} points to unknown attribute "${trimToString(entity.name)}.${ref}".`);
    }
  }

  function attributeBindingEntityForStep(step, key, fallbackEntity) {
    const stepType = trimToString(step && step.type);
    if (
      (key === "displayAttributeRef" || key === "displayAttribute") &&
      (stepType === "associationInput" || stepType === "associationSetInput" || stepType === "referenceSelector" || stepType === "referenceSetSelector")
    ) {
      return resolveEntity(step.targetEntityRef || step.targetEntity) || fallbackEntity;
    }
    return fallbackEntity;
  }

  function validatePageStepAttributeRefs(steps, inheritedEntity, pointer) {
    const source = Array.isArray(steps) ? steps : [];
    for (let index = 0; index < source.length; index += 1) {
      const step = source[index] || {};
      const stepType = trimToString(step.type) || "step";
      const stepPointer = `${pointer}.${stepType}[${index}]`;
      const stepEntity = resolveEntity(step.entityRef || step.entity || step.parameterEntityRef || step.contextEntityRef) || inheritedEntity;
      for (const key of ["attributeRef", "attribute", "attributeName", "displayAttributeRef", "displayAttribute"]) {
        if (step[key] !== undefined) {
          validateAttributeBinding(step[key], attributeBindingEntityForStep(step, key, stepEntity), `${stepPointer}.${key}`);
        }
      }
      if (Array.isArray(step.columns)) {
        for (let c = 0; c < step.columns.length; c += 1) {
          const col = step.columns[c] || {};
          validateAttributeBinding(col.attributeRef || col.attribute || col.attributeName, stepEntity, `${stepPointer}.columns[${c}].attributeRef`);
        }
      }
      if (step.search && Array.isArray(step.search.fields)) {
        for (let f = 0; f < step.search.fields.length; f += 1) {
          const field = step.search.fields[f] || {};
          validateAttributeBinding(field.attributeRef || field.attribute || field.attributeName, stepEntity, `${stepPointer}.search.fields[${f}].attributeRef`);
        }
      }
      validatePageStepAttributeRefs(step.content, stepEntity, `${stepPointer}.content`);
      validatePageStepAttributeRefs(step.itemContent, stepEntity, `${stepPointer}.itemContent`);
      validatePageStepAttributeRefs(step.templateContent, stepEntity, `${stepPointer}.templateContent`);
    }
  }

  function validateLookupInputStep(step, pointer, page, expectedType) {
    const assocRef = trimToString(step.associationRef || step.association || "");
    const contextEntity = entityNameFromRef(step.entityRef || page.entityRef || page.entity || "");
    const targetEntity = entityNameFromRef(step.targetEntityRef || step.targetEntity || "");
    const isReferenceSet = expectedType === "ReferenceSet";
    const bindingName = isReferenceSet ? "reference-set" : "reference";

    if (!contextEntity) {
      errors.push(`${pointer} requires page.entityRef, step.entityRef, or a data-view entity context for ${bindingName} binding.`);
    }
    if (!targetEntity) {
      errors.push(`${pointer}.targetEntityRef is required for deterministic ${bindingName} binding.`);
    }
    if (!assocRef) return;

    const assoc = associationsByRef.get(assocRef.toLowerCase()) ||
      associationsByRef.get(normalizeEntityRef(assocRef, moduleName).toLowerCase());
    if (!assoc) {
      errors.push(`${pointer}.associationRef points to unknown association "${assocRef}".`);
      return;
    }

    const normalizedType = normalizeAssociationType(assoc.type || assoc.associationType || "");
    if (!normalizedType.ok || normalizedType.type !== expectedType) {
      errors.push(`${pointer}.associationRef "${assocRef}" must point to a ${expectedType} association, found "${assoc.type || assoc.associationType || ""}".`);
    }

    const endpoints = [entityNameFromRef(assoc.parentEntity || assoc.parent), entityNameFromRef(assoc.childEntity || assoc.child)].filter(Boolean);
    if (contextEntity && endpoints.length > 0 && !endpoints.includes(contextEntity)) {
      errors.push(`${pointer} context entity "${contextEntity}" is not an endpoint of association "${assocRef}".`);
    }
    if (targetEntity && endpoints.length > 0 && !endpoints.includes(targetEntity)) {
      errors.push(`${pointer}.targetEntityRef "${targetEntity}" is not an endpoint of association "${assocRef}".`);
    }
    if (contextEntity && targetEntity && contextEntity === targetEntity) {
      errors.push(`${pointer}.targetEntityRef must differ from the ${bindingName} context entity "${contextEntity}".`);
    }
  }

  for (const spec of specs) {
    if (!spec || typeof spec !== "object") continue;
    if (spec.ref) pageRefs.add(String(spec.ref));
    if (spec.name) pageRefs.add(String(spec.name));
  }

  for (let i = 0; i < specs.length; i += 1) {
    const page = specs[i] || {};
    const base = `pages.specs[${i}]`;
    const pageEntity = resolveEntity(page.entityRef || page.parameterEntityRef || page.contextEntityRef || page.entity);
    if (page.allowedRoles !== undefined) {
      validateRoleRefs({
        refs: page.allowedRoles,
        pointer: `${base}.allowedRoles`,
        errors,
        availableModuleRoles
      });
    }

    const pageParameters = normalizePageParameterSpecs(page);
    if (page.pageParameters !== undefined || page.parameters !== undefined || page.parameterEntityRef || page.pageParameterEntityRef || page.contextEntityRef) {
      if (!Array.isArray(pageParameters) || pageParameters.length === 0) {
        errors.push(`${base}.pageParameters must define at least one parameter when parameter config is provided.`);
      }
    }

    walkPageSteps(page.content || [], (step, pathParts) => {
      const pointer = pathParts.join(".");
      if (!step || typeof step !== "object") {
        errors.push(`${pointer} must be an object.`);
        return;
      }

      const stepType = trimToString(step.type);
      if (!SUPPORTED_PAGE_STEP_TYPES.has(stepType)) {
        errors.push(`${pointer}.type "${step.type}" is unsupported.`);
      }
      if (stepType === "dataGrid") {
        validateDataGridStep(step, pointer, errors);
      }
      if (stepType === "widget") {
        validateWidgetStep(step, pointer, errors);
      }
      if (stepType === "associationSetInput" || stepType === "referenceSetSelector") {
        validateLookupInputStep(step, pointer, page, "ReferenceSet");
      }
      if (stepType === "associationInput" || stepType === "referenceSelector") {
        validateLookupInputStep(step, pointer, page, "Reference");
      }
      if (stepType === "openLinkButton" && !isAllowedOpenLinkUrl(step.url || step.address || "")) {
        errors.push(`${pointer}.url must be a valid absolute http(s), mailto, or tel URL.`);
      }
      if (stepType === "buttonToPage" && step.targetPageRef && !pageRefs.has(step.targetPageRef)) {
        errors.push(`${pointer}.targetPageRef points to unknown page "${step.targetPageRef}".`);
      }
      if (stepType === "createObjectButton" && step.targetPageRef && !pageRefs.has(step.targetPageRef)) {
        errors.push(`${pointer}.targetPageRef points to unknown page "${step.targetPageRef}".`);
      }
      if ((stepType === "listView" || stepType === "dataGrid") && step.rowClickTargetPageRef && !pageRefs.has(step.rowClickTargetPageRef)) {
        errors.push(`${pointer}.rowClickTargetPageRef points to unknown page "${step.rowClickTargetPageRef}".`);
      }
    }, [base, "content"]);
    validatePageStepAttributeRefs(page.content || [], pageEntity, `${base}.content`);
  }

  return { pageRefs, availableModuleRoles };
}

function walkWorkflowSteps(steps = [], visit) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== "object") continue;
    visit(step);
    for (const outcome of Array.isArray(step.outcomes) ? step.outcomes : []) {
      walkWorkflowSteps(outcome && outcome.steps, visit);
    }
  }
}

function validateBySchema(value, schema, pointer = "") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const anyValid = schema.anyOf.some((sub) => validateBySchema(value, sub, pointer).length === 0);
    if (!anyValid) {
      errors.push(`${pointer || "/"} must match at least one allowed schema.`);
      return errors;
    }
  }

  if (schema.type) {
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!expectedTypes.includes(actualType)) {
      errors.push(`${pointer || "/"} must be type ${expectedTypes.join("|")}.`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pointer || "/"} must be one of: ${schema.enum.join(", ")}.`);
  }

  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value)) {
        errors.push(`${pointerJoin(pointer || "", key)} is required.`);
      }
    }

    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!(key in value)) continue;
      errors.push(...validateBySchema(value[key], propSchema, pointerJoin(pointer || "", key)));
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      errors.push(...validateBySchema(value[i], schema.items, pointerJoin(pointer || "", i)));
    }
  }

  return errors;
}

function loadPlanSchema(schemaPath = "") {
  const resolved = schemaPath
    ? path.resolve(schemaPath)
    : path.join(__dirname, "..", "plans", "schema", "plan.schema.json");

  const raw = fs.readFileSync(resolved, "utf8");
  return {
    schemaPath: resolved,
    schema: JSON.parse(raw)
  };
}

function validatePlanSchema(plan, options = {}) {
  const { schema } = loadPlanSchema(options.schemaPath);
  return validateBySchema(plan, schema, "");
}

function normalizeActionType(raw) {
  const t = String(raw || "").trim().toLowerCase();
  if (!t) return "";
  if (["showmessage", "show_message"].includes(t)) return "showMessage";
  if (["callmicroflow", "microflowcall", "call_microflow"].includes(t)) return "callMicroflow";
  if (["callnanoflow", "nanoflowcall", "call_nanoflow"].includes(t)) return "callNanoflow";
  if (["retrievelist", "retrieve_list"].includes(t)) return "retrieveList";
  if (["retrieveobject", "retrieve_object"].includes(t)) return "retrieveObject";
  if (["createobject", "create_object"].includes(t)) return "createObject";
  if (["aggregatelist", "aggregate_list"].includes(t)) return "aggregateList";
  if (["createvariable", "create_variable"].includes(t)) return "createVariable";
  if (["changevariable", "change_variable"].includes(t)) return "changeVariable";
  if (["decision", "if"].includes(t)) return "decision";
  if (["changeobject", "change_object"].includes(t)) return "changeObject";
  if (["commitobject", "commit_object"].includes(t)) return "commitObject";
  if (["returnvalue", "return_value"].includes(t)) return "returnValue";
  return String(raw || "").trim();
}

function requiredActionField(action, keys) {
  for (const key of keys) {
    if (action[key] !== undefined && String(action[key]).trim() !== "") return true;
  }
  return false;
}

function validateMicroflowActionSpecs(plan) {
  const errors = [];
  const moduleName = trimToString(plan && plan.app && plan.app.moduleName) || "MyFirstModule";
  const entityByKey = new Map();
  for (const entity of Array.isArray(plan && plan.domainModel && plan.domainModel.entities) ? plan.domainModel.entities : []) {
    const name = trimToString(entity && entity.name);
    if (!name) continue;
    entityByKey.set(name.toLowerCase(), entity);
    entityByKey.set(`${moduleName}.${name}`.toLowerCase(), entity);
  }
  const microflowRefs = new Set(parseSpecs(plan.microflows)
    .flatMap((spec) => [spec && spec.ref, spec && spec.name, spec && spec.name ? `${moduleName}.${spec.name}` : ""])
    .map(trimToString)
    .filter(Boolean));
  const nanoflowRefs = new Set(parseSpecs(plan.nanoflows)
    .flatMap((spec) => [spec && spec.ref, spec && spec.name, spec && spec.name ? `${moduleName}.${spec.name}` : ""])
    .map(trimToString)
    .filter(Boolean));

  function resolveEntity(rawRef) {
    const ref = trimToString(rawRef);
    if (!ref) return null;
    return entityByKey.get(ref.toLowerCase()) || entityByKey.get(`${moduleName}.${ref}`.toLowerCase()) || null;
  }

  function resolveAttribute(entity, rawRef) {
    const ref = trimToString(rawRef).split(".").pop();
    if (!entity || !ref || !Array.isArray(entity.attributes)) return null;
    return entity.attributes.find((attr) => trimToString(attr && attr.name).toLowerCase() === ref.toLowerCase()) || null;
  }

  function inferEntityFromTypeSpec(typeSpec) {
    if (typeof typeSpec === "string") return resolveEntity(typeSpec);
    if (!typeSpec || typeof typeSpec !== "object") return null;
    return resolveEntity(typeSpec.entityRef || typeSpec.entity || typeSpec.qualifiedName || "");
  }

  function primitiveTypeFromTypeSpec(typeSpec) {
    const raw = typeof typeSpec === "object" && typeSpec
      ? trimToString(typeSpec.kind || typeSpec.type)
      : trimToString(typeSpec);
    const key = raw.toLowerCase();
    if (key === "enum" || key === "enumeration") return "Enumeration";
    if (key === "string") return "String";
    if (key === "boolean") return "Boolean";
    if (key === "integer") return "Integer";
    if (key === "long") return "Long";
    if (key === "decimal") return "Decimal";
    if (key === "datetime") return "DateTime";
    if (key === "uuid") return "UUID";
    return inferEntityFromTypeSpec(typeSpec) ? "Object" : "String";
  }

  function isSupportedDataTypeKind(rawKind) {
    return ["void", "string", "boolean", "integer", "long", "decimal", "datetime", "object", "list", "enum", "enumeration"]
      .includes(trimToString(rawKind).toLowerCase());
  }

  function validateParameterTypeSpec(typeSpec, prefix) {
    if (typeof typeSpec === "string") {
      if (!isSupportedDataTypeKind(typeSpec) && !resolveEntity(typeSpec)) {
        errors.push(`${prefix}.type "${typeSpec}" is unsupported; use a primitive kind or Object entityRef.`);
      }
      return;
    }
    if (typeSpec && typeof typeSpec === "object") {
      const kind = trimToString(typeSpec.kind || "Void");
      if (!isSupportedDataTypeKind(kind)) {
        errors.push(`${prefix}.type.kind "${kind}" is unsupported.`);
      }
      if (["object", "list"].includes(kind.toLowerCase()) && !resolveEntity(typeSpec.entityRef || typeSpec.entity || typeSpec.qualifiedName || "")) {
        errors.push(`${prefix}.type.entityRef "${trimToString(typeSpec.entityRef || typeSpec.entity || typeSpec.qualifiedName)}" could not be resolved.`);
      }
    }
  }

  function isQuotedMendixStringLiteral(value) {
    return /^'(?:[^']|'')*'$/.test(trimToString(value));
  }

  function isSimpleVariableExpression(value) {
    return /^\$[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)?$/.test(trimToString(value));
  }

  function validateExpressionVariableRefs(expression, vars, prefix) {
    const expr = trimToString(expression);
    if (!expr) return;
    for (const match of expr.matchAll(/\$([A-Za-z][A-Za-z0-9_]*)(?:\/([A-Za-z][A-Za-z0-9_]*))?/g)) {
      const variable = vars.get(match[1]);
      if (!variable) {
        errors.push(`${prefix} references unassigned variable "$${match[1]}".`);
        continue;
      }
      if (match[2] && (!variable.entity || !resolveAttribute(variable.entity, match[2]))) {
        errors.push(`${prefix} references unresolved attribute "$${match[1]}/${match[2]}".`);
      }
    }
  }

  function validateValueExpressionForAttribute(expression, attr, vars, prefix) {
    const value = trimToString(expression);
    const attrType = attr && typeof attr.type === "object" ? "Enumeration" : trimToString(attr && attr.type) || "String";
    if (!value) {
      errors.push(`${prefix}.valueExpression is required.`);
      return;
    }
    validateExpressionVariableRefs(value, vars, `${prefix}.valueExpression`);
    if (isSimpleVariableExpression(value) || /^\[%[A-Za-z0-9_]+%\]$/.test(value)) return;
    if (["String", "UUID", "Enumeration"].includes(attrType)) {
      if (!isQuotedMendixStringLiteral(value)) errors.push(`${prefix}.valueExpression must be a quoted string literal or variable.`);
      return;
    }
    if (attrType === "Boolean") {
      if (!/^(true|false)$/i.test(value)) errors.push(`${prefix}.valueExpression must be true, false, or a variable.`);
      return;
    }
    if (["Integer", "Long"].includes(attrType)) {
      if (!/^-?\d+$/.test(value)) errors.push(`${prefix}.valueExpression must be an integer literal or variable.`);
      return;
    }
    if (attrType === "Decimal") {
      if (!/^-?\d+(?:\.\d+)?$/.test(value)) errors.push(`${prefix}.valueExpression must be a decimal literal or variable.`);
      return;
    }
    if (attrType === "DateTime" && !/^\[%[A-Za-z0-9_]+%\]$/.test(value)) {
      errors.push(`${prefix}.valueExpression must be a DateTime token or variable.`);
    }
  }

  function validateDecisionExpression(expression, vars, prefix) {
    const expr = trimToString(expression);
    if (!expr) {
      errors.push(`${prefix}.conditionExpression is required.`);
      return;
    }
    validateExpressionVariableRefs(expr, vars, `${prefix}.conditionExpression`);
    if (/^(true|false)$/i.test(expr)) return;
    if (!/[=!<>]=?| and | or |\(|\)/i.test(expr)) {
      errors.push(`${prefix}.conditionExpression must be a boolean expression.`);
    }
  }

  function validateUnsupportedPayloadAliases(action, prefix) {
    const at = normalizeActionType(action && action.type);
    if ((at === "retrieveList" || at === "retrieveObject") && action && action.parameters !== undefined) {
      errors.push(`${prefix}.parameters is unsupported; use xPathConstraint or an assigned object variable pattern.`);
    }
    if (at === "createObject" && action && action.attributes !== undefined) {
      errors.push(`${prefix}.attributes is unsupported; use a following changeObject.changes action.`);
    }
    if (at === "commitObject" && action && action.object !== undefined &&
      !requiredActionField(action, ["variableName", "targetVariableName", "objectVariableName"])) {
      errors.push(`${prefix}.object is unsupported; use variableName/targetVariableName/objectVariableName.`);
    }
    if (at === "decision" && action && action.condition !== undefined && action.conditionExpression === undefined && action.expression === undefined) {
      errors.push(`${prefix}.condition is unsupported; use conditionExpression or expression.`);
    }
  }

  function validateNestedDecisionActions(actions, inheritedVars, pointer) {
    const branchVars = new Map(inheritedVars);
    for (let k = 0; k < (Array.isArray(actions) ? actions : []).length; k += 1) {
      const action = actions[k] || {};
      const at = normalizeActionType(action.type);
      const prefix = `${pointer}[${k}]`;
      validateUnsupportedPayloadAliases(action, prefix);
      if (!at) {
        errors.push(`${prefix}.type is required.`);
        continue;
      }
      if (!SUPPORTED_MICROFLOW_ACTION_TYPES.has(at)) {
        errors.push(`${prefix}.type "${at}" is unsupported.`);
        continue;
      }
      if (at === "retrieveList" || at === "retrieveObject" || at === "createObject") {
        const entityRef = action.entityRef || action.entity || action.fromEntityRef || action.fromEntity || "";
        const entity = resolveEntity(entityRef);
        if (!entity) errors.push(`${prefix}.entityRef "${trimToString(entityRef)}" could not be resolved.`);
        const varName = String(action.outputVariableName || action.variableName || action.name || (entity ? `${entity.name}_${at === "retrieveList" ? "List" : at === "createObject" ? "New" : "Object"}` : "")).trim();
        if (varName && !branchVars.has(varName)) branchVars.set(varName, { kind: at === "retrieveList" ? "list" : "object", entity });
      }
      if (at === "commitObject") {
        const targetName = String(action.variableName || action.targetVariableName || action.objectVariableName || "").trim();
        const targetVar = branchVars.get(targetName);
        if (!targetName) {
          errors.push(`${prefix}.variableName is required.`);
        } else if (!targetVar || targetVar.kind !== "object") {
          errors.push(`${prefix}.variableName "${targetName}" is not an assigned object variable.`);
        }
      }
      if (at === "changeObject") {
        const targetName = String(action.targetVariableName || action.objectVariableName || action.variableName || action.changeVariableName || "").trim();
        const targetVar = branchVars.get(targetName);
        const entity = resolveEntity(action.entityRef || action.entity || "") || (targetVar && targetVar.entity) || null;
        if (!targetName) {
          errors.push(`${prefix}.targetVariableName is required.`);
        } else if (!targetVar || targetVar.kind !== "object" || !entity) {
          errors.push(`${prefix}.targetVariableName "${targetName}" is not an assigned object variable.`);
        }
        const changes = Array.isArray(action.changes)
          ? action.changes
          : Array.isArray(action.members)
            ? action.members
            : [];
        for (let c = 0; c < changes.length; c += 1) {
          const attrRef = changes[c] && (changes[c].attributeRef || changes[c].attribute || changes[c].memberRef || changes[c].member);
          const attr = entity ? resolveAttribute(entity, attrRef) : null;
          if (entity && !attr) {
            errors.push(`${prefix}.changes[${c}].attributeRef "${trimToString(attrRef)}" could not be resolved.`);
          }
          if (attr) {
            validateValueExpressionForAttribute(
              changes[c].valueExpression !== undefined ? changes[c].valueExpression : changes[c].expression,
              attr,
              branchVars,
              `${prefix}.changes[${c}]`
            );
          }
        }
      }
      if (at === "decision") {
        const condition = action.conditionExpression !== undefined ? action.conditionExpression : action.expression;
        validateDecisionExpression(condition, branchVars, prefix);
        validateNestedDecisionActions(action.trueActions || action.whenTrue || [], new Map(branchVars), `${prefix}.trueActions`);
        validateNestedDecisionActions(action.falseActions || action.whenFalse || [], new Map(branchVars), `${prefix}.falseActions`);
      }
      if (at === "returnValue") {
        validateExpressionVariableRefs(action.valueExpression || action.expression || "", branchVars, `${prefix}.valueExpression`);
      }
    }
  }

  const sections = [
    { name: "microflows", specs: parseSpecs(plan.microflows) },
    { name: "nanoflows", specs: parseSpecs(plan.nanoflows) }
  ];

  for (const section of sections) {
    for (let i = 0; i < section.specs.length; i += 1) {
      const spec = section.specs[i] || {};
      const actionSpecs = Array.isArray(spec.actions) ? spec.actions : [];
      const knownVars = new Map();
      const params = Array.isArray(spec.parameters) ? spec.parameters : [];

      for (let p = 0; p < params.length; p += 1) {
        const name = String((params[p] && params[p].name) || "").trim();
        if (!name) continue;
        if (knownVars.has(name)) {
          errors.push(`${section.name}.specs[${i}].parameters[${p}].name duplicates existing variable "${name}".`);
        }
        validateParameterTypeSpec(params[p].type || params[p].dataType || params[p].parameterType || { kind: "String" }, `${section.name}.specs[${i}].parameters[${p}]`);
        const entity = resolveEntity(params[p].entityRef || params[p].entity) ||
          inferEntityFromTypeSpec(params[p].type || params[p].dataType || params[p].parameterType || {});
        knownVars.set(name, { kind: entity ? "object" : "value", entity });
      }

      for (let j = 0; j < actionSpecs.length; j += 1) {
        const action = actionSpecs[j] || {};
        const at = normalizeActionType(action.type);
        const prefix = `${section.name}.specs[${i}].actions[${j}]`;

        if (!at) {
          errors.push(`${prefix}.type is required.`);
          continue;
        }
        validateUnsupportedPayloadAliases(action, prefix);
        if (!SUPPORTED_MICROFLOW_ACTION_TYPES.has(at)) {
          errors.push(`${prefix}.type "${at}" is unsupported.`);
          continue;
        }

        if ((at === "callMicroflow" || at === "callNanoflow") &&
          Array.isArray(action.parameterMappings) && action.parameterMappings.length > 0) {
          errors.push(`${prefix}.parameterMappings are unsupported.`);
        }

        if (at === "callMicroflow") {
          const target = trimToString(action.microflowRef || action.targetRef || action.microflowQualifiedName || action.target);
          if (!target || !microflowRefs.has(target)) errors.push(`${prefix}.microflowRef "${target}" could not be resolved.`);
        }

        if (at === "callNanoflow") {
          const target = trimToString(action.nanoflowRef || action.targetRef || action.nanoflowQualifiedName || action.target);
          if (!target || !nanoflowRefs.has(target)) errors.push(`${prefix}.nanoflowRef "${target}" could not be resolved.`);
        }

        if (at === "retrieveList" || at === "retrieveObject" || at === "createObject") {
          const entityRef = action.entityRef || action.entity || action.fromEntityRef || action.fromEntity || "";
          const entity = resolveEntity(entityRef);
          if (!entity) errors.push(`${prefix}.entityRef "${trimToString(entityRef)}" could not be resolved.`);
          const varName = String(action.outputVariableName || action.variableName || action.name || (entity ? `${entity.name}_${at === "retrieveList" ? "List" : "Object"}` : "")).trim();
          if (varName) {
            if (knownVars.has(varName)) {
              errors.push(`${prefix}.outputVariableName duplicates existing variable "${varName}".`);
            } else {
              knownVars.set(varName, { kind: at === "retrieveList" ? "list" : "object", entity });
            }
          }
        }

        if (at === "aggregateList") {
          const inputListVariableName = String(action.inputListVariableName || action.listVariableName || action.sourceListVariableName || action.input || "").trim();
          const inputVar = knownVars.get(inputListVariableName);
          if (!inputListVariableName) {
            errors.push(`${prefix}.listVariableName is required.`);
          } else if (!inputVar || inputVar.kind !== "list") {
            errors.push(`${prefix}.listVariableName "${inputListVariableName}" is not an assigned list variable.`);
          }

          const fn = String(action.function || action.aggregateFunction || "Count").trim().toLowerCase();
          const requiresAttr = ["sum", "minimum", "min", "maximum", "max", "average", "avg"].includes(fn);
          const attrRef = action.attributeRef || action.attribute || action.memberRef || action.member || "";
          if (requiresAttr && !requiredActionField(action, ["attributeRef", "attribute", "memberRef", "member"])) {
            errors.push(`${prefix}.attributeRef is required for aggregate function "${action.function || action.aggregateFunction}".`);
          } else if (attrRef && inputVar && inputVar.entity && !resolveAttribute(inputVar.entity, attrRef)) {
            errors.push(`${prefix}.attributeRef "${trimToString(attrRef)}" could not be resolved.`);
          }
          const outputVariableName = String(action.outputVariableName || action.variableName || action.name || (inputListVariableName ? `${inputListVariableName}Count` : "")).trim();
          if (outputVariableName) {
            if (knownVars.has(outputVariableName)) {
              errors.push(`${prefix}.outputVariableName duplicates existing variable "${outputVariableName}".`);
            } else {
              knownVars.set(outputVariableName, { kind: "value", entity: null });
            }
          }
        }

        if (at === "createVariable") {
          const varName = String(action.name || action.variableName || action.targetVariableName || "").trim();
          if (!varName) {
            errors.push(`${prefix}.variableName is required.`);
          } else if (knownVars.has(varName)) {
            errors.push(`${prefix}.variableName duplicates existing variable "${varName}".`);
          } else {
            const rawInitialValue = action.initialValueExpression !== undefined
              ? action.initialValueExpression
              : action.valueExpression !== undefined
                ? action.valueExpression
                : action.expression;
            if (rawInitialValue !== undefined && trimToString(rawInitialValue)) {
              validateValueExpressionForAttribute(rawInitialValue, {
                type: primitiveTypeFromTypeSpec(action.variableType || action.dataType || action.returnType || "String")
              }, knownVars, `${prefix}.initialValueExpression`);
            }
            const entity = inferEntityFromTypeSpec(action.variableType || action.dataType || action.returnType || {});
            knownVars.set(varName, { kind: entity ? "object" : "value", entity });
          }
        }

        if (at === "changeVariable") {
          const varName = String(action.name || action.variableName || action.changeVariableName || action.targetVariableName || "").trim();
          if (!knownVars.has(varName)) errors.push(`${prefix}.variableName "${varName}" is not assigned before use.`);
          validateExpressionVariableRefs(action.valueExpression || action.expression || "", knownVars, `${prefix}.valueExpression`);
        }

        if (at === "changeObject") {
          const targetName = String(action.targetVariableName || action.objectVariableName || action.variableName || action.changeVariableName || "").trim();
          const targetVar = knownVars.get(targetName);
          const explicitEntity = resolveEntity(action.entityRef || action.entity || "");
          const entity = explicitEntity || (targetVar && targetVar.entity) || null;
          if (!targetName) {
            errors.push(`${prefix}.targetVariableName is required.`);
          } else if (!targetVar || targetVar.kind !== "object" || !entity) {
            errors.push(`${prefix}.targetVariableName "${targetName}" is not an assigned object variable.`);
          }
          const changes = Array.isArray(action.changes)
            ? action.changes
            : Array.isArray(action.members)
              ? action.members
              : [];
          if (changes.length === 0) {
            errors.push(`${prefix}.changes must be a non-empty array.`);
          }
          for (let c = 0; c < changes.length; c += 1) {
            const attrRef = changes[c] && (changes[c].attributeRef || changes[c].attribute || changes[c].memberRef || changes[c].member);
            const attr = entity ? resolveAttribute(entity, attrRef) : null;
            if (entity && !attr) {
              errors.push(`${prefix}.changes[${c}].attributeRef "${trimToString(attrRef)}" could not be resolved.`);
            }
            if (attr) {
              validateValueExpressionForAttribute(
                changes[c].valueExpression !== undefined ? changes[c].valueExpression : changes[c].expression,
                attr,
                knownVars,
                `${prefix}.changes[${c}]`
              );
            }
          }
        }

        if (at === "commitObject") {
          const targetName = String(action.variableName || action.targetVariableName || action.objectVariableName || "").trim();
          const targetVar = knownVars.get(targetName);
          if (!targetName) {
            errors.push(`${prefix}.variableName is required.`);
          } else if (!targetVar || targetVar.kind !== "object") {
            errors.push(`${prefix}.variableName "${targetName}" is not an assigned object variable.`);
          }
        }

        if (at === "decision" && Array.isArray(action.outcomes)) {
          const boolOutcomes = action.outcomes
            .map((o) => (o && o.conditionExpression !== undefined ? o.conditionExpression : o && o.condition))
            .filter((v) => typeof v === "boolean");
          const trueCount = boolOutcomes.filter((v) => v === true).length;
          const falseCount = boolOutcomes.filter((v) => v === false).length;
          if (trueCount !== 1 || falseCount !== 1) {
            errors.push(`${prefix}.outcomes must contain exactly one true and one false condition.`);
          }
        }
        if (at === "decision") {
          const condition = action.conditionExpression !== undefined ? action.conditionExpression : action.expression;
          validateDecisionExpression(condition, knownVars, prefix);
          validateNestedDecisionActions(action.trueActions || action.whenTrue || [], new Map(knownVars), `${prefix}.trueActions`);
          validateNestedDecisionActions(action.falseActions || action.whenFalse || [], new Map(knownVars), `${prefix}.falseActions`);
        }
        if (at === "returnValue") {
          validateExpressionVariableRefs(action.valueExpression || action.expression || "", knownVars, `${prefix}.valueExpression`);
        }
      }
    }
  }

  return errors;
}

function validatePlan(plan, options = {}) {
  const errors = [];
  if (!plan || typeof plan !== "object") {
    errors.push("Plan must be a JSON object.");
    return errors;
  }

  const schemaErrors = validatePlanSchema(plan, options).map((message) => `Schema: ${message}`);
  errors.push(...schemaErrors);

  if (!plan.app || typeof plan.app !== "object") {
    errors.push("Missing required object: app");
  } else {
    const createApp = Boolean(plan.execution && plan.execution.createApp === true);
    const seedAppId =
      plan.execution && typeof plan.execution === "object" ? trimToString(plan.execution.seedAppId) : "";
    if (!createApp && !seedAppId && (!plan.app.appId || typeof plan.app.appId !== "string")) {
      errors.push("app.appId is required and must be a string.");
    }
    if (!plan.app.moduleName || typeof plan.app.moduleName !== "string") {
      errors.push("app.moduleName is required and must be a string.");
    }
    if (plan.pages && (!plan.app.layoutQualifiedName || typeof plan.app.layoutQualifiedName !== "string")) {
      errors.push("app.layoutQualifiedName is required when pages are defined.");
    }
    if (plan.app.homePageRef !== undefined && typeof plan.app.homePageRef !== "string") {
      errors.push("app.homePageRef must be a string when provided.");
    }
    if (plan.app.homePageName !== undefined && typeof plan.app.homePageName !== "string") {
      errors.push("app.homePageName must be a string when provided.");
    }
    if (plan.app.homePageQualifiedName !== undefined && typeof plan.app.homePageQualifiedName !== "string") {
      errors.push("app.homePageQualifiedName must be a string when provided.");
    }
    if (plan.app.navigation !== undefined && (typeof plan.app.navigation !== "object" || !plan.app.navigation)) {
      errors.push("app.navigation must be an object when provided.");
    }
  }

  const hasDomainModel = Boolean(plan.domainModel);
  const hasPages = Boolean(plan.pages);
  const hasSecurity = Boolean(plan.security);
  const hasMicroflows = Boolean(plan.microflows);
  const hasNanoflows = Boolean(plan.nanoflows);
  const hasWorkflows = Boolean(plan.workflows);

  if (!hasDomainModel && !hasSecurity && !hasPages && !hasMicroflows && !hasNanoflows && !hasWorkflows) {
    errors.push("Plan must contain at least one of: domainModel, security, microflows, nanoflows, workflows, pages.");
  }

  validateDuplicatePlanIdentifiers(plan, errors);

  if (plan.execution && typeof plan.execution !== "object") {
    errors.push("execution must be an object when provided.");
  }
  if (plan.execution && plan.execution.dg2Cleanup !== undefined && typeof plan.execution.dg2Cleanup !== "boolean") {
    errors.push("execution.dg2Cleanup must be a boolean when provided.");
  }
  if (plan.execution && plan.execution.createApp !== undefined && typeof plan.execution.createApp !== "boolean") {
    errors.push("execution.createApp must be a boolean when provided.");
  }
  if (
    plan.execution &&
    plan.execution.createAppName !== undefined &&
    typeof plan.execution.createAppName !== "string"
  ) {
    errors.push("execution.createAppName must be a string when provided.");
  }
  if (
    plan.execution &&
    plan.execution.createAppNamePrefix !== undefined &&
    typeof plan.execution.createAppNamePrefix !== "string"
  ) {
    errors.push("execution.createAppNamePrefix must be a string when provided.");
  }
  if (plan.execution && plan.execution.createAppRepositoryType !== undefined) {
    if (typeof plan.execution.createAppRepositoryType !== "string") {
      errors.push("execution.createAppRepositoryType must be a string when provided.");
    } else if (plan.execution.createAppRepositoryType !== "git") {
      errors.push('execution.createAppRepositoryType must be "git" when provided.');
    }
  }
  if (plan.execution && plan.execution.seedAppId !== undefined && typeof plan.execution.seedAppId !== "string") {
    errors.push("execution.seedAppId must be a string when provided.");
  }
  if (
    plan.execution &&
    plan.execution.forceLegacyWebClientForLookups !== undefined &&
    typeof plan.execution.forceLegacyWebClientForLookups !== "boolean"
  ) {
    errors.push("execution.forceLegacyWebClientForLookups must be a boolean when provided.");
  }

  if (plan.domainModel) {
    const sharedDomainNames = new Map();
    const addSharedDomainName = (name, label, pointer) => {
      const raw = trimToString(name);
      if (!raw) return;
      const key = raw.toLowerCase();
      const existing = sharedDomainNames.get(key);
      if (existing) {
        errors.push(`${pointer} duplicates ${existing.label} "${existing.name}"; entities, associations, and enumerations share one Mendix module namespace.`);
        return;
      }
      sharedDomainNames.set(key, { name: raw, label, pointer });
    };
    if (!Array.isArray(plan.domainModel.entities)) {
      errors.push("domainModel.entities must be an array.");
    } else {
      plan.domainModel.entities.forEach((entity, entityIndex) => {
        if (!entity || typeof entity !== "object") return;
        addSharedDomainName(entity.name, "entity", `domainModel.entities[${entityIndex}].name`);
        validateMendixIdentifier(entity.name, `domainModel.entities[${entityIndex}].name`, "entity name", errors);
        if (Array.isArray(entity.attributes)) {
          entity.attributes.forEach((attribute, attributeIndex) => {
            if (!attribute || typeof attribute !== "object") return;
            validateMendixIdentifier(
              attribute.name,
              `domainModel.entities[${entityIndex}].attributes[${attributeIndex}].name`,
              "attribute name",
              errors
            );
          });
        }
      });
    }
    if (plan.domainModel.associations && !Array.isArray(plan.domainModel.associations)) {
      errors.push("domainModel.associations must be an array when provided.");
    }
    if (Array.isArray(plan.domainModel.associations)) {
      plan.domainModel.associations.forEach((association, index) => {
        if (!association || typeof association !== "object") return;
        addSharedDomainName(association.name, "association", `domainModel.associations[${index}].name`);
        const type = association.type;
        if (type === undefined || type === null || type === "") return;
        const normalizedType = normalizeAssociationType(type);
        if (!normalizedType.ok) {
          errors.push(
            `domainModel.associations[${index}].type "${type}" is not supported. Expected ${supportedAssociationTypeDescription()}.`
          );
        }
      });
    }
    if (plan.domainModel.enumerations && !Array.isArray(plan.domainModel.enumerations)) {
      errors.push("domainModel.enumerations must be an array when provided.");
    } else if (Array.isArray(plan.domainModel.enumerations)) {
      plan.domainModel.enumerations.forEach((enumeration, enumIndex) => {
        if (!enumeration || typeof enumeration !== "object") return;
        addSharedDomainName(enumeration.name, "enumeration", `domainModel.enumerations[${enumIndex}].name`);
        validateMendixIdentifier(enumeration.name, `domainModel.enumerations[${enumIndex}].name`, "enumeration name", errors);
        if (Array.isArray(enumeration.values)) {
          enumeration.values.forEach((value, valueIndex) => {
            validateMendixIdentifier(enumValueName(value), `domainModel.enumerations[${enumIndex}].values[${valueIndex}]`, "enumeration value", errors);
          });
        }
      });
    }
  }

  if (plan.microflows) {
    const specs = plan.microflows.specs || plan.microflows.items;
    if (!Array.isArray(specs)) {
      errors.push("microflows.specs (or microflows.items) must be an array.");
    }
  }

  if (plan.nanoflows) {
    const specs = plan.nanoflows.specs || plan.nanoflows.items;
    if (!Array.isArray(specs)) {
      errors.push("nanoflows.specs (or nanoflows.items) must be an array.");
    }
  }

  if (plan.bpmnSources) {
    errors.push("bpmnSources is not supported in this phase. Workflow generation is DSL-only.");
  }

  if (plan.workflows) {
    const specs = plan.workflows.specs || plan.workflows.items;
    const availableUserRoleNames = new Set(
      (Array.isArray(plan.security && plan.security.userRoles) ? plan.security.userRoles : [])
        .map((role) => trimToString(role && role.name))
        .filter(Boolean)
    );
    if (!Array.isArray(specs)) {
      errors.push("workflows.specs (or workflows.items) must be an array.");
    } else {
      for (const spec of specs) {
        if (!spec || typeof spec !== "object") continue;
        if (!spec.name || typeof spec.name !== "string") {
          errors.push("Each workflows.specs entry requires a string name.");
          continue;
        }
        const contextEntityRef =
          (spec.bindings && spec.bindings.contextEntityRef) ||
          spec.contextEntityRef ||
          spec.parameterEntityRef ||
          "";
        if (!contextEntityRef || typeof contextEntityRef !== "string") {
          errors.push(`Workflow \"${spec.name}\" requires bindings.contextEntityRef in DSL-only mode.`);
        }
        if (spec.bpmnSourceId || spec.bpmn) {
          errors.push(`Workflow \"${spec.name}\" contains BPMN fields, which are unsupported in this phase.`);
        }
        if (!Array.isArray(spec.steps)) {
          errors.push(`Workflow \"${spec.name}\" must define a steps array in DSL-only mode.`);
        }
        walkWorkflowSteps(spec.steps, (step) => {
          const refs = Array.isArray(step.userRoleRefs)
            ? step.userRoleRefs
            : Array.isArray(step.targetUserRoleRefs)
              ? step.targetUserRoleRefs
              : Array.isArray(step.allowedUserRoles)
                ? step.allowedUserRoles
                : [];
          for (const rawRef of refs) {
            const ref = trimToString(rawRef);
            if (!ref) continue;
            const normalizedName = ref.includes(".") ? ref.split(".").pop() : ref;
            if (availableUserRoleNames.size > 0 && !availableUserRoleNames.has(normalizedName)) {
              errors.push(`Workflow \"${spec.name}\" references missing security.userRoles entry \"${ref}\".`);
            }
            if (
              !/^[A-Za-z0-9_]+$/.test(normalizedName) &&
              !trimToString(step.userAssignmentXPath || step.userTargetingXPath || step.userSourceXPath)
            ) {
              errors.push(
                `Workflow \"${spec.name}\" user role \"${ref}\" requires explicit userAssignmentXPath because only letters, digits, and underscores can be auto-targeted.`
              );
            }
          }
        });
      }
    }
  }

  if (plan.pages) {
    const specs = plan.pages.specs || plan.pages.pageSpecs;
    if (!Array.isArray(specs)) {
      errors.push("pages.specs (or pages.pageSpecs) must be an array.");
    }
  }

  const pageValidation = validatePageSpecs(plan, errors) || {
    pageRefs: new Set(),
    availableModuleRoles: collectModuleRoleNamesFromPlan(plan)
  };

  const planVersion = String((plan.meta && plan.meta.planVersion) || "").trim();
  const generatedBy = String((plan.meta && plan.meta.generatedBy) || "").trim();
  const shouldRequireNavigationContract =
    Boolean(plan.pages) &&
    (generatedBy === "pipeline.plan-generator" || /^1\.[1-9]\d*\./.test(planVersion) || /^1\.1\./.test(planVersion));

  if (generatedBy === "pipeline.plan-generator" && !plan.security) {
    errors.push("security is required for plans generated by pipeline.plan-generator.");
  }

  if (shouldRequireNavigationContract) {
    const nav = normalizeNavigationConfig(plan.app && plan.app.navigation);
    const pageSpecs = parseSpecs(plan.pages);
    const moduleName = trimToString(plan.app && plan.app.moduleName);
    if (!nav || typeof nav !== "object") {
      errors.push(
        "app.navigation is required for generated plans with pages and must include navigation entries."
      );
    } else {
      const homeRefs = Array.isArray(nav.homePageButtonRefs) ? nav.homePageButtonRefs : null;
      const navRefs = Array.isArray(nav.navigationItemRefs) ? nav.navigationItemRefs : null;
      if (!homeRefs || homeRefs.length === 0) {
        errors.push("app.navigation.homePageButtons or app.navigation.homePageButtonRefs must be non-empty for generated plans.");
      }
      if (!navRefs || navRefs.length === 0) {
        errors.push("app.navigation.menuItems or app.navigation.navigationItemRefs must be non-empty for generated plans.");
      }

      function validatePageRefArray(refs, pointer) {
        if (!Array.isArray(refs)) return;
        for (const ref of refs) {
          if (typeof ref !== "string" || !ref.trim()) {
            errors.push(`${pointer} must only contain non-empty strings.`);
            continue;
          }
          if (!pageValidation.pageRefs.has(ref)) {
            errors.push(`${pointer} contains unknown page ref "${ref}".`);
          }
        }
      }

      validatePageRefArray(homeRefs, "app.navigation.homePageButtonRefs");
      validatePageRefArray(navRefs, "app.navigation.navigationItemRefs");

      if (Array.isArray(nav.homePageButtons)) {
        for (let i = 0; i < nav.homePageButtons.length; i += 1) {
          const entry = nav.homePageButtons[i] || {};
          const pointer = `app.navigation.homePageButtons[${i}]`;
          const targetPage = findPageSpecByToken(pageSpecs, entry.pageRef);
          if (!targetPage) {
            errors.push(`${pointer}.pageRef points to unknown page "${entry.pageRef || ""}".`);
            continue;
          }
          const requiredParams = collectRequiredPageParameterEntities(targetPage, moduleName);
          if (requiredParams.length > 0) {
            errors.push(
              `${pointer}.pageRef points to parameterized page "${entry.pageRef}", which cannot be opened directly from homepage navigation.`
            );
          }
          validateIconSpec(entry.icon, `${pointer}.icon`, errors);
          validateRoleRefs({
            refs: entry.allowedRoles,
            pointer: `${pointer}.allowedRoles`,
            errors,
            availableModuleRoles: pageValidation.availableModuleRoles
          });
        }
      }

      if (Array.isArray(nav.menuItems)) {
        for (let i = 0; i < nav.menuItems.length; i += 1) {
          const entry = nav.menuItems[i] || {};
          const pointer = `app.navigation.menuItems[${i}]`;
          const targetPage = findPageSpecByToken(pageSpecs, entry.pageRef);
          if (!targetPage) {
            errors.push(`${pointer}.pageRef points to unknown page "${entry.pageRef || ""}".`);
            continue;
          }
          const requiredParams = collectRequiredPageParameterEntities(targetPage, moduleName);
          if (requiredParams.length > 0) {
            errors.push(
              `${pointer}.pageRef points to parameterized page "${entry.pageRef}", which cannot be opened directly from menu navigation.`
            );
          }
          validateIconSpec(entry.icon, `${pointer}.icon`, errors);
          validateRoleRefs({
            refs: entry.allowedRoles,
            pointer: `${pointer}.allowedRoles`,
            errors,
            availableModuleRoles: pageValidation.availableModuleRoles
          });
        }
      }
    }
  }

  if (plan.verification && typeof plan.verification !== "object") {
    errors.push("verification must be an object when provided.");
  }
  if (plan.verification && plan.verification.checks && !Array.isArray(plan.verification.checks)) {
    errors.push("verification.checks must be an array when provided.");
  }
  if (plan.verification && plan.verification.scope !== undefined) {
    const scope = String(plan.verification.scope || "").trim();
    if (scope && scope !== "generatedModule") {
      errors.push('verification.scope must be "generatedModule" when provided.');
    }
  }
  if (plan.verification && plan.verification.semanticChecks !== undefined) {
    if (!plan.verification.semanticChecks || typeof plan.verification.semanticChecks !== "object") {
      errors.push("verification.semanticChecks must be an object when provided.");
    } else {
      for (const [name, value] of Object.entries(plan.verification.semanticChecks)) {
        if (typeof value !== "boolean") {
          errors.push(`verification.semanticChecks.${name} must be a boolean.`);
        }
      }
    }
  }

  if (plan.security) {
    if (typeof plan.security !== "object") {
      errors.push("security must be an object when provided.");
    } else {
      if (plan.security.securityLevel !== undefined) {
        const securityLevel = trimToString(plan.security.securityLevel).toLowerCase();
        if (securityLevel && !["none", "off", "prototype", "production"].includes(securityLevel)) {
          errors.push('security.securityLevel must be one of: "none", "off", "prototype", "production".');
        }
      }
      if (plan.security.moduleRoles !== undefined && !Array.isArray(plan.security.moduleRoles)) {
        errors.push("security.moduleRoles must be an array when provided.");
      }
      if (plan.security.userRoles !== undefined && !Array.isArray(plan.security.userRoles)) {
        errors.push("security.userRoles must be an array when provided.");
      }
      if (plan.security.demoUsers !== undefined && !Array.isArray(plan.security.demoUsers)) {
        errors.push("security.demoUsers must be an array when provided.");
      }
      if (Array.isArray(plan.security.userRoles)) {
        for (const roleSpec of plan.security.userRoles) {
          if (!roleSpec || typeof roleSpec !== "object" || !roleSpec.name || typeof roleSpec.name !== "string") {
            errors.push("Each security.userRoles entry must be an object with string name.");
            continue;
          }
          if (RESERVED_SECURITY_USER_ROLE_NAMES.has(trimToString(roleSpec.name).toLowerCase())) {
            errors.push(
              `security.userRoles entry "${roleSpec.name}" uses a reserved Mendix built-in user role name. ` +
                "Use an app-specific name such as Admin, Supervisor, or Manager instead."
            );
          }
        }
      }
      if (Array.isArray(plan.security.demoUsers)) {
        for (const userSpec of plan.security.demoUsers) {
          const userName = userSpec && (userSpec.userName || userSpec.username);
          if (!userName || typeof userName !== "string") {
            errors.push("Each security.demoUsers entry must contain userName (or username).");
          }
          if (!userSpec || typeof userSpec.password !== "string" || !userSpec.password) {
            errors.push(`security.demoUsers entry "${userName || "<unknown>"}" is missing password.`);
          }
        }
      }
    }
  }

  if (plan.personas) {
    if (typeof plan.personas !== "object") {
      errors.push("personas must be an object when provided.");
    } else {
      if (plan.personas.specs !== undefined && !Array.isArray(plan.personas.specs)) {
        errors.push("personas.specs must be an array when provided.");
      }
      if (Array.isArray(plan.personas.specs)) {
        for (const spec of plan.personas.specs) {
          if (!spec || typeof spec !== "object") {
            errors.push("Each personas.specs entry must be an object.");
            continue;
          }
          if (!spec.name || typeof spec.name !== "string") {
            errors.push("Each personas.specs entry must contain a string name.");
          }
        }
      }
    }
  }

  if (plan.packs) {
    const refs = normalizePackRefs(plan);
    if (refs.length === 0) {
      errors.push("packs is provided but no valid refs were found. Use packs.refs or an array of file paths.");
    }
  }

  errors.push(...validateMicroflowActionSpecs(plan));

  return errors;
}

module.exports = {
  validatePlan,
  validatePlanSchema,
  loadPlanSchema,
  applyReservedWordSanitizationToPlan,
  normalizeActionType,
  SUPPORTED_PAGE_STEP_TYPES: Array.from(SUPPORTED_PAGE_STEP_TYPES),
  RESERVED_ATTRIBUTE_NAMES,
  replacementBaseForReservedAttribute,
  buildUniqueAttributeName
};
