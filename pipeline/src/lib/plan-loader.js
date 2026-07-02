const fs = require("fs");

function requireSdkPackage(pkgName) {
  return require(pkgName);
}

function loadPlanFile(planPath) {
  const raw = fs.readFileSync(planPath, "utf8");
  return JSON.parse(raw);
}

module.exports = {
  requireSdkPackage,
  loadPlanFile
};
