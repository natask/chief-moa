#!/usr/bin/env node
"use strict";

// Smoke for streaming STT (Google Speech v2 streamingRecognize on the cascaded
// Chirp path). The gRPC client is stubbed with in-process fake duplex streams,
// so nothing touches Google. Covers:
//   A. The streaming session feeds live partial transcripts and finalizes a
//      concatenated transcript ACROSS a simulated stream rotation (the ~5-min
//      gRPC cap workaround that makes speech length unbounded).
//   B. The Google Speech v2 generated bidi method is selected instead of the
//      public method that fails live with RESOURCE_PROJECT_INVALID.
//   C. Any streaming failure degrades to the batch :recognize path — a broken
//      stream never fails the turn.
//   D. The batch fallback windows audio longer than 55s and concatenates the
//      per-window transcripts, so even the fallback has no length limit.
//   E. End to end through the real VoiceSessionConnection: audio frames teed
//      during capture broadcast `transcript_partial` to the client and the
//      final transcript is produced on commit without re-reading the file.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const { createStreamingSttSession } = require(path.join(GATEWAY_DIR, "lib", "voice-stt-streaming"));
const {
  createVoiceProvider,
  resetVoiceStreamingBreakerForTests,
  CLIENT_AUDIO_FORMAT,
} = require(path.join(GATEWAY_DIR, "lib", "voice-providers"));
const { VoiceSessionConnection } = require(path.join(GATEWAY_DIR, "lib", "voice-session-server"));

// A minimal stand-in for the gRPC duplex returned by client.streamingRecognize().
class FakeGrpcStream extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.ended = false;
    this.destroyed = false;
  }
  write(message) {
    this.written.push(message);
    return true;
  }
  end() {
    this.ended = true;
    setImmediate(() => this.emit("end"));
  }
  destroy() {
    this.destroyed = true;
    setImmediate(() => this.emit("close"));
  }
  emitData(results) {
    this.emit("data", { results });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await delay(20);
  }
  throw new Error(message);
}

async function testRotationAndPartials() {
  const opened = [];
  const partials = [];
  const session = createStreamingSttSession({
    openStream: () => {
      const stream = new FakeGrpcStream();
      opened.push(stream);
      return stream;
    },
    configMessage: { cfg: true },
    audioMessage: (chunk) => ({ audio: chunk }),
    parseResults: (data) => data.results,
    onPartial: (text) => { partials.push(text); },
    rotateAfterMs: 60000,
  });

  assert.equal(opened.length, 1, "first stream opens eagerly");
  assert.deepEqual(opened[0].written[0], { cfg: true }, "config is the first message");

  session.push(Buffer.from([1, 0, 2, 0]));
  assert.deepEqual(opened[0].written[1], { audio: Buffer.from([1, 0, 2, 0]) }, "audio frames follow config");

  opened[0].emitData([{ transcript: "hello", isFinal: false }]);
  opened[0].emitData([{ transcript: "hello there", isFinal: true }]);
  await tick();

  // Simulate the server closing the stream at its own time limit -> rotate.
  opened[0].emit("end");
  await settle(() => opened.length === 2, 1000, "stream did not rotate to a fresh gRPC session");
  assert.deepEqual(opened[1].written[0], { cfg: true }, "rotated stream re-sends config");

  session.push(Buffer.from([3, 0, 4, 0]));
  opened[1].emitData([{ transcript: "world", isFinal: true }]);
  await tick();

  const result = await session.finalize();
  assert.equal(result.ok, true, "healthy streaming session finalizes ok");
  assert.equal(result.rotations, 1, "exactly one rotation happened");
  assert.equal(result.text, "hello there world", "finals concatenate across the rotation");
  assert.ok(partials.includes("hello"), "interim partial was emitted");
  assert.ok(partials.includes("hello there"), "committed-so-far partial was emitted");

  console.log("  A rotation+partials: ok");
}

