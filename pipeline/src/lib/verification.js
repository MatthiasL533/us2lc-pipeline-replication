const { parseSpecs } = require("./pack-merger");
const { normalizeNavigationConfig } = require("./navigation-contract");

function buildPlannedPageRefs(moduleName, pagesSection = {}) {
  const refs = {};
  const specs = parseSpecs(pagesSection);

  for (const spec of specs) {
    if (!spec || typeof spec !== "object") continue;
    if (!spec.name || typeof spec.name !== "string") continue;

    const qname = spec.name.includes(".") ? spec.name : `${moduleName}.${spec.name}`;
    if (spec.ref && typeof spec.ref === "string") {
      refs[spec.ref] = qname;
    }
    refs[spec.name] = qname;
  }

  return refs;
}

function collectRequestedNames(plan) {
  return {
    pages: parseSpecs(plan.pages).map((s) => s.name).filter(Boolean),
    entities: ((plan.domainModel && plan.domainModel.entities) || []).map((e) => e.name).filter(Boolean),
    microflows: parseSpecs(plan.microflows).map((s) => s.name).filter(Boolean),
    nanoflows: parseSpecs(plan.nanoflows).map((s) => s.name).filter(Boolean),
    workflows: parseSpecs(plan.workflows).map((s) => s.name).filter(Boolean)
  };
}

function moduleNameFromQualifiedName(qname = "") {
  if (!qname || typeof qname !== "string" || !qname.includes(".")) return "";
  return qname.split(".")[0] || "";
}

function safeGet(getter, fallback = null) {
  try {
    return getter();
  } catch (_err) {
    return fallback;
  }
}

function moduleNameFromFolderBase(folderBase) {
  let current = folderBase || null;
  let guard = 0;

  while (current && guard < 20) {
    const containerAsModule = safeGet(() => current.containerAsModule, null);
    if (containerAsModule && containerAsModule.name) {
      return containerAsModule.name;
    }

    const containerAsFolder = safeGet(() => current.containerAsFolder, null);
    const folderContainerModule = safeGet(() => containerAsFolder.containerAsModule, null);
    if (folderContainerModule && folderContainerModule.name) {
      return folderContainerModule.name;
    }

    const parentFolderBase = safeGet(() => containerAsFolder.containerAsFolderBase, null);
    if (parentFolderBase) {
      current = parentFolderBase;
      guard += 1;
      continue;
    }

    break;
  }

  return "";
}

function inferModuleNameForFolderDocument(item) {
  if (!item || typeof item !== "object") return "";
  const containerAsModule = safeGet(() => item.containerAsModule, null);
  if (containerAsModule && containerAsModule.name) return containerAsModule.name;

  const containerAsFolderBase = safeGet(() => item.containerAsFolderBase, null);
  if (containerAsFolderBase) {
    const fromFolder = moduleNameFromFolderBase(containerAsFolderBase);
    if (fromFolder) return fromFolder;
  }

  const qualifiedName = safeGet(() => item.qualifiedName, "");
  if (qualifiedName && typeof qualifiedName === "string") {
    return moduleNameFromQualifiedName(qualifiedName);
  }
  return "";
}

function inferModuleNameForEntity(item) {
  if (!item || typeof item !== "object") return "";
  const containerAsDomainModel = safeGet(() => item.containerAsDomainModel, null);
  const dmModule = safeGet(() => containerAsDomainModel.containerAsModule, null);
  if (dmModule && dmModule.name) {
    return dmModule.name;
  }

  const qualifiedName = safeGet(() => item.qualifiedName, "");
  if (qualifiedName && typeof qualifiedName === "string") {
    return moduleNameFromQualifiedName(qualifiedName);
  }
  return "";
}

function collectNamedRefs(items, moduleName, inferModuleNameFn) {
  const refs = [];
  const source = Array.isArray(items) ? items : [];

  for (const item of source) {
    if (!item) continue;
    const inferred = safeGet(() => inferModuleNameFn(item), "");
    if (inferred !== moduleName) continue;

    const name = safeGet(() => item.name, "");
    if (!name) continue;

    const id = safeGet(() => item.id, "");
    refs.push({ name, id });
  }

  return refs;
}

