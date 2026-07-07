#!/usr/bin/env node
"use strict";

// Smoke for the cascaded voice pipeline: Chirp 3 STT -> gateway LLM turn -> Cloud
// TTS reply audio, driven through the SAME processTurn(turn, hooks) contract the
// native Gemini Live path uses. No real GCP calls: fetch is stubbed to answer the
// Chirp recognize and Cloud TTS synthesize endpoints, and the reasoner is a local
// stub standing in for the gateway's durable LLM turn.
//
// Asserts:
//   1. en-US cascade: STT transcript -> reasoner reply -> hosted TTS audio streamed
//      through onAssistantAudioStart/sendAudio/onAssistantAudioDone; result is not
//      transcription_only and tts_spoke=true.
//   2. am-ET cascade: Cloud TTS has no Amharic voice, so no hosted audio is
//      streamed (tts_spoke=false) but the reply text is still returned for the
//      device to speak. The STT leg still restricts to {en-US, am-ET} + chirp_3.
//   3. STT-only (no reasoner) stays transcription_only=true and streams no audio.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const {
  createVoiceProvider,
  generatePcm16Tone,
  reportVoiceStreamingFault,
  resetVoiceStreamingBreakerForTests,
  voiceStreamingTripped,
} = require(path.join(GATEWAY_DIR, "lib", "voice-providers"));
const { createSpeakStreamSanitizer } = require(path.join(GATEWAY_DIR, "lib", "voice-chunker"));
const { VoiceSessionConnection } = require(path.join(GATEWAY_DIR, "lib", "voice-session-server"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const previousFetch = global.fetch;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-cascaded-smoke-"));
  try {
    await enUsCascade(tempDir);
    await amEtFallback(tempDir);
    await geminiTtsAmEtCascade(tempDir);
    await perSessionVoiceOverride(tempDir);
    await sttOnlyUnchanged(tempDir);
    await profileDerivedSttLanguages(tempDir);
    await sttPrimaryFollowsProfilePrimary(tempDir);
    await turnDoneCarriesCascadedMetadata(tempDir);
    await errorContractEmitsTurnDoneAndCanonicalRecord(tempDir);
    await closedLiveTurnIgnoresLateProviderCompletion(tempDir);
    await responseModalityTextSkipsTts(tempDir);
    await ttsErrorSurfacedOnResult(tempDir);
    await spokenProfileControlConfirmation(tempDir);
    await expressiveTtsRequestShape(tempDir);
    await turnProgressDuringStalledReasoner(tempDir);
    await turnProgressStopsAfterCancel(tempDir);
    await turnProgressStopsAfterClose(tempDir);
    await streamingMultiFrameWireOrder(tempDir);
    await streamingSynthesisBodiesInSentenceOrder(tempDir);
    await streamingMidStreamTtsFailure(tempDir);
    await streamingInterruptionGoesSilent(tempDir);
    await streamingNullStreamGuard(tempDir);
    await streamingCircuitBreakerLatches(tempDir);
    await streamingCapPrefixProperty(tempDir);
    await streamingKillSwitchReproducesOldSequence(tempDir);
    console.log("smoke-cascaded-voice: ok");
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function profileDerivedSttLanguages(tempDir) {
  const calls = [];
  stubFetch({ sttTranscript: "selam", calls });

  const provider = createVoiceProvider({
    env: {
      VOICE_PROVIDER: "chirp",
      GCP_PROJECT_ID: "test-project",
      CHIRP_ACCESS_TOKEN: "test-token",
      CHIRP_MODEL: "chirp_3",
      CHIRP_LANGUAGE_CODES: "en-US,am-ET",
    },
    agentProfile: {
      effective: () => ({
        input_languages: "am-ET",
        input_language_primary: "am-ET",
        language: "en-US",
        language_primary: "en-US",
      }),
    },
  });

  assert.deepEqual(provider.status().language_codes, ["am-ET"], "profile input_languages must override env for Chirp STT");
  const events = [];
  await provider.processTurn(makeTurn(tempDir, "profile-am"), recordingHooks(events));
  const sttCall = calls.find((c) => c.kind === "stt");
  assert.deepEqual(sttCall.body.config.languageCodes, ["am-ET"], "recognize request must be restricted to profile input language");
}

// Explicit switching ("right now I want to speak X"): the recognizer is
// constrained to EXACTLY the stored understood set, and input_language_primary
// reorders it so the chosen language leads. Same two-language set, different
// leading code, driven only by the profile.
async function sttPrimaryFollowsProfilePrimary(tempDir) {
  const makeProvider = (inputPrimary) => createVoiceProvider({
    env: {
      VOICE_PROVIDER: "chirp",
      GCP_PROJECT_ID: "test-project",
      CHIRP_ACCESS_TOKEN: "test-token",
      CHIRP_MODEL: "chirp_3",
      CHIRP_LANGUAGE_CODES: "en-US,am-ET",
    },
    agentProfile: {
      effective: () => ({
        input_languages: "en-US,am-ET",
        input_language_primary: inputPrimary,
        language: "en-US",
        language_primary: "en-US",
      }),
    },
  });

  const englishLead = makeProvider("en-US");
  assert.deepEqual(
    englishLead.status().language_codes,
    ["en-US", "am-ET"],
    "with en-US primary, the constrained set must lead with en-US",
  );

  // "right now I want to speak Amharic": the model set input_language_primary to
  // am-ET (already in the set); the recognizer now leads with am-ET, same set.
  const amharicLead = makeProvider("am-ET");
  assert.deepEqual(
    amharicLead.status().language_codes,
    ["am-ET", "en-US"],
    "with am-ET primary, the same constrained set must lead with am-ET",
  );

  const calls = [];
  stubFetch({ sttTranscript: "selam", calls });
  const events = [];
  await amharicLead.processTurn(makeTurn(tempDir, "primary-reorder"), recordingHooks(events));
  const sttCall = calls.find((c) => c.kind === "stt");
  assert.deepEqual(
    sttCall.body.config.languageCodes,
    ["am-ET", "en-US"],
    "recognize request must lead with the profile's understood primary",
  );
}

async function turnDoneCarriesCascadedMetadata(tempDir) {
  const provider = {
    status: () => ({
      provider: "chirp-cascaded",
      model: "test-model",
      configured: true,
      language_codes: ["am-ET"],
      assistant_audio_format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    }),
    async processTurn(_turn, hooks) {
      await hooks.onTranscriptFinal("selam");
      await hooks.onAssistantText("ሰላም");
      return {
        provider: "chirp-cascaded",
        model: "test-model",
        transcript: "selam",
        assistant_text: "ሰላም",
        audio_format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
        transcription_only: false,
        tts_spoke: false,
        reply_language: "am-ET",
      };
    },
  };
  const outcome = await driveVoiceSession(tempDir, "metadata", provider);
  const done = outcome.events.find((event) => event.type === "turn_done");
  assert.equal(done.status, "completed");
  assert.equal(done.tts_spoke, false, "completed cascaded turn_done must expose tts_spoke=false");
  assert.equal(done.reply_language, "am-ET", "completed cascaded turn_done must expose reply_language");
}

async function errorContractEmitsTurnDoneAndCanonicalRecord(tempDir) {
  const provider = {
    status: () => ({
      provider: "chirp-cascaded",
      model: "test-model",
      configured: true,
      language_codes: ["en-US"],
      assistant_audio_format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    }),
    async processTurn() {
      throw new Error("simulated provider failure");
    },
  };
  const records = [];
  const outcome = await driveVoiceSession(tempDir, "error", provider, records);
  assert.ok(outcome.events.some((event) => event.type === "error"), "error event must still be emitted");
  const done = outcome.events.find((event) => event.type === "turn_done");
  assert.equal(done.status, "error", "provider failure must end with turn_done status=error");
  assert.equal(done.reason, "processing_error");
  assert.equal(records.length, 1, "error turn with captured audio must record an incomplete canonical turn");
  assert.equal(records[0].status, "error");
  assert.equal(records[0].incomplete, true);
}

async function closedLiveTurnIgnoresLateProviderCompletion(tempDir) {
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const provider = {
    status: () => ({
      provider: "gemini-live",
      model: "test-live",
      configured: true,
      assistant_audio_format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    }),
    createLiveTurnSession(_turn, hooks) {
      return {
        done,
        sendAudio() {
          void hooks.onTranscriptPartial("interrupted partial transcript");
          void hooks.onAssistantText("interrupted partial reply");
        },
        cancel() {
          resolveDone({
            provider: "gemini-live",
            model: "test-live",
            transcript: "late transcript",
            assistant_text: "late reply",
            audio_format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
          });
        },
      };
    },
  };
  const records = [];
  const dataDir = path.join(tempDir, "session-closed-live");
  const sessionsDir = path.join(dataDir, "voice-sessions");
  const providerEventsFile = path.join(dataDir, "voice-provider-events.jsonl");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const events = [];
  const connection = new VoiceSessionConnection(fakeWs(events), {
    request: {},
    sessionsDir,
    providerEventsFile,
    voiceProvider: provider,
    onTurnCompleted: async (record) => {
      records.push(record);
      return record;
    },
  });

  await connection.handleSessionStart({
    type: "session_start",
    session_id: "sess_closed_live",
    turn_id: "turn_closed_live",
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
  });
  connection.handleAudio(generatePcm16Tone({ durationMs: 40, frequencyHz: 260, sampleRate: 16000, volume: 0.2 }));
  await connection.closeCurrentTurn("closed");
  await Promise.resolve();

  assert.equal(records.length, 1, "closed live turn must be recorded once");
  assert.equal(records[0].status, "closed");
  assert.equal(records[0].incomplete, true);
  assert.equal(connection.turn, null, "closed live turn must be cleared");
  assert.ok(!events.some((event) => event.type === "turn_done" && event.status === "error"), "late provider completion must not emit error turn_done");
}

// Stub Chirp recognize + Cloud TTS synthesize. `sttTranscript` is what STT
// returns; `ttsOk` decides whether synthesize returns audio (it never should be
// reached for Amharic because the provider skips synthesis).
function stubFetch({ sttTranscript, calls }) {
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes(":recognize")) {
      calls.push({ kind: "stt", url: u, body: JSON.parse(String(options.body || "{}")) });
      return jsonResponse({ results: [{ alternatives: [{ transcript: sttTranscript }] }] });
    }
    if (u.includes("texttospeech.googleapis.com")) {
      calls.push({ kind: "tts", url: u, body: JSON.parse(String(options.body || "{}")) });
      return jsonResponse({ audioContent: wavBase64() });
    }
    throw new Error(`unexpected fetch to ${u}`);
  };
}

async function enUsCascade(tempDir) {
  const calls = [];
  stubFetch({ sttTranscript: "what time is it", calls });

  const provider = createVoiceProvider({
    env: {
      VOICE_PROVIDER: "chirp",
      VOICE_TTS_PROVIDER: "cloud-tts",
      GCP_PROJECT_ID: "test-project",
      CHIRP_ACCESS_TOKEN: "test-token",
      CHIRP_MODEL: "chirp_3",
      CHIRP_LANGUAGE_CODES: "en-US,am-ET",
    },
    reasoner: async ({ transcript }) => ({
      speak: `You said: ${transcript}.`,
      display: `You said: ${transcript}.`,
      language: "en-US",
      model: "test-model",
      classification: "chat",
    }),
  });

  const status = provider.status();
  assert.equal(status.pipeline, "cascaded", "en-US with cloud-tts must be cascaded");
  assert.equal(status.transcription_only, false, "cascaded status must not be transcription_only");
  assert.equal(status.tts_provider_id, "cloud-tts");

  const events = [];
  const hooks = recordingHooks(events);
  const result = await provider.processTurn(makeTurn(tempDir, "en"), hooks);

  assert.equal(result.provider, "chirp-cascaded");
  assert.equal(result.transcription_only, false);
  assert.equal(result.tts_spoke, true, "en-US reply must be spoken by hosted TTS");
  assert.equal(result.reply_language, "en-US");
  assert.equal(result.assistant_text, "You said: what time is it.");

  const kinds = events.map((e) => e.type);
  assert.deepEqual(
    kinds,
    ["transcript_final", "assistant_text", "assistant_audio_start", "audio", "assistant_audio_done"],
    `unexpected event order: ${kinds.join(",")}`,
  );
  assert.ok(events.find((e) => e.type === "audio").bytes > 0, "hosted TTS must stream audio bytes");
  assert.ok(calls.some((c) => c.kind === "tts"), "Cloud TTS synthesize must be called for en-US");
  // STT leg still restricts to the two configured languages + chirp_3.
  const sttCall = calls.find((c) => c.kind === "stt");
  assert.deepEqual(sttCall.body.config.languageCodes, ["en-US", "am-ET"]);
  assert.equal(sttCall.body.config.model, "chirp_3");
  assert.ok(sttCall.body.config.explicitDecodingConfig, "STT must use explicit decoding, not auto");
}

async function amEtFallback(tempDir) {
  const calls = [];
  stubFetch({ sttTranscript: "selam", calls });

  const provider = createVoiceProvider({
    env: {
      VOICE_PROVIDER: "chirp",
      VOICE_TTS_PROVIDER: "cloud-tts",
      GCP_PROJECT_ID: "test-project",
      CHIRP_ACCESS_TOKEN: "test-token",
      CHIRP_MODEL: "chirp_3",
      CHIRP_LANGUAGE_CODES: "am-ET,en-US",
    },
    reasoner: async () => ({
      speak: "ሰላም",
      display: "ሰላም",
      language: "am-ET",
      model: "test-model",
      classification: "chat",
    }),
  });

  const events = [];
  const result = await provider.processTurn(makeTurn(tempDir, "am"), recordingHooks(events));

  assert.equal(result.transcription_only, false, "cascaded reply is still a real reply");
  assert.equal(result.tts_spoke, false, "Amharic has no Cloud TTS voice; must not stream hosted audio");
  assert.equal(result.reply_language, "am-ET");
  assert.equal(result.assistant_text, "ሰላም", "reply text must survive for device-side TTS");

  const kinds = events.map((e) => e.type);
  assert.deepEqual(kinds, ["transcript_final", "assistant_text"], `Amharic must not emit audio events: ${kinds.join(",")}`);
  assert.ok(!calls.some((c) => c.kind === "tts"), "Cloud TTS must not be called for a language it cannot speak");
}

// Gemini 3.1 Flash TTS speaks Amharic, so the same am-ET turn that falls back
// to text-only on cloud-tts streams hosted reply audio on gemini-tts. The
// synthesize request must select the Gemini model via voice.modelName and pin
// the reply language.
async function geminiTtsAmEtCascade(tempDir) {
  const calls = [];
  stubFetch({ sttTranscript: "selam", calls });

  const provider = createVoiceProvider({
    env: {
      VOICE_PROVIDER: "chirp",
      VOICE_TTS_PROVIDER: "gemini-flash-tts", // alias must resolve to gemini-tts
      GCP_PROJECT_ID: "test-project",
      CHIRP_ACCESS_TOKEN: "test-token",
      CHIRP_MODEL: "chirp_3",
      CHIRP_LANGUAGE_CODES: "am-ET,en-US",
    },
    reasoner: async () => ({
      speak: "ሰላም",
      display: "ሰላም",
      language: "am-ET",
      model: "test-model",
      classification: "chat",
    }),
    agentProfile: {
      effective: () => ({
        voice: "Aoede", // persisted self-configured voice must win over the env default
        input_languages: "am-ET,en-US",
        input_language_primary: "am-ET",
        language: "am-ET",
        language_primary: "am-ET",
      }),
    },
  });

  const status = provider.status();
  assert.equal(status.pipeline, "cascaded", "gemini-tts must activate the cascaded pipeline");
  assert.equal(status.tts_provider_id, "gemini-tts", "gemini-flash-tts alias must resolve to gemini-tts");
  assert.equal(status.tts_model, "gemini-3.1-flash-tts-preview", "gemini-tts must default to the Gemini 3.1 Flash TTS model");

  const events = [];
  const result = await provider.processTurn(makeTurn(tempDir, "gemini-am"), recordingHooks(events));

  assert.equal(result.transcription_only, false);
  assert.equal(result.tts_spoke, true, "Gemini TTS speaks Amharic; hosted audio must stream");
  assert.equal(result.reply_language, "am-ET");
  assert.equal(result.assistant_text, "ሰላም");

  const kinds = events.map((e) => e.type);
  assert.deepEqual(
    kinds,
    ["transcript_final", "assistant_text", "assistant_audio_start", "audio", "assistant_audio_done"],
    `gemini-tts am-ET must stream hosted audio: ${kinds.join(",")}`,
  );

  const ttsCall = calls.find((c) => c.kind === "tts");
  assert.ok(ttsCall, "synthesize must be called");
  assert.equal(ttsCall.body.voice.modelName, "gemini-3.1-flash-tts-preview", "synthesize must select the Gemini TTS model via voice.modelName");
  assert.equal(ttsCall.body.voice.languageCode, "am-ET", "reply language must be pinned in the synthesize request");
  assert.equal(ttsCall.body.voice.name, "Aoede", "the persisted profile voice must win over the env/Kore default");
}

// A session_start `voice` override (a website pet speaking in its own voice)
// must drive the Gemini-TTS leg for THAT session only: every synthesize request
// carries the canonicalized override, a session with no override still speaks
// the persisted profile voice, and the stored profile is never mutated.
async function perSessionVoiceOverride(tempDir) {
  const agentProfile = {
    effective: () => ({
      voice: "Aoede",
      language: "en-US",
      language_primary: "en-US",
      input_languages: "en-US",
    }),
  };

  const reasonerInputs = [];
  const runSession = async (tag, sessionStartExtras) => {
    const calls = [];
    stubFetch({ sttTranscript: "hello pet", calls });
    const provider = createVoiceProvider({
      env: {
        VOICE_PROVIDER: "chirp",
        VOICE_TTS_PROVIDER: "gemini-tts",
        GCP_PROJECT_ID: "test-project",
        CHIRP_ACCESS_TOKEN: "test-token",
        CHIRP_MODEL: "chirp_3",
        CHIRP_LANGUAGE_CODES: "en-US",
      },
      reasoner: async (input) => {
        reasonerInputs.push(input);
        return {
          speak: `Hi! You said: ${input.transcript}.`,
          display: `Hi! You said: ${input.transcript}.`,
          language: "en-US",
          model: "test-model",
          classification: "chat",
        };
      },
      agentProfile,
    });
    const dataDir = path.join(tempDir, `voice-override-${tag}`);
    const sessionsDir = path.join(dataDir, "voice-sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const events = [];
    const connection = new VoiceSessionConnection(fakeWs(events), {
      request: {},
      sessionsDir,
      providerEventsFile: path.join(dataDir, "voice-provider-events.jsonl"),
      voiceProvider: provider,
      agentProfile,
      contextProvider: null,
      toolHandler: null,
      onTurnCompleted: null,
    });
    await connection.handleSessionStart({
      type: "session_start",
      session_id: `sess_voice_${tag}`,
      turn_id: `turn_voice_${tag}`,
      format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
      ...sessionStartExtras,
    });
    connection.handleAudio(generatePcm16Tone({ durationMs: 80, frequencyHz: 240, sampleRate: 16000, volume: 0.2 }));
    await connection.handleCommitTurn({ type: "commit_turn", turn_id: `turn_voice_${tag}` });
    return calls;
  };

  // Lowercase override exercises canonicalization (client voice lists are
  // lowercase) and must win over the profile's Aoede for this session. The
  // persona rides the same session_start and must reach the reasoner input
  // sanitized (control chars stripped, capped) for this session only.
  const overridden = await runSession("override", {
    voice: "puck",
    source: "website-pet-studio",
    persona: { name: "Shigmi  Scout", text: "A curious research scout.\n\nPeeks around edges." },
  });
  assert.equal(reasonerInputs.length, 1, "override session must run the reasoner once");
  assert.deepEqual(
    reasonerInputs[0].persona,
    { name: "Shigmi Scout", text: "A curious research scout. Peeks around edges." },
    "session_start persona must reach the reasoner sanitized",
  );
  const overriddenTts = overridden.filter((c) => c.kind === "tts");
  assert.ok(overriddenTts.length > 0, "override session must synthesize hosted audio");
  for (const call of overriddenTts) {
    assert.equal(call.body.voice.name, "Puck", "session_start voice override must reach every synthesize request");
  }

  // No override: unchanged behavior, the persisted profile voice speaks and
  // no persona reaches the reasoner.
  const defaulted = await runSession("default", {});
  const defaultedTts = defaulted.filter((c) => c.kind === "tts");
  assert.ok(defaultedTts.length > 0, "default session must synthesize hosted audio");
  for (const call of defaultedTts) {
    assert.equal(call.body.voice.name, "Aoede", "a session with no override must keep the profile voice");
  }
  assert.equal(reasonerInputs.length, 2, "default session must run the reasoner once");
  assert.equal(reasonerInputs[1].persona, undefined, "a session with no persona must not carry one");
  assert.equal(agentProfile.effective().voice, "Aoede", "a session override must not mutate the stored profile voice");
}

async function sttOnlyUnchanged(tempDir) {
  const calls = [];
  stubFetch({ sttTranscript: "hello", calls });

  // No reasoner and default android-tts => STT-only, unchanged legacy behavior.
  const provider = createVoiceProvider({
    env: {
      VOICE_PROVIDER: "chirp",
      GCP_PROJECT_ID: "test-project",
      CHIRP_ACCESS_TOKEN: "test-token",
      CHIRP_MODEL: "chirp_3",
      CHIRP_LANGUAGE_CODES: "en-US,am-ET",
    },
  });

  const status = provider.status();
  assert.equal(status.pipeline, "stt_only");
  assert.equal(status.transcription_only, true);

  const events = [];
  const result = await provider.processTurn(makeTurn(tempDir, "stt"), recordingHooks(events));
  assert.equal(result.transcription_only, true);
  assert.equal(result.assistant_text, "");
  assert.deepEqual(events.map((e) => e.type), ["transcript_final"], "STT-only must emit only the transcript");
  assert.ok(!calls.some((c) => c.kind === "tts"), "STT-only must not call TTS");
}

// response_modality:"text" deliberately delivers the reply as text: the cascaded
// provider must NOT call hosted TTS and must mark the turn modality:"text",
// distinct from tts_spoke=false caused by a synthesis failure.
async function responseModalityTextSkipsTts(tempDir) {
  const calls = [];
  stubFetch({ sttTranscript: "what time is it", calls });

  const provider = createVoiceProvider({
    env: {
      VOICE_PROVIDER: "chirp",
      VOICE_TTS_PROVIDER: "cloud-tts",
      GCP_PROJECT_ID: "test-project",
      CHIRP_ACCESS_TOKEN: "test-token",
      CHIRP_MODEL: "chirp_3",
      CHIRP_LANGUAGE_CODES: "en-US",
    },
    agentProfile: {
      effective: () => ({
        response_modality: "text",
        language: "en-US",
        language_primary: "en-US",
      }),
    },
    reasoner: async ({ transcript, response_modality }) => {
      assert.equal(response_modality, "text", "reasoner input must carry the current response_modality");
      return { speak: `You said: ${transcript}.`, display: `You said: ${transcript}.`, language: "en-US", model: "test-model", classification: "chat" };
    },
  });

  const events = [];
  const result = await provider.processTurn(makeTurn(tempDir, "modality-text"), recordingHooks(events));

  assert.equal(result.modality, "text", "text modality must be reported on the result");
  assert.equal(result.tts_spoke, false, "text modality must not stream hosted audio");
  assert.equal(result.tts_error, "", "a deliberate text turn is not a TTS failure");
  assert.equal(result.assistant_text, "You said: what time is it.", "reply text must still be returned for display");
  assert.deepEqual(events.map((e) => e.type), ["transcript_final", "assistant_text"], "text modality must emit no audio events");
  assert.ok(!calls.some((c) => c.kind === "tts"), "text modality must skip the TTS request entirely");
}

// A hosted-TTS synthesis failure must be observable: tts_spoke=false plus a short
// tts_error reason on the result, while the reply text still survives so the
// device can speak it. The turn must not fail.
async function ttsErrorSurfacedOnResult(tempDir) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes(":recognize")) {
      calls.push({ kind: "stt" });
      return jsonResponse({ results: [{ alternatives: [{ transcript: "hello there" }] }] });
    }
    if (u.includes("texttospeech.googleapis.com")) {
      calls.push({ kind: "tts" });
      return { ok: false, status: 500, json: async () => ({}), text: async () => "internal error" };
    }
    throw new Error(`unexpected fetch to ${u}`);
  };

  const provider = createVoiceProvider({
    env: {
      VOICE_PROVIDER: "chirp",
      VOICE_TTS_PROVIDER: "cloud-tts",
      GCP_PROJECT_ID: "test-project",
      CHIRP_ACCESS_TOKEN: "test-token",
      CHIRP_MODEL: "chirp_3",
      CHIRP_LANGUAGE_CODES: "en-US",
    },
    reasoner: async ({ transcript }) => ({
      speak: `You said: ${transcript}.`,
      display: `You said: ${transcript}.`,
      language: "en-US",
      model: "test-model",
      classification: "chat",
    }),
  });

  const events = [];
  const result = await provider.processTurn(makeTurn(tempDir, "tts-error"), recordingHooks(events));

  assert.equal(result.tts_spoke, false, "a failed synthesis must report tts_spoke=false");
  assert.ok(result.tts_error && result.tts_error.length > 0, "a failed synthesis must surface a tts_error reason");
  assert.equal(result.assistant_text, "You said: hello there.", "reply text must survive a TTS failure");
  assert.deepEqual(events.map((e) => e.type), ["transcript_final", "assistant_text"], "a TTS failure must emit no audio events");
  assert.ok(calls.some((c) => c.kind === "tts"), "synthesis must have been attempted");
}