async function testProviderRetryAndOverlapReconciliation() {
  const opened = [];
  const partials = [];
  const session = createStreamingSttSession({
    openStream: () => {
      const stream = new FakeGrpcStream();
      opened.push(stream);
      return stream;
    },
    configMessage: { cfg: true },
    parseResults: (data) => data.results,
    onPartial: (text) => { partials.push(text); },
    rotateAfterMs: 60000,
  });

  const first = "Alpha plan has three safe steps";
  opened[0].emitData([{ transcript: first, isFinal: false }]);
  opened[0].emitData([{ transcript: first, isFinal: true, segmentId: "6:0" }]);
  // The gRPC/provider retry redelivers the same final event.
  opened[0].emitData([{ transcript: first, isFinal: true, segmentId: "6:0" }]);
  // A later final overlaps the prior segment, as can happen at a long-pause
  // boundary or provider replacement.
  opened[0].emitData([{
    transcript: "three safe steps and one final check",
    isFinal: true,
    segmentId: "10:0",
  }]);
  await tick();
  const result = await session.finalize();
  assert.equal(result.text, "Alpha plan has three safe steps and one final check");
  assert.ok(!partials.some((text) => text.includes(`${first} ${first}`)),
    "retry must never leak a repeated block into a partial");

  const amharic = createStreamingSttSession({
    openStream: () => {
      const stream = new FakeGrpcStream();
      opened.push(stream);
      return stream;
    },
    configMessage: { cfg: true },
    parseResults: (data) => data.results,
    rotateAfterMs: 60000,
  });
  const amStream = opened.at(-1);
  amStream.emitData([{ transcript: "የመጀመሪያ ክፍል እዚህ ነው", isFinal: true, segmentId: "4:0" }]);
  amStream.emitData([{ transcript: "ክፍል እዚህ ነው ከዚያ ይቀጥላል", isFinal: true, segmentId: "8:0" }]);
  const amResult = await amharic.finalize();
  assert.equal(amResult.text, "የመጀመሪያ ክፍል እዚህ ነው ከዚያ ይቀጥላል");

  // Short deliberate repetition stays intact without a shared provider id.
  const repeated = createStreamingSttSession({
    openStream: () => {
      const stream = new FakeGrpcStream();
      opened.push(stream);
      return stream;
    },
    configMessage: { cfg: true },
    parseResults: (data) => data.results,
    rotateAfterMs: 60000,
  });
  const repeatStream = opened.at(-1);
  repeatStream.emitData([{ transcript: "yes", isFinal: true }]);
  repeatStream.emitData([{ transcript: "yes", isFinal: true }]);
  assert.equal((await repeated.finalize()).text, "yes yes");

  const shortPhraseRepeat = createStreamingSttSession({
    openStream: () => {
      const stream = new FakeGrpcStream();
      opened.push(stream);
      return stream;
    },
    configMessage: { cfg: true },
    parseResults: (data) => data.results,
    rotateAfterMs: 60000,
  });
  const shortPhraseStream = opened.at(-1);
  for (const transcript of ["go", "go", "very good", "very good"]) {
    shortPhraseStream.emitData([{ transcript, isFinal: true }]);
  }
  assert.equal((await shortPhraseRepeat.finalize()).text, "go go very good very good",
    "legitimate one- and two-word final segments remain repeated");
  console.log("  A2 provider retry + multilingual overlap reconciliation: ok");
}

async function testCumulativeFinalStaircaseReplacement() {
  const opened = [];
  const session = createStreamingSttSession({
    openStream: () => {
      const stream = new FakeGrpcStream();
      opened.push(stream);
      return stream;
    },
    configMessage: { cfg: true },
    parseResults: (data) => data.results,
    rotateAfterMs: 60000,
  });
  const stream = opened[0];
  const prefix = "Draft the release note";
  const middle = `${prefix} እሺ then verify the package`;
  const complete = `${middle} before publishing the result`;
  stream.emitData([{ transcript: prefix, isFinal: true, segmentId: "4:0" }]);
  stream.emitData([{ transcript: middle, isFinal: true, segmentId: "8:0" }]);
  stream.emitData([{ transcript: complete, isFinal: true, segmentId: "12:0" }]);
  assert.equal((await session.finalize()).text, complete,
    "cumulative A; A+B; A+B+C finals replace the prefix and retain an isolated language token once");
  console.log("  A3 cumulative-final staircase replacement: ok");
}

function chirpProviderEnv(extra = {}) {
  return {
    VOICE_PROVIDER: "chirp",
    VOICE_TTS_PROVIDER: "cloud-tts",
    VOICE_REASONING_PROVIDER: "gateway",
    GCP_PROJECT_ID: "test-project",
    CHIRP_ACCESS_TOKEN: "test-token",
    CHIRP_MODEL: "chirp_3",
    CHIRP_PROMPT_LANGUAGE_CODES: "en-US",
    ...extra,
  };
}

