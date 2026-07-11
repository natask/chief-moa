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

const { browserTasksForSession, runsForSession } = require("../server");

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
