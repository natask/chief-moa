"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAudioNotesStore } = require("../lib/audio-notes");
const { createEventSubstrateStore } = require("../lib/event-substrate");
const { createCaptureBlockStore } = require("../lib/capture-blocks");
const { createAudioCaptureBlockService } = require("../lib/audio-capture-blocks");
const {
  createAudioCaptureTranscriptionService,
  createAudioCaptureTranscriptionWorker,
  selectedSttProviderId,
} = require("../lib/audio-capture-transcription");

async function harness(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-capture-stt-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const audioNotes = createAudioNotesStore({ dataDir });
  const events = createEventSubstrateStore({ dataDir, originId: "capture-stt-test" });
  const captureBlocks = createCaptureBlockStore({ events });
  const capture = createAudioCaptureBlockService({ events, audioNotes, captureBlocks });
  const note = audioNotes.create({
    bytes: Buffer.from("immutable source audio"), content_type: "audio/L16; rate=16000; channels=1",
    surface: "android-ime", session_id: "session_1", duration_ms: 1200,
  });
  const block = await capture.create({
    audio_note_id: note.id, owner_id: "usr_1", idempotency_key: "create_1",
    source: { surface: note.surface, session_id: note.session_id, device_id: "phone_1" },
  });
  let now = Date.parse("2026-08-03T12:00:00.000Z");
  const service = createAudioCaptureTranscriptionService({
    events, captureBlocks, clock: () => new Date(now), leaseMs: overrides.leaseMs || 1_000,
    maxAttempts: overrides.maxAttempts || 3,
  });
  return { audioNotes, events, captureBlocks, service, note, block, advance(ms) { now += ms; } };
}

function claimInput(state, overrides = {}) {
  return {
    capture_block_id: state.block.id,
    worker_id: "worker_a",
    provider_id: "chirp",
    language_profile: { version: "profile-7", languages: ["en-US", "am-ET"], primary: "am-ET" },
    ...overrides,
  };
}

test("claim binds source, language, provider, worker, lease, and attempt idempotently", async (t) => {
  const state = await harness(t);
  const first = await state.service.claim(claimInput(state));
  const duplicate = await state.service.claim(claimInput(state));

  assert.equal(first.claimed, true);
  assert.equal(duplicate.claimed, false);
  assert.deepEqual(duplicate.claim, first.claim);
  assert.equal(first.claim.audio_note_id, state.note.id);
  assert.equal(first.claim.attempt, 0);
  assert.equal(first.claim.worker_id, "worker_a");
  assert.equal(first.claim.provider_id, "chirp");
  assert.deepEqual(first.claim.language_profile.languages, ["en-US", "am-ET"]);
  assert.match(first.claim.language_profile.digest, /^sha256:[a-f0-9]{64}$/);
  await assert.rejects(state.service.claim(claimInput(state, { worker_id: "worker_b" })), /active transcription lease/);

  const events = await state.events.listEvents({ stream_id: `capture-block:${state.block.id}`, order: "asc", limit: 20 });
  assert.equal(events.filter((event) => event.payload?.to_state === "transcribing").length, 1);
});

