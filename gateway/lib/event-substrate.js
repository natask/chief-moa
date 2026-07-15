"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EVENTS_FILENAME = "product-events.jsonl";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_JSON_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_JSON_LOCK_RETRY_MS = 10;
const DEFAULT_JSON_LOCK_STALE_MS = 30_000;
const LOCK_OWNER_HOST = os.hostname() || "local";
const LOCK_PROCESS_INSTANCE_ID = crypto.randomUUID();
const LOCK_CLEANUP_ATTEMPTS = 3;
const MAX_LOCK_ARTIFACT_SCAN = 256;
const PROCESS_OWNED_JSON_LOCKS = new Map();
// In-process fairness gate for withStreamLock so same-process callers queue
// before contending for the cross-process file lock. Keyed by lock path.
const JSON_STREAM_LOCK_QUEUE = new Map();

class EventStreamVersionConflictError extends Error {
  constructor({ originId, streamId, expectedVersion, actualVersion }) {
    super(`event stream version conflict for ${originId}:${streamId}: expected ${expectedVersion}, actual ${actualVersion}`);
    this.name = "EventStreamVersionConflictError";
    this.code = "EVENT_STREAM_VERSION_CONFLICT";
    this.statusCode = 409;
    this.origin_id = originId;
    this.stream_id = streamId;
    this.expected_stream_version = expectedVersion;
    this.actual_stream_version = actualVersion;
  }
}

function createEventSubstrateStore(options = {}) {
  const databaseUrl = String(options.databaseUrl || process.env.DATABASE_URL || "").trim();
  if (databaseUrl || options.pool) {
    return createPostgresEventSubstrateStore({
      databaseUrl,
      pool: options.pool,
      schemaPath: options.schemaPath,
      initialize: options.initialize,
      originId: options.originId,
    });
  }
  return createJsonEventSubstrateStore(options);
}

function createJsonEventSubstrateStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || "./data");
  const eventsPath = path.join(dataDir, EVENTS_FILENAME);
  const originId = normalizeOriginId(options.originId);
  const lockOptions = normalizeJsonLockOptions(options);
  fs.mkdirSync(dataDir, { recursive: true });

  async function appendEvent(input = {}) {
    const expectedVersion = expectedStreamVersion(input);
    const base = normalizeEvent(input, { originId, streamVersion: 1 });
    return withJsonAppendLock(eventsPath, lockOptions, () => {
      const current = readJsonLinesStrict(eventsPath);
      const existing = findExistingEvent(current, input);
      if (existing) return clone(existing);

      const actualVersion = currentJsonStreamVersion(current, base.origin_id, base.stream_id);
      assertExpectedStreamVersion(base, expectedVersion, actualVersion);
      const event = { ...base, stream_version: actualVersion + 1 };
      appendJsonLine(eventsPath, event);
      return clone(event);
    });
  }

  async function listEvents(filter = {}) {
    const offset = clampOffset(filter.offset);
    const order = filter.order === "asc" ? "asc" : "desc";
    const events = readJsonLines(eventsPath)
      .filter((event) => matchesFilter(event, filter))
      .sort(order === "asc" ? compareEventsAsc : compareEventsDesc)
      .slice(offset, offset + clampLimit(filter.limit))
      .map(clone);
    return events;
  }

  async function getEvent(eventId) {
    const safeId = String(eventId || "").trim();
    if (!safeId) return null;
    return readJsonLines(eventsPath).find((event) => event.event_id === safeId) || null;
  }

  async function storageInfo() {
    const events = readJsonLines(eventsPath);
    return {
      mode: "jsonl",
      path: eventsPath,
      origin_id: originId,
      event_count: events.length,
      postgres_configured: false,
    };
  }

  // Serialized per-stream critical section. Callers pass a logical stream id and
  // run a read-modify-append transition with the guarantee that no other
  // withStreamLock caller for the same stream runs concurrently. Same-process
  // callers queue on a promise chain first; a lightweight atomic-mkdir lock
  // then guards across processes. This stays deliberately fast (no per-acquire
  // fsync) because a transition holds it around another durable append and the
  // deployment control plane binds it to short operation leases.
  async function withStreamLock(streamId, fn) {
    if (typeof fn !== "function") throw new Error("withStreamLock requires a function");
    const key = normalizeOptionalText(streamId, 240) || "default";
    const lockDir = `${eventsPath}.stream-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 20)}.lock`;
    const previous = JSON_STREAM_LOCK_QUEUE.get(lockDir) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    // Chain past the prior holder regardless of how it settled so one failed
    // transition cannot wedge the stream.
    const queued = previous.then(() => current, () => current);
    JSON_STREAM_LOCK_QUEUE.set(lockDir, queued);
    try { await previous; } catch { /* prior holder failure must not block us */ }
    const owner = await acquireJsonStreamDirLock(lockDir, lockOptions);
    try {
      return await fn();
    } finally {
      // Identity-bound release: if this holder ran long enough to be reclaimed,
      // the nonce no longer matches and the successor's lock is left intact.
      try { await releaseJsonStreamDirLock(lockDir, owner, lockOptions); } catch { /* best effort */ }
      release();
      if (JSON_STREAM_LOCK_QUEUE.get(lockDir) === queued) JSON_STREAM_LOCK_QUEUE.delete(lockDir);
    }
  }

  return { appendEvent, listEvents, getEvent, storageInfo, withStreamLock };
}

