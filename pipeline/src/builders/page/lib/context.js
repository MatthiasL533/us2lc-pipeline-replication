function toUniqueStrings(values) {
  return [...new Set((values || []).filter((v) => typeof v === "string" && v.length > 0))];
}

function toSafeName(value, fallback = "item") {
  const raw = String(value || "").trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function toHumanLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

module.exports = {
  toUniqueStrings,
  toSafeName,
  toHumanLabel
};
