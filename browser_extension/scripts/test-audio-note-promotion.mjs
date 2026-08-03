import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTURE_BLOCKS_PATH,
  canHandoffPromotion,
  captureBlockHandoffPath,
  captureBlockHandoffRequest,
  captureBlockPath,
  captureBlockRequest,
  captureBlockRetryPath,
  captureBlockSnapshot,
  handoffPresentation,
  newPromotionRecord,
  promotionPresentation,
  promotionRecordWithBlock,
  promotionRecordWithHandoff,
  promotionStorageKey,
  usablePromotionRecord,
} from "../extension/audio-note-promotion.js";

const BLOCK_ID = `cap_${"a".repeat(64)}`;
const NOTE = { id: "note/1", surface: "browser-extension", session_id: "session_1" };

test("promotion identity is generated once and retained separately per audio note", () => {
  const created = newPromotionRecord(NOTE, () => "request-1");
  assert.equal(CAPTURE_BLOCKS_PATH, "/v1/capture-blocks");
  assert.equal(created.idempotency_key, "browser-audio-note:note/1:request-1");
  assert.ok(newPromotionRecord({ id: "n".repeat(120) }, () => "r".repeat(200)).idempotency_key.length <= 200);
  assert.equal(promotionStorageKey(NOTE), "ageeAudioNotePromotion:note%2F1");
  assert.deepEqual(usablePromotionRecord(NOTE, created), created);
  assert.equal(usablePromotionRecord({ id: "other" }, created), null);
});

test("persisted promotion state cannot bind one note card to another block", () => {
  const created = newPromotionRecord(NOTE, () => "request-1");
  const stale = {
    ...created,
    capture_block_id: BLOCK_ID,
    snapshot: {
      capture_block_id: BLOCK_ID,
      audio_note_id: "different-note",
      processing_state: "transcribed",
      transcript_state: "transcribed",
      literal_transcript: "wrong source",
      transcript_result_id: "result_wrong",
      transcript_provider_id: "chirp",
    },
    handoff: {
      source_record_id: BLOCK_ID,
      admission_id: "admission_wrong",
      source_revision: `capture-block-v2:${"b".repeat(64)}`,
      request_digest: `sha256:${"c".repeat(64)}`,
      compiled_intent_ids: ["intent_wrong"],
    },
  };
  const recovered = usablePromotionRecord(NOTE, stale);
  assert.equal(recovered.capture_block_id, null);
  assert.equal(recovered.snapshot, null);
  assert.equal(recovered.handoff, null);
  assert.equal(recovered.idempotency_key, created.idempotency_key);
  assert.equal(canHandoffPromotion(recovered), false);
});

test("promotion request binds the exact stored note and stays non-executing", () => {
  const record = newPromotionRecord(NOTE, () => "request-1");
  assert.deepEqual(captureBlockRequest(NOTE, record), {
    audio_note_id: "note/1",
    idempotency_key: record.idempotency_key,
    source: { surface: "browser-extension", session_id: "session_1", capture_id: "" },
  });
  assert.equal(captureBlockPath(BLOCK_ID), `/v1/capture-blocks/${BLOCK_ID}`);
  assert.equal(captureBlockRetryPath(BLOCK_ID), `/v1/capture-blocks/${BLOCK_ID}/retry`);
  assert.equal(JSON.stringify(captureBlockRequest(NOTE, record)).includes("execute"), false);
  assert.throws(() => captureBlockPath("bad"), /invalid/);
});

test("returned capture state is validated, bounded, and rendered honestly", () => {
  const payload = { capture_block: {
    id: BLOCK_ID,
    source: { audio_note_id: "note/1" },
    processing_state: "transcribed",
    transcript: {
      state: "transcribed",
      literal: "exact literal",
      result_id: "result_1",
      provider: { id: "chirp", request_id: "provider_1" },
    },
  } };
  const snapshot = captureBlockSnapshot(payload);
  assert.equal(snapshot.literal_transcript, "exact literal");
  const record = promotionRecordWithBlock(NOTE, newPromotionRecord(NOTE, () => "request-1"), payload);
  assert.equal(record.capture_block_id, BLOCK_ID);
  assert.deepEqual(promotionPresentation(record), {
    state: "transcribed",
    label: "Transcribed · no execution started",
    action: "Refresh transcript",
    error: false,
  });
  assert.throws(() => promotionRecordWithBlock(NOTE, record, {
    capture_block: { ...payload.capture_block, source: { audio_note_id: "other" } },
  }), /selected audio note/);
});