function createPostgresEventSubstrateStore(options = {}) {
  const databaseUrl = String(options.databaseUrl || "").trim();
  if (!databaseUrl && !options.pool) {
    throw new Error("DATABASE_URL is required for Postgres event substrate storage");
  }
  const pool = options.pool || createPool(databaseUrl);
  const schemaPath = options.schemaPath || path.resolve(__dirname, "..", "schema.sql");
  const initialize = options.initialize !== false;
  const originId = normalizeOriginId(options.originId);
  let readyPromise = null;

  function ready() {
    if (!initialize) return Promise.resolve();
    if (!readyPromise) {
      readyPromise = fs.promises.readFile(schemaPath, "utf8").then((schema) => pool.query(schema));
    }
    return readyPromise;
  }

  async function appendEvent(input = {}) {
    await ready();
    const idempotencyKey = normalizeOptionalText(input.idempotency_key || input.idempotencyKey, 240);
    const eventId = normalizeOptionalText(input.event_id || input.eventId, 120);
    const existing = await findExistingPostgresEvent({ eventId, idempotencyKey }, pool);
    if (existing) return existing;

    return withTransaction(pool, async (client) => {
      return appendEventOnClient(client, input, { originId });
    });
  }

  async function listEvents(filter = {}) {
    await ready();
    const params = [];
    const where = [];
    addWhere(where, params, "event_type", filter.event_type || filter.eventType);
    addWhere(where, params, "stream_id", filter.stream_id || filter.streamId);
    addWhere(where, params, "origin_id", filter.origin_id || filter.originId);
    addWhere(where, params, "correlation_id", filter.correlation_id || filter.correlationId);
    addWhere(where, params, "idempotency_key", filter.idempotency_key || filter.idempotencyKey);
    const prefix = normalizeOptionalText(filter.event_type_prefix || filter.eventTypePrefix, 160);
    if (prefix) {
      params.push(`${prefix}%`);
      where.push(`event_type like $${params.length}`);
    }
    const limit = clampLimit(filter.limit);
    const offset = clampOffset(filter.offset);
    params.push(limit);
    params.push(offset);
    const order = filter.order === "asc" ? "asc" : "desc";
    const result = await pool.query(
      `select * from product_events${where.length ? ` where ${where.join(" and ")}` : ""}
       order by recorded_at ${order}, stream_version ${order}, event_id ${order}
       limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return result.rows.map(eventFromRow);
  }

  async function getEvent(eventId) {
    await ready();
    const safeId = normalizeOptionalText(eventId, 120);
    if (!safeId) return null;
    const result = await pool.query("select * from product_events where event_id = $1", [safeId]);
    return result.rows[0] ? eventFromRow(result.rows[0]) : null;
  }

  async function storageInfo() {
    await ready();
    const result = await pool.query("select count(*)::bigint as count from product_events");
    return {
      mode: "postgres",
      origin_id: originId,
      event_count: Number(result.rows[0]?.count || 0),
      postgres_configured: true,
      table: "product_events",
    };
  }

  // Serialized per-stream critical section. Holds a session-level advisory lock
  // on a dedicated connection for the whole transition. The key is namespaced
  // apart from appendEvent's per-stream xact advisory lock so an append issued
  // from inside fn (on a pool connection) can never self-deadlock against the
  // transition lock this holds.
  async function withStreamLock(streamId, fn) {
    if (typeof fn !== "function") throw new Error("withStreamLock requires a function");
    await ready();
    const client = await pool.connect();
    const key = `stream-transition:${originId}:${normalizeOptionalText(streamId, 240)}`;
    try {
      await client.query("select pg_advisory_lock(hashtext($1))", [key]);
      return await fn();
    } finally {
      try {
        await client.query("select pg_advisory_unlock(hashtext($1))", [key]);
      } finally {
        client.release();
      }
    }
  }

  return { appendEvent, listEvents, getEvent, storageInfo, withStreamLock };
}

async function appendEventOnClient(client, input = {}, options = {}) {
  if (!client || typeof client.query !== "function") {
    throw new Error("appendEventOnClient requires a pg client");
  }
  const originId = normalizeOriginId(options.originId);
  const base = normalizeEvent(input, { originId, streamVersion: 0 });
  const expectedVersion = expectedStreamVersion(input);
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${base.origin_id}:${base.stream_id}`]);

  const secondExisting = await findExistingPostgresEvent({
    eventId: base.event_id,
    idempotencyKey: base.idempotency_key,
  }, client);
  if (secondExisting) return secondExisting;

  const actualVersion = await currentPostgresStreamVersion(client, base.origin_id, base.stream_id);
  assertExpectedStreamVersion(base, expectedVersion, actualVersion);
  const event = { ...base, stream_version: actualVersion + 1 };
  const result = await client.query(
    `insert into product_events (
       event_id, origin_id, stream_id, stream_version, event_type,
       event_schema_version, occurred_at, recorded_at, actor, authority,
       causation_id, correlation_id, idempotency_key, payload, blob_refs,
       crdt_refs, signature
     ) values (
       $1, $2, $3, $4, $5,
       $6, $7::timestamptz, $8::timestamptz, $9::jsonb, $10::jsonb,
       $11, $12, $13, $14::jsonb, $15::jsonb,
       $16::jsonb, $17
     )
     returning *`,
    [
      event.event_id,
      event.origin_id,
      event.stream_id,
      event.stream_version,
      event.event_type,
      event.event_schema_version,
      event.occurred_at,
      event.recorded_at,
      JSON.stringify(event.actor),
      JSON.stringify(event.authority),
      event.causation_id || null,
      event.correlation_id || null,
      event.idempotency_key || null,
      JSON.stringify(event.payload),
      JSON.stringify(event.blob_refs),
      JSON.stringify(event.crdt_refs),
      event.signature || null,
    ],
  );
  return eventFromRow(result.rows[0]);
}

