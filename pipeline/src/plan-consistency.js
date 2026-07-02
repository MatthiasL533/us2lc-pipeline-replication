const fs = require("fs");
const path = require("path");

const { analyzePlanConsistency } = require("./lib/plan-consistency");
const { checkPlanFile } = require("./lib/plan-checker");

function parseArgs(argv) {
  const out = {
    model: "",
    plans: [],
    inputDir: ""
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model") out.model = argv[++i] || "";
    else if (arg.startsWith("--model=")) out.model = arg.slice("--model=".length);
    else if (arg === "--plan") out.plans.push(argv[++i] || "");
    else if (arg.startsWith("--plan=")) out.plans.push(arg.slice("--plan=".length));
    else if (arg === "--plans-file") out.plans.push(...readPlanList(argv[++i] || ""));
    else if (arg.startsWith("--plans-file=")) out.plans.push(...readPlanList(arg.slice("--plans-file=".length)));
    else if (arg === "--input-dir") out.inputDir = argv[++i] || "";
    else if (arg.startsWith("--input-dir=")) out.inputDir = arg.slice("--input-dir=".length);
  }

  return out;
}

function readPlanList(filePath) {
  if (!filePath) return [];
  return String(fs.readFileSync(filePath, "utf8"))
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node pipeline/plan-consistency.js --model=<name> --plan=<plan.json> [--plan=<plan2.json> ...]",
      "",
      "Options:",
      "  --model <name>                Model label",
      "  --plan <path>                 Plan path to include (repeatable)",
      "  --plans-file <path>           Text file with one plan path per line",
      "  --input-dir <path>            Optional input folder for checker story coverage"
    ].join("\n")
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");
  if (wantsHelp || args.plans.length === 0) {
    printHelp();
    process.exit(wantsHelp ? 0 : 1);
  }

  const runs = args.plans.map((planPath, index) => {
    const resolved = path.resolve(planPath);
    const checker = checkPlanFile(resolved, {
      inputDir: args.inputDir ? path.resolve(args.inputDir) : ""
    });
    return {
      runId: `run-${index + 1}`,
      checker,
      plan: checker.jsonParseValid ? JSON.parse(fs.readFileSync(resolved, "utf8")) : null
    };
  });

  const result = analyzePlanConsistency(runs, { model: args.model });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  printHelp,
  main,
  readPlanList
};
