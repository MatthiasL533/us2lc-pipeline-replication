const { spawnSync } = require("child_process");
const path = require("path");

function run() {
  if (process.env.PIPELINE_LIVE_SMOKE !== "1") {
    console.log("live smoke: skipped (set PIPELINE_LIVE_SMOKE=1 to enable)");
    return;
  }

  const token = process.env.MENDIX_TOKEN || process.env.MENDIX_PAT;
  if (!token) {
    throw new Error("live smoke requires MENDIX_TOKEN or MENDIX_PAT");
  }

  const planPath =
    process.env.PIPELINE_LIVE_PLAN ||
    path.join(__dirname, "plan-01-library.json");

  const commanderPath = path.join(__dirname, "..", "commander.js");
  const child = spawnSync(process.execPath, [commanderPath, planPath], {
    stdio: "inherit",
    env: process.env
  });

  if (child.status !== 0) {
    throw new Error(`live smoke failed with exit code ${child.status}`);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