function normalizeEvent(input = {}, defaults = {}) {
  const now = new Date().toISOString();
  const originId = normalizeOptionalText(input.origin_id || input.originId, 120)
    || defaults.originId
    || normalizeOriginId("");
  const streamId = normalizeOptionalText(input.stream_id || input.streamId, 240)
    || streamIdForEvent(input);
  return {
    event_id: normalizeOptionalText(input.event_id || input.eventId, 120) || `evt_${crypto.randomUUID()}`,
    origin_id: originId,
    stream_id: streamId,
    stream_version: positiveInteger(input.stream_version || input.streamVersion, defaults.streamVersion || 1),
    event_type: normalizeEventType(input.event_type || input.eventType || input.type),
    event_schema_version: positiveInteger(input.event_schema_version || input.eventSchemaVersion, 1),
    occurred_at: normalizeDate(input.occurred_at || input.occurredAt || input.ts || input.created_at || input.createdAt, now),
    recorded_at: normalizeDate(input.recorded_at || input.recordedAt, now),
    actor: normalizeActor(input.actor),
    authority: plainObject(input.authority),
    causation_id: normalizeOptionalText(input.causation_id || input.causationId, 120),
    correlation_id: normalizeOptionalText(input.correlation_id || input.correlationId, 120),
    idempotency_key: normalizeOptionalText(input.idempotency_key || input.idempotencyKey, 240),
    payload: plainObject(input.payload),
    blob_refs: arrayOfObjects(input.blob_refs || input.blobRefs),
    crdt_refs: arrayOfObjects(input.crdt_refs || input.crdtRefs),
    signature: normalizeOptionalText(input.signature, 400),
  };
}

function streamIdForEvent(input = {}) {
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  const sessionId = normalizeOptionalText(input.session_id || input.sessionId || payload.session_id || payload.sessionId, 160);
  if (sessionId) return `session:${sessionId}`;
  const runId = normalizeOptionalText(input.run_id || input.runId || payload.run_id || payload.runId, 160);
  if (runId) return `run:${runId}`;
  return `event:${normalizeEventType(input.event_type || input.eventType || input.type)}`;
}

function normalizeEventType(value) {
  const text = String(value || "event.recorded").trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, ".");
  return text.replace(/\.+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 160) || "event.recorded";
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    return { kind: "gateway", id: "gateway" };
  }
  return {
    kind: normalizeOptionalText(actor.kind, 80) || "gateway",
    id: normalizeOptionalText(actor.id, 160) || "gateway",
  };
}

function normalizeOriginId(value) {
  return normalizeOptionalText(value || process.env.MOA_ORIGIN_ID || process.env.GATEWAY_ORIGIN_ID, 120)
    || `gateway-${os.hostname() || "local"}`;
}

function normalizeOptionalText(value, max) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : "";
}

