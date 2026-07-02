function getContainerTypeName(container) {
  if (!container) return "";
  if (container.structureTypeName && typeof container.structureTypeName === "string") {
    return container.structureTypeName;
  }
  if (container.constructor && typeof container.constructor.name === "string") {
    return container.constructor.name;
  }
  return "";
}

function rankCreateMethod(methodName, containerTypeName) {
  let score = 0;
  if (methodName.includes("UnderWidgets")) score += 2;
  if (containerTypeName && methodName.toLowerCase().includes(containerTypeName.toLowerCase())) score += 2;
  if (methodName.startsWith("createIn")) score += 1;
  return score;
}

function discoverCreateMethodsForContainer(ctor, container) {
  if (!ctor || typeof ctor !== "function") return [];
  const containerTypeName = getContainerTypeName(container);
  const methods = Object.getOwnPropertyNames(ctor)
    .filter((name) => /^createIn[A-Za-z0-9_]+$/.test(name) && typeof ctor[name] === "function")
    .sort((a, b) => rankCreateMethod(b, containerTypeName) - rankCreateMethod(a, containerTypeName));
  return methods;
}

function discoverCreatableWidgets(pages, createMethod = "createInLayoutCallArgumentUnderWidgets") {
  if (!pages || typeof pages !== "object") return [];
  const out = [];
  for (const [name, value] of Object.entries(pages)) {
    if (!value || typeof value !== "function") continue;
    if (typeof value[createMethod] === "function") {
      out.push(name);
    }
  }
  return out.sort();
}

module.exports = {
  getContainerTypeName,
  rankCreateMethod,
  discoverCreateMethodsForContainer,
  discoverCreatableWidgets
};
