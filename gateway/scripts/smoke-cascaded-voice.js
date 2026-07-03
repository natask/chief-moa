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

const GATEWAY_DIR = path.resolve(__dirname, "..");
const {
  createVoiceProvider,
  generatePcm16Tone,
} = require(path.join(GATEWAY_DIR, "lib", "voice-providers"));

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
    await sttOnlyUnchanged(tempDir);
    console.log("smoke-cascaded-voice: ok");
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
