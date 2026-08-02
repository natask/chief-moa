"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRollingTranscriptReconcileRuntime } = require("../lib/rolling-transcript-reconcile");

test("batches immutable natural spans in order and activates only after canonical commit", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-reconcile-"));
  const calls = [];
  const prefixes = [];
  const finals = [];
  const provider = {
    async transcribePcmWindowed(turn) {
      const bytes = fs.readFileSync(turn.pcmPath);
      calls.push(bytes);
      return { text: bytes[0] === 1 ? "first corrected" : "second corrected" };
    },
  };
  const runtime = createRollingTranscriptReconcileRuntime({
    dataDir, maxActive: 1,
    onFinalRevision: async (value) => finals.push(value),
  });
  const turn = runtime.createTurn({
    sessionId: "session", branchId: "default", turnId: "turn", provider,
    languageCodes: ["en-US", "am-ET"], emitPrefix: async (value) => prefixes.push(value),
  });
  turn.push(Buffer.alloc(320, 1));
  assert.equal(turn.seal({ absolute_audio_byte_offset: 320 }), true);
  turn.push(Buffer.alloc(160, 2));
  turn.finish();
  await eventually(() => calls.length === 2 && prefixes.length === 2);
  assert.deepEqual(calls.map((value) => value.length), [320, 160]);
  assert.deepEqual(prefixes.map((value) => value.sealedThroughAudioByte), [320, 480]);
  assert.equal(prefixes[1].finalizedText, "first corrected second corrected");
  assert.equal(finals.length, 0, "background work cannot race ahead of canonical persistence");
  runtime.notifyCanonicalCommitted({ sessionId: "session", branchId: "default", turnId: "turn" });
  await eventually(() => finals.length === 1);
  assert.equal(finals[0].transcript, "first corrected second corrected");
});

test("a durable claimed span is never charged twice after an ambiguous failure", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-claim-"));
  let calls = 0;
  const runtime = createRollingTranscriptReconcileRuntime({ dataDir, maxActive: 1 });
  const turn = runtime.createTurn({
    sessionId: "session", branchId: "default", turnId: "turn",
    provider: { async transcribePcmWindowed() { calls += 1; throw new Error("ambiguous transport failure"); } },
  });
  turn.push(Buffer.alloc(64, 1));
  turn.finish();
  await eventually(() => calls === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, "voice-transcript-reconcile", "session", "turn.json")));
  assert.equal(state.spans[0].paid_attempts, 1);
  assert.equal(state.spans[0].status, "failed");
});

test("restart recovery processes only bounded durable pending spans", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-restart-"));
  const dir = path.join(dataDir, "voice-transcript-reconcile", "session");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "turn.span.pcm"), Buffer.alloc(32, 7));
  fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify({
    version: 1, session_id: "session", branch_id: "default", turn_id: "turn",
    received_bytes: 32, sealed_bytes: 32, corrected_text: "", revision: 0, terminal: true,
    spans: [{ id: "span", start_audio_byte: 0, end_audio_byte: 32, status: "pending", terminal: true,
      language_codes: ["en-US"] }],
  }));
  let calls = 0;
  const finals = [];
  createRollingTranscriptReconcileRuntime({
    dataDir,
    providerForJob: () => ({ async transcribePcmWindowed() { calls += 1; return { text: "recovered text" }; } }),
    canonicalReadyForJob: () => true,
    onFinalRevision: async (value) => { finals.push(value); return true; },
  });
  await eventually(() => finals.length === 1);
  assert.equal(calls, 1);
  assert.equal(finals[0].transcript, "recovered text");
});

test("bounded-memory backpressure flushes the exact final tail from the closed PCM file", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-tail-"));
  const pcmPath = path.join(dataDir, "turn.pcm");
  fs.writeFileSync(pcmPath, Buffer.alloc(64, 9));
  let seenBytes = 0;
  const finals = [];
  const runtime = createRollingTranscriptReconcileRuntime({
    dataDir, maxBufferBytes: 16,
    onFinalRevision: async (value) => { finals.push(value); return true; },
  });
  const turn = runtime.createTurn({
    sessionId: "session", branchId: "default", turnId: "tail",
    provider: { async transcribePcmWindowed(value) { seenBytes = fs.statSync(value.pcmPath).size; return { text: "whole tail" }; } },
  });
  turn.push(Buffer.alloc(32, 9));
  turn.push(Buffer.alloc(32, 9));
  turn.finish({ pcmPath });
  runtime.notifyCanonicalCommitted({ sessionId: "session", branchId: "default", turnId: "tail" });
  await eventually(() => finals.length === 1);
  assert.equal(seenBytes, 64);
});

test("privacy deletion removes reconciliation state and suppresses late provider output", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-delete-"));
  let release;
  const providerDone = new Promise((resolve) => { release = resolve; });
  const finals = [];
  const runtime = createRollingTranscriptReconcileRuntime({
    dataDir, onFinalRevision: async (value) => finals.push(value),
  });
  const turn = runtime.createTurn({
    sessionId: "session", branchId: "default", turnId: "private",
    provider: { async transcribePcmWindowed() { await providerDone; return { text: "must disappear" }; } },
  });
  turn.push(Buffer.alloc(32, 1));
  turn.finish();
  await eventually(() => fs.existsSync(path.join(dataDir, "voice-transcript-reconcile", "session", "private.json")));
  runtime.deleteTurn({ sessionId: "session", branchId: "incognito_x", turnId: "private" });
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(finals.length, 0);
  assert.equal(fs.existsSync(path.join(dataDir, "voice-transcript-reconcile", "session", "private.json")), false);
});

test("restart retires an ambiguous paid claim without another provider call", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-ambiguous-"));
  const dir = path.join(dataDir, "voice-transcript-reconcile", "session");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "turn.span.pcm"), Buffer.alloc(32));
  fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify({
    version: 1, session_id: "session", branch_id: "default", turn_id: "turn",
    received_bytes: 32, sealed_bytes: 32, terminal: true,
    spans: [{ id: "span", start_audio_byte: 0, end_audio_byte: 32, status: "claimed", paid_attempts: 1 }],
  }));
  let calls = 0;
  createRollingTranscriptReconcileRuntime({ dataDir, providerForJob: () => ({
    async transcribePcmWindowed() { calls += 1; return { text: "duplicate" }; },
  }) });
  await eventually(() => readState(dir, "turn").spans[0].status === "abandoned_ambiguous"
    && !fs.existsSync(path.join(dir, "turn.span.pcm")));
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(dir, "turn.span.pcm")), false);
});

async function eventually(predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true");
}

function readState(dir, turnId) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${turnId}.json`)));
}