function normalizeDate(value, fallback) {
  const text = String(value || "").trim();
  const date = text ? new Date(text) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

function arrayOfObjects(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object" && !Array.isArray(item)).slice(0, 100);
}

function findExistingEvent(events, input = {}) {
  const eventId = normalizeOptionalText(input.event_id || input.eventId, 120);
  const idempotencyKey = normalizeOptionalText(input.idempotency_key || input.idempotencyKey, 240);
  return events.find((event) =>
    (eventId && event.event_id === eventId) ||
    (idempotencyKey && event.idempotency_key === idempotencyKey)
  ) || null;
}

async function findExistingPostgresEvent({ eventId, idempotencyKey }, clientOrPool) {
  const db = clientOrPool || null;
  if (!db) return null;
  const params = [];
  const where = [];
  if (eventId) {
    params.push(eventId);
    where.push(`event_id = $${params.length}`);
  }
  if (idempotencyKey) {
    params.push(idempotencyKey);
    where.push(`idempotency_key = $${params.length}`);
  }
  if (where.length === 0) return null;
  const result = await db.query(`select * from product_events where ${where.join(" or ")} limit 1`, params);
  return result.rows[0] ? eventFromRow(result.rows[0]) : null;
}

async function currentPostgresStreamVersion(client, originId, streamId) {
  const result = await client.query(
    "select coalesce(max(stream_version), 0) as current_version from product_events where origin_id = $1 and stream_id = $2",
    [originId, streamId],
  );
  return Number(result.rows[0]?.current_version || 0);
}

function currentJsonStreamVersion(events, originId, streamId) {
  return events
    .filter((event) => event.origin_id === originId && event.stream_id === streamId)
    .reduce((max, event) => Math.max(max, Number(event.stream_version || 0)), 0);
}

function matchesFilter(event, filter = {}) {
  const exact = [
    ["event_type", filter.event_type || filter.eventType],
    ["stream_id", filter.stream_id || filter.streamId],
    ["origin_id", filter.origin_id || filter.originId],
    ["correlation_id", filter.correlation_id || filter.correlationId],
    ["idempotency_key", filter.idempotency_key || filter.idempotencyKey],
  ];
  for (const [field, value] of exact) {
    const expected = normalizeOptionalText(value, 240);
    if (expected && event[field] !== expected) return false;
  }
  const prefix = normalizeOptionalText(filter.event_type_prefix || filter.eventTypePrefix, 160);
  if (prefix && !String(event.event_type || "").startsWith(prefix)) return false;
  return true;
}

function compareEventsDesc(a, b) {
  return String(b.recorded_at || "").localeCompare(String(a.recorded_at || ""))
    || Number(b.stream_version || 0) - Number(a.stream_version || 0)
    || String(b.event_id || "").localeCompare(String(a.event_id || ""));
}

function compareEventsAsc(a, b) {
  return String(a.recorded_at || "").localeCompare(String(b.recorded_at || ""))
    || Number(a.stream_version || 0) - Number(b.stream_version || 0)
    || String(a.event_id || "").localeCompare(String(b.event_id || ""));
}

function clampLimit(limit) {
  const value = Number(limit || DEFAULT_LIMIT);
  return Math.max(1, Math.min(Number.isFinite(value) ? value : DEFAULT_LIMIT, MAX_LIMIT));
}

function clampOffset(offset) {
  const value = Number(offset);
  return Number.isInteger(value) && value >= 0 ? Math.min(value, 10_000_000) : 0;
}

function addWhere(where, params, column, value) {
  const safe = normalizeOptionalText(value, 240);
  if (!safe) return;
  params.push(safe);
  where.push(`${column} = $${params.length}`);
}

function eventFromRow(row) {
  return {
    event_id: row.event_id,
    origin_id: row.origin_id,
    stream_id: row.stream_id,
    stream_version: Number(row.stream_version),
    event_type: row.event_type,
    event_schema_version: Number(row.event_schema_version),
    occurred_at: toIso(row.occurred_at),
    recorded_at: toIso(row.recorded_at),
    actor: row.actor || {},
    authority: row.authority || {},
    causation_id: row.causation_id || "",
    correlation_id: row.correlation_id || "",
    idempotency_key: row.idempotency_key || "",
    payload: row.payload || {},
    blob_refs: Array.isArray(row.blob_refs) ? row.blob_refs : [],
    crdt_refs: Array.isArray(row.crdt_refs) ? row.crdt_refs : [],
    signature: row.signature || "",
  };
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function createPool(databaseUrl) {
  const { Pool } = require("pg");
  return new Pool({ connectionString: databaseUrl });
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try { await client.query("rollback"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const before = lstatRegularBoundary(filePath, "event file", { allowMissing: true });
  const flags = fs.constants.O_APPEND
    | fs.constants.O_CREAT
    | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW || 0);
  const handle = fs.openSync(filePath, flags, 0o600);
  const line = Buffer.from(`${JSON.stringify(value)}\n`);
  try {
    verifyOpenedRegularBoundary(filePath, handle, before, "event file");
    let offset = 0;
    while (offset < line.length) {
      const written = fs.writeSync(handle, line, offset, line.length - offset);
      if (written <= 0) throw new Error(`failed to append event substrate record to ${filePath}`);
      offset += written;
    }
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function readJsonLinesStrict(filePath) {
  const snapshot = readRegularFileSnapshot(filePath, "event file", { allowMissing: true });
  if (!snapshot) return [];
  const content = snapshot.content;
  return content.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch (cause) {
      const error = new Error(`invalid JSONL event record at line ${index + 1}`);
      error.code = "EVENT_SUBSTRATE_CORRUPT";
      error.cause = cause;
      throw error;
    }
  });
}

function readJsonLines(filePath) {
  const snapshot = readRegularFileSnapshot(filePath, "event file", { allowMissing: true });
  if (!snapshot) return [];
  return snapshot.content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectedStreamVersion(input = {}) {
  const hasSnake = Object.prototype.hasOwnProperty.call(input, "expected_stream_version");
  const hasCamel = Object.prototype.hasOwnProperty.call(input, "expectedStreamVersion");
  if (!hasSnake && !hasCamel) return null;
  const snake = hasSnake ? Number(input.expected_stream_version) : null;
  const camel = hasCamel ? Number(input.expectedStreamVersion) : null;
  if ((hasSnake && (!Number.isSafeInteger(snake) || snake < 0))
    || (hasCamel && (!Number.isSafeInteger(camel) || camel < 0))
    || (hasSnake && hasCamel && snake !== camel)) {
    const error = new TypeError("expected_stream_version must be a non-negative safe integer");
    error.code = "INVALID_EXPECTED_STREAM_VERSION";
    error.statusCode = 400;
    throw error;
  }
  return hasSnake ? snake : camel;
}

function assertExpectedStreamVersion(event, expectedVersion, actualVersion) {
  if (expectedVersion === null || expectedVersion === actualVersion) return;
  throw new EventStreamVersionConflictError({
    originId: event.origin_id,
    streamId: event.stream_id,
    expectedVersion,
    actualVersion,
  });
}

function normalizeJsonLockOptions(options = {}) {
  return {
    timeoutMs: boundedPositiveInteger(options.jsonLockTimeoutMs, DEFAULT_JSON_LOCK_TIMEOUT_MS, 100, 60_000),
    retryMs: boundedPositiveInteger(options.jsonLockRetryMs, DEFAULT_JSON_LOCK_RETRY_MS, 1, 1_000),
    staleMs: boundedPositiveInteger(options.jsonLockStaleMs, DEFAULT_JSON_LOCK_STALE_MS, 100, 300_000),
  };
}

function boundedPositiveInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) return fallback;
  return number;
}

// Lightweight atomic-mkdir lock backing withStreamLock. mkdir is atomic across
// processes on POSIX and needs no fsync, so the uncontended fast path stays
// cheap. A holder that crashes leaves the directory behind; stale reclaim is
// reaper-guarded: the first stale observation is only a hint, the re-check and
// removal happen under a dedicated reaper mutex, and removal is bound to the
// exact directory (owner nonce + inode) that was judged stale so two racing
// reclaimers can never delete a fresh successor's lock.
async function acquireJsonStreamDirLock(lockDir, options) {
  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    const owner = streamLockOwner();
    let created = false;
    try {
      fs.mkdirSync(lockDir);
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (created) {
      try {
        fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      } catch (error) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }
        throw error;
      }
      return owner;
    }
    const observed = readStreamLockState(lockDir);
    if (streamLockStateIsStale(observed, options.staleMs)) {
      await withStreamReaperLock(lockDir, options, async () => {
        // The first observation is only a hint. Re-read while every release
        // and competing stale reaper is excluded, so a replacement lock can
        // never be deleted based on its predecessor's stale state.
        const current = readStreamLockState(lockDir);
        if (streamLockStateIsStale(current, options.staleMs)) {
          quarantineStreamLockDir(lockDir, current.owner?.nonce || "", current.stat);
        }
      });
      continue;
    }
    if (Date.now() >= deadline) {
      const error = new Error(`timed out acquiring event stream lock: ${path.basename(lockDir)}`);
      error.code = "EVENT_SUBSTRATE_LOCK_TIMEOUT";
      throw error;
    }
    await delay(options.retryMs);
  }
}