test("worker reads retained audio only after claim and stores one immutable literal result", async (t) => {
  const state = await harness(t);
  const before = fs.readFileSync(state.audioNotes.audioPath(state.note.id));
  let observedClaim = null;
  const wrappedNotes = {
    async stream(id) {
      observedClaim = await state.captureBlocks.get(state.block.id);
      return state.audioNotes.stream(id);
    },
  };
  let providerCalls = 0;
  const worker = createAudioCaptureTranscriptionWorker({
    service: state.service,
    audioNotes: wrappedNotes,
    workerId: "worker_a",
    languageProfileForBlock: () => ({ version: "profile-7", languages: ["en-US"], primary: "en-US" }),
    providerIdForBlock: () => "chirp",
    transcriberForClaim: (claim) => ({
      async transcribe({ audio }) {
        providerCalls += 1;
        assert.equal(claim.audio_note_id, state.note.id);
        assert.equal(audio.contentType.startsWith("audio/L16"), true);
        return {
          text: " literal words, exactly ",
          provider: { id: "chirp", model: "chirp_3", request_id: "req_1" },
          language_evidence: ["en-US"],
        };
      },
    }),
  });

  const completed = await worker.processBlock(state.block.id);
  assert.equal(observedClaim.processing_state, "transcribing");
  assert.equal(completed.processing_state, "transcribed");
  assert.equal(completed.transcript.literal, " literal words, exactly ");
  assert.equal(completed.transcript.provider.model, "chirp_3");
  assert.equal(providerCalls, 1);
  assert.deepEqual(fs.readFileSync(state.audioNotes.audioPath(state.note.id)), before);
  assert.equal(completed.audio.audio_note_id, state.note.id);
  assert.deepEqual(completed.transcript_revisions, []);
  assert.deepEqual(completed.dispatches, []);

  const duplicate = await state.service.complete({
    capture_block_id: state.block.id,
    claim_id: completed.last_claim_id,
    literal: " literal words, exactly ",
    provider: { id: "chirp", model: "chirp_3", request_id: "req_1" },
    language_evidence: ["en-US"],
  });
  assert.deepEqual(duplicate, completed);
  await assert.rejects(state.service.complete({
    capture_block_id: state.block.id, claim_id: completed.last_claim_id,
    literal: "conflicting replacement", provider: { id: "chirp" }, language_evidence: ["en-US"],
  }), /terminal result conflicts/);
});

test("an exact duplicate worker claim does not repeat provider work", async (t) => {
  const state = await harness(t);
  let calls = 0;
  const options = {
    service: state.service,
    audioNotes: state.audioNotes,
    workerId: "worker_same",
    languageProfileForBlock: () => ({ version: "profile-1", languages: ["en-US"], primary: "en-US" }),
    providerIdForBlock: () => "chirp",
    transcriberForClaim: () => ({ async transcribe() { calls += 1; return { text: "done" }; } }),
  };
  await state.service.claim({
    capture_block_id: state.block.id, worker_id: "worker_same", provider_id: "chirp",
    language_profile: { version: "profile-1", languages: ["en-US"], primary: "en-US" },
  });
  const unchanged = await createAudioCaptureTranscriptionWorker(options).processBlock(state.block.id);
  assert.equal(unchanged.processing_state, "transcribing");
  assert.equal(calls, 0);
});

test("provider failure preserves audio and retry advances the bounded attempt", async (t) => {
  const state = await harness(t);
  const before = fs.readFileSync(state.audioNotes.audioPath(state.note.id));
  const firstWorker = createAudioCaptureTranscriptionWorker({
    service: state.service,
    audioNotes: state.audioNotes,
    workerId: "worker_a",
    languageProfileForBlock: () => ({ version: "profile-1", languages: ["am-ET"], primary: "am-ET" }),
    providerIdForBlock: () => "chirp",
    transcriberForClaim: () => ({ async transcribe() { throw new Error("provider socket unavailable\nsecret omitted"); } }),
  });
  const failed = await firstWorker.processBlock(state.block.id);
  assert.equal(failed.processing_state, "failed");
  assert.equal(failed.failure.retryable, true);
  assert.equal(failed.failure.message.includes("\n"), false);
  assert.deepEqual(fs.readFileSync(state.audioNotes.audioPath(state.note.id)), before);

  const queued = await state.service.retry({ capture_block_id: state.block.id });
  assert.equal(queued.processing_state, "queued");
  assert.equal(queued.retry_count, 1);
  const retryAgain = await state.service.retry({ capture_block_id: state.block.id });
  assert.deepEqual(retryAgain, queued);

  const claim = await state.service.claim(claimInput(state));
  assert.equal(claim.claim.attempt, 1);
  const complete = await state.service.complete({
    capture_block_id: state.block.id, claim_id: claim.claim.id, literal: "recovered words",
    provider: { id: "chirp" }, language_evidence: ["am-ET"],
  });
  assert.equal(complete.processing_state, "transcribed");
  assert.equal(complete.retry_count, 1);
  assert.equal(complete.processing_events.map((event) => `${event.from_state}->${event.to_state}`).join(","),
    "null->queued,queued->transcribing,transcribing->failed,failed->queued,queued->transcribing,transcribing->transcribed");
});

