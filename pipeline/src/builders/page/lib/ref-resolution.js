function normalizeEntityQualifiedName(rawEntityRef, moduleName) {
  const raw = String(rawEntityRef || "").trim();
  if (!raw) return "";
  if (raw.includes(".")) return raw;
  return moduleName ? `${moduleName}.${raw}` : raw;
}

function normalizeToken(rawValue) {
  return String(rawValue || "").trim().toLowerCase();
}

module.exports = {
  normalizeEntityQualifiedName,
  normalizeToken
};
