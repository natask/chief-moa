"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const { CLIENT_AUDIO_FORMAT, composeVoiceProvider } = require("../lib/voice-providers");
const { VoiceSessionConnection } = require("../lib/voice-session-server");

test("a duplex provider composes with an off-by-default Chirp transcript sidecar", () => {
  const base = {
    GCP_PROJECT_ID: "test-project",
    CHIRP_ACCESS_TOKEN: "test-chirp-token",
    CHIRP_MODEL: "chirp_3",
    CHIRP_LANGUAGE_CODES: "en-US,am-ET",
  };
  const primary = {
    status: () => ({
      provider: "test-duplex-audio",
      model: "test-native-model",
      selected_providers: { native_live: "test-duplex-audio" },
    }),
    createLiveTurnSession: () => ({ done: Promise.resolve({}) }),
    processTurn: async () => ({}),
  };

  const off = composeVoiceProvider(primary, { env: base });
  assert.equal(off, primary);

  const on = composeVoiceProvider(primary, {
    env: { ...base, VOICE_TRANSCRIPT_SIDECAR: "chirp" },
    streamingSttClientFactory: () => null,
  });
  assert.deepEqual(on.status().transcript_sidecar, {
    enabled: true,
    provider: "chirp",
    configured: true,
    model: "chirp_3",
    language_codes: ["auto"],
    streaming: true,
  });
  assert.equal(on.status().provider, "test-duplex-audio");
  assert.equal(on.status().selected_providers.transcript_sidecar, "chirp");
});

