"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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
    dataDir, maxActive: 1, minSpanMs: 1,
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
  assert.equal(finals[0].transcriptSequence, 3);
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
  const state = JSON.parse(fs.readFileSync(path.join(stateDir(dataDir, "session"), "turn.json")));
  assert.equal(state.spans[0].paid_attempts, 1);
  assert.equal(state.spans[0].status, "failed");
});

test("restart recovery processes only bounded durable pending spans", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-restart-"));
  const dir = stateDir(dataDir, "session");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "turn.span.pcm"), Buffer.alloc(32, 7));
  fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify({
    version: 1, session_id: "session", branch_id: "default", turn_id: "turn",
    received_bytes: 32, sealed_bytes: 32, corrected_text: "", revision: 0, terminal: true,
    owner_id: "legacy_owner", privacy_scope: "retained", format: { sample_rate: 16000, channels: 1 },
    spans: [{ id: "span", start_audio_byte: 0, end_audio_byte: 32, status: "pending", terminal: true,
      language_codes: ["en-US"], audio_sha256: digest(Buffer.alloc(32, 7)) }],
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
  await eventually(() => fs.existsSync(path.join(stateDir(dataDir, "session"), "private.json")));
  runtime.deleteTurn({ sessionId: "session", branchId: "default", turnId: "private" });
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(finals.length, 0);
  assert.equal(fs.existsSync(path.join(stateDir(dataDir, "session"), "private.json")), false);
});

test("owner and branch identity isolate state and exact deletion", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-identity-"));
  const runtime = createRollingTranscriptReconcileRuntime({ dataDir });
  const left = runtime.createTurn({ ownerId: "owner", sessionId: "session", branchId: "left", turnId: "same",
    provider: { async transcribePcmWindowed() { return { text: "left" }; } } });
  const right = runtime.createTurn({ ownerId: "owner", sessionId: "session", branchId: "right", turnId: "same",
    provider: { async transcribePcmWindowed() { return { text: "right" }; } } });
  left.push(Buffer.alloc(32, 1)); right.push(Buffer.alloc(32, 2));
  left.finish(); right.finish();
  await eventually(() => fs.existsSync(path.join(stateDir(dataDir, "session", "left", "owner"), "same.json"))
    && fs.existsSync(path.join(stateDir(dataDir, "session", "right", "owner"), "same.json")));
  runtime.deleteTurn({ ownerId: "owner", sessionId: "session", branchId: "left", turnId: "same" });
  assert.equal(fs.existsSync(path.join(stateDir(dataDir, "session", "left", "owner"), "same.json")), false);
  assert.equal(fs.existsSync(path.join(stateDir(dataDir, "session", "right", "owner"), "same.json")), true);
});

test("an empty span leaves revision zero authoritative", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-empty-"));
  const finals = [];
  const runtime = createRollingTranscriptReconcileRuntime({ dataDir,
    onFinalRevision: async (value) => { finals.push(value); return true; } });
  const turn = runtime.createTurn({ sessionId: "session", branchId: "default", turnId: "empty",
    provider: { async transcribePcmWindowed() { return { text: "" }; } } });
  turn.push(Buffer.alloc(32)); turn.finish();
  runtime.notifyCanonicalCommitted({ sessionId: "session", branchId: "default", turnId: "empty" });
  await eventually(() => readState(stateDir(dataDir, "session"), "empty").spans[0].status === "empty");
  assert.equal(finals.length, 0);
  assert.equal(readState(stateDir(dataDir, "session"), "empty").finalized_at, "");
});

test("global outstanding bound skips excess final work without future paid backlog", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-global-bound-"));
  const secondPcm = path.join(dataDir, "second.pcm");
  fs.writeFileSync(secondPcm, Buffer.alloc(32, 2));
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const provider = { async transcribePcmWindowed(value) {
    calls.push(fs.readFileSync(value.pcmPath));
    if (calls.length === 1) await hold;
    return { text: `result ${calls.length}` };
  } };
  const runtime = createRollingTranscriptReconcileRuntime({ dataDir, maxActive: 1, maxReady: 1 });
  const first = runtime.createTurn({ sessionId: "session", branchId: "default", turnId: "first", provider });
  first.push(Buffer.alloc(32, 1)); first.finish();
  await eventually(() => calls.length === 1);
  const second = runtime.createTurn({ sessionId: "session", branchId: "default", turnId: "second", provider });
  second.push(Buffer.alloc(32, 2)); second.finish({ pcmPath: secondPcm });
  assert.equal(runtime.status().outstanding, 1);
  assert.equal(readState(stateDir(dataDir, "session"), "second").reconcile_stopped, "backpressure");
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 1);
  assert.ok(runtime.status().outstanding <= 1);
});