// A voice assistant must speak its confirmations. A profile-control turn is
// classified non-chat, so the provider returns no spoken reply; the gateway
// produces the confirmation while applying the change, and the streaming server
// synthesizes it through the provider's synthesizeAssistantSpeech capability.
async function spokenProfileControlConfirmation(tempDir) {
  const confirmation = "Reply language set to Amharic.";
  let synthesizeCalledWith = null;
  const provider = {
    status: () => ({
      provider: "chirp-cascaded",
      model: "test-model",
      configured: true,
      language_codes: ["am-ET"],
      assistant_audio_format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    }),
    async processTurn(_turn, hooks) {
      await hooks.onTranscriptFinal("speak amharic");
      return {
        provider: "chirp-cascaded",
        model: "test-model",
        transcript: "speak amharic",
        assistant_text: "",
        audio_format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
        transcription_only: false,
        tts_spoke: false,
        reply_language: "am-ET",
        classification: "profile_control",
        modality: "auto",
        tts_error: "",
      };
    },
    async synthesizeAssistantSpeech(text, hooks, options) {
      synthesizeCalledWith = { text, options };
      await hooks.onAssistantAudioStart({ encoding: "pcm16", sample_rate: 16000, channels: 1 });
      await hooks.sendAudio(Buffer.from(generatePcm16Tone({ durationMs: 20, frequencyHz: 220, sampleRate: 16000, volume: 0.2 })));
      await hooks.onAssistantAudioDone();
      return { spoke: true, tts_error: "" };
    },
  };

  const dataDir = path.join(tempDir, "session-profile-confirm");
  const sessionsDir = path.join(dataDir, "voice-sessions");
  const providerEventsFile = path.join(dataDir, "voice-provider-events.jsonl");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const events = [];
  const connection = new VoiceSessionConnection(fakeWs(events), {
    request: {},
    sessionsDir,
    providerEventsFile,
    voiceProvider: provider,
    onTurnCompleted: async () => ({
      classification: "profile_control",
      response: {
        classification: "profile_control",
        display: confirmation,
        speak: confirmation,
        reply_language: "am-ET",
      },
    }),
  });

  await connection.handleSessionStart({
    type: "session_start",
    session_id: "sess_profile_confirm",
    turn_id: "turn_profile_confirm",
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
  });
  connection.handleAudio(generatePcm16Tone({ durationMs: 60, frequencyHz: 240, sampleRate: 16000, volume: 0.2 }));
  await connection.handleCommitTurn({ type: "commit_turn", turn_id: "turn_profile_confirm" });

  assert.ok(synthesizeCalledWith, "profile-control confirmation must be synthesized");
  assert.equal(synthesizeCalledWith.text, confirmation, "the gateway confirmation text must be spoken");
  const assistantText = events.find((e) => e.type === "assistant_text");
  assert.ok(assistantText && assistantText.text === confirmation, "confirmation must also be sent as assistant_text");
  const kinds = events.map((e) => e.type).filter((t) => ["assistant_audio_start", "binary", "assistant_audio_done", "turn_done"].includes(t));
  assert.deepEqual(kinds, ["assistant_audio_start", "binary", "assistant_audio_done", "turn_done"], `confirmation must stream hosted audio then finish: ${events.map((e) => e.type).join(",")}`);
  const done = events.find((e) => e.type === "turn_done");
  assert.equal(done.status, "completed");
  assert.equal(done.tts_spoke, true, "a spoken confirmation must report tts_spoke=true on turn_done");
}