// Release is identity-bound: only the recorded owner's own directory is
// removed, under the same reaper mutex the reclaim path uses, so a holder that
// was reclaimed while still running cannot delete its successor's lock.
async function releaseJsonStreamDirLock(lockDir, owner, options) {
  return withStreamReaperLock(lockDir, options, async () => {
    const current = readStreamLockState(lockDir);
    if (!current || !owner?.nonce || current.owner?.nonce !== owner.nonce) return false;
    return quarantineStreamLockDir(lockDir, owner.nonce, current.stat);
  });
}

function streamLockOwner() {
  return {
    host: LOCK_OWNER_HOST,
    pid: process.pid,
    process_instance_id: LOCK_PROCESS_INSTANCE_ID,
    nonce: crypto.randomUUID(),
    acquired_at: new Date().toISOString(),
  };
}

function readStreamLockState(lockDir) {
  try {
    const stat = fs.statSync(lockDir);
    let owner = {};
    try { owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")); } catch { owner = {}; }
    if (!owner || typeof owner !== "object") owner = {};
    return { stat, owner };
  } catch {
    return null;
  }
}

function streamLockStateIsStale(state, staleMs) {
  if (!state) return false;
  const age = Date.now() - Number(state.stat.mtimeMs || 0);
  const owner = state.owner || {};
  // Ownerless or corrupt owner records (crash between mkdir and the owner
  // write) fall back to the bounded stale age.
  if (!owner.host || !owner.pid || !owner.nonce) return age >= staleMs;
  // A holder on another host cannot be liveness-checked here. Preserve it and
  // let acquisition time out instead of stealing a possibly-live lock.
  if (owner.host !== LOCK_OWNER_HOST) return false;
  if (owner.pid === process.pid) {
    // Same pid: only a prior instance of this process (pid reuse across
    // restarts) is reclaimable; our own live instance never is.
    return typeof owner.process_instance_id === "string"
      && owner.process_instance_id !== LOCK_PROCESS_INSTANCE_ID;
  }
  return !processIsAlive(owner.pid);
}

// Serializes stale reclaim and release for one stream lock. The reaper mutex
// itself is a mkdir lock with the same identity-bound reclaim, so a crashed
// reaper cannot wedge the stream.
async function withStreamReaperLock(lockDir, options, fn) {
  const reaperDir = `${lockDir}.reaper`;
  const deadline = Date.now() + options.timeoutMs;
  let owner = null;
  while (!owner) {
    const candidate = streamLockOwner();
    let created = false;
    try {
      fs.mkdirSync(reaperDir);
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (created) {
      try {
        fs.writeFileSync(path.join(reaperDir, "owner.json"), JSON.stringify(candidate), { flag: "wx", mode: 0o600 });
        owner = candidate;
      } catch (error) {
        try { fs.rmSync(reaperDir, { recursive: true, force: true }); } catch { /* best effort */ }
        throw error;
      }
      break;
    }
    const observed = readStreamLockState(reaperDir);
    if (streamLockStateIsStale(observed, options.staleMs)) {
      // Bind reclamation to the exact owner and inode that were judged stale.
      // If a competing reaper already replaced the mutex, this conditional
      // quarantine becomes a no-op and can never remove the fresh one.
      quarantineStreamLockDir(reaperDir, observed.owner?.nonce || "", observed.stat);
    } else if (Date.now() >= deadline) {
      const error = new Error(`timed out acquiring event stream lock reaper: ${path.basename(reaperDir)}`);
      error.code = "EVENT_SUBSTRATE_LOCK_TIMEOUT";
      throw error;
    } else {
      await delay(options.retryMs);
    }
  }
  try {
    return await fn();
  } finally {
    quarantineStreamLockDir(reaperDir, owner.nonce);
  }
}

// Removes a lock directory only when it is still the directory that was
// observed: the caller pins the expected owner nonce and, when available, the
// stat identity (dev + inode). rename-then-rm keeps the removal atomic with
// respect to competing mkdir acquisitions at the same path.
function quarantineStreamLockDir(lockDir, expectedNonce = "", expectedStat = null) {
  const current = readStreamLockState(lockDir);
  if (!current) return false;
  if (expectedNonce && current.owner?.nonce !== expectedNonce) return false;
  if (expectedStat && (current.stat.dev !== expectedStat.dev || current.stat.ino !== expectedStat.ino)) return false;
  const tombstone = `${lockDir}.released-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockDir, tombstone);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  fs.rmSync(tombstone, { recursive: true, force: true });
  return true;
}

async function withJsonAppendLock(eventsPath, options, task) {
  const lock = await acquireJsonAppendLock(`${eventsPath}.append.lock`, options);
  let result;
  let taskError = null;
  try {
    result = await task();
  } catch (error) {
    taskError = error;
  }
  let releaseError = null;
  try {
    releaseJsonAppendLock(lock);
  } catch (error) {
    lock.active = false;
    lock.abandoned = true;
    releaseError = error;
  }
  if (taskError) {
    if (releaseError) taskError.lock_release_error = releaseError;
    throw taskError;
  }
  if (releaseError) throw releaseError;
  return result;
}

async function acquireJsonAppendLock(lockPath, options) {
  const deadline = Date.now() + options.timeoutMs;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  reconcileProcessOwnedJsonLock(lockPath);
  reconcileDetachedJsonLockArtifacts(lockPath, options);
  while (true) {
    reconcileProcessOwnedJsonLock(lockPath);
    const ownerId = crypto.randomUUID();
    const candidatePath = `${lockPath}.candidate-${ownerId}`;
    const owner = {
      owner_id: ownerId,
      pid: process.pid,
      host: LOCK_OWNER_HOST,
      process_instance_id: LOCK_PROCESS_INSTANCE_ID,
      acquired_at: new Date().toISOString(),
    };
    const candidateIdentity = writeDurableLockCandidate(candidatePath, owner);
    let linked = false;
    try {
      fs.linkSync(candidatePath, lockPath);
      linked = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    if (linked) {
      const lock = {
        lockPath,
        ownerId,
        dev: candidateIdentity.dev,
        ino: candidateIdentity.ino,
        candidatePath,
        active: true,
        abandoned: false,
        cleanupErrors: [],
      };
      PROCESS_OWNED_JSON_LOCKS.set(lockPath, lock);
      const cleanupError = unlinkArtifactWithIdentity(candidatePath, lock);
      if (cleanupError) lock.cleanupErrors.push(cleanupError);
      return lock;
    }

    const candidateCleanupError = unlinkArtifactWithIdentity(candidatePath, candidateIdentity);
    if (candidateCleanupError) throw candidateCleanupError;

    const observed = inspectJsonAppendLock(lockPath);
    if (observed && jsonAppendLockIsStale(observed, options)) {
      try {
        retireJsonAppendLock(observed, { requireStale: options });
      } catch (error) {
        const current = inspectJsonAppendLock(lockPath);
        if (current) throw error;
      }
    }
    if (Date.now() >= deadline) {
      const error = new Error(`timed out acquiring event substrate append lock: ${lockPath}`);
      error.code = "EVENT_SUBSTRATE_LOCK_TIMEOUT";
      throw error;
    }
    await delay(options.retryMs);
  }
}

function writeDurableLockCandidate(candidatePath, owner) {
  const flags = fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW || 0);
  const handle = fs.openSync(candidatePath, flags, 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(owner)}\n`, "utf8");
    fs.fsyncSync(handle);
    const identity = fs.fstatSync(handle);
    if (!identity.isFile()) throw unsafeBoundaryError(candidatePath, "lock candidate");
    return { dev: identity.dev, ino: identity.ino, mtimeMs: identity.mtimeMs };
  } finally {
    fs.closeSync(handle);
  }
}

