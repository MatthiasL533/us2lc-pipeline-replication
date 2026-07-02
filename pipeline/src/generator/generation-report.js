const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

function trimToString(raw) {
  return String(raw || "").trim();
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function buildInputFileManifest(bundle = {}) {
  const files = bundle.files && typeof bundle.files === "object" ? bundle.files : {};
  const manifest = {};
  for (const [key, filePath] of Object.entries(files)) {
    if (!filePath || !fs.existsSync(filePath)) continue;
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath);
    manifest[key] = {
      path: filePath,
      bytes: stat.size,
      mtime: stat.mtime.toISOString(),
      sha256: crypto.createHash("sha256").update(content).digest("hex")
    };
  }
  return manifest;
}

function buildReproducibilitySection({
  bundle,
  prompt = "",
  model,
  processVisualizerModel,
  ollamaUrl,
  ollamaOptions,
  useExamplePlans,
  useKnowledge,
  useVisualNarrator,
  useProcessVisualizer,
  examplePlanPaths,
  knowledgeDir
}) {
  return {
    generator: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch
    },
    inputs: buildInputFileManifest(bundle),
    prompt: {
      sha256: prompt ? sha256Text(prompt) : "",
      chars: String(prompt || "").length
    },
    settings: {
      model,
      processVisualizerModel,
      ollamaUrl,
      ollamaOptions: { ...(ollamaOptions || {}) },
      useExamplePlans: Boolean(useExamplePlans),
      useKnowledge: Boolean(useKnowledge),
      useVisualNarrator: Boolean(useVisualNarrator),
      useProcessVisualizer: Boolean(useProcessVisualizer),
      examplePlanPaths: Array.isArray(examplePlanPaths) ? examplePlanPaths.slice() : [],
      knowledgeDir: trimToString(knowledgeDir)
    }
  };
}

function applyPlanMetadata({
  finalPlan,
  bundle,
  visualNarrator,
  processVisualizer,
  domainModelReview,
  associationGeneration,
  sectionPasses,
  coverage,
  deriveStoryCapabilityBaseline,
  collectPlanCapabilityRequirements
}) {
  const existingMeta = finalPlan.meta && typeof finalPlan.meta === "object" && !Array.isArray(finalPlan.meta)
    ? finalPlan.meta
    : {};
  const associationDiagnostics =
    finalPlan.domainModel &&
    finalPlan.domainModel._associationDiagnostics &&
    typeof finalPlan.domainModel._associationDiagnostics === "object" &&
    !Array.isArray(finalPlan.domainModel._associationDiagnostics)
      ? finalPlan.domainModel._associationDiagnostics
      : {};
  if (finalPlan.domainModel && finalPlan.domainModel._associationDiagnostics !== undefined) {
    delete finalPlan.domainModel._associationDiagnostics;
  }
  const slimMeta = {};
  for (const key of ["planVersion", "generatedAt", "generatedBy", "mergedWithLlm"]) {
    if (existingMeta[key] !== undefined) slimMeta[key] = existingMeta[key];
  }
  finalPlan.meta = {
    ...slimMeta
  };

  return {
    preprocessing: {
      visualNarratorEnabled: visualNarrator.enabled,
      visualNarratorStatus: visualNarrator.status,
      processVisualizerEnabled: processVisualizer.enabled,
      processVisualizerStatus: processVisualizer.status
    },
    associationDiagnostics,
    domainModelReview: domainModelReview || { enabled: false, status: "skipped" },
    associationGeneration: associationGeneration || { enabled: false, status: "skipped" },
    sectionPasses: sectionPasses || {},
    referenceAppBaseline: deriveStoryCapabilityBaseline({
      stories: bundle.stories,
      visualNarratorSummary: visualNarrator.summary,
      processVisualizerSummary: processVisualizer.summary
    }),
    capabilityRequirements: collectPlanCapabilityRequirements(finalPlan),
    storyCoverage: {
      entries: coverage.entries,
      score: coverage.score,
      covered: coverage.covered,
      total: coverage.total
    }
  };
}

