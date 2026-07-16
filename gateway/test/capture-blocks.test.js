"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAudioNotesStore } = require("../lib/audio-notes");
const { createSttStage } = require("../lib/voice-stages");
const { createCaptureBlockStore, transcribeCaptureBlock } = require("../lib/capture-blocks");

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-capture-blocks-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let tick = 0;
  let id = 0;
  const store = createCaptureBlockStore({
    dataDir,
    now: () => `2026-07-16T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    createId: (prefix) => `${prefix}_${++id}`,
  });
  const audioStore = createAudioNotesStore({ dataDir });
  const note = audioStore.create({
    bytes: Buffer.from([1, 2, 3, 4]),
    content_type: "audio/L16; rate=16000; channels=1",
  });
  const create = (overrides = {}) => store.create({
    idempotency_key: "upload-1",
    audio_note: { id: note.id, href: note.audio.href, content_type: note.content_type, bytes: note.bytes },
    input_languages: ["en-US", "am-ET"],
    owner_id: "owner_1",
    session_id: "session_1",
    source_surface: "android_ime",
    ...overrides,
  });
  return { dataDir, store, audioStore, note, create };
}

test("forced STT failure preserves audio and idempotent retry reaches transcribed", async (t) => {
  const { store, audioStore, note, create } = fixture(t);
  const block = create();
  const expectedBytes = fs.readFileSync(audioStore.audioPath(note.id));
  let calls = 0;
  const failingStt = createSttStage({
    id: "fixture-stt",
    transcribe: async ({ audioNote, languageCodes }) => {
      calls += 1;
      assert.equal(audioNote.id, note.id);
      assert.deepEqual(languageCodes, ["en-US", "am-ET"]);
      const error = new Error("provider offline\nretry later");
      error.code = "UNAVAILABLE";
      throw error;
    },
  });

  await assert.rejects(
    transcribeCaptureBlock(store, block.id, { stt: failingStt, claim_id: "attempt-1" }),
    /provider offline/,
  );
  const failed = store.detail(block.id);
  assert.equal(failed.transcription.state, "failed");
  assert.deepEqual(failed.audio_note, block.audio_note);
  assert.equal(failed.transcription.failure.code, "UNAVAILABLE");
  assert.equal(failed.transcription.failure.message, "provider offline retry later");
  assert.deepEqual(fs.readFileSync(audioStore.audioPath(note.id)), expectedBytes);

  const queued = store.retry(block.id, { idempotency_key: "retry-1" });
  assert.equal(queued.transcription.retry_count, 1);
  assert.deepEqual(store.retry(block.id, { idempotency_key: "retry-1" }), queued);
  const successfulStt = createSttStage({
    id: "fixture-stt",
    transcribe: async () => ({
      text: "Exact literal transcript.\nSecond line.",
      language_evidence: { code: "en-US", restricted_to: ["en-US", "am-ET", "ignored"] },
    }),
  });
  const completed = await transcribeCaptureBlock(store, block.id, {
    stt: successfulStt,
    claim_id: "attempt-2",
    model: () => assert.fail("capture must not call a model"),
    tools: () => assert.fail("capture must not call tools"),
    memory: () => assert.fail("capture must not call memory"),
    tts: () => assert.fail("capture must not call TTS"),
    agent: () => assert.fail("capture must not dispatch an agent"),
  });
  assert.equal(calls, 1);
  assert.equal(completed.transcription.state, "transcribed");
  assert.equal(completed.transcription.literal_transcript, "Exact literal transcript.\nSecond line.");
  assert.deepEqual(completed.transcription.language_evidence.restricted_to, ["en-US", "am-ET"]);
  assert.deepEqual(fs.readFileSync(audioStore.audioPath(note.id)), expectedBytes);
  assert.deepEqual(
    await transcribeCaptureBlock(store, block.id, { stt: successfulStt, claim_id: "attempt-2" }),
    completed,
  );
});

test("create, claim, result, and failure transitions are idempotent but reject conflicts", (t) => {
  const { store, note, create } = fixture(t);
  const block = create();
  assert.deepEqual(create(), block);
  assert.throws(() => create({ audio_note: { id: `${note.id}_other` }, input_languages: ["en-US"] }), /different audio/);

  const claimed = store.claim(block.id, { claim_id: "claim-1", provider: "chirp" });
  assert.equal(claimed.transcription.attempt, 1);
  assert.deepEqual(store.claim(block.id, { claim_id: "claim-1" }), claimed);
  assert.throws(() => store.claim(block.id, { claim_id: "claim-2" }), /cannot be claimed/);
  assert.throws(() => store.recordFailure(block.id, { claim_id: "wrong", error: "bad" }), /claim does not match/);
  const failed = store.recordFailure(block.id, { claim_id: "claim-1", error: "plain failure" });
  assert.deepEqual(store.recordFailure(block.id, { claim_id: "claim-1", error: "changed" }), failed);
  assert.throws(() => store.recordResult(block.id, { claim_id: "claim-1", literal_transcript: "late" }), /claim does not match/);

  store.retry(block.id, { idempotency_key: "retry-2" });
  assert.throws(() => store.retry(block.id, { idempotency_key: "retry-3" }), /cannot be retried/);
  store.claim(block.id, { claim_id: "claim-2" });
  const result = store.recordResult(block.id, {
    claim_id: "claim-2",
    literal_transcript: " literal bytes stay exactly this way \n",
    language_evidence: null,
  });
  assert.deepEqual(store.recordResult(block.id, {
    claim_id: "claim-2",
    literal_transcript: " literal bytes stay exactly this way \n",
  }), result);
  assert.throws(() => store.recordResult(block.id, {
    claim_id: "claim-2",
    literal_transcript: "different",
  }), /immutable/);
});

test("revisions are append-only children and tombstone preserves source provenance", (t) => {
  const { store, create } = fixture(t);
  const block = create();
  assert.throws(() => store.addRevision(block.id, {
    idempotency_key: "edit-too-soon", kind: "user_edit", text: "edit",
  }), /requires a literal/);
  store.claim(block.id, { claim_id: "claim" });
  store.recordResult(block.id, { claim_id: "claim", literal_transcript: "literal" });
  const first = store.addRevision(block.id, {
    idempotency_key: "edit-1",
    kind: "user_edit",
    text: "corrected",
    provenance: { actor: "user", model: "ignored", skill_version: "v1" },
  });
  assert.deepEqual(store.addRevision(block.id, {
    idempotency_key: "edit-1", kind: "summary", text: "different",
  }), first);
  const second = store.addRevision(block.id, {
    idempotency_key: "edit-2",
    kind: "writing_skill",
    parent_revision_id: first.id,
    text: "polished",
  });
  assert.equal(second.parent_revision_id, first.id);
  assert.equal(store.detail(block.id).transcription.literal_transcript, "literal");
  assert.throws(() => store.addRevision(block.id, {
    idempotency_key: "bad-kind", kind: "literal", text: "overwrite",
  }), /unsupported revision/);
  assert.throws(() => store.addRevision(block.id, {
    idempotency_key: "bad-parent", kind: "summary", parent_revision_id: "missing", text: "summary",
  }), /parent revision not found/);

  const tombstoned = store.tombstone(block.id, { idempotency_key: "delete-1", reason: " retention request\n" });
  assert.equal(tombstoned.transcription.state, "tombstoned");
  assert.equal(tombstoned.transcription.literal_transcript, "literal");
  assert.equal(tombstoned.audio_note.id, block.audio_note.id);
  assert.deepEqual(store.tombstone(block.id, { idempotency_key: "delete-1" }), tombstoned);
  assert.throws(() => store.tombstone(block.id, { idempotency_key: "delete-2" }), /already tombstoned/);
  assert.throws(() => store.retry(block.id, { idempotency_key: "retry-deleted" }), /not mutable/);
  assert.throws(() => store.addRevision(block.id, {
    idempotency_key: "edit-deleted", kind: "user_edit", text: "no",
  }), /not mutable/);
});

test("bounded validation, missing records, and corrupt sidecars fail closed", async (t) => {
  const { dataDir, store, create } = fixture(t);
  assert.equal(store.detail("missing"), null);
  assert.equal(store.detail("bad/path"), null);
  assert.throws(() => store.claim("missing", { claim_id: "x" }), (error) => error.statusCode === 404);
  await assert.rejects(transcribeCaptureBlock(store, "missing", { claim_id: "x" }), /STT stage/);
  assert.throws(() => create({ idempotency_key: "" }), /idempotency_key/);
  assert.throws(() => create({ idempotency_key: "bad-audio", audio_note: null }), /audio_note/);
  assert.throws(() => create({ idempotency_key: "bad-id", audio_note: {} }), /audio_note.id/);
  assert.throws(() => create({ idempotency_key: "bad-languages", input_languages: [] }), /one or two/);
  assert.throws(() => create({ idempotency_key: "too-many", input_languages: ["en-US", "am-ET", "es-US"] }), /one or two/);
  assert.throws(() => create({ idempotency_key: "bad-code", input_languages: ["english"] }), /invalid language/);
  assert.throws(() => store.claim(create().id, { claim_id: "" }), /claim_id/);

  const validationBlock = create({ idempotency_key: "validation-block", input_languages: ["en-US", "en-US"] });
  assert.deepEqual(validationBlock.input_languages, ["en-US"]);
  assert.equal(validationBlock.audio_note.bytes, 4);
  store.claim(validationBlock.id, { claim_id: "validation-claim" });
  assert.throws(() => store.recordResult(validationBlock.id, {
    claim_id: "validation-claim", literal_transcript: "", language_evidence: {},
  }), /transcript text/);
  assert.throws(() => store.recordResult(validationBlock.id, {
    claim_id: "validation-claim", literal_transcript: "ok", language_evidence: [],
  }), /language evidence/);
  store.recordFailure(validationBlock.id, { claim_id: "validation-claim", error: null });

  const provenanceBlock = create({ idempotency_key: "provenance-block" });
  store.claim(provenanceBlock.id, { claim_id: "provenance-claim" });
  store.recordResult(provenanceBlock.id, { claim_id: "provenance-claim", literal_transcript: "literal" });
  assert.throws(() => store.addRevision(provenanceBlock.id, {
    idempotency_key: "bad-provenance", kind: "summary", text: "summary", provenance: [],
  }), /provenance/);

  const defaultStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-capture-defaults-"));
  t.after(() => fs.rmSync(defaultStoreDir, { recursive: true, force: true }));
  const defaultStore = createCaptureBlockStore({ dataDir: defaultStoreDir });
  assert.match(defaultStore.create({
    idempotency_key: "default-id",
    audio_note: { id: "note-default", bytes: -1 },
    input_languages: ["en-US"],
  }).id, /^capture_/);

  const blocksDir = path.join(dataDir, "capture-blocks");
  fs.writeFileSync(path.join(blocksDir, "corrupt.json"), "{");
  fs.writeFileSync(path.join(blocksDir, "primitive.json"), "1");
  fs.writeFileSync(path.join(blocksDir, "invalid.json"), JSON.stringify({ id: "" }));
  assert.equal(store.detail("corrupt"), null);
});
