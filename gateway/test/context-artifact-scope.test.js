"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-context-scope-"));
process.env.DATA_DIR = dataDir;
process.env.MOA_MODE = "local";
process.env.ALLOW_AGENT_WITHOUT_TOKEN = "1";
process.env.GBRAIN_BIN = "__missing_gbrain_for_context_test__";
process.env.BRAIN_STORE_DIR = dataDir;

const { brain, browserTasksForSession, buildCanonicalContextArtifact, runsForSession } = require("../server");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("run collection never lets a referenced cross-session or cross-branch run bypass scope", () => {
  writeRecords("agent-runs", [
    run("run-current", "session-a", "branch-a"),
    run("run-other-branch", "session-a", "branch-b"),
    run("run-other-session", "session-b", "branch-a"),
  ]);
  const forgedReferences = [{ references: { agent_run_ids: ["run-other-session", "run-other-branch"] } }];
  assert.deepEqual(
    runsForSession("session-a", forgedReferences, "branch-a").map((item) => item.id),
    ["run-current"],
  );
});

test("fork collection admits only referenced runs from the declared parent branch", () => {
  writeRecords("agent-runs", [
    run("run-current-fork", "session-fork", "child"),
    run("run-parent-referenced", "session-fork", "parent"),
    run("run-parent-unreferenced", "session-fork", "parent"),
    run("run-unrelated", "session-fork", "unrelated"),
  ]);
  const inheritedTurns = [{ references: { agent_run_ids: ["run-parent-referenced", "run-unrelated"] } }];
  assert.deepEqual(
    runsForSession("session-fork", inheritedTurns, "child", "parent").map((item) => item.id).sort(),
    ["run-current-fork", "run-parent-referenced"],
  );
});

test("browser task collection enforces session and branch before returning records", () => {
  writeRecords("browser-tasks", [
    task("task-current", "session-a", "branch-a"),
    task("task-other-branch", "session-a", "branch-b"),
    task("task-other-session", "session-b", "branch-a"),
  ]);
  assert.deepEqual(
    browserTasksForSession("session-a", "branch-a", 10).map((item) => item.id),
    ["task-current"],
  );
});

test("all-branches operational collection still excludes deleted and incognito records", () => {
  writeRecords("agent-runs", [
    run("run-visible-all", "session-all", "feature"),
    { ...run("run-incognito-branch", "session-all", "inc-secret"), incognito: false },
    { ...run("run-incognito-flag", "session-all", "feature"), incognito: true },
    { ...run("run-deleted", "session-all", "feature"), deleted_at: "2026-07-10T01:00:00.000Z" },
  ]);
  writeRecords("browser-tasks", [
    task("task-visible-all", "session-all", "feature"),
    task("task-incognito-branch", "session-all", "inc-task"),
    { ...task("task-incognito-flag", "session-all", "feature"), incognito: true },
    { ...task("task-deleted", "session-all", "feature"), deleted: true },
  ]);
  assert.deepEqual(runsForSession("session-all", [], "").map((item) => [item.id, item.branch_id]), [["run-visible-all", "feature"]]);
  assert.deepEqual(browserTasksForSession("session-all", "", 20).map((item) => [item.id, item.branch_id]), [["task-visible-all", "feature"]]);
});

test("assembly emits standing facts with global non-record provenance and never falls back", () => {
  assert.equal(brain.remember("The user prefers tea.", {
    kind: "standing",
    tags: ["memory", "standing"],
    title: "The user prefers tea.",
    slug: "standing-tea",
  }), true);
  const artifact = buildCanonicalContextArtifact({ sessionId: "standing-session", branchId: "feature", query: "tea" });
  assert.ok(artifact, "standing fact assembly must return the canonical artifact");
  const standing = artifact.sources.find((source) => source.section === "standing");
  assert.ok(standing, "standing fact source must be present");
  assert.equal(standing.branch_id, "", "global standing facts must not borrow a record branch");
});

test("assembly preserves all-branches and fork-parent operational provenance", () => {
  writeRecords("agent-runs", [
    run("run-all-feature", "assembly-all", "feature"),
    run("run-all-other", "assembly-all", "other"),
    run("run-fork-child", "assembly-fork", "child"),
    run("run-fork-parent", "assembly-fork", "parent"),
  ]);
  writeVoiceTurn("assembly-fork", {
    id: "parent-turn",
    branch_id: "parent",
    transcript: "parent work",
    response: { display: "done" },
    references: { agent_run_ids: ["run-fork-parent"] },
    created_at: "2026-07-10T00:00:00.000Z",
  });
  const allBranches = buildCanonicalContextArtifact({ sessionId: "assembly-all", branchId: "default", allBranches: true });
  assert.deepEqual(
    allBranches.sources.filter((source) => source.section === "runs").map((source) => source.branch_id).sort(),
    ["feature", "other"],
  );
  const fork = buildCanonicalContextArtifact({
    sessionId: "assembly-fork",
    branchId: "child",
    inheritFrom: { branchId: "parent", uptoCreatedAt: "2026-07-10T00:00:01.000Z" },
  });
  assert.deepEqual(
    fork.sources.filter((source) => source.section === "runs").map((source) => [source.source_id, source.branch_id]).sort(),
    [["run:run-fork-child", "child"], ["run:run-fork-parent", "parent"]],
  );
});

function writeRecords(directory, records) {
  const target = path.join(dataDir, directory);
  fs.mkdirSync(target, { recursive: true });
  for (const record of records) fs.writeFileSync(path.join(target, `${record.id}.json`), JSON.stringify(record));
}

function run(id, conversationId, branchId) {
  return {
    id,
    conversation_id: conversationId,
    branch_id: branchId,
    status: "completed",
    harness: "echo",
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
  };
}

function task(id, conversationId, branchId) {
  return {
    id,
    conversation_id: conversationId,
    branch_id: branchId,
    status: "completed",
    instruction: "bounded fixture",
    receipts: [],
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
  };
}

function writeVoiceTurn(sessionId, record) {
  const target = path.join(dataDir, "voice-turns", sessionId);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, `${record.id}.json`), JSON.stringify(record));
}
