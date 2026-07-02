function normalizeStoryCoverageThreshold(raw, PlanGeneratorError) {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new PlanGeneratorError("--min-story-coverage must be a number between 0 and 1.");
  }
  return value;
}

function buildCoverageGate({ coverage, minStoryCoverage, PlanGeneratorError }) {
  const minimumStoryCoverage = normalizeStoryCoverageThreshold(minStoryCoverage, PlanGeneratorError);
  return {
    enabled: minimumStoryCoverage !== null,
    minimum: minimumStoryCoverage,
    score: coverage.score,
    passed: minimumStoryCoverage === null || coverage.score + 1e-9 >= minimumStoryCoverage
  };
}

function formatMissingStory(story) {
  if (!story || typeof story !== "object") return String(story || "");

  const id = String(story.id || story.storyId || "").trim() || "<unknown>";
  const text = String(story.raw || story.story || story.text || "").trim();
  const concepts = Array.isArray(story.storyConcepts) && story.storyConcepts.length > 0
    ? ` concepts=${story.storyConcepts.join(", ")}`
    : "";
  const matched = Array.isArray(story.matchedConcepts) && story.matchedConcepts.length > 0
    ? ` matched=${story.matchedConcepts.join(", ")}`
    : "";
  const lexicalScore = Number.isFinite(Number(story.lexicalScore))
    ? ` lexicalScore=${Number(story.lexicalScore).toFixed(3)}`
    : "";

  return `${id}: ${text || "<missing story text>"}${lexicalScore}${concepts}${matched}`;
}

function assertCoverageGate({ coverageGate, coverage, PlanGeneratorError }) {
  if (coverageGate.passed) return;
  throw new PlanGeneratorError(
    `Generated plan story coverage ${coverage.score.toFixed(3)} is below required minimum ${coverageGate.minimum.toFixed(3)}.`,
    coverage.missingStories.map(formatMissingStory)
  );
}

module.exports = {
  buildCoverageGate,
  assertCoverageGate,
  formatMissingStory,
  normalizeStoryCoverageThreshold
};
