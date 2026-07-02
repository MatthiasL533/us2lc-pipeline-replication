function runPlanMergerStage({
  bundle,
  visualNarrator,
  processVisualizer,
  baselineNormalized,
  llmNormalized,
  mergePlanCandidates,
  ensureWorkflowScaffold,
  ensureNavigationSpecAndHomeButtons,
  evaluateStoryCoverage,
  progress
}) {
  progress("Stage 8/10: Merging drafts with story relevance filtering...");
  const mergeWarnings = [];
  const finalPlan = mergePlanCandidates({
    baselinePlan: baselineNormalized.plan,
    llmPlan: llmNormalized.plan,
    stories: bundle.stories,
    visualNarratorSummary: visualNarrator.summary,
    processVisualizerSummary: processVisualizer.summary,
    warnings: mergeWarnings
  });

  ensureWorkflowScaffold(finalPlan, bundle.stories, mergeWarnings, bundle.domainInfo);
  ensureNavigationSpecAndHomeButtons(finalPlan, mergeWarnings);

  return {
    finalPlan,
    mergeWarnings,
    coverage: evaluateStoryCoverage(finalPlan, bundle.stories, visualNarrator.summary, processVisualizer.summary)
  };
}

function mergeRepairPlan({
  finalPlan,
  repairNormalized,
  bundle,
  visualNarrator,
  processVisualizer,
  mergePlanCandidates,
  ensureWorkflowScaffold,
  ensureNavigationSpecAndHomeButtons,
  evaluateStoryCoverage
}) {
  const repairedWarnings = [];
  const repairedPlan = mergePlanCandidates({
    baselinePlan: finalPlan,
    llmPlan: repairNormalized.plan,
    stories: bundle.stories,
    visualNarratorSummary: visualNarrator.summary,
    processVisualizerSummary: processVisualizer.summary,
    warnings: repairedWarnings
  });

  ensureWorkflowScaffold(repairedPlan, bundle.stories, repairedWarnings, bundle.domainInfo);
  ensureNavigationSpecAndHomeButtons(repairedPlan, repairedWarnings);

  return {
    repairedPlan,
    repairedWarnings,
    repairedCoverage: evaluateStoryCoverage(repairedPlan, bundle.stories, visualNarrator.summary, processVisualizer.summary)
  };
}

module.exports = {
  runPlanMergerStage,
  mergeRepairPlan
};