test("Switchboard handoff is exposed only for an exact terminal transcript", () => {
  const base = newPromotionRecord(NOTE, () => "request-1");
  const terminal = promotionRecordWithBlock(NOTE, base, { capture_block: {
    id: BLOCK_ID,
    source: { audio_note_id: "note/1" },
    processing_state: "transcribed",
    transcript: {
      state: "transcribed",
      literal: "exact literal",
      result_id: "result_1",
      provider: { id: "chirp", request_id: "provider_1" },
    },
  } });
  assert.equal(canHandoffPromotion(terminal), true);
  assert.equal(captureBlockHandoffPath(BLOCK_ID), `/v1/capture-blocks/${BLOCK_ID}/handoff`);
  assert.deepEqual(captureBlockHandoffRequest(terminal), { confirmed: true, authority: "execute" });
  assert.deepEqual(handoffPresentation(terminal), {
    sent: false,
    label: "Ready for explicit Switchboard handoff",
    action: "Send to Switchboard",
  });
  for (const state of ["stored", "queued", "transcribing", "failed"]) {
    const unfinished = { ...terminal, snapshot: { ...terminal.snapshot, processing_state: state, transcript_state: state } };
    assert.equal(canHandoffPromotion(unfinished), false);
    assert.equal(handoffPresentation(unfinished), null);
    assert.throws(() => captureBlockHandoffRequest(unfinished), /not ready/);
  }
});

test("Switchboard receipt is exact, durable, and reset by a transcript revision", () => {
  const terminal = promotionRecordWithBlock(NOTE, newPromotionRecord(NOTE, () => "request-1"), { capture_block: {
    id: BLOCK_ID,
    source: { audio_note_id: "note/1" },
    processing_state: "transcribed",
    transcript: {
      state: "transcribed",
      literal: "exact literal",
      result_id: "result_1",
      provider: { id: "chirp", request_id: "provider_1" },
    },
  } });
  const sent = promotionRecordWithHandoff(terminal, { handoff: {
    source_system: "chief-moa",
    source_record_id: BLOCK_ID,
    source_revision: `capture-block-v2:${"b".repeat(64)}`,
    request_digest: `sha256:${"c".repeat(64)}`,
    switchboard: {
      admission_id: "ext_1",
      raw_intent_id: "raw_1",
      compiled_intent_ids: ["intent_1"],
      state: "queued",
    },
  } });
  assert.match(handoffPresentation(sent).label, /intent intent_1 · queued/);
  assert.equal(usablePromotionRecord(NOTE, sent).handoff.admission_id, "ext_1");
  assert.throws(() => promotionRecordWithHandoff(terminal, {
    handoff: {
      source_system: "chief-moa",
      source_record_id: `cap_${"d".repeat(64)}`,
      source_revision: `capture-block-v2:${"b".repeat(64)}`,
      request_digest: `sha256:${"c".repeat(64)}`,
      switchboard: { admission_id: "ext_2" },
    },
  }), /mismatched/);
  const revised = promotionRecordWithBlock(NOTE, sent, { capture_block: {
    id: BLOCK_ID,
    source: { audio_note_id: "note/1" },
    processing_state: "transcribed",
    transcript: {
      state: "transcribed",
      literal: "revised literal",
      result_id: "result_2",
      provider: { id: "chirp", request_id: "provider_2" },
    },
  } });
  assert.equal(revised.handoff, null);
});

test("queued, transcribing, and retryable failure remain distinct", () => {
  const record = (snapshot) => ({ snapshot });
  assert.equal(promotionPresentation(null).state, "stored");
  assert.equal(promotionPresentation(record({ processing_state: "queued" })).state, "queued");
  assert.equal(promotionPresentation(record({ processing_state: "transcribing" })).state, "transcribing");
  const failed = promotionPresentation(record({
    processing_state: "failed",
    failure_message: "provider unavailable",
    retryable: true,
  }));
  assert.equal(failed.state, "failed");
  assert.match(failed.label, /retry available/);
  assert.equal(failed.action, "Retry transcript");
  const eventDriven = captureBlockSnapshot({
    id: BLOCK_ID,
    source: { audio_note_id: "note/1" },
    processing_state: "queued",
    processing_events: [{ to_state: "failed", retryable: true, error: "later failure" }],
  });
  assert.equal(eventDriven.processing_state, "failed");
  assert.equal(eventDriven.retryable, true);
});
