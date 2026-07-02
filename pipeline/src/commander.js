const path = require("path");

const { applyDomainModelPlanToModel } = require("./model-builder");
const { applySecurityPlanToModel } = require("./security-builder");
const { applyMicroflowsPlanToModel } = require("./microflow-builder");
const { applyWorkflowsPlanToModel } = require("./workflow-builder");
const { applyPagesPlanToModel } = require("./page-builder");

const { requireSdkPackage, loadPlanFile } = require("./lib/plan-loader");
const { parseSpecs, applyPackRefs } = require("./lib/pack-merger");
const { applyPersonaScaffoldingToPages } = require("./lib/personas");
const { validatePlan, applyReservedWordSanitizationToPlan } = require("./lib/validation");
const { HOME_ICON_NAME, homeIconCode, isHomeIconName } = require("./lib/glyphicons");
const { normalizeNavigationConfig } = require("./lib/navigation-contract");
const { collectModelCapabilitySummary, collectPlanCapabilityRequirements } = require("./lib/app-capabilities");
const {
  buildPlannedPageRefs,
  collectRequestedNames,
  collectModuleRefs,
  verifyRequestedArtifacts,
  verifyPlanSemantics
} = require("./lib/verification");
const { hasAssociationLookupSteps, runGeneratedModuleSemanticChecks } = require("./lib/semantic-checks");
const {
  ERROR_CODES,
  PipelineError,
  wrapStageError,
  formatErrorForDisplay,
  formatPipelineErrorForConsole
} = require("./lib/errors");

const DEFAULT_NAV_ICON_CODE = homeIconCode();

function resolveHomePageQualifiedName({ appSection = {}, moduleName = "", pageRefsByRef = {} }) {
  const app = appSection || {};
  const explicitQname = String(app.homePageQualifiedName || "").trim();
  if (explicitQname) return explicitQname;

  const homeToken = String(app.homePageRef || "").trim();
  if (homeToken) {
    const fromRefs = pageRefsByRef[homeToken] || "";
    if (fromRefs) return fromRefs;
    return homeToken.includes(".") ? homeToken : `${moduleName}.${homeToken}`;
  }

  const homePageName = String(app.homePageName || "").trim();
  if (homePageName) {
    return homePageName.includes(".") ? homePageName : `${moduleName}.${homePageName}`;
  }

  return "";
}

function createTextValue(texts, model, value, languageCode = "en_US") {
  const t = texts.Text.create(model);
  const tr = texts.Translation.create(model);
  tr.languageCode = languageCode;
  tr.text = String(value || "");
  t.translations.push(tr);
  return t;
}

function createClientTemplateValue(pages, texts, model, value, languageCode = "en_US") {
  const template = pages.ClientTemplate.create(model);
  template.template = createTextValue(texts, model, value, languageCode);
  return template;
}

