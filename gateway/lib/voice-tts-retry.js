"use strict";

async function handleTtsRetry(connection, event, helpers) {
  const turn = connection.turn;
  const requestedTurnId = helpers.sanitizeId(event.turn_id || "", "turn_id");
  const retryId = helpers.sanitizeId(event.retry_id || helpers.randomId("tts_retry"), "retry_id");
  if (!turn || turn.turnId !== requestedTurnId || !["playback", "completed"].includes(turn.status)) {
    connection.sendError("retry_tts requires the completed active turn");
    return;
  }
  const priorReceipt = connection.ttsRetryReceipts.get(retryId);
  if (priorReceipt) {
    await connection.sendEvent(priorReceipt);
    return;
  }
  if (connection.responding || turn.ttsRetryActive) {
    connection.sendError("retry_tts is already in progress");
    return;
  }
  if (!connection.voiceProvider || typeof connection.voiceProvider.synthesizeAssistantSpeech !== "function") {
    await sendReceipt(connection, turn, retryId, { status: "error", from_text_char: 0, tts_error: "hosted TTS retry is unavailable" });
    return;
  }
  const assistantText = String(turn.providerEvents?.assistantText || "").trim();
  const requestedFrom = Number(event.from_text_char);
  const fromTextChar = Number.isFinite(requestedFrom) ? Math.max(0, Math.min(assistantText.length, Math.round(requestedFrom))) : 0;
  const retryText = assistantText.slice(fromTextChar).trimStart();
  const effectiveFrom = fromTextChar + assistantText.slice(fromTextChar).length - retryText.length;
  if (!retryText) {
    await sendReceipt(connection, turn, retryId, { status: "error", from_text_char: effectiveFrom, tts_error: "retry_tts has no remaining assistant text" });
    return;
  }
  turn.ttsRetryActive = true;
  connection.responding = true;
  await connection.sendEvent(identity(turn, retryId, "tts_retry_started", { from_text_char: effectiveFrom }));
  const hooks = {
    isTurnActive: () => connection.turn === turn && connection.ws.readyState === helpers.webSocketOpen,
    onTurnProgress: async () => {}, onStageStart: async () => {}, onStageDone: async () => {}, onStageError: async () => {},
    onAssistantAudioStart: async (format, options = {}) => connection.sendEvent(identity(turn, retryId, "assistant_audio_start", {
      recovery: true, format: format || helpers.assistantAudioFormat,
      ...(Number.isFinite(options.playbackRate) ? { playback_rate: options.playbackRate } : {}),
    })),
    onAssistantAudioSegment: async (segment = {}) => connection.sendEvent(identity(turn, retryId, "assistant_audio_segment", {
      recovery: true, ...segment,
      text_start: effectiveFrom + Math.max(0, Number(segment.text_start) || 0),
      text_end: effectiveFrom + Math.max(0, Number(segment.text_end) || 0),
    })),
    sendAudio: async (chunk) => helpers.sendWs(connection.ws, chunk, { binary: true }),
    onAssistantAudioDone: async () => connection.sendEvent(identity(turn, retryId, "assistant_audio_done", {
      recovery: true, complete: true, tts_delivery: "complete",
    })),
  };
  try {
    const result = await connection.voiceProvider.synthesizeAssistantSpeech(retryText, hooks, {
      language: helpers.turnReplyLanguage(turn, null, null), profile: turn.effectiveProfile,
    });
    const spoke = result?.spoke === true;
    await sendReceipt(connection, turn, retryId, {
      status: spoke ? "completed" : "error", from_text_char: effectiveFrom,
      ...(spoke ? { tts_delivery: "complete", tts_complete: true } : {
        tts_delivery: "failed", tts_complete: false,
        tts_error: helpers.cleanErrorSummary(result?.tts_error || "hosted TTS retry produced no audio"),
      }),
    });
  } catch (error) {
    await sendReceipt(connection, turn, retryId, {
      status: "error", from_text_char: effectiveFrom, tts_delivery: "failed",
      tts_complete: false, tts_error: helpers.cleanErrorSummary(error),
    });
  } finally {
    turn.ttsRetryActive = false;
    connection.responding = false;
  }
}

async function sendReceipt(connection, turn, retryId, details) {
  const receipt = identity(turn, retryId, "tts_retry_done", details);
  connection.ttsRetryReceipts.set(retryId, receipt);
  await connection.recordProviderEvent(turn, turn.providerEvents || connection.createProviderEvents(turn), "tts_retry_done", receipt);
  await connection.sendEvent(receipt);
}

function identity(turn, retryId, type, details) {
  return { type, session_id: turn.sessionId, branch_id: turn.branchId, turn_id: turn.turnId, retry_id: retryId, ...details };
}

module.exports = { handleTtsRetry };
