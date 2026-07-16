"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TranscriptSidecarVoiceProvider, mergeTranscriptSidecar } = require("../lib/voice-provider-composition");

function providers(overrides = {}) {
  const calls = { process: [], live: [], synthesize: [], stream: [], stt: [] };
  const primary = {
    status: () => ({ provider: "native", selected_providers: { native_live: "native" } }),
    processTurn: (...args) => { calls.process.push(args); return "processed"; },
    createLiveTurnSession: (turn, hooks) => { calls.live.push({ turn, hooks }); return { turn, hooks }; },
    synthesizeAssistantSpeech: (...args) => { calls.synthesize.push(args); return "audio"; },
    ...overrides.primary,
  };
  const sidecar = {
    status: () => ({ provider: "chirp", configured: true, model: "chirp-3", language_codes: ["auto"], prompt_language_codes: ["en-US"], voice_stt: { streaming_recognition: true } }),
    createStreamingSttSession: (turn, hooks) => { calls.stream.push({ turn, hooks }); return { id: "stream" }; },
    runSttStage: (turn, languages) => { calls.stt.push({ turn, languages }); return { text: "final" }; },
    sttLanguageCodes: () => ["en-US", "am-ET"],
    ...overrides.sidecar,
  };
  return { primary, sidecar, calls };
}

test("status merges primary evidence with bounded sidecar diagnostics", () => {
  const full = providers();
  const provider = new TranscriptSidecarVoiceProvider(full.primary, full.sidecar, "sidecar-id");
  assert.deepEqual(provider.status(), {
    provider: "native",
    selected_providers: { native_live: "native", transcript_sidecar: "sidecar-id" },
    transcript_sidecar: {
      enabled: true, provider: "chirp", configured: true, model: "chirp-3",
      language_codes: ["auto"], prompt_language_codes: ["en-US"], streaming: true,
    },
  });

  const sparse = providers({
    primary: { status: () => ({ provider: "native" }) },
    sidecar: { status: () => ({ configured: false, model: "", language_codes: "en-US", voice_stt: {} }) },
  });
  assert.deepEqual(new TranscriptSidecarVoiceProvider(sparse.primary, sparse.sidecar, "fallback").status().transcript_sidecar, {
    enabled: true, provider: "fallback", configured: false, model: null,
    language_codes: [], prompt_language_codes: [], streaming: false,
  });
});

test("primary processing and optional synthesis delegate exactly", () => {
  const h = providers();
  const provider = new TranscriptSidecarVoiceProvider(h.primary, h.sidecar, "chirp");
  const turn = {};
  const hooks = {};
  assert.equal(provider.processTurn(turn, hooks), "processed");
  assert.equal(provider.synthesizeAssistantSpeech("hello", { voice: "x" }), "audio");
  assert.deepEqual(h.calls.process[0], [turn, hooks]);
  assert.deepEqual(h.calls.synthesize[0], ["hello", { voice: "x" }]);

  const noSynthesis = providers({ primary: { synthesizeAssistantSpeech: null } });
  assert.equal("synthesizeAssistantSpeech" in new TranscriptSidecarVoiceProvider(noSynthesis.primary, noSynthesis.sidecar, "chirp"), false);
});

test("native partial transcripts are visible only before sidecar stream ownership", async () => {
  const h = providers();
  const provider = new TranscriptSidecarVoiceProvider(h.primary, h.sidecar, "chirp");
  const turn = {};
  const partials = [];
  const live = provider.createLiveTurnSession(turn, { onTranscriptPartial: async (text) => partials.push(text), other: true });
  await live.hooks.onTranscriptPartial("native-before");
  const stream = provider.createStreamingSttSession(turn, { event: true });
  assert.deepEqual(stream, { id: "stream" });
  await live.hooks.onTranscriptPartial("native-after");
  assert.deepEqual(partials, ["native-before"]);
  assert.equal(h.calls.stream[0].turn, turn);
});