function collectModuleRefs(model, moduleName) {
  const pages = collectNamedRefs(safeGet(() => model.allPages(), []), moduleName, inferModuleNameForFolderDocument);

  const microflows = collectNamedRefs(
    safeGet(() => model.allMicroflows(), []),
    moduleName,
    inferModuleNameForFolderDocument
  );

  const nanoflows = collectNamedRefs(
    safeGet(() => model.allNanoflows(), []),
    moduleName,
    inferModuleNameForFolderDocument
  );

  const workflowIfaces = typeof model.allWorkflows === "function" ? model.allWorkflows() : [];
  const workflows = collectNamedRefs(workflowIfaces, moduleName, inferModuleNameForFolderDocument);

  let entities = [];
  if (typeof model.allEntities === "function") {
    entities = collectNamedRefs(safeGet(() => model.allEntities(), []), moduleName, inferModuleNameForEntity);
  } else if (typeof model.allDomainModels === "function") {
    const domainModels = model
      .allDomainModels()
      .filter((dm) => {
        const dmModule = safeGet(() => dm.containerAsModule, null);
        return Boolean(dmModule && dmModule.name === moduleName);
      });

    const fromDomainModel = [];
    for (const dm of domainModels) {
      const entityIfaces = Array.isArray(dm.entities) ? dm.entities : [];
      for (const e of entityIfaces) {
        if (!e || !e.name) continue;
        const inferred =
          inferModuleNameForEntity(e) ||
          (safeGet(() => dm.containerAsModule && dm.containerAsModule.name, "") || "");
        if (inferred !== moduleName) continue;
        fromDomainModel.push({ name: e.name, id: e.id || "" });
      }
    }
    entities = fromDomainModel;
  }

  return {
    pages,
    entities,
    microflows,
    nanoflows,
    workflows,
    counts: {
      pagesInModule: pages.length,
      entitiesInModule: entities.length,
      microflowsInModule: microflows.length,
      nanoflowsInModule: nanoflows.length,
      workflowsInModule: workflows.length
    }
  };
}

function verifyRequestedArtifacts({ requested, refs, strict = true }) {
  const refSets = {
    pages: new Set(refs.pages.map((x) => x.name)),
    entities: new Set(refs.entities.map((x) => x.name)),
    microflows: new Set(refs.microflows.map((x) => x.name)),
    nanoflows: new Set(refs.nanoflows.map((x) => x.name)),
    workflows: new Set(refs.workflows.map((x) => x.name))
  };

  const missing = {
    pages: requested.pages.filter((name) => !refSets.pages.has(name)),
    entities: requested.entities.filter((name) => !refSets.entities.has(name)),
    microflows: requested.microflows.filter((name) => !refSets.microflows.has(name)),
    nanoflows: requested.nanoflows.filter((name) => !refSets.nanoflows.has(name)),
    workflows: requested.workflows.filter((name) => !refSets.workflows.has(name))
  };

  const missingCount =
    missing.pages.length +
    missing.entities.length +
    missing.microflows.length +
    missing.nanoflows.length +
    missing.workflows.length;

  if (strict && missingCount > 0) {
    throw new Error(`Verification failed. Missing artifacts: ${JSON.stringify(missing)}`);
  }

  return {
    missing,
    ok: missingCount === 0
  };
}

function toArrayFromList(list) {
  if (!list) return [];
  if (Array.isArray(list)) return list.filter(Boolean);
  if (typeof list.slice === "function") {
    try {
      return list.slice().filter(Boolean);
    } catch (_err) {
      // ignore
    }
  }
  const out = [];
  if (typeof list.forEach === "function") {
    list.forEach((item) => {
      if (item) out.push(item);
    });
  }
  return out;
}

function trimToString(value) {
  return String(value || "").trim();
}

function normalizeRoleNames(values = []) {
  return [...new Set((values || []).map((value) => trimToString(value)).filter(Boolean))];
}

