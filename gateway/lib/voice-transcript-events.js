"use strict";

function createVoiceTranscriptEventHooks(options) {
  const { turn, providerEvents, turnSuperseded, recordProviderEvent, sendEvent } = options;
  const publishTranscript = async (type, text) => {
    if (turnSuperseded()) return;
    const value = String(text || "").trim();
    if (!value) return;
    providerEvents.transcript = value;
    if (type === "transcript_final") providerEvents.transcriptFinalSent = true;
    await recordProviderEvent(type, { text: value });
    await sendEvent({
      type,
      session_id: turn.sessionId,
      branch_id: turn.branchId,
      turn_id: turn.turnId,
      text: value,
    });
  };
  return {
    onTranscriptPartial: (text) => publishTranscript("transcript_partial", text),
    onTranscriptFinal: (text) => publishTranscript("transcript_final", text),
    onTranscriptRejected: async (evidence) => {
      if (turnSuperseded()) return;
      providerEvents.transcript = "";
      providerEvents.transcriptFinalSent = false;
      turn.transcriptLanguageRejected = true;
      await recordProviderEvent("stt_candidate_rejected", evidence || {});
    },
  };
}

module.exports = { createVoiceTranscriptEventHooks };
