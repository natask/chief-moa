"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const { WebSocketServer } = require("ws");
const { createInactivityTimer } = require("../lib/native-voice-reliability");
const { createVoiceProvider } = require("../lib/voice-providers");

test("native provider inactivity deadline moves forward on activity", async () => {
  let fired = 0;
  const timer = createInactivityTimer(40, () => { fired += 1; });
  await delay(25);
  timer.touch();
  await delay(25);
  assert.equal(fired, 0);
  await delay(25);
  assert.equal(fired, 1);
  timer.cancel();
});

test("Gemini Live turnComplete without assistant output is retryable", async (t) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.setup) socket.send(JSON.stringify({ setupComplete: {} }));
    if (message.realtimeInput?.audioStreamEnd) {
      socket.send(JSON.stringify({ serverContent: {
        inputTranscription: { text: "keep this transcript" }, turnComplete: true,
      } }));
    }
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => wss.close(() => server.close(resolve))));

  const provider = createVoiceProvider({ env: {
    VOICE_PROVIDER: "gemini-live", GEMINI_API_KEY: "fixture-key",
    GEMINI_LIVE_ENDPOINT: `ws://127.0.0.1:${server.address().port}`,
    GEMINI_LIVE_TRANSCRIPT_SETTLE_MS: "50",
  } });
  const session = provider.createLiveTurnSession({
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
  }, hooks());
  session.sendAudio(Buffer.alloc(3200, 2));
  session.commit();
  await assert.rejects(session.done, (error) => error?.name === "RetryableVoiceProviderError"
    && error?.code === "native_provider_empty_response" && error?.retryable === true);
});

function hooks() {
  return {
    onTranscriptPartial: async () => {}, onTranscriptFinal: async () => {},
    onAssistantText: async () => {}, onAssistantAudioStart: async () => {},
    sendAudio: async () => {}, onAssistantAudioDone: async () => {},
  };
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
