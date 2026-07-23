"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventSubstrateStore } = require("../lib/event-substrate");
const {
  CAPTURE_EVENT,
  ROUTING_EVENT,
  MAX_LITERAL_BYTES,
  CaptureBlockError,
  createCaptureBlockStore,
  captureBlockFromVoiceTurn,
  captureBlockId,
  initialRoutingProposal,
  isCompletedTranscriptionOnly,
  requireCaptureBlockId,
  routingProposalId,
} = require("../lib/capture-blocks");

function completedDictation(overrides = {}) {
  const record = {
    id: "turn_dictation_1",
    session_id: "session_shared",
    conversation_id: "session_shared",
    branch_id: "default",
    device_id: "browser_1",
    source: "browser-extension",
    transcript: "  Hello ሰላም.\nKeep my spacing.  ",
    transcript_source: "stt",
    transcript_provider: "chirp-3",
    audio_format: "pcm16/16000/mono",
    created_at: "2026-07-22T17:00:00.000Z",
    updated_at: "2026-07-22T17:00:05.000Z",
    references: {
      voice_session: {
        transcription_only: true,
        status: "completed",
        incomplete: false,
        provider: "cascaded",
        model: "chirp_3",
        input_languages: ["en-US", "am-ET", "en-US"],
        transcript_language_rejected: false,
        audio: { bytes: 32000, chunks: 4, encoding: "pcm16" },
      },
    },
  };
  return {
    ...record,
    ...overrides,
    references: overrides.references || record.references,
  };
}

function tempStore(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-capture-blocks-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const events = createEventSubstrateStore({ dataDir, originId: "gateway-test" });
  return { events, store: createCaptureBlockStore({ events }) };
}

test("completed transcription-only voice identity is deterministic from session and turn", () => {
  const first = completedDictation();
  const second = completedDictation({ transcript: "different later text" });
  assert.equal(isCompletedTranscriptionOnly(first), true);
  assert.equal(captureBlockId(first.session_id, first.id), captureBlockId(second.session_id, second.id));
  assert.match(captureBlockId(first.session_id, first.id), /^cap_[a-f0-9]{64}$/);
  assert.throws(() => requireCaptureBlockId("cap_bad"), CaptureBlockError);
  for (const record of [
    completedDictation({ references: { voice_session: { transcription_only: false, status: "completed" } } }),
    completedDictation({ references: { voice_session: { transcription_only: true, status: "error" } } }),
    completedDictation({ incomplete: true }),
  ]) {
    assert.equal(isCompletedTranscriptionOnly(record), false);
  }
});

test("capture preserves the exact high-bounded literal and retained provenance", () => {
  const record = completedDictation();
  const block = captureBlockFromVoiceTurn(record);
  assert.equal(block.literal_transcript, record.transcript);
  assert.deepEqual(block.transcript_completeness, {
    state: "complete",
    exact: true,
    truncated: false,
    utf8_bytes: Buffer.byteLength(record.transcript),
  });
  assert.deepEqual(block.audio, {
    retention_state: "retained",
    storage_ref: "voice-sessions/session_shared/turn_dictation_1.pcm",
    href: "/v1/voice/audio/session_shared/turn_dictation_1?kind=user",
    encoding: "pcm16",
    bytes: 32000,
    chunks: 4,
    format: "pcm16/16000/mono",
  });
  assert.deepEqual(block.transcript_provenance, {
    transcript_source: "stt",
    transcript_provider: "chirp-3",
    voice_provider: "cascaded",
    model: "chirp_3",
    input_languages: ["en-US", "am-ET"],
    language_rejected: false,
  });
  const proposal = initialRoutingProposal(block);
  assert.equal(proposal.id, routingProposalId(block.id));
  assert.equal(proposal.route, "file_only");
  assert.equal(proposal.classification, "unclassified");
  assert.equal(proposal.executable, false);
  assert.equal(proposal.provenance.model_used, false);
});

test("capture normalizes bounded fallback provenance without inventing execution state", () => {
  const block = captureBlockFromVoiceTurn(completedDictation({
    id: undefined,
    turn_id: "turn_fallback",
    session_id: undefined,
    conversation_id: "conversation_fallback",
    branch_id: "",
    source: "",
    device_id: "",
    transcript_provider: "",
    audio_format: "",
    created_at: "",
    completed_at: "2026-07-22T17:00:05.000Z",
    updated_at: "",
    references: {
      voice_session: {
        transcription_only: true,
        status: "completed",
        provider: "chirp",
        transcript_language_rejected: true,
        audio: { bytes: "32", chunks: "invalid", encoding: "" },
      },
    },
  }));
  assert.equal(block.source.session_id, "conversation_fallback");
  assert.equal(block.source.turn_id, "turn_fallback");
  assert.equal(block.source.branch_id, "default");
  assert.equal(block.created_at, block.completed_at);
  assert.equal(block.audio.encoding, "pcm16");
  assert.equal(block.audio.chunks, 0);
  assert.equal(block.audio.format, "pcm16");
  assert.equal(block.transcript_provenance.transcript_provider, "chirp");
  assert.deepEqual(block.transcript_provenance.input_languages, []);
  assert.equal(block.transcript_provenance.language_rejected, true);
});

