#!/usr/bin/env node
"use strict";

// Regression lock for the Vertex Live 1007 break.
//
// Native-audio Live models reject any text-output request and close the socket
// with 1007 "Text output is not supported for native audio output model." The
// user speaks and gets nothing back because the provider setup handshake dies
// before any transcript or assistant audio. The setup message must therefore
// never send outputAudioTranscription on a native-audio model, while keeping it
// on non-native Live models, and must always keep inputAudioTranscription (the
// user's STT, a separate capability the 1007 error does not name) so the
// exact-transcript echo-back keeps working.
//
// This asserts the invariant on the built setup payload, not a specific line, so
// it passes however the guard is written and fails the moment anyone reintroduces
// the field. No network, no socket, no secret.

const assert = require("node:assert");
const { createVoiceProvider } = require("../lib/voice-providers");

const NATIVE_AUDIO_MODEL = "gemini-live-2.5-flash-native-audio";
const NON_NATIVE_MODEL = "gemini-2.5-flash-live";

main();

function main() {
  assertNativeAudioOmitsOutputTranscription();
  assertNonNativeKeepsOutputTranscription();
  assertInputTranscriptionAlwaysPresent();
  assertNativeAudioForcesAudioModality();
  console.log(JSON.stringify({
    ok: true,
    checks: [
      "native-audio setup omits outputAudioTranscription (no 1007 text-output request)",
      "non-native Live setup keeps outputAudioTranscription",
      "inputAudioTranscription stays present on both models",
      "native-audio responseModalities is exactly [AUDIO]",
    ],
  }, null, 2));
}

// Build a vertex-live provider pinned to a model, with a throwaway env so no real
// secret is read. VOICE_PROVIDER=vertex-live routes createVoiceProvider to the
// GeminiLiveVoiceProvider; VERTEX_LIVE_MODEL pins the model under test.
function setupFor(model) {
  const provider = createVoiceProvider({
    env: {
      VOICE_PROVIDER: "vertex-live",
      VERTEX_LIVE_MODEL: model,
      VERTEX_PROJECT: "smoke-project",
      VERTEX_API_KEY: "smoke-key-not-a-secret",
    },
  });
  assert.equal(provider.constructor.name, "GeminiLiveVoiceProvider", "expected a Gemini Live provider");
  assert.equal(provider.model, model, "provider did not pin the model under test");
  return provider.setupMessage({});
}

function assertNativeAudioOmitsOutputTranscription() {
  const setup = setupFor(NATIVE_AUDIO_MODEL);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(setup, "outputAudioTranscription"),
    "native-audio setup must NOT request outputAudioTranscription (triggers Vertex 1007)",
  );
}

function assertNonNativeKeepsOutputTranscription() {
  const setup = setupFor(NON_NATIVE_MODEL);
  assert.ok(
    Object.prototype.hasOwnProperty.call(setup, "outputAudioTranscription"),
    "non-native Live setup should keep outputAudioTranscription so the assistant transcript is emitted",
  );
}

function assertInputTranscriptionAlwaysPresent() {
  for (const model of [NATIVE_AUDIO_MODEL, NON_NATIVE_MODEL]) {
    const setup = setupFor(model);
    assert.ok(
      Object.prototype.hasOwnProperty.call(setup, "inputAudioTranscription"),
      `inputAudioTranscription must stay present on ${model} for exact-transcript echo-back`,
    );
  }
}

function assertNativeAudioForcesAudioModality() {
  const setup = setupFor(NATIVE_AUDIO_MODEL);
  assert.deepEqual(
    setup.generationConfig.responseModalities,
    ["AUDIO"],
    "native-audio responseModalities must be exactly [AUDIO]; TEXT closes the socket",
  );
}
