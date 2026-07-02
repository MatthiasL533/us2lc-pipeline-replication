const fs = require("fs");
const path = require("path");

const { parseSpecs } = require("./pack-merger");
const { normalizePlan, jaccard } = require("./plan-consistency");
const { checkPlanObject } = require("./plan-checker");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b)));
}

function diffSets(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return {
    shared: uniqueSorted([...leftSet].filter((value) => rightSet.has(value))),
    onlyLeft: uniqueSorted([...leftSet].filter((value) => !rightSet.has(value))),
    onlyRight: uniqueSorted([...rightSet].filter((value) => !leftSet.has(value)))
  };
}

function collectStepTypes(steps = [], out = []) {
  for (const step of safeArray(steps)) {
    if (!step || typeof step !== "object") continue;
    if (step.type) out.push(String(step.type));
    collectStepTypes(step.content, out);
    collectStepTypes(step.templateContent, out);
    collectStepTypes(step.itemContent, out);
  }
  return out;
}

function buildPlanShape(plan) {
  const normalized = normalizePlan(plan);
  return {
    entities: uniqueSorted(safeArray(normalized.domainModel && normalized.domainModel.entities).map((entity) => entity.name)),
    associations: uniqueSorted(
      safeArray(normalized.domainModel && normalized.domainModel.associations).map((assoc) =>
        [assoc.parentEntity, assoc.childEntity, assoc.name].join("->")
      )
    ),
    pages: uniqueSorted(parseSpecs(normalized.pages).map((page) => page.ref || page.name)),
    microflows: uniqueSorted(parseSpecs(normalized.microflows).map((item) => item.ref || item.name)),
    nanoflows: uniqueSorted(parseSpecs(normalized.nanoflows).map((item) => item.ref || item.name)),
    workflows: uniqueSorted(parseSpecs(normalized.workflows).map((item) => item.ref || item.name)),
    pageStepTypes: uniqueSorted(parseSpecs(normalized.pages).flatMap((page) => collectStepTypes(page && page.content)))
  };
}

function comparePlans({ leftPlan, rightPlan, leftLabel = "left", rightLabel = "right" }) {
  const leftShape = buildPlanShape(leftPlan);
  const rightShape = buildPlanShape(rightPlan);
  const leftChecker = checkPlanObject(leftPlan);
  const rightChecker = checkPlanObject(rightPlan);

  const sections = {
    entities: diffSets(leftShape.entities, rightShape.entities),
    associations: diffSets(leftShape.associations, rightShape.associations),
    pages: diffSets(leftShape.pages, rightShape.pages),
    microflows: diffSets(leftShape.microflows, rightShape.microflows),
    nanoflows: diffSets(leftShape.nanoflows, rightShape.nanoflows),
    workflows: diffSets(leftShape.workflows, rightShape.workflows),
    pageStepTypes: diffSets(leftShape.pageStepTypes, rightShape.pageStepTypes)
  };

  return {
    ok: true,
    labels: {
      left: leftLabel,
      right: rightLabel
    },
    similarity: {
      entityJaccard: jaccard(leftShape.entities, rightShape.entities),
      associationJaccard: jaccard(leftShape.associations, rightShape.associations),
      pageJaccard: jaccard(leftShape.pages, rightShape.pages),
      pageStepTypeJaccard: jaccard(leftShape.pageStepTypes, rightShape.pageStepTypes)
    },
    validation: {
      left: {
        jsonParseValid: true,
        schemaValid: leftChecker.schemaValid,
        storyCoverageScore: leftChecker.storyCoverageScore,
        artifactCounts: leftChecker.artifactCounts,
        stubFlags: leftChecker.stubFlags.flags
      },
      right: {
        jsonParseValid: true,
        schemaValid: rightChecker.schemaValid,
        storyCoverageScore: rightChecker.storyCoverageScore,
        artifactCounts: rightChecker.artifactCounts,
        stubFlags: rightChecker.stubFlags.flags
      }
    },
    differences: sections
  };
}

