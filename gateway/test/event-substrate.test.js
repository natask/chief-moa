"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  EventStreamVersionConflictError,
  acquireJsonStreamDirLock,
  appendEventOnClient,
  createEventSubstrateStore,
  eventSubstrateTestInternals,
  normalizeEvent,
  normalizeEventType,
  releaseJsonStreamDirLock,
  withTransaction,
} = require("../lib/event-substrate");

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-substrate-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createEventSubstrateStore({ dataDir, originId: "test-origin", ...options }) };
}

function sample(overrides = {}) {
  return {
    event_type: "test.created",
    stream_id: "stream:test",
    actor: { kind: "user", id: "usr_1" },
    payload: { ok: true },
    ...overrides,
  };
}

test("normalizes bounded event aliases and fallback identities", () => {
  assert.equal(normalizeEventType(), "event.recorded");
  assert.equal(normalizeEventType("..Hello BAD///Type.."), "hello.bad.type");
  const event = normalizeEvent({
    eventId: " evt-1 ",
    originId: " origin ",
    eventType: "Task DONE",
    eventSchemaVersion: "2",
    streamVersion: "3",
    sessionId: "session-1",
    occurredAt: "2025-01-02T03:04:05Z",
    recordedAt: "invalid",
    actor: { kind: " device ", id: " phone " },
    authority: { mode: "local" },
    causationId: "cause",
    correlationId: "correlation",
    idempotencyKey: "idem",
    blobRefs: [{ id: 1 }, null, []],
    crdtRefs: "bad",
    signature: "sig",
  }, { originId: "fallback", streamVersion: 9 });
  assert.equal(event.event_id, "evt-1");
  assert.equal(event.stream_id, "session:session-1");
  assert.equal(event.event_type, "task.done");
  assert.equal(event.stream_version, 3);
  assert.equal(event.event_schema_version, 2);
  assert.equal(event.actor.kind, "device");
  assert.equal(event.recorded_at.length, 24);
  assert.deepEqual(event.blob_refs, [{ id: 1 }]);
  assert.deepEqual(event.crdt_refs, []);

  const run = normalizeEvent({ type: "run.event", payload: { runId: "run-1" }, actor: [] });
  assert.equal(run.stream_id, "run:run-1");
  assert.deepEqual(run.actor, { kind: "gateway", id: "gateway" });
  const fallback = normalizeEvent({ event_type: "!!!", payload: [], authority: [], blob_refs: {} });
  assert.equal(fallback.stream_id, "event:event.recorded");
  assert.equal(fallback.event_type, "event.recorded");
  assert.deepEqual(fallback.authority, {});
  const aliases = normalizeEvent({
    event_id: "snake", origin_id: "snake-origin", stream_id: "snake-stream",
    event_type: "snake.type", event_schema_version: 0, stream_version: 0,
    occurred_at: "", recorded_at: "", idempotency_key: "snake-idem",
    actor: {}, blob_refs: Array.from({ length: 105 }, (_, i) => ({ i })), crdt_refs: [{}],
  }, { streamVersion: 7 });
  assert.equal(aliases.stream_version, 7);
  assert.deepEqual(aliases.actor, { kind: "gateway", id: "gateway" });
  assert.equal(aliases.blob_refs.length, 100);
  assert.equal(aliases.crdt_refs.length, 1);
  const stringActor = normalizeEvent({ event_type: "actor.test", actor: "bad", run_id: "run-snake" });
  assert.deepEqual(stringActor.actor, { kind: "gateway", id: "gateway" });
  assert.equal(stringActor.stream_id, "run:run-snake");
});

