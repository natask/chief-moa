"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildVoiceReplayCorpus } = require("../lib/voice-replay-corpus");

test("builds ordered real-turn replay samples with next-turn feedback", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-replay-corpus-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session = "session-a";
  fs.mkdirSync(path.join(dataDir, "voice-turns", session), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "voice-sessions", session), { recursive: true });
  writeTurn(dataDir, session, "turn-1", "2026-01-01T00:00:00.000Z", "hello", 1280, "2026-01-01T00:00:00.500Z");
  writeTurn(dataDir, session, "turn-2", "2026-01-01T00:00:02.000Z", "that was slow", 640, null);
  fs.writeFileSync(path.join(dataDir, "voice-sessions", session, "turn-1.pcm"), Buffer.alloc(1280));
  fs.writeFileSync(path.join(dataDir, "voice-sessions", session, "turn-2.pcm"), Buffer.alloc(640));

  const corpus = buildVoiceReplayCorpus({ dataDir, maxSamples: 10 });
  assert.equal(corpus.samples.length, 2);
  assert.equal(corpus.samples[0].input_audio.local_path.endsWith("turn-1.pcm"), true);
  assert.equal(corpus.samples[0].original.first_audio_ms, 500);
  assert.deepEqual(corpus.samples[0].follow_up, {
    turn_id: "turn-2",
    created_at: "2026-01-01T00:00:02.000Z",
    transcript: "that was slow",
    delay_ms: 2000,
  });
  assert.equal(corpus.samples[1].follow_up, null);
});

function writeTurn(dataDir, session, id, createdAt, transcript, bytes, audioStart) {
  const providerEvents = audioStart ? [{ type: "assistant_audio_start", ts: audioStart }] : [];
  fs.writeFileSync(path.join(dataDir, "voice-turns", session, `${id}.json`), JSON.stringify({
    id,
    session_id: session,
    source: "android-overlay",
    created_at: createdAt,
    transcript,
    response: { speak: `answer to ${transcript}` },
    references: { voice_session: {
      provider: "fixture",
      status: "completed",
      audio: { bytes },
      assistant_audio: { bytes: 320 },
      provider_events: providerEvents,
    } },
  }));
}