// The Gemini-TTS leg carries expressive direction: the reasoner's clean reply is
// spoken/displayed, while its whitelisted inline tags feed input.text and its
// style prompt feeds input.prompt. The synthesize request must carry both, and
// the displayed assistant_text must stay clean.
async function expressiveTtsRequestShape(tempDir) {
  const calls = [];
  stubFetch({ sttTranscript: "how are you", calls });

  const provider = createVoiceProvider({
    env: {
      VOICE_PROVIDER: "chirp",
      VOICE_TTS_PROVIDER: "gemini-tts",
      GCP_PROJECT_ID: "test-project",
      CHIRP_ACCESS_TOKEN: "test-token",
      CHIRP_MODEL: "chirp_3",
      CHIRP_LANGUAGE_CODES: "en-US",
    },
    reasoner: async () => ({
      speak: "Sure thing.",
      display: "Sure thing.",
      tts_text: "[whispering] Sure thing.",
      tts_style: "warm, amused",
      language: "en-US",
      model: "test-model",
      classification: "chat",
    }),
  });

  const events = [];
  const result = await provider.processTurn(makeTurn(tempDir, "expressive"), recordingHooks(events));

  assert.equal(result.tts_spoke, true, "an expressive gemini-tts reply must stream hosted audio");
  assert.equal(result.assistant_text, "Sure thing.", "the displayed/stored transcript must be the clean reply, no tags");

  const ttsCall = calls.find((c) => c.kind === "tts");
  assert.ok(ttsCall, "synthesize must be called");
  assert.equal(ttsCall.body.input.prompt, "warm, amused", "the style prompt must ride input.prompt");
  assert.match(String(ttsCall.body.input.text || ""), /\[whispering\]/, "whitelisted inline tags must ride input.text");
  assert.equal(ttsCall.body.voice.modelName, "gemini-3.1-flash-tts-preview", "gemini-tts model must be selected");
}

