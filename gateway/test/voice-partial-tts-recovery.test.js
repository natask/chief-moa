"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { WebSocket } = require("ws");
const { createVoiceProvider } = require("../lib/voice-providers");
const { createVoiceSessionServer } = require("../lib/voice-session-server");
const { handleTtsRetry, MAX_RECEIPTS, MAX_RETRIES_PER_TURN } = require("../lib/voice-tts-retry");

const FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };
const REPLY = "First sentence.\n\n   Second sentence.";

test("a short unpunctuated first phrase reaches TTS before reasoning completes", async () => {
  const provider = createVoiceProvider({
    env: {
      MOA_MODE: "local", VOICE_PROVIDER: "chirp",
      VOICE_REASONING_PROVIDER: "gateway", VOICE_TTS_PROVIDER: "cloud-tts",
      VOICE_STREAMING: "1", VOICE_CHUNK_FIRST_FLUSH_MS: "50",
      CHIRP_MODEL: "chirp_3", GCP_PROJECT_ID: "test-project", CHIRP_ACCESS_TOKEN: "test-token",
    },
    reasoner: async () => ({}),
  });
  let resolveAudio;
  const firstAudio = new Promise((resolve) => { resolveAudio = resolve; });
  provider.synthesizeSpeech = async () => Buffer.alloc(320, 1);
  const pipeline = provider.createStreamingReplyPipeline({
    hooks: {
      isTurnActive: () => true,
      onAssistantAudioStart: async () => {},
      onAssistantAudioSegment: async () => {},
      sendAudio: async (_pcm, metadata) => resolveAudio(metadata.segmentText),
      onAssistantAudioDone: async () => {},
    },
    language: "en-US",
    turnStartedAtMs: Date.now(),
    voice: "Kore",
    speakingRate: 1,
    tone: "",
    playbackRate: 1,
  });

  pipeline.pushDelta("Short reply without punctuation");
  const spoken = await Promise.race([
    firstAudio,
    new Promise((_, reject) => setTimeout(() => reject(new Error("first phrase stayed buffered")), 300)),
  ]);
  assert.equal(spoken, "Short reply without");
  await pipeline.finish();
});

