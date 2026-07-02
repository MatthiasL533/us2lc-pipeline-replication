const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildGeneratedAppName, describeNavigationTarget, normalizeIconCode, normalizeNavigationIconsToHome, planRequiresDataGrid2 } = require("./commander");

function run() {
  const target = describeNavigationTarget("employee_overview");
  assert.equal(target.caption, "Employee");
  assert.equal(typeof target.iconCode, "number");

  const explicit = describeNavigationTarget("audit_reporting");
  assert.equal(explicit.caption, "Audit Reporting");
  assert.equal(typeof explicit.iconCode, "number");
  assert.equal(target.iconCode, 57377);
  assert.equal(explicit.iconCode, 57377);
  assert.equal(normalizeIconCode({ name: "home" }), 57377);
  assert.equal(normalizeIconCode({ code: 57377 }, "audit reporting"), null);
  assert.equal(normalizeIconCode("999999", "employee overview"), null);
  const plan = {
    app: {
      navigation: {
        homePageButtons: [{ pageRef: "home", icon: { name: "tasks" } }],
        menuItems: [{ pageRef: "home", icon: 999999 }]
      }
    }
  };
  assert.equal(normalizeNavigationIconsToHome(plan).normalized, 2);
  assert.deepEqual(plan.app.navigation.homePageButtons[0].icon, { name: "home" });
  assert.deepEqual(plan.app.navigation.menuItems[0].icon, { name: "home" });

  assert.equal(
    planRequiresDataGrid2({
      specs: [
        {
          name: "Example",
          content: [{ type: "dataGrid", widgetMode: "datagrid2", columns: [{ attributeRef: "Name" }] }]
        }
      ]
    }),
    true
  );
  assert.equal(
    planRequiresDataGrid2({
      specs: [
        {
          name: "Example",
          content: [{ type: "dataGrid", widgetMode: "classic", columns: [{ attributeRef: "Name" }] }]
        }
      ]
    }),
    false
  );

  assert.equal(
    buildGeneratedAppName({ createAppNamePrefix: "PLAN_12", seed: 0 }),
    "plan_12-000000"
  );
  assert.equal(
    buildGeneratedAppName({ createAppNamePrefix: "plan10", seed: 1 }),
    "plan10-000001"
  );
  assert.equal(
    buildGeneratedAppName({ createAppName: "Exact App Name", createAppNamePrefix: "PLAN_12", seed: 2 }),
    "Exact App Name"
  );

  const commanderPath = path.join(__dirname, "commander.js");
  const result = spawnSync(process.execPath, [commanderPath], {
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert(String(result.stdout || result.stderr || "").includes("Usage: node"));
  console.log("pipeline commander smoke tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