// Keepalive contract: while a committed cascaded turn sits between
// transcript_final and turn_done with the reasoner (here, a stalled stub) running
// and no stream events, the session server must emit turn_progress ticks so a
// client watchdog does not tear the slow-but-healthy turn down. Ticks must stop
// at turn_done and never fire afterward.
async function turnProgressDuringStalledReasoner(tempDir) {
  const calls = [];
  stubFetch({ sttTranscript: "hello there", calls });

  const provider = createVoiceProvider({
    env: {
      VOICE_PROVIDER: "chirp",
      VOICE_TTS_PROVIDER: "cloud-tts",
      GCP_PROJECT_ID: "test-project",
      CHIRP_ACCESS_TOKEN: "test-token",
      CHIRP_MODEL: "chirp_3",
      CHIRP_LANGUAGE_CODES: "en-US",
    },
    reasoner: async ({ transcript }) => {
      // The reasoner stalls with no stream events — the exact window the client
      // watchdog would misread as a dead turn.
      await delayMs(120);
      return { speak: `You said: ${transcript}.`, display: `You said: ${transcript}.`, language: "en-US", model: "test-model", classification: "chat" };
    },
  });

  const { events } = await driveCascadedSessionWithProgress(tempDir, "progress-stall", provider, 20);
  const types = events.map((e) => e.type);
  const doneIndex = types.indexOf("turn_done");
  assert.ok(doneIndex >= 0, "a stalled cascaded turn must still finish with turn_done");
  assert.equal(events[doneIndex].status, "completed", "the stalled cascaded turn must complete");

  const progressIndexes = types.map((t, i) => (t === "turn_progress" ? i : -1)).filter((i) => i >= 0);
  assert.ok(progressIndexes.length >= 1, "at least one turn_progress must fire while the reasoner stalls");
  assert.ok(progressIndexes.every((i) => i < doneIndex), "every turn_progress must precede turn_done");
  for (const i of progressIndexes) {
    assert.equal(events[i].turn_id, "turn_progress-stall", "turn_progress must carry the turn id");
    assert.ok(["reasoning", "tts"].includes(events[i].stage), `turn_progress stage must be reasoning|tts, got ${events[i].stage}`);
  }
  const transcriptFinalIndex = types.indexOf("transcript_final");
  assert.ok(
    transcriptFinalIndex >= 0 && transcriptFinalIndex < progressIndexes[0],
    "turn_progress must only fill the gap AFTER transcript_final",
  );

  // Zero turn_progress after turn_done, even after a wait longer than the interval.
  const progressBefore = progressIndexes.length;
  await delayMs(80);
  const progressAfter = events.filter((e) => e.type === "turn_progress").length;
  assert.equal(progressAfter, progressBefore, "no turn_progress may fire after turn_done");
}

