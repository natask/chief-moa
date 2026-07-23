export function sanitizeBrowserAgentOwner(owner) {
  if (!owner || typeof owner !== "object") return null;
  const {
    page_url: _pageUrl,
    page_title: _pageTitle,
    last_result: _lastResult,
    ...extensionLocalOwner
  } = owner;
  return extensionLocalOwner;
}

const OWNER_STATUS_RANK = Object.freeze({
  starting: 0,
  listening: 1,
  processing: 2,
  responding: 3,
  completed: 4,
  no_speech: 4,
  error: 4,
  cleared: 5,
});

export function findListeningDictationSession(sessions) {
  for (const session of sessions || []) {
    if (
      session &&
      session.transcriptionOnly === true &&
      session.closed !== true &&
      session.committed !== true
    ) {
      return session;
    }
  }
  return null;
}

export function findActiveDictationSession(sessions) {
  for (const session of sessions || []) {
    if (
      session &&
      session.transcriptionOnly === true &&
      session.closed !== true
    ) {
      return session;
    }
  }
  return null;
}

export function planGlobalDictationToggle(sessions) {
  const active = findActiveDictationSession(sessions);
  if (!active) return { action: "start" };
  if (active.committed) {
    return {
      action: "wait",
      voiceSessionId: active.id,
      ownerTabId: active.tabId,
    };
  }
  return {
    action: "commit",
    voiceSessionId: active.id,
    ownerTabId: active.tabId,
    turnId: active.turnId,
  };
}

export function persistedDictationBlocksStart(owner) {
  const current = sanitizeBrowserAgentOwner(owner);
  return current?.activity === "dictation" &&
    ["starting", "listening", "processing", "responding"].includes(String(current.status || ""));
}

export function planDictationRestartReconciliation({
  owner,
  hasRuntimeSession,
  offscreenCaptureId = null,
  now = Date.now(),
  startingGraceMs = 15_000,
} = {}) {
  const current = sanitizeBrowserAgentOwner(owner);
  if (!persistedDictationBlocksStart(current) || hasRuntimeSession) return { action: "keep" };
  const ageMs = now - Date.parse(current.updated_at || 0);
  if (current.status === "starting" && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < startingGraceMs) {
    return { action: "wait" };
  }
  return {
    action: "reconcile_error",
    stopCaptureId: offscreenCaptureId || null,
  };
}

export function transitionVoiceOwner(owner, voiceSessionId, patch = {}) {
  const current = sanitizeBrowserAgentOwner(owner);
  const id = String(voiceSessionId || "").trim();
  if (!current || !id || String(current.voice_session_id || "") !== id) return null;
  const currentSequence = Number(current.transition_sequence || 0);
  const nextSequence = Number(patch.transition_sequence);
  if (!Number.isSafeInteger(nextSequence) || nextSequence <= currentSequence) return null;
  const currentRank = OWNER_STATUS_RANK[current.status] ?? 0;
  const nextStatus = String(patch.status || current.status || "");
  const nextRank = OWNER_STATUS_RANK[nextStatus] ?? currentRank;
  if (nextRank < currentRank) return null;
  if (currentRank >= OWNER_STATUS_RANK.completed && nextStatus !== current.status && nextStatus !== "cleared") {
    return null;
  }
  return sanitizeBrowserAgentOwner({
    ...current,
    ...patch,
    status: nextStatus,
  });
}
