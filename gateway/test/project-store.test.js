"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProjectStore, sanitizeProjectBrief, promptWithProjectBrief } = require("../lib/project-store");

function harness(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-project-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const store = createProjectStore({
    filePath: path.join(dir, "projects.json"),
    sanitizeId: (id) => { if (!id || String(id).includes("/")) throw new Error("bad id"); return String(id); },
    resolveWorkingDir: (value) => { calls.push(["dir", value]); return value || "/safe"; },
    sanitizeHarness: (value) => { calls.push(["harness", value]); return String(value); },
    defaultHarness: "echo",
    randomId: (prefix) => `${prefix}_1`,
    now: overrides.now || (() => "2026-07-15T00:00:00Z"),
  });
  return { dir, filePath: path.join(dir, "projects.json"), store, calls };
}

test("store creates, lists, finds, reloads, updates, and preserves immutable fields", (t) => {
  let tick = 0;
  const h = harness(t, { now: () => `2026-07-15T00:00:0${tick++}Z` });
  assert.deepEqual(h.store.list(), []);
  const created = h.store.create({ name: ` ${"N".repeat(140)} `, cwd: "/work", brief: { problem: "p", outcome: "o" } });
  assert.equal(created.id, "proj_1");
  assert.equal(created.name.length, 120);
  assert.equal(created.working_dir, "/work");
  assert.equal(created.default_harness, "echo");
  assert.equal(created.brief.desired_outcome, "o");
  assert.equal(h.store.find("proj_1").name, created.name);
  assert.equal(h.store.find("missing"), null);
  assert.throws(() => h.store.find("bad/id"), /bad id/);

  const updated = h.store.update("proj_1", { brief: { next_step: "next" } });
  assert.equal(updated.name, created.name);
  assert.equal(updated.brief.problem, "p");
  assert.equal(updated.brief.next_step, "next");
  assert.notEqual(updated.updated_at, created.updated_at);
  assert.equal(h.store.update("missing", {}), null);

  const reloaded = createProjectStore({
    filePath: h.filePath, sanitizeId: String, resolveWorkingDir: String,
    sanitizeHarness: String, randomId: () => "unused",
  });
  assert.equal(reloaded.list()[0].brief.next_step, "next");
});

test("store validates names, supports aliases, and tolerates corrupt or non-array state", (t) => {
  const h = harness(t);
  assert.throws(() => h.store.create(), /name is required/);
  assert.throws(() => h.store.create({ name: "   " }), /name is required/);
  const created = h.store.create({ name: "Project", working_dir: "/one", default_harness: "codex", state: "working" });
  assert.deepEqual(h.calls, [["dir", "/one"], ["harness", "codex"]]);
  assert.equal(created.brief.current_state, "working");
  h.store.update(created.id, null);
  assert.equal(h.store.find(created.id).brief.current_state, "working");

  fs.writeFileSync(h.filePath, "{");
  assert.deepEqual(h.store.list(), []);
  fs.writeFileSync(h.filePath, JSON.stringify({ projects: [] }));
  assert.deepEqual(h.store.list(), []);
});

test("brief normalization bounds aliases, primitives, arrays, and all fields", () => {
  assert.deepEqual(sanitizeProjectBrief(null), { problem: "", desired_outcome: "", current_state: "", next_step: "" });
  assert.deepEqual(sanitizeProjectBrief([]), { problem: "", desired_outcome: "", current_state: "", next_step: "" });
  const brief = sanitizeProjectBrief({
    problem: " p ", outcome: "o".repeat(5000), state: "s".repeat(13000), next_step: 42,
  });
  assert.equal(brief.problem, "p");
  assert.equal(brief.desired_outcome.length, 4000);
  assert.equal(brief.current_state.length, 12000);
  assert.equal(brief.next_step, "42");
});

test("project prompt remains unchanged without context and renders every brief field", () => {
  assert.equal(promptWithProjectBrief("do it", null), "do it");
  assert.equal(promptWithProjectBrief("do it", { brief: {} }), "do it");
  let prompt = promptWithProjectBrief("do it", { id: "p1", brief: { problem: "P", outcome: "O", state: "S", next_step: "N" } });
  assert.match(prompt, /Durable project brief \(p1\)/);
  assert.match(prompt, /Problem: P/);
  assert.match(prompt, /Desired outcome: O/);
  assert.match(prompt, /Current state: S/);
  assert.match(prompt, /Next viable step: N/);
  prompt = promptWithProjectBrief("do it", { name: "Named", id: "p1", brief: { problem: "P" } });
  assert.match(prompt, /Durable project brief \(Named\)/);
});

test("default clock produces an ISO timestamp", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-project-clock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createProjectStore({
    filePath: path.join(dir, "projects.json"), sanitizeId: String,
    resolveWorkingDir: () => "/safe", sanitizeHarness: String,
    randomId: () => "proj_clock", defaultHarness: "echo",
  });
  assert.match(store.create({ name: "Clock" }).created_at, /^\d{4}-\d{2}-\d{2}T/);
});
