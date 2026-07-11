"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAsyncTelemetryExporter,
  createSemanticEnvelope,
  metricDimensions,
} = require("../lib/semantic-telemetry");

const release = { version: "0.1.0", build_id: "git-abc123" };

test("semantic envelope correlates releases without putting IDs in metric dimensions", () => {
  const event = createSemanticEnvelope({
    name: "canary.received",
    surface: "gateway",
    release,
    correlation: { trace_id: "trace-1", canary_id: "canary-1" },
    attributes: { environment: "preview", outcome: "ok", transport: "https" },
  }, { now: new Date("2026-07-10T00:00:00.000Z") });
  assert.equal(event.schema_version, 1);
  assert.deepEqual(metricDimensions(event), {
    surface: "gateway",
    environment: "preview",
    outcome: "ok",
    transport: "https",
  });
  assert.equal(JSON.stringify(metricDimensions(event)).includes("trace-1"), false);
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

test("attribute cardinality and shape are bounded before traversal", () => {
  const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`key_${index}`, "x"]));
  assert.throws(() => createSemanticEnvelope({ name: "request.completed", surface: "gateway", release, attributes: tooMany }), /too many/);
  assert.throws(() => createSemanticEnvelope({ name: "request.completed", surface: "gateway", release, attributes: { operation: { nested: true } } }), /invalid telemetry attribute/);
  assert.throws(() => createSemanticEnvelope({ name: "request.completed", surface: "gateway", release, attributes: { operation: "path-/users/1234" } }), /unsupported telemetry attribute value/);
  assert.throws(() => createSemanticEnvelope({ name: "made.up", surface: "gateway", release }), /unsupported event name/);
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
  assert.deepEqual(exporter.stats(), { accepted: 2, dropped: 1, export_failures: 0, queued: 2, exporting: false });
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

test("a hung exporter times out and later bounded batches continue", async () => {
  let calls = 0;
  const exporter = createAsyncTelemetryExporter({
    maxBatchSize: 1,
    exportTimeoutMs: 5,
    exportBatch: async () => {
      calls += 1;
      if (calls === 1) await new Promise(() => {});
    },
  });
  const input = { name: "canary.started", surface: "gateway", release, attributes: { environment: "test" } };
  assert.equal(exporter.emit(input), true);
  assert.equal(exporter.emit(input), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 2);
  assert.equal(exporter.stats().export_failures, 1);
  assert.equal(exporter.stats().queued, 0);
});
