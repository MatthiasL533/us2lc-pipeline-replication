const path = require("path");

const {
  PlanGeneratorError,
  generateVisualNarratorArtifactsFromInputDir
} = require("./plan-generator");

function parseArgs(argv) {
  const out = {
    inputDir: "input",
    outputDir: "",
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--input-dir") {
      out.inputDir = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--input-dir=")) {
      out.inputDir = arg.slice("--input-dir=".length);
      continue;
    }
    if (arg === "--output-dir") {
      out.outputDir = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--output-dir=")) {
      out.outputDir = arg.slice("--output-dir=".length);
      continue;
    }
  }

  return out;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node pipeline/generate-vn-cli.js --input-dir=<input-dir> [--output-dir=<dir>]",
      "",
      "Options:",
      "  --input-dir <path>   Input folder containing user-stories.txt (default: input)",
      "  --output-dir <path>  Destination folder for VN artifacts (default: same as input-dir)",
      "  --help               Show this help"
    ].join("\n")
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.inputDir) {
    throw new PlanGeneratorError("--input-dir is required.");
  }

  const startedAt = Date.now();
  function progress(message) {
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(`[generate:vn +${elapsedSec}s] ${message}`);
  }

  const result = generateVisualNarratorArtifactsFromInputDir({
    inputDir: args.inputDir,
    outputDir: args.outputDir ? path.resolve(args.outputDir) : path.resolve(args.inputDir),
    onProgress: progress
  });

  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

if (require.main === module) {
  Promise.resolve(main()).catch((err) => {
    if (err instanceof PlanGeneratorError) {
      console.error(`Failed: ${err.message}`);
      if (Array.isArray(err.details) && err.details.length > 0) {
        console.error(`- ${err.details.join("\n- ")}`);
      }
    } else {
      console.error(`Failed: ${err && err.message ? err.message : String(err)}`);
    }
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  printHelp,
  main
};
