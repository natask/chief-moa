#!/usr/bin/env node
"use strict";

// Smoke for the work-graph store: the durable forest of tasks you have initiated.
//
// Proves the spine end to end, in-process against a throwaway DATA_DIR (no
// server, no network — this slice has no HTTP routes yet):
//
//   1. create() makes a root node; create({parentId}) FORKS and the child
//      inherits the parent's context refs as of the fork (B7).
//   2. enqueue()/dequeue() is a FIFO per-branch queue (C12) and does not touch
//      the effective instruction.
//   3. applyCorrection() + effectiveInstruction(): the newest correction wins
//      over the original intent (D15 — corrections win, not launch order).
//   4. setStatus() updates status + the self-reported next step (C11);
//      list({status}) is the "all my tasks" read (E19).
//   5. bindExecutor() attaches/clears the disposable worker (local/devin/none).
//   6. State survives a reload: a second store over the same dir sees every node.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const { createWorkGraphStore, effectiveInstruction } = require(path.join(GATEWAY_DIR, "lib", "work-graph"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-work-graph-smoke-"));
  const dataDir = path.join(tempDir, "data");

  try {
    const store = createWorkGraphStore({ dataDir });

    const rootId = await step("create root + fork inherits context", () => assertCreateAndFork(store));
    await step("queue is FIFO and leaves intent alone", () => assertQueue(store, rootId));
    await step("corrections win over original intent", () => assertCorrectionsWin(store, rootId));
    await step("status + next step + list filter", () => assertStatusAndList(store, rootId));
    await step("executor binds and clears", () => assertExecutor(store, rootId));
    await step("state survives reload", () => assertPersistence(dataDir, rootId));

    console.log(JSON.stringify({
      ok: true,
      data_dir: dataDir,
      checks: [
        "create() root; create({parentId}) forks and inherits contextRefs (B7)",
        "enqueue/dequeue FIFO per-branch queue, does not change effective instruction (C12)",
        "applyCorrection + effectiveInstruction: newest correction wins (D15)",
        "setStatus updates status + nextStep (C11); list({status}) filters (E19)",
        "bindExecutor sets {kind,ref} and clears to none",
        "a fresh store over the same dir sees all persisted nodes",
      ],
    }, null, 2));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

function assertCreateAndFork(store) {
  const root = store.create({ title: "Ship the work-graph", intent: "Build the durable task forest" });
  assert.ok(root.id.startsWith("wg_"), "node id must be prefixed wg_");
  assert.equal(root.parentId, null, "a root node has no parent");
  assert.equal(root.status, "open", "a new node starts open");
  assert.deepEqual(root.queue, [], "a new node starts with an empty queue");

  // Seed context refs on the parent so we can prove inheritance on fork.
  store.bindExecutor(root.id, { kind: "local", ref: "run-1" });
  const seeded = store.addContextRefs(root.id, ["ctx-root", "ctx-decl"]);
  assert.deepEqual(seeded.contextRefs, ["ctx-root", "ctx-decl"], "addContextRefs must record both refs");
  store.addContextRefs(root.id, "ctx-root"); // duplicate is a no-op
  assert.equal(store.get(root.id).contextRefs.length, 2, "addContextRefs must dedupe");

  const child = store.create({ title: "Sub-task", intent: "A forked branch", parentId: root.id });
  assert.equal(child.parentId, root.id, "child must point at its parent");
  assert.deepEqual(child.contextRefs, ["ctx-root", "ctx-decl"], "fork must inherit parent contextRefs (B7)");

  // Inheritance is a copy, not a shared reference: mutating the parent later
  // must not leak into the already-forked child.
  store.addContextRefs(root.id, "ctx-after-fork");
  assert.equal(store.get(child.id).contextRefs.length, 2, "fork inherits refs as of the fork point, not after");

  const kids = store.children(root.id);
  assert.equal(kids.length, 1, "root must report one child");
  assert.equal(kids[0].id, child.id, "children() must return the forked node");

  assert.throws(() => store.create({ title: "orphan", parentId: "wg_missing" }), /parent node not found/);
  return root.id;
}

function assertQueue(store, id) {
  const before = effectiveInstruction(store.get(id));
  store.enqueue(id, "do A");
  store.enqueue(id, "do B");
  const node = store.get(id);
  assert.equal(node.queue.length, 2, "two enqueues must leave two items");
  assert.equal(effectiveInstruction(node), before, "queueing must not change the effective instruction");

  const first = store.dequeue(id);
  assert.equal(first.item.text, "do A", "dequeue must be FIFO (A before B)");
  const second = store.dequeue(id);
  assert.equal(second.item.text, "do B", "dequeue must return B next");
  const empty = store.dequeue(id);
  assert.equal(empty.item, null, "dequeue on an empty queue returns a null item");
}

function assertCorrectionsWin(store, id) {
  const original = store.get(id).intent;
  assert.equal(effectiveInstruction(store.get(id)), original, "with no corrections the intent is effective");

  store.applyCorrection(id, "actually, do it this way");
  assert.equal(effectiveInstruction(store.get(id)), "actually, do it this way", "newest correction must win");

  store.applyCorrection(id, "no, this way instead");
  assert.equal(effectiveInstruction(store.get(id)), "no, this way instead", "the latest of several corrections wins");
  assert.equal(store.get(id).corrections.length, 2, "every correction is logged, not overwritten");
}

function assertStatusAndList(store, id) {
  store.setStatus(id, "running", { nextStep: "spawn a worker" });
  const node = store.get(id);
  assert.equal(node.status, "running", "status must update");
  assert.equal(node.nextStep, "spawn a worker", "next step must be recorded (C11)");

  store.setStatus(id, "blocked");
  assert.equal(store.get(id).nextStep, "spawn a worker", "omitting nextStep must leave the prior value");

  assert.throws(() => store.setStatus(id, "frozen"), /invalid status/);

  const blocked = store.list({ status: "blocked" });
  assert.ok(blocked.some((n) => n.id === id), "list({status:'blocked'}) must include the blocked node");
  const open = store.list({ status: "open" });
  assert.ok(!open.some((n) => n.id === id), "the blocked node must not appear under status open");
}



function assertExecutor(store, id) {
  store.bindExecutor(id, { kind: "devin", ref: "devin-abc123" });
  let node = store.get(id);
  assert.deepEqual(node.executor, { kind: "devin", ref: "devin-abc123" }, "executor must bind to a devin session");

  store.bindExecutor(id, { kind: "none" });
  node = store.get(id);
  assert.deepEqual(node.executor, { kind: "none", ref: null }, "clearing must reset to none with a null ref");

  store.bindExecutor(id, { kind: "bogus", ref: "x" });
  assert.equal(store.get(id).executor.kind, "none", "an unknown executor kind falls back to none");
}

function assertPersistence(dataDir, id) {
  const reopened = createWorkGraphStore({ dataDir });
  const node = reopened.get(id);
  assert.ok(node, "a fresh store over the same dir must see the persisted node");
  assert.equal(node.corrections.length, 2, "persisted corrections must survive reload");
  assert.ok(reopened.list().length >= 2, "the reopened forest must hold root + child");
}