test("one PCM frame feeds native audio and sidecar; sidecar owns visible/final transcript", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-native-sidecar-"));
  try {
    const recorded = [];
    const provider = new FakeHybridProvider({ sidecarText: "chirp final" });
    const ws = new FakeWs();
    const connection = new VoiceSessionConnection(ws, {
      request: { headers: {} },
      sessionsDir: path.join(tempDir, "voice-sessions"),
      providerEventsFile: path.join(tempDir, "voice-provider-events.jsonl"),
      voiceProvider: provider,
      agentProfile: null,
      contextProvider: null,
      toolHandler: null,
      onTurnCompleted: (turn) => recorded.push(turn),
    });
    fs.mkdirSync(path.join(tempDir, "voice-sessions"), { recursive: true });
    connection.start();

    ws.emit("message", json({
      type: "session_start",
      session_id: "hybrid_session",
      branch_id: "default",
      turn_id: "hybrid_turn",
      format: CLIENT_AUDIO_FORMAT,
    }), false);
    await settle(() => sentEvents(ws).some((event) => event.type === "session_ready"));

    const frame = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    ws.emit("message", frame, true);
    await settle(() => provider.liveFrames.length === 1 && provider.sidecarFrames.length === 1);
    assert.deepEqual(provider.liveFrames[0], frame);
    assert.deepEqual(provider.sidecarFrames[0], frame);
    await settle(() => sentEvents(ws).some((event) => event.type === "transcript_partial"));
    assert.equal(sentEvents(ws).find((event) => event.type === "transcript_partial").text, "chirp partial");

    ws.emit("message", json({ type: "commit_turn", turn_id: "hybrid_turn" }), false);
    await settle(() => recorded.length === 1);

    assert.equal(recorded[0].transcript, "chirp final");
    assert.equal(recorded[0].transcript_source, "stt_sidecar");
    assert.equal(recorded[0].transcript_provider, "chirp");
    assert.equal(recorded[0].native_input_transcript, "native candidate");
    assert.ok(sentEvents(ws).some((event) => event.type === "transcript_final" && event.text === "chirp final"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("fallback, cancel, replacement, and socket close tear down both streams", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-native-sidecar-fallback-"));
  try {
    const recorded = [];
    const provider = new FakeHybridProvider({ sidecarText: "" });
    const ws = new FakeWs();
    const connection = new VoiceSessionConnection(ws, {
      request: { headers: {} },
      sessionsDir: path.join(tempDir, "voice-sessions"),
      providerEventsFile: path.join(tempDir, "voice-provider-events.jsonl"),
      voiceProvider: provider,
      agentProfile: null,
      contextProvider: null,
      toolHandler: null,
      onTurnCompleted: (turn) => recorded.push(turn),
    });
    fs.mkdirSync(path.join(tempDir, "voice-sessions"), { recursive: true });
    connection.start();

    ws.emit("message", json({
      type: "session_start",
      session_id: "fallback_session",
      turn_id: "fallback_turn",
      format: CLIENT_AUDIO_FORMAT,
    }), false);
    await settle(() => sentEvents(ws).some((event) => event.type === "session_ready"));
    ws.emit("message", Buffer.from([1, 0]), true);
    ws.emit("message", json({ type: "commit_turn", turn_id: "fallback_turn" }), false);
    await settle(() => recorded.length === 1);
    assert.equal(recorded[0].transcript, "native candidate");
    assert.equal(recorded[0].transcript_source, "stt");

    ws.emit("message", json({
      type: "session_start",
      session_id: "cancel_session",
      turn_id: "cancel_turn",
      format: CLIENT_AUDIO_FORMAT,
    }), false);
    await settle(() => provider.sessionsStarted === 2);
    ws.emit("message", Buffer.from([2, 0]), true);
    ws.emit("message", json({ type: "cancel_turn", turn_id: "cancel_turn" }), false);
    await settle(() => provider.liveCanceled === 1 && provider.sidecarAborted === 1);
    assert.ok(sentEvents(ws).some((event) => event.type === "turn_done" && event.status === "canceled"));

    ws.emit("message", json({
      type: "session_start",
      session_id: "replace_session",
      turn_id: "replace_first",
      format: CLIENT_AUDIO_FORMAT,
    }), false);
    await settle(() => provider.sessionsStarted === 3);
    ws.emit("message", Buffer.from([3, 0]), true);
    ws.emit("message", json({
      type: "session_start",
      session_id: "replace_session",
      turn_id: "replace_second",
      format: CLIENT_AUDIO_FORMAT,
    }), false);
    await settle(() => provider.sessionsStarted === 4);
    assert.equal(provider.liveCanceled, 2, "replacement cancels the first native Live stream");
    assert.equal(provider.sidecarAborted, 2, "replacement aborts the first transcript stream");

    ws.emit("close");
    await settle(() => provider.liveCanceled === 3 && provider.sidecarAborted === 3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

class FakeHybridProvider {
  constructor(options) {
    this.sidecarText = options.sidecarText;
    this.liveFrames = [];
    this.sidecarFrames = [];
    this.liveCanceled = 0;
    this.sidecarAborted = 0;
    this.sessionsStarted = 0;
  }

  status() {
    return {
      provider: "test-duplex-audio",
      model: "test-native-model",
      selected_providers: {
        native_live: "test-duplex-audio",
        stt: "test-duplex-audio",
        reasoning: "test-duplex-audio",
        tts: "test-duplex-audio",
      },
      transcript_sidecar: { enabled: true, provider: "chirp" },
    };
  }

  createLiveTurnSession() {
    this.sessionsStarted += 1;
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    return {
      done,
      sendAudio: (chunk) => this.liveFrames.push(Buffer.from(chunk)),
      commit: () => resolveDone({
        provider: "test-duplex-audio",
        model: "test-native-model",
        transcript: "native candidate",
        transcript_source: "stt",
        assistant_text: "",
        audio_format: CLIENT_AUDIO_FORMAT,
      }),
      sendText: () => {},
      cancel: () => { this.liveCanceled += 1; },
    };
  }

  createStreamingSttSession(_turn, hooks) {
    let partialSent = false;
    return {
      push: (chunk) => {
        this.sidecarFrames.push(Buffer.from(chunk));
        if (!partialSent) {
          partialSent = true;
          void hooks.onTranscriptPartial("chirp partial");
        }
      },
      finalize: async () => ({ ok: true, text: this.sidecarText }),
      abort: () => { this.sidecarAborted += 1; },
    };
  }

  async finalizeStreamingSttSession(turn) {
    return turn.sttStream.finalize();
  }
}

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(data, options, callback) {
    const done = typeof options === "function" ? options : callback;
    this.sent.push(data);
    done?.();
  }
}

function json(value) {
  return Buffer.from(JSON.stringify(value));
}

function sentEvents(ws) {
  return ws.sent.flatMap((frame) => {
    if (Buffer.isBuffer(frame)) return [];
    try {
      return [JSON.parse(frame)];
    } catch {
      return [];
    }
  });
}

async function settle(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