test("JSON store covers idempotency, compare-and-append, filters, and corruption", async (t) => {
  const { store, dataDir } = fixture(t, { jsonLockTimeoutMs: -1, jsonLockRetryMs: 0, jsonLockStaleMs: 9999999 });
  assert.equal(await store.getEvent(), null);
  assert.deepEqual(await store.listEvents(), []);
  const first = await store.appendEvent(sample({ event_id: "evt-first", idempotency_key: "same", expected_stream_version: 0 }));
  assert.equal(first.stream_version, 1);
  assert.equal((await store.appendEvent(sample({ event_id: "different", idempotency_key: "same" }))).event_id, first.event_id);
  assert.equal((await store.appendEvent(sample({ event_id: "evt-first", payload: { changed: true } }))).event_id, first.event_id);
  const second = await store.appendEvent(sample({ event_type: "test.updated", correlation_id: "corr", expectedStreamVersion: 1 }));
  assert.equal(second.stream_version, 2);
  await assert.rejects(
    () => store.appendEvent(sample({ expected_stream_version: 0 })),
    (error) => error instanceof EventStreamVersionConflictError && error.statusCode === 409 && error.actual_stream_version === 2,
  );
  for (const bad of [-1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => store.appendEvent(sample({ expected_stream_version: bad })), /non-negative safe integer/);
  }
  await assert.rejects(() => store.appendEvent(sample({ expected_stream_version: 1, expectedStreamVersion: 2 })), /non-negative safe integer/);
  await assert.rejects(() => store.appendEvent(sample({ expectedStreamVersion: -1 })), /non-negative safe integer/);
  const fixedTime = "2025-01-01T00:00:00.000Z";
  await store.appendEvent(sample({ event_id: "evt-z", stream_id: "stream:z", recorded_at: fixedTime, occurred_at: fixedTime }));
  await store.appendEvent(sample({ event_id: "evt-a", stream_id: "stream:a", recorded_at: fixedTime, occurred_at: fixedTime }));

  assert.equal((await store.getEvent(first.event_id)).event_id, first.event_id);
  assert.equal((await store.listEvents({ event_type: "test.created" })).length, 3);
  assert.equal((await store.listEvents({ eventTypePrefix: "test.", streamId: "stream:test", originId: "test-origin", order: "asc", offset: -1, limit: 9999 })).length, 2);
  assert.equal((await store.listEvents({ correlationId: "corr", idempotencyKey: "missing" })).length, 0);
  assert.equal((await store.listEvents({ eventType: "missing" })).length, 0);
  assert.equal((await store.listEvents({ streamId: "missing" })).length, 0);
  assert.equal((await store.listEvents({ originId: "missing" })).length, 0);
  assert.equal((await store.listEvents({ eventTypePrefix: "other." })).length, 0);
  assert.equal((await store.listEvents({ offset: 1, limit: "bad" })).length, 3);
  const tied = await store.listEvents({ order: "asc", limit: 500 });
  assert.ok(tied.findIndex((event) => event.event_id === "evt-a") < tied.findIndex((event) => event.event_id === "evt-z"));
  assert.equal((await store.storageInfo()).event_count, 4);
  await assert.rejects(() => store.withStreamLock("x", null), /requires a function/);
  assert.equal(await store.withStreamLock("x", async () => 42), 42);
  await assert.rejects(() => store.withStreamLock("x", async () => { throw new Error("transition failed"); }), /transition failed/);
  assert.equal(await store.withStreamLock("x", async () => 43), 43);
  assert.equal(await store.withStreamLock("", async () => 44), 44);

  const eventsPath = path.join(dataDir, "product-events.jsonl");
  fs.appendFileSync(eventsPath, "invalid-json\n");
  assert.equal((await store.listEvents()).length, 4, "lenient reads skip corrupt lines");
  await assert.rejects(() => store.appendEvent(sample()), (error) => error.code === "EVENT_SUBSTRATE_CORRUPT");
});

function pgRow(overrides = {}) {
  const now = new Date("2025-01-01T00:00:00Z");
  return {
    event_id: "evt-pg",
    origin_id: "pg-origin",
    stream_id: "stream:pg",
    stream_version: "1",
    event_type: "pg.created",
    event_schema_version: "1",
    occurred_at: now,
    recorded_at: now,
    actor: null,
    authority: null,
    causation_id: null,
    correlation_id: null,
    idempotency_key: null,
    payload: null,
    blob_refs: null,
    crdt_refs: null,
    signature: null,
    ...overrides,
  };
}

