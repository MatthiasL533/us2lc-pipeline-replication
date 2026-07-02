const { parseSpecs } = require("./pack-merger");

function toPersonaKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildPersonaLandingName(personaName) {
  const raw = String(personaName || "").trim();
  if (!raw) return "Persona_Home";
  const cleaned = raw.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${cleaned}_Home`;
}

function normalizePagePersonaTags(pageSpec = {}) {
  const tags = [];

  if (typeof pageSpec.persona === "string" && pageSpec.persona.trim()) {
    tags.push(pageSpec.persona.trim());
  }

  if (Array.isArray(pageSpec.personas)) {
    for (const p of pageSpec.personas) {
      if (typeof p === "string" && p.trim()) tags.push(p.trim());
    }
  }

  return [...new Set(tags.map((t) => toPersonaKey(t)).filter(Boolean))];
}

function applyPersonaScaffoldingToPages(pages = {}, personas = {}) {
  const pageSpecs = parseSpecs(pages);
  const personaEnabled = personas && personas.enabled === true;
  const personaSpecs = Array.isArray(personas && personas.specs) ? personas.specs : [];

  if (!personaEnabled || personaSpecs.length === 0) {
    return {
      pagesPlan: {
        ...(pages || {}),
        specs: pageSpecs
      },
      personasApplied: {
        enabled: false,
        generatedPageNames: [],
        personaNames: []
      }
    };
  }

  const finalSpecs = [...pageSpecs];
  const existingByName = new Map(finalSpecs.map((p) => [p.name, p]));
  const existingByRef = new Map(finalSpecs.map((p) => [p.ref, p]));

  const generatedPageNames = [];
  const personaNames = [];

  for (const personaSpec of personaSpecs) {
    const personaName = String((personaSpec && personaSpec.name) || "").trim();
    if (!personaName) continue;

    const personaKey = toPersonaKey(personaName);
    if (!personaKey) continue;

    personaNames.push(personaName);

    const landingRef =
      (personaSpec && personaSpec.landingRef && String(personaSpec.landingRef).trim()) ||
      `persona_${personaKey}_home`;
    const landingName =
      (personaSpec && personaSpec.landingPageName && String(personaSpec.landingPageName).trim()) ||
      buildPersonaLandingName(personaName);

    if (existingByName.has(landingName) || existingByRef.has(landingRef)) {
      continue;
    }

    const taggedPages = finalSpecs
      .filter((p) => {
        if (!p || !p.name) return false;
        const tags = normalizePagePersonaTags(p);
        return tags.includes(personaKey);
      })
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

    const content = [
      {
        type: "dynamicText",
        text: `${personaName} Home`,
        renderMode: "H2"
      }
    ];

    if (taggedPages.length === 0) {
      content.push({
        type: "dynamicText",
        text: `No pages assigned to persona ${personaName}.`,
        renderMode: "Paragraph"
      });
    } else {
      for (const page of taggedPages) {
        content.push({
          type: "buttonToPage",
          caption: page.title || page.name,
          targetPageRef: page.ref || page.name
        });
      }
    }

    const landingPage = {
      ref: landingRef,
      name: landingName,
      title: `${personaName} Home`,
      persona: personaName,
      content
    };

    finalSpecs.push(landingPage);
    existingByName.set(landingName, landingPage);
    existingByRef.set(landingRef, landingPage);
    generatedPageNames.push(landingName);
  }

  return {
    pagesPlan: {
      ...(pages || {}),
      specs: finalSpecs
    },
    personasApplied: {
      enabled: true,
      generatedPageNames,
      personaNames: [...new Set(personaNames)]
    }
  };
}

module.exports = {
  toPersonaKey,
  buildPersonaLandingName,
  normalizePagePersonaTags,
  applyPersonaScaffoldingToPages
};
