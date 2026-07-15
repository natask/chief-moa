#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const voiceDrafts = require("../lib/voice-drafts");

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-drafts-smoke-"));
  try {
    await step("module exports the synchronous draft-store seam", assertModuleContract);
    await step("capturing persists canonical PCM and restart recovery parks only orphaned capture", () => {
      assertRestartRecovery(tempDir);
    });
    await step("send-ready drafts assemble one canonical audio file and consume safely", () => {
      assertSendReadySeam(tempDir);
    });
    await step("discard leaves a content-free tombstone and deletes content on restart-safe markers", () => {
      assertDiscard(tempDir);
    });
    await step("compaction preserves expired replay authority and audio streams verify immutable snapshots", () => {
      assertExpiredReplayAndAudioSnapshot(tempDir);
    });
    console.log("smoke-voice-drafts: ok");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

function assertModuleContract() {
  assert.equal(typeof voiceDrafts.createVoiceDraftStore, "function");
  assert.equal(typeof voiceDrafts.STATE_MACHINE_REVISION, "string");
  assert.ok(voiceDrafts.LEGAL_TRANSITIONS.capturing.has("send_ready"));
}

function assertRestartRecovery(tempDir) {
  const dataDir = path.join(tempDir, "restart");
  let store = voiceDrafts.createVoiceDraftStore({ dataDir });
  const draft = store.create({
    idempotency_key: "create-r",
    source: "android",
    surface: "overlay",
    session_id: "session-r",
    branch_id: "branch-r",
    parent_intent_id: "intent-r",
    release_id: "release-r",
    release_version: "1.0.0",
  });
  store.appendSegment(draft.id, {
    segment_id: "seg-r1",
    bytes: pcm(1, 2),
    duration_ms: 100,
    partial_transcript: "hello",
    expected_revision: draft.revision,
  });
  fs.rmSync(path.join(dataDir, "voice-drafts", "capture.lock"), { force: true });

  store = voiceDrafts.createVoiceDraftStore({ dataDir });
  const recovered = store.get(draft.id);
  assert.equal(recovered.state, "parked");
  assert.equal(recovered.recovery_receipt.reason, "boot_recovery_auto_park");
  assert.equal(store.status().active_capture_draft_id, "");

  store.transition(draft.id, {
    action: "resume",
    idempotency_key: "resume-r",
    expected_revision: recovered.revision,
  });
  store.appendSegment(draft.id, {
    segment_id: "seg-r2",
    bytes: pcm(3, 4),
    duration_ms: 100,
    expected_revision: store.get(draft.id).revision,
  });
  assert.equal(store.segments(draft.id).length, 2);
}

function assertSendReadySeam(tempDir) {
  const dataDir = path.join(tempDir, "send");
  const store = voiceDrafts.createVoiceDraftStore({ dataDir });
  const draft = store.create({
    idempotency_key: "create-s",
    source: "browser",
    surface: "mark",
    session_id: "session-s",
    branch_id: "branch-s",
    parent_intent_id: "intent-s",
    release_id: "release-s",
    release_version: "1.0.0",
  });
  const first = pcm(5, 6);
  const second = pcm(7, 8);
  store.appendSegment(draft.id, {
    segment_id: "seg-s1",
    bytes: first,
    duration_ms: 90,
    expected_revision: draft.revision,
  });
  store.appendSegment(draft.id, {
    segment_id: "seg-s2",
    bytes: second,
    duration_ms: 110,
    expected_revision: store.get(draft.id).revision,
  });
  store.transition(draft.id, {
    action: "pause",
    idempotency_key: "pause-s",
    expected_revision: store.get(draft.id).revision,
  });
  store.transition(draft.id, {
    action: "send_ready",
    idempotency_key: "ready-s",
    expected_revision: store.get(draft.id).revision,
  });

  const audio = store.readAudio(draft.id);
  assert.deepEqual(audio.readBuffer(), Buffer.concat([first, second]));
  assert.equal(path.basename(audio.path), "audio.pcm");

  const claim = store.claimForTurn(draft.id, {
    session_id: "session-s",
    branch_id: "branch-s",
    turn_id: "turn-s",
    expected_revision: store.get(draft.id).revision,
  });
  assert.equal(claim.turn_id, "turn-s");

  const sent = store.markSent(draft.id, {
    receipt_id: "sent-s",
    session_id: "session-s",
    branch_id: "branch-s",
    turn_id: "turn-s",
    expected_revision: store.get(draft.id).revision,
  });
  assert.equal(sent.turn_id, "turn-s");
  const stored = store.get(draft.id);
  assert.equal(stored.state, "sent");
  assert.equal(stored.audio.total_bytes, 0);
  assert.equal(stored.tombstone.mode, "sent");
  assert.throws(() => store.readAudio(draft.id), /no readable audio/);
}

function assertDiscard(tempDir) {
  const dataDir = path.join(tempDir, "discard");
  const store = voiceDrafts.createVoiceDraftStore({ dataDir });
  const draft = store.create({
    idempotency_key: "create-d",
    session_id: "session-d",
    branch_id: "branch-d",
  });
  store.appendSegment(draft.id, {
    segment_id: "seg-d1",
    bytes: pcm(9, 10),
    duration_ms: 70,
    partial_transcript: "erase this",
    expected_revision: draft.revision,
  });
  store.discard(draft.id, {
    idempotency_key: "discard-d",
    expected_revision: store.get(draft.id).revision,
  });

  const discarded = store.get(draft.id);
  assert.equal(discarded.state, "discarded");
  assert.equal(discarded.partial_transcript, "");
  assert.equal(discarded.audio.total_bytes, 0);
  assert.equal(discarded.cleanup_pending, null);
  assert.ok(discarded.tombstone);
  assert.equal(discarded.tombstone.mode, "discarded");
  assert.equal(fs.existsSync(path.join(dataDir, "voice-drafts", draft.id, "audio.pcm")), false);
}

function assertExpiredReplayAndAudioSnapshot(tempDir) {
  const dataDir = path.join(tempDir, "expired");
  const store = voiceDrafts.createVoiceDraftStore({
    dataDir,
    maxDrafts: 1,
    maxTerminalDrafts: 1,
  });
  const firstCommand = {
    idempotency_key: "create-expired-a",
    session_id: "session-expired-a",
    branch_id: "branch-expired-a",
  };
  const first = store.create(firstCommand);
  store.appendSegment(first.id, {
    segment_id: "segment-expired-a",
    bytes: pcm(1, 2),
    duration_ms: 10,
    expected_revision: first.revision,
  });
  store.transition(first.id, {
    action: "park",
    idempotency_key: "park-expired-a",
    expected_revision: store.get(first.id).revision,
  });
  const handle = store.readAudio(first.id);
  fs.writeFileSync(handle.path, pcm(9, 8));
  assert.throws(() => handle.readBuffer(), /digest changed/);
  assert.throws(() => handle.createReadStream(), /digest changed/);
  fs.writeFileSync(handle.path, pcm(1, 2));
  store.discard(first.id, {
    idempotency_key: "discard-expired-a",
    expected_revision: store.get(first.id).revision,
  });
  const second = store.create({
    idempotency_key: "create-expired-b",
    session_id: "session-expired-b",
    branch_id: "branch-expired-b",
  });
  store.discard(second.id, {
    idempotency_key: "discard-expired-b",
    expected_revision: second.revision,
  });
  assert.equal(store.get(first.id).kind, "voice_draft_expired_replay");
  assert.equal(fs.existsSync(path.join(dataDir, "voice-drafts", first.id)), false);
  assert.equal(store.status().replay_index.record_count, 1);
  assert.ok(store.status().replay_index.metadata_bytes > 0);
  assert.throws(
    () => store.create(firstCommand),
    (error) => error.statusCode === 410 && error.code === "voice_draft_replay_expired",
  );
}

function pcm(...samples) {
  return Buffer.from(samples.flatMap((sample) => [sample, 0]));
}
