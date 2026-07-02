function trimToString(value) {
  return String(value || "").trim();
}

function toUniqueStrings(values = []) {
  return [...new Set((values || []).map((value) => trimToString(value)).filter(Boolean))];
}

function cloneIconSpec(icon) {
  if (icon === null || icon === undefined) return null;
  if (typeof icon === "number") return icon;
  if (typeof icon === "string") {
    const trimmed = icon.trim();
    return trimmed || null;
  }
  if (typeof icon === "object" && !Array.isArray(icon)) {
    const out = {};
    for (const [key, value] of Object.entries(icon)) {
      if (value === undefined) continue;
      out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}

function normalizeRoleRefs(values = []) {
  return toUniqueStrings(values);
}

function normalizeNavigationEntry(rawEntry) {
  if (typeof rawEntry === "string") {
    const pageRef = trimToString(rawEntry);
    return pageRef
      ? {
          pageRef,
          caption: "",
          icon: null,
          allowedRoles: []
        }
      : null;
  }

  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return null;
  }

  const pageRef = trimToString(rawEntry.pageRef || rawEntry.targetPageRef || rawEntry.ref);
  if (!pageRef) return null;

  return {
    pageRef,
    caption: trimToString(rawEntry.caption || rawEntry.label),
    icon: cloneIconSpec(rawEntry.icon),
    allowedRoles: normalizeRoleRefs(rawEntry.allowedRoles || rawEntry.allowedModuleRoles || [])
  };
}

function dedupeNavigationEntries(entries = []) {
  const out = [];
  const seen = new Set();

  for (const rawEntry of entries) {
    const entry = normalizeNavigationEntry(rawEntry);
    if (!entry) continue;

    const key = entry.pageRef.toLowerCase();
    if (seen.has(key)) {
      const existing = out.find((item) => item.pageRef.toLowerCase() === key);
      if (!existing) continue;
      if (!existing.caption && entry.caption) existing.caption = entry.caption;
      if (!existing.icon && entry.icon) existing.icon = entry.icon;
      existing.allowedRoles = toUniqueStrings([...(existing.allowedRoles || []), ...(entry.allowedRoles || [])]);
      continue;
    }

    seen.add(key);
    out.push(entry);
  }

  return out;
}

function normalizeNavigationConfig(navigation = {}) {
  const nav = navigation && typeof navigation === "object" ? navigation : {};

  const homePageButtons = dedupeNavigationEntries([
    ...(Array.isArray(nav.homePageButtons) ? nav.homePageButtons : []),
    ...(Array.isArray(nav.homePageButtonRefs) ? nav.homePageButtonRefs : [])
  ]);
  const menuItems = dedupeNavigationEntries([
    ...(Array.isArray(nav.menuItems) ? nav.menuItems : []),
    ...(Array.isArray(nav.navigationItemRefs) ? nav.navigationItemRefs : [])
  ]);

  return {
    ...nav,
    homePageButtons,
    menuItems,
    homePageButtonRefs: homePageButtons.map((entry) => entry.pageRef),
    navigationItemRefs: menuItems.map((entry) => entry.pageRef)
  };
}

module.exports = {
  trimToString,
  toUniqueStrings,
  normalizeRoleRefs,
  normalizeNavigationEntry,
  dedupeNavigationEntries,
  normalizeNavigationConfig
};
