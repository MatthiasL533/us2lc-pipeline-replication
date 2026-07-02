function runBaselinePlannerStage({
  bundle,
  visualNarrator,
  processVisualizer,
  buildStoryDrivenBaselineDraft,
  PlanGeneratorError,
  progress
}) {
  progress("Stage 4/10: Synthesizing story-driven baseline draft...");
  const baselineDraft = buildStoryDrivenBaselineDraft({
    stories: bundle.stories,
    moduleName: bundle.appContext.moduleName,
    domainInfo: bundle.domainInfo,
    visualNarratorSummary: visualNarrator.summary,
    processVisualizerSummary: processVisualizer.summary
  });

  if (((baselineDraft.domainModel && baselineDraft.domainModel.entities) || []).length === 0) {
    throw new PlanGeneratorError(
      "Could not derive a defensible domain model scaffold from the user stories and Visual Narrator output."
    );
  }

  return baselineDraft;
}

module.exports = {
  runBaselinePlannerStage
};