async function testV2BidiMethodSelection() {
  resetVoiceStreamingBreakerForTests();
  const opened = [];
  let generatedCalls = 0;
  let publicCalls = 0;
  const client = {
    _streamingRecognize: () => {
      generatedCalls += 1;
      const stream = new FakeGrpcStream();
      opened.push(stream);
      return stream;
    },
    streamingRecognize: () => {
      publicCalls += 1;
      throw new Error("public v2 method must not be selected");
    },
  };
  const provider = createVoiceProvider({
    env: chirpProviderEnv(),
    streamingSttClientFactory: () => client,
  });
  const session = provider.createStreamingSttSession({
    turnId: "v2-bidi-method",
    format: { sample_rate: 16000, channels: 1 },
  }, { onTranscriptPartial: () => {} });

  assert.ok(session, "streaming session should be created");
  assert.equal(generatedCalls, 1, "Speech v2 generated bidi method is selected");
  assert.equal(publicCalls, 0, "the live-broken public streamingRecognize method is not called");
  assert.equal(opened.length, 1, "one generated bidi stream opens");
  const config = opened[0].written[0].streamingConfig.config;
  assert.deepEqual(config.languageCodes, ["auto"], "streaming Chirp recognition remains automatic");
  assert.match(config.features.customPromptConfig.customPrompt, /English/,
    "streaming config carries the profile-derived transcription prompt");
  session.abort();
  console.log("  B Speech v2 generated bidi method selection: ok");
}

async function testBatchFallbackOnStreamingError() {
  resetVoiceStreamingBreakerForTests();
  const previousFetch = global.fetch;
  let recognizeCalls = 0;
  let fallbackConfig = null;
  global.fetch = async (_url, options) => {
    recognizeCalls += 1;
    fallbackConfig = JSON.parse(String(options?.body || "{}")).config || null;
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [{ alternatives: [{ transcript: "batch recovery transcript" }] }] }),
    };
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-stream-fallback-"));
  try {
    // First openStream() yields a stream we will error; the reopen throws so the
    // session goes fatal and finalize() reports ok:false.
    let openCount = 0;
    const firstStream = new FakeGrpcStream();
    const client = {
      streamingRecognize: () => {
        openCount += 1;
        if (openCount === 1) return firstStream;
        throw new Error("simulated gRPC reopen failure");
      },
    };
    const provider = createVoiceProvider({
      env: chirpProviderEnv(),
      streamingSttClientFactory: () => client,
    });

    const pcmPath = path.join(tempDir, "turn.pcm");
    fs.writeFileSync(pcmPath, Buffer.alloc(3200)); // ~0.1s @16k, one batch window
    const turn = {
      turnId: "t1",
      pcmPath,
      audioBytes: 3200,
      format: { sample_rate: 16000, channels: 1 },
      effectiveProfile: { input_languages: "am-ET,en-US", input_language_primary: "am-ET" },
    };

    const session = provider.createStreamingSttSession(turn, { onTranscriptPartial: () => {} });
    assert.ok(session, "streaming session should be created when enabled");
    turn.sttStream = session;
    session.push(Buffer.from([1, 0, 2, 0]));
    // Error the live stream -> triggers a rotate -> reopen throws -> fatal.
    firstStream.emit("error", new Error("simulated gRPC stream error"));
    await settle(() => openCount >= 2, 1000, "session never attempted a reopen");

    const result = await provider.runSttStage(turn, ["en-US"]);
    assert.equal(result.streaming, undefined, "a failed stream must not report a streaming result");
    assert.equal(result.text, "batch recovery transcript", "STT degraded to the batch :recognize path");
    assert.ok(recognizeCalls >= 1, "batch recognize was invoked as the fallback");
    assert.deepEqual(fallbackConfig.languageCodes, ["auto"]);
    assert.match(fallbackConfig.features.customPromptConfig.customPrompt, /Amharic.*English/,
      "batch fallback preserves the same turn-pinned prompt contract");
    console.log("  C batch fallback on streaming error: ok");
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
    resetVoiceStreamingBreakerForTests();
  }
}