function comparePlanFiles({ leftPath, rightPath, leftLabel, rightLabel }) {
  const leftPlan = readJson(leftPath);
  const rightPlan = readJson(rightPath);
  return comparePlans({
    leftPlan,
    rightPlan,
    leftLabel: leftLabel || path.basename(leftPath),
    rightLabel: rightLabel || path.basename(rightPath)
  });
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function collectPlanPathsForBenchmarkModel(modelDir) {
  if (!fs.existsSync(modelDir)) return [];
  return fs
    .readdirSync(modelDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^run-\d+$/i.test(entry.name))
    .map((entry) => path.join(modelDir, entry.name, "plan.json"))
    .filter((planPath) => fs.existsSync(planPath))
    .sort((a, b) => a.localeCompare(b));
}

function compareModelPlanSets({ leftLabel, rightLabel, leftPlanPaths, rightPlanPaths }) {
  const comparisons = [];
  for (const leftPath of leftPlanPaths) {
    for (const rightPath of rightPlanPaths) {
      comparisons.push(
        comparePlanFiles({
          leftPath,
          rightPath,
          leftLabel,
          rightLabel
        })
      );
    }
  }

  return {
    ok: comparisons.length > 0,
    labels: {
      left: leftLabel,
      right: rightLabel
    },
    comparedPairs: comparisons.length,
    leftRunCount: leftPlanPaths.length,
    rightRunCount: rightPlanPaths.length,
    aggregateSimilarity: {
      entityJaccardMean: mean(comparisons.map((item) => item.similarity.entityJaccard)),
      associationJaccardMean: mean(comparisons.map((item) => item.similarity.associationJaccard)),
      pageJaccardMean: mean(comparisons.map((item) => item.similarity.pageJaccard)),
      pageStepTypeJaccardMean: mean(comparisons.map((item) => item.similarity.pageStepTypeJaccard))
    },
    sampleDifference: comparisons[0] || null
  };
}

function compareBenchmarkModels(benchmarkDir) {
  const benchmarkResultsPath = path.join(benchmarkDir, "benchmark-results.json");
  const benchmarkResults = fs.existsSync(benchmarkResultsPath) ? readJson(benchmarkResultsPath) : null;

  const modelLabels = benchmarkResults && Array.isArray(benchmarkResults.models)
    ? benchmarkResults.models.map((entry) => entry.model)
    : fs
        .readdirSync(benchmarkDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

  const discoveredModels = [];
  for (const entry of fs.readdirSync(benchmarkDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const planPaths = collectPlanPathsForBenchmarkModel(path.join(benchmarkDir, entry.name));
    if (planPaths.length === 0) continue;
    const mappedLabel =
      benchmarkResults &&
      Array.isArray(benchmarkResults.models) &&
      benchmarkResults.models.find((model) => {
        const sampleRun = model && Array.isArray(model.runs) ? model.runs[0] : null;
        return sampleRun && sampleRun.runDir && path.basename(path.dirname(sampleRun.runDir)) === entry.name;
      });

    discoveredModels.push({
      slug: entry.name,
      label: mappedLabel ? mappedLabel.model : entry.name,
      planPaths
    });
  }

  const pairs = [];
  for (let i = 0; i < discoveredModels.length; i += 1) {
    for (let j = i + 1; j < discoveredModels.length; j += 1) {
      const left = discoveredModels[i];
      const right = discoveredModels[j];
      pairs.push(
        compareModelPlanSets({
          leftLabel: left.label,
          rightLabel: right.label,
          leftPlanPaths: left.planPaths,
          rightPlanPaths: right.planPaths
        })
      );
    }
  }

  const matrix = {};
  for (const model of discoveredModels) {
    matrix[model.label] = {};
  }
  for (const pair of pairs) {
    matrix[pair.labels.left][pair.labels.right] = pair.aggregateSimilarity;
    matrix[pair.labels.right][pair.labels.left] = pair.aggregateSimilarity;
  }
  for (const model of discoveredModels) {
    matrix[model.label][model.label] = {
      entityJaccardMean: 1,
      associationJaccardMean: 1,
      pageJaccardMean: 1,
      pageStepTypeJaccardMean: 1
    };
  }

  return {
    ok: true,
    benchmarkDir,
    models: discoveredModels.map((model) => ({
      label: model.label,
      slug: model.slug,
      runCount: model.planPaths.length
    })),
    pairwise: pairs,
    matrix
  };
}

function renderMarkdownDiff(result) {
  const lines = [
    "# Plan Diff",
    "",
    `Comparing **${result.labels.left}** vs **${result.labels.right}**.`,
    "",
    "## Similarity",
    "",
    `- Entity Jaccard: ${result.similarity.entityJaccard.toFixed(3)}`,
    `- Association Jaccard: ${result.similarity.associationJaccard.toFixed(3)}`,
    `- Page Jaccard: ${result.similarity.pageJaccard.toFixed(3)}`,
    `- Page step-type Jaccard: ${result.similarity.pageStepTypeJaccard.toFixed(3)}`,
    "",
    "## Validation Snapshot",
    "",
    `- ${result.labels.left}: schemaValid=${result.validation.left.schemaValid}, coverage=${result.validation.left.storyCoverageScore === null ? "n/a" : result.validation.left.storyCoverageScore}`,
    `- ${result.labels.right}: schemaValid=${result.validation.right.schemaValid}, coverage=${result.validation.right.storyCoverageScore === null ? "n/a" : result.validation.right.storyCoverageScore}`,
    ""
  ];

  for (const [sectionName, section] of Object.entries(result.differences)) {
    lines.push(`## ${sectionName}`);
    lines.push("");
    lines.push(`- Shared (${section.shared.length}): ${section.shared.join(", ") || "(none)"}`);
    lines.push(`- Only ${result.labels.left} (${section.onlyLeft.length}): ${section.onlyLeft.join(", ") || "(none)"}`);
    lines.push(`- Only ${result.labels.right} (${section.onlyRight.length}): ${section.onlyRight.join(", ") || "(none)"}`);
    lines.push("");
  }

  return lines.join("\n");
}

function renderMarkdownBenchmarkComparison(result) {
  const lines = [
    "# Benchmark Model Comparison",
    "",
    `Source benchmark: ${result.benchmarkDir}`,
    "",
    "## Models",
    ""
  ];

  for (const model of result.models) {
    lines.push(`- ${model.label} (${model.runCount} runs)`);
  }

  lines.push("", "## Pairwise Similarity", "");
  lines.push("| Left | Right | Entity | Association | Page | Step types |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const pair of result.pairwise) {
    lines.push(
      `| ${pair.labels.left} | ${pair.labels.right} | ${pair.aggregateSimilarity.entityJaccardMean.toFixed(3)} | ${pair.aggregateSimilarity.associationJaccardMean.toFixed(3)} | ${pair.aggregateSimilarity.pageJaccardMean.toFixed(3)} | ${pair.aggregateSimilarity.pageStepTypeJaccardMean.toFixed(3)} |`
    );
  }

  return lines.join("\n");
}

module.exports = {
  buildPlanShape,
  collectPlanPathsForBenchmarkModel,
  compareBenchmarkModels,
  comparePlanFiles,
  compareModelPlanSets,
  comparePlans,
  diffSets,
  renderMarkdownBenchmarkComparison,
  renderMarkdownDiff
};
