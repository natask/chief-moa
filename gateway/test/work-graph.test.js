"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createWorkGraphStore, effectiveInstruction, STATUSES, EXECUTOR_KINDS } = require("../lib/work-graph");

function harness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-graph-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createWorkGraphStore({ dataDir }) };
}

test("store constants and storage selection remain explicit", () => {
  assert.deepEqual(STATUSES, ["open", "running", "blocked", "done"]);
  assert.deepEqual(EXECUTOR_KINDS, ["none", "local", "devin"]);
  const postgres = createWorkGraphStore({ pool: {}, initialize: false });
  assert.equal(postgres.storageInfo().postgres_configured, true);
});

test("nodes default, fork context, list newest-first, and clone reads", (t) => {
  const { store } = harness(t);
  const root = store.create({});
  assert.equal(root.title, "untitled");
  assert.equal(root.intent, "untitled");
  assert.equal(root.parentId, null);
  assert.deepEqual(root.executor, { kind: "none", ref: null });
  assert.deepEqual(store.statuses(), STATUSES);
  assert.throws(() => store.create({ parentId: "missing" }), /parent node not found/);

  store.addContextRefs(root.id, [" ctx-1 ", "", null, "ctx-1", "ctx-2"]);
  const child = store.create({ title: " child ", intent: " do it ", parentId: root.id });
  assert.deepEqual(child.contextRefs, ["ctx-1", "ctx-2"]);
  assert.deepEqual(store.children(root.id).map((node) => node.id), [child.id]);
  const listed = store.list();
  assert.equal(listed.length, 2);
  assert.equal(store.list({ status: "open" }).length, 2);
  assert.equal(store.list({ status: "invalid" }).length, 2);
  listed[0].title = "mutated";
  assert.notEqual(store.get(listed[0].id).title, "mutated");
  assert.equal(store.get("missing"), null);
});

test("queue, corrections, status, context, executor, and missing mutations are bounded", (t) => {
  const { store } = harness(t);
  const node = store.create({ title: "task", intent: "original" });
  assert.equal(store.enqueue(node.id, "  ").queue.length, 0);
  assert.equal(store.enqueue("missing", "work"), null);
  store.enqueue(node.id, "first");
  store.enqueue(node.id, "second");
  assert.equal(store.dequeue(node.id).item.text, "first");
  assert.equal(store.dequeue(node.id).item.text, "second");
  assert.equal(store.dequeue(node.id).item, null);
  assert.deepEqual(store.dequeue("missing"), { node: null, item: null });

  assert.equal(effectiveInstruction(null), "");
  assert.equal(effectiveInstruction(store.get(node.id)), "original");
  assert.equal(store.applyCorrection(node.id, null).corrections.length, 0);
  store.applyCorrection(node.id, "first correction");
  store.applyCorrection(node.id, "latest correction");
  assert.equal(effectiveInstruction(store.get(node.id)), "latest correction");
  assert.equal(effectiveInstruction({}), "");

  store.setStatus(node.id, "running", { nextStep: " continue " });
  store.setStatus(node.id, "blocked");
  assert.equal(store.get(node.id).nextStep, "continue");
  store.setStatus(node.id, "done", { nextStep: " " });
  assert.equal(store.get(node.id).nextStep, "continue");
  assert.throws(() => store.setStatus(node.id, "frozen"), /invalid status/);
  assert.equal(store.setStatus("missing", "open"), null);

  assert.equal(store.addContextRefs(node.id, []).contextRefs.length, 0);
  store.addContextRefs(node.id, "ref");
  store.addContextRefs(node.id, ["ref", "next"]);
  assert.deepEqual(store.get(node.id).contextRefs, ["ref", "next"]);
  store.bindExecutor(node.id, { kind: "local", ref: " run-1 " });
  assert.deepEqual(store.get(node.id).executor, { kind: "local", ref: "run-1" });
  store.bindExecutor(node.id, { kind: "devin" });
  assert.deepEqual(store.get(node.id).executor, { kind: "devin", ref: null });
  store.bindExecutor(node.id, { kind: "invalid", ref: "ignored" });
  assert.deepEqual(store.get(node.id).executor, { kind: "none", ref: null });
});

test("events validate nodes, sequence per node, filter, sort, and survive corrupt lines", (t) => {
  const { dataDir, store } = harness(t);
  const first = store.create({ title: "first" });
  const second = store.create({ title: "second" });
  assert.throws(() => store.appendEvent({}), /node_id is required/);
  assert.throws(() => store.appendEvent({ nodeId: "missing" }), /work node not found/);
  const event1 = store.appendEvent({ nodeId: first.id, runId: "run-1", type: "partial", payload: { text: "a" } });
  const event2 = store.appendEvent({ node_id: first.id, run_id: "run-1", payload: [] });
  const other = store.appendEvent({ node_id: second.id });
  assert.equal(event1.seq, 1);
  assert.equal(event2.seq, 2);
  assert.equal(event2.type, "status");
  assert.deepEqual(event2.payload, {});
  assert.equal(other.seq, 1);
  fs.appendFileSync(path.join(dataDir, "work-events.jsonl"), "not-json\n");
  assert.deepEqual(store.listEvents({ nodeId: first.id, runId: "run-1" }).map((event) => event.seq), [1, 2]);
  assert.equal(store.listEvents({ limit: 1 }).length, 1);
  assert.equal(store.listEvents({ limit: "invalid" }).length, 3);
});

test("artifacts normalize aliases, bound bodies, and support every filter", (t) => {
  const { dataDir, store } = harness(t);
  assert.deepEqual(store.listArtifacts(), []);
  const first = store.addArtifact({
    nodeId: "node-1",
    runId: "run-1",
    kind: "plan",
    title: " Alpha Plan ",
    body: `needle ${"x".repeat(210_000)}`,
    refs: ["not", "plain"],
  });
  const second = store.addArtifact({ node_id: "node-2", run_id: "run-2", title: "Beta", refs: { source: "s" } });
  assert.equal(first.body.length, 200_000);
  assert.deepEqual(first.refs, {});
  assert.equal(second.kind, "note");
  assert.deepEqual(second.refs, { source: "s" });
  fs.appendFileSync(path.join(dataDir, "work-artifacts.jsonl"), "{bad\n");
  assert.equal(store.listArtifacts({ nodeId: "node-1" }).length, 1);
  assert.equal(store.listArtifacts({ run_id: "run-2" }).length, 1);
  assert.equal(store.listArtifacts({ kind: "plan" }).length, 1);
  assert.equal(store.listArtifacts({ query: "ALPHA" }).length, 1);
  assert.equal(store.listArtifacts({ q: "needle" }).length, 1);
  assert.equal(store.listArtifacts({ q: "absent" }).length, 0);
  assert.equal(store.listArtifacts({ limit: -5 }).length, 1);
});

test("persistence reloads valid state and fails soft for invalid state shapes", (t) => {
  const { dataDir, store } = harness(t);
  const node = store.create({ title: "persisted" });
  assert.equal(createWorkGraphStore({ dataDir }).get(node.id).title, "persisted");
  const graphPath = store.graphPath;
  for (const content of ["not-json", "null", "[]", '{"nodes":null}', '{"nodes":"bad"}']) {
    fs.writeFileSync(graphPath, content);
    assert.deepEqual(createWorkGraphStore({ dataDir }).list(), []);
  }
  const info = store.storageInfo();
  assert.equal(info.work_graph, graphPath);
  assert.equal(info.postgres_configured, false);
});
