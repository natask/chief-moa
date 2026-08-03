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
} = require("../lib/audio-capture-transcription");
const { createAudioCaptureTranscriptionHost } = require("../lib/audio-capture-transcription-host");
const { createAudioCaptureSttProvider } = require("../lib/audio-capture-stt-provider");

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-capture-host-integration-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const audioNotes = createAudioNotesStore({ dataDir });
  const events = createEventSubstrateStore({ dataDir, originId: "capture-host-integration" });
  const captureBlocks = createCaptureBlockStore({ events });
  const capture = createAudioCaptureBlockService({ events, audioNotes, captureBlocks });
  let now = Date.parse("2026-08-03T15:00:00.000Z");
  const service = createAudioCaptureTranscriptionService({
    events, captureBlocks, leaseMs: 1_000, clock: () => new Date(now),
  });
  let providerCalls = 0;
  const provider = createAudioCaptureSttProvider({
    env: { CAPTURE_TRANSCRIPTION_STT_PROVIDER: "chirp" },
    registryFactory: () => ({
      selected_providers: { stt: "chirp" },
      providers: { stt: [{ id: "chirp", configured: true }] },
    }),
    providerFactory: () => ({
      model: "fake-chirp",
      async transcribePcmBuffer(bytes, sampleRate, channels, languages) {
        providerCalls += 1;
        assert.equal(sampleRate, 16000);
        assert.equal(channels, 1);
        assert.deepEqual(languages, ["en-US", "am-ET"]);
        return { text: `literal-${bytes.toString("hex")}` };
      },
    }),
  });
  async function createBlock(suffix) {
    const note = audioNotes.create({
      bytes: Buffer.from([1, 0, 2, 0]),
      content_type: "audio/L16; rate=16000; channels=1",
      surface: "browser", session_id: `session_${suffix}`,
    });
    const block = await capture.create({
      audio_note_id: note.id, owner_id: "usr_owner", idempotency_key: `create_${suffix}`,
      source: { surface: note.surface, session_id: note.session_id },
    });
    return { note, block };
  }
  function worker(workerId) {
    return createAudioCaptureTranscriptionWorker({
      service, audioNotes, workerId,
      providerIdForBlock: provider.requireProviderId,
      transcriberForClaim: provider.transcriberForClaim,
      languageProfileForBlock: () => ({
        version: "profile-1", languages: ["en-US", "am-ET"], primary: "en-US",
      }),
    });
  }
  function host(workerId) {
    return createAudioCaptureTranscriptionHost({
      captureBlocks, processBlock: worker(workerId).processBlock, enabled: true,
      workerId, clock: () => new Date(now), pollIntervalMs: 60_000,
    });
  }
  return {
    audioNotes, captureBlocks, service, createBlock, host,
    providerCalls: () => providerCalls,
    advance(ms) { now += ms; },
  };
}

test("stored-audio creation stays provider-free until the background host polls", async (t) => {
  const state = await setup(t);
  const { note, block } = await state.createBlock("queued");
  const original = fs.readFileSync(state.audioNotes.audioPath(note.id));
  assert.equal(state.providerCalls(), 0);
  assert.equal((await state.captureBlocks.get(block.id)).processing_state, "queued");

  const host = state.host("worker_async");
  await host.poll();
  const completed = await waitForBlock(state.captureBlocks, block.id, "transcribed");
  assert.equal(state.providerCalls(), 1);
  assert.equal(completed.transcript.provider.id, "chirp");
  assert.deepEqual(fs.readFileSync(state.audioNotes.audioPath(note.id)), original);
  await host.stop();
});

test("a replacement host recovers an expired durable lease after restart", async (t) => {
  const state = await setup(t);
  const { block } = await state.createBlock("restart");
  await state.service.claim({
    capture_block_id: block.id,
    worker_id: "worker_dead",
    provider_id: "chirp",
    language_profile: { version: "profile-1", languages: ["en-US", "am-ET"], primary: "en-US" },
  });
  state.advance(1_001);

  const replacement = state.host("worker_restarted");
  await replacement.poll();
  const completed = await waitForBlock(state.captureBlocks, block.id, "transcribed");
  assert.equal(state.providerCalls(), 1);
  assert.equal(completed.retry_count, 1);
  assert.deepEqual(completed.processing_events.slice(-3).map((event) => event.to_state),
    ["failed", "queued", "transcribing"].concat("transcribed").slice(-3));
  assert.equal(completed.processing_events.some((event) => event.failure?.code === "lease_expired"), true);
  await replacement.stop();
});

async function waitForBlock(store, id, state) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const block = await store.get(id);
    if (block?.processing_state === state) return block;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`capture block did not reach ${state}`);
}
