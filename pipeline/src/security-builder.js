const { parseSpecs } = require("./lib/pack-merger");
const { normalizeNavigationConfig } = require("./lib/navigation-contract");

function requireSdkPackage(pkgName) {
  return require(pkgName);
}

function loadModelNamespaces() {
  const sdk = requireSdkPackage("mendixmodelsdk");
  return {
    security: sdk.security,
    settings: sdk.settings
  };
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

function safeGet(getter, fallback = null) {
  try {
    return getter();
  } catch (_err) {
    return fallback;
  }
}

function toUniqueStrings(values = []) {
  return [...new Set(values.map((v) => String(v || "").trim()).filter(Boolean))];
}

async function findModule(model, moduleName) {
  const moduleIface =
    typeof model.allModules === "function"
      ? model.allModules().find((m) => m && m.name === moduleName)
      : null;
  if (!moduleIface) return null;
  return typeof moduleIface.load === "function" ? moduleIface.load() : moduleIface;
}

async function findOrCreateProjectSecurity(model, security) {
  const existingIface =
    typeof model.allProjectSecurities === "function" ? model.allProjectSecurities()[0] || null : null;

  if (existingIface) {
    return typeof existingIface.load === "function" ? existingIface.load() : existingIface;
  }

  if (!security || !security.ProjectSecurity || typeof security.ProjectSecurity.createIn !== "function") {
    throw new Error("ProjectSecurity.createIn is unavailable in this SDK version.");
  }

  const projectIface = typeof model.allProjects === "function" ? model.allProjects()[0] || null : null;
  if (!projectIface) {
    throw new Error("Could not create project security: no project found in model.");
  }

  const project = typeof projectIface.load === "function" ? await projectIface.load() : projectIface;
  return security.ProjectSecurity.createIn(project);
}

async function findOrCreateProjectSettings(model, settings) {
  const existingIface =
    typeof model.allProjectSettings === "function" ? model.allProjectSettings()[0] || null : null;

  if (existingIface) {
    return typeof existingIface.load === "function" ? existingIface.load() : existingIface;
  }

  if (!settings || !settings.ProjectSettings || typeof settings.ProjectSettings.createIn !== "function") {
    throw new Error("ProjectSettings.createIn is unavailable in this SDK version.");
  }

  const projectIface = typeof model.allProjects === "function" ? model.allProjects()[0] || null : null;
  if (!projectIface) {
    throw new Error("Could not create project settings: no project found in model.");
  }

  const project = typeof projectIface.load === "function" ? await projectIface.load() : projectIface;
  return settings.ProjectSettings.createIn(project);
}

function findProjectSettingsPart(projectSettings, ctor) {
  const parts = Array.isArray(projectSettings && projectSettings.settingsParts) ? projectSettings.settingsParts : [];
  return parts.find((part) => part instanceof ctor) || null;
}

async function ensureDefaultProjectLanguage(model, settings) {
  if (!settings || !settings.LanguageSettings || !settings.Language) return null;

  const projectSettings = await findOrCreateProjectSettings(model, settings);
  let languageSettings = findProjectSettingsPart(projectSettings, settings.LanguageSettings);
  if (!languageSettings) {
    if (typeof settings.LanguageSettings.createIn !== "function") {
      throw new Error("LanguageSettings.createIn is unavailable in this SDK version.");
    }
    languageSettings = settings.LanguageSettings.createIn(projectSettings);
  }

  const languages = Array.isArray(languageSettings.languages) ? languageSettings.languages : [];
  let defaultLanguage = languages.find((language) => String(language && language.code || "").trim() === "en_US") || null;
  if (!defaultLanguage) {
    defaultLanguage = languages[0] || null;
  }

  if (!defaultLanguage) {
    if (typeof settings.Language.createIn !== "function") {
      throw new Error("Language.createIn is unavailable in this SDK version.");
    }
    defaultLanguage = settings.Language.createIn(languageSettings);
    defaultLanguage.code = "en_US";
  }

  if ("defaultLanguageCode" in languageSettings) {
    languageSettings.defaultLanguageCode = String(defaultLanguage.code || "en_US").trim() || "en_US";
  }

  return languageSettings;
}

async function findOrCreateModuleSecurity(module, security) {
  if (!module) return null;

  let moduleSecurity = module.moduleSecurity || null;
  if (moduleSecurity && typeof moduleSecurity.load === "function") {
    moduleSecurity = await moduleSecurity.load();
  }

  if (!moduleSecurity) {
    if (!security || !security.ModuleSecurity || typeof security.ModuleSecurity.createIn !== "function") {
      throw new Error("ModuleSecurity.createIn is unavailable in this SDK version.");
    }
    moduleSecurity = security.ModuleSecurity.createIn(module);
  }

  return moduleSecurity;
}

function normalizeRoleSpecs(rawRoles = []) {
  const names = [];
  for (const role of rawRoles || []) {
    if (typeof role === "string") {
      const trimmed = role.trim();
      if (trimmed) names.push(trimmed);
      continue;
    }
    if (role && typeof role === "object" && typeof role.name === "string") {
      const trimmed = role.name.trim();
      if (trimmed) names.push(trimmed);
    }
  }
  return toUniqueStrings(names);
}

function collectRoleNamesFromUserRoles(userRoleSpecs = [], moduleName = "") {
  const out = [];
  for (const spec of userRoleSpecs || []) {
    const refs = Array.isArray(spec && spec.moduleRoles) ? spec.moduleRoles : [];
    for (const rawRef of refs) {
      const ref = String(rawRef || "").trim();
      if (!ref) continue;
      if (ref.includes(".")) {
        const [mod, name] = ref.split(".");
        if (mod === moduleName && name) out.push(name);
      } else {
        out.push(ref);
      }
    }
  }
  return toUniqueStrings(out);
}

function resolveModuleRoleReference({ model, moduleName, moduleRolesByName, rawRef }) {
  const ref = String(rawRef || "").trim();
  if (!ref) return null;

  if (!ref.includes(".") && moduleRolesByName.has(ref)) {
    return moduleRolesByName.get(ref);
  }

  if (typeof model.findModuleRoleByQualifiedName === "function") {
    if (ref.includes(".")) {
      const byQname = model.findModuleRoleByQualifiedName(ref);
      if (byQname) return byQname;
    }
    const inModule = model.findModuleRoleByQualifiedName(`${moduleName}.${ref}`);
    if (inModule) return inModule;
  }

  return moduleRolesByName.get(ref.includes(".") ? ref.split(".").pop() : ref) || null;
}

function getModuleRoleQualifiedName(role) {
  if (!role) return "";
  const qnameValue = safeGet(() => role.qualifiedName, null);
  if (typeof qnameValue === "string" && qnameValue) return qnameValue;
  if (typeof qnameValue === "function") {
    const computed = safeGet(() => qnameValue.call(role), null);
    if (typeof computed === "string" && computed) return computed;
  }

  const roleName = String(safeGet(() => role.name, "") || "").trim();
  const moduleName = String(
    safeGet(() => role.containerAsModuleSecurity.containerAsModule.name, "") ||
      safeGet(() => role.containerAsModuleRole.containerAsModule.name, "") ||
      ""
  ).trim();
  if (roleName && moduleName) {
    return `${moduleName}.${roleName}`;
  }
  return roleName || "";
}

function isLikelySystemModuleRole(role) {
  if (!role) return false;
  const qname = getModuleRoleQualifiedName(role);
  if (qname && qname.startsWith("System.")) return true;
  const moduleName = qname.includes(".") ? qname.split(".")[0] : "";
  if (moduleName === "System") return true;
  const explicitModuleName = String(
    safeGet(() => role.containerAsModuleSecurity.containerAsModule.name, "") ||
      safeGet(() => role.containerAsModuleRole.containerAsModule.name, "") ||
      ""
  ).trim();
  return explicitModuleName === "System";
}

function getUserRoleName(userRole) {
  return String(safeGet(() => userRole.name, "") || "").trim();
}

function normalizeRoleName(value) {
  return String(value || "").trim().toLowerCase();
}

function getDefaultBuiltInSourceUserRoleName(targetUserRoleName) {
  const normalized = normalizeRoleName(targetUserRoleName);
  if (!normalized || normalized === "user" || normalized === "administrator") {
    return "";
  }
  return "User";
}

function getDefaultSystemModuleRoleQname(targetUserRoleName) {
  const normalized = normalizeRoleName(targetUserRoleName);
  if (normalized === "manager") return "System.User";
  if (normalized === "employee") return "System.User";
  return "";
}

function parseQualifiedName(qname) {
  const raw = String(qname || "").trim();
  if (!raw || !raw.includes(".")) {
    return { moduleName: "", roleName: raw };
  }
  const firstDot = raw.indexOf(".");
  return {
    moduleName: raw.slice(0, firstDot),
    roleName: raw.slice(firstDot + 1)
  };
}

async function materializeElement(element) {
  if (!element) return null;
  if (typeof element.load === "function") {
    try {
      return await element.load();
    } catch (_err) {
      return element;
    }
  }
  return element;
}

function dedupeRolesByIdentity(roles = []) {
  const seen = new Set();
  const out = [];
  for (const role of roles) {
    if (!role) continue;
    const key =
      String(safeGet(() => role.id, "") || "").trim() ||
      getModuleRoleQualifiedName(role) ||
      String(safeGet(() => role.name, "") || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(role);
  }
  return out;
}

function getModuleRoleIdentity(role) {
  if (!role) return "";
  return (
    String(safeGet(() => role.id, "") || "").trim() ||
    getModuleRoleQualifiedName(role) ||
    String(safeGet(() => role.name, "") || "").trim()
  );
}

function hasModuleRoleReference(moduleRoles, candidateRole) {
  const candidateKey = getModuleRoleIdentity(candidateRole);
  if (!candidateKey) return false;
  for (const role of moduleRoles || []) {
    if (getModuleRoleIdentity(role) === candidateKey) return true;
  }
  return false;
}

function appendModuleRoleIfMissing(moduleRoles, role) {
  if (!moduleRoles || !role) return;
  if (hasModuleRoleReference(moduleRoles, role)) return;
  moduleRoles.push(role);
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

function appendByNameReferenceListQualifiedName(owner, propertyName, qualifiedName) {
  const qname = String(qualifiedName || "").trim();
  if (!qname) return false;
  const current = getByNameReferenceListQualifiedNames(owner, propertyName);
  if (current.includes(qname)) return true;
  return replaceByNameReferenceListQualifiedNames(owner, propertyName, [...current, qname]);
}

function appendModuleRoleQualifiedNameIfPossible(userRole, qualifiedName) {
  return appendByNameReferenceListQualifiedName(userRole, "__moduleRoles", qualifiedName);
}

function replaceModuleRoleQualifiedNamesIfPossible(userRole, qualifiedNames) {
  return replaceByNameReferenceListQualifiedNames(userRole, "__moduleRoles", qualifiedNames);
}

function readModuleRoleQualifiedNames(userRole) {
  const rawQualifiedNames = getByNameReferenceListQualifiedNames(userRole, "__moduleRoles");
  if (rawQualifiedNames.length > 0) return rawQualifiedNames;
  return toUniqueStrings(
    (Array.isArray(userRole && userRole.moduleRoles) ? userRole.moduleRoles : [])
      .map((role) => getModuleRoleQualifiedName(role))
      .filter(Boolean)
  );
}

function getUserRoleQualifiedName(userRole) {
  return String(safeGet(() => userRole.qualifiedName, "") || getUserRoleName(userRole)).trim();
}

function appendUserRoleQualifiedNameIfPossible(demoUser, qualifiedName) {
  return appendByNameReferenceListQualifiedName(demoUser, "__userRoles", qualifiedName);
}

function replaceDemoUserRoleQualifiedNamesIfPossible(demoUser, qualifiedNames) {
  return replaceByNameReferenceListQualifiedNames(demoUser, "__userRoles", qualifiedNames);
}

async function collectBuiltInUserRoleModuleRoles(projectSecurity) {
  const out = [];
  const builtInNames = new Set(["user", "administrator"]);
  const userRoles = Array.isArray(projectSecurity && projectSecurity.userRoles) ? projectSecurity.userRoles : [];
  for (const userRole of userRoles) {
    const lowerName = getUserRoleName(userRole).toLowerCase();
    if (!builtInNames.has(lowerName)) continue;

    const moduleRoles = Array.isArray(userRole && userRole.moduleRoles) ? userRole.moduleRoles : [];
    for (const moduleRole of moduleRoles) {
      const loaded = await materializeElement(moduleRole);
      if (loaded) out.push(loaded);
    }
  }
  return dedupeRolesByIdentity(out);
}

function collectProjectUserRolesByLowerName(projectSecurity) {
  const map = new Map();
  const userRoles = Array.isArray(projectSecurity && projectSecurity.userRoles) ? projectSecurity.userRoles : [];
  for (const userRole of userRoles) {
    const name = getUserRoleName(userRole);
    if (!name) continue;
    map.set(name.toLowerCase(), userRole);
  }
  return map;
}

function isBuiltInProjectUserRoleName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return normalized === "user" || normalized === "administrator";
}

async function resolveModuleRoleReferenceFlexible({ model, moduleName, moduleRolesByName, rawRef }) {
  const direct = resolveModuleRoleReference({ model, moduleName, moduleRolesByName, rawRef });
  if (direct) {
    const loaded = await materializeElement(direct);
    if (loaded) return loaded;
  }

  const ref = String(rawRef || "").trim();
  if (!ref) return null;
  const targetQname = ref.includes(".") ? ref : `${moduleName}.${ref}`;
  const targetName = ref.includes(".") ? ref.split(".").pop() : ref;
  const targetModule = ref.includes(".") ? ref.split(".")[0] : moduleName;

  if (typeof model.allModuleRoles !== "function") return null;
  const roleIfaces = Array.isArray(model.allModuleRoles()) ? model.allModuleRoles() : [];
  for (const roleIface of roleIfaces) {
    const role = await materializeElement(roleIface);
    if (!role) continue;

    const qname = getModuleRoleQualifiedName(role);
    if (qname === targetQname || qname === ref) return role;

    const roleName = String(role.name || "").trim();
    const moduleOfRole = qname.includes(".") ? qname.split(".")[0] : "";
    if (roleName === targetName && moduleOfRole === targetModule) return role;
  }

  return null;
}

async function resolveExactModuleRoleByQname({ model, qname }) {
  const targetQname = String(qname || "").trim();
  if (!targetQname || !targetQname.includes(".")) return null;

  if (typeof model.findModuleRoleByQualifiedName === "function") {
    const found = model.findModuleRoleByQualifiedName(targetQname);
    if (found) {
      const loaded = await materializeElement(found);
      if (loaded) return loaded;
    }
  }

  if (typeof model.allModuleRoles !== "function") return null;
  const target = parseQualifiedName(targetQname);
  const roleIfaces = Array.isArray(model.allModuleRoles()) ? model.allModuleRoles() : [];
  for (const roleIface of roleIfaces) {
    const role = await materializeElement(roleIface);
    if (!role) continue;

    const roleQname = getModuleRoleQualifiedName(role);
    if (roleQname === targetQname) return role;

    const roleName = String(safeGet(() => role.name, "") || "").trim();
    const roleModule =
      String(
        safeGet(() => role.containerAsModuleSecurity.containerAsModule.name, "") ||
          safeGet(() => role.containerAsModuleRole.containerAsModule.name, "") ||
          (roleQname.includes(".") ? roleQname.split(".")[0] : "") ||
          ""
      ).trim();
    if (roleModule === target.moduleName && roleName === target.roleName) {
      return role;
    }
  }

  return null;
}

async function collectUserRoleModuleRolesByName(projectSecurity, userRoleName) {
  const targetName = String(userRoleName || "").trim().toLowerCase();
  if (!targetName) return [];
  const userRoles = Array.isArray(projectSecurity && projectSecurity.userRoles) ? projectSecurity.userRoles : [];
  const out = [];
  for (const userRole of userRoles) {
    if (getUserRoleName(userRole).toLowerCase() !== targetName) continue;
    for (const moduleRole of Array.isArray(userRole && userRole.moduleRoles) ? userRole.moduleRoles : []) {
      const loaded = await materializeElement(moduleRole);
      if (loaded) out.push(loaded);
    }
  }
  return dedupeRolesByIdentity(out);
}

async function appendModuleRolesFromProjectUserRole({ projectSecurity, userRole, sourceUserRoleName }) {
  const sourceName = String(sourceUserRoleName || "").trim();
  if (!sourceName || !userRole) return 0;
  const projectUserRoles = Array.isArray(projectSecurity && projectSecurity.userRoles) ? projectSecurity.userRoles : [];
  const sourceUserRole =
    projectUserRoles.find((candidate) => getUserRoleName(candidate).toLowerCase() === sourceName.toLowerCase()) || null;
  const sourceQualifiedNames = toUniqueStrings(
    Array.isArray(sourceUserRole && sourceUserRole.moduleRolesQualifiedNames)
      ? sourceUserRole.moduleRolesQualifiedNames
      : []
  );
  let appended = 0;
  if (sourceQualifiedNames.length > 0) {
    const before = readModuleRoleQualifiedNames(userRole);
    const merged = toUniqueStrings([...before, ...sourceQualifiedNames]);
    if (replaceModuleRoleQualifiedNamesIfPossible(userRole, merged)) {
      return Math.max(0, merged.length - before.length);
    }
  }

  const sourceModuleRoles = Array.isArray(sourceUserRole && sourceUserRole.moduleRoles) ? sourceUserRole.moduleRoles : [];
  for (const sourceModuleRole of sourceModuleRoles) {
    if (!sourceModuleRole) continue;
    const before = Array.isArray(userRole.moduleRoles) ? userRole.moduleRoles.length : 0;
    appendModuleRoleIfMissing(userRole.moduleRoles, sourceModuleRole);
    const after = Array.isArray(userRole.moduleRoles) ? userRole.moduleRoles.length : before;
    if (after > before) appended += 1;
  }
  if (appended > 0) return appended;

  const materializedSourceRoles = await collectUserRoleModuleRolesByName(projectSecurity, sourceName);
  for (const sourceModuleRole of materializedSourceRoles) {
    if (!sourceModuleRole) continue;
    const before = Array.isArray(userRole.moduleRoles) ? userRole.moduleRoles.length : 0;
    appendModuleRoleIfMissing(userRole.moduleRoles, sourceModuleRole);
    const after = Array.isArray(userRole.moduleRoles) ? userRole.moduleRoles.length : before;
    if (after > before) appended += 1;
  }
  return appended;
}

function matchesRequestedSystemModuleRole(role, targetQname) {
  const target = parseQualifiedName(targetQname);
  if (!target.moduleName || !target.roleName) return false;
  if (!isLikelySystemModuleRole(role)) return false;

  const roleQname = getModuleRoleQualifiedName(role);
  if (roleQname === targetQname) return true;

  const roleName = String(safeGet(() => role.name, "") || "").trim();
  return roleName.toLowerCase() === target.roleName.toLowerCase();
}

function isOpaqueSystemModuleRolePlaceholder(role) {
  if (!role) return false;
  const qname = String(getModuleRoleQualifiedName(role) || "").trim();
  const roleName = String(safeGet(() => role.name, "") || "").trim();
  const moduleName = String(
    safeGet(() => role.containerAsModuleSecurity.containerAsModule.name, "") ||
      safeGet(() => role.containerAsModuleRole.containerAsModule.name, "") ||
      ""
  ).trim();
  return !qname && !roleName && !moduleName;
}

async function resolveRequestedSystemModuleRole({ model, projectSecurity, qname }) {
  const targetQname = String(qname || "").trim();
  if (!targetQname) return null;

  const exact = await resolveExactModuleRoleByQname({ model, qname: targetQname });
  if (exact) return exact;

  const target = parseQualifiedName(targetQname);
  if (target.moduleName !== "System" || !target.roleName) return null;

  const builtInRoleSeeds = await collectUserRoleModuleRolesByName(projectSecurity, target.roleName);
  const seededMatch = builtInRoleSeeds.find((role) => matchesRequestedSystemModuleRole(role, targetQname));
  if (seededMatch) return seededMatch;
  const opaqueSeed = builtInRoleSeeds.find((role) => isOpaqueSystemModuleRolePlaceholder(role));
  if (opaqueSeed) return opaqueSeed;

  if (typeof model.allModuleRoles !== "function") {
    return builtInRoleSeeds.find((role) => isLikelySystemModuleRole(role)) || null;
  }

  const roleIfaces = Array.isArray(model.allModuleRoles()) ? model.allModuleRoles() : [];
  for (const roleIface of roleIfaces) {
    const role = await materializeElement(roleIface);
    if (matchesRequestedSystemModuleRole(role, targetQname)) return role;
  }

  return builtInRoleSeeds.find((role) => isLikelySystemModuleRole(role)) || null;
}

async function appendRequestedSystemModuleRole({
  model,
  projectSecurity,
  userRole,
  requestedQname,
  explicitSourceUserRoleName = ""
}) {
  const targetQname = String(requestedQname || "").trim();
  if (!targetQname) return { assigned: false, inheritedCount: 0, resolvedExact: false };

  const preferredSourceRoleName = String(explicitSourceUserRoleName || "").trim();

  let inheritedCount = 0;
  if (preferredSourceRoleName) {
    inheritedCount = await appendModuleRolesFromProjectUserRole({
      projectSecurity,
      userRole,
      sourceUserRoleName: preferredSourceRoleName
    });
  }

  const requestedSystemRole = await resolveRequestedSystemModuleRole({
    model,
    projectSecurity,
    qname: targetQname
  });
  if (requestedSystemRole) {
    const resolvedQualifiedName = getModuleRoleQualifiedName(requestedSystemRole) || targetQname;
    if (!appendModuleRoleQualifiedNameIfPossible(userRole, resolvedQualifiedName)) {
      appendModuleRoleIfMissing(userRole.moduleRoles, requestedSystemRole);
    }
  }

  const wroteQualifiedName = appendModuleRoleQualifiedNameIfPossible(userRole, targetQname);

  return {
    assigned: Boolean(requestedSystemRole) || inheritedCount > 0 || wroteQualifiedName,
    inheritedCount,
    resolvedExact: Boolean(requestedSystemRole) || wroteQualifiedName
  };
}

async function hasRequestedSystemModuleRoleAssignment({ assignedRoles, assignedQualifiedNames = [], projectSecurity, requestedQname }) {
  const targetQname = String(requestedQname || "").trim();
  if (!targetQname) return false;
  const assignedRoleList = Array.isArray(assignedRoles) ? assignedRoles : [];
  const assignedQualifiedNameList = toUniqueStrings(assignedQualifiedNames);

  if (assignedQualifiedNameList.includes(targetQname)) {
    return true;
  }

  const target = parseQualifiedName(targetQname);
  if (
    assignedQualifiedNameList.some((qualifiedName) => {
      const parsed = parseQualifiedName(qualifiedName);
      return parsed.moduleName === target.moduleName && parsed.roleName.toLowerCase() === target.roleName.toLowerCase();
    })
  ) {
    return true;
  }

  if (assignedRoleList.some((role) => matchesRequestedSystemModuleRole(role, targetQname))) {
    return true;
  }

  if (target.moduleName !== "System" || !target.roleName) return false;

  const builtInRoleSeeds = await collectUserRoleModuleRolesByName(projectSecurity, target.roleName);
  const opaqueSeeds = builtInRoleSeeds.filter((role) => isOpaqueSystemModuleRolePlaceholder(role));
  if (assignedRoleList.some((role) => isOpaqueSystemModuleRolePlaceholder(role))) {
    return true;
  }

  const assignedIds = new Set(assignedRoleList.map((role) => getModuleRoleIdentity(role)).filter(Boolean));
  if (opaqueSeeds.some((role) => assignedIds.has(getModuleRoleIdentity(role)))) {
    return true;
  }

  const builtInSeedIds = new Set(builtInRoleSeeds.map((role) => getModuleRoleIdentity(role)).filter(Boolean));
  if (builtInSeedIds.size === 0) return false;

  // Fresh Mendix apps often expose the effective built-in security baseline
  // only through the project "User"/"Administrator" role assignments rather
  // than a resolvable System.* module role. Treat inherited built-in seeds as valid.
  return assignedRoleList.some((role) => builtInSeedIds.has(getModuleRoleIdentity(role)));
}

function hasExactModuleRole(moduleRoles, targetQname) {
  const target = String(targetQname || "").trim();
  if (!target) return false;
  for (const role of moduleRoles || []) {
    if (getModuleRoleQualifiedName(role) === target) return true;
  }
  return false;
}

async function collectSystemModuleRoleHints(model) {
  if (typeof model.allModuleRoles !== "function") return [];
  const roleIfaces = Array.isArray(model.allModuleRoles()) ? model.allModuleRoles() : [];
  const hints = [];
  for (const roleIface of roleIfaces) {
    const role = await materializeElement(roleIface);
    if (!role) continue;
    if (!isLikelySystemModuleRole(role)) continue;
    const qname = getModuleRoleQualifiedName(role) || String(safeGet(() => role.name, "") || "").trim();
    if (qname) hints.push(qname);
  }
  return toUniqueStrings(hints);
}

function pickPreferredSystemRole(candidates = []) {
  const preferredQnames = ["System.User", "System.Administrator"];
  for (const qname of preferredQnames) {
    const exact = candidates.find((role) => getModuleRoleQualifiedName(role) === qname);
    if (exact) return exact;
  }

  const preferredNames = ["user", "administrator"];
  for (const roleName of preferredNames) {
    const byName = candidates.find((role) => String(role && role.name || "").trim().toLowerCase() === roleName);
    if (byName) return byName;
  }

  return candidates.find((role) => isLikelySystemModuleRole(role)) || null;
}

async function resolveSystemDefaultModuleRole({ model, projectSecurity }) {
  const preferredQnames = ["System.User", "System.Administrator"];

  if (typeof model.findModuleRoleByQualifiedName === "function") {
    for (const qname of preferredQnames) {
      const role = model.findModuleRoleByQualifiedName(qname);
      if (role) {
        const loaded = await materializeElement(role);
        if (loaded) return loaded;
      }
    }
  }

  const candidates = [];

  if (typeof model.allModuleRoles === "function" && Array.isArray(model.allModuleRoles())) {
    for (const roleIface of model.allModuleRoles()) {
      const role = await materializeElement(roleIface);
      if (role) candidates.push(role);
    }
  }

  for (const userRole of projectSecurity && projectSecurity.userRoles ? projectSecurity.userRoles : []) {
    const moduleRoles = Array.isArray(userRole && userRole.moduleRoles) ? userRole.moduleRoles : [];
    for (const moduleRole of moduleRoles) {
      const loaded = await materializeElement(moduleRole);
      if (loaded) candidates.push(loaded);
    }
  }

  const preferred = pickPreferredSystemRole(candidates);
  if (preferred) return preferred;

  for (const userRole of projectSecurity && projectSecurity.userRoles ? projectSecurity.userRoles : []) {
    const roleName = String(userRole && userRole.name || "").trim().toLowerCase();
    if (roleName !== "user" && roleName !== "administrator") continue;
    const moduleRoles = Array.isArray(userRole && userRole.moduleRoles) ? userRole.moduleRoles : [];
    if (moduleRoles.length > 0) {
      const first = await materializeElement(moduleRoles[0]);
      if (first) return first;
    }
  }

  return null;
}

function resolveUserRoleReference({ model, userRolesByName, rawRef }) {
  const ref = String(rawRef || "").trim();
  if (!ref) return null;

  if (!ref.includes(".") && userRolesByName.has(ref)) {
    return userRolesByName.get(ref);
  }

  if (typeof model.findUserRoleByQualifiedName === "function" && ref.includes(".")) {
    const byQname = model.findUserRoleByQualifiedName(ref);
    if (byQname) return byQname;
  }

  return userRolesByName.get(ref.includes(".") ? ref.split(".").pop() : ref) || null;
}

function resolveEntityReference(model, moduleName, rawEntityRef) {
  if (!rawEntityRef) return null;
  const raw = String(rawEntityRef).trim();
  if (!raw) return null;

  if (typeof model.findEntityByQualifiedName !== "function") return null;

  if (raw.includes(".")) {
    return model.findEntityByQualifiedName(raw);
  }

  return model.findEntityByQualifiedName(`${moduleName}.${raw}`);
}

function resolveSecurityLevel(security, rawLevel) {
  if (!security || !security.SecurityLevel) return null;
  const raw = String(rawLevel || "").trim().toLowerCase();
  if (!raw) return null;

  if (raw === "none" || raw === "off" || raw === "checknothing") {
    return security.SecurityLevel.CheckNothing;
  }
  if (
    raw === "prototype" ||
    raw === "checkformsandmicroflows" ||
    raw === "check_forms_and_microflows" ||
    raw === "forms"
  ) {
    return security.SecurityLevel.CheckFormsAndMicroflows;
  }
  if (
    raw === "production" ||
    raw === "checkeverything" ||
    raw === "check_everything" ||
    raw === "prod" ||
    raw === "live" ||
    raw === "strict" ||
    raw === "full"
  ) {
    return security.SecurityLevel.CheckFormsAndMicroflows;
  }

  return null;
}

function toSpecArray(section) {
  if (Array.isArray(section)) return section;
  return [];
}

function normalizeRoleRefToLocalName(rawRef, moduleName) {
  const ref = String(rawRef || "").trim();
  if (!ref) return "";
  if (!ref.includes(".")) return ref;
  const [refModule, roleName] = ref.split(".");
  if (refModule && refModule !== moduleName) return "";
  return roleName || "";
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
      const normalized = String(ref || "").trim();
      if (normalized) out.push(normalized.includes(".") ? normalized.split(".").pop() : normalized);
    }

    for (const outcome of Array.isArray(step.outcomes) ? step.outcomes : []) {
      collectWorkflowUserRoleRefs(outcome && outcome.steps, out);
    }
  }
  return out;
}