test("expired leases recover on the next worker with a new attempt", async (t) => {
  const state = await harness(t);
  const first = await state.service.claim(claimInput(state));
  state.advance(1_001);
  const recovered = await state.service.claim(claimInput(state, { worker_id: "worker_b" }));
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.claim.attempt, 1);
  assert.notEqual(recovered.claim.id, first.claim.id);
  const block = await state.captureBlocks.get(state.block.id);
  assert.deepEqual(block.processing_events.slice(-3).map((event) => event.to_state), ["failed", "queued", "transcribing"]);
  assert.equal(block.processing_events.at(-3).failure.code, "lease_expired");
});

test("the production lease fence outlasts the bounded five-minute capture window", async (t) => {
  const state = await harness(t, { leaseMs: 15 * 60_000 });
  await state.service.claim(claimInput(state));
  state.advance(5 * 60_000 + 1);
  await assert.rejects(
    state.service.claim(claimInput(state, { worker_id: "worker_b" })),
    /active transcription lease/,
  );
  state.advance(10 * 60_000);
  const recovered = await state.service.claim(claimInput(state, { worker_id: "worker_b" }));
  assert.equal(recovered.claim.attempt, 1);
});

test("completion fencing errors are not rewritten as provider failures", async () => {
  let failCalls = 0;
  const service = {
    async claim() {
      return { claimed: true, claim: {
        id: "claim_1", audio_note_id: "note_1", provider_id: "chirp",
        language_profile: { languages: ["en-US"] },
      } };
    },
    async complete() { throw new Error("transcription claim is not current"); },
    async fail() { failCalls += 1; },
  };
  const worker = createAudioCaptureTranscriptionWorker({
    service,
    audioNotes: { async stream() { return { contentType: "audio/L16", stream: null }; } },
    transcriberForClaim: () => ({ async transcribe() { return { text: "done" }; } }),
    providerIdForBlock: () => "chirp",
  });
  await assert.rejects(worker.processBlock(`cap_${"a".repeat(64)}`), /claim is not current/);
  assert.equal(failCalls, 0);
});

test("terminal transitions reject stale claims and retry stops at the configured bound", async (t) => {
  const state = await harness(t, { maxAttempts: 1 });
  await assert.rejects(state.service.retry({ capture_block_id: state.block.id }), /not in failed/);
  const claim = await state.service.claim(claimInput(state));
  const failed = await state.service.fail({
    capture_block_id: state.block.id, claim_id: claim.claim.id,
    code: "bad_audio", message: "not usable", retryable: true,
  });
  assert.equal(failed.failure.retryable, false);
  const duplicate = await state.service.fail({
    capture_block_id: state.block.id, claim_id: claim.claim.id,
    code: "bad_audio", message: "not usable", retryable: true,
  });
  assert.deepEqual(duplicate, failed);
  await assert.rejects(state.service.fail({
    capture_block_id: state.block.id, claim_id: claim.claim.id,
    code: "different", message: "different", retryable: false,
  }), /terminal result conflicts/);
  await assert.rejects(state.service.retry({ capture_block_id: state.block.id }), /no retry attempts/);
  await assert.rejects(state.service.complete({
    capture_block_id: state.block.id, claim_id: "claim_stale", literal: "wrong",
  }), /claim is not current/);
});

test("worker dependencies and language profiles fail closed", async (t) => {
  const state = await harness(t);
  assert.throws(() => createAudioCaptureTranscriptionWorker(), /requires service/);
  await assert.rejects(state.service.claim(claimInput(state, { language_profile: { languages: [] } })), /languages is required/);
  await assert.rejects(state.service.claim(claimInput(state, {
    language_profile: { languages: ["en-US"], primary: "am-ET" },
  })), /primary must be in languages/);
});

