"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPostgresWorkGraphStore } = require("../lib/work-graph-postgres");

const NOW = "2026-07-15T12:00:00.000Z";

test("adapter requires configuration and exposes stable metadata", async () => {
  assert.throws(() => createPostgresWorkGraphStore(), /DATABASE_URL is required/);
  const pool = scriptedPool();
  const store = createPostgresWorkGraphStore({ pool, initialize: false });
  assert.equal(store.graphPath, "postgres:nodes");
  assert.deepEqual(store.statuses(), ["open", "running", "blocked", "done"]);
  assert.deepEqual(store.storageInfo(), {
    work_graph: "postgres",
    postgres_configured: true,
    database_url_configured: true,
    schema: "schema.sql",
  });
  await store.close();
  assert.equal(pool.ended, 1);
  await createPostgresWorkGraphStore({ pool: { query: async () => ({ rows: [] }) }, initialize: false }).close();
});

test("schema initialization is lazy, shared, and optional", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-graph-schema-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const schemaPath = path.join(tempDir, "schema.sql");
  fs.writeFileSync(schemaPath, "select schema_setup;");
  const pool = scriptedPool([{ rows: [nodeRow()] }, { rows: [nodeRow({ id: "wg_2" })] }]);
  const store = createPostgresWorkGraphStore({ pool, schemaPath });
  await store.get("wg_1");
  await store.get("wg_2");
  assert.equal(pool.records.filter((record) => record.sql === "select schema_setup;").length, 1);
});

test("create handles roots, inherited child context, and missing parents", async () => {
  const rootPool = scriptedPool([{ rows: [nodeRow({ title: "root", intent: "intent" })] }]);
  const root = await makeStore(rootPool).create({ title: " root ", intent: " intent " });
  assert.equal(root.title, "root");
  assert.equal(root.intent, "intent");
  assert.equal(rootPool.releases, 1);
  assert.match(rootPool.records.find((record) => /insert into nodes/.test(record.sql)).params[0], /^wg_/);

  const parent = nodeRow({ id: "parent", context_refs: ["ctx"] });
  const childPool = scriptedPool([{ rows: [parent] }, { rows: [nodeRow({ id: "child", parent_id: "parent", context_refs: ["ctx"] })] }]);
  const child = await makeStore(childPool).create({ parentId: "parent" });
  assert.equal(child.parentId, "parent");
  assert.deepEqual(child.contextRefs, ["ctx"]);

  const missingPool = scriptedPool([{ rows: [] }]);
  await assert.rejects(makeStore(missingPool).create({ parentId: "missing" }), /parent node not found/);
  assert.equal(missingPool.records.some((record) => record.sql === "rollback"), true);
});

test("transaction rollback preserves the original error even when rollback fails", async () => {
  const original = new Error("insert failed");
  const pool = scriptedPool([original], { failRollback: true });
  await assert.rejects(makeStore(pool).create({}), (error) => error === original);
  assert.equal(pool.releases, 1);
});

test("get, list, and children map rows and select correct query variants", async () => {
  const row = nodeRow({
    queue: null,
    corrections: "bad",
    context_refs: null,
    executor_kind: "",
    executor_ref: "",
    next_step: "",
    created_at: new Date(NOW),
  });
  const pool = scriptedPool([
    { rows: [row] },
    { rows: [] },
    { rows: [row] },
    { rows: [row] },
    { rows: [row] },
  ]);
  const store = makeStore(pool);
  const found = await store.get("wg_1");
  assert.deepEqual(found.queue, []);
  assert.deepEqual(found.executor, { kind: "none", ref: null });
  assert.equal(found.createdAt, NOW);
  assert.equal(await store.get("missing"), null);
  assert.equal((await store.list({ status: "running" })).length, 1);
  assert.equal((await store.list({ status: "invalid" })).length, 1);
  assert.equal((await store.children("wg_1")).length, 1);
  assert.match(pool.records[2].sql, /where status/);
  assert.doesNotMatch(pool.records[3].sql, /where status/);
});

