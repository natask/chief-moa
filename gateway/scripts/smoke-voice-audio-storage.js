#!/usr/bin/env node
"use strict";

// Smoke for raw-audio turn storage on the cascaded path. The gateway already
// persists user PCM, assistant PCM, and a canonical turn JSON sidecar; this
// proves the CASCADED provider flows through the SAME mechanism as the native
// path: identical PCM files plus a sidecar that carries transcript, provider,
// input languages, reply language, and audio byte counts — enough for a later
// audio-analysis agent to fetch the stored audio and feed it to a critic.
//
// Drives the real VoiceSessionConnection (via createVoiceSessionServer) with an
// in-process fake WebSocket and a stub cascaded provider, so no GCP/network.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const { VoiceSessionConnection } = require(path.join(GATEWAY_DIR, "lib", "voice-session-server"));
const { CLIENT_AUDIO_FORMAT } = require(path.join(GATEWAY_DIR, "lib", "voice-providers"));

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-audio-storage-smoke-"));
  const dataDir = path.join(tempDir, "data");
  try {
    const recorded = [];
    // A stub cascaded provider: streams a transcript, spoken text, and one
    // assistant-audio chunk, then completes — the same hook shape the real
    // Chirp cascade and Gemini Live use.
    const provider = new StubCascadedProvider();
    const sessionsDir = path.join(dataDir, "voice-sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const ws = new FakeWs();
    // Drive the real connection class (same record/PCM paths as production),
    // without a real HTTP upgrade.
    const connection = new VoiceSessionConnection(ws, {
      request: { headers: {} },
      sessionsDir,
      providerEventsFile: path.join(dataDir, "voice-provider-events.jsonl"),
      voiceProvider: provider,
      agentProfile: null,
      contextProvider: null,
      toolHandler: null,
      onTurnCompleted: (turn) => { recorded.push(turn); },
    });

    // session_start (recording) -> audio frame -> commit_turn.
    connection.start();
    ws.emit("message", Buffer.from(JSON.stringify({
      type: "session_start",
      session_id: "audiosess",
      conversation_id: "audiosess",
      branch_id: "default",
      turn_id: "audioturn",
      format: CLIENT_AUDIO_FORMAT,
    })), false);
    await tick();
    ws.emit("message", Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]), true);
    await tick();
    ws.emit("message", Buffer.from(JSON.stringify({ type: "commit_turn", turn_id: "audioturn" })), false);
    await settle(() => recorded.length > 0, 3000, "turn never completed");

    // 1. Canonical turn record carries the language pair, transcript, provider.
    const turn = recorded[0];
    assert.equal(turn.transcript, "hello world", "canonical record must carry the STT transcript");
    assert.equal(turn.assistant_text, "Hi there.", "canonical record must carry the reply text");
    assert.equal(turn.provider, "chirp-cascaded");
    assert.equal(turn.transcription_only, false);
    assert.equal(turn.tts_spoke, true, "record must note hosted TTS spoke");
    assert.equal(turn.reply_language, "en-US");
    assert.deepEqual(turn.input_languages, ["en-US", "am-ET"], "record must carry the restricted input languages");
    assert.ok(turn.audio && turn.audio.bytes > 0, "record must reference stored user audio bytes");
    assert.ok(turn.assistant_audio && turn.assistant_audio.bytes > 0, "record must reference stored assistant audio bytes");

    // 2. Raw PCM files exist on disk at the documented paths.
    const turnDir = path.join(dataDir, "voice-sessions", "audiosess");
    const userPcm = path.join(turnDir, "audioturn.pcm");
    const assistantPcm = path.join(turnDir, "audioturn.assistant.pcm");
    const sidecar = path.join(turnDir, "audioturn.json");
    assert.ok(fs.existsSync(userPcm), "user PCM must be stored");
    assert.ok(fs.existsSync(assistantPcm), "assistant PCM must be stored");
    assert.ok(fs.statSync(userPcm).size > 0, "user PCM must be non-empty");
    assert.ok(fs.statSync(assistantPcm).size > 0, "assistant PCM must be non-empty");
    assert.ok(fs.existsSync(sidecar), "canonical turn JSON sidecar must be stored");

    // 3. Sidecar JSON references the audio files + provider (fetchable later).
    const meta = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    assert.equal(meta.audio.pcm_file, "audioturn.pcm");
    assert.equal(meta.assistant_audio.pcm_file, "audioturn.assistant.pcm");
    assert.equal(meta.provider, "chirp-cascaded");

    console.log("smoke-voice-audio-storage: ok");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

class StubCascadedProvider {
  status() {
    return {
      provider: "chirp-cascaded",
      selected_providers: { stt: "chirp", reasoning: "gateway", tts: "cloud-tts" },
      model: "chirp_3",
      language_codes: ["en-US", "am-ET"],
      transcription_only: false,
    };
  }

  async processTurn(turn, hooks) {
    await hooks.onTranscriptFinal("hello world");
    await hooks.onAssistantText("Hi there.");
    await hooks.onAssistantAudioStart(CLIENT_AUDIO_FORMAT);
    await hooks.sendAudio(Buffer.from([9, 0, 8, 0, 7, 0]));
    await hooks.onAssistantAudioDone();
    return {
      provider: "chirp-cascaded",
      model: "chirp_3",
      transcript: "hello world",
      assistant_text: "Hi there.",
      audio_format: CLIENT_AUDIO_FORMAT,
      transcription_only: false,
      tts_spoke: true,
      reply_language: "en-US",
      classification: "chat",
    };
  }
}

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1; // OPEN
    this.OPEN = 1;
    this.sent = [];
  }
  send(data, options, cb) {
    const callback = typeof options === "function" ? options : cb;
    this.sent.push(data);
    if (callback) callback();
  }
  close() { this.readyState = 3; }
  terminate() { this.readyState = 3; }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
