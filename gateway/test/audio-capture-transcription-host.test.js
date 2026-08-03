"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createAudioCaptureTranscriptionHost } = require("../lib/audio-capture-transcription-host");

const START = Date.parse("2026-08-03T12:00:00.000Z");

function block(id, processingState = "queued", leaseExpiresAt = null) {
  return {
    id,
    schema_version: 2,
    source: { kind: "audio_note" },
    processing_state: processingState,
    processing_claim: leaseExpiresAt ? { lease_expires_at: leaseExpiresAt } : null,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushJobs() {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(overrides = {}) {
  let now = START;
  const items = overrides.items || [];
  const listCalls = [];
  const processCalls = [];
  const timers = [];
  const captureBlocks = {
    async list(input) {
      listCalls.push(input);
      return { items };
    },
  };
  const host = createAudioCaptureTranscriptionHost({
    captureBlocks,
    processBlock: async (id) => {
      processCalls.push(id);
      return overrides.processBlock ? overrides.processBlock(id) : block(id, "transcribed");
    },
    enabled: true,
    workerId: "host_test",
    pollIntervalMs: 100,
    backoffMs: 100,
    shutdownTimeoutMs: 100,
    clock: () => new Date(now),
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    logger: { error() {}, warn() {} },
    ...overrides.options,
  });
  return {
    host,
    listCalls,
    processCalls,
    timers,
    advance(ms) { now += ms; },
  };
}

test("disabled hosts neither discover nor process capture blocks", async () => {
  let listCalls = 0;
  let processCalls = 0;
  const host = createAudioCaptureTranscriptionHost({
    captureBlocks: { async list() { listCalls += 1; return { items: [block("queued_1")] }; } },
    async processBlock() { processCalls += 1; },
    enabled: false,
    workerId: "disabled_test",
  });

  assert.equal(host.start().running, false);
  assert.equal((await host.poll()).enabled, false);
  await flushJobs();
  assert.equal(listCalls, 0);
  assert.equal(processCalls, 0);
});

test("poll discovers queued work up to concurrency and reports queue and active leases separately", async () => {
  const jobs = new Map();
  const state = harness({
    items: [
      block("queued_1"),
      block("queued_2"),
      block("queued_3"),
      block("leased_1", "transcribing", new Date(START + 60_000).toISOString()),
    ],
    processBlock(id) {
      const job = deferred();
      jobs.set(id, job);
      return job.promise;
    },
    options: { concurrency: 2 },
  });

  await state.host.poll();
  await flushJobs();

  assert.deepEqual(state.listCalls, [{ limit: 50, offset: 0 }]);
  assert.deepEqual(state.processCalls, ["queued_1", "queued_2"]);
  assert.deepEqual(state.host.status(), {
    enabled: true,
    running: false,
    stopping: false,
    worker_id: "host_test",
    poll_interval_ms: 100,
    concurrency: 2,
    scan_limit: 50,
    backoff_ms: 100,
    in_flight: 2,
    queued_observed: 3,
    actively_leased_observed: 1,
    expired_leases_observed: 0,
    eligible_observed: 3,
    scanned_observed: 4,
    next_scan_offset: 0,
    processed_total: 0,
    transcribed_total: 0,
    failed_total: 0,
    last_poll_at: "2026-08-03T12:00:00.000Z",
    last_error: null,
    shutdown_timed_out: false,
  });

  for (const job of jobs.values()) job.resolve(block("done", "transcribed"));
  await flushJobs();
});

test("poll advances through completed pages so queued blocks cannot starve", async () => {
  const pages = [
    { items: [block("done_1", "transcribed"), block("done_2", "transcribed")], has_more: true },
    { items: [block("queued_1")], has_more: false },
  ];
  const offsets = [];
  const state = harness({
    options: {
      scanLimit: 2,
      captureBlocks: {
        async list({ offset }) {
          offsets.push(offset);
          return pages[offset === 0 ? 0 : 1];
        },
      },
    },
  });

  await state.host.poll();
  await flushJobs();
  assert.deepEqual(state.processCalls, []);
  assert.equal(state.host.status().next_scan_offset, 2);

  await state.host.poll();
  await flushJobs();
  assert.deepEqual(offsets, [0, 2]);
  assert.deepEqual(state.processCalls, ["queued_1"]);
  assert.equal(state.host.status().next_scan_offset, 0);
});

test("a duplicate poll does not launch an in-flight block twice", async () => {
  const job = deferred();
  const state = harness({
    items: [block("queued_1")],
    processBlock: () => job.promise,
  });

  await state.host.poll();
  await flushJobs();
  await state.host.poll();
  await flushJobs();

  assert.deepEqual(state.processCalls, ["queued_1"]);
  assert.equal(state.host.status().in_flight, 1);
  job.resolve(block("queued_1", "transcribed"));
  await flushJobs();
});

test("a rejected job is deferred until its deterministic backoff expires", async () => {
  let attempts = 0;
  const state = harness({
    items: [block("queued_1")],
    processBlock() {
      attempts += 1;
      if (attempts === 1) throw new Error("provider unavailable");
      return block("queued_1", "transcribed");
    },
  });

  await state.host.poll();
  await flushJobs();
  assert.deepEqual(state.processCalls, ["queued_1"]);
  assert.equal(state.host.status().last_error, "provider unavailable");

  await state.host.poll();
  await flushJobs();
  assert.deepEqual(state.processCalls, ["queued_1"]);

  state.advance(99);
  await state.host.poll();
  await flushJobs();
  assert.deepEqual(state.processCalls, ["queued_1"]);

  state.advance(1);
  await state.host.poll();
  await flushJobs();
  assert.deepEqual(state.processCalls, ["queued_1", "queued_1"]);
  assert.equal(state.host.status().transcribed_total, 1);
});

test("expired transcription leases are eligible while active leases are only observed", async () => {
  const state = harness({
    items: [
      block("expired_1", "transcribing", new Date(START).toISOString()),
      block("active_1", "transcribing", new Date(START + 1).toISOString()),
      block("queued_1"),
      { ...block("wrong_schema", "queued"), schema_version: 1 },
      { ...block("wrong_source", "queued"), source: { kind: "video_note" } },
    ],
    options: { concurrency: 3 },
  });

  await state.host.poll();
  await flushJobs();

  assert.deepEqual(state.processCalls, ["expired_1", "queued_1"]);
  assert.equal(state.host.status().queued_observed, 1);
  assert.equal(state.host.status().actively_leased_observed, 2);
  assert.equal(state.host.status().expired_leases_observed, 1);
  assert.equal(state.host.status().eligible_observed, 2);
  assert.equal(state.host.status().scanned_observed, 5);
});

test("start schedules bounded polling and stop reports a bounded shutdown timeout", async () => {
  const never = deferred();
  const state = harness({
    items: [block("queued_1")],
    processBlock: () => never.promise,
  });

  assert.equal(state.host.start().running, true);
  await flushJobs();
  assert.equal(state.host.status().in_flight, 1);
  assert.equal(state.timers.filter((timer) => !timer.cleared).length, 1);
  assert.equal(state.timers.find((timer) => !timer.cleared).delay, 100);

  const stopping = state.host.stop();
  const activeTimers = state.timers.filter((timer) => !timer.cleared);
  assert.equal(activeTimers.length, 1);
  assert.equal(activeTimers[0].delay, 100);
  activeTimers[0].callback();
  const status = await stopping;

  assert.equal(status.running, false);
  assert.equal(status.stopping, true);
  assert.equal(status.in_flight, 1);
  assert.equal(status.shutdown_timed_out, true);
});