test("queue and correction mutations cover blank, missing, empty, and populated arrays", async () => {
  const getBlank = scriptedPool([{ rows: [nodeRow()] }]);
  assert.equal((await makeStore(getBlank).enqueue("wg_1", " ")).id, "wg_1");

  const enqueuePool = scriptedPool([{ rows: [nodeRow({ queue: "bad" })] }, { rows: [nodeRow({ queue: [{ text: "work" }] })] }]);
  assert.equal((await makeStore(enqueuePool).enqueue("wg_1", " work ")).queue[0].text, "work");

  const missingPool = scriptedPool([{ rows: [] }]);
  assert.equal(await makeStore(missingPool).enqueue("missing", "work"), null);

  const dequeueMissing = scriptedPool([{ rows: [] }]);
  assert.deepEqual(await makeStore(dequeueMissing).dequeue("missing"), { node: null, item: null });
  const dequeueEmpty = scriptedPool([{ rows: [nodeRow({ queue: [] })] }]);
  assert.equal((await makeStore(dequeueEmpty).dequeue("wg_1")).item, null);
  const dequeuePool = scriptedPool([
    { rows: [nodeRow({ queue: [{ text: "first" }, { text: "second" }] })] },
    { rows: [nodeRow({ queue: [{ text: "second" }] })] },
  ]);
  assert.equal((await makeStore(dequeuePool).dequeue("wg_1")).item.text, "first");

  const correctionBlank = scriptedPool([{ rows: [nodeRow()] }]);
  await makeStore(correctionBlank).applyCorrection("wg_1", null);
  const correctionPool = scriptedPool([{ rows: [nodeRow()] }, { rows: [nodeRow({ corrections: [{ text: "fix" }] })] }]);
  assert.equal((await makeStore(correctionPool).applyCorrection("wg_1", "fix")).corrections.length, 1);
});

test("status, context, and executor updates validate and normalize", async () => {
  const store = makeStore(scriptedPool());
  await assert.rejects(store.setStatus("wg_1", "invalid"), /invalid status/);

  const statusPool = scriptedPool([{ rows: [nodeRow({ status: "running", next_step: "next" })] }, { rows: [] }]);
  assert.equal((await makeStore(statusPool).setStatus("wg_1", "running", { nextStep: " next " })).nextStep, "next");
  assert.equal(await makeStore(scriptedPool([{ rows: [] }])).setStatus("missing", "open"), null);

  const contextBlank = scriptedPool([{ rows: [nodeRow()] }]);
  await makeStore(contextBlank).addContextRefs("wg_1", []);
  const contextPool = scriptedPool([
    { rows: [nodeRow({ context_refs: ["old"] })] },
    { rows: [nodeRow({ context_refs: ["old", "new"] })] },
  ]);
  assert.deepEqual((await makeStore(contextPool).addContextRefs("wg_1", ["old", " new ", null])).contextRefs, ["old", "new"]);

  const executorPool = scriptedPool([
    { rows: [nodeRow({ executor_kind: "local", executor_ref: "run" })] },
    { rows: [nodeRow({ executor_kind: "none", executor_ref: null })] },
  ]);
  const executorStore = makeStore(executorPool);
  assert.deepEqual((await executorStore.bindExecutor("wg_1", { kind: "local", ref: " run " })).executor, { kind: "local", ref: "run" });
  assert.equal((await executorStore.bindExecutor("wg_1", { kind: "bad", ref: "ignored" })).executor.kind, "none");
});

