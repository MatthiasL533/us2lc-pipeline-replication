function toUniqueStrings(values) {
  return [...new Set((values || []).filter((v) => typeof v === "string" && v.length > 0))];
}

function toQualifiedName(moduleName, name) {
  return `${moduleName}.${name}`;
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

function resolveAttributeReference({ model, entity, rawAttributeRef }) {
  if (!rawAttributeRef) return null;
  const raw = String(rawAttributeRef).trim();
  if (!raw) return null;

  const entityQname =
    entity && entity.qualifiedName
      ? entity.qualifiedName
      : entity && entity.name && entity.containerAsDomainModel && entity.containerAsDomainModel.containerAsModule
        ? `${entity.containerAsDomainModel.containerAsModule.name}.${entity.name}`
        : "";

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

function resolveMicroflowByReference({ model, moduleName, ref, microflowRefsByRef = {}, createdByRef = {} }) {
  if (!ref) return null;
  const raw = String(ref).trim();
  if (!raw) return null;

  if (createdByRef[raw]) return createdByRef[raw];

  const mappedQname = microflowRefsByRef[raw] || "";
  if (mappedQname) {
    const found = model.findMicroflowByQualifiedName(mappedQname);
    if (found) return found;
  }

  if (raw.includes(".")) {
    const found = model.findMicroflowByQualifiedName(raw);
    if (found) return found;
  }

  const inModule = model.findMicroflowByQualifiedName(toQualifiedName(moduleName, raw));
  if (inModule) return inModule;

  return model.allMicroflows().find((mf) => mf.name === raw) || null;
}

function resolveNanoflowByReference({ model, moduleName, ref, nanoflowRefsByRef = {}, createdByRef = {} }) {
  if (!ref) return null;
  const raw = String(ref).trim();
  if (!raw) return null;

  if (createdByRef[raw]) return createdByRef[raw];

  const mappedQname = nanoflowRefsByRef[raw] || "";
  if (mappedQname) {
    const found = model.findNanoflowByQualifiedName(mappedQname);
    if (found) return found;
  }

  if (raw.includes(".")) {
    const found = model.findNanoflowByQualifiedName(raw);
    if (found) return found;
  }

  const inModule = model.findNanoflowByQualifiedName(toQualifiedName(moduleName, raw));
  if (inModule) return inModule;

  return model.allNanoflows().find((nf) => nf.name === raw) || null;
}

module.exports = {
  resolveEntityReference,
  resolveAttributeReference,
  resolveMicroflowByReference,
  resolveNanoflowByReference,
  toQualifiedName,
  toUniqueStrings
};
