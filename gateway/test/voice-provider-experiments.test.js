"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  currentConnectionTopology,
  providerExperimentStatus,
  speechToSpeechContract,
} = require("../lib/voice-provider-experiments");

test("provider experiment status reports capability truth without credential values", () => {
  const secret = "must-never-appear";
  const status = providerExperimentStatus({
    OPENAI_API_KEY: secret,
    XAI_API_KEY: secret,
    ANTHROPIC_API_KEY: secret,
    GOOGLE_APPLICATION_CREDENTIALS: "/private/credential.json",
    GOOGLE_CLOUD_PROJECT: "project-id",
  });
  assert.deepEqual(status.map((provider) => provider.id), ["vertex", "openai", "xai", "anthropic"]);
  assert.ok(status.every((provider) => provider.configured));
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.match(status.find((provider) => provider.id === "anthropic").limitation, /No first-party Anthropic duplex audio/);
});

test("Vertex ADC requires both a credential source and project", () => {
  assert.equal(providerExperimentStatus({ GOOGLE_APPLICATION_CREDENTIALS: "/credential.json" })[0].configured, false);
  assert.equal(providerExperimentStatus({ VERTEX_API_KEY: "key" })[0].configured, true);
});

test("connection topology distinguishes phrase HTTP TTS from provider audio streaming", () => {
  const topology = currentConnectionTopology();
  assert.match(topology.client_to_gateway.transport, /WebSocket/);
  assert.match(topology.cascaded_gateway_to_providers.reasoning, /SSE text deltas/);
  assert.match(topology.cascaded_gateway_to_providers.tts, /not provider audio deltas/);
  assert.match(topology.native_audio_gateway_to_provider.lifetime, /one admitted voice turn/);
});

test("all provider experiments preserve one phone-facing speech-to-speech contract", () => {
  const contract = speechToSpeechContract();
  assert.match(contract.client_protocol, /every backend/);
  assert.equal(contract.turn_input.prompt, "caller-controlled voice system instruction");
  assert.ok(contract.streamed_output.includes("PCM audio frames"));
  assert.match(contract.invariant, /phone protocol does not change/);
});
