const path = require("path");

const { checkPlanFile } = require("./lib/plan-checker");

function parseArgs(argv) {
  const out = {
    planPath: "",
    inputDir: ""
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plan") out.planPath = argv[++i] || "";
    else if (arg.startsWith("--plan=")) out.planPath = arg.slice("--plan=".length);
    else if (arg === "--input-dir") out.inputDir = argv[++i] || "";
    else if (arg.startsWith("--input-dir=")) out.inputDir = arg.slice("--input-dir=".length);
  }

  return out;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node pipeline/plan-checker.js --plan=<path-to-plan.json> [--input-dir=<input-dir>]",
      "",
      "Options:",
      "  --plan <path>                 Path to plan JSON to evaluate",
      "  --input-dir <path>            Optional input folder for story coverage recomputation"
    ].join("\n")
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");
  if (wantsHelp || !args.planPath) {
    printHelp();
    process.exit(wantsHelp ? 0 : 1);
  }

  const result = checkPlanFile(path.resolve(args.planPath), {
    inputDir: args.inputDir ? path.resolve(args.inputDir) : ""
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  printHelp,
  main
};