function inspectJsonAppendLock(lockPath) {
  const snapshot = readRegularFileSnapshot(lockPath, "append lock", { allowMissing: true });
  if (!snapshot) return null;
  return lockObservation(lockPath, snapshot);
}

function jsonAppendLockIsStale(observed, options) {
  const ageMs = Math.max(0, Date.now() - Number(observed.mtimeMs || 0));
  if (!observed.owner) return ageMs >= options.staleMs;
  if (observed.owner.host !== LOCK_OWNER_HOST) return false;
  const staleAgeReached = ageMs >= options.staleMs;
  if (!staleAgeReached) return false;
  const ownerInstanceId = typeof observed.owner.process_instance_id === "string"
    ? observed.owner.process_instance_id
    : "";
  if (observed.owner.pid === process.pid && ownerInstanceId) {
    return ownerInstanceId !== LOCK_PROCESS_INSTANCE_ID;
  }
  return !processIsAlive(observed.owner.pid);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function releaseJsonAppendLock(lock) {
  const observed = inspectJsonAppendLock(lock.lockPath);
  if (!observed
    || observed.dev !== lock.dev
    || observed.ino !== lock.ino
    || observed.owner?.owner_id !== lock.ownerId) {
    const error = new Error(`event substrate append lock ownership changed before release: ${lock.lockPath}`);
    error.code = "EVENT_SUBSTRATE_LOCK_OWNERSHIP_LOST";
    throw error;
  }
  const identity = lockIdentity(observed);
  const retiredPath = `${lock.lockPath}.retired-${lock.ownerId}-${crypto.randomUUID()}`;
  const renameError = retrySync(() => fs.renameSync(lock.lockPath, retiredPath));
  if (renameError) throw renameError;

  lock.active = false;
  lock.abandoned = false;
  PROCESS_OWNED_JSON_LOCKS.delete(lock.lockPath);
  const cleanupErrors = [];
  const retiredCleanupError = unlinkArtifactWithIdentity(retiredPath, identity);
  if (retiredCleanupError) cleanupErrors.push(retiredCleanupError);
  const candidateCleanupError = unlinkArtifactWithIdentity(lock.candidatePath, identity);
  if (candidateCleanupError) cleanupErrors.push(candidateCleanupError);
  cleanupErrors.push(...cleanupJsonLockArtifactsForIdentity(lock.lockPath, identity));
  if (cleanupErrors.length > 0) throw cleanupErrors[0];
}

function retireJsonAppendLock(observed, { requireStale = null } = {}) {
  const identity = lockIdentity(observed);
  const identityText = `${observed.owner?.owner_id || "partial"}-${observed.dev}-${observed.ino}`
    .replace(/[^a-zA-Z0-9_.-]/g, "_");
  const claimPath = `${observed.lockPath}.claim-${identityText}`;
  const claim = acquireJsonReaperClaim(claimPath, observed, requireStale);
  if (!claim) return false;
  let canonicalRetired = false;
  try {
    const currentClaim = inspectJsonReaperClaim(claimPath, observed);
    const current = inspectJsonAppendLock(observed.lockPath);
    if (!currentClaim
      || currentClaim.claimId !== claim.claimId
      || !sameFileIdentity(currentClaim, claim)
      || !current
      || !sameFileIdentity(current, identity)
      || (requireStale && !jsonAppendLockIsStale(current, requireStale))) {
      return false;
    }
    const retiredPath = `${observed.lockPath}.retired-${identityText}-${crypto.randomUUID()}`;
    const renameError = retrySync(() => fs.renameSync(observed.lockPath, retiredPath));
    if (renameError) throw renameError;
    canonicalRetired = true;

    const cleanupErrors = [];
    const retiredCleanupError = unlinkArtifactWithIdentity(retiredPath, identity);
    if (retiredCleanupError) cleanupErrors.push(retiredCleanupError);
    cleanupErrors.push(...cleanupJsonLockArtifactsForIdentity(observed.lockPath, identity));
    const claimCleanupError = unlinkArtifactWithIdentity(claimPath, claim);
    if (claimCleanupError) cleanupErrors.push(claimCleanupError);
    if (cleanupErrors.length > 0) throw cleanupErrors[0];
    return true;
  } finally {
    if (!canonicalRetired) unlinkArtifactWithIdentity(claimPath, claim);
  }
}

function acquireJsonReaperClaim(claimPath, observed, options) {
  for (let attempt = 0; attempt < LOCK_CLEANUP_ATTEMPTS; attempt += 1) {
    const claimId = crypto.randomUUID();
    const candidatePath = `${claimPath}.candidate-${claimId}`;
    const record = {
      owner_id: claimId,
      pid: process.pid,
      host: LOCK_OWNER_HOST,
      process_instance_id: LOCK_PROCESS_INSTANCE_ID,
      acquired_at: new Date().toISOString(),
      observed_owner_id: observed.owner?.owner_id || "",
      observed_dev: observed.dev,
      observed_ino: observed.ino,
    };
    const candidate = writeDurableLockCandidate(candidatePath, record);
    let created = false;
    try {
      fs.linkSync(candidatePath, claimPath);
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const candidateCleanupError = unlinkArtifactWithIdentity(candidatePath, candidate);
    if (candidateCleanupError) throw candidateCleanupError;
    if (created) return { ...candidate, claimId };

    const existing = inspectJsonReaperClaim(claimPath, observed);
    if (!existing) continue;
    if (!jsonAppendLockIsStale(existing, options)) return null;

    const movedPath = `${claimPath}.stale-${existing.claimId}-${crypto.randomUUID()}`;
    const moveError = retrySync(() => fs.renameSync(claimPath, movedPath));
    if (moveError) {
      if (moveError.code === "ENOENT") continue;
      throw moveError;
    }
    const moved = inspectJsonReaperClaim(movedPath, observed);
    if (!moved || moved.claimId !== existing.claimId || !sameFileIdentity(moved, existing)) {
      const restoreError = retrySync(() => fs.renameSync(movedPath, claimPath));
      if (restoreError && restoreError.code !== "EEXIST") throw restoreError;
      return null;
    }
    const staleCleanupError = unlinkArtifactWithIdentity(movedPath, moved);
    if (staleCleanupError) throw staleCleanupError;
  }
  return null;
}

function inspectJsonReaperClaim(claimPath, observed) {
  const snapshot = readRegularFileSnapshot(claimPath, "append lock claim", { allowMissing: true });
  if (!snapshot) return null;
  const claim = lockObservation(claimPath, snapshot);
  const owner = claim.owner;
  if (!owner
    || owner.observed_dev !== observed.dev
    || owner.observed_ino !== observed.ino
    || String(owner.observed_owner_id || "") !== String(observed.owner?.owner_id || "")) {
    throw unsafeBoundaryError(claimPath, "append lock claim authority");
  }
  return { ...claim, claimId: owner.owner_id };
}

function reconcileProcessOwnedJsonLock(lockPath) {
  const lock = PROCESS_OWNED_JSON_LOCKS.get(lockPath);
  if (!lock || lock.active || !lock.abandoned) return;
  try {
    releaseJsonAppendLock(lock);
  } catch (error) {
    const current = inspectJsonAppendLock(lockPath);
    if (current) throw error;
    PROCESS_OWNED_JSON_LOCKS.delete(lockPath);
  }
}

function reconcileDetachedJsonLockArtifacts(lockPath, options) {
  const canonical = inspectJsonAppendLock(lockPath);
  for (const artifactPath of listJsonLockArtifacts(lockPath)) {
    const snapshot = readRegularFileSnapshot(artifactPath, "append lock artifact", { allowMissing: true });
    if (!snapshot) continue;
    if (canonical && sameFileIdentity(snapshot.stat, canonical)) continue;
    const artifact = lockObservation(artifactPath, snapshot);
    if (!artifact.owner || !jsonAppendLockIsStale(artifact, options)) continue;
    const cleanupError = unlinkArtifactWithIdentity(artifactPath, artifact);
    if (cleanupError) throw cleanupError;
  }
}

function cleanupJsonLockArtifactsForIdentity(lockPath, identity) {
  const errors = [];
  for (const artifactPath of listJsonLockArtifacts(lockPath)) {
    let artifact;
    try {
      artifact = lstatRegularBoundary(artifactPath, "append lock artifact", { allowMissing: true });
    } catch (error) {
      errors.push(error);
      continue;
    }
    if (!artifact || !sameFileIdentity(artifact, identity)) continue;
    const cleanupError = unlinkArtifactWithIdentity(artifactPath, identity);
    if (cleanupError) errors.push(cleanupError);
  }
  return errors;
}

function listJsonLockArtifacts(lockPath) {
  const directory = path.dirname(lockPath);
  const base = path.basename(lockPath);
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.startsWith(`${base}.candidate-`)
      || name.startsWith(`${base}.claim-`)
      || name.startsWith(`${base}.retired-`))
    .slice(0, MAX_LOCK_ARTIFACT_SCAN)
    .map((name) => path.join(directory, name));
}

function unlinkArtifactWithIdentity(artifactPath, identity) {
  if (!artifactPath) return null;
  let current;
  try {
    current = lstatRegularBoundary(artifactPath, "append lock artifact", { allowMissing: true });
  } catch (error) {
    return error;
  }
  if (!current || !sameFileIdentity(current, identity)) return null;
  return retrySync(() => fs.unlinkSync(artifactPath), { ignoreMissing: true });
}

function retrySync(operation, { ignoreMissing = false } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < LOCK_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      operation();
      return null;
    } catch (error) {
      if (ignoreMissing && error?.code === "ENOENT") return null;
      lastError = error;
    }
  }
  return lastError;
}