test("configuration, missing blocks, and non-audio blocks fail closed", async () => {
  assert.throws(() => createAudioCaptureTranscriptionService(), /requires locked events/);
  const events = { appendEvent() {}, withStreamLock(_id, fn) { return fn(); } };
  assert.throws(() => createAudioCaptureTranscriptionService({
    events, captureBlocks: { get() {} }, leaseMs: 999,
  }), /lease_ms/);
  assert.throws(() => createAudioCaptureTranscriptionService({
    events, captureBlocks: { get() {} }, maxAttempts: 0,
  }), /max_attempts/);
  const missing = createAudioCaptureTranscriptionService({
    events, captureBlocks: { async get() { return null; } },
  });
  await assert.rejects(missing.claim({
    capture_block_id: `cap_${"a".repeat(64)}`, worker_id: "w", provider_id: "p",
    language_profile: { languages: ["en-US"] },
  }), /not found/);
  const wrongKind = createAudioCaptureTranscriptionService({
    events, captureBlocks: { async get() { return { schema_version: 1, source: {} }; } },
  });
  await assert.rejects(wrongKind.claim({
    capture_block_id: `cap_${"a".repeat(64)}`, worker_id: "w", provider_id: "p",
    language_profile: { languages: ["en-US"] },
  }), /not audio-note backed/);
});

test("worker records unavailable audio and provider as retryable failures", async (t) => {
  let state = await harness(t);
  let worker = createAudioCaptureTranscriptionWorker({
    service: state.service, audioNotes: { async stream() { return null; } },
    transcriberForClaim: () => ({ async transcribe() { throw new Error("must not run"); } }),
    providerRegistry: { selected_providers: { stt: "chirp" } },
  });
  let failed = await worker.processBlock(state.block.id);
  assert.equal(failed.failure.code, "audio_unavailable");

  state = await harness(t);
  worker = createAudioCaptureTranscriptionWorker({
    service: state.service, audioNotes: state.audioNotes, transcriberForClaim: () => null,
    providerRegistry: { selected_providers: { stt: "chirp" } },
  });
  failed = await worker.processBlock(state.block.id);
  assert.equal(failed.failure.code, "provider_unavailable");
  assert.equal(failed.failure.retryable, false);
  assert.equal(failed.processing_events[1].claim.provider_id, "chirp");
  assert.deepEqual(failed.processing_events[1].claim.language_profile.languages, ["en-US"]);
});

test("worker provider selection consumes the existing registry projection", () => {
  assert.equal(selectedSttProviderId({ selected_providers: { stt: "chirp" } }), "chirp");
  assert.throws(() => selectedSttProviderId({ selected_providers: {} }), /provider is unavailable/);
  assert.throws(() => selectedSttProviderId({ selected_providers: { stt: "bad provider" } }), /provider_id is invalid/);
});

test("literal, token, clock, and terminal state validation is bounded", async (t) => {
  const state = await harness(t);
  await assert.rejects(state.service.claim(claimInput(state, { worker_id: "bad worker" })), /worker_id is invalid/);
  const claim = await state.service.claim(claimInput(state));
  await assert.rejects(state.service.retry({ capture_block_id: state.block.id }), /not in failed/);
  await assert.rejects(state.service.complete({
    capture_block_id: state.block.id, claim_id: claim.claim.id, literal: " ",
  }), /literal transcript is required/);
  await assert.rejects(state.service.complete({
    capture_block_id: state.block.id, claim_id: claim.claim.id, literal: "x".repeat(1024 * 1024 + 1),
  }), /literal transcript exceeds/);
  const complete = await state.service.complete({
    capture_block_id: state.block.id, claim_id: claim.claim.id, literal: "done",
    provider: [], language_evidence: "not-a-list",
  });
  assert.deepEqual(complete.transcript.provider, { id: "", model: "", request_id: "" });
  await assert.rejects(state.service.claim(claimInput(state)), /not queued/);

  const invalidClock = createAudioCaptureTranscriptionService({
    events: state.events, captureBlocks: state.captureBlocks, clock: () => "invalid",
  });
  const other = await harness(t);
  const otherInvalidClock = createAudioCaptureTranscriptionService({
    events: other.events, captureBlocks: other.captureBlocks, clock: () => "invalid",
  });
  await assert.rejects(otherInvalidClock.claim(claimInput(other)), /clock returned an invalid date/);
  assert.equal(invalidClock.max_attempts, 3);
});
