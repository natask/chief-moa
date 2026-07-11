function sampleFailureMessage(sampleIndex, message) {
  const detail = String(message || "").trim();
  return detail || `Voice sample ${sampleIndex + 1} failed.`;
}

export function createVoiceSamplerRuntime({ send, startSample, closeSession }) {
  const samplersByTabId = new Map();
  const samplersBySessionId = new Map();

  function isCurrentSampler(sampler) {
    return !!sampler && !sampler.cancelled && samplersByTabId.get(sampler.tabId) === sampler;
  }

  function isCurrentLaunch(sampler, launchId) {
    return isCurrentSampler(sampler) && sampler.activeLaunchId === launchId;
  }

  function closeSamplerSession(sampler, sessionId, reason) {
    const id = String(sessionId || "").trim();
    if (!id || sampler?.lastClosedSessionId === id) return;
    if (sampler?.activeSessionId === id) sampler.activeSessionId = null;
    samplersBySessionId.delete(id);
    if (sampler) sampler.lastClosedSessionId = id;
    closeSession(id, reason);
  }

  function finishSampler(sampler) {
    if (!sampler || sampler.cancelled) return;
    sampler.cancelled = true;
    sampler.detachAbort?.();
    sampler.detachAbort = null;
    samplersByTabId.delete(sampler.tabId);
  }

  function completeSampler(sampler) {
    if (!isCurrentSampler(sampler)) return;
    finishSampler(sampler);
    send(sampler.tabId, {
      cmd: "done",
      cueId: sampler.cueId,
      summary: `Finished ${sampler.samples.length} voice samples.`,
      speak: "",
    });
  }

  function failSampler(sampler, text) {
    if (!isCurrentSampler(sampler)) return;
    const activeSessionId = sampler.activeSessionId;
    finishSampler(sampler);
    closeSamplerSession(sampler, activeSessionId, "sample failed");
    send(sampler.tabId, {
      cmd: "error",
      cueId: sampler.cueId,
      text: String(text || "Voice sampler failed."),
    });
  }

  async function playNextSample(sampler) {
    if (!isCurrentSampler(sampler)) return;
    if (sampler.index >= sampler.samples.length) {
      completeSampler(sampler);
      return;
    }

    const sampleIndex = sampler.index;
    const sample = sampler.samples[sampleIndex];
    const launchId = sampler.activeLaunchId + 1;
    sampler.activeLaunchId = launchId;
    sampler.activeSessionId = null;

    send(sampler.tabId, {
      cmd: "progress",
      cueId: sampler.cueId,
      text: `sampling ${sample.voice} (${sampleIndex + 1} of ${sampler.samples.length})…`,
    });

    const onSessionCreated = (sessionId) => {
      const id = String(sessionId || "").trim();
      if (!id) return;
      if (!isCurrentLaunch(sampler, launchId)) {
        closeSamplerSession(sampler, id, "stale sampler session");
        return;
      }
      sampler.activeSessionId = id;
      samplersBySessionId.set(id, { sampler, launchId, sampleIndex });
    };

    let session;
    try {
      session = await startSample({
        sampler,
        sample,
        sampleIndex,
        onSessionCreated,
      });
    } catch (error) {
      if (!isCurrentLaunch(sampler, launchId)) return;
      throw error;
    }

    const sessionId = String(session?.voiceSessionId || "").trim();
    if (!sessionId) return;
    onSessionCreated(sessionId);
    if (!isCurrentLaunch(sampler, launchId)) {
      closeSamplerSession(sampler, sessionId, "stale sampler session");
    }
  }

  function cancel(tabId, reason = "cancelled") {
    const sampler = samplersByTabId.get(tabId);
    if (!sampler) return false;
    const activeSessionId = sampler.activeSessionId;
    finishSampler(sampler);
    closeSamplerSession(sampler, activeSessionId, reason);
    return true;
  }

  async function start(tabId, cueId, samples, { signal } = {}) {
    cancel(tabId, "superseded");
    const sampler = {
      tabId,
      cueId,
      samples: Array.isArray(samples) ? samples.slice() : [],
      index: 0,
      activeLaunchId: 0,
      activeSessionId: null,
      lastClosedSessionId: null,
      cancelled: false,
      detachAbort: null,
    };
    samplersByTabId.set(tabId, sampler);
    const abort = () => cancel(tabId, "cancelled");
    signal?.addEventListener?.("abort", abort, { once: true });
    sampler.detachAbort = () => signal?.removeEventListener?.("abort", abort);
    if (signal?.aborted) {
      cancel(tabId, "cancelled");
      return;
    }
    try {
      await playNextSample(sampler);
    } catch (error) {
      if (!isCurrentSampler(sampler)) return;
      failSampler(sampler, `Voice sampler failed: ${String(error?.message || error)}`);
    }
  }

  function handleSessionTerminal(sessionId, { failed = false, message = "", closeReason } = {}) {
    const id = String(sessionId || "").trim();
    const entry = samplersBySessionId.get(id);
    if (!entry) return false;
    samplersBySessionId.delete(id);
    const { sampler, launchId, sampleIndex } = entry;
    if (sampler.activeSessionId === id) sampler.activeSessionId = null;
    if (!isCurrentLaunch(sampler, launchId) || sampler.index !== sampleIndex) {
      closeSamplerSession(sampler, id, closeReason || "stale sampler session");
      return true;
    }
    closeSamplerSession(sampler, id, closeReason || (failed ? "sample failed" : "sample complete"));
    if (failed) {
      failSampler(sampler, sampleFailureMessage(sampleIndex, message));
      return true;
    }
    sampler.index += 1;
    playNextSample(sampler).catch((error) => {
      if (!isCurrentSampler(sampler)) return;
      failSampler(sampler, `Voice sampler failed: ${String(error?.message || error)}`);
    });
    return true;
  }

  return {
    start,
    cancel,
    handleSessionTerminal,
  };
}