// A canceled turn must stop the keepalive. The Live path starts progress at commit;
// the provider here never returns (its done stays pending), so the parked commit
// never completes the turn and cancel_turn is the only terminal path. Ticks flow
// until cancel and none after.
async function turnProgressStopsAfterCancel(tempDir) {
  const { connection, events } = await setupHungLiveConnection(tempDir, "progress-cancel", 20);
  // Do NOT await: the committed Live turn parks forever on the hung provider done.
  connection.handleCommitTurn({ type: "commit_turn", turn_id: "turn_progress-cancel" }).catch(() => {});
  await delayMs(80);
  assert.ok(
    events.filter((e) => e.type === "turn_progress").length >= 1,
    "a hung committed Live turn must emit turn_progress keepalives",
  );

  await connection.handleCancelTurn({ type: "cancel_turn", turn_id: "turn_progress-cancel" });

  const types = events.map((e) => e.type);
  const doneIndex = types.indexOf("turn_done");
  assert.ok(doneIndex >= 0 && events[doneIndex].status === "canceled", "cancel must end the turn with turn_done canceled");
  const progressIndexes = types.map((t, i) => (t === "turn_progress" ? i : -1)).filter((i) => i >= 0);
  assert.ok(progressIndexes.every((i) => i < doneIndex), "every turn_progress must precede the cancel turn_done");

  const progressAfterCancel = events.filter((e) => e.type === "turn_progress").length;
  await delayMs(80);
  assert.equal(
    events.filter((e) => e.type === "turn_progress").length,
    progressAfterCancel,
    "no turn_progress may fire after cancel",
  );
}

// A closed socket must stop the keepalive too. closeCurrentTurn is the same path
// ws.on("close") drives; it records the incomplete turn and sends no turn_done, so
// the assertion is only that ticks stop and the turn is cleared.
async function turnProgressStopsAfterClose(tempDir) {
  const { connection, events } = await setupHungLiveConnection(tempDir, "progress-close", 20);
  connection.handleCommitTurn({ type: "commit_turn", turn_id: "turn_progress-close" }).catch(() => {});
  await delayMs(80);
  assert.ok(
    events.filter((e) => e.type === "turn_progress").length >= 1,
    "a hung committed Live turn must emit turn_progress before the socket closes",
  );

  await connection.closeCurrentTurn("closed");

  assert.equal(connection.turn, null, "a closed turn must be cleared");
  const progressAfterClose = events.filter((e) => e.type === "turn_progress").length;
  await delayMs(80);
  assert.equal(
    events.filter((e) => e.type === "turn_progress").length,
    progressAfterClose,
    "no turn_progress may fire after the socket closes",
  );
}

// Drive a cascaded turn through the real VoiceSessionConnection with a fast
// turn_progress interval so the keepalive is observable in a short test.
async function driveCascadedSessionWithProgress(tempDir, tag, provider, turnProgressIntervalMs) {
  const { connection, events } = makeProgressConnection(tempDir, tag, provider, turnProgressIntervalMs);
  const pcm = generatePcm16Tone({ durationMs: 80, frequencyHz: 240, sampleRate: 16000, volume: 0.2 });
  await connection.handleSessionStart({
    type: "session_start",
    session_id: `sess_${tag}`,
    turn_id: `turn_${tag}`,
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
  });
  connection.handleAudio(pcm);
  await connection.handleCommitTurn({ type: "commit_turn", turn_id: `turn_${tag}` });
  return { connection, events };
}

// A Live provider whose turn never completes on its own: its done promise stays
// pending even after cancel(), so the parked handleCommitTurn never completes the
// turn and the session server's terminal path (cancel/close) is the only thing
// that ends it. This isolates the keepalive-stop assertion from the separate
// completion race.
function makeHungLiveProvider() {
  const done = new Promise(() => {});
  const audioFormat = { encoding: "pcm16", sample_rate: 16000, channels: 1 };
  return {
    status: () => ({ provider: "gemini-live", model: "test-live", configured: true, assistant_audio_format: audioFormat }),
    createLiveTurnSession() {
      return {
        done,
        sendAudio() {},
        commit() {},
        cancel() {},
      };
    },
  };
}