function lockObservation(lockPath, snapshot) {
  let owner = null;
  try {
    const parsed = JSON.parse(snapshot.content);
    if (typeof parsed?.owner_id === "string"
      && parsed.owner_id.length > 0
      && Number.isSafeInteger(parsed?.pid)
      && parsed.pid > 0
      && typeof parsed?.host === "string"
      && parsed.host.length > 0) {
      owner = parsed;
    }
  } catch {}
  return {
    lockPath,
    dev: snapshot.stat.dev,
    ino: snapshot.stat.ino,
    mtimeMs: snapshot.stat.mtimeMs,
    owner,
  };
}

function lockIdentity(value) {
  return { dev: value.dev, ino: value.ino };
}

function sameFileIdentity(left, right) {
  return Boolean(left) && Boolean(right) && left.dev === right.dev && left.ino === right.ino;
}

function readRegularFileSnapshot(filePath, label, { allowMissing = false } = {}) {
  const before = lstatRegularBoundary(filePath, label, { allowMissing });
  if (!before) return null;
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const handle = fs.openSync(filePath, flags);
  try {
    const after = verifyOpenedRegularBoundary(filePath, handle, before, label);
    return { stat: after, content: fs.readFileSync(handle, "utf8") };
  } finally {
    fs.closeSync(handle);
  }
}

