const path = require("path");

const {
  compareBenchmarkModels,
  comparePlanFiles,
  renderMarkdownBenchmarkComparison,
  renderMarkdownDiff
} = require("./lib/plan-diff");

function parseArgs(argv) {
  const out = {
    leftPath: "",
    rightPath: "",
    benchmarkDir: "",
    leftLabel: "",
    rightLabel: "",
    format: "markdown"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--left") out.leftPath = argv[++i] || "";
    else if (arg.startsWith("--left=")) out.leftPath = arg.slice("--left=".length);
    else if (arg === "--right") out.rightPath = argv[++i] || "";
    else if (arg.startsWith("--right=")) out.rightPath = arg.slice("--right=".length);
    else if (arg === "--benchmark-dir") out.benchmarkDir = argv[++i] || "";
    else if (arg.startsWith("--benchmark-dir=")) out.benchmarkDir = arg.slice("--benchmark-dir=".length);
    else if (arg === "--left-label") out.leftLabel = argv[++i] || "";
    else if (arg.startsWith("--left-label=")) out.leftLabel = arg.slice("--left-label=".length);
    else if (arg === "--right-label") out.rightLabel = argv[++i] || "";
    else if (arg.startsWith("--right-label=")) out.rightLabel = arg.slice("--right-label=".length);
    else if (arg === "--format") out.format = argv[++i] || "markdown";
    else if (arg.startsWith("--format=")) out.format = arg.slice("--format=".length);
  }

  return out;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node pipeline/plan-diff.js --left=<plan-a.json> --right=<plan-b.json> [--format=markdown|json]",
      "  node pipeline/plan-diff.js --benchmark-dir=<benchmark-run-dir> [--format=markdown|json]",
      "",
      "Options:",
      "  --left <path>                First plan file",
      "  --right <path>               Second plan file",
      "  --benchmark-dir <path>       Compare all models found in a benchmark run folder",
      "  --left-label <text>          Optional label for first plan",
      "  --right-label <text>         Optional label for second plan",
      "  --format <markdown|json>     Output format (default: markdown)"
    ].join("\n")
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");
  const isBenchmarkMode = Boolean(args.benchmarkDir);
  const missingPairArgs = !isBenchmarkMode && (!args.leftPath || !args.rightPath);
  if (wantsHelp || missingPairArgs) {
    printHelp();
    process.exit(wantsHelp ? 0 : 1);
  }

  const result = isBenchmarkMode
    ? compareBenchmarkModels(path.resolve(args.benchmarkDir))
    : comparePlanFiles({
        leftPath: path.resolve(args.leftPath),
        rightPath: path.resolve(args.rightPath),
        leftLabel: args.leftLabel,
        rightLabel: args.rightLabel
      });

  if (String(args.format).toLowerCase() === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(isBenchmarkMode ? renderMarkdownBenchmarkComparison(result) : renderMarkdownDiff(result));
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  parseArgs,
  printHelp
};