test("a second-chunk TTS failure is explicit and the unheard suffix can be retried idempotently", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-partial-tts-"));
  let synthesisCall = 0;
  let failedSecondChunk = false;
  const provider = createVoiceProvider({
    env: {
      MOA_MODE: "local",
      VOICE_PROVIDER: "chirp",
      VOICE_REASONING_PROVIDER: "gateway",
      VOICE_TTS_PROVIDER: "cloud-tts",
      VOICE_STREAMING: "1",
      CHIRP_MODEL: "chirp_3",
      GCP_PROJECT_ID: "test-project",
      CHIRP_ACCESS_TOKEN: "test-token",
    },
    reasoner: async (input) => {
      input.on_speak_delta(REPLY);
      return {
        speak: REPLY,
        display: REPLY,
        language: "en-US",
        classification: "chat",
      };
    },
  });
  provider.synthesizeSpeech = async (text) => {
    synthesisCall += 1;
    if (text === "First sentence.") {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    if (text === "Second sentence." && !failedSecondChunk) {
      failedSecondChunk = true;
      throw new Error("deterministic second chunk failure");
    }
    return Buffer.alloc(Math.max(320, text.length * 20), 1);
  };

  const voiceServer = createVoiceSessionServer({ dataDir: tempDir, voiceProvider: provider });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => voiceServer.handleUpgrade(request, socket, head));
  let client;

  try {
    const port = await listen(server);
    client = await connect(`ws://127.0.0.1:${port}${voiceServer.endpoint}`);
    client.ws.send(JSON.stringify({
      type: "session_start",
      session_id: "partial_session",
      conversation_id: "partial_session",
      branch_id: "default",
      turn_id: "partial_turn",
      source: "partial-tts-test",
      format: FORMAT,
    }));
    await client.waitFor("session_ready");
    client.ws.send(JSON.stringify({ type: "text_turn", turn_id: "partial_turn", text: "please answer" }));
    const done = await client.waitFor("turn_done");

    assert.equal(done.status, "completed");
    assert.equal(done.tts_delivery, "partial");
    assert.equal(done.tts_complete, false);
    assert.equal(done.tts_spoke, true);
    assert.equal(done.tts_segments, 1);
    assert.equal(done.tts_failed_segment_index, 1);
    assert.equal(done.tts_spoken_text_end, "First sentence.".length);
    assert.equal(done.tts_reply_text_chars, REPLY.length);
    assert.match(done.tts_error, /deterministic second chunk failure/);

    const audioDone = client.events.find((event) => event.type === "assistant_audio_done");
    assert.equal(audioDone.complete, false);
    assert.equal(audioDone.tts_delivery, "partial");

    const retry = {
      type: "retry_tts",
      turn_id: "partial_turn",
      retry_id: "retry_one",
      from_text_char: done.tts_spoken_text_end,
    };
    client.ws.send(JSON.stringify(retry));
    const retryDone = await client.waitFor("tts_retry_done");
    assert.equal(retryDone.status, "completed");
    assert.equal(retryDone.from_text_char, "First sentence.".length);
    assert.equal(retryDone.tts_delivery, "complete");
    assert.equal(synthesisCall, 3);

    client.ws.send(JSON.stringify(retry));
    const duplicate = await client.waitFor("tts_retry_done", 2);
    assert.deepEqual(duplicate, retryDone);
    assert.equal(synthesisCall, 3, "duplicate retry_id must not synthesize or replay audio twice");
    client.ws.send(JSON.stringify({ ...retry, from_text_char: 0 }));
    const conflict = await client.waitFor("error");
    assert.match(conflict.message, /idempotency conflict/);
    assert.equal(synthesisCall, 3);
    client.ws.close();
  } finally {
    client?.ws.terminate();
    await new Promise((resolve) => voiceServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a fully failed first TTS chunk remains reachable for successful retry", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-failed-tts-"));
  let synthesisCall = 0;
  const provider = createVoiceProvider({
    env: {
      MOA_MODE: "local", VOICE_PROVIDER: "chirp",
      VOICE_REASONING_PROVIDER: "gateway", VOICE_TTS_PROVIDER: "cloud-tts",
      VOICE_STREAMING: "1", CHIRP_MODEL: "chirp_3",
      GCP_PROJECT_ID: "test-project", CHIRP_ACCESS_TOKEN: "test-token",
    },
    reasoner: async (input) => {
      input.on_speak_delta("Only sentence.");
      return { speak: "Only sentence.", display: "Only sentence.", language: "en-US", classification: "chat" };
    },
  });
  provider.synthesizeSpeech = async () => {
    synthesisCall += 1;
    if (synthesisCall === 1) throw new Error("deterministic first chunk failure");
    return Buffer.alloc(320, 1);
  };
  const voiceServer = createVoiceSessionServer({ dataDir: tempDir, voiceProvider: provider });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => voiceServer.handleUpgrade(request, socket, head));
  let client;
  try {
    const port = await listen(server);
    client = await connect(`ws://127.0.0.1:${port}${voiceServer.endpoint}`);
    client.ws.send(JSON.stringify({
      type: "session_start", session_id: "failed_session", conversation_id: "failed_session",
      branch_id: "default", turn_id: "failed_turn", source: "failed-tts-test", format: FORMAT,
    }));
    await client.waitFor("session_ready");
    client.ws.send(JSON.stringify({ type: "text_turn", turn_id: "failed_turn", text: "please answer" }));
    const done = await client.waitFor("turn_done");
    assert.equal(done.tts_delivery, "failed");
    assert.equal(done.tts_complete, false);
    assert.equal(done.tts_spoke, false);
    assert.equal(done.tts_spoken_text_end, 0);
    client.ws.send(JSON.stringify({
      type: "retry_tts", turn_id: "failed_turn", retry_id: "failed_retry", from_text_char: 0,
    }));
    const retried = await client.waitFor("tts_retry_done");
    assert.equal(retried.status, "completed");
    assert.equal(retried.tts_delivery, "complete");
    assert.equal(synthesisCall, 2);
  } finally {
    client?.ws.terminate();
    await new Promise((resolve) => voiceServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("retry_tts rejects unauthorized receipts, offsets, missing ids, and excess attempts", async () => {
  const harness = retryHarness();
  await handleTtsRetry(harness.connection, { type: "retry_tts", turn_id: "turn_a", from_text_char: 5 }, harness.helpers);
  assert.match(harness.errors.pop(), /requires retry_id/);

  harness.connection.turn.ttsRecovery = null;
  await handleTtsRetry(harness.connection, { type: "retry_tts", turn_id: "turn_a", retry_id: "r1", from_text_char: 5 }, harness.helpers);
  assert.match(harness.errors.pop(), /recoverable partial or failed/);

  harness.connection.turn.ttsRecovery = recovery("partial");
  await handleTtsRetry(harness.connection, { type: "retry_tts", turn_id: "turn_a", retry_id: "r2", from_text_char: 0 }, harness.helpers);
  assert.match(harness.errors.pop(), /recorded safe suffix boundary/);
  harness.connection.turn.ttsRetryAttempts = MAX_RETRIES_PER_TURN;
  await handleTtsRetry(harness.connection, { type: "retry_tts", turn_id: "turn_a", retry_id: "r3", from_text_char: 5 }, harness.helpers);
  assert.match(harness.errors.pop(), /attempt limit/);
  assert.equal(harness.synthesisCount(), 0);
});

test("retry_tts scopes idempotency to turn plus request digest and bounds receipt memory", async () => {
  const harness = retryHarness();
  const request = { type: "retry_tts", turn_id: "turn_a", retry_id: "same_retry", from_text_char: 5 };
  await handleTtsRetry(harness.connection, request, harness.helpers);
  await handleTtsRetry(harness.connection, request, harness.helpers);
  assert.equal(harness.synthesisCount(), 1);
  await handleTtsRetry(harness.connection, { ...request, from_text_char: 6 }, harness.helpers);
  assert.match(harness.errors.pop(), /idempotency conflict/);

  harness.connection.turn = retryTurn("turn_b");
  await handleTtsRetry(harness.connection, { ...request, turn_id: "turn_b" }, harness.helpers);
  assert.equal(harness.synthesisCount(), 2, "a later turn may reuse a retry id without receiving the prior turn receipt");

  for (let index = 0; index < MAX_RECEIPTS + 5; index += 1) {
    harness.connection.turn = retryTurn(`turn_${index + 10}`);
    await handleTtsRetry(harness.connection, {
      type: "retry_tts", turn_id: harness.connection.turn.turnId,
      retry_id: `retry_${index}`, from_text_char: 5,
    }, harness.helpers);
  }
  assert.equal(harness.connection.ttsRetryReceipts.size, MAX_RECEIPTS);
});

function recovery(delivery = "partial") {
  return { delivery, spokenTextEnd: 5, replyTextChars: 10, assistantText: "FirstSecond" };
}

function retryTurn(turnId) {
  return {
    turnId, sessionId: "session", branchId: "default", status: "playback",
    effectiveProfile: {}, providerEvents: { assistantText: "FirstSecond", events: [] },
    ttsRecovery: recovery(),
  };
}

function retryHarness() {
  const events = [];
  const errors = [];
  let syntheses = 0;
  const connection = {
    turn: retryTurn("turn_a"),
    ttsRetryReceipts: new Map(),
    responding: false,
    ws: { readyState: 1 },
    voiceProvider: {
      async synthesizeAssistantSpeech(text, hooks) {
        syntheses += 1;
        await hooks.onAssistantAudioStart(FORMAT);
        await hooks.onAssistantAudioSegment({ text_start: 0, text_end: text.length, text });
        await hooks.sendAudio(Buffer.alloc(2));
        await hooks.onAssistantAudioDone();
        return { spoke: true };
      },
    },
    sendError(message) { errors.push(message); },
    async sendEvent(event) { events.push(event); },
    async recordProviderEvent() {},
    createProviderEvents() { return { events: [] }; },
  };
  return {
    connection, events, errors, synthesisCount: () => syntheses,
    helpers: {
      sanitizeId: (value) => String(value),
      sendWs: async () => {},
      turnReplyLanguage: () => "en-US",
      cleanErrorSummary: (value) => String(value?.message || value),
      assistantAudioFormat: FORMAT,
      webSocketOpen: 1,
    },
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function connect(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    const events = [];
    const waiters = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      events.push(event);
      for (const waiter of waiters.slice()) {
        if (waiter.type === event.type
            && events.filter((candidate) => candidate.type === waiter.type).length >= waiter.occurrence) {
          clearTimeout(waiter.timeout);
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    });
    ws.once("error", reject);
    ws.once("open", () => {
      resolve({
        ws,
        events,
        waitFor(type, occurrence = 1) {
          const existing = events.filter((event) => event.type === type);
          if (existing.length >= occurrence) return Promise.resolve(existing[occurrence - 1]);
          return new Promise((resolveEvent, rejectEvent) => {
            const waiter = { type, occurrence, resolve: resolveEvent };
            waiter.timeout = setTimeout(() => {
              waiters.splice(waiters.indexOf(waiter), 1);
              rejectEvent(new Error(`timed out waiting for ${type} #${occurrence}`));
            }, 5000);
            waiters.push(waiter);
          });
        },
      });
    });
  });
}
