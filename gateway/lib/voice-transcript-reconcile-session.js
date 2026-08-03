"use strict";

function createVoiceTranscriptReconcileBridge(connection, runtime, webSocketOpen, options = {}) {
  const measureLatency = String(options?.env?.VOICE_LATENCY_MEASURE || "") === "1";
  const now = typeof options?.now === "function" ? options.now : Date.now;
  return {
    configure(turn, input) {
      if (measureLatency && !input.incognito) {
        turn.voiceLatencyMeasurement = { clauseCount: 0, firstClauseAtMs: null, committed: false };
      }
      if (!runtime || !input.enabled || input.incognito || typeof input.provider?.transcribePcmWindowed !== "function") return;
      turn.transcriptReconciler = runtime.createTurn({
        sessionId: turn.sessionId, branchId: turn.branchId, turnId: turn.turnId,
        ownerId: input.ownerId, provider: input.provider, languageCodes: input.languageCodes, format: input.format,
        emitPrefix: (revision) => this.emitPrefix(turn, revision),
      });
    },
    push(turn, chunk) { turn?.transcriptReconciler?.push(chunk); },
    seal(turn, segment) {
      noteLatencyClause(turn?.voiceLatencyMeasurement, now());
      turn?.transcriptReconciler?.seal(segment);
    },
    commit(turn) {
      const measurement = finishLatencyMeasurement(turn?.voiceLatencyMeasurement, now());
      if (!measurement) return;
      void connection.recordProviderEvent(
        turn, turn.providerEvents || connection.createProviderEvents(turn),
        "voice_latency_clause_boundaries", measurement,
      ).catch(() => {});
    },
    finish(turn) { turn?.transcriptReconciler?.finish({ pcmPath: turn.pcmPath }); },
    abandon(turn) { turn?.transcriptReconciler?.abandon(); },
    capability(turn) { return { supported: Boolean(turn?.transcriptReconciler), version: 1,
      owner_id: turn?.deviceId || "legacy_owner" }; },
    sequence(turn) { turn.transcriptSequence = (turn.transcriptSequence || 0) + 1; return turn.transcriptSequence; },
    async emitPrefix(turn, revision) {
      if (!turn || !revision?.finalizedText || connection.ws.readyState !== webSocketOpen) return;
      const snapshot = turn.sttStream?.snapshot?.();
      const unsealedText = transcriptTailAfter(snapshot, revision.sealedThroughAudioByte);
      const finalizedText = String(revision.finalizedText || "").trim();
      const sequence = this.sequence(turn);
      await connection.sendEvent({
        type: "transcript_prefix_revision", session_id: turn.sessionId, branch_id: turn.branchId,
        turn_id: turn.turnId, message_id: `turn:${turn.sessionId}:${turn.branchId}:${turn.turnId}:user`,
        owner_id: revision.ownerId, speaker: "user", transcript_sequence: sequence, revision: revision.revision,
        finalized_text: finalizedText, unsealed_text: unsealedText,
        text: [finalizedText, unsealedText].filter(Boolean).join(" "),
        sealed_through_audio_byte: revision.sealedThroughAudioByte, audio_format: turn.format,
        source: "automatic_reconcile", updated_at: new Date().toISOString(),
      });
      return sequence;
    },
  };
}

function noteLatencyClause(measurement, occurredAtMs) {
  if (!measurement || measurement.committed) return;
  measurement.clauseCount += 1;
  if (measurement.firstClauseAtMs == null) measurement.firstClauseAtMs = occurredAtMs;
}

function finishLatencyMeasurement(measurement, committedAtMs) {
  if (!measurement || measurement.committed) return null;
  measurement.committed = true;
  return {
    clause_count: measurement.clauseCount,
    first_clause_to_commit_ms: measurement.firstClauseAtMs == null
      ? null : Math.max(0, Math.round(committedAtMs - measurement.firstClauseAtMs)),
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
    if (!identity || identity.sessionId !== payload?.session_id || identity.branchId !== payload?.branch_id
        || identity.turnId !== payload?.turn_id || identity.ownerId !== payload?.owner_id) continue;
    void connection.sendEvent(payload).catch(() => {});
  }
}

module.exports = { createVoiceTranscriptReconcileBridge, publishTranscriptRevision };
