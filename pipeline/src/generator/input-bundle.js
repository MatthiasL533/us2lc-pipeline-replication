function runInputBundleStage({ inputDir, loadInputBundle, progress }) {
  progress("Stage 1/10: Reading input files...");
  return loadInputBundle(inputDir);
}

function runPreprocessingStages({
  bundle,
  outputDir,
  model,
  processVisualizerModel,
  ollamaUrl,
  useVisualNarrator,
  useProcessVisualizer,
  mockVisualNarratorResponsePath,
  mockProcessVisualizerResponsePath,
  runVisualNarratorImpl,
  runProcessVisualizerImpl,
  createVisualNarratorState,
  createProcessVisualizerState,
  loadMockVisualNarratorResult,
  loadMockProcessVisualizerResult,
  loadInputVisualNarratorResult,
  loadInputProcessVisualizerResult,
  trimToString,
  PlanGeneratorError,
  strictProcessVisualizer = false,
  progress
}) {
  let visualNarrator = createVisualNarratorState({
    enabled: Boolean(useVisualNarrator),
    status: useVisualNarrator ? "pending" : "skipped"
  });
  let processVisualizer = createProcessVisualizerState({
    enabled: Boolean(useProcessVisualizer),
    status: useProcessVisualizer ? "pending" : "skipped"
  });

  if (useVisualNarrator) {
    progress("Stage 2/10: Running Visual Narrator conceptual-model extraction...");
    if (bundle.inputDir) {
      try {
        visualNarrator = loadInputVisualNarratorResult({
          inputDir: bundle.inputDir,
          outputDir
        });
        if (visualNarrator && visualNarrator.command) {
          progress("Stage 2/10: Using Visual Narrator input artifacts from input directory.");
        }
      } catch (_err) {
        visualNarrator = null;
      }
      if (visualNarrator) {
        // Loaded from input artifacts; skip inline execution.
      } else if (mockVisualNarratorResponsePath) {
        visualNarrator = loadMockVisualNarratorResult({
          mockPath: mockVisualNarratorResponsePath,
          outputDir
        });
      } else {
        try {
          visualNarrator = runVisualNarratorImpl({
            inputPath: bundle.files.stories,
            outputDir,
            systemName: trimToString(bundle.appContext.appName) || trimToString(bundle.appContext.moduleName) || "System",
            repoRoot: process.cwd(),
            progress: (message) => progress(`Stage 2/10: Visual Narrator ${message}`)
          });
        } catch (err) {
          if (err && err.name === "VisualNarratorError") {
            throw new PlanGeneratorError(err.message, [err.details && err.details.stderr ? err.details.stderr : ""].filter(Boolean));
          }
          throw err;
        }
      }
    } else {
      try {
        visualNarrator = runVisualNarratorImpl({
          inputPath: bundle.files.stories,
          outputDir,
          systemName: trimToString(bundle.appContext.appName) || trimToString(bundle.appContext.moduleName) || "System",
          repoRoot: process.cwd(),
          progress: (message) => progress(`Stage 2/10: Visual Narrator ${message}`)
        });
      } catch (err) {
        if (err && err.name === "VisualNarratorError") {
          throw new PlanGeneratorError(err.message, [err.details && err.details.stderr ? err.details.stderr : ""].filter(Boolean));
        }
        throw err;
      }
    }
  } else {
    progress("Stage 2/10: Visual Narrator disabled (--no-vn).");
  }

  if (useProcessVisualizer) {
    progress("Stage 3/10: Running Process Visualizer process extraction...");
    if (bundle.inputDir) {
      try {
        processVisualizer = loadInputProcessVisualizerResult({
          inputDir: bundle.inputDir,
          outputDir
        });
        if (processVisualizer && processVisualizer.command) {
          progress("Stage 3/10: Using Process Visualizer input artifacts from input directory.");
        }
      } catch (_err) {
        processVisualizer = null;
      }
      if (processVisualizer) {
        // Loaded from input artifacts; skip inline execution.
      } else if (mockProcessVisualizerResponsePath) {
        processVisualizer = loadMockProcessVisualizerResult({
          mockPath: mockProcessVisualizerResponsePath,
          outputDir
        });
      } else {
        try {
          processVisualizer = runProcessVisualizerImpl({
            inputPath: bundle.files.stories,
            outputDir,
            model: processVisualizerModel || model,
            ollamaUrl,
            repoRoot: process.cwd(),
            progress: (message) => progress(`Stage 3/10: Process Visualizer ${message}`)
          });
        } catch (err) {
          if (err && err.name === "ProcessVisualizerError") {
            const detailLines = [err.details && err.details.stderr ? err.details.stderr : ""].filter(Boolean);
            if (strictProcessVisualizer) {
              throw new PlanGeneratorError(err.message, detailLines);
            }
            const warning = detailLines.length > 0 ? `${err.message} ${detailLines.join(" ")}` : err.message;
            progress(`Stage 3/10: Process Visualizer unavailable; continuing without process evidence (${err.message}).`);
            processVisualizer = createProcessVisualizerState({
              enabled: true,
              status: "failed",
              durationMs: err.details && Number.isFinite(Number(err.details.durationMs)) ? Number(err.details.durationMs) : 0,
              command: err.details && err.details.command
                ? [err.details.command.command].concat(err.details.command.args || []).join(" ")
                : "",
              warnings: [warning],
              error: err.message
            });
          } else {
            throw err;
          }
        }
      }
    } else {
      try {
        processVisualizer = runProcessVisualizerImpl({
          inputPath: bundle.files.stories,
          outputDir,
          model: processVisualizerModel || model,
          ollamaUrl,
          repoRoot: process.cwd(),
          progress: (message) => progress(`Stage 3/10: Process Visualizer ${message}`)
        });
      } catch (err) {
        if (err && err.name === "ProcessVisualizerError") {
          const detailLines = [err.details && err.details.stderr ? err.details.stderr : ""].filter(Boolean);
          if (strictProcessVisualizer) {
            throw new PlanGeneratorError(err.message, detailLines);
          }
          const warning = detailLines.length > 0 ? `${err.message} ${detailLines.join(" ")}` : err.message;
          progress(`Stage 3/10: Process Visualizer unavailable; continuing without process evidence (${err.message}).`);
          processVisualizer = createProcessVisualizerState({
            enabled: true,
            status: "failed",
            durationMs: err.details && Number.isFinite(Number(err.details.durationMs)) ? Number(err.details.durationMs) : 0,
            command: err.details && err.details.command
              ? [err.details.command.command].concat(err.details.command.args || []).join(" ")
              : "",
            warnings: [warning],
            error: err.message
          });
        } else {
          throw err;
        }
      }
    }
  } else {
    progress("Stage 3/10: Process Visualizer disabled (--no-process-viz).");
  }

  return {
    visualNarrator,
    processVisualizer
  };
}

module.exports = {
  runInputBundleStage,
  runPreprocessingStages
};