function describeNavigationTarget(ref) {
  const raw = String(ref || "").trim();
  if (!raw) return { caption: "Open", iconCode: DEFAULT_NAV_ICON_CODE };

  const last = raw.includes(".") ? raw.split(".").pop() : raw;
  const withoutSuffix = last
    .replace(/_overview$/i, "")
    .replace(/_detail$/i, "")
    .replace(/_list$/i, "")
    .replace(/_admin$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  const caption = (withoutSuffix || "Open")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return {
    caption,
    iconCode: DEFAULT_NAV_ICON_CODE
  };
}

function normalizeGeneratedAppNamePrefix(prefix = "") {
  const normalized = String(prefix || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized || "newapp";
}

function toAlphabeticSuffix(value) {
  let current = Math.abs(Number(value) || 0) % 26;
  return String.fromCharCode(97 + current);
}

function buildGeneratedAppName({ createAppName = "", createAppNamePrefix = "NewApp", seed = Date.now() }) {
  const explicitName = String(createAppName || "").trim();
  if (explicitName) return explicitName;
  const prefix = normalizeGeneratedAppNamePrefix(createAppNamePrefix);
  const numericSeed = Math.abs(Number(seed) || 0);
  const suffix = numericSeed.toString(36).padStart(6, "0");
  return `${prefix}-${suffix}`;
}

function planRequiresDataGrid2(pagesSection = {}) {
  const pages = parseSpecs(pagesSection);
  let requires = false;

  function walk(steps = []) {
    for (const step of Array.isArray(steps) ? steps : []) {
      if (!step || typeof step !== "object" || requires) continue;
      if (step.type === "dataGrid") {
        const mode = String(step.widgetMode || step.mode || "datagrid2").trim().toLowerCase();
        if (!["classic", "datagrid", "data_grid", "grid"].includes(mode)) {
          requires = true;
          return;
        }
      }
      walk(step.content);
      walk(step.itemContent);
      walk(step.templateContent);
    }
  }

  for (const page of pages) {
    walk(page && page.content);
    if (requires) break;
  }

  return requires;
}

async function assertRequiredPageCapabilities({
  model,
  effectivePlan,
  createApp = false
}) {
  const requirements = collectPlanCapabilityRequirements(effectivePlan);
  const requiresDG2 = requirements.includes("data_grid_2") || planRequiresDataGrid2(effectivePlan.pages || {});
  if (!requiresDG2) return null;

  const capabilities = await collectModelCapabilitySummary(model);
  const hasDataWidgetsModule =
    Array.isArray(capabilities.modules) && capabilities.modules.includes("DataWidgets");
  const hasDG2WidgetFamily =
    Array.isArray(capabilities.widgetFamilies) &&
    (capabilities.widgetFamilies.includes("data_grid_2") || capabilities.widgetFamilies.includes("datawidgets_module"));

  if (hasDataWidgetsModule || hasDG2WidgetFamily) {
    return capabilities;
  }

  const blankAppHint = createApp
    ? "This run created a brand-new app, and blank apps do not include the Marketplace module 'Data Widgets' by default."
    : "The target app does not currently expose the Marketplace module 'Data Widgets'.";

  throw new PipelineError({
    code: ERROR_CODES.SDK_WRITE_ERROR,
    stage: "capabilities",
    message:
      "Plan requires Data Grid 2, but the target app does not support it yet. " +
      `${blankAppHint} Install Marketplace module 'Data Widgets' in the app first, commit it, then rerun this plan.`
  });
}

function normalizeIconCode(icon, fallbackCaption = "") {
  if (icon === undefined || icon === null || icon === "") return null;
  if (typeof icon === "string") {
    return isHomeIconName(icon) ? DEFAULT_NAV_ICON_CODE : null;
  }
  if (icon && typeof icon === "object" && !Array.isArray(icon)) {
    return isHomeIconName(icon.name) ? DEFAULT_NAV_ICON_CODE : null;
  }
  return null;
}

function resolveNavigationEntryMeta(entry = {}) {
  const targetMeta = describeNavigationTarget(entry.pageRef || "");
  return {
    caption: String(entry.caption || "").trim() || targetMeta.caption,
    iconCode: normalizeIconCode(entry.icon, String(entry.caption || "").trim() || targetMeta.caption) || targetMeta.iconCode
  };
}

function normalizeNavigationIconsToHome(plan) {
  const homeIcon = { name: HOME_ICON_NAME };
  const nav = plan && plan.app && plan.app.navigation;
  if (!nav || typeof nav !== "object") return { normalized: 0 };
  let normalized = 0;
  for (const collectionName of ["homePageButtons", "menuItems"]) {
    for (const entry of Array.isArray(nav[collectionName]) ? nav[collectionName] : []) {
      if (!entry || typeof entry !== "object") continue;
      const before = JSON.stringify(entry.icon);
      entry.icon = { ...homeIcon };
      if (before !== JSON.stringify(entry.icon)) normalized += 1;
    }
  }
  return { normalized };
}

function clonePlanForExecution(plan) {
  return JSON.parse(JSON.stringify(plan || {}));
}

function applyMenuItemIcon({ item, pages, iconCode }) {
  if (!item || !pages || !pages.GlyphIcon || typeof pages.GlyphIcon.createInMenuItemUnderIcon !== "function") return false;
  if (!iconCode) return false;
  if (item.icon) return true;
  const icon = pages.GlyphIcon.createInMenuItemUnderIcon(item);
  icon.code = iconCode;
  return true;
}

function applyButtonIcon({ button, pages, iconCode }) {
  if (!button || !pages || !pages.GlyphIcon || typeof pages.GlyphIcon.createInButtonUnderIcon !== "function") return false;
  if (!iconCode) return false;
  if (button.icon) return true;
  const icon = pages.GlyphIcon.createInButtonUnderIcon(button);
  icon.code = iconCode;
  return true;
}

function getModuleRoleQualifiedName(role, moduleName = "") {
  if (!role) return "";
  if (typeof role.qualifiedName === "string" && role.qualifiedName) return role.qualifiedName;
  if (role.name && moduleName) return `${moduleName}.${role.name}`;
  return String(role.name || "").trim();
}

function resolveModuleRolesForNavigation({ model, moduleName, refs = [], availableRoles = [] }) {
  const resolved = [];
  const seen = new Set();

  for (const rawRef of refs) {
    const ref = String(rawRef || "").trim();
    if (!ref) continue;

    let role = null;
    if (ref.includes(".") && typeof model.findModuleRoleByQualifiedName === "function") {
      role = model.findModuleRoleByQualifiedName(ref);
    }
    if (!role && typeof model.findModuleRoleByQualifiedName === "function") {
      role = model.findModuleRoleByQualifiedName(`${moduleName}.${ref}`);
    }
    if (!role) {
      role =
        availableRoles.find((candidate) => getModuleRoleQualifiedName(candidate, moduleName) === ref) ||
        availableRoles.find((candidate) => String(candidate && candidate.name || "").trim() === ref) ||
        null;
    }

    if (!role) continue;
    const key = String(role.id || getModuleRoleQualifiedName(role, moduleName) || role.name || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    resolved.push(role);
  }

  return resolved;
}

function applyConditionalVisibilityToButton({ pages, button, roles = [] }) {
  if (!button || !Array.isArray(roles) || roles.length === 0) return false;
  if (!("conditionalVisibilitySettings" in button)) return false;

  let settings = button.conditionalVisibilitySettings || null;
  if (!settings && pages.ConditionalVisibilitySettings && typeof pages.ConditionalVisibilitySettings.createIn === "function") {
    settings = pages.ConditionalVisibilitySettings.createIn(button);
  }
  if (!settings || !("moduleRoles" in settings)) return false;

  if (typeof settings.moduleRoles.replace === "function") {
    settings.moduleRoles.replace([]);
  } else if (Array.isArray(settings.moduleRoles)) {
    settings.moduleRoles.length = 0;
  }

  for (const role of roles) {
    settings.moduleRoles.push(role);
  }
  return true;
}

function mergeTargetPageAllowedRoles({ targetPage, roles = [] }) {
  if (!targetPage || !Array.isArray(roles) || roles.length === 0) return false;
  if (!("allowedRoles" in targetPage) || !targetPage.allowedRoles) return false;

  const existing = new Set(
    (Array.isArray(targetPage.allowedRoles) ? targetPage.allowedRoles : [])
      .map((role) => String(role && (role.id || role.qualifiedName || role.name) || "").trim())
      .filter(Boolean)
  );

  let changed = false;
  for (const role of roles) {
    const key = String(role && (role.id || role.qualifiedName || role.name) || "").trim();
    if (!key || existing.has(key)) continue;
    targetPage.allowedRoles.push(role);
    existing.add(key);
    changed = true;
  }
  return changed;
}

function buildStageSummary(stage, value) {
  if (value === null || value === undefined) return `${stage} completed`;
  if (typeof value !== "object") return `${stage} completed`;

  const summaryParts = [];
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && /(created|count|updated|deleted)/i.test(key)) {
      summaryParts.push(`${key}=${raw}`);
    }
    if (key === "ok" && typeof raw === "boolean") {
      summaryParts.push(`ok=${raw}`);
    }
    if (key === "enabled" && typeof raw === "boolean") {
      summaryParts.push(`enabled=${raw}`);
    }
  }

  if (summaryParts.length === 0) return `${stage} completed`;
  return summaryParts.join(", ");
}

function buildStageArtifacts(stage, value) {
  const artifacts = [];
  if (!value || typeof value !== "object") return artifacts;

  for (const [key, raw] of Object.entries(value)) {
    if (!raw) continue;
    if (Array.isArray(raw) && /names|paths|refs/i.test(key)) {
      artifacts.push({ key, count: raw.length });
    }
    if (typeof raw === "object" && /refs/i.test(key)) {
      artifacts.push({ key, count: Object.keys(raw).length });
    }
  }

  return artifacts;
}

function normalizeStageResult(stage, value) {
  const warnings =
    value && Array.isArray(value.warnings)
      ? value.warnings.map((w) => String(w))
      : [];

  const errors =
    value && Array.isArray(value.errors)
      ? value.errors.map((message) => ({ code: ERROR_CODES.SDK_WRITE_ERROR, message: String(message) }))
      : [];

  return {
    stage,
    ok: errors.length === 0,
    summary: buildStageSummary(stage, value),
    artifacts: buildStageArtifacts(stage, value),
    warnings,
    errors
  };
}

function normalizeFailedStageResult(stage, err) {
  const message = formatErrorForDisplay(err);
  return {
    stage,
    ok: false,
    summary: message,
    artifacts: [],
    warnings: [],
    errors: [
      {
        code: err && err.code ? err.code : ERROR_CODES.SDK_WRITE_ERROR,
        message
      }
    ]
  };
}

function printCliSummary(result) {
  const stageCount = Array.isArray(result && result.stages) ? result.stages.length : 0;
  const failedStages = Array.isArray(result && result.stages)
    ? result.stages.filter((stage) => stage && stage.ok === false).map((stage) => stage.stage)
    : [];
  const status = result && result.ok ? "OK" : `FAILED${failedStages.length ? ` (${failedStages.join(", ")})` : ""}`;
  const appName =
    String(
      (result && result.appCreatedInfo && result.appCreatedInfo.name) ||
      (result && result.planMeta && result.planMeta.name) ||
      ""
    ).trim() || "-";

  console.log(`app: ${appName}`);
  console.log(`id: ${String((result && result.appId) || "-")}`);
  console.log(`status: ${status}`);
  if (stageCount > 0 && !result.ok) {
    console.log(`stages: ${stageCount}`);
  }
}

async function ensureLegacyWebClientForLookupSteps({ model, pagesSection }) {
  function hasClassicDataGridSteps(steps = []) {
    for (const step of Array.isArray(steps) ? steps : []) {
      if (!step || typeof step !== "object") continue;
      const explicit = String(step.widgetMode || step.mode || "").trim().toLowerCase();
      if (step.type === "dataGrid" && ["classic", "datagrid", "data_grid", "grid"].includes(explicit)) {
        return true;
      }
      if (hasClassicDataGridSteps(step.content) || hasClassicDataGridSteps(step.templateContent) || hasClassicDataGridSteps(step.itemContent)) {
        return true;
      }
    }
    return false;
  }

  const lookupRequested = hasAssociationLookupSteps(pagesSection);
  const classicGridRequested = parseSpecs(pagesSection).some((page) => hasClassicDataGridSteps(page && page.content));
  if (!lookupRequested && !classicGridRequested) {
    return {
      lookupRequested: false,
      classicGridRequested: false,
      updated: false,
      useOptimizedClient: null
    };
  }

  const sdk = requireSdkPackage("mendixmodelsdk");
  const settings = sdk && sdk.settings ? sdk.settings : null;
  if (!settings || !settings.UseOptimizedClient) {
    throw new PipelineError({
      code: ERROR_CODES.SDK_WRITE_ERROR,
      stage: "webClientCompatibility",
      message: "Could not load Settings namespace from Mendix Model SDK."
    });
  }

  if (typeof model.allProjectSettings !== "function") {
    throw new PipelineError({
      code: ERROR_CODES.SDK_WRITE_ERROR,
      stage: "webClientCompatibility",
      message: "Model does not expose project settings; cannot switch web client mode."
    });
  }

  const projectSettingsIfaces = model.allProjectSettings();
  const firstProjectSettings = Array.isArray(projectSettingsIfaces) ? projectSettingsIfaces[0] : null;
  if (!firstProjectSettings) {
    throw new PipelineError({
      code: ERROR_CODES.SDK_WRITE_ERROR,
      stage: "webClientCompatibility",
      message: "Project settings document not found; cannot switch web client mode."
    });
  }

  const projectSettings =
    typeof firstProjectSettings.load === "function" ? await firstProjectSettings.load() : firstProjectSettings;

  let webUiPart = null;
  const parts = Array.isArray(projectSettings.settingsParts)
    ? projectSettings.settingsParts
    : projectSettings.settingsParts && typeof projectSettings.settingsParts.slice === "function"
      ? projectSettings.settingsParts.slice()
      : [];

  for (const part of parts) {
    if (part && part.structureTypeName === "Settings$WebUIProjectSettingsPart") {
      webUiPart = part;
      break;
    }
  }

  if (!webUiPart) {
    if (settings.WebUIProjectSettingsPart && typeof settings.WebUIProjectSettingsPart.createIn === "function") {
      webUiPart = settings.WebUIProjectSettingsPart.createIn(projectSettings);
    } else {
      throw new PipelineError({
        code: ERROR_CODES.SDK_WRITE_ERROR,
        stage: "webClientCompatibility",
        message: "Could not create WebUI project settings part."
      });
    }
  }

  const previous = webUiPart.useOptimizedClient
    ? String(webUiPart.useOptimizedClient.name || webUiPart.useOptimizedClient)
    : null;
  const target = settings.UseOptimizedClient.No;
  const alreadyNo = webUiPart.useOptimizedClient === target || previous === "No";

  if (!alreadyNo) {
    webUiPart.useOptimizedClient = target;
  }

  return {
    lookupRequested: true,
    classicGridRequested,
    updated: !alreadyNo,
    useOptimizedClient: "No",
    previousUseOptimizedClient: previous
  };
}

async function applyHomePagePlanToModel({ model, moduleName, appSection = {}, pageRefsByRef = {} }) {
  const targetQname = resolveHomePageQualifiedName({
    appSection,
    moduleName,
    pageRefsByRef
  });

  if (!targetQname) {
    return {
      requested: false,
      updatedProfiles: 0,
      targetPageQualifiedName: ""
    };
  }

  const pageIface =
    typeof model.findPageByQualifiedName === "function" ? model.findPageByQualifiedName(targetQname) : null;
  if (!pageIface) {
    throw new PipelineError({
      code: ERROR_CODES.REFERENCE_RESOLUTION_ERROR,
      stage: "homePage",
      message: `Could not resolve homepage page "${targetQname}".`
    });
  }
  const targetPage = typeof pageIface.load === "function" ? await pageIface.load() : pageIface;

  const navIfaces = typeof model.allNavigationDocuments === "function" ? model.allNavigationDocuments() : [];
  if (!Array.isArray(navIfaces) || navIfaces.length === 0) {
    throw new PipelineError({
      code: ERROR_CODES.SDK_WRITE_ERROR,
      stage: "homePage",
      message: "No Navigation document found in model; cannot set homepage."
    });
  }

  const sdk = requireSdkPackage("mendixmodelsdk");
  const navigation = sdk && sdk.navigation ? sdk.navigation : null;
  if (!navigation || !navigation.HomePage) {
    throw new PipelineError({
      code: ERROR_CODES.SDK_WRITE_ERROR,
      stage: "homePage",
      message: "Could not load Navigation namespace from Mendix Model SDK."
    });
  }

  let updatedProfiles = 0;
  let webProfilesSeen = 0;

  for (const navIface of navIfaces) {
    const navDoc = typeof navIface.load === "function" ? await navIface.load() : navIface;
    const profiles = Array.isArray(navDoc.profiles)
      ? navDoc.profiles
      : navDoc.profiles && typeof navDoc.profiles.slice === "function"
        ? navDoc.profiles.slice()
        : [];

    for (const profile of profiles) {
      if (!profile || profile.structureTypeName !== "Navigation$NavigationProfile") continue;
      webProfilesSeen += 1;

      let homePage = null;
      try {
        homePage = profile.homePage || null;
      } catch (_err) {
        homePage = null;
      }

      if (!homePage && navigation.HomePage && typeof navigation.HomePage.createIn === "function") {
        homePage = navigation.HomePage.createIn(profile);
      }
      if (!homePage || !("page" in homePage)) continue;

      const previousQname = String(homePage.pageQualifiedName || "").trim();
      if (previousQname === targetQname) continue;

      homePage.page = targetPage;
      updatedProfiles += 1;
    }
  }

  if (webProfilesSeen === 0) {
    throw new PipelineError({
      code: ERROR_CODES.SDK_WRITE_ERROR,
      stage: "homePage",
      message: "No web Navigation profiles found; cannot set homepage."
    });
  }

  return {
    requested: true,
    updatedProfiles,
    targetPageQualifiedName: targetQname
  };
}

async function applyNavigationUiPlanToModel({ model, moduleName, appSection = {}, pageRefsByRef = {} }) {
  const navigationCfg = normalizeNavigationConfig(appSection && appSection.navigation ? appSection.navigation : null);
  if (!navigationCfg || typeof navigationCfg !== "object") {
    return {
      requested: false,
      homeButtonsAdded: 0,
      navItemsAdded: 0
    };
  }

  const homeButtons = Array.isArray(navigationCfg.homePageButtons) ? navigationCfg.homePageButtons : [];
  const menuItems = Array.isArray(navigationCfg.menuItems) ? navigationCfg.menuItems : [];

  if (homeButtons.length === 0 && menuItems.length === 0) {
    return {
      requested: false,
      homeButtonsAdded: 0,
      navItemsAdded: 0
    };
  }

  const sdk = requireSdkPackage("mendixmodelsdk");
  const pages = sdk && sdk.pages ? sdk.pages : null;
  const menus = sdk && sdk.menus ? sdk.menus : null;
  const texts = sdk && sdk.texts ? sdk.texts : null;

  if (!pages || !menus || !texts) {
    throw new PipelineError({
      code: ERROR_CODES.SDK_WRITE_ERROR,
      stage: "navigationUI",
      message: "Could not load pages/menus/texts namespaces from Mendix Model SDK."
    });
  }

  const moduleIface =
    typeof model.allModules === "function" ? model.allModules().find((candidate) => candidate && candidate.name === moduleName) : null;
  const module = moduleIface && typeof moduleIface.load === "function" ? await moduleIface.load() : moduleIface;
  let availableModuleRoles = [];
  if (module && module.moduleSecurity) {
    const moduleSecurity = typeof module.moduleSecurity.load === "function" ? await module.moduleSecurity.load() : module.moduleSecurity;
    availableModuleRoles = Array.isArray(moduleSecurity && moduleSecurity.moduleRoles)
      ? moduleSecurity.moduleRoles
      : moduleSecurity && moduleSecurity.moduleRoles && typeof moduleSecurity.moduleRoles.slice === "function"
        ? moduleSecurity.moduleRoles.slice()
        : [];
  }

  const targetByRef = {};
  function resolveTargetPageByRef(ref) {
    const qname = pageRefsByRef[ref] || (ref.includes(".") ? ref : `${moduleName}.${ref}`);
    if (targetByRef[qname]) return targetByRef[qname];
    const iface = typeof model.findPageByQualifiedName === "function" ? model.findPageByQualifiedName(qname) : null;
    if (!iface) return null;
    targetByRef[qname] = iface;
    return iface;
  }

  let homeButtonsAdded = 0;
  if (homeButtons.length > 0) {
    const homeQname = resolveHomePageQualifiedName({ appSection, moduleName, pageRefsByRef });
    const homeIface = homeQname && typeof model.findPageByQualifiedName === "function" ? model.findPageByQualifiedName(homeQname) : null;
    if (!homeIface) {
      throw new PipelineError({
        code: ERROR_CODES.REFERENCE_RESOLUTION_ERROR,
        stage: "navigationUI",
        message: `Could not resolve homepage page "${homeQname}" for navigation buttons.`
      });
    }

    const homePage = typeof homeIface.load === "function" ? await homeIface.load() : homeIface;
    const mainArg = homePage && homePage.layoutCall && Array.isArray(homePage.layoutCall.arguments)
      ? homePage.layoutCall.arguments[0]
      : null;
    if (!mainArg) {
      throw new PipelineError({
        code: ERROR_CODES.SDK_WRITE_ERROR,
        stage: "navigationUI",
        message: "Homepage has no layout argument container for adding buttons."
      });
    }

    const existingTargets = new Set();
    for (const widget of Array.isArray(mainArg.widgets) ? mainArg.widgets : []) {
      if (!widget || widget.structureTypeName !== "Pages$ActionButton") continue;
      const action = widget.action || null;
      const pageQname = action && action.pageSettings ? String(action.pageSettings.pageQualifiedName || "") : "";
      if (pageQname) existingTargets.add(pageQname);
    }

    for (const entry of homeButtons) {
      const ref = String(entry && entry.pageRef || "").trim();
      if (!ref) continue;

      const targetIface = resolveTargetPageByRef(ref);
      if (!targetIface) continue;
      const targetPage = typeof targetIface.load === "function" ? await targetIface.load() : targetIface;
      const targetQname = String(targetPage.qualifiedName || "");
      if (!targetQname || existingTargets.has(targetQname) || targetQname === String(homePage.qualifiedName || "")) continue;

      const button = pages.ActionButton.createInLayoutCallArgumentUnderWidgets(mainArg);
      button.name = `btn_nav_${String(ref).replace(/[^A-Za-z0-9_]/g, "_")}`.slice(0, 60);
      const targetMeta = resolveNavigationEntryMeta(entry);
      button.caption = createClientTemplateValue(pages, texts, model, targetMeta.caption);
      applyButtonIcon({ button, pages, iconCode: targetMeta.iconCode });
      const action = pages.PageClientAction.createInActionButtonUnderAction(button);
      const settings =
        pages.PageSettings && typeof pages.PageSettings.createInPageClientActionUnderPageSettings === "function"
          ? pages.PageSettings.createInPageClientActionUnderPageSettings(action)
          : action.pageSettings || null;
      if (settings) {
        settings.page = targetPage;
        const entryRoles = resolveModuleRolesForNavigation({
          model,
          moduleName,
          refs: entry.allowedRoles || [],
          availableRoles: availableModuleRoles
        });
        if (entryRoles.length > 0) {
          applyConditionalVisibilityToButton({
            pages,
            button,
            roles: entryRoles
          });
          mergeTargetPageAllowedRoles({ targetPage, roles: entryRoles });
        }
        homeButtonsAdded += 1;
        existingTargets.add(targetQname);
      }
    }
  }

  let navItemsAdded = 0;
  if (menuItems.length > 0) {
    const navIfaces = typeof model.allNavigationDocuments === "function" ? model.allNavigationDocuments() : [];
    for (const navIface of navIfaces) {
      const navDoc = typeof navIface.load === "function" ? await navIface.load() : navIface;
      const profiles = Array.isArray(navDoc.profiles) ? navDoc.profiles : [];
      for (const profile of profiles) {
        if (!profile || profile.structureTypeName !== "Navigation$NavigationProfile") continue;
        let collection = profile.menuItemCollection || null;
        if (!collection && menus.MenuItemCollection && typeof menus.MenuItemCollection.createInNavigationProfileUnderMenuItemCollection === "function") {
          collection = menus.MenuItemCollection.createInNavigationProfileUnderMenuItemCollection(profile);
        }
        if (!collection) continue;

        const existingTargets = new Set();
        const existingItems = Array.isArray(collection.items)
          ? collection.items
          : collection.items && typeof collection.items.slice === "function"
            ? collection.items.slice()
            : [];

        for (const item of existingItems) {
          const action = item && item.action ? item.action : null;
          const pageQname = action && action.pageSettings ? String(action.pageSettings.pageQualifiedName || "") : "";
          if (pageQname) existingTargets.add(pageQname);
        }

        for (const entry of menuItems) {
          const ref = String(entry && entry.pageRef || "").trim();
          if (!ref) continue;

          const targetIface = resolveTargetPageByRef(ref);
          if (!targetIface) continue;
          const targetPage = typeof targetIface.load === "function" ? await targetIface.load() : targetIface;
          const targetQname = String(targetPage.qualifiedName || "");
          if (!targetQname || existingTargets.has(targetQname)) continue;

          const item = menus.MenuItem.createIn(collection);
          const targetMeta = resolveNavigationEntryMeta(entry);
          item.caption = createTextValue(texts, model, targetMeta.caption);
          if ("alternativeText" in item) {
            item.alternativeText = createTextValue(texts, model, targetMeta.caption);
          }
          applyMenuItemIcon({ item, pages, iconCode: targetMeta.iconCode });
          const action = pages.PageClientAction.createInMenuItemUnderAction(item);
          const settings =
            pages.PageSettings && typeof pages.PageSettings.createInPageClientActionUnderPageSettings === "function"
              ? pages.PageSettings.createInPageClientActionUnderPageSettings(action)
              : action.pageSettings || null;
          if (settings) {
            settings.page = targetPage;
            const entryRoles = resolveModuleRolesForNavigation({
              model,
              moduleName,
              refs: entry.allowedRoles || [],
              availableRoles: availableModuleRoles
            });
            if (entryRoles.length > 0) {
              mergeTargetPageAllowedRoles({ targetPage, roles: entryRoles });
            }
            navItemsAdded += 1;
            existingTargets.add(targetQname);
          }
        }
      }
    }
  }

  return {
    requested: true,
    homeButtonsAdded,
    navItemsAdded
  };
}

async function runPlan(plan, options = {}) {
  const normalizedPlan = clonePlanForExecution(plan);
  const preflightErrors = validatePlan(normalizedPlan);
  if (preflightErrors.length) {
    throw new PipelineError({
      code: ERROR_CODES.PLAN_VALIDATION_ERROR,
      stage: "validation",
      message: `Plan validation failed:\n- ${preflightErrors.join("\n- ")}`,
      details: {
        errors: preflightErrors
      }
    });
  }

  const { MendixPlatformClient, setPlatformConfig } = requireSdkPackage("mendixplatformsdk");
  const emitStageUpdate = typeof options.onStageUpdate === "function" ? options.onStageUpdate : null;

  const planForExecution = normalizedPlan;
  const execution = planForExecution.execution || {};
  const createApp = execution.createApp === true;
  const createAppName = String(execution.createAppName || "").trim();
  const createAppNamePrefix = String(execution.createAppNamePrefix || "NewApp").trim() || "NewApp";
  const createAppRepositoryType = execution.createAppRepositoryType || "git";
  const seedAppId = String(execution.seedAppId || "").trim();

  let appId = createApp && !seedAppId ? "" : process.env.MENDIX_APP_ID || seedAppId || planForExecution.app.appId;
  const branch = process.env.MENDIX_BRANCH || planForExecution.app.branch || "main";
  const moduleName = planForExecution.app.moduleName;
  const layoutQualifiedName = planForExecution.app.layoutQualifiedName || "Atlas_Core.Atlas_Default";
  const layoutParameterQname =
    planForExecution.app.layoutParameterQname || (planForExecution.pages && planForExecution.pages.layoutParameterQname) || "";

  const commit = execution.commit === true;
  const commitMessage =
    execution.commitMessage ||
    "Pipeline commander: generate model, flows, workflows and pages from planner JSON";

  const dg2Cleanup = execution.dg2Cleanup !== undefined ? execution.dg2Cleanup : true;
  const forceLegacyWebClientForLookups =
    execution.forceLegacyWebClientForLookups !== undefined ? execution.forceLegacyWebClientForLookups : true;

  const token = process.env.MENDIX_TOKEN || process.env.MENDIX_PAT;
  if (!token) {
    throw new PipelineError({
      code: ERROR_CODES.SDK_WRITE_ERROR,
      stage: "auth",
      message: "No token found. Set MENDIX_TOKEN (preferred) or MENDIX_PAT before running commander."
    });
  }
  setPlatformConfig({ mendixToken: token });

  const client = new MendixPlatformClient();
  let appCreated = false;
  let createdApp = null;
  let app = null;
  if (seedAppId) {
    app = client.getApp(seedAppId);
  } else if (createApp) {
    const createdName = buildGeneratedAppName({ createAppName, createAppNamePrefix });
    const created = await client.createNewApp(createdName, {
      repositoryType: createAppRepositoryType
    });
    appId = created.appId;
    app = created;
    appCreated = true;
    createdApp = {
      appId: created.appId,
      name: createdName,
      repositoryType: createAppRepositoryType
    };
  } else {
    app = client.getApp(appId);
  }

  const workingCopy = await app.createTemporaryWorkingCopy(branch);
  const model = await workingCopy.openModel();

  const personaResult = applyPersonaScaffoldingToPages(planForExecution.pages || {}, planForExecution.personas || {});
  const effectivePagesPlan = personaResult.pagesPlan;
  const effectivePlan = {
    ...planForExecution,
    pages: effectivePagesPlan
  };

  const result = {
    appId,
    appCreated,
    seedAppId: seedAppId || null,
    branch,
    committed: false,
    commitRequested: commit,
    workingCopyId: workingCopy.workingCopyId || null,
    personas: personaResult.personasApplied,
    stages: []
  };
  if (createdApp) {
    result.createdApp = createdApp;
  }

  const reservedWordSanitization = applyReservedWordSanitizationToPlan(effectivePlan, moduleName);
  if (reservedWordSanitization.totalRenamed > 0) {
    result.reservedWordSanitization = reservedWordSanitization;
  }

  if (options.appliedPackPaths && options.appliedPackPaths.length > 0) {
    result.appliedPacks = options.appliedPackPaths;
  }

  async function runStage(stage, fn) {
    const stageStartedAt = Date.now();
    if (emitStageUpdate) {
      emitStageUpdate({
        event: "started",
        stage
      });
    }
    try {
      const value = await fn();
      const normalized = normalizeStageResult(stage, value);
      normalized.durationMs = Date.now() - stageStartedAt;
      result.stages.push(normalized);
      if (emitStageUpdate) {
        emitStageUpdate({
          event: "completed",
          stage,
          result: normalized
        });
      }
      return value;
    } catch (err) {
      const wrapped = wrapStageError(stage, err);
      const normalized = normalizeFailedStageResult(stage, wrapped);
      normalized.durationMs = Date.now() - stageStartedAt;
      result.stages.push(normalized);
      if (emitStageUpdate) {
        emitStageUpdate({
          event: "failed",
          stage,
          result: normalized,
          error: wrapped
        });
      }
      throw wrapped;
    }
  }

  const requestedNames = collectRequestedNames(effectivePlan);
  const beforeRefs = collectModuleRefs(model, moduleName);
  result.beforeCounts = beforeRefs.counts;

  let microflowRefsByRef = {};
  let nanoflowRefsByRef = {};
  let workflowRefsByRef = {};
  let pageRefsByRef = buildPlannedPageRefs(moduleName, effectivePagesPlan || {});

  if (effectivePlan.domainModel) {
    result.domainModel = await runStage("domainModel", async () =>
      applyDomainModelPlanToModel({
        model,
        moduleName,
        domainModelPlan: effectivePlan.domainModel
      })
    );

    await runStage("flush.afterDomainModel", async () => model.flushChanges());
  }

  if (effectivePlan.security) {
    result.security = await runStage("security", async () =>
      applySecurityPlanToModel({
        model,
        moduleName,
        securityPlan: effectivePlan.security,
        plan: effectivePlan
      })
    );

    await runStage("flush.afterSecurity", async () => model.flushChanges());
  }

  if (effectivePlan.microflows || effectivePlan.nanoflows) {
    result.microflows = await runStage("microflowsNanoflows", async () =>
      applyMicroflowsPlanToModel({
        model,
        moduleName,
        microflowsPlan: effectivePlan.microflows || {},
        nanoflowsPlan: effectivePlan.nanoflows || {}
      })
    );

    microflowRefsByRef = result.microflows.microflowRefsByRef || {};
    nanoflowRefsByRef = result.microflows.nanoflowRefsByRef || {};

    await runStage("flush.afterMicroflows", async () => model.flushChanges());
  }

  if (effectivePlan.workflows) {
    result.workflows = await runStage("workflows", async () =>
      applyWorkflowsPlanToModel({
        model,
        moduleName,
        workflowsPlan: effectivePlan.workflows,
        microflowRefsByRef,
        pageRefsByRef
      })
    );

    workflowRefsByRef = result.workflows.workflowRefsByRef || {};

    await runStage("flush.afterWorkflows", async () => model.flushChanges());
  }

  if (effectivePlan.pages) {
    result.pageCapabilities = await runStage("pageCapabilities", async () =>
      assertRequiredPageCapabilities({
        model,
        effectivePlan,
        createApp
      })
    );

    if (forceLegacyWebClientForLookups) {
      result.webClientCompatibility = await runStage("webClientCompatibility", async () =>
        ensureLegacyWebClientForLookupSteps({
          model,
          pagesSection: effectivePagesPlan
        })
      );
      if (result.webClientCompatibility && result.webClientCompatibility.updated) {
        await runStage("flush.afterWebClientCompatibility", async () => model.flushChanges());
      }
    }

    result.pages = await runStage("pages", async () =>
      applyPagesPlanToModel({
        model,
        moduleName,
        layoutQualifiedName,
        layoutParameterQname,
        pagesPlan: effectivePagesPlan,
        dg2Cleanup,
        microflowRefsByRef,
        nanoflowRefsByRef,
        workflowRefsByRef
      })
    );

    if (result.pages && result.pages.dg2Cleanup) {
      result.dg2Cleanup = result.pages.dg2Cleanup;
    }

    pageRefsByRef = parseSpecs(effectivePagesPlan).reduce((acc, spec) => {
      if (spec && spec.ref && spec.name) {
        acc[spec.ref] = `${moduleName}.${spec.name}`;
      }
      if (spec && spec.name) {
        acc[spec.name] = `${moduleName}.${spec.name}`;
      }
      return acc;
    }, pageRefsByRef);

    if (effectivePlan.app && effectivePlan.app.navigation) {
      result.navigationUI = await runStage("navigationUI", async () =>
        applyNavigationUiPlanToModel({
          model,
          moduleName,
          appSection: effectivePlan.app,
          pageRefsByRef
        })
      );
    }
  }

  if (effectivePlan.app) {
    result.homePage = await runStage("homePage", async () =>
      applyHomePagePlanToModel({
        model,
        moduleName,
        appSection: effectivePlan.app,
        pageRefsByRef
      })
    );
  }

  await runStage("flush.final", async () => model.flushChanges());

  const afterRefs = collectModuleRefs(model, moduleName);
  result.afterCounts = afterRefs.counts;
  result.beforeRefs = {
    pages: beforeRefs.pages,
    entities: beforeRefs.entities,
    microflows: beforeRefs.microflows,
    nanoflows: beforeRefs.nanoflows,
    workflows: beforeRefs.workflows
  };
  result.afterRefs = {
    pages: afterRefs.pages,
    entities: afterRefs.entities,
    microflows: afterRefs.microflows,
    nanoflows: afterRefs.nanoflows,
    workflows: afterRefs.workflows
  };

  const verificationCfg = effectivePlan.verification || {};
  const strictVerification = verificationCfg.failOnMissing !== false;
  result.verification = await runStage("verification", async () => {
    const artifactVerification = verifyRequestedArtifacts({
      requested: requestedNames,
      refs: afterRefs,
      strict: strictVerification
    });
    const semanticArtifactVerification = await verifyPlanSemantics({
      plan: effectivePlan,
      model,
      moduleName,
      pageRefsByRef,
      strict: strictVerification
    });

    const scope = String(verificationCfg.scope || "generatedModule");
    const semanticVerification =
      scope === "generatedModule"
        ? runGeneratedModuleSemanticChecks({
            plan: effectivePlan,
            moduleName
          })
        : { enabled: false, ok: true, errors: [] };

    if (semanticVerification.enabled && !semanticVerification.ok) {
      throw new PipelineError({
        code: ERROR_CODES.SEMANTIC_GUARD_ERROR,
        stage: "verification",
        message: `Semantic verification failed (${semanticVerification.errors.length}): ${semanticVerification.errors.join(
          " | "
        )}`
      });
    }

    return {
      ...artifactVerification,
      artifacts: semanticArtifactVerification,
      semantic: semanticVerification
    };
  });

  result.capabilities = await runStage("capabilities", async () => collectModelCapabilitySummary(model));

  if (commit) {
    await runStage("commit", async () => workingCopy.commitToRepository(branch, { commitMessage }));
    result.committed = true;
    result.commitMessage = commitMessage;
  }

  result.ok = result.stages.every((stage) => stage.ok);

  return result;
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const paths = argv.filter((a) => !a.startsWith("--"));
  return {
    planPath: paths[0] || "",
    validateOnly: flags.has("--validate-only")
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.planPath) {
    throw new PipelineError({
      code: ERROR_CODES.PLAN_VALIDATION_ERROR,
      stage: "validation",
      message: "Usage: node src/commander.js <plan.json> [--validate-only]"
    });
  }

  const absolutePlanPath = path.resolve(args.planPath);
  const loadedPlan = loadPlanFile(absolutePlanPath);
  const packResult = applyPackRefs(loadedPlan, {
    planDirectory: path.dirname(absolutePlanPath)
  });
  const plan = packResult.plan;

  const errors = validatePlan(plan);
  if (errors.length) {
    throw new PipelineError({
      code: ERROR_CODES.PLAN_VALIDATION_ERROR,
      stage: "validation",
      message: `Plan validation failed:\n- ${errors.join("\n- ")}`,
      details: {
        errors
      }
    });
  }

  if (args.validateOnly) {
    console.log(
      JSON.stringify(
        {
          valid: true,
          planPath: absolutePlanPath,
          appliedPacks: packResult.appliedPackPaths,
          stages: [
            {
              stage: "validation",
              ok: true,
              summary: "Plan and schema validation passed",
              artifacts: [],
              warnings: [],
              errors: []
            }
          ]
        },
        null,
        2
      )
    );
    return;
  }

  const result = await runPlan(plan, {
    planPath: absolutePlanPath,
    planDirectory: path.dirname(absolutePlanPath),
    appliedPackPaths: packResult.appliedPackPaths
  });
  printCliSummary(result);
}

if (require.main === module) {
  main().catch((err) => {
    const message = formatErrorForDisplay(err);
    const lower = message.toLowerCase();
    const looksLike403 =
      lower.includes("403") ||
      (err && err.statusCode === 403) ||
      (err && err.error && err.error.code === 403);

    if (looksLike403) {
      console.error(
        [
          "Failed: 403 Forbidden while creating/opening working copy.",
          "Likely causes:",
          "1) app.appId points to an app you cannot access",
          "2) token lacks required scopes",
          "3) token belongs to a different Mendix account",
          "",
          "Checks:",
          "- Verify plan app id or override with MENDIX_APP_ID",
          "- Verify token is set in current shell: echo ${#MENDIX_TOKEN}",
          "- Required scopes include: mx:modelrepository:repo:write, mx:app:create, mx:app:delete",
          "",
          `Original error: ${message}`
        ].join("\n")
      );
      process.exit(1);
    }

    if (err instanceof PipelineError) {
      console.error(`Failed: ${formatPipelineErrorForConsole(err)}`);
    } else {
      console.error(`Failed: ${message}`);
    }

    if (process.env.PIPELINE_DEBUG === "1" && err && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  });
}

module.exports = {
  loadPlanFile,
  validatePlan,
  runPlan,
  parseArgs,
  parseSpecs,
  applyPackRefs,
  applyPersonaScaffoldingToPages,
  buildPlannedPageRefs,
  collectRequestedNames,
  collectModuleRefs,
  verifyRequestedArtifacts,
  verifyPlanSemantics,
  describeNavigationTarget,
  normalizeIconCode,
  normalizeNavigationIconsToHome,
  buildGeneratedAppName,
  planRequiresDataGrid2,
  formatErrorForDisplay,
  runGeneratedModuleSemanticChecks
};
