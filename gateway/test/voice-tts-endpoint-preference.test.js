"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createVoiceProvider } = require("../lib/voice-providers");

const V1 = "https://texttospeech.googleapis.com/v1/text:synthesize";
const V1BETA1 = "https://texttospeech.googleapis.com/v1beta1/text:synthesize";
const AUDIO_CONTENT = Buffer.alloc(480, 1).toString("base64");

test("model-backed TTS prefers the last successful endpoint and recovers through fallback", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let betaHealthy = true;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const ok = betaHealthy ? String(url) === V1BETA1 : String(url) === V1;
    return {
      ok,
      status: ok ? 200 : 404,
      text: async () => "model is unavailable on this API version",
      json: async () => ({ audioContent: AUDIO_CONTENT }),
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = createVoiceProvider({
    env: {
      VOICE_PROVIDER: "chirp",
      VOICE_REASONING_PROVIDER: "gateway",
      VOICE_TTS_PROVIDER: "gemini-tts",
      GCP_PROJECT_ID: "test-project",
      CHIRP_ACCESS_TOKEN: "test-token",
      GEMINI_TTS_MODEL: "test-gemini-tts-model",
    },
    reasoner: async () => ({}),
  });

  await provider.synthesizeSpeech("first chunk", "en-US");
  await provider.synthesizeSpeech("second chunk", "en-US");
  assert.deepEqual(requests, [V1, V1BETA1, V1BETA1],
    "chunk two must begin on the endpoint that succeeded for chunk one");

  betaHealthy = false;
  await provider.synthesizeSpeech("third chunk", "en-US");
  await provider.synthesizeSpeech("fourth chunk", "en-US");
  assert.deepEqual(requests.slice(3), [V1BETA1, V1, V1],
    "a failed preferred endpoint must fall back and replace the preference");
});
