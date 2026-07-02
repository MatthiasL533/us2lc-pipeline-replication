function runPromptBuilderStage({
  bundle,
  visualNarrator,
  processVisualizer,
  baselineDraft,
  useExamplePlans,
  useKnowledge,
  examplePlanPaths,
  knowledgeDir,
  buildExamplePlansBlock,
  buildKnowledgeBlock,
  buildOllamaPrompt,
  progress
}) {
  progress("Stage 5/10: Building LLM prompt...");
  const promptWarnings = [];
  const queryText = [bundle.userStories, bundle.domainInfo, bundle.acceptanceCriteria].filter(Boolean).join("\n\n");
  const examplePlansText = useExamplePlans ? buildExamplePlansBlock(examplePlanPaths, promptWarnings) : "";
  const knowledgeText = useKnowledge
    ? buildKnowledgeBlock({
        knowledgeDir,
        queryText,
        warnings: promptWarnings
      })
    : "";

  const prompt = buildOllamaPrompt({
    stories: bundle.stories,
    domainInfo: bundle.domainInfo,
    acceptanceCriteria: bundle.acceptanceCriteria,
    visualNarratorPromptText: visualNarrator.promptText,
    processVisualizerPromptText: processVisualizer.promptText,
    appContext: bundle.appContext,
    examplePlansText,
    knowledgeText,
    baselineDraft
  });

  return {
    prompt,
    promptWarnings
  };
}

module.exports = {
  runPromptBuilderStage
};
