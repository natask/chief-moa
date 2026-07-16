"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAudioNotesStore } = require("../lib/audio-notes");
const { createCaptureBlockStore } = require("../lib/capture-blocks");
const { createCaptureBlockHandlers, matchRoute } = require("../lib/capture-block-handlers");

function response() {
  return {
    status: 0,
    payload: null,
  };
}

function harness(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-routes-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const audioNotes = createAudioNotesStore({ dataDir });
  const note = audioNotes.create({
    bytes: Buffer.from([1, 2, 3, 4]),
    content_type: "audio/L16; rate=16000; channels=1",
    surface: "android",
    session_id: "session-1",
  });
  const store = createCaptureBlockStore({
    dataDir,
    createId: (prefix) => `${prefix}-1`,
    now: (() => {
      let n = 0;
      return () => `2026-07-16T12:00:0${n++}.000Z`;
    })(),
  });
  let sttAttempts = 0;
  const handlers = createCaptureBlockHandlers({
    store,
    audioNotes,
    authorized: (request) => request.authorized !== false,
    readJsonBody: async (request) => request.body || {},
    sendJson: (res, status, payload) => {
      res.status = status;
      res.payload = payload;
    },
    createStt: async () => {
      if (options.factoryFailure) {
        const error = new Error("STT registry unavailable");
        error.code = "stt_registry_unavailable";
        throw error;
      }
      return ({
      id: "fixture-stt",
      transcribe: async ({ audioNote, languageCodes }) => {
        sttAttempts += 1;
        assert.equal(audioNote.id, note.id);
        assert.deepEqual(languageCodes, ["en-US", "am-ET"]);
        if (sttAttempts === 1) {
          const error = new Error("forced STT failure");
          error.code = "forced_failure";
          throw error;
        }
        return { text: "exact transcript", language_evidence: { code: "en-US", restricted_to: languageCodes } };
      },
      });
    },
  });
  return { note, store, handlers, get sttAttempts() { return sttAttempts; } };
}

async function call(handlers, method, pathname, body = {}, authorized = true) {
  const res = response();
  const handled = await handlers.route({ method, body, authorized }, res, new URL(`http://local${pathname}`));
  return { handled, ...res };
}

test("route matcher accepts only the bounded capture-block vocabulary", () => {
  assert.deepEqual(matchRoute("POST", "/v1/capture-blocks"), { operation: "create" });
  assert.deepEqual(matchRoute("GET", "/v1/capture-blocks/c%201"), { operation: "detail", id: "c1" });
  assert.deepEqual(matchRoute("POST", "/v1/capture-blocks/c/retry"), { operation: "retry", id: "c" });
  assert.deepEqual(matchRoute("POST", "/v1/capture-blocks/c/revisions"), { operation: "revision", id: "c" });
  assert.deepEqual(matchRoute("DELETE", "/v1/capture-blocks/c"), { operation: "tombstone", id: "c" });
  for (const input of [["GET", "/other"], ["PUT", "/v1/capture-blocks"], ["GET", "/v1/capture-blocks"], ["GET", "/v1/capture-blocks/%"], ["GET", "/v1/capture-blocks/%ZZ"], ["POST", "/v1/capture-blocks/c/unknown"]]) {
    assert.equal(matchRoute(...input), null);
  }
});

test("authenticated create preserves audio through failure and retry reaches transcribed", async (t) => {
  const h = harness(t);
  const body = {
    audio_note_id: h.note.id,
    idempotency_key: "create-1",
    input_languages: ["en-US", "am-ET"],
  };
  const denied = await call(h.handlers, "POST", "/v1/capture-blocks", body, false);
  assert.equal(denied.status, 401);
  assert.equal(h.sttAttempts, 0);

  const created = await call(h.handlers, "POST", "/v1/capture-blocks", body);
  assert.equal(created.status, 202);
  assert.equal(created.payload.capture_block.transcription.state, "queued");
  await h.handlers.drain();
  const failed = h.store.detail("capture-1");
  assert.equal(failed.transcription.state, "failed");
  assert.equal(failed.transcription.failure.code, "forced_failure");
  assert.equal(failed.audio_note.id, h.note.id);

  const retry = await call(h.handlers, "POST", "/v1/capture-blocks/capture-1/retry", { idempotency_key: "retry-1" });
  assert.equal(retry.status, 202);
  await h.handlers.drain();
  const completed = h.store.detail("capture-1");
  assert.equal(completed.transcription.state, "transcribed");
  assert.equal(completed.transcription.literal_transcript, "exact transcript");
  assert.equal(h.sttAttempts, 2);

  const duplicate = await call(h.handlers, "POST", "/v1/capture-blocks", body);
  await h.handlers.drain();
  assert.equal(duplicate.payload.capture_block.id, "capture-1");
  assert.equal(h.sttAttempts, 2);
});

test("detail, revision, and tombstone routes expose the lifecycle", async (t) => {
  const h = harness(t);
  await call(h.handlers, "POST", "/v1/capture-blocks", {
    audio_note_id: h.note.id,
    idempotency_key: "create-1",
    input_languages: ["en-US", "am-ET"],
  });
  await h.handlers.drain();
  await call(h.handlers, "POST", "/v1/capture-blocks/capture-1/retry", { idempotency_key: "retry-1" });
  await h.handlers.drain();

  const detail = await call(h.handlers, "GET", "/v1/capture-blocks/capture-1");
  assert.equal(detail.status, 200);
  const revision = await call(h.handlers, "POST", "/v1/capture-blocks/capture-1/revisions", {
    idempotency_key: "revision-1",
    kind: "user_edit",
    text: "edited transcript",
  });
  assert.equal(revision.status, 201);
  assert.equal(revision.payload.revision.text, "edited transcript");
  const tombstone = await call(h.handlers, "DELETE", "/v1/capture-blocks/capture-1", {
    idempotency_key: "delete-1",
    reason: "user_requested",
  });
  assert.equal(tombstone.status, 200);
  assert.equal(tombstone.payload.capture_block.transcription.state, "tombstoned");
  const missing = await call(h.handlers, "GET", "/v1/capture-blocks/missing");
  assert.equal(missing.status, 404);
});

test("route failures stay bounded and unrelated paths fall through", async (t) => {
  const h = harness(t);
  assert.equal((await call(h.handlers, "GET", "/other")).handled, false);
  const missingAudio = await call(h.handlers, "POST", "/v1/capture-blocks", {
    audio_note_id: "missing",
    idempotency_key: "create-x",
    input_languages: ["en-US"],
  });
  assert.equal(missingAudio.status, 404);
  const invalidCreate = await call(h.handlers, "POST", "/v1/capture-blocks", {
    audio_note: { id: h.note.id },
    idempotency_key: "create-invalid",
    session_id: "override-session",
    source_surface: "override-surface",
    input_languages: [],
  });
  assert.equal(invalidCreate.status, 400);
  const badRetry = await call(h.handlers, "POST", "/v1/capture-blocks/missing/retry", { idempotency_key: "retry-x" });
  assert.equal(badRetry.status, 404);
});

test("an unavailable STT registry becomes a retryable stored failure", async (t) => {
  const h = harness(t, { factoryFailure: true });
  await call(h.handlers, "POST", "/v1/capture-blocks", {
    audio_note_id: h.note.id,
    idempotency_key: "create-registry-failure",
    input_languages: ["en-US"],
  });
  await h.handlers.drain();
  const failed = h.store.detail("capture-1");
  assert.equal(failed.transcription.state, "failed");
  assert.equal(failed.transcription.failure.code, "stt_registry_unavailable");
  assert.equal(failed.audio_note.id, h.note.id);
});
