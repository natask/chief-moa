"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGatewayHealthHandlers } = require("../lib/gateway-health-handlers");

function harness(overrides = {}) {
  const deps = {
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    build: { sha: "abc" },
    runtimeMode: { mode: "remote", health: () => ({ mode: "remote" }) },
    remoteMode: "required",
    trustProxy: true,
    host: "127.0.0.1",
    port: 8787,
    publicGatewayUrl: "https://gateway.test",
    provider: "vertex",
    model: "gemini",
    modelBaseUrl: "https://model.test",
    providerConfigured: () => true,
    vertexProject: "project",
    vertexLocation: "location",
    vertexCredentialHint: () => "adc",
    dataDir: "/data",
    voiceTurnsDir: "/voice",
    audioNotes: { status: () => ({ count: 1 }) },
    videoNotes: { status: () => ({ count: 2 }) },
    blobStore: { status: () => ({ backend: "local" }) },
    voiceSessionServer: {
      sessionsDir: "/sessions",
      endpoint: "/v1/voice/stream",
      status: () => ({ provider: "cascaded", assistant_audio_format: { encoding: "wav" } }),
      activityStatus: () => ({ active: 1 }),
    },
    agentProfileRuntimeStatus: () => ({ voice: "default" }),
    voiceProfileDiagnostics: (profile, provider) => ({ profile, provider: provider.provider }),
    livekitStatus: () => ({ enabled: false }),
    androidOtaHealth: () => ({ available: true }),
    eventStatus: async () => ({ count: 3 }),
    deviceClientsFile: "/devices.json",
    toolRequestsDir: "/requests",
    listDeviceClients: () => [{ id: "phone" }],
    listToolRequests: (query) => query.status === "pending" && query.limit === 100 ? [{ id: "tool" }] : [],
    voiceExecuteToolEnabled: () => true,
    cascadedExecuteCapabilities: () => ({ tap: {}, type: {} }),
    agentRunsDir: "/runs",
    harnessWorkdir: "/work",
    defaultHarness: "codex",
    harnessStatus: () => [{ id: "codex" }],
    allowAgentWithoutToken: false,
    workerPullAgentRuns: true,
    workerPull: { status: () => ({ pending: 1 }) },
    nativeWebSearchEnabled: (provider) => provider === "vertex",
    exaApiKey: "configured",
    browserAgentLoop: { dir: "/browser", healthCounts: () => ({ queued: 2 }) },
    accountConnections: { status: () => ({ count: 1 }) },
    accountHealthIntervalMs: 300000,
    releaseControlStatus: () => ({
      configured: true,
      ready: true,
      storage: "postgres",
      endpoint: "/v1/release-control/apps/{application_id}/view",
    }),
    captureTranscriptionStatus: () => ({
      enabled: true,
      running: true,
      queued_observed: 3,
      actively_leased_observed: 2,
      in_flight: 1,
      provider: { provider_id: "chirp", available: true },
    }),
    brain: {
      available: () => true,
      mode: () => "gbrain",
      factsFile: "/facts.json",
      slugPrefix: "moa",
      gbrainHome: "/gbrain",
    },
    brainRecallLimit: 8,
    ...overrides,
  };
  return createGatewayHealthHandlers(deps);
}

const url = (pathname) => new URL(`https://gateway.test${pathname}`);

test("route only handles GET health requests", async () => {
  const handlers = harness();
  assert.equal(await handlers.routeHealth({ method: "POST" }, {}, url("/health")), false);
  assert.equal(await handlers.routeHealth({ method: "GET" }, {}, url("/elsewhere")), false);
  const response = {};
  assert.equal(await handlers.routeHealth({ method: "GET" }, response, url("/health")), true);
  assert.equal(response.status, 200);
  assert.equal(response.payload.ok, true);
});

test("health projection reports configured runtime dependencies", async () => {
  const payload = await harness().healthPayload();
  assert.deepEqual(payload.bind, { host: "127.0.0.1", port: 8787 });
  assert.deepEqual(payload.vertex, { project: "project", location: "location", auth: "adc" });
  assert.equal(payload.voice_stream.assistant_audio_format.encoding, "wav");
  assert.deepEqual(payload.blob_store, { backend: "local" });
  assert.deepEqual(payload.voice_stream.profile_diagnostics, {
    profile: { voice: "default" }, provider: "cascaded",
  });
  assert.equal(payload.agent_loop.token_required, true);
  assert.equal(payload.device_hub.device_count, 1);
  assert.equal(payload.device_hub.pending_tool_requests, 1);
  assert.equal(payload.execute_tool.capability_count, 2);
  assert.equal(payload.web_search.exa_fallback_configured, true);
  assert.deepEqual(payload.browser_agent_tasks, { dir: "/browser", queued: 2 });
  assert.equal(payload.account_connections.health_interval_ms, 300000);
  assert.deepEqual(payload.release_control, {
    configured: true,
    ready: true,
    storage: "postgres",
    endpoint: "/v1/release-control/apps/{application_id}/view",
  });
  assert.deepEqual(payload.capture_transcription, {
    enabled: true,
    running: true,
    queued_observed: 3,
    actively_leased_observed: 2,
    in_flight: 1,
    provider: { provider_id: "chirp", available: true },
  });
  assert.equal(payload.brain.available, true);
  assert.equal(payload.brain.gbrain_home, "/gbrain");
});

test("health projection preserves safe fallbacks for optional configuration", async () => {
  const handlers = harness({
    provider: "openai",
    publicGatewayUrl: "",
    exaApiKey: "",
    captureTranscriptionStatus: null,
    allowAgentWithoutToken: true,
    voiceSessionServer: {
      sessionsDir: "/sessions",
      endpoint: "/stream",
      status: () => ({ provider: "legacy" }),
      activityStatus: () => ({ active: 0 }),
    },
    brain: {
      available: () => false,
      mode: () => "file",
      factsFile: "/facts.json",
      slugPrefix: "moa",
      gbrainHome: "",
    },
  });
  const payload = await handlers.healthPayload();
  assert.equal(payload.vertex, undefined);
  assert.equal(payload.public_gateway_url, undefined);
  assert.deepEqual(payload.voice_stream.assistant_audio_format, {
    encoding: "pcm16", sample_rate: 16000, channels: 1,
  });
  assert.deepEqual(payload.capture_transcription, { enabled: false, running: false });
  assert.equal(payload.agent_loop.token_required, false);
  assert.equal(payload.web_search.exa_fallback_configured, false);
  assert.equal(payload.brain.available, true);
  assert.equal(payload.brain.gbrain_available, false);
  assert.equal(payload.brain.gbrain_home, "default (~/.gbrain)");
});

test("health does not expose release-control credentials", async () => {
  const payload = await harness({
    releaseControlStatus: undefined,
  }).healthPayload();
  assert.deepEqual(payload.release_control, {
    configured: false,
    ready: false,
    storage: "disabled",
  });
  assert.equal(JSON.stringify(payload).includes("postgres://"), false);
});