async function setupHungLiveConnection(tempDir, tag, turnProgressIntervalMs) {
  const { connection, events } = makeProgressConnection(tempDir, tag, makeHungLiveProvider(), turnProgressIntervalMs);
  await connection.handleSessionStart({
    type: "session_start",
    session_id: `sess_${tag}`,
    turn_id: `turn_${tag}`,
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
  });
  connection.handleAudio(generatePcm16Tone({ durationMs: 40, frequencyHz: 260, sampleRate: 16000, volume: 0.2 }));
  return { connection, events };
}

function makeProgressConnection(tempDir, tag, provider, turnProgressIntervalMs) {
  const dataDir = path.join(tempDir, `session-${tag}`);
  const sessionsDir = path.join(dataDir, "voice-sessions");
  const providerEventsFile = path.join(dataDir, "voice-provider-events.jsonl");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const events = [];
  const connection = new VoiceSessionConnection(fakeWs(events), {
    request: {},
    sessionsDir,
    providerEventsFile,
    voiceProvider: provider,
    turnProgressIntervalMs,
    onTurnCompleted: async (record) => record,
  });
  return { connection, events };
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delayMs(10);
  }
  throw new Error(`timed out waiting for ${label || "condition"}`);
}

function streamingProviderEnv(extra = {}) {
  return {
    VOICE_PROVIDER: "chirp",
    VOICE_TTS_PROVIDER: "cloud-tts",
    GCP_PROJECT_ID: "test-project",
    CHIRP_ACCESS_TOKEN: "test-token",
    CHIRP_MODEL: "chirp_3",
    CHIRP_LANGUAGE_CODES: "en-US",
    ...extra,
  };
}

function makeStreamingConnection(tempDir, tag, provider, events) {
  const dataDir = path.join(tempDir, `session-${tag}`);
  const sessionsDir = path.join(dataDir, "voice-sessions");
  const providerEventsFile = path.join(dataDir, "voice-provider-events.jsonl");
  fs.mkdirSync(sessionsDir, { recursive: true });
  return new VoiceSessionConnection(fakeWs(events), {
    request: {},
    sessionsDir,
    providerEventsFile,
    voiceProvider: provider,
    onTurnCompleted: async (record) => record,
  });
}

async function startStreamingTurn(connection, tag) {
  await connection.handleSessionStart({
    type: "session_start",
    session_id: `sess_${tag}`,
    turn_id: `turn_${tag}`,
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
  });
  connection.handleAudio(generatePcm16Tone({ durationMs: 80, frequencyHz: 240, sampleRate: 16000, volume: 0.2 }));
}

// Streaming contract on the wire (connection-level, real binary frames): one
// assistant_audio_start {streaming:true}, >= 3 ordered binary frames for a
// 3-sentence stubbed turn, assistant_text AFTER the first frame (audio before
// text is the streaming contract), one assistant_audio_done, then turn_done
// carrying the additive first_audio_ms and tts_segments fields.
async function streamingMultiFrameWireOrder(tempDir) {
  const calls = [];
  stubFetch({ sttTranscript: "tell me a story", calls });
  const s1 = "Sure.";
  const s2 = "Here is a much longer second sentence that clearly crosses the sixty character minimum mark.";
  const s3 = "And the third sentence also runs far enough past sixty characters to form its own chunk.";
  const speak = `${s1} ${s2} ${s3}`;
  const events = [];
  const provider = createVoiceProvider({
    env: streamingProviderEnv(),
    reasoner: async (input) => {
      assert.equal(typeof input.on_speak_delta, "function", "streaming turns must offer on_speak_delta");
      input.on_speak_delta(`${s1} `);
      input.on_speak_delta(`${s2} `);
      input.on_speak_delta(s3);
      // Return only after the frames flowed, so assistant_text (sent at LLM
      // stream end) deterministically lands after the first binary frame.
      await waitFor(() => events.filter((e) => e.type === "binary").length >= 3, 5000, "three binary frames");
      return { speak, display: speak, language: "en-US", model: "test-model", classification: "chat" };
    },
  });
  const connection = makeStreamingConnection(tempDir, "stream-wire", provider, events);
  await startStreamingTurn(connection, "stream-wire");
  await connection.handleCommitTurn({ type: "commit_turn", turn_id: "turn_stream-wire" });

  const types = events.map((event) => event.type);
  const startIndexes = types.map((t, i) => (t === "assistant_audio_start" ? i : -1)).filter((i) => i >= 0);
  const doneIndexes = types.map((t, i) => (t === "assistant_audio_done" ? i : -1)).filter((i) => i >= 0);
  const binaryIndexes = types.map((t, i) => (t === "binary" ? i : -1)).filter((i) => i >= 0);
  assert.equal(startIndexes.length, 1, "exactly one assistant_audio_start");
  assert.equal(doneIndexes.length, 1, "exactly one assistant_audio_done");
  assert.ok(binaryIndexes.length >= 3, `>= 3 binary frames (got ${binaryIndexes.length})`);
  assert.ok(startIndexes[0] < binaryIndexes[0], "assistant_audio_start precedes the first frame");
  assert.ok(binaryIndexes[binaryIndexes.length - 1] < doneIndexes[0], "all frames precede assistant_audio_done");
  assert.equal(events[startIndexes[0]].streaming, true, "assistant_audio_start must carry streaming:true");
  const transcriptIndex = types.indexOf("transcript_final");
  assert.ok(transcriptIndex >= 0 && transcriptIndex < startIndexes[0], "transcript_final precedes audio");
  const textIndex = types.indexOf("assistant_text");
  const turnDoneIndex = types.indexOf("turn_done");
  assert.ok(textIndex > binaryIndexes[0], "assistant_text must arrive AFTER the first binary frame");
  assert.ok(textIndex < turnDoneIndex, "assistant_text precedes turn_done");
  assert.ok(doneIndexes[0] < turnDoneIndex, "assistant_audio_done precedes turn_done");
  const done = events[turnDoneIndex];
  assert.equal(done.status, "completed");
  assert.equal(done.tts_spoke, true);
  assert.equal(done.streaming, true, "turn_done must mark the streaming turn");
  assert.ok(Number.isFinite(done.first_audio_ms), "turn_done must carry first_audio_ms");
  assert.ok(done.tts_segments >= 3, `turn_done must carry tts_segments >= 3 (got ${done.tts_segments})`);
}

// Per-chunk synthesize request bodies arrive in sentence order (processTurn
// level; the recordingHooks harness records TTS bodies, never a WS).
async function streamingSynthesisBodiesInSentenceOrder(tempDir) {
  const calls = [];
  stubFetch({ sttTranscript: "hello", calls });
  const s1 = "Sure.";
  const s2 = "Here is a much longer second sentence that clearly crosses the sixty character minimum mark.";
  const s3 = "And the third sentence also runs far enough past sixty characters to form its own chunk.";
  const speak = `${s1} ${s2} ${s3}`;
  const provider = createVoiceProvider({
    env: streamingProviderEnv(),
    reasoner: async (input) => {
      input.on_speak_delta(speak);
      return { speak, display: speak, language: "en-US", model: "test-model", classification: "chat" };
    },
  });
  const events = [];
  const result = await provider.processTurn(makeTurn(tempDir, "stream-order"), recordingHooks(events));
  const bodies = calls.filter((c) => c.kind === "tts").map((c) => c.body.input.text);
  assert.deepEqual(bodies, [s1, s2, s3], `synthesize bodies must be the sentences in order (got ${JSON.stringify(bodies)})`);
  const audioCount = events.filter((e) => e.type === "audio").length;
  assert.ok(audioCount >= 3, `>= 3 audio emissions (got ${audioCount})`);
  assert.equal(result.streaming, true);
  assert.equal(result.tts_segments, 3);
  assert.equal(result.tts_spoke, true);
  assert.ok(Number.isFinite(result.first_audio_ms), "the result must carry first_audio_ms");
}

