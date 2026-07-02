const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  VisualNarratorError,
  buildVisualNarratorCommand,
  normalizeVisualNarratorSummary,
  runVisualNarrator
} = require("./visual-narrator");

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createFakeRepoRoot() {
  const root = mkTmpDir("visual-narrator-repo-");
  writeFile(path.join(root, "visual-narrator", ".venv", "bin", "python"), "");
  writeFile(path.join(root, "src", "scripts", "run_visual_narrator.py"), "# mock");
  return root;
}

function testBuildVisualNarratorCommandUsesRepoLocalVenv() {
  const repoRoot = createFakeRepoRoot();
  const command = buildVisualNarratorCommand({
    inputPath: path.join(repoRoot, "input", "user-stories.txt"),
    systemName: "MySystem",
    repoRoot
  });

  assert(command.command.endsWith(path.join(".venv", "bin", "python")));
  assert(command.args.some((entry) => entry.endsWith(path.join("src", "scripts", "run_visual_narrator.py"))));
  assert(command.args.includes("MySystem"));
}

function testMissingVenvFailsClearly() {
  const repoRoot = mkTmpDir("visual-narrator-missing-venv-");
  writeFile(path.join(repoRoot, "visual-narrator", "README.md"), "x");
  writeFile(path.join(repoRoot, "src", "scripts", "run_visual_narrator.py"), "# mock");

  assert.throws(
    () =>
      runVisualNarrator({
        inputPath: path.join(repoRoot, "input.txt"),
        outputDir: path.join(repoRoot, "out"),
        repoRoot
      }),
    (err) => {
      assert(err instanceof VisualNarratorError);
      assert.equal(err.details.code, "VN_MISSING_VENV");
      return true;
    }
  );
}

function testNonZeroExitProducesActionableError() {
  const repoRoot = createFakeRepoRoot();

  assert.throws(
    () =>
      runVisualNarrator({
        inputPath: path.join(repoRoot, "input.txt"),
        outputDir: path.join(repoRoot, "out"),
        repoRoot,
        spawnSyncImpl: () => ({
          status: 1,
          stdout: "",
          stderr: "Can't find model 'en_core_web_md'"
        })
      }),
    (err) => {
      assert(err instanceof VisualNarratorError);
      assert.equal(err.details.code, "VN_EXIT_NON_ZERO");
      assert(err.message.includes("npm run setup:vn"));
      return true;
    }
  );
}

function testSuccessfulRunWritesArtifacts() {
  const repoRoot = createFakeRepoRoot();
  const outputDir = path.join(repoRoot, "artifacts");
  const mockStdout = JSON.stringify({
    ontology: "Class: :Ticket",
    stories: [{ number: 1, text: "As a user, I want a ticket." }],
    classes: [{ name: "Ticket", parent: "", isRole: false }],
    relationships: [{ name: "owns", domain: "User", range: "Ticket" }],
    inferredRoles: ["User"],
    keyNouns: [{ term: "Ticket", weight: 2 }]
  });

  const result = runVisualNarrator({
    inputPath: path.join(repoRoot, "input.txt"),
    outputDir,
    repoRoot,
    spawnSyncImpl: () => ({
      status: 0,
      stdout: mockStdout,
      stderr: "Initializing Natural Language Processor..."
    })
  });

  assert.equal(result.status, "completed");
  assert.equal(fs.existsSync(result.artifacts.ontologyPath), true);
  assert.equal(fs.existsSync(result.artifacts.storiesPath), true);
  assert.equal(fs.existsSync(result.artifacts.summaryPath), true);
  assert.equal(fs.existsSync(result.artifacts.rawPath), true);
  assert(result.promptText.includes("Preferred entity candidates: Ticket"));
}

function testSummaryFilteringDropsGenericAndDuplicateConcepts() {
  const summary = normalizeVisualNarratorSummary({
    classes: [
      { name: "Task", parent: "", isRole: false },
      { name: "Tasks", parent: "", isRole: false },
      { name: "What", parent: "", isRole: false },
      { name: "Work", parent: "", isRole: false },
      { name: "Employee", parent: "", isRole: true },
      { name: "Task History", parent: "History", isRole: false }
    ],
    relationships: [
      { name: "hasHistory", domain: "Task", range: "Task History" },
      { name: "canSee", domain: "Employee", range: "What" }
    ],
    keyNouns: [
      { term: "Task", weight: 3 },
      { term: "Work", weight: 2 }
    ],
    inferredRoles: ["Employee"]
  });

  assert.deepEqual(summary.classNames, ["Task", "Task History"]);
  assert.equal(summary.relationships.length, 1);
  assert.equal(summary.relationships[0].name, "hasHistory");
  assert.deepEqual(summary.keyNouns.map((entry) => entry.term), ["Task"]);
}

function run() {
  testBuildVisualNarratorCommandUsesRepoLocalVenv();
  testMissingVenvFailsClearly();
  testNonZeroExitProducesActionableError();
  testSuccessfulRunWritesArtifacts();
  testSummaryFilteringDropsGenericAndDuplicateConcepts();
  console.log("visual narrator unit tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
