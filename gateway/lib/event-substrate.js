"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EVENTS_FILENAME = "product-events.jsonl";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

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
  fs.mkdirSync(dataDir, { recursive: true });

  async function appendEvent(input = {}) {
    const current = readJsonLines(eventsPath);
    const existing = findExistingEvent(current, input);
    if (existing) return clone(existing);

    const event = normalizeEvent(input, { originId, streamVersion: 1 });
    if (!positiveInteger(input.stream_version || input.streamVersion, 0)) {
      event.stream_version = nextJsonStreamVersion(current, event, event.origin_id);
    }
    appendJsonLine(eventsPath, event);
    return clone(event);
  }

  async function listEvents(filter = {}) {
    const events = readJsonLines(eventsPath)
      .filter((event) => matchesFilter(event, filter))
      .sort(compareEventsDesc)
      .slice(0, clampLimit(filter.limit))
      .map(clone);
    return filter.order === "asc" ? events.reverse() : events;
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

  return { appendEvent, listEvents, getEvent, storageInfo };
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
      const base = normalizeEvent(input, { originId, streamVersion: 0 });
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${base.origin_id}:${base.stream_id}`]);

      const secondExisting = await findExistingPostgresEvent({ eventId: base.event_id, idempotencyKey: base.idempotency_key }, client);
      if (secondExisting) return secondExisting;

      const version = positiveInteger(input.stream_version || input.streamVersion, 0)
        || await nextPostgresStreamVersion(client, base.origin_id, base.stream_id);
      const event = { ...base, stream_version: version };
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
    params.push(limit);
    const order = filter.order === "asc" ? "asc" : "desc";
    const result = await pool.query(
      `select * from product_events${where.length ? ` where ${where.join(" and ")}` : ""}
       order by recorded_at ${order}, stream_version ${order}
       limit $${params.length}`,
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

  return { appendEvent, listEvents, getEvent, storageInfo };
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

async function nextPostgresStreamVersion(client, originId, streamId) {
  const result = await client.query(
    "select coalesce(max(stream_version), 0) + 1 as next_version from product_events where origin_id = $1 and stream_id = $2",
    [originId, streamId],
  );
  return Number(result.rows[0]?.next_version || 1);
}

function nextJsonStreamVersion(events, input, originId) {
  const streamId = normalizeOptionalText(input.stream_id || input.streamId, 240) || streamIdForEvent(input);
  return events
    .filter((event) => event.origin_id === originId && event.stream_id === streamId)
    .reduce((max, event) => Math.max(max, Number(event.stream_version || 0)), 0) + 1;
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
    || Number(b.stream_version || 0) - Number(a.stream_version || 0);
}

function clampLimit(limit) {
  const value = Number(limit || DEFAULT_LIMIT);
  return Math.max(1, Math.min(Number.isFinite(value) ? value : DEFAULT_LIMIT, MAX_LIMIT));
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
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
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
  } catch {
    return [];
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  createEventSubstrateStore,
  normalizeEvent,
};