// Mid-stream TTS fault: chunk 2's synthesize returns 500. Chunk 1's audio
// stands, chunk 3 never issues a request, and the turn still completes with
// tts_error set — never a crash, never a turn error.
async function streamingMidStreamTtsFailure(tempDir) {
  let ttsCalls = 0;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes(":recognize")) {
      return jsonResponse({ results: [{ alternatives: [{ transcript: "tell me more" }] }] });
    }
    if (u.includes("texttospeech.googleapis.com")) {
      ttsCalls += 1;
      if (ttsCalls === 1) {
        return jsonResponse({ audioContent: wavBase64() });
      }
      await delayMs(40);
      return { ok: false, status: 500, json: async () => ({}), text: async () => "synthesize exploded" };
    }
    throw new Error(`unexpected fetch to ${u}`);
  };

  const s1 = "First sentence leaves fast.";
  const s2 = "Second sentence is long enough to pass the sixty character minimum and then fails to synthesize.";
  const s3 = "Third sentence must never even issue a synthesize request after the fault.";
  const events = [];
  const provider = createVoiceProvider({
    env: streamingProviderEnv(),
    reasoner: async (input) => {
      input.on_speak_delta(`${s1} `);
      input.on_speak_delta(s2);
      await waitFor(() => ttsCalls >= 2 && events.some((e) => e.type === "binary"), 5000, "chunk 1 emitted and chunk 2 attempted");
      await delayMs(80); // let the 500 land and the pipeline latch the fault
      input.on_speak_delta(` ${s3}`);
      return { speak: `${s1} ${s2} ${s3}`, display: `${s1} ${s2} ${s3}`, language: "en-US", model: "test-model", classification: "chat" };
    },
  });
  const connection = makeStreamingConnection(tempDir, "stream-fault", provider, events);
  await startStreamingTurn(connection, "stream-fault");
  await connection.handleCommitTurn({ type: "commit_turn", turn_id: "turn_stream-fault" });

  assert.equal(events.filter((e) => e.type === "binary").length, 1, "only chunk 1's audio may play");
  assert.equal(ttsCalls, 2, "chunk 3 must not fire a synthesize request after the fault");
  const done = events.find((e) => e.type === "turn_done");
  assert.equal(done.status, "completed", "a mid-stream TTS fault still completes the turn");
  assert.ok(done.tts_error && done.tts_error.length > 0, "turn_done must surface the tts_error");
  assert.equal(done.tts_spoke, true, "at least one chunk played");
  assert.ok(events.some((e) => e.type === "assistant_audio_done"), "assistant_audio_done still closes the audio window");
}

// Interruption: a new session_start replaces the turn between chunk emissions.
// The superseded turn emits nothing further — no frames, no assistant_text, no
// turn_done, no error — and TurnSupersededError never escapes as a turn error.
async function streamingInterruptionGoesSilent(tempDir) {
  const calls = [];
  stubFetch({ sttTranscript: "long story", calls });
  const events = [];
  let releaseReasoner;
  const gate = new Promise((resolve) => {
    releaseReasoner = resolve;
  });
  const provider = createVoiceProvider({
    env: streamingProviderEnv(),
    reasoner: async (input) => {
      input.on_speak_delta("First sentence spoken early.");
      await waitFor(() => events.some((e) => e.type === "binary"), 5000, "first frame before barge-in");
      await gate;
      input.on_speak_delta(" The rest of this reply must never reach the old turn after the barge-in lands, not one frame of it.");
      return { speak: "full reply", display: "full reply", language: "en-US", model: "test-model", classification: "chat" };
    },
  });
  const connection = makeStreamingConnection(tempDir, "stream-interrupt", provider, events);
  await startStreamingTurn(connection, "stream-interrupt");
  const commitPromise = connection.handleCommitTurn({ type: "commit_turn", turn_id: "turn_stream-interrupt" }).catch((error) => {
    throw new Error(`commit must not reject on interruption: ${error?.message || error}`);
  });
  await waitFor(() => events.some((e) => e.type === "binary"), 5000, "first frame at the connection level");

  // Barge-in: a new session_start marks the old turn terminal mid-stream.
  await connection.handleSessionStart({
    type: "session_start",
    session_id: "sess_stream-interrupt-next",
    turn_id: "turn_stream-interrupt-next",
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
  });
  const marker = events.length;
  releaseReasoner();
  await commitPromise;
  await delayMs(120);

  const after = events.slice(marker);
  assert.ok(!after.some((e) => e.type === "binary"), "no binary frames after supersession");
  const deadTurnEvents = after.filter((e) => e.turn_id === "turn_stream-interrupt"
    && ["assistant_text", "assistant_audio_done", "turn_done", "error"].includes(e.type));
  assert.deepEqual(deadTurnEvents, [], `no events for the dead turn (got ${JSON.stringify(deadTurnEvents)})`);
  assert.ok(!events.some((e) => e.type === "error"), "TurnSupersededError must never surface as an error event");
}

// Null-stream race: the assistant audio stream is finalized (nulled + latched,
// as closeAssistantAudioStream does) while a late chunk is still in flight.
// The late chunk is dropped: no throw, no flags:"w" re-creation, and the
// finalized audio record is not rewritten.
async function streamingNullStreamGuard(tempDir) {
  const calls = [];
  stubFetch({ sttTranscript: "keep talking", calls });
  const events = [];
  let releaseReasoner;
  const gate = new Promise((resolve) => {
    releaseReasoner = resolve;
  });
  const provider = createVoiceProvider({
    env: streamingProviderEnv(),
    reasoner: async (input) => {
      input.on_speak_delta("First sentence flows to disk and socket.");
      await waitFor(() => events.some((e) => e.type === "binary"), 5000, "first frame before the stream closes");
      await gate;
      input.on_speak_delta(" A late second sentence arrives after the assistant stream was finalized and must be dropped from disk.");
      return { speak: "reply", display: "reply", language: "en-US", model: "test-model", classification: "chat" };
    },
  });
  const connection = makeStreamingConnection(tempDir, "stream-null", provider, events);
  await startStreamingTurn(connection, "stream-null");
  const commitPromise = connection.handleCommitTurn({ type: "commit_turn", turn_id: "turn_stream-null" });
  await waitFor(() => events.some((e) => e.type === "binary"), 5000, "first frame at the connection level");

  // Exactly what closeAssistantAudioStream does: null the stream + set the latch.
  const turn = connection.turn;
  assert.ok(turn, "the turn must still be active");
  turn.assistantAudioStream = null;
  turn.assistantAudioClosed = true;
  const bytesBefore = turn.assistantAudioBytes;
  const chunksBefore = turn.assistantAudioChunks;
  releaseReasoner();
  await commitPromise;

  const done = events.find((e) => e.type === "turn_done");
  assert.equal(done.status, "completed", "a dropped late chunk must not fail the turn");
  assert.equal(turn.assistantAudioStream, null, "the finalized stream must never be re-created (flags:\"w\" reopen)");
  assert.equal(turn.assistantAudioBytes, bytesBefore, "the finalized audio byte count must not be rewritten");
  assert.equal(turn.assistantAudioChunks, chunksBefore, "the finalized audio chunk count must not be rewritten");
}

