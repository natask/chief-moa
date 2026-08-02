"use strict";

function createVoiceTranscriptReconcileBridge(connection, runtime, webSocketOpen) {
  return {
    configure(turn, input) {
      if (!runtime || input.incognito || typeof input.provider?.transcribePcmWindowed !== "function") return;
      turn.transcriptReconciler = runtime.createTurn({
        sessionId: turn.sessionId, branchId: turn.branchId, turnId: turn.turnId,
        provider: input.provider, languageCodes: input.languageCodes,
        emitPrefix: (revision) => this.emitPrefix(turn, revision),
      });
    },
    push(turn, chunk) { turn?.transcriptReconciler?.push(chunk); },
    seal(turn, segment) { turn?.transcriptReconciler?.seal(segment); },
    finish(turn) { turn?.transcriptReconciler?.finish({ pcmPath: turn.pcmPath }); },
    abandon(turn) { turn?.transcriptReconciler?.abandon(); },
    capability(turn) { return { supported: Boolean(turn?.transcriptReconciler), version: 1 }; },
    sequence(turn) { turn.transcriptSequence = (turn.transcriptSequence || 0) + 1; return turn.transcriptSequence; },
    async emitPrefix(turn, revision) {
      if (!turn || !revision?.finalizedText || connection.ws.readyState !== webSocketOpen) return;
      const snapshot = turn.sttStream?.snapshot?.();
      const unsealedText = transcriptTailAfter(snapshot, revision.sealedThroughAudioByte);
      const finalizedText = String(revision.finalizedText || "").trim();
      await connection.sendEvent({
        type: "transcript_prefix_revision", session_id: turn.sessionId, branch_id: turn.branchId,
        turn_id: turn.turnId, message_id: `turn:${turn.sessionId}:${turn.branchId}:${turn.turnId}:user`,
        speaker: "user", transcript_sequence: this.sequence(turn), revision: revision.revision,
        finalized_text: finalizedText, unsealed_text: unsealedText,
        text: [finalizedText, unsealedText].filter(Boolean).join(" "),
        sealed_through_audio_byte: revision.sealedThroughAudioByte, audio_format: turn.format,
        source: "automatic_reconcile", updated_at: new Date().toISOString(),
      });
    },
  };
}

function transcriptTailAfter(snapshot, sealedThroughAudioByte) {
  if (!snapshot) return "";
  const tail = (Array.isArray(snapshot.finalSegments) ? snapshot.finalSegments : [])
    .filter((segment) => Number(segment.endAudioByteOffset) > Number(sealedThroughAudioByte))
    .map((segment) => String(segment.transcript || "").trim()).filter(Boolean);
  const interim = String(snapshot.interim || "").trim();
  if (interim) tail.push(interim);
  return tail.join(" ");
}

function publishTranscriptRevision(connections, payload) {
  for (const connection of connections || []) {
    const identity = connection.sessionIdentity;
    if (!identity || identity.sessionId !== payload?.session_id || identity.branchId !== payload?.branch_id) continue;
    void connection.sendEvent(payload).catch(() => {});
  }
}

module.exports = { createVoiceTranscriptReconcileBridge, publishTranscriptRevision };