test("missing sidecar stream and finalize capabilities return null", () => {
  const h = providers({ sidecar: { createStreamingSttSession: null, runSttStage: null } });
  const provider = new TranscriptSidecarVoiceProvider(h.primary, h.sidecar, "chirp");
  assert.equal(provider.createStreamingSttSession({}, {}), null);
  assert.equal(provider.finalizeStreamingSttSession({}), null);
});

test("sidecar finalization delegates language codes", () => {
  const h = providers();
  const provider = new TranscriptSidecarVoiceProvider(h.primary, h.sidecar, "chirp");
  const turn = {};
  assert.deepEqual(provider.finalizeStreamingSttSession(turn), { text: "final" });
  assert.deepEqual(h.calls.stt[0], { turn, languages: ["en-US", "am-ET"] });
});

test("merge ignores turns without owned sidecar streams", async () => {
  const original = { transcript: "native" };
  let finalized = 0;
  const options = { providerResult: original, provider: "chirp", finalize: async () => { finalized += 1; }, record: async () => {}, cleanError: String };
  assert.equal(await mergeTranscriptSidecar({ ...options, turn: null }), original);
  assert.equal(await mergeTranscriptSidecar({ ...options, turn: { sttStreamRole: "native", sttStream: {} } }), original);
  assert.equal(await mergeTranscriptSidecar({ ...options, turn: { sttStreamRole: "transcript_sidecar", sttStream: null } }), original);
  assert.equal(finalized, 0);
});

test("empty sidecar transcript records fallback and clears stream", async () => {
  const turn = { sttStreamRole: "transcript_sidecar", sttStream: {} };
  const records = [];
  const original = { transcript: "native" };
  const result = await mergeTranscriptSidecar({
    turn, providerResult: original, provider: "chirp", finalize: async () => ({ text: "  " }),
    record: async (...args) => records.push(args), cleanError: (error) => error.message,
  });
  assert.equal(result, original);
  assert.equal(turn.sttStream, null);
  assert.deepEqual(records, [["transcript_sidecar_fallback", { provider: "chirp", reason: "empty_transcript" }]]);
});

test("final sidecar transcript replaces native text while preserving evidence", async () => {
  const turn = { sttStreamRole: "transcript_sidecar", sttStream: {} };
  const records = [];
  const result = await mergeTranscriptSidecar({
    turn, providerResult: { transcript: " native text ", other: 1 }, provider: "chirp",
    finalize: async () => ({ text: " sidecar text " }), record: async (...args) => records.push(args), cleanError: String,
  });
  assert.deepEqual(result, {
    transcript: "sidecar text", other: 1, transcript_source: "stt_sidecar",
    transcript_provider: "chirp", native_input_transcript: "native text",
  });
  assert.deepEqual(records[0], ["transcript_sidecar_final", { provider: "chirp", transcript_chars: 12, native_transcript_chars: 11 }]);

  const noNative = await mergeTranscriptSidecar({
    turn: { sttStreamRole: "transcript_sidecar", sttStream: {} }, providerResult: null,
    provider: "chirp", finalize: async () => ({ text: "text" }), record: async () => {}, cleanError: String,
  });
  assert.equal(noNative.native_input_transcript, "");
});

test("sidecar errors clear ownership and record bounded failure evidence", async () => {
  const turn = { sttStreamRole: "transcript_sidecar", sttStream: {} };
  const records = [];
  const original = { transcript: "native" };
  const result = await mergeTranscriptSidecar({
    turn, providerResult: original, provider: "chirp", finalize: async () => { throw new Error("socket closed"); },
    record: async (...args) => records.push(args), cleanError: (error) => `clean:${error.message}`,
  });
  assert.equal(result, original);
  assert.equal(turn.sttStream, null);
  assert.deepEqual(records[0], ["transcript_sidecar_fallback", {
    provider: "chirp", reason: "sidecar_error", error_summary: "clean:socket closed",
  }]);
});
