"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { appendTranscriptRevision } = require("../lib/transcript-revisions");

test("preserves revision zero and appends monotonic automatic correction metadata", () => {
  const record = { transcript: "live", transcript_source: "stt", created_at: "2026-08-02T00:00:00Z" };
  const result = appendTranscriptRevision(record, {
    transcript: "corrected", source: "automatic_reconcile", reconciliationId: "rolling_abc",
    transcriptSource: "stt-auto-reconcile", createdAt: "2026-08-02T00:01:00Z",
  });
  assert.equal(result.revision, 1);
  assert.equal(record.transcript_revisions[0].transcript, "live");
  assert.equal(record.transcript_revisions[1].reconciliation_id, "rolling_abc");
  assert.equal(record.transcript, "corrected");
});