function mockPg() {
  const calls = [];
  const client = {
    released: 0,
    async query(sql, params = []) {
      calls.push({ target: "client", sql, params });
      if (sql.includes("where event_id") || sql.includes("where idempotency_key")) return { rows: [] };
      if (sql.includes("coalesce(max")) return { rows: [{ current_version: "0" }] };
      if (sql.includes("insert into")) return { rows: [pgRow({
        event_id: params[0], origin_id: params[1], stream_id: params[2], stream_version: params[3],
        event_type: params[4], event_schema_version: params[5], occurred_at: params[6], recorded_at: params[7],
        actor: JSON.parse(params[8]), authority: JSON.parse(params[9]), payload: JSON.parse(params[13]),
        blob_refs: JSON.parse(params[14]), crdt_refs: JSON.parse(params[15]),
      })] };
      return { rows: [] };
    },
    release() { this.released += 1; },
  };
  const pool = {
    async connect() { calls.push({ target: "pool", sql: "connect" }); return client; },
    async query(sql, params = []) {
      calls.push({ target: "pool", sql, params });
      if (sql.includes("count(*)")) return { rows: [{ count: "3" }] };
      if (sql.includes("where event_id = $1")) return { rows: params[0] === "missing" ? [] : [pgRow()] };
      if (sql.startsWith("select * from product_events where") && sql.includes("limit 1")) return { rows: [] };
      if (sql.startsWith("select * from product_events")) return { rows: [pgRow()] };
      return { rows: [] };
    },
  };
  return { pool, client, calls };
}

test("Postgres store uses injected pool for the complete lifecycle", async (t) => {
  const { pool, client, calls } = mockPg();
  const schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-schema-"));
  t.after(() => fs.rmSync(schemaDir, { recursive: true, force: true }));
  const schemaPath = path.join(schemaDir, "schema.sql");
  fs.writeFileSync(schemaPath, "select 1;");
  const store = createEventSubstrateStore({ pool, schemaPath, originId: "pg-origin" });
  const listed = await store.listEvents({
    eventType: "pg.created", streamId: "stream:pg", originId: "pg-origin",
    correlationId: "corr", idempotencyKey: "idem", eventTypePrefix: "pg.", order: "asc", limit: 2, offset: 1,
  });
  assert.equal(listed[0].event_id, "evt-pg");
  assert.deepEqual(listed[0].actor, {});
  assert.equal(await store.getEvent(""), null);
  assert.equal((await store.getEvent("evt-pg")).event_id, "evt-pg");
  assert.equal(await store.getEvent("missing"), null);
  assert.equal((await store.storageInfo()).event_count, 3);
  const appended = await store.appendEvent(sample({ event_type: "pg.created", stream_id: "stream:pg" }));
  assert.equal(appended.stream_version, 1);
  await assert.rejects(() => store.withStreamLock("pg", null), /requires a function/);
  assert.equal(await store.withStreamLock("pg", async () => "locked"), "locked");
  assert.ok(client.released >= 2);
  assert.ok(calls.some((call) => String(call.sql).includes("pg_advisory_lock")));
  assert.ok(calls.some((call) => String(call.sql).includes("insert into product_events")));

  const noInit = createEventSubstrateStore({ pool, initialize: false, originId: "pg-origin" });
  assert.equal((await noInit.listEvents({ order: "desc", limit: Number.NaN, offset: 99_999_999 }))[0].event_id, "evt-pg");
  assert.ok(calls.some((call) => String(call.sql).includes("order by recorded_at desc")));
  const defaultSchema = createEventSubstrateStore({ pool, originId: "pg-origin" });
  assert.equal((await defaultSchema.listEvents())[0].event_id, "evt-pg");
});

