"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createAudioHistory,
  createAudioHistoryHandlers,
  audioHistoryTestInternals,
} = require("../lib/audio-history");

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-audio-history-"));
  const voiceDir = path.join(dataDir, "voice-turns", "session_one");
  fs.mkdirSync(voiceDir, { recursive: true });
  const voice = {
    id: "turn_one",
    session_id: "session_one",
    source: "browser",
    device_id: "browser_1",
    transcript: "new transcript",
    transcript_source: "stt-retranscribe",
    created_at: "2026-07-24T00:00:00.000Z",
    updated_at: "2026-07-25T00:00:00.000Z",
    transcript_revisions: [
      { revision: 0, transcript: "original transcript", source: "original", created_at: "2026-07-24T00:00:00.000Z" },
      { revision: 1, transcript: "new transcript", source: "retranscribe", language_codes: ["en-US", "am-ET"], windowed: true, created_at: "2026-07-25T00:00:00.000Z" },
    ],
    references: { voice_session: { provider: "google-cloud-stt", model: "chirp_3" } },
  };
  fs.writeFileSync(path.join(voiceDir, "turn_one.json"), JSON.stringify(voice));
  const notes = [{
    id: "note_one",
    created_at: "2026-07-26T00:00:00.000Z",
    surface: "browser",
    session_id: "session_two",
    duration_ms: 1200,
    content_type: "audio/webm",
    bytes: 42,
    audio: { encoding: "webm" },
  }];
  const history = createAudioHistory({
    dataDir,
    audioNotes: { list: () => notes },
    voiceTurnAudioRefs: () => ({
      user: { content_type: "audio/L16; rate=16000; channels=1", encoding: "pcm16", bytes: 32000 },
    }),
  });
  return { dataDir, history };
}

test("unifies voice turns and audio notes without duplicating projections", () => {
  const { history } = fixture();
  const page = history.list({ limit: 20 });
  assert.equal(page.records.length, 2);
  assert.deepEqual(page.records.map((row) => row.source_kind), ["audio_note", "voice_turn"]);
  const voice = page.records[1];
  assert.equal(voice.duration_ms, 1000);
  assert.equal(voice.transcript.revisions.length, 2);
  assert.equal(voice.transcript.revisions[0].transcript, "original transcript");
  assert.equal(voice.transcript.revisions[1].strategy, "windowed_sync_legacy");
  assert.equal(voice.transcript.selected_revision_id, "rev_1");
  assert.match(voice.retranscribe_href, /session_one\/turn_one\/retranscribe$/);
  assert.equal(history.get(voice.audio_record_id).source_id, "turn_one");
});

test("uses stable opaque ids and bounded cursor pagination", () => {
  const { history } = fixture();
  const first = history.list({ limit: 1 });
  assert.match(first.records[0].audio_record_id, /^aud_[a-f0-9]{24}$/);
  assert.ok(first.next_cursor);
  const second = history.list({ limit: 1, cursor: first.next_cursor });
  assert.equal(second.records.length, 1);
  assert.notEqual(second.records[0].audio_record_id, first.records[0].audio_record_id);
  assert.equal(audioHistoryTestInternals.decodeCursor("not-a-cursor"), 0);
});

test("routes authenticated list, detail, and original audio only", async () => {
  const { history } = fixture();
  const calls = [];
  const handlers = createAudioHistoryHandlers({
    history,
    authorized: (request) => request.headers.authorization === "Bearer secret",
    sendJson: (response, status, body) => { response.status = status; response.body = body; },
    sendVoiceAudio: async (_request, _response, url) => calls.push(["voice", url.pathname, url.search]),
    sendAudioNote: async (_response, url) => calls.push(["note", url.pathname]),
  });
  const denied = { setHeader() {} };
  assert.equal(await handlers.routeAudioHistory({ method: "GET", headers: {} }, denied, new URL("https://local/v1/audio-history")), true);
  assert.equal(denied.status, 401);

  const response = { setHeader() {} };
  await handlers.routeAudioHistory(
    { method: "GET", headers: { authorization: "Bearer secret" } },
    response,
    new URL("https://local/v1/audio-history?limit=10"),
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.records.length, 2);

  const voice = response.body.records.find((row) => row.source_kind === "voice_turn");
  await handlers.routeAudioHistory(
    { method: "GET", headers: { authorization: "Bearer secret" } },
    { setHeader() {} },
    new URL(`https://local${voice.audio.playback_href}`),
  );
  assert.deepEqual(calls[0], ["voice", "/v1/voice/audio/session_one/turn_one", "?kind=user"]);

  const note = response.body.records.find((row) => row.source_kind === "audio_note");
  await handlers.routeAudioHistory(
    { method: "GET", headers: { authorization: "Bearer secret" } },
    { setHeader() {} },
    new URL(`https://local${note.audio.playback_href}`),
  );
  assert.deepEqual(calls[1], ["note", "/v1/audio-notes/note_one/audio"]);
});
