"use strict";

const crypto = require("node:crypto");
const { ALLOWED_EVENT_NAMES, createAsyncTelemetryExporter, createSemanticEnvelope } = require("./semantic-telemetry");

const EVENT_TYPE = "telemetry.semantic.v1";
const MAX_QUERY_LIMIT = 100;

function createSemanticTelemetryStore({ events, release, surface = "gateway", exporterOptions = {} } = {}) {
  if (!events || typeof events.appendEvent !== "function" || typeof events.listEvents !== "function") {
    throw new Error("semantic telemetry store requires an event substrate");
  }
  const safeRelease = createSemanticEnvelope({ name: "request.completed", surface, release, attributes: { operation: "http_request", outcome: "ok" } }).release;
  const exporter = createAsyncTelemetryExporter({
    ...exporterOptions,
    exportBatch: async (batch) => {
      for (const envelope of batch) {
        await events.appendEvent({
          event_id: envelope.event_id,
          event_type: EVENT_TYPE,
          stream_id: "telemetry:semantic",
          occurred_at: envelope.occurred_at,
          actor: { kind: "gateway", id: "semantic-telemetry" },
          idempotency_key: envelope.event_id,
          payload: envelope,
        });
      }
    },
  });

  function emit(input = {}) {
    return exporter.emit({ ...input, surface: input.surface || surface, release: input.release || safeRelease });
  }

  async function query(input = {}) {
    const limit = boundedLimit(input.limit);
    const name = optionalAllowed(input.name, "name", ALLOWED_EVENT_NAMES);
    const outcome = optionalAllowed(input.outcome, "outcome", new Set(["ok", "error", "cancelled", "dropped", "timeout"]));
    const rows = await events.listEvents({ event_type: EVENT_TYPE, stream_id: "telemetry:semantic", limit: MAX_QUERY_LIMIT });
    const telemetry = [];
    for (const row of rows) {
      if (!canonicalTelemetryRow(row)) continue;
      let envelope;
      try { envelope = createSemanticEnvelope(row.payload, { now: new Date(row.occurred_at) }); } catch { continue; }
      if (name && envelope.name !== name) continue;
      if (outcome && envelope.attributes.outcome !== outcome) continue;
      telemetry.push(envelope);
      if (telemetry.length >= limit) break;
    }
    const counts = {};
    for (const envelope of telemetry) {
      const key = `${envelope.name}:${envelope.attributes.outcome || "none"}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    return { events: telemetry, aggregate: { returned: telemetry.length, counts } };
  }

  return { emit, query, stats: exporter.stats };
}

function opaqueLifecycleId(value) {
  const identity = String(value || "").trim();
  if (!identity) throw new TypeError("lifecycle correlation requires a bound identity");
  const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32).split("");
  digest[12] = "5";
  digest[16] = ["8", "9", "a", "b"][parseInt(digest[16], 16) % 4];
  const uuid = `${digest.slice(0, 8).join("")}-${digest.slice(8, 12).join("")}-${digest.slice(12, 16).join("")}-${digest.slice(16, 20).join("")}-${digest.slice(20).join("")}`;
  return `lifecycle_${uuid}`;
}

function canonicalTelemetryRow(row) {
  return row?.event_type === EVENT_TYPE
    && row.stream_id === "telemetry:semantic"
    && row.actor?.kind === "gateway"
    && row.actor?.id === "semantic-telemetry"
    && typeof row.event_id === "string"
    && row.event_id === row.payload?.event_id
    && row.idempotency_key === row.event_id;
}

function boundedLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_QUERY_LIMIT) : 25;
}

function optionalAllowed(value, label, allowed) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text.length > 80 || !allowed.has(text)) throw new TypeError(`invalid telemetry ${label}`);
  return text;
}

module.exports = { EVENT_TYPE, MAX_QUERY_LIMIT, createSemanticTelemetryStore, opaqueLifecycleId };
