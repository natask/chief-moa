"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAudioNotesStore } = require("../lib/audio-notes");
const { createEventSubstrateStore } = require("../lib/event-substrate");
const { createCaptureBlockStore } = require("../lib/capture-blocks");
const {
  CAPTURE_CREATED_EVENT,
  PROCESSING_EVENT,
  AudioCaptureBlockError,
  audioCaptureBlockId,
  createAudioCaptureBlockService,
  queuedBlockFromAudioNote,
} = require("../lib/audio-capture-blocks");

function harness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-audio-capture-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const audioNotes = createAudioNotesStore({ dataDir });
  const events = createEventSubstrateStore({ dataDir, originId: "capture-test" });
  const captureBlocks = createCaptureBlockStore({ events });
  const service = createAudioCaptureBlockService({ events, audioNotes, captureBlocks });
  return { audioNotes, events, captureBlocks, service };
}

function storedNote(audioNotes, overrides = {}) {
  return audioNotes.create({
    bytes: Buffer.from("exact raw voice bytes"),
    content_type: "audio/webm;codecs=opus",
    surface: "browser-extension",
    session_id: "session_voice_note",
    duration_ms: 1234,
    ...overrides,
  });
}

function createInput(note, overrides = {}) {
  return {
    audio_note_id: note.id,
    owner_id: "usr_owner",
    idempotency_key: "capture-request-1",
    source: {
      surface: note.surface,
      session_id: note.session_id,
      device_id: "browser-device-1",
      capture_id: "local-capture-1",
    },
    ...overrides,
  };
}

test("stored audio becomes one queued canonical block without changing raw bytes", async (t) => {
  const state = harness(t);
  const note = storedNote(state.audioNotes);
  const before = fs.readFileSync(state.audioNotes.audioPath(note.id));

  const block = await state.service.create(createInput(note));

  assert.equal(block.id, audioCaptureBlockId(note.id));
  assert.equal(block.owner_id, "usr_owner");
  assert.equal(block.processing_state, "queued");
  assert.equal(block.audio.audio_note_id, note.id);
  assert.equal(block.audio.retention_state, "retained");
  assert.equal(block.transcript.state, "queued");
  assert.equal(block.transcript.literal, null);
  assert.deepEqual(block.transcript_revisions, []);
  assert.deepEqual(block.dispatches, []);
  assert.equal(block.source.surface, note.surface);
  assert.equal(block.source.session_id, note.session_id);
  assert.deepEqual(fs.readFileSync(state.audioNotes.audioPath(note.id)), before);

  const rows = await state.events.listEvents({ stream_id: `capture-block:${block.id}`, order: "asc", limit: 10 });
  assert.deepEqual(rows.map((row) => row.event_type), [CAPTURE_CREATED_EVENT, PROCESSING_EVENT]);
  assert.equal(rows.every((row) => row.authority.execution === "none"), true);
  assert.equal(JSON.stringify(rows).includes("agent_run"), false);
  assert.equal(block.processing_events[0].to_state, "queued");
  assert.equal(block.processing_events[0].attempt, 0);
});

test("creation is idempotent and rejects reuse with different input", async (t) => {
  const state = harness(t);
  const firstNote = storedNote(state.audioNotes);
  const input = createInput(firstNote);
  const first = await state.service.create(input);
  const retry = await state.service.create(input);
  assert.deepEqual(retry, first);

  let rows = await state.events.listEvents({ stream_id: `capture-block:${first.id}`, order: "asc", limit: 10 });
  assert.equal(rows.length, 2);

  const equivalentNewKey = await state.service.create({ ...input, idempotency_key: "capture-request-2" });
  assert.deepEqual(equivalentNewKey, first);
  rows = await state.events.listEvents({ stream_id: `capture-block:${first.id}`, order: "asc", limit: 10 });
  assert.equal(rows.length, 2);

  const otherNote = storedNote(state.audioNotes, { session_id: "session_other" });
  await assert.rejects(
    state.service.create(createInput(otherNote, { idempotency_key: input.idempotency_key })),
    (error) => error instanceof AudioCaptureBlockError && error.statusCode === 409,
  );
});

test("creation validates source, ownership, idempotency, and retained note existence", async (t) => {
  const state = harness(t);
  const note = storedNote(state.audioNotes);
  await assert.rejects(state.service.create(createInput(note, { idempotency_key: "" })), /idempotency_key is required/);
  await assert.rejects(state.service.create(createInput(note, { owner_id: "" })), /owner_id is invalid/);
  await assert.rejects(
    state.service.create(createInput(note, { source: { surface: "android" } })),
    /conflicts with the stored audio note/,
  );
  await assert.rejects(
    state.service.create(createInput(note, { audio_note_id: "note_missing" })),
    (error) => error.statusCode === 404,
  );
  assert.throws(
    () => queuedBlockFromAudioNote({
      audioNote: { ...note, bytes: 0 }, ownerId: "usr_owner", idempotencyKey: "key",
    }),
    /audio_note.bytes/,
  );
  for (const bad of ["x".repeat(201), "bad\nkey"]) {
    await assert.rejects(state.service.create(createInput(note, { idempotency_key: bad })), /idempotency_key is invalid/);
  }
  await assert.rejects(
    state.service.create(createInput(note, { source: [] })),
    /source must be an object/,
  );
  await assert.rejects(
    state.service.create(createInput(note, { source: { device_id: "x".repeat(161) } })),
    /source.device_id exceeds/,
  );
  assert.throws(
    () => queuedBlockFromAudioNote({
      audioNote: { ...note, created_at: "not-a-date" }, ownerId: "usr_owner", idempotencyKey: "key",
    }),
    /must be an ISO timestamp/,
  );
  assert.throws(
    () => queuedBlockFromAudioNote({
      audioNote: { ...note, duration_ms: 86_400_001 }, ownerId: "usr_owner", idempotencyKey: "key",
    }),
    /audio_note.duration_ms/,
  );
});

test("optional source metadata and nullable duration stay bounded", async (t) => {
  const state = harness(t);
  const note = storedNote(state.audioNotes, { surface: "", session_id: "", duration_ms: "invalid" });
  const block = await state.service.create(createInput(note, { source: undefined }));
  assert.equal(block.source.surface, "");
  assert.equal(block.source.session_id, "");
  assert.equal(block.audio.duration_ms, null);
});

test("constructor refuses partial storage dependencies", () => {
  assert.throws(() => createAudioCaptureBlockService(), /require events/);
});
