const { parseSpecs } = require("./pack-merger");

function trimToString(value) {
  return String(value || "").trim();
}

function uniq(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function deriveStoryCapabilityBaseline({
  stories = [],
  visualNarratorSummary = null,
  processVisualizerSummary = null
} = {}) {
  const text = `${(stories || []).map((story) => story && story.raw || "").join(" ")} ${
    ((visualNarratorSummary && visualNarratorSummary.classNames) || []).join(" ")
  } ${
    [
      ...((processVisualizerSummary && processVisualizerSummary.processObjects) || []),
      ...((processVisualizerSummary && processVisualizerSummary.tasks) || []).flatMap((task) => [task && task.actor, task && task.action, task && task.condition])
    ].filter(Boolean).join(" ")
  }`.toLowerCase();

  const capabilities = [];
  const archetypes = [];
  const processHints = processVisualizerSummary && processVisualizerSummary.capabilityHints || {};

  if (/\bdashboard|report|metric|analytics?|summary|kpi\b/.test(text)) {
    capabilities.push("charts");
    archetypes.push("dashboard");
    archetypes.push("analytics");
  }
  if (/\bfilter|search|find|sort\b/.test(text)) {
    capabilities.push("searchable_data_management");
    archetypes.push("management");
  }
  if (processHints.hasWorkflowLikeRouting || /\bworkflow|approve|approval|reject|task\b/.test(text)) {
    capabilities.push("workflow_support");
    archetypes.push("tasks");
  }
  if (/\brole|permission|admin|manager|operator|analyst\b/.test(text)) {
    capabilities.push("role_separated_views");
    archetypes.push("role_separation");
  }
  if (/\bupload|attachment|document|file\b/.test(text)) {
    capabilities.push("file_handling");
  }

  const recommendedWidgetFamilies = [];
  if (capabilities.includes("charts")) recommendedWidgetFamilies.push("mendix_charts");
  if (capabilities.includes("searchable_data_management")) {
    recommendedWidgetFamilies.push("data_grid");
    recommendedWidgetFamilies.push("data_grid_filters");
  }
  if (capabilities.includes("workflow_support")) {
    recommendedWidgetFamilies.push("workflow_commons");
  }

  return {
    source: "reference-app-baseline",
    capabilities: uniq(capabilities),
    archetypes: uniq(archetypes),
    recommendedWidgetFamilies: uniq(recommendedWidgetFamilies)
  };
}

function collectPlanCapabilityRequirements(plan = {}) {
  const pages = parseSpecs(plan.pages);
  const requirements = new Set();

  for (const page of pages) {
    const steps = Array.isArray(page && page.content) ? page.content : [];
    walkSteps(steps, (step) => {
      if (!step || typeof step !== "object") return;
      if (step.type === "dataGrid") {
        requirements.add("data_grid");
        const mode = trimToString(step.widgetMode || step.mode || "datagrid2").toLowerCase();
        if (!["classic", "datagrid", "data_grid", "grid"].includes(mode)) {
          requirements.add("data_grid_2");
        }
      }
      if (step.type === "filterToolbar") requirements.add("data_grid_filters");
      if (step.type === "callWorkflowButton" || step.type === "setTaskOutcomeButton") requirements.add("workflow_commons");
      if (step.type === "widget" && trimToString(step.widgetId).startsWith("com.mendix.charts.")) {
        requirements.add("mendix_charts");
      }
    });
  }

  return [...requirements].sort();
}

function walkSteps(steps = [], visit) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== "object") continue;
    visit(step);
    walkSteps(step.content, visit);
    walkSteps(step.itemContent, visit);
    walkSteps(step.templateContent, visit);
  }
}

async function collectModelCapabilitySummary(model) {
  const moduleNames =
    typeof model.allModules === "function"
      ? (Array.isArray(model.allModules()) ? model.allModules() : [])
          .map((module) => trimToString(module && module.name))
          .filter(Boolean)
      : [];

  const widgetIds = new Set();
  function toArray(list) {
    if (!list) return [];
    if (Array.isArray(list)) return list;
    if (typeof list.slice === "function") {
      try {
        return list.slice();
      } catch (_err) {
        return [];
      }
    }
    const out = [];
    if (typeof list.forEach === "function") list.forEach((item) => out.push(item));
    return out;
  }
  function walk(value, seen = new Set()) {
    if (!value || typeof value !== "object") return;
    const id = trimToString(value.id);
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    if (value.structureTypeName === "CustomWidgets$CustomWidget") {
      const widgetType = value.type || null;
      const widgetId = trimToString(widgetType && widgetType.widgetId);
      if (widgetId) widgetIds.add(widgetId);
    }
    for (const key of ["widgets", "items", "arguments", "properties", "objects"]) {
      for (const item of toArray(value[key])) walk(item, seen);
    }
    for (const key of ["layoutCall", "dataSource", "searchBar", "action", "pageSettings", "object", "type"]) {
      try {
        if (value[key]) walk(value[key], seen);
      } catch (_err) {
        // ignore unavailable properties in versioned metamodels
      }
    }
  }

  if (typeof model.allPages === "function") {
    for (const pageIface of toArray(model.allPages())) {
      const page = pageIface && typeof pageIface.load === "function" ? await pageIface.load() : pageIface;
      walk(page);
    }
  }

  return {
    modules: uniq(moduleNames).sort(),
    widgetIds: [...widgetIds].sort(),
    widgetFamilies: uniq([
      [...widgetIds].some((id) => id.startsWith("com.mendix.charts.")) ? "mendix_charts" : "",
      moduleNames.some((name) => name === "DataWidgets") ? "datawidgets_module" : "",
      [...widgetIds].some((id) => /datagrid2|datawidgets\.datagrid/i.test(id)) ? "data_grid_2" : "",
      moduleNames.some((name) => name === "WorkflowCommons") ? "workflow_commons" : ""
    ]).sort()
  };
}

module.exports = {
  deriveStoryCapabilityBaseline,
  collectPlanCapabilityRequirements,
  collectModelCapabilitySummary
};