function lstatRegularBoundary(filePath, label, { allowMissing = false } = {}) {
  let identity;
  try {
    identity = fs.lstatSync(filePath);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (identity.isSymbolicLink() || !identity.isFile()) {
    throw unsafeBoundaryError(filePath, label);
  }
  return identity;
}

function verifyOpenedRegularBoundary(filePath, handle, before, label) {
  const opened = fs.fstatSync(handle);
  const current = lstatRegularBoundary(filePath, label, { allowMissing: false });
  if (!opened.isFile()
    || (before && !sameFileIdentity(opened, before))
    || !sameFileIdentity(opened, current)) {
    throw unsafeBoundaryError(filePath, `${label} changed during open`);
  }
  return opened;
}

function unsafeBoundaryError(filePath, label) {
  const error = new Error(`unsafe ${label} boundary: ${filePath}`);
  error.code = "EVENT_SUBSTRATE_UNSAFE_PATH";
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  appendEventOnClient,
  createEventSubstrateStore,
  EventStreamVersionConflictError,
  normalizeEvent,
  normalizeEventType,
  withTransaction,
  // Internal stream-lock primitives, exported for direct race-condition tests
  // of the reaper-guarded stale reclaim. Application code goes through
  // store.withStreamLock instead.
  acquireJsonStreamDirLock,
  releaseJsonStreamDirLock,
  eventSubstrateTestInternals: Object.freeze({
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
  }),
};