function collectInferredSecurityContract({ plan = {}, moduleName = "" }) {
  const moduleRoles = [];
  const userRoles = [];

  for (const page of parseSpecs(plan.pages)) {
    for (const rawRef of Array.isArray(page && page.allowedRoles) ? page.allowedRoles : []) {
      const localName = normalizeRoleRefToLocalName(rawRef, moduleName);
      if (localName) moduleRoles.push(localName);
    }
  }

  const navigation = normalizeNavigationConfig(plan.app && plan.app.navigation ? plan.app.navigation : {});
  for (const entry of [...(navigation.homePageButtons || []), ...(navigation.menuItems || [])]) {
    for (const rawRef of Array.isArray(entry && entry.allowedRoles) ? entry.allowedRoles : []) {
      const localName = normalizeRoleRefToLocalName(rawRef, moduleName);
      if (localName) moduleRoles.push(localName);
    }
  }

  for (const workflow of parseSpecs(plan.workflows)) {
    collectWorkflowUserRoleRefs(workflow && workflow.steps, userRoles);
  }

  const securityPlan = plan.security || {};
  for (const demoUser of Array.isArray(securityPlan.demoUsers) ? securityPlan.demoUsers : []) {
    for (const rawRef of Array.isArray(demoUser && demoUser.userRoles) ? demoUser.userRoles : []) {
      const name = String(rawRef || "").trim();
      if (name) userRoles.push(name.includes(".") ? name.split(".").pop() : name);
    }
  }

  return {
    moduleRoles: toUniqueStrings(moduleRoles),
    userRoles: toUniqueStrings(userRoles)
  };
}

