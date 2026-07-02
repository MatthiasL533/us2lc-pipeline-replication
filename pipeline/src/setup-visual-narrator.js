const path = require("path");
const { spawnSync } = require("child_process");

function run(command, args, options = {}) {
  const rendered = [command].concat(args).join(" ");
  console.error(`[setup:vn] ${rendered}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}: ${rendered}`);
  }
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const vnRoot = path.join(repoRoot, "visual-narrator");
  const venvRoot = path.join(vnRoot, ".venv");
  const isWindows = process.platform === "win32";
  const pythonBootstrap = process.env.PYTHON || "python3";
  const venvPython = isWindows
    ? path.join(venvRoot, "Scripts", "python.exe")
    : path.join(venvRoot, "bin", "python");

  run(pythonBootstrap, ["-m", "venv", venvRoot], { cwd: repoRoot });
  run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], { cwd: repoRoot });
  run(venvPython, ["-m", "pip", "install", "--upgrade", "setuptools"], { cwd: repoRoot });
  run(venvPython, ["-m", "pip", "install", "-r", path.join(vnRoot, "requirements.txt")], { cwd: repoRoot });
  run(venvPython, ["-m", "spacy", "download", "en_core_web_md"], { cwd: repoRoot });

  console.error("[setup:vn] Visual Narrator environment is ready.");
}

if (require.main === module) {
  main();
}

module.exports = { main };
