import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { buildRegistryIndex, parseClosureLedger, parseRegistryEvents, parseWorktreePorcelain } from "./worktree-registry.mjs";

const NOW = "2026-08-03T12:00:00.000Z";

function worktree(overrides = {}) {
  return {
    path: "/repo",
    head: "a".repeat(40),
    branch: "refs/heads/master",
    primary: true,
    bare: false,
    prunable: false,
    exists: true,
    dirty: false,
    integration_state: "contained",
    ...overrides,
  };
}

function index(input = {}) {
  return buildRegistryIndex({ worktrees: [], claims: [], closures: [], warnings: [], generatedAt: NOW, targetRef: "master", targetSha: "f".repeat(40), ...input });
}

test("parses NUL-delimited porcelain without losing spaces or detached state", () => {
  const parsed = parseWorktreePorcelain([
    "worktree /repo with spaces", `HEAD ${"a".repeat(40)}`, "branch refs/heads/master", "",
    "worktree /tmp/detached", `HEAD ${"b".repeat(40)}`, "detached", "prunable stale metadata", "",
  ].join("\0"));
  assert.deepEqual(parsed, [
    { path: "/repo with spaces", head: "a".repeat(40), branch: "refs/heads/master", bare: false, prunable: false },
    { path: "/tmp/detached", head: "b".repeat(40), branch: "detached", bare: false, prunable: true },
  ]);
});

test("classifies live states and reverse-maps durable claim evidence", () => {
  const result = index({
    worktrees: [
      worktree(),
      worktree({ path: "/repo/feature", branch: "refs/heads/feature", primary: false, integration_state: "unique", dirty: true }),
      worktree({ path: "/repo/closed", branch: "refs/heads/closed", primary: false, integration_state: "contained" }),
    ],
    claims: [{ claim_id: "claim-1", worktree_path: "/repo/feature", branch: "refs/heads/feature", task_id: "S0.3", candidate_id: "candidate-1", path_claims: ["scripts"] }],
  });
  assert.deepEqual(result.worktrees.map(({ path: itemPath, lifecycle_state: state }) => [itemPath, state]), [
    ["/repo", "idle-on-master"],
    ["/repo/closed", "closable"],
    ["/repo/feature", "active"],
  ]);
  assert.deepEqual(result.reverse_index.by_branch["refs/heads/feature"], ["/repo/feature"]);
  assert.deepEqual(result.reverse_index.by_path_claim.scripts, ["/repo/feature"]);
  assert.deepEqual(result.worktrees[2].task_ids, ["S0.3"]);
});

test("blocks duplicate branches, overlapping claims, missing claim owners, and stale closure reuse", () => {
  const head = "c".repeat(40);
  const result = index({
    worktrees: [
      worktree({ path: "/one", head, branch: "refs/heads/shared", primary: false }),
      worktree({ path: "/two", branch: "refs/heads/shared", primary: false }),
    ],
    claims: [
      { claim_id: "one", worktree_path: "/one", path_claims: ["gateway"] },
      { claim_id: "two", worktree_path: "/two", path_claims: ["gateway/server.js"] },
      { claim_id: "gone", worktree_path: "/gone", task_id: "lost", path_claims: ["android_app"] },
    ],
    closures: [{ path: "/one", head, classification: "contained" }],
  });
  assert.deepEqual(result.worktrees.map((item) => item.lifecycle_state), ["blocked", "blocked"]);
  assert.equal(result.conflicts.duplicate_branches.length, 1);
  assert.deepEqual(result.conflicts.overlapping_path_claims[0].overlaps, [{ left: "gateway", right: "gateway/server.js" }]);
  assert.equal(result.orphans.claims[0].claim_id, "gone");
  assert.equal(result.worktrees[0].closure_state, "closure-receipt-matches-live-worktree");
});

test("registry event and closure parsers retain valid evidence and report bad lines", () => {
  const event = { schema_version: 1, event_type: "worktree.claim.recorded", claim_id: "c", worktree_path: "/repo" };
  const parsed = parseRegistryEvents(`${JSON.stringify(event)}\nnot-json\n${JSON.stringify({ schema_version: 2, event_type: "future" })}\n`);
  assert.deepEqual(parsed.events, [event]);
  assert.deepEqual(parsed.warnings, [{ line: 2, reason: "invalid JSON" }, { line: 3, reason: "unsupported registry event" }]);
  assert.deepEqual(parseClosureLedger("closed_at\tpath\thead\nnow\t/repo\tabc\n"), [{ closed_at: "now", path: "/repo", head: "abc" }]);
});

test("audit leaves registry absent while reconcile writes append-only events and atomic JSON", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-registry-"));
  const registry = path.join(root, "registry");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "master", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.test"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "fixture\n");
  execFileSync("git", ["-C", root, "add", "tracked.txt"]);
  execFileSync("git", ["-C", root, "commit", "-m", "test: fixture"]);
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), "worktree-registry.mjs");
  const before = execFileSync("git", ["-C", root, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8" });

  const audit = JSON.parse(execFileSync(process.execPath, [script, "audit", "--cwd", root, "--registry-dir", registry, "--json"], { encoding: "utf8" }));
  assert.equal(audit.worktrees[0].lifecycle_state, "idle-on-master");
  assert.equal(fs.existsSync(registry), false);
  assert.equal(execFileSync("git", ["-C", root, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8" }), before);
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain=v1"], { encoding: "utf8" }), "");

  execFileSync(process.execPath, [script, "reconcile", "--cwd", root, "--registry-dir", registry, "--json"]);
  const stored = JSON.parse(fs.readFileSync(path.join(registry, "index.json"), "utf8"));
  const events = fs.readFileSync(path.join(registry, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(stored.summary.idle_on_master, 1);
  assert.equal(events[0].event_type, "worktree.registry.reconciled");
  assert.deepEqual(fs.readdirSync(registry).sort(), ["events.jsonl", "index.json"]);
});
