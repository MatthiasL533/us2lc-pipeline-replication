function runPlanNormalizerStage({
  baselineDraft,
  llmResult,
  bundle,
  promptWarnings,
  normalizeGeneratedPlan,
  progress
}) {
  progress("Stage 7/10: Normalizing baseline and LLM drafts...");
  const baselineNormalized = normalizeGeneratedPlan({
    generatedPlan: baselineDraft,
    appContext: bundle.appContext,
    stories: bundle.stories,
    domainInfo: bundle.domainInfo,
    warnings: bundle.warnings.concat(promptWarnings)
  });

  const llmNormalized = normalizeGeneratedPlan({
    generatedPlan: llmResult.generatedPlan,
    appContext: bundle.appContext,
    stories: bundle.stories,
    domainInfo: bundle.domainInfo,
    warnings: []
  });

  return {
    baselineNormalized,
    llmNormalized
  };
}

function normalizeRepairPlan({
  repairResult,
  bundle,
  normalizeGeneratedPlan
}) {
  return normalizeGeneratedPlan({
    generatedPlan: repairResult.generatedPlan,
    appContext: bundle.appContext,
    stories: bundle.stories,
    domainInfo: bundle.domainInfo,
    warnings: []
  });
}

module.exports = {
  runPlanNormalizerStage,
  normalizeRepairPlan
};