test("appendEventOnClient validates clients, retries idempotently, and detects conflicts", async () => {
  await assert.rejects(() => appendEventOnClient(null, sample()), /requires a pg client/);
  const existing = pgRow({ event_id: "existing" });
  const existingClient = {
    async query(sql) {
      if (sql.includes("advisory")) return { rows: [] };
      if (sql.includes("where event_id")) return { rows: [existing] };
      return { rows: [] };
    },
  };
  assert.equal((await appendEventOnClient(existingClient, sample({ event_id: "existing" }))).event_id, "existing");
  const conflictClient = {
    async query(sql) {
      if (sql.includes("advisory")) return { rows: [] };
      if (sql.includes("where event_id")) return { rows: [] };
      if (sql.includes("coalesce(max")) return { rows: [{ current_version: 4 }] };
      throw new Error(`unexpected: ${sql}`);
    },
  };
  await assert.rejects(
    () => appendEventOnClient(conflictClient, sample({ expected_stream_version: 3 }), { originId: "pg" }),
    (error) => error.code === "EVENT_STREAM_VERSION_CONFLICT" && error.actual_stream_version === 4,
  );
});

test("Postgres outer idempotency and row fallbacks avoid transactions", async () => {
  const row = pgRow({
    event_id: "outer-existing", occurred_at: "invalid", recorded_at: "invalid",
    actor: { kind: "system" }, authority: { mode: "server" }, causation_id: "cause",
    correlation_id: "corr", idempotency_key: "idem", payload: { ok: true },
    blob_refs: [{}], crdt_refs: [{}], signature: "sig",
  });
  let connects = 0;
  const pool = {
    async connect() { connects += 1; throw new Error("must not connect"); },
    async query(sql, params) {
      if (sql.includes("limit 1")) {
        assert.deepEqual(params, ["outer-existing", "idem"]);
        return { rows: [row] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const store = createEventSubstrateStore({ pool, initialize: false });
  const existing = await store.appendEvent({ eventId: "outer-existing", idempotencyKey: "idem" });
  assert.equal(existing.event_id, "outer-existing");
  assert.equal(existing.occurred_at, "");
  assert.equal(existing.recorded_at, "");
  assert.deepEqual(existing.blob_refs, [{}]);
  assert.equal(connects, 0);

  const keyOnlyPool = {
    async query(sql, params) {
      assert.match(sql, /idempotency_key = \$1/);
      assert.deepEqual(params, ["key-only"]);
      return { rows: [pgRow({ event_id: "key-event" })] };
    },
    async connect() { throw new Error("must not connect"); },
  };
  assert.equal((await createEventSubstrateStore({ pool: keyOnlyPool, initialize: false }).appendEvent({ idempotency_key: "key-only" })).event_id, "key-event");
});

test("withTransaction commits, rolls back, and always releases", async () => {
  const calls = [];
  const client = { async query(sql) { calls.push(sql); }, release() { calls.push("release"); } };
  const pool = { async connect() { return client; } };
  assert.equal(await withTransaction(pool, async () => "ok"), "ok");
  assert.deepEqual(calls, ["begin", "commit", "release"]);
  calls.length = 0;
  await assert.rejects(() => withTransaction(pool, async () => { throw new Error("fail"); }), /fail/);
  assert.deepEqual(calls, ["begin", "rollback", "release"]);
  calls.length = 0;
  client.query = async (sql) => { calls.push(sql); if (sql === "rollback") throw new Error("rollback failed"); };
  await assert.rejects(() => withTransaction(pool, async () => { throw new Error("original"); }), /original/);
  assert.deepEqual(calls, ["begin", "rollback", "release"]);
});

test("default JSON directory and valid lock bounds remain usable", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-default-dir-"));
  const previous = process.cwd();
  t.after(() => {
    process.chdir(previous);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  process.chdir(cwd);
  const store = createEventSubstrateStore({
    originId: "default-dir",
    jsonLockTimeoutMs: 100,
    jsonLockRetryMs: 1,
    jsonLockStaleMs: 100,
  });
  assert.equal((await store.appendEvent({ type: "default.dir" })).stream_version, 1);
  process.chdir(previous);
});

test("stream-directory locks reject impostors and recover stale owners and reapers", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-stream-lock-direct-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { timeoutMs: 30, retryMs: 1, staleMs: 10 };
  const lockDir = path.join(root, "stream.lock");
  const owner = await acquireJsonStreamDirLock(lockDir, options);
  await assert.rejects(() => acquireJsonStreamDirLock(lockDir, options), (error) => error.code === "EVENT_SUBSTRATE_LOCK_TIMEOUT");
  assert.equal(await releaseJsonStreamDirLock(lockDir, { nonce: "wrong" }, options), false);

  const ownerPath = path.join(lockDir, "owner.json");
  fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, process_instance_id: "previous-process-instance" }));
  const reclaimedPriorInstance = await acquireJsonStreamDirLock(lockDir, options);

  const reaperDir = `${lockDir}.reaper`;
  fs.mkdirSync(reaperDir);
  fs.writeFileSync(path.join(reaperDir, "owner.json"), "not-json");
  const old = new Date(Date.now() - 1000);
  fs.utimesSync(reaperDir, old, old);
  assert.equal(await releaseJsonStreamDirLock(lockDir, reclaimedPriorInstance, options), true);
  assert.equal(await releaseJsonStreamDirLock(lockDir, reclaimedPriorInstance, options), false);

  const timeoutOwner = await acquireJsonStreamDirLock(lockDir, options);
  fs.mkdirSync(reaperDir);
  fs.writeFileSync(path.join(reaperDir, "owner.json"), JSON.stringify({
    host: "remote-host", pid: 123, process_instance_id: "remote", nonce: "remote", acquired_at: new Date().toISOString(),
  }));
  await assert.rejects(() => releaseJsonStreamDirLock(lockDir, timeoutOwner, options), (error) => error.code === "EVENT_SUBSTRATE_LOCK_TIMEOUT");
  fs.rmSync(reaperDir, { recursive: true, force: true });
  assert.equal(await releaseJsonStreamDirLock(lockDir, timeoutOwner, options), true);

  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
    host: os.hostname(), pid: 99999999, process_instance_id: "dead", nonce: "dead", acquired_at: old.toISOString(),
  }));
  const recoveredDead = await acquireJsonStreamDirLock(lockDir, options);
  assert.notEqual(recoveredDead.nonce, "dead");
  assert.equal(await releaseJsonStreamDirLock(lockDir, recoveredDead, options), true);

  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
    host: "remote-host", pid: 123, process_instance_id: "remote", nonce: "remote", acquired_at: new Date().toISOString(),
  }));
  await assert.rejects(() => acquireJsonStreamDirLock(lockDir, options), (error) => error.code === "EVENT_SUBSTRATE_LOCK_TIMEOUT");
  fs.rmSync(lockDir, { recursive: true, force: true });

  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, "owner.json"), "{}");
  fs.utimesSync(lockDir, old, old);
  const recoveredOwnerless = await acquireJsonStreamDirLock(lockDir, options);
  assert.equal(await releaseJsonStreamDirLock(lockDir, recoveredOwnerless, options), true);
});

