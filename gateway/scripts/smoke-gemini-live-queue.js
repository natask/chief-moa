#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");
const { createVoiceProvider } = require("../lib/voice-providers");

main().catch((error) => {
  console.error(`smoke-gemini-live-queue: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});

async function main() {
  assertVertexLiveRegionalDefaults();

  const received = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");

  server.on("connection", (ws) => {
    ws.on("message", (data) => {
      const message = JSON.parse(Buffer.from(data).toString("utf8"));
      received.push(message);

      if (message.setup) {
        setTimeout(() => {
          ws.send(JSON.stringify({ setupComplete: {} }));
        }, 50);
        return;
      }

      if (message.realtimeInput?.audioStreamEnd) {
        ws.send(JSON.stringify({
          serverContent: {
            inputTranscription: { text: "the first couple sections are not" },
          },
        }));
        ws.send(JSON.stringify({
          serverContent: {
            inputTranscription: { text: "not properly sent" },
          },
        }));
        ws.send(JSON.stringify({
          serverContent: {
            inputTranscription: { text: "only the last couple sections get sent" },
            outputTranscription: { text: "ready" },
            modelTurn: {
              parts: [{
                inlineData: {
                  mimeType: "audio/pcm;rate=24000",
                  data: Buffer.alloc(960).toString("base64"),
                },
              }],
            },
            turnComplete: true,
          },
        }));
      }
    });
  });

  try {
    const { port } = server.address();
    const provider = createVoiceProvider({
      env: {
        VOICE_PROVIDER: "gemini-live",
        GEMINI_API_KEY: "test-key",
        GEMINI_LIVE_ENDPOINT: `ws://127.0.0.1:${port}/v1beta/fake-live`,
        GEMINI_LIVE_MODEL: "fake-live-model",
      },
      systemPrompt: "test prompt",
    });
    const events = [];
    let assistantAudioBytes = 0;
    const liveSession = provider.createLiveTurnSession({
      format: {
        encoding: "pcm16",
        sample_rate: 16000,
        channels: 1,
      },
    }, {
      onTranscriptPartial: async (text) => events.push(["transcript_partial", text]),
      onTranscriptFinal: async (text) => events.push(["transcript_final", text]),
      onAssistantText: async (text) => events.push(["assistant_text", text]),
      onAssistantAudioStart: async () => events.push(["assistant_audio_start"]),
      sendAudio: async (chunk) => {
        assistantAudioBytes += Buffer.byteLength(chunk);
      },
      onAssistantAudioDone: async () => events.push(["assistant_audio_done"]),
    });

    liveSession.sendAudio(Buffer.alloc(640, 1));
    liveSession.commit();

    const result = await withTimeout(liveSession.done, 2000);
    const setupIndex = received.findIndex((message) => message.setup);
    const audioIndex = received.findIndex((message) => message.realtimeInput?.audio);
    const endIndex = received.findIndex((message) => message.realtimeInput?.audioStreamEnd);

    assert.ok(setupIndex >= 0, "provider must send setup");
    assert.ok(audioIndex > setupIndex, "queued audio must be sent after setup");
    assert.ok(endIndex > audioIndex, "audioStreamEnd must be sent after queued audio");
    assert.equal(
      result.transcript,
      "the first couple sections are not properly sent only the last couple sections get sent",
    );
    assert.equal(result.assistant_text, "ready");
    assert.ok(assistantAudioBytes > 0, "inline assistant audio must be forwarded");
    assert.ok(events.some(([type]) => type === "transcript_partial"), "transcript hook must fire");

    console.log("smoke-gemini-live-queue: ok");
  } finally {
    await closeServer(server);
  }
}

function assertVertexLiveRegionalDefaults() {
  const provider = createVoiceProvider({
    env: {
      VOICE_PROVIDER: "vertex-live",
      VERTEX_PROJECT: "test-project",
      VERTEX_LOCATION: "global",
    },
  });
  assert.equal(provider.status().location, "us-central1");
  assert.equal(
    provider.status().endpoint,
    "wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent",
  );
  assert.equal(
    provider.setupMessage({}).model,
    "projects/test-project/locations/us-central1/publishers/google/models/gemini-live-2.5-flash-native-audio",
  );

  const overrideProvider = createVoiceProvider({
    env: {
      VOICE_PROVIDER: "vertex-live",
      VERTEX_PROJECT: "test-project",
      VERTEX_LOCATION: "global",
      VERTEX_LIVE_LOCATION: "europe-west4",
    },
  });
  assert.equal(overrideProvider.status().location, "europe-west4");
  assert.equal(
    overrideProvider.status().endpoint,
    "wss://europe-west4-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent",
  );
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    promise.then((value) => {
      clearTimeout(timeout);
      resolve(value);
    }, (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