test("literal validation rejects instead of truncating and requires retained audio", () => {
  const exactLimit = "x".repeat(MAX_LITERAL_BYTES);
  assert.equal(captureBlockFromVoiceTurn(completedDictation({ transcript: exactLimit })).literal_transcript.length, MAX_LITERAL_BYTES);
  assert.throws(
    () => captureBlockFromVoiceTurn(completedDictation({ transcript: `${exactLimit}x` })),
    /exceeds/,
  );
  assert.throws(
    () => captureBlockFromVoiceTurn(completedDictation({
      references: { voice_session: { transcription_only: true, status: "completed", audio: { bytes: 0 } } },
    })),
    /retained voice audio/,
  );
  assert.throws(() => captureBlockFromVoiceTurn(completedDictation({ transcript: " \n " })), /literal transcript/);
  assert.throws(() => captureBlockFromVoiceTurn(completedDictation({ updated_at: "not-a-date" })), /completed_at/);
});

test("recording is idempotent and creates exactly one append-only non-executing proposal", async (t) => {
  const { events, store } = tempStore(t);
  const record = completedDictation();
  const first = await store.recordCompletedDictation(record);
  const second = await store.recordCompletedDictation(record);
  assert.deepEqual(second, first);
  assert.equal(first.literal_transcript, record.transcript);
  assert.equal(first.routing_proposals.length, 1);
  assert.equal(first.routing_proposals[0].route, "file_only");
  assert.equal(first.routing_proposals[0].executable, false);

  const rows = await events.listEvents({ stream_id: `capture-block:${first.id}`, order: "asc", limit: 20 });
  assert.deepEqual(rows.map((event) => event.event_type), [CAPTURE_EVENT, ROUTING_EVENT]);
  assert.equal(rows.filter((event) => event.event_type === ROUTING_EVENT).length, 1);
  assert.equal(rows.some((event) => event.payload?.agent_run_id || event.payload?.run_id), false);

  assert.equal(await store.recordCompletedDictation(completedDictation({
    references: { voice_session: { transcription_only: false, status: "completed" } },
  })), null);
});

test("retry after a proposal append fault fills only the missing event", async (t) => {
  const base = tempStore(t);
  let failOnce = true;
  const events = {
    listEvents: base.events.listEvents,
    appendEvent: async (event) => {
      if (event.event_type === ROUTING_EVENT && failOnce) {
        failOnce = false;
        throw new Error("simulated proposal append fault");
      }
      return base.events.appendEvent(event);
    },
  };
  const store = createCaptureBlockStore({ events });
  await assert.rejects(store.recordCompletedDictation(completedDictation()), /simulated/);
  const id = captureBlockId("session_shared", "turn_dictation_1");
  let rows = await base.events.listEvents({ stream_id: `capture-block:${id}`, order: "asc", limit: 20 });
  assert.deepEqual(rows.map((event) => event.event_type), [CAPTURE_EVENT]);
  const recovered = await store.recordCompletedDictation(completedDictation());
  assert.equal(recovered.routing_proposals.length, 1);
  rows = await base.events.listEvents({ stream_id: `capture-block:${id}`, order: "asc", limit: 20 });
  assert.deepEqual(rows.map((event) => event.event_type), [CAPTURE_EVENT, ROUTING_EVENT]);
});

test("list, get, and search return bounded rehydrated projections", async (t) => {
  const { store } = tempStore(t);
  const first = await store.recordCompletedDictation(completedDictation());
  const second = await store.recordCompletedDictation(completedDictation({
    id: "turn_dictation_2",
    session_id: "other_session",
    conversation_id: "other_session",
    transcript: "A note about FPGA inference.",
    created_at: "2026-07-22T18:00:00.000Z",
    updated_at: "2026-07-22T18:00:03.000Z",
  }));
  assert.deepEqual(await store.get(first.id), first);
  assert.equal(await store.get(captureBlockId("missing", "missing")), null);

  let result = await store.list({ limit: 1, offset: 0 });
  assert.deepEqual(result.items.map((item) => item.id), [second.id]);
  assert.equal(result.has_more, true);
  result = await store.list({ session_id: "session_shared", source_surface: "browser-extension" });
  assert.deepEqual(result.items.map((item) => item.id), [first.id]);
  result = await store.search("fpga", { limit: 10 });
  assert.deepEqual(result.items.map((item) => item.id), [second.id]);
  result = await store.search("AM-ET", { limit: 10 });
  assert.equal(result.items.length, 2);
  result = await store.list({ turnId: "turn_dictation_1", sourceSurface: "browser-extension", q: "spacing" });
  assert.deepEqual(result.items.map((item) => item.id), [first.id]);
  assert.equal(result.has_more, false);
  result = await store.list({ turn_id: "absent" });
  assert.deepEqual(result.items, []);
  result = await store.search("not present anywhere");
  assert.deepEqual(result.items, []);
  await assert.rejects(store.list({ limit: 101 }), /integer must be between/);
  await assert.rejects(store.list({ offset: -1 }), /integer must be between/);
});

test("constructor and malformed source validation fail closed", () => {
  assert.throws(() => createCaptureBlockStore(), /event substrate/);
  assert.throws(
    () => captureBlockFromVoiceTurn(completedDictation({ session_id: "", conversation_id: "" })),
    /session_id/,
  );
  assert.throws(
    () => captureBlockFromVoiceTurn(completedDictation({ id: "", turn_id: "" })),
    /turn_id/,
  );
});