function normalizeRoleRefToLocalName(rawRef, moduleName) {
  const ref = trimToString(rawRef);
  if (!ref) return "";
  if (ref.includes(".")) {
    const [refModule, roleName] = ref.split(".");
    if (refModule && refModule !== moduleName) return "";
    return roleName || "";
  }
  return ref;
}

function collectWorkflowUserRoleRefs(steps = [], out = []) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== "object") continue;
    const refs = Array.isArray(step.userRoleRefs)
      ? step.userRoleRefs
      : Array.isArray(step.targetUserRoleRefs)
        ? step.targetUserRoleRefs
        : Array.isArray(step.allowedUserRoles)
          ? step.allowedUserRoles
          : [];
    for (const ref of refs) {
      const normalized = trimToString(ref);
      if (normalized) out.push(normalized);
    }

    const outcomes = Array.isArray(step.outcomes) ? step.outcomes : [];
    for (const outcome of outcomes) {
      collectWorkflowUserRoleRefs(outcome && outcome.steps, out);
    }
  }
  return out;
}

function collectPlannedModuleRoleNames(plan = {}, moduleName = "") {
  const names = [];
  const security = plan.security || {};
  const pages = parseSpecs(plan.pages);
  const navigation = normalizeNavigationConfig(plan.app && plan.app.navigation ? plan.app.navigation : {});

  names.push(...normalizeRoleNames(security.moduleRoles || []));

  for (const userRole of Array.isArray(security.userRoles) ? security.userRoles : []) {
    for (const rawRef of Array.isArray(userRole && userRole.moduleRoles) ? userRole.moduleRoles : []) {
      const localName = normalizeRoleRefToLocalName(rawRef, moduleName);
      if (localName) names.push(localName);
    }
  }

  for (const page of pages) {
    for (const rawRef of Array.isArray(page && page.allowedRoles) ? page.allowedRoles : []) {
      const localName = normalizeRoleRefToLocalName(rawRef, moduleName);
      if (localName) names.push(localName);
    }
  }

  for (const entry of [...(navigation.homePageButtons || []), ...(navigation.menuItems || [])]) {
    for (const rawRef of Array.isArray(entry && entry.allowedRoles) ? entry.allowedRoles : []) {
      const localName = normalizeRoleRefToLocalName(rawRef, moduleName);
      if (localName) names.push(localName);
    }
  }

  return normalizeRoleNames(names);
}

function collectPlannedUserRoleNames(plan = {}) {
  const names = [];
  const security = plan.security || {};
  for (const userRole of Array.isArray(security.userRoles) ? security.userRoles : []) {
    if (userRole && userRole.name) names.push(String(userRole.name));
  }
  for (const demoUser of Array.isArray(security.demoUsers) ? security.demoUsers : []) {
    for (const rawRef of Array.isArray(demoUser && demoUser.userRoles) ? demoUser.userRoles : []) {
      const ref = trimToString(rawRef);
      if (ref) names.push(ref.includes(".") ? ref.split(".").pop() : ref);
    }
  }
  for (const workflow of parseSpecs(plan.workflows)) {
    collectWorkflowUserRoleRefs(workflow && workflow.steps, names);
  }
  return normalizeRoleNames(names.map((name) => (name.includes(".") ? name.split(".").pop() : name)));
}

function collectPlannedDemoUserNames(plan = {}) {
  return normalizeRoleNames(
    (Array.isArray(plan.security && plan.security.demoUsers) ? plan.security.demoUsers : []).map(
      (demoUser) => demoUser && (demoUser.userName || demoUser.username)
    )
  );
}

function normalizeActualRoleName(role) {
  return trimToString(role && (role.qualifiedName || role.name));
}

async function materialize(item) {
  if (!item) return null;
  if (typeof item.load === "function") {
    return item.load();
  }
  return item;
}

async function findModule(model, moduleName) {
  const moduleIface =
    typeof model.allModules === "function"
      ? toArrayFromList(model.allModules()).find((candidate) => candidate && candidate.name === moduleName)
      : null;
  return materialize(moduleIface);
}