async function applySecurityPlanToModel({
  model,
  moduleName = "MyFirstModule",
  securityPlan = {},
  plan = null
}) {
  const { security, settings } = loadModelNamespaces();

  const module = await findModule(model, moduleName);
  if (!module) {
    throw new Error(`Module "${moduleName}" not found for security generation.`);
  }

  await ensureDefaultProjectLanguage(model, settings);

  const projectSecurity = await findOrCreateProjectSecurity(model, security);
  const moduleSecurity = await findOrCreateModuleSecurity(module, security);

  const inferredContract = collectInferredSecurityContract({
    plan: plan || { security: securityPlan },
    moduleName
  });

  const moduleRoleSpecs = normalizeRoleSpecs([
    ...(Array.isArray(securityPlan.moduleRoles) ? securityPlan.moduleRoles : []),
    ...inferredContract.moduleRoles
  ]);
  const userRoleSpecs = [
    ...toSpecArray(securityPlan.userRoles || []).map((spec) => ({ ...spec })),
    ...inferredContract.userRoles
      .filter(
        (roleName) =>
          !toSpecArray(securityPlan.userRoles || []).some(
            (spec) => spec && String(spec.name || "").trim().toLowerCase() === roleName.toLowerCase()
          )
      )
      .map((roleName) => ({
        name: roleName,
        moduleRoles: [roleName]
      }))
  ];
  const requestedDemoUserSpecs = toSpecArray(securityPlan.demoUsers || []);
  const demoUserSpecs = [];

  const clearExisting = securityPlan.clearExisting === true;
  const clearExistingModuleRoles =
    securityPlan.clearExistingModuleRoles === true || (clearExisting && securityPlan.moduleRoles !== undefined);
  const clearExistingUserRoles =
    securityPlan.clearExistingUserRoles === true || (clearExisting && securityPlan.userRoles !== undefined);
  const clearExistingDemoUsers = false;

  const roleNamesFromUserRoles = collectRoleNamesFromUserRoles(userRoleSpecs, moduleName);
  const allRequestedModuleRoleNames = toUniqueStrings([...moduleRoleSpecs, ...roleNamesFromUserRoles]);

  if (clearExistingModuleRoles && moduleSecurity && Array.isArray(moduleSecurity.moduleRoles)) {
    const toDelete = [...moduleSecurity.moduleRoles].filter((r) => allRequestedModuleRoleNames.includes(r.name));
    for (const role of toDelete) role.delete();
  }

  const moduleRolesByName = new Map();
  for (const role of moduleSecurity.moduleRoles || []) {
    if (role && role.name) moduleRolesByName.set(role.name, role);
  }

  const createdModuleRoleNames = [];
  for (const roleName of allRequestedModuleRoleNames) {
    if (moduleRolesByName.has(roleName)) continue;
    if (!security.ModuleRole || typeof security.ModuleRole.createIn !== "function") {
      throw new Error("ModuleRole.createIn is unavailable in this SDK version.");
    }
    const role = security.ModuleRole.createIn(moduleSecurity);
    role.name = roleName;
    moduleRolesByName.set(roleName, role);
    createdModuleRoleNames.push(roleName);
  }

  if (clearExistingUserRoles && Array.isArray(projectSecurity.userRoles)) {
    const names = toUniqueStrings(userRoleSpecs.map((r) => r && r.name));
    const toDelete = [...projectSecurity.userRoles].filter((r) => names.includes(r.name));
    for (const role of toDelete) role.delete();
  }

  const userRolesByName = new Map();
  for (const userRole of projectSecurity.userRoles || []) {
    if (userRole && userRole.name) userRolesByName.set(userRole.name, userRole);
  }
  const projectUserRolesByLowerName = collectProjectUserRolesByLowerName(projectSecurity);

  const createdUserRoleNames = [];
  const builtInUserRoleModuleRoleSeeds = await collectBuiltInUserRoleModuleRoles(projectSecurity);
  for (const spec of userRoleSpecs) {
    if (!spec || typeof spec !== "object" || !spec.name) continue;
    const name = String(spec.name).trim();
    if (!name) continue;

    let userRole = userRolesByName.get(name) || null;
    if (!userRole) {
      if (!security.UserRole || typeof security.UserRole.createIn !== "function") {
        throw new Error("UserRole.createIn is unavailable in this SDK version.");
      }
      userRole = security.UserRole.createIn(projectSecurity);
      userRole.name = name;
      userRolesByName.set(name, userRole);
      createdUserRoleNames.push(name);
    }

    if (typeof spec.description === "string" && "description" in userRole) {
      userRole.description = spec.description;
    }

    const moduleRoleRefs = Array.isArray(spec.moduleRoles) ? spec.moduleRoles : [];
    if (!isBuiltInProjectUserRoleName(name)) {
      if (!replaceModuleRoleQualifiedNamesIfPossible(userRole, [])) {
        clearList(userRole.moduleRoles);
      }
    }
    for (const rawRef of moduleRoleRefs) {
      const moduleRole = await resolveModuleRoleReferenceFlexible({
        model,
        moduleName,
        moduleRolesByName,
        rawRef
      });
      if (!moduleRole) {
        throw new Error(`Could not resolve module role "${rawRef}" for user role "${name}".`);
      }
      const moduleRoleQname = getModuleRoleQualifiedName(moduleRole);
      if (!moduleRoleQname) {
        throw new Error(`Resolved module role "${rawRef}" for user role "${name}" is missing a qualified name.`);
      }
      if (!appendModuleRoleQualifiedNameIfPossible(userRole, moduleRoleQname)) {
        appendModuleRoleIfMissing(userRole.moduleRoles, moduleRole);
      }
    }

    const requestedSystemModuleRoleQname = String(
      spec.systemModuleRole || spec.requiredSystemModuleRole || getDefaultSystemModuleRoleQname(name)
    ).trim();
    if (requestedSystemModuleRoleQname) {
      const fallbackBuiltInRoleName = String(
        spec.systemSourceUserRole || spec.inheritSystemModuleRolesFromUserRole || ""
      ).trim();
      const requestedSystemRole = await resolveRequestedSystemModuleRole({
        model,
        projectSecurity,
        qname: requestedSystemModuleRoleQname
      });
      const assignment = await appendRequestedSystemModuleRole({
        model,
        projectSecurity,
        userRole,
        requestedQname: requestedSystemModuleRoleQname,
        explicitSourceUserRoleName: fallbackBuiltInRoleName
      });
      if (!assignment.assigned && !requestedSystemRole) {
        const systemHints = await collectSystemModuleRoleHints(model);
        throw new Error(
          `Could not resolve required System module role "${requestedSystemModuleRoleQname}" ` +
            `for user role "${name}".` +
            (systemHints.length ? ` Available System module roles: ${systemHints.join(", ")}.` : "")
        );
      }
    }

    const requestedBuiltInSourceRoleName = String(
      spec.systemSourceUserRole ||
        spec.inheritSystemModuleRolesFromUserRole ||
        getDefaultBuiltInSourceUserRoleName(name)
    ).trim();
    if (requestedBuiltInSourceRoleName) {
      await appendModuleRolesFromProjectUserRole({
        projectSecurity,
        userRole,
        sourceUserRoleName: requestedBuiltInSourceRoleName
      });
    }

    const assignedModuleRoleQualifiedNames = readModuleRoleQualifiedNames(userRole);
    const hasSystemModuleRole =
      assignedModuleRoleQualifiedNames.some((qualifiedName) => parseQualifiedName(qualifiedName).moduleName === "System") ||
      (userRole.moduleRoles || []).some((role) => isLikelySystemModuleRole(role));
    if (!hasSystemModuleRole) {
      const systemRole = await resolveSystemDefaultModuleRole({ model, projectSecurity });
      if (systemRole) {
        const systemRoleQname = getModuleRoleQualifiedName(systemRole);
        if (!systemRoleQname || !appendModuleRoleQualifiedNameIfPossible(userRole, systemRoleQname)) {
          appendModuleRoleIfMissing(userRole.moduleRoles, systemRole);
        }
      } else if (builtInUserRoleModuleRoleSeeds.length > 0) {
        // In some apps we cannot reliably identify System module roles via metadata.
        // Reuse built-in project role module-role assignments as a safe baseline.
        for (const seedRole of builtInUserRoleModuleRoleSeeds) {
          const seedRoleQname = getModuleRoleQualifiedName(seedRole);
          if (!seedRoleQname || !appendModuleRoleQualifiedNameIfPossible(userRole, seedRoleQname)) {
            appendModuleRoleIfMissing(userRole.moduleRoles, seedRole);
          }
        }
      } else {
        const availableRoleHints =
          typeof model.allModuleRoles === "function"
            ? model
                .allModuleRoles()
                .map((role) => getModuleRoleQualifiedName(role) || String(role && role.name || "").trim())
                .filter(Boolean)
                .slice(0, 30)
            : [];
        throw new Error(
          `Could not resolve a default System module role for user role "${name}". ` +
            "Expected one of: System.User, System.Administrator." +
            (availableRoleHints.length ? ` Available module roles: ${availableRoleHints.join(", ")}.` : "")
        );
      }
    }

    if (
      requestedSystemModuleRoleQname &&
      !(await hasRequestedSystemModuleRoleAssignment({
        assignedRoles: userRole.moduleRoles || [],
        assignedQualifiedNames: readModuleRoleQualifiedNames(userRole),
        projectSecurity,
        requestedQname: requestedSystemModuleRoleQname
      }))
    ) {
      throw new Error(
        `User role "${name}" is missing required System module role "${requestedSystemModuleRoleQname}" ` +
          "after assignment."
      );
    }
  }

  if (clearExistingDemoUsers && Array.isArray(projectSecurity.demoUsers)) {
    const names = toUniqueStrings(
      demoUserSpecs.map((u) => (u && (u.userName || u.username) ? u.userName || u.username : ""))
    );
    const toDelete = [...projectSecurity.demoUsers].filter((u) => names.includes(u.userName));
    for (const demoUser of toDelete) demoUser.delete();
  }

  const existingDemoUsersByName = new Map();
  for (const demoUser of projectSecurity.demoUsers || []) {
    if (demoUser && demoUser.userName) existingDemoUsersByName.set(demoUser.userName, demoUser);
  }

  const createdDemoUserNames = [];
  for (const spec of demoUserSpecs) {
    if (!spec || typeof spec !== "object") continue;
    const userName = String(spec.userName || spec.username || "").trim();
    if (!userName) {
      throw new Error("Each security.demoUsers entry requires userName (or username).");
    }
    const password = String(spec.password || "").trim();
    if (!password) {
      throw new Error(`Demo user "${userName}" is missing password.`);
    }

    let demoUser = existingDemoUsersByName.get(userName) || null;
    if (!demoUser) {
      if (!security.DemoUser || typeof security.DemoUser.createIn !== "function") {
        throw new Error("DemoUser.createIn is unavailable in this SDK version.");
      }
      demoUser = security.DemoUser.createIn(projectSecurity);
      demoUser.userName = userName;
      existingDemoUsersByName.set(userName, demoUser);
      createdDemoUserNames.push(userName);
    }

    demoUser.password = password;

    const demoUserEntityRef = spec.entityRef || securityPlan.demoUserEntityRef || "Administration.Account";
    const entity = resolveEntityReference(model, moduleName, demoUserEntityRef);
    if (!entity) {
      throw new Error(`Could not resolve demo user entity "${demoUserEntityRef}" for "${userName}".`);
    }
    demoUser.entity = entity;

    if (!replaceDemoUserRoleQualifiedNamesIfPossible(demoUser, [])) {
      clearList(demoUser.userRoles);
    }
    const userRoleRefs = Array.isArray(spec.userRoles) ? spec.userRoles : [];
    for (const rawRef of userRoleRefs) {
      const userRole = resolveUserRoleReference({
        model,
        userRolesByName,
        rawRef
      });
      if (!userRole) {
        throw new Error(`Could not resolve user role "${rawRef}" for demo user "${userName}".`);
      }
      const userRoleQname = getUserRoleQualifiedName(userRole);
      if (!userRoleQname || !appendUserRoleQualifiedNameIfPossible(demoUser, userRoleQname)) {
        demoUser.userRoles.push(userRole);
      }
    }
  }

  const levelCandidate =
    securityPlan.securityLevel ||
    securityPlan.level ||
    (securityPlan.enabled === true ? "prototype" : "");
  const resolvedLevel = resolveSecurityLevel(security, levelCandidate);
  if (resolvedLevel && "securityLevel" in projectSecurity) {
    projectSecurity.securityLevel = resolvedLevel;
  }
  if ("checkSecurity" in projectSecurity && securityPlan.checkSecurity !== undefined) {
    projectSecurity.checkSecurity = Boolean(securityPlan.checkSecurity);
  }

  if (securityPlan.admin && typeof securityPlan.admin === "object") {
    const adminUserName = String(securityPlan.admin.userName || securityPlan.admin.username || "").trim();
    const adminPassword = String(securityPlan.admin.password || "").trim();
    const adminUserRoleName = String(securityPlan.admin.userRole || securityPlan.admin.userRoleName || "").trim();

    if (adminUserName && "adminUserName" in projectSecurity) {
      projectSecurity.adminUserName = adminUserName;
    }
    if (adminPassword && "adminPassword" in projectSecurity) {
      projectSecurity.adminPassword = adminPassword;
    }
    if (adminUserRoleName && "adminUserRoleName" in projectSecurity) {
      projectSecurity.adminUserRoleName = adminUserRoleName;
    }
  }

  const hasDemoUsers = (projectSecurity.demoUsers || []).length > 0;
  if ("enableDemoUsers" in projectSecurity) {
    projectSecurity.enableDemoUsers = false;
  }

  return {
    moduleName,
    securityLevel: String(projectSecurity.securityLevel || ""),
    moduleRolesCreated: createdModuleRoleNames.length,
    userRolesCreated: createdUserRoleNames.length,
    demoUsersRequested: requestedDemoUserSpecs.length,
    demoUsersCreated: createdDemoUserNames.length,
    demoUsersApplied: demoUserSpecs.length,
    demoUserHandling:
      requestedDemoUserSpecs.length > 0
        ? "skipped: demo user creation is disabled by the security builder"
        : "notRequested",
    skippedDemoUsers: requestedDemoUserSpecs.map((spec) => String(spec && (spec.userName || spec.username) || "").trim()).filter(Boolean),
    moduleRoleNames: [...moduleRolesByName.keys()].sort((a, b) => a.localeCompare(b)),
    userRoleNames: [...userRolesByName.keys()].sort((a, b) => a.localeCompare(b)),
    demoUserNames: [...existingDemoUsersByName.keys()].sort((a, b) => a.localeCompare(b))
  };
}

module.exports = {
  applySecurityPlanToModel,
  appendRequestedSystemModuleRole,
  appendModuleRolesFromProjectUserRole,
  getDefaultBuiltInSourceUserRoleName,
  getDefaultSystemModuleRoleQname,
  isBuiltInProjectUserRoleName,
  loadModelNamespaces,
  hasRequestedSystemModuleRoleAssignment,
  isOpaqueSystemModuleRolePlaceholder,
  matchesRequestedSystemModuleRole,
  resolveRequestedSystemModuleRole
};
