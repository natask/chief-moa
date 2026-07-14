"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createEventSubstrateStore } = require("../lib/event-substrate");
const { createSemanticTelemetryStore, opaqueLifecycleId } = require("../lib/semantic-telemetry-store");

const release = { version: "0.1.0", build_id: "build_11111111-1111-4111-8111-111111111111" };

test("validated telemetry persists and bounded query returns safe aggregates", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(t.mock?.tmpdir?.() || require("node:os").tmpdir(), "moa-telemetry-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const events = createEventSubstrateStore({ dataDir });
  const store = createSemanticTelemetryStore({ events, release });
  assert.equal(store.emit({ name: "preview.claimed", correlation: { lifecycle_id: opaqueLifecycleId("req_private") }, attributes: { environment: "preview", operation: "preview_claim", outcome: "ok" } }), true);
  await waitFor(() => store.stats().queued === 0);
  const result = await store.query({ limit: 500 });
  assert.equal(result.events.length, 1);
  assert.equal(result.aggregate.counts["preview.claimed:ok"], 1);
  assert.match(result.events[0].correlation.lifecycle_id, /^lifecycle_[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(result).includes("req_private"), false);
});

test("invalid emit drops, malformed persistence is quarantined, and filters are bounded", async () => {
  const rows = [];
  const events = {
    appendEvent: async (event) => { rows.push(event); return event; },
    listEvents: async (filter) => { assert.equal(filter.limit, 100); assert.equal(filter.stream_id, "telemetry:semantic"); return rows; },
  };
  const store = createSemanticTelemetryStore({ events, release, exporterOptions: { maxQueueSize: 1 } });
  assert.equal(store.emit({ name: "preview.failed", attributes: { prompt: "do not persist" } }), false);
  const poisonedPayload = {
    schema: "moa.semantic_telemetry", schema_version: 1,
    event_id: "tel_22222222-2222-4222-8222-222222222222", occurred_at: new Date().toISOString(),
    name: "preview.failed", surface: "gateway", release, correlation: {},
    attributes: { environment: "preview", operation: "preview_failure", outcome: "error" },
  };
  rows.push(
    { event_type: "telemetry.semantic.v1", stream_id: "telemetry:semantic", event_id: poisonedPayload.event_id, idempotency_key: poisonedPayload.event_id, actor: { kind: "user", id: "forger" }, occurred_at: poisonedPayload.occurred_at, payload: poisonedPayload },
    { event_type: "telemetry.semantic.v1", stream_id: "attacker", event_id: poisonedPayload.event_id, idempotency_key: poisonedPayload.event_id, actor: { kind: "gateway", id: "semantic-telemetry" }, occurred_at: poisonedPayload.occurred_at, payload: poisonedPayload },
    { event_type: "telemetry.semantic.v1", stream_id: "telemetry:semantic", event_id: "evt_mismatch", idempotency_key: "evt_mismatch", actor: { kind: "gateway", id: "semantic-telemetry" }, occurred_at: poisonedPayload.occurred_at, payload: poisonedPayload },
  );
  assert.deepEqual(await store.query({ limit: 999 }), { events: [], aggregate: { returned: 0, counts: {} } });
  await assert.rejects(() => store.query({ name: "../../secret" }), /invalid telemetry name/);
});

test("exporter storage failure never escapes emit", async () => {
  const store = createSemanticTelemetryStore({
    events: { appendEvent: async () => { throw new Error("storage down"); }, listEvents: async () => [] },
    release,
  });
  assert.doesNotThrow(() => store.emit({ name: "preview.available", attributes: { environment: "preview", operation: "preview_available", outcome: "ok" } }));
  await waitFor(() => store.stats().export_failures === 1);
});

test("missing lifecycle identity is rejected instead of sharing a sentinel", () => {
  assert.throws(() => opaqueLifecycleId(""), /bound identity/);
  assert.throws(() => opaqueLifecycleId(null), /bound identity/);
});

test("console exposes responsive read-only preview telemetry panel", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/console.html"), "utf8");
  assert.match(html, /Work \/ Previews/);
  assert.match(html, /work-history\/telemetry\?limit=8/);
  assert.match(html, /@media \(max-width: 720px\)/);
  const panel = html.slice(html.indexOf('class="previews"'), html.indexOf('class="thread"'));
  assert.doesNotMatch(panel, /apply|promot/i);
});

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for telemetry exporter");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