function buildGenerationReport({
  bundle,
  absoluteOutPath,
  allWarnings,
  model,
  coverage,
  coverageGate,
  llmResult,
  visualNarrator,
  processVisualizer,
  domainModelReview,
  associationGeneration,
  sectionPasses,
  planDiagnostics,
  llmPassCount,
  allowRepairPass,
  generationMode,
  reproducibility,
  ollamaOptions,
  constants
}) {
  const ollamaRaw = llmResult.ollamaRaw || {};
  const likelyPromptTruncated = Number(ollamaRaw.prompt_eval_count || 0) >= constants.OLLAMA_NUM_CTX - 16;
  if (likelyPromptTruncated) {
    allWarnings.push(
      `Prompt likely hit context limit (prompt_eval_count=${ollamaRaw.prompt_eval_count}, num_ctx=${constants.OLLAMA_NUM_CTX}).`
    );
  }

  return {
    ok: coverageGate.passed,
    generatedAt: new Date().toISOString(),
    inputDir: bundle.inputDir,
    outputPlanPath: absoluteOutPath,
    warnings: allWarnings,
    validation: {
      ok: true,
      errors: []
    },
    model,
    coverage: {
      score: coverage.score,
      covered: coverage.covered,
      total: coverage.total,
      missingStoryIds: coverage.missingStories.map((s) => s.id),
      entries: coverage.entries
    },
    coverageGate,
    ollama: {
      model: trimToString(ollamaRaw.model) || model,
      totalDuration: ollamaRaw.total_duration || 0,
      loadDuration: ollamaRaw.load_duration || 0,
      promptEvalCount: ollamaRaw.prompt_eval_count || 0,
      evalCount: ollamaRaw.eval_count || 0,
      numCtx: constants.OLLAMA_NUM_CTX,
      numPredict: constants.OLLAMA_NUM_PREDICT,
      options: { ...(ollamaOptions || {}) },
      likelyPromptTruncated
    },
    visualNarrator: {
      enabled: visualNarrator.enabled,
      status: visualNarrator.status,
      durationMs: visualNarrator.durationMs,
      command: visualNarrator.command,
      artifacts: visualNarrator.artifacts,
      warnings: visualNarrator.warnings,
      error: visualNarrator.error
    },
    processVisualizer: {
      enabled: processVisualizer.enabled,
      status: processVisualizer.status,
      durationMs: processVisualizer.durationMs,
      command: processVisualizer.command,
      artifacts: processVisualizer.artifacts,
      warnings: processVisualizer.warnings,
      error: processVisualizer.error
    },
    domainModelReview: domainModelReview || { enabled: false, status: "skipped" },
    associationGeneration: associationGeneration || { enabled: false, status: "skipped" },
    sectionPasses: sectionPasses || {},
    planDiagnostics: planDiagnostics || {},
    generationStrategy: {
      mode: generationMode || "legacy",
      llmPassCount,
      repairPassEnabled: Boolean(allowRepairPass)
    },
    reproducibility: reproducibility || null
  };
}

function writeGenerationArtifacts({
  absoluteOutPath,
  finalPlan,
  report,
  progress
}) {
  const reportPath = path.join(path.dirname(absoluteOutPath), "generation-report.json");
  fs.mkdirSync(path.dirname(absoluteOutPath), { recursive: true });
  progress(`Stage 10/10: Writing plan to ${absoluteOutPath}...`);
  fs.writeFileSync(absoluteOutPath, JSON.stringify(finalPlan, null, 2), "utf8");
  progress(`Stage 10/10: Writing generation report to ${reportPath}...`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  return reportPath;
}

module.exports = {
  applyPlanMetadata,
  buildGenerationReport,
  buildReproducibilitySection,
  writeGenerationArtifacts
};