test("revoked retained-audio authority suppresses queued provider work", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-revoke-"));
  let authorized = true, release;
  const hold = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const runtime = createRollingTranscriptReconcileRuntime({ dataDir, maxActive: 1, minSpanMs: 1,
    authorizeJob: () => authorized });
  const turn = runtime.createTurn({ sessionId: "session", branchId: "default", turnId: "turn",
    provider: { async transcribePcmWindowed(value) {
      calls.push(value.audioBytes); if (calls.length === 1) await hold; return { text: "text" };
    } } });
  turn.push(Buffer.alloc(32)); assert.equal(turn.seal({ absolute_audio_byte_offset: 32 }), true);
  turn.push(Buffer.alloc(32)); turn.finish();
  await eventually(() => calls.length === 1);
  authorized = false; release();
  await eventually(() => readState(stateDir(dataDir, "session"), "turn").reconcile_stopped === "privacy_revoked");
  assert.equal(calls.length, 1);
});

test("digest mismatch fails closed before a paid provider call", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-integrity-"));
  const dir = stateDir(dataDir, "session");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "turn.span.pcm"), Buffer.alloc(32, 8));
  fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify({
    version: 1, owner_id: "legacy_owner", privacy_scope: "retained",
    session_id: "session", branch_id: "default", turn_id: "turn",
    received_bytes: 32, sealed_bytes: 32, terminal: true, format: { sample_rate: 16000, channels: 1 },
    spans: [{ id: "span", start_audio_byte: 0, end_audio_byte: 32, status: "pending", terminal: true,
      audio_sha256: digest(Buffer.alloc(32, 7)) }],
  }));
  let calls = 0;
  createRollingTranscriptReconcileRuntime({ dataDir, providerForJob: () => ({
    async transcribePcmWindowed() { calls += 1; return { text: "must not run" }; },
  }) });
  await eventually(() => readState(dir, "turn").spans[0].status === "invalid_audio");
  assert.equal(calls, 0);
});

test("per-owner concurrency leaves capacity for another owner", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-owner-limit-"));
  const started = [];
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const provider = { async transcribePcmWindowed(value) {
    started.push(value.turnId);
    await hold;
    return { text: value.turnId };
  } };
  const runtime = createRollingTranscriptReconcileRuntime({ dataDir, maxActive: 2, maxActivePerOwner: 1 });
  for (const [ownerId, turnId] of [["owner_a", "a1"], ["owner_a", "a2"], ["owner_b", "b1"]]) {
    const turn = runtime.createTurn({ ownerId, sessionId: "session", branchId: "default", turnId, provider });
    turn.push(Buffer.alloc(32)); turn.finish();
  }
  await eventually(() => started.length === 2);
  assert.deepEqual(new Set(started), new Set(["a1", "b1"]));
  assert.equal(runtime.status().active, 2);
  release();
  await eventually(() => started.length === 3);
});

test("restart retires an ambiguous paid claim without another provider call", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-ambiguous-"));
  const dir = stateDir(dataDir, "session");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "turn.span.pcm"), Buffer.alloc(32));
  fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify({
    version: 1, session_id: "session", branch_id: "default", turn_id: "turn",
    received_bytes: 32, sealed_bytes: 32, terminal: true,
    owner_id: "legacy_owner", privacy_scope: "retained", format: { sample_rate: 16000, channels: 1 },
    spans: [{ id: "span", start_audio_byte: 0, end_audio_byte: 32, status: "claimed", paid_attempts: 1,
      audio_sha256: digest(Buffer.alloc(32)) }],
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

test("restart recovery enforces the configured global paid backlog", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-rolling-recovery-bound-"));
  const dir = stateDir(dataDir, "session");
  fs.mkdirSync(dir, { recursive: true });
  for (const turnId of ["one", "two"]) {
    const bytes = Buffer.alloc(32, turnId === "one" ? 1 : 2);
    fs.writeFileSync(path.join(dir, `${turnId}.span.pcm`), bytes);
    fs.writeFileSync(path.join(dir, `${turnId}.json`), JSON.stringify({
      version: 1, owner_id: "legacy_owner", privacy_scope: "retained",
      session_id: "session", branch_id: "default", turn_id: turnId,
      received_bytes: 32, sealed_bytes: 32, terminal: true, format: { sample_rate: 16000, channels: 1 },
      spans: [{ id: "span", start_audio_byte: 0, end_audio_byte: 32, status: "pending",
        terminal: true, audio_sha256: digest(bytes) }],
    }));
  }
  let calls = 0, release;
  const hold = new Promise((resolve) => { release = resolve; });
  createRollingTranscriptReconcileRuntime({ dataDir, maxReady: 1, providerForJob: () => ({
    async transcribePcmWindowed() { calls += 1; await hold; return { text: "one" }; },
  }) });
  await eventually(() => calls === 1);
  const states = [readState(dir, "one"), readState(dir, "two")];
  assert.equal(states.filter((state) => state.reconcile_stopped === "recovery_backpressure").length, 1);
  release();
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
function stateDir(dataDir, sessionId, branchId = "default", ownerId = "legacy_owner") {
  return path.join(dataDir, "voice-transcript-reconcile", ownerId, sessionId, branchId);
}
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
