"use strict";

function appendTranscriptRevision(record, input = {}) {
  if (!record || typeof record !== "object") return null;
  const transcript = String(input.transcript || "").trim();
  if (!transcript) return null;
  const now = String(input.createdAt || new Date().toISOString());
  const revisions = Array.isArray(record.transcript_revisions) ? record.transcript_revisions.slice() : [];
  if (revisions.length === 0) {
    revisions.push({
      revision: 0,
      transcript: String(record.transcript || ""),
      transcript_source: String(record.transcript_source || ""),
      source: "original",
      created_at: String(record.updated_at || record.created_at || now),
    });
  }
  const revision = revisions.reduce((max, value) => Math.max(max, Number(value?.revision) || 0), 0) + 1;
  const source = input.source === "automatic_reconcile" ? "automatic_reconcile" : "retranscribe";
  const transcriptSource = String(input.transcriptSource || (source === "automatic_reconcile"
    ? "stt-auto-reconcile"
    : "stt-retranscribe"));
  revisions.push({
    revision,
    transcript,
    transcript_source: transcriptSource,
    source,
    ...(Array.isArray(input.languageCodes) ? { language_codes: input.languageCodes } : {}),
    ...(typeof input.windowed === "boolean" ? { windowed: input.windowed } : {}),
    ...(input.reconciliationId ? { reconciliation_id: String(input.reconciliationId) } : {}),
    created_at: now,
  });
  record.transcript_revisions = revisions;
  record.retranscribed = true;
  record.transcript = transcript;
  record.transcript_source = transcriptSource;
  record.updated_at = now;
  return { record, revision, createdAt: now };
}

module.exports = { appendTranscriptRevision };