test("filesystem test primitives fail closed on identity and retry faults", async (t) => {
  const {
    createPostgresEventSubstrateStore,
    jsonAppendLockIsStale,
    listJsonLockArtifacts,
    lockObservation,
    processIsAlive,
    quarantineStreamLockDir,
    readRegularFileSnapshot,
    retrySync,
    sameFileIdentity,
    unlinkArtifactWithIdentity,
    lstatRegularBoundary,
    verifyOpenedRegularBoundary,
  } = eventSubstrateTestInternals;
  assert.throws(() => createPostgresEventSubstrateStore({}), /DATABASE_URL is required/);
  const lazyPostgres = createPostgresEventSubstrateStore({ databaseUrl: "postgres://invalid.invalid/test", initialize: false });
  assert.equal(typeof lazyPostgres.appendEvent, "function");

  const emptyCountStore = createPostgresEventSubstrateStore({
    pool: { async query() { return { rows: [] }; } },
    initialize: false,
  });
  assert.equal((await emptyCountStore.storageInfo()).event_count, 0);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-internals-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDir = path.join(root, "lock");
  assert.equal(quarantineStreamLockDir(lockDir), false);
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ nonce: "right" }));
  const stat = fs.statSync(lockDir);
  assert.equal(quarantineStreamLockDir(lockDir, "wrong", stat), false);
  assert.equal(quarantineStreamLockDir(lockDir, "right", { ...stat, ino: stat.ino + 1 }), false);
  assert.equal(quarantineStreamLockDir(lockDir, "right", stat), true);

  let attempts = 0;
  assert.equal(retrySync(() => { attempts += 1; if (attempts < 3) throw new Error("retry"); }), null);
  assert.equal(attempts, 3);
  const exhausted = retrySync(() => { throw new Error("exhausted"); });
  assert.match(exhausted.message, /exhausted/);
  assert.equal(retrySync(() => { const error = new Error("gone"); error.code = "ENOENT"; throw error; }, { ignoreMissing: true }), null);

  const filePath = path.join(root, "event.jsonl");
  assert.equal(readRegularFileSnapshot(filePath, "event", { allowMissing: true }), null);
  assert.throws(() => readRegularFileSnapshot(filePath, "event"), /ENOENT/);
  fs.writeFileSync(filePath, "hello");
  assert.equal(readRegularFileSnapshot(filePath, "event").content, "hello");
  const originalOpenSync = fs.openSync;
  try {
    fs.openSync = function openAfterRetire(target) {
      if (target === filePath) throw Object.assign(new Error("retired before open"), { code: "ENOENT" });
      return Reflect.apply(originalOpenSync, this, arguments);
    };
    assert.equal(readRegularFileSnapshot(filePath, "event", { allowMissing: true }), null);
  } finally {
    fs.openSync = originalOpenSync;
  }
  const originalLstatSync = fs.lstatSync;
  let boundaryReads = 0;
  try {
    fs.lstatSync = function lstatAfterOpen(target) {
      if (target === filePath && ++boundaryReads === 2) throw Object.assign(new Error("retired after open"), { code: "ENOENT" });
      return Reflect.apply(originalLstatSync, this, arguments);
    };
    assert.equal(readRegularFileSnapshot(filePath, "event", { allowMissing: true }), null);
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  const target = path.join(root, "target");
  fs.writeFileSync(target, "target");
  const link = path.join(root, "link");
  fs.symlinkSync(target, link);
  assert.throws(() => readRegularFileSnapshot(link, "event"), (error) => error.code === "EVENT_SUBSTRATE_UNSAFE_PATH");
  assert.equal(unlinkArtifactWithIdentity(link, fs.lstatSync(link)).code, "EVENT_SUBSTRATE_UNSAFE_PATH");
  const directoryBoundary = path.join(root, "directory-boundary");
  fs.mkdirSync(directoryBoundary);
  assert.throws(() => readRegularFileSnapshot(directoryBoundary, "event"), (error) => error.code === "EVENT_SUBSTRATE_UNSAFE_PATH");

  assert.deepEqual(listJsonLockArtifacts(path.join(root, "missing", "append.lock")), []);
  const baseLock = path.join(root, "append.lock");
  fs.writeFileSync(`${baseLock}.candidate-one`, "x");
  fs.writeFileSync(`${baseLock}.claim-two`, "x");
  fs.writeFileSync(`${baseLock}.retired-three`, "x");
  fs.writeFileSync(`${baseLock}.other`, "x");
  assert.equal(listJsonLockArtifacts(baseLock).length, 3);

  assert.equal(unlinkArtifactWithIdentity("", {}), null);
  assert.equal(unlinkArtifactWithIdentity(path.join(root, "absent"), {}), null);
  const artifact = path.join(root, "artifact");
  fs.writeFileSync(artifact, "artifact");
  const artifactStat = fs.lstatSync(artifact);
  assert.equal(unlinkArtifactWithIdentity(artifact, { dev: artifactStat.dev, ino: artifactStat.ino + 1 }), null);
  assert.equal(fs.existsSync(artifact), true);
  assert.equal(unlinkArtifactWithIdentity(artifact, artifactStat), null);
  assert.equal(fs.existsSync(artifact), false);

  assert.equal(sameFileIdentity(null, artifactStat), false);
  assert.equal(sameFileIdentity(artifactStat, artifactStat), true);
  assert.equal(sameFileIdentity(artifactStat, { ...artifactStat, ino: artifactStat.ino + 1 }), false);
  const validOwner = { owner_id: "owner", pid: process.pid, host: os.hostname(), process_instance_id: "instance" };
  assert.equal(lockObservation("lock", { content: "bad", stat: artifactStat }).owner, null);
  assert.equal(lockObservation("lock", { content: JSON.stringify(validOwner), stat: artifactStat }).owner.owner_id, "owner");
  assert.equal(lockObservation("lock", { content: JSON.stringify({ owner_id: "", pid: 0, host: "" }), stat: artifactStat }).owner, null);

  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(99999999), false);
  const originalKill = process.kill;
  process.kill = () => { const error = new Error("permission"); error.code = "EPERM"; throw error; };
  try {
    assert.equal(processIsAlive(123), true);
  } finally {
    process.kill = originalKill;
  }
  const staleOptions = { staleMs: 10 };
  assert.equal(jsonAppendLockIsStale({ mtimeMs: Date.now(), owner: null }, staleOptions), false);
  assert.equal(jsonAppendLockIsStale({ mtimeMs: 0, owner: null }, staleOptions), true);
  assert.equal(jsonAppendLockIsStale({ mtimeMs: 0, owner: { host: "remote", pid: 1 } }, staleOptions), false);
  assert.equal(jsonAppendLockIsStale({ mtimeMs: Date.now(), owner: validOwner }, staleOptions), false);
  assert.equal(jsonAppendLockIsStale({ mtimeMs: 0, owner: validOwner }, staleOptions), true);
  assert.equal(jsonAppendLockIsStale({ mtimeMs: 0, owner: { ...validOwner, process_instance_id: "" } }, staleOptions), false);
  assert.equal(jsonAppendLockIsStale({ mtimeMs: 0, owner: { ...validOwner, pid: 99999999 } }, staleOptions), true);

  const boundary = path.join(root, "opened-boundary");
  fs.writeFileSync(boundary, "one");
  const before = lstatRegularBoundary(boundary, "test boundary");
  const handle = fs.openSync(boundary, "r");
  try {
    assert.equal(verifyOpenedRegularBoundary(boundary, handle, before, "test boundary").isFile(), true);
    assert.throws(
      () => verifyOpenedRegularBoundary(boundary, handle, { ...before, ino: before.ino + 1 }, "test boundary"),
      (error) => error.code === "EVENT_SUBSTRATE_UNSAFE_PATH",
    );
    fs.renameSync(boundary, `${boundary}.old`);
    fs.writeFileSync(boundary, "two");
    assert.throws(
      () => verifyOpenedRegularBoundary(boundary, handle, before, "test boundary"),
      (error) => error.code === "EVENT_SUBSTRATE_UNSAFE_PATH",
    );
  } finally {
    fs.closeSync(handle);
  }
  assert.equal(lstatRegularBoundary(path.join(root, "missing-boundary"), "test boundary", { allowMissing: true }), null);
});