async function testWindowedBatchSplit() {
  const previousFetch = global.fetch;
  const windowTexts = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(String(options.body || "{}"));
    const bytes = Buffer.from(String(body.content || ""), "base64").length;
    const index = windowTexts.length + 1;
    windowTexts.push({ bytes });
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [{ alternatives: [{ transcript: `w${index}` }] }] }),
    };
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-stream-window-"));
  try {
    const provider = createVoiceProvider({ env: chirpProviderEnv() });
    // Shrink the effective window with a tiny sample rate: at 100 Hz mono pcm16
    // the 55s window is 55 * 100 * 2 = 11000 bytes. A 25000-byte file must split
    // into 3 windows (11000 + 11000 + 3000).
    const pcmPath = path.join(tempDir, "long.pcm");
    fs.writeFileSync(pcmPath, Buffer.alloc(25000, 1));
    const turn = {
      turnId: "long",
      pcmPath,
      audioBytes: 25000,
      format: { sample_rate: 100, channels: 1 },
    };
    const result = await provider.transcribePcmWindowed(turn, ["en-US"]);
    assert.equal(windowTexts.length, 3, "long audio splits into 3 windows");
    assert.deepEqual(windowTexts.map((w) => w.bytes), [11000, 11000, 3000], "windows are <=55s and frame-aligned");
    assert.equal(result.text, "w1 w2 w3", "window transcripts concatenate in order");
    assert.equal(result.windowed, true, "windowed batch is flagged");
    console.log("  D windowed batch split (>55s): ok");
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testSessionServerTee() {
  const opened = [];
  const provider = new StubStreamingProvider(opened);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-stream-tee-"));
  const sessionsDir = path.join(tempDir, "voice-sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  try {
    const recorded = [];
    const ws = new FakeWs();
    const connection = new VoiceSessionConnection(ws, {
      request: { headers: {} },
      sessionsDir,
      providerEventsFile: path.join(tempDir, "voice-provider-events.jsonl"),
      voiceProvider: provider,
      agentProfile: null,
      contextProvider: null,
      toolHandler: null,
      onTurnCompleted: (turn) => { recorded.push(turn); },
    });

    connection.start();
    ws.emit("message", Buffer.from(JSON.stringify({
      type: "session_start",
      session_id: "streamsess",
      conversation_id: "streamsess",
      branch_id: "default",
      turn_id: "streamturn",
      format: CLIENT_AUDIO_FORMAT,
    })), false);
    await settle(() => opened.length === 1, 1000, "streaming STT session was not opened at session_start");

    // A teed audio frame reaches the recognizer.
    ws.emit("message", Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]), true);
    await tick();
    assert.ok(opened[0].written.some((m) => m.audio), "audio frame was teed into the streaming recognizer");

    // Interim result -> transcript_partial broadcast to the client.
    opened[0].emitData([{ transcript: "live one", isFinal: false }]);
    await settle(() => sentEvents(ws).some((e) => e.type === "transcript_partial" && e.text === "live one"),
      1000, "transcript_partial was not broadcast to the client");

    opened[0].emitData([{ transcript: "live one two", isFinal: true }]);
    await tick();

    ws.emit("message", Buffer.from(JSON.stringify({ type: "commit_turn", turn_id: "streamturn" })), false);
    await settle(() => recorded.length > 0, 3000, "turn never completed");

    assert.equal(recorded[0].transcript, "live one two", "final transcript came from the streaming session");
    assert.ok(sentEvents(ws).some((e) => e.type === "transcript_final" && e.text === "live one two"),
      "transcript_final was broadcast");
    console.log("  E session-server tee + partial broadcast: ok");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

class StubStreamingProvider {
  constructor(opened) {
    this.opened = opened;
  }
  status() {
    return {
      provider: "chirp-cascaded",
      selected_providers: { stt: "chirp", reasoning: "gateway", tts: "cloud-tts" },
      model: "chirp_3",
      language_codes: ["en-US"],
      transcription_only: true,
    };
  }
  createStreamingSttSession(turn, hooks) {
    const opened = this.opened;
    return createStreamingSttSession({
      openStream: () => {
        const stream = new FakeGrpcStream();
        opened.push(stream);
        return stream;
      },
      configMessage: { cfg: true },
      audioMessage: (chunk) => ({ audio: chunk }),
      parseResults: (data) => data.results,
      onPartial: (text) => hooks.onTranscriptPartial(text),
      rotateAfterMs: 60000,
    });
  }
  async processTurn(turn, hooks) {
    let text = "unrecognized";
    if (turn.sttStream && typeof turn.sttStream.finalize === "function") {
      const result = await turn.sttStream.finalize();
      if (result.ok && result.text) text = result.text;
    }
    if (text) await hooks.onTranscriptFinal(text);
    return {
      provider: "chirp-cascaded",
      model: "chirp_3",
      transcript: text,
      assistant_text: "",
      transcription_only: true,
      audio_format: CLIENT_AUDIO_FORMAT,
    };
  }
}

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
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

function sentEvents(ws) {
  const events = [];
  for (const frame of ws.sent) {
    if (Buffer.isBuffer(frame)) continue;
    try {
      events.push(JSON.parse(frame));
    } catch {
      // non-JSON frame
    }
  }
  return events;
}

async function main() {
  await testRotationAndPartials();
  await testProviderRetryAndOverlapReconciliation();
  await testCumulativeFinalStaircaseReplacement();
  await testV2BidiMethodSelection();
  await testBatchFallbackOnStreamingError();
  await testWindowedBatchSplit();
  await testSessionServerTee();
  console.log("smoke-streaming-stt: ok");
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
