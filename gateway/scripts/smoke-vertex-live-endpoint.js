#!/usr/bin/env node
"use strict";

// Regression lock for the Vertex Live 404 break.
//
// With VERTEX_LOCATION=global the Live provider built the socket URL
// `wss://global-aiplatform.googleapis.com/...`. That host does not exist, so
// the ws upgrade failed with "Unexpected server response: 404" and every voice
// session died after session_ready. Text Vertex in server.js already splits
// hosts (bare host for global, `<location>-` prefix for regions); the Live
// provider must never emit a `global-` prefixed host either. On top of that,
// the LlmBidiService publisher model is served regionally, so an ADC session
// with location `global` is pinned to us-central1 while VERTEX_LIVE_LOCATION
// stays available as an explicit per-surface override.
//
// No network, no socket, no secret.

const assert = require("node:assert");
const { createVoiceProvider } = require("../lib/voice-providers");

const BIDI_PATH = "/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent";

main();

function main() {
  assertGlobalAdcPinsServingRegion();
  assertLiveLocationOverrideWins();
  assertRegionalLocationKeepsPrefixedHost();
  assertGlobalNeverBuildsPrefixedHost();
  assertExpressKeyKeepsExpressEndpoint();
  console.log(JSON.stringify({
    ok: true,
    checks: [
      "VERTEX_LOCATION=global ADC pins the Live socket to us-central1",
      "VERTEX_LIVE_LOCATION overrides VERTEX_LOCATION for the Live socket",
      "regional locations keep the <location>-aiplatform host",
      "defaultVertexEndpoint never emits a global-aiplatform host",
      "express API key keeps the bare-host express endpoint",
    ],
  }, null, 2));
}

// Vertex ADC provider (no API key in env) with the given location envs.
function adcProvider(env) {
  const provider = createVoiceProvider({
    env: { VOICE_PROVIDER: "vertex-live", VERTEX_PROJECT: "smoke-project", ...env },
  });
  assert.equal(provider.constructor.name, "GeminiLiveVoiceProvider", "expected a Gemini Live provider");
  assert.equal(provider.authMode, "vertex", "expected vertex auth mode");
  assert.equal(provider.apiKey, "", "ADC scenario must not pick up an API key");
  return provider;
}

function assertGlobalAdcPinsServingRegion() {
  const provider = adcProvider({ VERTEX_LOCATION: "global" });
  assert.equal(provider.vertexLocation, "us-central1", "global must pin to a Live serving region");
  assert.equal(provider.endpoint, `wss://us-central1-aiplatform.googleapis.com${BIDI_PATH}`);
  assert.ok(provider.modelResource().includes("/locations/us-central1/"), "model resource must use the pinned region");
}

function assertLiveLocationOverrideWins() {
  const provider = adcProvider({ VERTEX_LOCATION: "global", VERTEX_LIVE_LOCATION: "europe-west4" });
  assert.equal(provider.vertexLocation, "europe-west4");
  assert.equal(provider.endpoint, `wss://europe-west4-aiplatform.googleapis.com${BIDI_PATH}`);
}

function assertRegionalLocationKeepsPrefixedHost() {
  const provider = adcProvider({ VERTEX_LOCATION: "us-east5" });
  assert.equal(provider.vertexLocation, "us-east5");
  assert.equal(provider.endpoint, `wss://us-east5-aiplatform.googleapis.com${BIDI_PATH}`);
}

function assertGlobalNeverBuildsPrefixedHost() {
  // Guard the endpoint builder directly: even if the region pin is removed or
  // bypassed later, `global` must map to the bare host, never `global-`.
  const provider = adcProvider({ VERTEX_LOCATION: "us-central1" });
  provider.vertexLocation = "global";
  const endpoint = provider.defaultVertexEndpoint(`wss://aiplatform.googleapis.com${BIDI_PATH}`);
  assert.equal(endpoint, `wss://aiplatform.googleapis.com${BIDI_PATH}`);
  assert.ok(!endpoint.includes("global-aiplatform"), "global must never build a global- prefixed host");
}

function assertExpressKeyKeepsExpressEndpoint() {
  const provider = createVoiceProvider({
    env: {
      VOICE_PROVIDER: "vertex-live",
      VERTEX_LOCATION: "global",
      VERTEX_API_KEY: "smoke-key-not-a-secret",
    },
  });
  assert.equal(provider.endpoint, `wss://aiplatform.googleapis.com${BIDI_PATH}`);
}
