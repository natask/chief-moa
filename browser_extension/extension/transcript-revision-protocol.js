(() => {
  const CAPABILITY = "transcript_revisions_v1";
  const TOKEN = /^[A-Za-z0-9._:-]{1,200}$/;

  const token = (value) => typeof value === "string" && TOKEN.test(value) ? value : "";
  const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const nonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0 ? value : -1;

  function authority(value = {}) {
    const sessionId = token(value.sessionId ?? value.session_id);
    const branchId = token(value.branchId ?? value.branch_id);
    const turnId = token(value.turnId ?? value.turn_id);
    return sessionId && branchId && turnId ? { sessionId, branchId, turnId } : null;
  }

  function sameAuthority(left, right) {
    const a = authority(left), b = authority(right);
    return Boolean(a && b && a.sessionId === b.sessionId && a.branchId === b.branchId && a.turnId === b.turnId);
  }

  function normalizeCapability(value) {
    return value?.supported === true && value?.version === 1 ? { supported: true, version: 1 } : null;
  }

  function reconciliationOptIn({ contextAction = "", retainedAudio = false } = {}) {
    const action = String(contextAction).trim().toLowerCase();
    if (retainedAudio !== true || (action && action !== "continue")) return null;
    return { enabled: true, version: 1, privacy_scope: "retained" };
  }

  function reconciliationSessionFields(input = {}) {
    const consent = reconciliationOptIn(input);
    return consent ? { context_action: "continue", transcript_reconciliation: consent } : {};
  }

  function createState(expected = {}) {
    const bound = authority(expected) || { sessionId: "", branchId: "", turnId: "" };
    return {
      ...bound,
      messageId: `turn:${bound.sessionId}:${bound.branchId}:${bound.turnId}:user`,
      supported: false,
      transcriptSequence: 0,
      revision: 0,
      sealedThroughAudioByte: 0,
      text: "",
      finalizedText: "",
      unsealedText: "",
      terminal: false,
    };
  }

  function acceptReady(state, message) {
    if (!state || message?.type !== "session_ready" || !sameAuthority(state, message)) return false;
    state.supported = Boolean(normalizeCapability(message?.capabilities?.[CAPABILITY]));
    return state.supported;
  }

  function acceptStreamingSnapshot(state, message) {
    if (!state || !["transcript_partial", "transcript_final"].includes(message?.type)) return null;
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text) return null;
    if (!state.supported) {
      state.text = text;
      return { accepted: true, legacy: true, text, partial: message.type === "transcript_partial" };
    }
    const sequence = positiveInteger(message.transcript_sequence);
    if (!sameAuthority(state, message) || message.speaker !== "user" || sequence <= state.transcriptSequence) return null;
    state.transcriptSequence = sequence;
    state.text = text;
    state.terminal = message.type === "transcript_final";
    return { accepted: true, text, partial: !state.terminal, sequence };
  }

  function acceptPrefixRevision(state, message) {
    if (!state?.supported || message?.type !== "transcript_prefix_revision" || !sameAuthority(state, message)) return null;
    const sequence = positiveInteger(message.transcript_sequence);
    const revision = positiveInteger(message.revision);
    const sealedByte = nonNegativeInteger(message.sealed_through_audio_byte);
    const finalizedText = typeof message.finalized_text === "string" ? message.finalized_text.trim() : "";
    const unsealedText = typeof message.unsealed_text === "string" ? message.unsealed_text.trim() : "";
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const joined = [finalizedText, unsealedText].filter(Boolean).join(" ");
    const format = message.audio_format;
    if (message.speaker !== "user" || message.message_id !== state.messageId || !sequence || !revision || sealedByte < 0 || !finalizedText || text !== joined) return null;
    if (format?.encoding !== "pcm16" || format?.sample_rate !== 16000 || format?.channels !== 1) return null;
    if (sequence <= state.transcriptSequence || revision <= state.revision || sealedByte < state.sealedThroughAudioByte) return null;
    Object.assign(state, { transcriptSequence: sequence, revision, sealedThroughAudioByte: sealedByte,
      finalizedText, unsealedText, text });
    return { accepted: true, text, finalizedText, unsealedText, sequence, revision, sealedThroughAudioByte: sealedByte };
  }

  function markTerminal(state) {
    if (state) state.terminal = true;
  }

  function historyKey(message) {
    const bound = authority(message);
    const messageId = token(message?.id ?? message?.message_id);
    if (!bound || !messageId || message?.speaker !== "user") return "";
    return `${bound.sessionId}\u0000${bound.branchId}\u0000${bound.turnId}\u0000${messageId}`;
  }

  function guardHistory(messages, ledger) {
    return messages.map((message) => {
      const key = historyKey(message);
      const revision = nonNegativeInteger(message?.voiceHistory?.currentRevision);
      if (!key || revision < 0 || !["complete", "completed"].includes(String(message.completion || "").toLowerCase())) return message;
      const prior = ledger.get(key);
      if (prior && (prior.revision > revision || (prior.revision === revision && prior.message.text !== message.text))) return prior.message;
      ledger.set(key, { revision, message });
      return message;
    });
  }

  globalThis.AgeeTranscriptRevisionProtocol = Object.freeze({
    CAPABILITY,
    acceptPrefixRevision,
    acceptReady,
    acceptStreamingSnapshot,
    authority,
    createState,
    guardHistory,
    historyKey,
    markTerminal,
    normalizeCapability,
    reconciliationOptIn,
    reconciliationSessionFields,
    sameAuthority,
  });
})();
