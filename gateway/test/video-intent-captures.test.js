"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventSubstrateStore } = require("../lib/event-substrate");
const { createIntentRuntime } = require("../lib/intent-runtime");
const { createVideoNotesStore } = require("../lib/video-notes");
const {
  createVideoIntentCaptureService,
  parseVideoTranscriptAnalysis,
  stableIntentId,
} = require("../lib/video-intent-captures");

function fixture(analyzeVideo) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-video-intent-"));
  const events = createEventSubstrateStore({ dataDir, originId: "video-intent-test" });
  const videoNotes = createVideoNotesStore({ dataDir });
  const intents = createIntentRuntime({ events, now: () => "2026-08-03T02:00:00.000Z" });
  const service = createVideoIntentCaptureService({ videoNotes, intents, analyzeVideo, now: () => "2026-08-03T02:00:00.000Z" });
  return { dataDir, videoNotes, intents, service };
}

test("explicit stop preserves video and exact transcript before admitting an inert durable intent", async (t) => {
  const f = fixture(async () => ({
    transcript: "I need the first thought, then the correction—keep both.",
    provider: "fixture", model: "fixture-video", prompt_version: "fixture-v1",
  }));
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  const bytes = Buffer.from("source-video-bytes");
  const note = f.videoNotes.create({
    bytes, surface: "agee-extension", session_id: "session-video",
    duration_ms: 4200, retention: "user_kept",
  });
  await assert.rejects(() => f.service.capture(note.id, {}), /user_confirmed/);
  const captureIntent = f.intents.capture.bind(f.intents);
  f.intents.capture = async (input) => {
    assert.equal(f.videoNotes.get(note.id).transcript.state, "complete", "transcript must be durable before intent admission");
    return captureIntent(input);
  };

  const result = await f.service.capture(note.id, { user_confirmed: true });
  assert.equal(result.intent.intent_id, stableIntentId(note.id));
  assert.equal(result.intent.lifecycle_state, "captured");
  assert.equal(result.intent.normalized_objective, "I need the first thought, then the correction—keep both.");
  assert.deepEqual(result.intent.evidence_refs, [note.evidence_ref]);
  assert.deepEqual(result.dispatch, { automatic: false });
  assert.equal(result.transcript.state, "complete");
  assert.equal(result.transcript.text, "I need the first thought, then the correction—keep both.");
  assert.deepEqual(await f.videoNotes.readBytes(note.id), bytes);
  assert.equal(f.videoNotes.get(note.id).sha256, note.sha256);

  const history = await f.intents.history(result.intent.intent_id);
  const source = history.events.find((event) => event.event_type === "intent.source_recorded");
  assert.equal(source.payload.raw_text, result.transcript.text);
  assert.equal(source.payload.provenance.evidence_sha256, note.sha256);
  assert.equal(source.payload.provenance.admitted_by, "explicit_stop");
  const replay = await f.service.capture(note.id, { user_confirmed: true });
  assert.equal(replay.intent.event_count, result.intent.event_count);
});

test("provider failure keeps evidence and creates a retryable visible intent", async (t) => {
  let fail = true;
  const f = fixture(async () => {
    if (fail) throw new Error("provider offline");
    return { transcript: "Recovered exact narration.", provider: "fixture", model: "video" };
  });
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  const note = f.videoNotes.create({ bytes: Buffer.from("still-preserved") });
  const pending = await f.service.capture(note.id, { user_confirmed: true });
  assert.equal(pending.transcript.state, "failed");
  assert.match(pending.intent.next_step, /Retry transcription/);
  assert.ok(await f.videoNotes.readBytes(note.id));

  fail = false;
  const recovered = await f.service.capture(note.id, { user_confirmed: true });
  assert.equal(recovered.transcript.state, "complete");
  assert.equal(recovered.intent.normalized_objective, "Recovered exact narration.");
  assert.equal(recovered.intent.source_revisions.length, 1);
});

test("analysis parser accepts fenced JSON and refuses summaries without transcripts", () => {
  assert.equal(parseVideoTranscriptAnalysis("```json\n{\"transcript\":\"Exact words.\"}\n```").transcript, "Exact words.");
  assert.throws(() => parseVideoTranscriptAnalysis('{"summary":"Reduced thought"}'), /empty transcript/);
  assert.throws(() => parseVideoTranscriptAnalysis("not json"), /invalid JSON/);
});
