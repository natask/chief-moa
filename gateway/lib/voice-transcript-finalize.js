"use strict";

async function handleTranscriptFinalize(connection, event, helpers) {
  if (connection.responding) {
    connection.sendError("turn is already being finalized");
    return;
  }
  const turn = connection.currentTurnFor(event.turn_id);
  if (!turn) return;
  if (turn.status !== "recording") {
    connection.sendError(`turn is not recordable: ${turn.status}`);
    return;
  }
  if (turn.liveSession || typeof connection.voiceProvider?.transcribeTurn !== "function") {
    connection.sendError("active voice provider cannot finalize this capture without reasoning");
    return;
  }

  connection.responding = true;
  const providerEvents = turn.providerEvents || connection.createProviderEvents(turn);
  turn.providerEvents = providerEvents;
  const providerHooks = connection.providerHooks(turn, providerEvents);
  try {
    await connection.phraseAssist.stop(turn);
    turn.status = "committed";
    turn.transcriptionOnly = true;
    turn.finalizeTranscriptOnly = true;
    turn.captureSummary = helpers.captureSummaryForTurn(turn, { inputKind: "audio" });
    turn.transportSummary = helpers.transportSummaryForTurn(turn, "audio");
    await connection.recordProviderEvent(turn, providerEvents, "transcript_finalize_requested", {
      audio_bytes: turn.audioBytes,
      audio_chunks: turn.audioChunks,
    });
    await helpers.closeAudioStream(turn);
    const providerResult = await connection.voiceProvider.transcribeTurn(turn, providerHooks);
    assertTranscriptOnlyProviderResult(providerResult);
    if (connection.turn !== turn || turn.completing) return;
    turn.completing = true;
    await connection.completeTurnWithProviderResult(turn, providerEvents, providerResult);
  } catch (error) {
    await connection.failCommittedTurn(turn, providerEvents, error);
  } finally {
    connection.responding = false;
  }
}

async function completeTranscriptFinalization(
  connection,
  turn,
  providerEvents,
  providerResult,
  canonicalRecord,
  transcript,
  helpers,
) {
  const completionMs = Math.max(0, helpers.elapsedMsSince(turn.startedAt));
  providerEvents.stageTimings.completion_ms = completionMs;
  await connection.recordProviderEvent(turn, providerEvents, "transcript_finalized", {
    transcript,
    duration_ms: completionMs,
    stage_timings: helpers.sanitizeStageTimings(providerEvents.stageTimings),
    stored: Boolean(canonicalRecord),
  });
  connection.stopTurnProgress();
  turn.status = "completed";
  helpers.writeTurnMetadata(turn, {
    status: "completed",
    completed_at: helpers.nowIso(),
    transcription_only: true,
  });
  await connection.sendTurnDone({
    type: "transcript_finalized",
    session_id: turn.sessionId,
    branch_id: turn.branchId,
    turn_id: turn.turnId,
    status: "completed",
    transcript,
    transcription_only: true,
    stored: Boolean(canonicalRecord),
    reply_language: helpers.turnReplyLanguage(turn, providerResult, canonicalRecord),
    input_languages: helpers.turnInputLanguages(turn),
  });
  if (connection.turn === turn) connection.turn = null;
}

async function completeNoSpeech(
  connection,
  turn,
  providerEvents,
  providerResult,
  transcriptQualityRejected,
  helpers,
) {
  await connection.recordProviderEvent(turn, providerEvents, "turn_no_speech", {
    reason: transcriptQualityRejected ? "transcript_quality_rejected" : "stt_empty",
    audio_bytes: turn.audioBytes,
    transcript_language_rejected: providerResult?.transcript_language_rejected === true,
    ...(providerResult?.transcript_quality ? { transcript_quality: providerResult.transcript_quality } : {}),
  });
  helpers.writeTurnMetadata(turn, {
    status: "no_speech",
    completed_at: helpers.nowIso(),
    transcript_language_rejected: providerResult?.transcript_language_rejected === true,
    ...(providerResult?.transcript_quality ? { transcript_quality: providerResult.transcript_quality } : {}),
  });
  turn.status = "no_speech";
  connection.stopTurnProgress();
  await connection.sendTurnDone({
    type: turn.finalizeTranscriptOnly ? "transcript_finalized" : "turn_done",
    session_id: turn.sessionId,
    branch_id: turn.branchId,
    turn_id: turn.turnId,
    status: "no_speech",
    ...(turn.finalizeTranscriptOnly
      ? { transcript: "", transcription_only: true, stored: false }
      : {}),
    reason: transcriptQualityRejected ? "transcript_quality_rejected" : "stt_empty",
    reply_language: helpers.turnReplyLanguage(turn, providerResult, null),
    input_languages: helpers.turnInputLanguages(turn),
    ...(providerResult?.transcript_quality ? { transcript_quality: providerResult.transcript_quality } : {}),
  });
  if (connection.turn === turn) connection.turn = null;
}

function assertTranscriptOnlyProviderResult(result) {
  if (!result || result.transcription_only !== true) {
    throw new Error("voice provider did not return a transcription-only result");
  }
  if (String(result.assistant_text || "").trim()) {
    throw new Error("transcription-only provider returned assistant text");
  }
  if (Array.isArray(result.actions) && result.actions.length > 0) {
    throw new Error("transcription-only provider returned actions");
  }
}

function transcriptionOnlyResult(provider, model, transcript, audioFormat, extras = {}) {
  return {
    provider,
    model,
    transcript,
    assistant_text: "",
    audio_format: audioFormat,
    transcription_only: true,
    ...extras,
  };
}

module.exports = {
  completeNoSpeech,
  completeTranscriptFinalization,
  handleTranscriptFinalize,
  transcriptionOnlyResult,
};
