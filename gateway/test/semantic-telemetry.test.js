"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAsyncTelemetryExporter,
  createSemanticEnvelope,
  generateOpaqueId,
  metricDimensions,
} = require("../lib/semantic-telemetry");

const release = {
  version: "0.1.0",
  build_id: "build_11111111-1111-4111-8111-111111111111",
};
const traceId = "trace_22222222-2222-4222-8222-222222222222";
const canaryId = "canary_33333333-3333-4333-8333-333333333333";
const parentEventId = "tel_44444444-4444-4444-8444-444444444444";

test("semantic envelope correlates releases without putting IDs in metric dimensions", () => {
  const event = createSemanticEnvelope({
    name: "canary.received",
    surface: "gateway",
    release,
    correlation: { trace_id: traceId, canary_id: canaryId, parent_event_id: parentEventId },
    attributes: { environment: "preview", outcome: "ok", transport: "https" },
  }, { now: new Date("2026-07-10T00:00:00.000Z") });
  assert.equal(event.schema_version, 1);
  assert.match(event.event_id, /^tel_[0-9a-f-]{36}$/);
  assert.deepEqual(metricDimensions(event), {
    surface: "gateway",
    environment: "preview",
    outcome: "ok",
    transport: "https",
  });
  assert.equal(JSON.stringify(metricDimensions(event)).includes(traceId), false);
});

test("release and correlation ids require explicit opaque formats", () => {
  for (const input of [
    { release: { version: "alice@example.com", build_id: release.build_id } },
    { release: { version: "0.1.0", build_id: "build_alice@example.com" } },
    { release: { version: "0.1.0", build_id: "build_session-123" } },
    { correlation: { trace_id: "trace_user-123" } },
    { correlation: { parent_event_id: "tel_tenant-123" } },
    { correlation: { canary_id: "canary_alice@example.com" } },
  ]) {
    assert.throws(() => createSemanticEnvelope({ name: "request.completed", surface: "gateway", release, ...input }));
  }
});

test("event and release ids generate opaque defaults when omitted", () => {
  const event = createSemanticEnvelope({
    name: "request.completed",
    surface: "gateway",
    release: { version: "0.1.0" },
  });
  assert.match(event.event_id, /^tel_[0-9a-f-]{36}$/);
  assert.match(event.release.build_id, /^build_[0-9a-f-]{36}$/);
});

test("content, identity and token-shaped attributes are rejected", () => {
  for (const attributes of [
    { transcript: "hello" },
    { user_id: "user-1" },
    { operation: "Bearer secret-value" },
    { operation: "sk-abcdefghijklmnopqrstuvwxyz" },
  ]) {
    assert.throws(() => createSemanticEnvelope({ name: "request.completed", surface: "gateway", release, attributes }));
  }
});

test("export is asynchronous, bounded and failure-isolated", async () => {
  let resolveExport;
  const exporter = createAsyncTelemetryExporter({
    maxQueueSize: 2,
    maxBatchSize: 1,
    exportBatch: () => new Promise((resolve, reject) => { resolveExport = () => reject(new Error("down")); }),
  });
  const input = { name: "canary.started", surface: "browser_extension", release, attributes: { environment: "preview" } };
  assert.equal(exporter.emit(input), true);
  assert.equal(exporter.emit(input), true);
  assert.equal(exporter.emit(input), false);
  assert.deepEqual(exporter.stats(), {
    accepted: 2,
    active_exports: 0,
    circuit_open: false,
    dropped: 1,
    export_failures: 0,
    exporting: false,
    queued: 2,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exporter.stats().exporting, true);
  resolveExport();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  resolveExport();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exporter.stats().export_failures, 2);
  assert.equal(exporter.stats().queued, 0);
});

test("invalid events drop locally instead of reaching the exporter", () => {
  let calls = 0;
  const exporter = createAsyncTelemetryExporter({ exportBatch: async () => { calls += 1; } });
  assert.equal(exporter.emit({ name: "request.completed", surface: "gateway", release, attributes: { prompt: "private" } }), false);
  assert.equal(calls, 0);
  assert.equal(exporter.stats().dropped, 1);
});

test("attribute cardinality and shape are bounded before traversal", () => {
  const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`key_${index}`, "x"]));
  assert.throws(() => createSemanticEnvelope({ name: "request.completed", surface: "gateway", release, attributes: tooMany }), /too many/);
  assert.throws(() => createSemanticEnvelope({ name: "request.completed", surface: "gateway", release, attributes: { operation: { nested: true } } }), /invalid telemetry attribute/);
  assert.throws(() => createSemanticEnvelope({ name: "request.completed", surface: "gateway", release, attributes: { operation: "path-/users/1234" } }), /unsupported telemetry attribute value/);
  assert.throws(() => createSemanticEnvelope({ name: "made.up", surface: "gateway", release }), /unsupported event name/);
});

test("five timed-out exports stay single-flight when the adapter cooperates with abort", async () => {
  let aborts = 0;
  let active = 0;
  let calls = 0;
  let maxActive = 0;
  const exporter = createAsyncTelemetryExporter({
    maxBatchSize: 1,
    exportTimeoutMs: 5,
    exportBatch: async (_batch, { signal }) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            aborts += 1;
            reject(signal.reason || new Error("aborted"));
          }, { once: true });
        });
      } finally {
        active -= 1;
      }
    },
  });
  const input = { name: "canary.started", surface: "gateway", release, attributes: { environment: "test" } };
  for (let index = 0; index < 5; index += 1) {
    assert.equal(exporter.emit(input), true);
  }
  await waitFor(() => exporter.stats().export_failures === 5 && exporter.stats().queued === 0 && exporter.stats().active_exports === 0, 200);
  assert.equal(calls, 5);
  assert.equal(aborts, 5);
  assert.equal(maxActive, 1);
});

test("a non-cooperative timed-out exporter is quarantined so unresolved work stays bounded", async () => {
  let active = 0;
  let calls = 0;
  let maxActive = 0;
  const exporter = createAsyncTelemetryExporter({
    maxBatchSize: 1,
    maxQueueSize: 3,
    exportTimeoutMs: 5,
    exportBatch: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(() => {});
    },
  });
  const input = {
    name: "canary.started",
    surface: "gateway",
    release: { version: "0.1.0", build_id: generateOpaqueId("build") },
    attributes: { environment: "test" },
  };
  assert.equal(exporter.emit(input), true);
  assert.equal(exporter.emit(input), true);
  assert.equal(exporter.emit(input), true);
  assert.equal(exporter.emit(input), false);
  assert.equal(exporter.emit(input), false);
  await waitFor(() => exporter.stats().circuit_open, 200);
  assert.equal(calls, 1);
  assert.equal(active, 1);
  assert.equal(maxActive, 1);
  assert.equal(exporter.stats().export_failures, 1);
  assert.equal(exporter.stats().queued, 2);
  assert.equal(exporter.stats().active_exports, 1);
  assert.equal(exporter.stats().circuit_open, true);
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for condition");
}
