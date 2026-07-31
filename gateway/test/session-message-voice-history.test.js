"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TRANSCRIPT_REVISION_MAX_ITEMS,
  projectVoiceHistory,
} = require("../lib/session-message-voice-history");

test("projects an original transcript and truthful live capability state", () => {
  const history = projectVoiceHistory({
    transcript: "the exact original",
    transcript_source: "stt",
    created_at: "2026-07-30T10:00:00.000Z",
    references: { voice_session: { audio: { bytes: 99_999 } } },
  }, {
    audioAccessibility: "unavailable",
    retranscriptionSupported: true,
  });

  assert.equal(history.audio_accessibility, "unavailable");
  assert.equal(history.audio_accessible, false, "stored byte counts do not imply accessibility");
  assert.equal(history.retranscription_supported, true);
  assert.equal(history.retranscription_available, false);
  assert.equal(history.current_revision, 0);
  assert.deepEqual(history.transcript_revisions, [{
    revision: 0,
    transcript: "the exact original",
    transcript_source: "stt",
    source: "original",
    created_at: "2026-07-30T10:00:00.000Z",
    text_complete: true,
    stored_text_chars: 18,
  }]);
});

test("keeps the original and newest completed revisions in chronological order", () => {
  const transcript_revisions = Array.from({ length: 12 }, (_, revision) => ({
    revision,
    transcript: `revision ${revision}`,
    transcript_source: revision ? "stt-retranscribe" : "stt",
    source: revision ? "retranscribe" : "original",
    created_at: `2026-07-30T10:${String(revision).padStart(2, "0")}:00.000Z`,
  }));
  transcript_revisions.push({ revision: 13, transcript: " " });
  const history = projectVoiceHistory({ transcript_revisions }, {
    audioAccessibility: "accessible",
    retranscriptionSupported: true,
  });

  assert.equal(history.audio_accessible, true);
  assert.equal(history.retranscription_available, true);
  assert.equal(history.revision_count, 12);
  assert.equal(history.revisions_truncated, true);
  assert.equal(history.transcript_revisions.length, TRANSCRIPT_REVISION_MAX_ITEMS);
  assert.deepEqual(
    history.transcript_revisions.map((item) => item.revision),
    [0, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.equal(history.current_revision, 11);
});

test("reports a failed backend probe as unknown and keeps retranscription disabled", () => {
  const history = projectVoiceHistory({ transcript: "kept" }, {
    audioAccessibility: "unknown",
    retranscriptionSupported: true,
  });
  assert.equal(history.audio_accessibility, "unknown");
  assert.equal(history.audio_accessible, false);
  assert.equal(history.retranscription_available, false);
});