function collectPageWidgets(root) {
  const widgets = [];
  const visited = new Set();

  function visit(value) {
    if (!value || typeof value !== "object") return;
    const id = trimToString(value.id || "");
    if (id && visited.has(id)) return;
    if (id) visited.add(id);

    if (typeof value.structureTypeName === "string" && /Pages\$|CustomWidgets\$/.test(value.structureTypeName)) {
      widgets.push(value);
    }

    const listProps = ["widgets", "items", "columns", "arguments", "properties", "objects"];
    for (const prop of listProps) {
      for (const item of toArrayFromList(value[prop])) {
        visit(item);
      }
    }

    const singleProps = [
      "layoutCall",
      "dataSource",
      "searchBar",
      "controlBar",
      "action",
      "pageSettings",
      "object",
      "type",
      "icon",
      "conditionalVisibilitySettings"
    ];
    for (const prop of singleProps) {
      const nestedValue = safeGet(() => value[prop], null);
      if (nestedValue) visit(nestedValue);
    }
  }

  visit(root);
  return widgets;
}

async function verifyPlanSemantics({ plan, model, moduleName, pageRefsByRef = {}, strict = true }) {
  const pages = parseSpecs(plan.pages);
  const navigation = normalizeNavigationConfig(plan.app && plan.app.navigation ? plan.app.navigation : {});
  const missing = {
    moduleRoles: [],
    userRoles: [],
    demoUsers: [],
    pageVisibility: [],
    homePageButtons: [],
    menuItems: [],
    widgets: []
  };

  const module = await findModule(model, moduleName);
  const moduleSecurity = await materialize(module && module.moduleSecurity ? module.moduleSecurity : null);
  const moduleRoleSource = toArrayFromList(moduleSecurity && moduleSecurity.moduleRoles);
  const actualModuleRoleNames = new Set(
    moduleRoleSource
      .map((role) => trimToString(role && role.name))
      .filter(Boolean)
  );

  for (const expected of collectPlannedModuleRoleNames(plan, moduleName)) {
    if (!actualModuleRoleNames.has(expected)) missing.moduleRoles.push(expected);
  }

  const projectSecurityIface =
    typeof model.allProjectSecurities === "function" ? (model.allProjectSecurities()[0] || null) : null;
  const projectSecurity = await materialize(projectSecurityIface);
  const allUserRoles = toArrayFromList(projectSecurity && projectSecurity.userRoles);
  const actualUserRoleNames = new Set(
    allUserRoles
      .map((role) => trimToString(role && role.name))
      .filter(Boolean)
  );
  for (const expected of collectPlannedUserRoleNames(plan)) {
    if (!actualUserRoleNames.has(expected)) missing.userRoles.push(expected);
  }

  const actualDemoUserNames = new Set(
    toArrayFromList(projectSecurity && projectSecurity.demoUsers).map((demoUser) => trimToString(demoUser && demoUser.userName)).filter(Boolean)
  );

  for (const pageSpec of pages) {
    const requestedRoles = normalizeRoleNames(pageSpec && pageSpec.allowedRoles);
    if (requestedRoles.length === 0) continue;
    const qname =
      (pageSpec && pageSpec.name ? pageRefsByRef[pageSpec.ref] || `${moduleName}.${pageSpec.name}` : "") || "";
    const pageIface = qname && typeof model.findPageByQualifiedName === "function" ? model.findPageByQualifiedName(qname) : null;
    const page = await materialize(pageIface);
    const actualRoles = new Set(
      toArrayFromList(page && page.allowedRoles)
        .map((role) => normalizeActualRoleName(role))
        .filter(Boolean)
        .map((name) => (name.includes(".") ? name.split(".").pop() : name))
    );
    for (const role of requestedRoles) {
      if (!actualRoles.has(role)) {
        missing.pageVisibility.push(`${pageSpec.name}:${role}`);
      }
    }
  }

  const homeQname =
    trimToString(plan.app && plan.app.homePageQualifiedName) ||
    (trimToString(plan.app && plan.app.homePageRef)
      ? pageRefsByRef[trimToString(plan.app.homePageRef)] || `${moduleName}.${trimToString(plan.app.homePageRef)}`
      : "");
  const homePage = homeQname && typeof model.findPageByQualifiedName === "function"
    ? await materialize(model.findPageByQualifiedName(homeQname))
    : null;
  const homeWidgets = collectPageWidgets(homePage);
  const homeButtonTargets = new Set();
  for (const widget of homeWidgets) {
    if (!widget || widget.structureTypeName !== "Pages$ActionButton") continue;
    const action = widget.action || null;
    const pageQname = trimToString(action && action.pageSettings ? action.pageSettings.pageQualifiedName : "");
    if (pageQname) homeButtonTargets.add(pageQname);
  }
  for (const entry of navigation.homePageButtons || []) {
    const expectedQname = pageRefsByRef[entry.pageRef] || `${moduleName}.${entry.pageRef}`;
    if (!homeButtonTargets.has(expectedQname)) {
      missing.homePageButtons.push(entry.pageRef);
    }
  }

  const navDocs = typeof model.allNavigationDocuments === "function" ? toArrayFromList(model.allNavigationDocuments()) : [];
  const actualMenuTargets = new Set();
  for (const navDocIface of navDocs) {
    const navDoc = await materialize(navDocIface);
    for (const profile of toArrayFromList(navDoc && navDoc.profiles)) {
      for (const item of toArrayFromList(profile && profile.menuItemCollection ? profile.menuItemCollection.items : [])) {
        const action = item && item.action ? item.action : null;
        const qname = trimToString(action && action.pageSettings ? action.pageSettings.pageQualifiedName : "");
        if (qname) actualMenuTargets.add(qname);
      }
    }
  }
  for (const entry of navigation.menuItems || []) {
    const expectedQname = pageRefsByRef[entry.pageRef] || `${moduleName}.${entry.pageRef}`;
    if (!actualMenuTargets.has(expectedQname)) {
      missing.menuItems.push(entry.pageRef);
    }
  }

  for (const pageSpec of pages) {
    const qname = pageRefsByRef[pageSpec.ref] || `${moduleName}.${pageSpec.name}`;
    const page = qname && typeof model.findPageByQualifiedName === "function"
      ? await materialize(model.findPageByQualifiedName(qname))
      : null;
    if (!page) continue;
    const widgets = collectPageWidgets(page);
    const customWidgetIds = new Set();
    const structureTypes = new Set();
    for (const widget of widgets) {
      if (widget && widget.structureTypeName) structureTypes.add(widget.structureTypeName);
      const widgetType = widget && widget.structureTypeName === "CustomWidgets$CustomWidget" ? widget.type || null : null;
      const widgetId = trimToString(widgetType && widgetType.widgetId);
      if (widgetId) customWidgetIds.add(widgetId);
    }

    function walkSteps(steps = []) {
      for (const step of Array.isArray(steps) ? steps : []) {
        if (!step || typeof step !== "object") continue;
        if (step.type === "dataGrid") {
          if (![...structureTypes].some((type) => type === "Pages$DataGrid") && customWidgetIds.size === 0) {
            missing.widgets.push(`${pageSpec.name}:dataGrid`);
          }
        }
        if (step.type === "widget" && step.widgetId) {
          if (![...customWidgetIds].some((widgetId) => widgetId === step.widgetId)) {
            missing.widgets.push(`${pageSpec.name}:widget:${step.widgetId}`);
          }
        }
        walkSteps(step.content);
        walkSteps(step.templateContent);
        walkSteps(step.itemContent);
      }
    }

    walkSteps(pageSpec.content);
  }

  const missingCount = Object.values(missing).reduce((count, entries) => count + entries.length, 0);
  if (strict && missingCount > 0) {
    throw new Error(`Verification failed. Missing semantic artifacts: ${JSON.stringify(missing)}`);
  }

  return {
    ok: missingCount === 0,
    missing
  };
}

module.exports = {
  buildPlannedPageRefs,
  collectRequestedNames,
  collectModuleRefs,
  verifyRequestedArtifacts,
  verifyPlanSemantics,
  safeGet,
  moduleNameFromFolderBase,
  inferModuleNameForEntity,
  inferModuleNameForFolderDocument
};
