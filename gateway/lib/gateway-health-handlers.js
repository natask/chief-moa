"use strict";

function createGatewayHealthHandlers(deps) {
  const {
    sendJson, build, runtimeMode, remoteMode, trustProxy, host, port,
    publicGatewayUrl, provider, model, modelBaseUrl, providerConfigured,
    vertexCredentialHint, dataDir, voiceTurnsDir, audioNotes, videoNotes,
    voiceSessionServer, agentProfileRuntimeStatus, voiceProfileDiagnostics,
    livekitStatus, androidOtaHealth, eventStatus, deviceClientsFile,
    toolRequestsDir, listDeviceClients, listToolRequests,
    voiceExecuteToolEnabled, cascadedExecuteCapabilities, agentRunsDir,
    harnessWorkdir, defaultHarness, harnessStatus, allowAgentWithoutToken,
    workerPullAgentRuns, workerPull, browserAgentLoop, accountConnections,
    accountHealthIntervalMs, brain, brainRecallLimit, nativeWebSearchEnabled,
    exaApiKey,
  } = deps;

  async function healthPayload() {
    const voiceProvider = voiceSessionServer.status();
    const profileStatus = agentProfileRuntimeStatus();
    return {
      ok: true,
      build,
      mode: runtimeMode.mode,
      gateway_mode: runtimeMode.health(),
      remote_mode: remoteMode,
      trust_proxy: trustProxy,
      bind: { host, port },
      public_gateway_url: publicGatewayUrl || undefined,
      provider,
      model,
      model_base_url: modelBaseUrl,
      provider_configured: providerConfigured(),
      vertex: provider === "vertex" ? {
        project: deps.vertexProject,
        location: deps.vertexLocation,
        auth: vertexCredentialHint(),
      } : undefined,
      data_dir: dataDir,
      voice_router: {
        turns_dir: voiceTurnsDir,
        endpoint: "/v1/voice/turns",
        classification: "heuristic",
        transport: "transcript_http",
      },
      audio_notes: audioNotes.status(),
      video_notes: videoNotes.status(),
      voice_stream: {
        sessions_dir: voiceSessionServer.sessionsDir,
        endpoint: voiceSessionServer.endpoint,
        ticket_endpoint: "/v1/voice/session-ticket",
        provider: voiceProvider,
        profile_diagnostics: voiceProfileDiagnostics(profileStatus, voiceProvider),
        activity: voiceSessionServer.activityStatus(),
        input_format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
        assistant_audio_format: voiceProvider.assistant_audio_format || {
          encoding: "pcm16", sample_rate: 16000, channels: 1,
        },
      },
      agent_profile: profileStatus,
      livekit_voice: livekitStatus(),
      agent_loop: {
        runs_dir: agentRunsDir,
        harness_workdir: harnessWorkdir,
        default_harness: defaultHarness,
        harnesses: harnessStatus(),
        token_required: !allowAgentWithoutToken,
        worker_pull_enabled: workerPullAgentRuns,
        worker_pull: workerPull.status(),
      },
      android_ota: androidOtaHealth(),
      event_substrate: await eventStatus(),
      device_hub: {
        registry_file: deviceClientsFile,
        tool_requests_dir: toolRequestsDir,
        device_count: listDeviceClients().length,
        pending_tool_requests: listToolRequests({ status: "pending", limit: 100 }).length,
      },
      execute_tool: {
        enabled: voiceExecuteToolEnabled(),
        capability_count: Object.keys(cascadedExecuteCapabilities({})).length,
      },
      web_search: {
        native_vertex: nativeWebSearchEnabled("vertex"),
        exa_fallback_configured: Boolean(exaApiKey),
        boundary: "model_tool",
      },
      browser_agent_tasks: {
        dir: browserAgentLoop.dir,
        ...browserAgentLoop.healthCounts(),
      },
      account_connections: {
        ...accountConnections.status(),
        health_interval_ms: accountHealthIntervalMs,
        endpoint: "/v1/account-connections",
      },
      brain: {
        available: brain.available() || brain.mode() === "file",
        mode: brain.mode(),
        gbrain_available: brain.available(),
        facts_file: brain.factsFile,
        recall_limit: brainRecallLimit,
        slug_prefix: brain.slugPrefix,
        gbrain_home: brain.gbrainHome || "default (~/.gbrain)",
      },
    };
  }

  async function routeHealth(request, response, url) {
    if (request.method !== "GET" || url.pathname !== "/health") return false;
    sendJson(response, 200, await healthPayload());
    return true;
  }

  return { healthPayload, routeHealth };
}

module.exports = { createGatewayHealthHandlers };