// Circuit breaker: three streaming faults latch streaming off for the process,
// voice_streaming_tripped logs exactly once, and the next turn runs the
// non-streaming single-frame path.
async function streamingCircuitBreakerLatches(tempDir) {
  resetVoiceStreamingBreakerForTests();
  const errorLogs = [];
  const previousConsoleError = console.error;
  console.error = (message) => {
    errorLogs.push(String(message));
  };
  try {
    reportVoiceStreamingFault("smoke-fault-1");
    reportVoiceStreamingFault("smoke-fault-2");
    assert.equal(voiceStreamingTripped(), false, "two faults must not trip the breaker");
    reportVoiceStreamingFault("smoke-fault-3");
    assert.equal(voiceStreamingTripped(), true, "the third fault must trip the breaker");
    reportVoiceStreamingFault("smoke-fault-4");
    const tripLogs = errorLogs.filter((line) => line.includes("voice_streaming_tripped"));
    assert.equal(tripLogs.length, 1, "voice_streaming_tripped must log exactly once");
  } finally {
    console.error = previousConsoleError;
  }

  try {
    const calls = [];
    stubFetch({ sttTranscript: "hello there", calls });
    const provider = createVoiceProvider({
      env: streamingProviderEnv(),
      reasoner: async (input) => {
        assert.equal(input.on_speak_delta, undefined, "a tripped breaker must serve the non-streaming path");
        return { speak: "Old path reply.", display: "Old path reply.", language: "en-US", model: "test-model", classification: "chat" };
      },
    });
    assert.equal(provider.status().voice_streaming.tripped, true, "status must expose the tripped latch");
    assert.equal(provider.status().voice_streaming.enabled, false);
    const events = [];
    await provider.processTurn(makeTurn(tempDir, "stream-breaker"), recordingHooks(events));
    assert.deepEqual(
      events.map((e) => e.type),
      ["transcript_final", "assistant_text", "assistant_audio_start", "audio", "assistant_audio_done"],
      "a tripped breaker must reproduce the single-frame text-before-audio sequence",
    );
  } finally {
    resetVoiceStreamingBreakerForTests();
  }
}

// Cap prefix property near the streaming cap: streamed speech is a PREFIX of
// the stored capped text — never byte equality, the spoken tail may be up to
// one clause shorter. Uses the real sanitizer the gateway wires around
// on_speak_delta, with a plain (compaction-identity) reply.
async function streamingCapPrefixProperty(tempDir) {
  const calls = [];
  stubFetch({ sttTranscript: "talk a lot", calls });
  const cap = 140;
  const fullText = "The quick brown fox jumps over the lazy dog and keeps going without a pause. ".repeat(5).trim();
  const storedSpeak = fullText.length > cap ? `${fullText.slice(0, cap)}...` : fullText; // truncate() semantics
  const provider = createVoiceProvider({
    env: streamingProviderEnv(),
    reasoner: async (input) => {
      const sanitizer = createSpeakStreamSanitizer({ onDelta: input.on_speak_delta, maxChars: cap });
      for (const piece of fullText.match(/.{1,23}/g)) {
        sanitizer.push(piece);
      }
      sanitizer.end();
      return { speak: storedSpeak, display: storedSpeak, language: "en-US", model: "test-model", classification: "chat" };
    },
  });
  const events = [];
  const result = await provider.processTurn(makeTurn(tempDir, "stream-cap"), recordingHooks(events));
  const spoken = calls.filter((c) => c.kind === "tts").map((c) => c.body.input.text).join(" ");
  assert.ok(spoken.length > 0, "capped stream must still speak the head of the reply");
  assert.ok(spoken.length <= cap, `spoken text must stay under the cap (got ${spoken.length})`);
  assert.ok(result.assistant_text.startsWith(spoken), `streamed speech must be a PREFIX of the stored capped text (spoken=${JSON.stringify(spoken.slice(-40))} stored=${JSON.stringify(result.assistant_text.slice(0, 60))})`);
  assert.notEqual(spoken, result.assistant_text, "byte equality is not required near the cap");
}

// Kill switch: VOICE_STREAMING=0 reproduces the exact pre-streaming event
// sequence (text before a single audio frame), guarding the rollback path.
async function streamingKillSwitchReproducesOldSequence(tempDir) {
  const calls = [];
  stubFetch({ sttTranscript: "what time is it", calls });
  const provider = createVoiceProvider({
    env: streamingProviderEnv({ VOICE_STREAMING: "0" }),
    reasoner: async (input) => {
      assert.equal(input.on_speak_delta, undefined, "VOICE_STREAMING=0 must not offer on_speak_delta");
      return { speak: "You said: what time is it.", display: "You said: what time is it.", language: "en-US", model: "test-model", classification: "chat" };
    },
  });
  assert.equal(provider.status().voice_streaming.enabled, false, "status must reflect the kill switch");
  const events = [];
  const result = await provider.processTurn(makeTurn(tempDir, "stream-off"), recordingHooks(events));
  assert.deepEqual(
    events.map((e) => e.type),
    ["transcript_final", "assistant_text", "assistant_audio_start", "audio", "assistant_audio_done"],
    "VOICE_STREAMING=0 must reproduce the exact single-frame text-before-audio sequence",
  );
  assert.equal(result.streaming, undefined, "a kill-switched turn carries no streaming metadata");
  assert.equal(result.tts_spoke, true);
}

function makeTurn(tempDir, tag) {
  const pcmPath = path.join(tempDir, `${tag}.pcm`);
  fs.writeFileSync(pcmPath, generatePcm16Tone({ durationMs: 60, frequencyHz: 200, sampleRate: 16000, volume: 0.2 }));
  return {
    pcmPath,
    audioBytes: fs.statSync(pcmPath).size,
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    sessionId: "sess",
    turnId: "turn",
  };
}

function recordingHooks(events) {
  return {
    onTranscriptFinal: async (text) => events.push({ type: "transcript_final", text }),
    onAssistantText: async (text) => events.push({ type: "assistant_text", text }),
    onAssistantAudioStart: async (format) => events.push({ type: "assistant_audio_start", format }),
    sendAudio: async (chunk) => events.push({ type: "audio", bytes: chunk.length }),
    onAssistantAudioDone: async () => events.push({ type: "assistant_audio_done" }),
  };
}

async function driveVoiceSession(tempDir, tag, provider, records = []) {
  const dataDir = path.join(tempDir, `session-${tag}`);
  const sessionsDir = path.join(dataDir, "voice-sessions");
  const providerEventsFile = path.join(dataDir, "voice-provider-events.jsonl");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const events = [];
  const ws = fakeWs(events);
  const connection = new VoiceSessionConnection(ws, {
    request: {},
    sessionsDir,
    providerEventsFile,
    voiceProvider: provider,
    agentProfile: null,
    contextProvider: null,
    toolHandler: null,
    onTurnCompleted: async (record) => {
      records.push(record);
      return record;
    },
  });
  const pcm = generatePcm16Tone({ durationMs: 80, frequencyHz: 240, sampleRate: 16000, volume: 0.2 });

  await connection.handleSessionStart({
    type: "session_start",
    session_id: `sess_${tag}`,
    turn_id: `turn_${tag}`,
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
  });
  connection.handleAudio(pcm);
  await connection.handleCommitTurn({ type: "commit_turn", turn_id: `turn_${tag}` });
  return { events, records };
}

function fakeWs(events) {
  return {
    readyState: WebSocket.OPEN,
    send(data, options, callback) {
      const cb = typeof options === "function" ? options : callback;
      if (Buffer.isBuffer(data)) {
        events.push({ type: "binary", bytes: data.length });
      } else {
        events.push(JSON.parse(Buffer.from(data).toString("utf8")));
      }
      if (cb) {
        process.nextTick(cb);
      }
    },
  };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

// A minimal 24kHz mono LINEAR16 WAV (header + a few PCM samples) so pcmFromWav
// finds the data chunk and returns non-empty audio.
function wavBase64() {
  const sampleRate = 24000;
  const samples = 240;
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(i / 6) * 8000), 44 + i * 2);
  }
  return buffer.toString("base64");
}
