function createVoiceSessionAdmission(options) {
  let provider = options.voiceProvider || null;
  const factory = typeof options.voiceProviderFactory === "function"
    ? options.voiceProviderFactory
    : options.defaultVoiceProviderFactory;
  const readMode = typeof options.voiceModeAdmission === "function" ? options.voiceModeAdmission : () => null;
  const applyMode = typeof options.applyVoiceModeToProfile === "function"
    ? options.applyVoiceModeToProfile
    : (profile) => profile;
  const agentProfile = options.agentProfile || null;

  function getProvider() {
    provider = provider || factory();
    return provider;
  }

  async function admit({ deviceId, sessionId, branchId, turnId, sendEvent, onDenied }) {
    const admission = readMode(deviceId);
    if (admission?.routing?.provider_work_allowed !== false) {
      return { admission, provider: getProvider() };
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
    status: () => getProvider().status(),
  };
}

module.exports = { createVoiceSessionAdmission };
