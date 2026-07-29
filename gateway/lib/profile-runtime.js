const { normalizeDeviceId } = require("./agent-profile");

function createProfileRuntime({
  agentProfile,
  activeCompanionPayload,
  modelId,
  modelProvider,
  modelOptions = () => "",
  profileOptionsPayload,
  sendJson,
  truncate,
}) {
  function profileOptionsFromUrl(url) {
    const requestedScope = String(url.searchParams.get("scope") || url.searchParams.get("profile_scope") || "global").toLowerCase();
    const deviceId = normalizeDeviceId(url.searchParams.get("device_id") || url.searchParams.get("deviceId") || "");
    return {
      scope: requestedScope === "device" && deviceId ? "device" : "global",
      requested_scope: requestedScope === "device" ? "device" : "global",
      deviceId,
    };
  }

  function gatewayModelOptions() {
    const models = [];
    const seen = new Set();
    function add(id, patch = {}) {
      const idValue = String(id || "").trim();
      if (!idValue || seen.has(idValue)) return;
      seen.add(idValue);
      models.push({
        id: idValue,
        label: patch.label || idValue,
        provider: patch.provider || modelProvider,
        current: patch.current === true,
      });
    }
    add(modelId, { current: true });
    for (const raw of String(modelOptions() || "").split(/[,;\n]+/)) add(raw);
    return models;
  }

  function gatewayProfileOptionsPayload() {
    return profileOptionsPayload({ models: gatewayModelOptions() });
  }

  function profileDeviceIdFromBody(body) {
    return normalizeDeviceId(
      body?.device_id || body?.deviceId || body?.client?.device_id
      || body?.client?.deviceId || body?.client_id || "",
    );
  }

  function profileScopeFromBody(body, fallback = "global") {
    const raw = String(body?.scope || body?.profile_scope || body?.client?.profile_scope || fallback || "global").toLowerCase();
    return raw === "device" || raw === "current_device" || raw === "this_device" ? "device" : "global";
  }

  function profileOptionsFromBody(body, fallbackScope = "global") {
    const deviceId = profileDeviceIdFromBody(body);
    const requestedScope = profileScopeFromBody(body, fallbackScope);
    return {
      scope: requestedScope === "device" && deviceId ? "device" : "global",
      requested_scope: requestedScope,
      deviceId,
    };
  }

  function requireDeviceScope(response, options) {
    if (options.requested_scope === "device" && !options.deviceId) {
      sendJson(response, 400, { error: "device_id is required for device-scoped profile changes" });
      return false;
    }
    return true;
  }

  function normalizedProfileOptions(options = {}) {
    const deviceId = normalizeDeviceId(options.deviceId || options.device_id || "");
    return { scope: options.scope === "device" && deviceId ? "device" : "global", deviceId };
  }

  function agentProfilePayload(extra = {}, options = {}) {
    const profileOptions = normalizedProfileOptions(options);
    const profile = agentProfile.effective(profileOptions);
    return {
      profile,
      profile_version: agentProfile.currentVersion(profileOptions),
      current_version: agentProfile.currentVersion(profileOptions),
      global_version: agentProfile.currentVersion(),
      scope: profileOptions.scope,
      device_id: profileOptions.deviceId || "",
      defaults: agentProfile.defaults(),
      is_overridden: agentProfile.isOverridden(profileOptions),
      fields: agentProfile.fields(),
      options_endpoint: "/v1/agent/profile/options",
      active_companion: activeCompanionPayload(profile),
      ...extra,
    };
  }

  function agentProfileRuntimeStatus(options = {}) {
    const profileOptions = normalizedProfileOptions(options);
    const profile = agentProfile.effective(profileOptions);
    return {
      current_version: agentProfile.currentVersion(profileOptions),
      global_version: agentProfile.currentVersion(),
      scope: profileOptions.scope,
      device_id: profileOptions.deviceId || "",
      is_overridden: agentProfile.isOverridden(profileOptions),
      model: profile.model,
      assistant_name: profile.assistant_name,
      voice: profile.voice,
      voice_max_chars: profile.voice_max_chars,
      system_prompt_preview: truncate(profile.system_prompt || "", 240),
      language: {
        allowed: profile.language || "",
        mode: profile.language_mode,
        primary: profile.language_primary || profile.language || "",
        input: profile.input_languages || "",
        input_primary: profile.input_language_primary || "",
        output: profile.language_output,
        auto_switch: profile.language_auto_switch === true,
      },
      providers: {
        voice_provider: profile.voice_provider,
        stt_provider: profile.stt_provider,
        reasoning_provider: profile.reasoning_provider,
        tts_provider: profile.tts_provider,
      },
      tool_policy: profile.tool_policy,
      autonomy_level: profile.autonomy_level,
      memory_policy: profile.memory_policy,
      recovery_mode: profile.recovery_mode,
      active_companion: activeCompanionPayload(profile),
    };
  }

  return {
    agentProfilePayload,
    agentProfileRuntimeStatus,
    gatewayProfileOptionsPayload,
    profileDeviceIdFromBody,
    profileOptionsFromBody,
    profileOptionsFromUrl,
    requireDeviceScope,
  };
}

function voiceProfileDiagnostics(profileStatus, providerStatus) {
  const warnings = [];
  const storedProvider = String(profileStatus?.providers?.voice_provider || "").trim();
  const runtimeProvider = String(providerStatus?.provider || providerStatus?.mode || "").trim();
  if (storedProvider && runtimeProvider && storedProvider !== runtimeProvider) {
    warnings.push({
      code: "stored_runtime_provider_drift",
      summary: `Stored voice provider ${storedProvider} differs from effective runtime ${runtimeProvider}.`,
    });
  }
  const inputLanguages = String(profileStatus?.language?.input || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (inputLanguages.length === 1) {
    warnings.push({
      code: "single_input_language_restriction",
      summary: `Speech recognition is restricted to ${inputLanguages[0]}; turns in other languages can be rejected.`,
    });
  }
  return {
    ok: warnings.length === 0,
    stored_voice_provider: storedProvider,
    runtime_voice_provider: runtimeProvider,
    input_languages: inputLanguages,
    warnings,
  };
}

module.exports = { createProfileRuntime, voiceProfileDiagnostics };
