"use strict";

const crypto = require("node:crypto");
const MAX_RETRIES_PER_TURN = 3;
const MAX_RECEIPTS = 32;

async function handleTtsRetry(connection, event, helpers) {
  const turn = connection.turn;
  if (!event.retry_id) return connection.sendError("retry_tts requires retry_id");
  const turnId = helpers.sanitizeId(event.turn_id || "", "turn_id");
  const retryId = helpers.sanitizeId(event.retry_id, "retry_id");
  if (!turn || turn.turnId !== turnId || !["playback", "completed"].includes(turn.status)) {
    return connection.sendError("retry_tts requires the completed active turn");
  }
  const requestedFrom = Number(event.from_text_char);
  const key = `${turn.turnId}:${retryId}`;
  const digest = requestDigest(turn.turnId, retryId, requestedFrom);
  const prior = connection.ttsRetryReceipts.get(key);
  if (prior) {
    if (prior.digest !== digest) return connection.sendError("retry_tts idempotency conflict");
    return connection.sendEvent(prior.receipt);
  }
  const recovery = turn.ttsRecovery;
  if (!recovery || !["partial", "failed"].includes(recovery.delivery)) {
    return connection.sendError("retry_tts requires a recoverable partial or failed TTS receipt");
  }
  if (!Number.isSafeInteger(requestedFrom) || requestedFrom !== recovery.spokenTextEnd) {
    return connection.sendError("retry_tts from_text_char must equal the recorded safe suffix boundary");
  }
  if ((turn.ttsRetryAttempts || 0) >= MAX_RETRIES_PER_TURN) {
    return connection.sendError("retry_tts attempt limit reached");
  }
  if (connection.responding || turn.ttsRetryActive) return connection.sendError("retry_tts is already in progress");
  turn.ttsRetryAttempts = (turn.ttsRetryAttempts || 0) + 1;
  if (!connection.voiceProvider || typeof connection.voiceProvider.synthesizeAssistantSpeech !== "function") {
    return sendReceipt(connection, turn, retryId, digest, {
      status: "error", from_text_char: requestedFrom, tts_error: "hosted TTS retry is unavailable",
    });
  }
  const retryText = recovery.assistantText.slice(requestedFrom);
  if (!retryText.trim() || requestedFrom >= recovery.replyTextChars) {
    return connection.sendError("retry_tts recorded suffix is empty");
  }
  turn.ttsRetryActive = true;
  connection.responding = true;
  await connection.sendEvent(identity(turn, retryId, "tts_retry_started", { from_text_char: requestedFrom }));
  const hooks = retryHooks(connection, turn, retryId, requestedFrom, helpers);
  try {
    const result = await connection.voiceProvider.synthesizeAssistantSpeech(retryText, hooks, {
      language: helpers.turnReplyLanguage(turn, null, null), profile: turn.effectiveProfile,
    });
    const spoke = result?.spoke === true;
    await sendReceipt(connection, turn, retryId, digest, {
      status: spoke ? "completed" : "error", from_text_char: requestedFrom,
      ...(spoke ? { tts_delivery: "complete", tts_complete: true } : {
        tts_delivery: "failed", tts_complete: false,
        tts_error: helpers.cleanErrorSummary(result?.tts_error || "hosted TTS retry produced no audio"),
      }),
    });
  } catch (error) {
    await sendReceipt(connection, turn, retryId, digest, {
      status: "error", from_text_char: requestedFrom, tts_delivery: "failed",
      tts_complete: false, tts_error: helpers.cleanErrorSummary(error),
    });
  } finally {
    turn.ttsRetryActive = false;
    connection.responding = false;
  }
}

function retryHooks(connection, turn, retryId, from, helpers) {
  return {
    isTurnActive: () => connection.turn === turn && connection.ws.readyState === helpers.webSocketOpen,
    onTurnProgress: async () => {}, onStageStart: async () => {}, onStageDone: async () => {}, onStageError: async () => {},
    onAssistantAudioStart: async (format, options = {}) => connection.sendEvent(identity(turn, retryId, "assistant_audio_start", {
      recovery: true, format: format || helpers.assistantAudioFormat,
      ...(Number.isFinite(options.playbackRate) ? { playback_rate: options.playbackRate } : {}),
    })),
    onAssistantAudioSegment: async (segment = {}) => connection.sendEvent(identity(turn, retryId, "assistant_audio_segment", {
      recovery: true, ...segment,
      text_start: from + Math.max(0, Number(segment.text_start) || 0),
      text_end: from + Math.max(0, Number(segment.text_end) || 0),
    })),
    sendAudio: async (chunk) => helpers.sendWs(connection.ws, chunk, { binary: true }),
    onAssistantAudioDone: async () => connection.sendEvent(identity(turn, retryId, "assistant_audio_done", {
      recovery: true, complete: true, tts_delivery: "complete",
    })),
  };
}

async function sendReceipt(connection, turn, retryId, digest, details) {
  const receipt = identity(turn, retryId, "tts_retry_done", details);
  const key = `${turn.turnId}:${retryId}`;
  connection.ttsRetryReceipts.set(key, { digest, receipt });
  while (connection.ttsRetryReceipts.size > MAX_RECEIPTS) {
    connection.ttsRetryReceipts.delete(connection.ttsRetryReceipts.keys().next().value);
  }
  await connection.recordProviderEvent(turn, turn.providerEvents || connection.createProviderEvents(turn), "tts_retry_done", receipt);
  await connection.sendEvent(receipt);
}

function requestDigest(turnId, retryId, from) {
  return crypto.createHash("sha256").update(JSON.stringify({ turn_id: turnId, retry_id: retryId, from_text_char: from })).digest("hex");
}

function identity(turn, retryId, type, details) {
  return { type, session_id: turn.sessionId, branch_id: turn.branchId, turn_id: turn.turnId, retry_id: retryId, ...details };
}

module.exports = { handleTtsRetry, MAX_RECEIPTS, MAX_RETRIES_PER_TURN };
