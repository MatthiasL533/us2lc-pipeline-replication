const ASSOCIATION_TYPE_CONFIG = {
  defaultType: "Reference",
  canonicalTypes: ["Reference", "ReferenceSet"],
  aliases: {
    reference: "Reference",
    oneToOne: "Reference",
    oneToMany: "Reference",
    manyToOne: "Reference",
    referenceSet: "ReferenceSet",
    manyToMany: "ReferenceSet"
  }
};

function associationTypeKey(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "")
    .toLowerCase();
}

function associationTypeMap(config = ASSOCIATION_TYPE_CONFIG) {
  const out = new Map();
  for (const type of config.canonicalTypes || []) {
    out.set(associationTypeKey(type), type);
  }
  for (const [alias, type] of Object.entries(config.aliases || {})) {
    out.set(associationTypeKey(alias), type);
  }
  return out;
}

function normalizeAssociationType(raw, options = {}) {
  const config = options.config || ASSOCIATION_TYPE_CONFIG;
  const rawText = String(raw || "").trim();
  const fallbackType = options.defaultType || config.defaultType || "Reference";
  const map = associationTypeMap(config);
  const key = associationTypeKey(rawText || fallbackType);
  const canonicalType = map.get(key);

  if (canonicalType) {
    return {
      ok: true,
      type: canonicalType,
      originalType: rawText || "",
      semanticType: "",
      usedFallback: false
    };
  }

  if (options.allowSemanticFallback) {
    return {
      ok: true,
      type: fallbackType,
      originalType: rawText,
      semanticType: rawText,
      usedFallback: true
    };
  }

  return {
    ok: false,
    type: "",
    originalType: rawText,
    semanticType: "",
    usedFallback: false
  };
}

function supportedAssociationTypeDescription(config = ASSOCIATION_TYPE_CONFIG) {
  const canonical = (config.canonicalTypes || []).join(", ");
  const aliases = Object.keys(config.aliases || {}).join(", ");
  return aliases ? `${canonical}; aliases: ${aliases}` : canonical;
}

module.exports = {
  ASSOCIATION_TYPE_CONFIG,
  associationTypeKey,
  normalizeAssociationType,
  supportedAssociationTypeDescription
};