test("events validate, sequence, upsert run states, and filter dynamically", async () => {
  await assert.rejects(makeStore(scriptedPool()).appendEvent({}), /node_id is required/);
  const eventPool = scriptedPool([
    { rows: [] },
    { rows: [{ next_seq: "3" }] },
    { rows: [] },
    { rows: [eventRow({ seq: 3, payload: { status: "completed", result: "ok", kind: "agent" } })] },
  ]);
  const event = await makeStore(eventPool).appendEvent({ nodeId: "node", runId: "run", type: "bad", payload: { status: "completed", result: "ok", kind: "agent" } });
  assert.equal(event.seq, 3);
  assert.equal(event.type, "status");
  assert.equal(eventPool.records.some((record) => /insert into runs/.test(record.sql)), true);

  for (const status of ["done", "failed", "timed-out", "error", "canceled", "cancelled", "running"]) {
    const pool = scriptedPool([{ rows: [] }, { rows: [{ next_seq: 1 }] }, { rows: [] }, { rows: [eventRow()] }]);
    await makeStore(pool).appendEvent({ node_id: "node", run_id: `run-${status}`, type: "final", payload: { status, text: "text", error: "err", harness: "echo", instruction: "go" } });
  }

  const listPool = scriptedPool([{ rows: [eventRow({ run_id: null, payload: "bad", ts: null })] }, { rows: [] }]);
  const listStore = makeStore(listPool);
  const listed = await listStore.listEvents({ nodeId: "node", runId: "run", limit: 1 });
  assert.deepEqual(listed[0].payload, {});
  assert.equal(listed[0].run_id, "");
  assert.equal(listed[0].ts, "");
  await listStore.listEvents();
  assert.match(listPool.records[0].sql, /where node_id = \$1 and run_id = \$2/);
  assert.doesNotMatch(listPool.records[1].sql, / where /);
});

test("artifacts normalize values, optionally upsert runs, and build all filters", async () => {
  const addPool = scriptedPool([{ rows: [] }, { rows: [artifactRow()] }]);
  const artifact = await makeStore(addPool).addArtifact({ nodeId: "node", runId: "run", kind: "bad", title: " title ", body: "x".repeat(210_000), refs: [] });
  assert.equal(artifact.kind, "note");
  assert.equal(addPool.records.some((record) => /insert into runs/.test(record.sql)), true);

  const barePool = scriptedPool([{ rows: [artifactRow({ node_id: null, run_id: null, title: null, body: null, refs: null, created_at: null })] }]);
  const bare = await makeStore(barePool).addArtifact({ kind: "plan", refs: { source: "s" } });
  assert.equal(bare.node_id, "");
  assert.deepEqual(bare.refs, {});

  const listPool = scriptedPool([{ rows: [artifactRow()] }, { rows: [] }]);
  const listStore = makeStore(listPool);
  await listStore.listArtifacts({ nodeId: "node", runId: "run", kind: "plan", query: "find", limit: 2 });
  await listStore.listArtifacts({ kind: "invalid", limit: "bad" });
  assert.match(listPool.records[0].sql, /node_id = \$1.*run_id = \$2.*kind = \$3.*websearch/s);
  assert.doesNotMatch(listPool.records[1].sql, / where /);
});

function makeStore(pool) {
  return createPostgresWorkGraphStore({ pool, initialize: false });
}

function nodeRow(overrides = {}) {
  return {
    id: "wg_1",
    title: "title",
    intent: "intent",
    parent_id: null,
    status: "open",
    queue: [],
    corrections: [],
    context_refs: [],
    executor_kind: "none",
    executor_ref: null,
    next_step: "",
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function eventRow(overrides = {}) {
  return { id: "evt_1", node_id: "node", run_id: "run", seq: 1, type: "status", payload: {}, ts: NOW, ...overrides };
}

function artifactRow(overrides = {}) {
  return { id: "art_1", node_id: "node", run_id: "run", kind: "note", title: "title", body: "body", refs: {}, created_at: NOW, ...overrides };
}

function scriptedPool(responses = [], options = {}) {
  const records = [];
  const pool = {
    records,
    releases: 0,
    ended: 0,
    async query(sql, params) {
      return execute(sql, params);
    },
    async connect() {
      return {
        query: execute,
        release: () => { pool.releases += 1; },
      };
    },
    async end() { pool.ended += 1; },
  };
  async function execute(sql, params) {
    const normalized = String(sql).trim().replace(/\s+/g, " ");
    records.push({ sql: normalized, params });
    if (["begin", "commit"].includes(normalized)) return { rows: [] };
    if (normalized === "rollback") {
      if (options.failRollback) throw new Error("rollback failed");
      return { rows: [] };
    }
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next || { rows: [] };
  }
  return pool;
}
