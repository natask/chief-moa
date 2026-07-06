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
} = require(path.join(GATEWAY_DIR, "lib", "voice-providers"));
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
