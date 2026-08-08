function createVoiceSessionAdmission(options) {
  const fixedProvider = options.voiceProvider || null;
  const providers = new Map();
  const factory = typeof options.voiceProviderFactory === "function"
    ? options.voiceProviderFactory
    : options.defaultVoiceProviderFactory;
  const readMode = typeof options.voiceModeAdmission === "function" ? options.voiceModeAdmission : () => null;
  const applyMode = typeof options.applyVoiceModeToProfile === "function"
    ? options.applyVoiceModeToProfile
    : (profile) => profile;
  const agentProfile = options.agentProfile || null;

  function getProvider(profile) {
    if (fixedProvider) return fixedProvider;
    const key = providerKey(profile);
    if (!providers.has(key)) providers.set(key, factory(profile));
    return providers.get(key);
  }

  async function admit({ deviceId, sessionId, branchId, turnId, sendEvent, onDenied, effectiveProfile, profileVersion }) {
    const admission = readMode(deviceId);
    if (admission?.routing?.provider_work_allowed !== false) {
      const profile = deepFreeze({ ...applyMode(effectiveProfile || {}, admission) });
      return { admission, provider: getProvider(profile), effectiveProfile: profile,
        profileVersion: profileVersion || "profile_v0001", providerBundle: providerKey(profile),
        providerSelection: selectionDiagnostic(deviceId, profile) };
    }
    if (typeof onDenied === "function") onDenied();
    const endpoint = admission.routing.capture_endpoint || "/v1/audio-notes";
    const action = { type: "capture_audio_note", endpoint };
    await sendEvent({
      type: "mode_admission", session_id: sessionId, branch_id: branchId, turn_id: turnId,
      status: "note_capture_required", mode: admission.mode, mode_version: admission.version,
      routing: admission.routing, action,
    });
    await sendEvent({
      type: "turn_done", session_id: sessionId, branch_id: branchId, turn_id: turnId,
      status: "note_capture_required", mode: admission.mode, mode_version: admission.version,
      actions: [action],
    });
    return { admission, provider: null };
  }

  return {
    admit,
    applyProfile: (profile, admission) => applyMode(profile, admission),
    effectiveProfile: (deviceId) => agentProfile && typeof agentProfile.effective === "function"
      ? agentProfile.effective(deviceId ? { deviceId } : {}) : null,
    profileVersion(deviceId) {
      const value = agentProfile && typeof agentProfile.currentVersion === "function"
        ? agentProfile.currentVersion(deviceId ? { deviceId } : {}) : "profile_v0001";
      try {
        return options.sanitizeId(value, "profile_version");
      } catch {
        return "profile_v0001";
      }
    },
    status: () => ({ ...getProvider(null).status(), provider_selection: {
      scope: "boot_default",
      provider_bundle: "boot-default",
      note: "runtime health default; admitted turns may use a device-effective profile",
    } }),
  };
}

function selectionDiagnostic(deviceId, profile) {
  return {
    scope: deviceId ? "device_effective" : "global_effective",
    device_id: deviceId || "",
    provider_bundle: providerKey(profile),
  };
}

function providerKey(profile) {
  if (!profile) return "boot-default";
  return [profile.voice_provider, profile.stt_provider, profile.reasoning_provider,
    profile.tts_provider, profile.model].map((value) => String(value || "").trim()).join("|");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = { createVoiceSessionAdmission };
