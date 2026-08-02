"use strict";

const { SESSION_MESSAGE_TEXT_MAX_CHARS } = require("./session-messages");

const TRANSCRIPT_REVISION_MAX_ITEMS = 8;

function projectVoiceHistory(record = {}, options = {}) {
  const allRevisions = completedTranscriptRevisions(record);
  const selected = selectBoundedRevisions(allRevisions);
  const accessibility = normalizeAccessibility(options.audioAccessibility);
  const retranscriptionSupported = options.retranscriptionSupported === true;
  return {
    audio_accessibility: accessibility,
    audio_accessible: accessibility === "accessible",
    retranscription_supported: retranscriptionSupported,
    retranscription_available: accessibility === "accessible" && retranscriptionSupported,
    current_revision: allRevisions.length ? allRevisions[allRevisions.length - 1].revision : 0,
    revision_count: allRevisions.length,
    revisions_truncated: selected.length < allRevisions.length,
    transcript_revisions: selected,
  };
}

function completedTranscriptRevisions(record) {
  const stored = Array.isArray(record.transcript_revisions)
    ? record.transcript_revisions
    : [];
  const candidates = stored.length
    ? stored
    : [{
        revision: 0,
        transcript: record.transcript,
        transcript_source: record.transcript_source,
        source: "original",
        created_at: record.updated_at || record.created_at,
      }];
  const byRevision = new Map();
  for (const value of candidates) {
    const revision = Number(value?.revision);
    const transcript = String(value?.transcript || "");
    if (!Number.isSafeInteger(revision) || revision < 0 || !transcript.trim()) continue;
    const bounded = boundedTranscript(transcript);
    byRevision.set(revision, {
      revision,
      transcript: bounded.text,
      transcript_source: boundedLabel(value.transcript_source, 80),
      source: value.source === "automatic_reconcile"
        ? "automatic_reconcile"
        : (value.source === "retranscribe" ? "retranscribe" : "original"),
      created_at: boundedLabel(value.created_at, 80),
      text_complete: !bounded.truncated,
      stored_text_chars: transcript.length,
    });
  }
  return [...byRevision.values()].sort((left, right) => left.revision - right.revision);
}

function selectBoundedRevisions(revisions) {
  if (revisions.length <= TRANSCRIPT_REVISION_MAX_ITEMS) return revisions;
  return [revisions[0], ...revisions.slice(-(TRANSCRIPT_REVISION_MAX_ITEMS - 1))];
}

function normalizeAccessibility(value) {
  return value === "accessible" || value === "unknown" ? value : "unavailable";
}

function boundedTranscript(value) {
  const text = String(value || "");
  return {
    text: text.slice(0, SESSION_MESSAGE_TEXT_MAX_CHARS),
    truncated: text.length > SESSION_MESSAGE_TEXT_MAX_CHARS,
  };
}

function boundedLabel(value, maxChars) {
  return String(value || "").trim().slice(0, maxChars);
}

module.exports = {
  TRANSCRIPT_REVISION_MAX_ITEMS,
  completedTranscriptRevisions,
  projectVoiceHistory,
};
