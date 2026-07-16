"use strict";

const {
  DELIVERY_INTENTS,
  DeliveryIntentValidationError,
  parseDeliveryIntent,
} = require("./delivery-intent");

function resolveSessionDeliveryIntent(event) {
  if (!Object.prototype.hasOwnProperty.call(event, "delivery_intent")) {
    return { deliveryIntent: DELIVERY_INTENTS.ASSISTANT_RESPONSE };
  }
  try {
    return { deliveryIntent: parseDeliveryIntent(event) };
  } catch (error) {
    if (!(error instanceof DeliveryIntentValidationError)) throw error;
    return { error };
  }
}

function literalSttHooks(deliveryIntent, hooks) {
  if (deliveryIntent !== DELIVERY_INTENTS.LITERAL_TEXT) return hooks;
  return {
    isTurnActive: hooks.isTurnActive,
    onStageStart: hooks.onStageStart,
    onStageDone: hooks.onStageDone,
    onStageError: hooks.onStageError,
    onTranscriptPartial: hooks.onTranscriptPartial,
    onTranscriptFinal: hooks.onTranscriptFinal,
  };
}

async function transcribeLiteralTurn(voiceProvider, turn, inputLanguages) {
  let result;
  if (typeof voiceProvider.finalizeStreamingSttSession === "function") {
    result = await voiceProvider.finalizeStreamingSttSession(turn);
  } else if (typeof voiceProvider.runSttStage === "function") {
    result = await voiceProvider.runSttStage(turn, inputLanguages);
  } else if (turn.sttStream && typeof turn.sttStream.finalize === "function") {
    result = await turn.sttStream.finalize();
  } else {
    const error = new Error("selected voice provider does not expose an STT-only path");
    error.code = "stt_only_unavailable";
    throw error;
  }
  turn.sttStream = null;
  return {
    text: String(result?.text || "").trim(),
    transcript_source: "stt",
    transcript_provider: turn.providerStatus?.stt_provider || turn.providerStatus?.provider || "",
    transcript_language_rejected: result?.languageRejected === true || result?.language_rejected === true,
  };
}

async function completeLiteralTurn(connection, turn, providerEvents, result, helpers) {
  const inputLanguages = helpers.turnInputLanguages(turn);
  const transcript = String(result?.text || "").trim();
  if (!transcript) {
    turn.status = "no_speech";
    connection.stopTurnProgress();
    await connection.recordProviderEvent(turn, providerEvents, "turn_no_speech", { reason: "stt_empty" });
    helpers.writeTurnMetadata(turn, {
      status: "no_speech",
      delivery_intent: DELIVERY_INTENTS.LITERAL_TEXT,
      completed_at: helpers.nowIso(),
    });
    await connection.sendTurnDone({
      type: "turn_done",
      session_id: turn.sessionId,
      branch_id: turn.branchId,
      turn_id: turn.turnId,
      status: "no_speech",
      reason: "stt_empty",
      delivery_intent: DELIVERY_INTENTS.LITERAL_TEXT,
      transcription_only: true,
      input_languages: inputLanguages,
    });
    if (connection.turn === turn) connection.turn = null;
    return;
  }

  const providerHooks = connection.providerHooks(turn, providerEvents);
  if (!providerEvents.transcriptFinalSent) await providerHooks.onTranscriptFinal(transcript);
  const candidate = { kind: DELIVERY_INTENTS.LITERAL_TEXT, text: transcript };
  await connection.recordProviderEvent(turn, providerEvents, "turn_completed", {
    transcript,
    delivery_intent: DELIVERY_INTENTS.LITERAL_TEXT,
    transcription_only: true,
  });
  helpers.writeTurnMetadata(turn, {
    status: "completed",
    delivery_intent: DELIVERY_INTENTS.LITERAL_TEXT,
    completed_at: helpers.nowIso(),
    transcript: {
      final: true,
      text: transcript,
      source: result?.transcript_source || "stt",
      provider: result?.transcript_provider || "",
    },
    literal_candidate: candidate,
  });
  await connection.sendEvent({
    type: "literal_candidate",
    session_id: turn.sessionId,
    branch_id: turn.branchId,
    turn_id: turn.turnId,
    candidate,
  });
  connection.stopTurnProgress();
  await connection.sendTurnDone({
    type: "turn_done",
    session_id: turn.sessionId,
    branch_id: turn.branchId,
    turn_id: turn.turnId,
    status: "completed",
    delivery_intent: DELIVERY_INTENTS.LITERAL_TEXT,
    transcription_only: true,
    candidate,
    input_languages: inputLanguages,
  });
  turn.status = "completed";
  if (connection.turn === turn) connection.turn = null;
}

module.exports = {
  DELIVERY_INTENTS,
  completeLiteralTurn,
  literalSttHooks,
  resolveSessionDeliveryIntent,
  transcribeLiteralTurn,
};
