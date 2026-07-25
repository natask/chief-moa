"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const audioRecordContract = require("../../reference/contracts/audio-record.v1.schema.json");

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
  }, {
    id: "note_deleted",
    created_at: "2026-07-23T00:00:00.000Z",
    media_status: "deleted",
    deleted_at: "2026-07-24T00:00:00.000Z",
  }, {
    id: "note_tombstone",
    created_at: "2026-07-22T00:00:00.000Z",
    tombstone: true,
  }, {
    id: "note_incognito",
    created_at: "2026-07-21T00:00:00.000Z",
    incognito: true,
  }];
  const history = createAudioHistory({
    dataDir,
    ownerSubject: "usr_owner",
    audioNotes: { list: () => notes },
    voiceTurnAudioRefs: (source) => source.id === "turn_missing" ? {} : ({
      user: { content_type: "audio/L16; rate=16000; channels=1", encoding: "pcm16", bytes: 32000 },
    }),
  });
  return { dataDir, history };
}

test("unifies voice turns and audio notes without duplicating projections", () => {
  const { history } = fixture();
  const page = history.list({ limit: 20, subject: "usr_owner" });
  assert.equal(page.records.length, 5);
  assert.equal(page.contract, "audio_record.v1");
  for (const key of audioRecordContract.required) {
    assert.ok(key in page.records[0], `shared contract field ${key}`);
  }
  assert.deepEqual(page.records.slice(0, 2).map((row) => row.source_kind), ["audio_note", "voice_turn"]);
  const voice = page.records[1];
  assert.equal(voice.duration_ms, 1000);
  assert.equal(voice.transcript.revisions.length, 2);
  assert.equal(voice.transcript.revisions[0].transcript, "original transcript");
  assert.equal(voice.transcript.revisions[1].provenance.chunk_strategy, "windowed_sync_legacy");
  assert.equal(voice.transcript.selected_revision_id, "rev_1");
  assert.equal(voice.media_status, "available");
  assert.equal("retranscribe_href" in voice, false);
  assert.equal(history.get(voice.audio_record_id, { subject: "usr_owner" }).source_id, "turn_one");
});

test("uses stable opaque ids and bounded cursor pagination", () => {
  const { history } = fixture();
  const first = history.list({ limit: 1, subject: "usr_owner" });
  assert.match(first.records[0].audio_record_id, /^aud_[a-f0-9]{24}$/);
  assert.ok(first.next_cursor);
  const second = history.list({ limit: 1, cursor: first.next_cursor, subject: "usr_owner" });
  assert.equal(second.records.length, 1);
  assert.notEqual(second.records[0].audio_record_id, first.records[0].audio_record_id);
  assert.equal(audioHistoryTestInternals.decodeCursor("not-a-cursor"), 0);
});

test("reports honest media lifecycle states and never fabricates playback", () => {
  const { dataDir, history } = fixture();
  const missingTurn = {
    id: "turn_missing",
    session_id: "session_one",
    created_at: "2026-07-20T00:00:00.000Z",
    transcript: "transcript survives missing media",
  };
  fs.writeFileSync(
    path.join(dataDir, "voice-turns", "session_one", "turn_missing.json"),
    JSON.stringify(missingTurn),
  );
  const records = history.list({ limit: 20, subject: "usr_owner" }).records;
  const bySource = new Map(records.map((row) => [row.source_id, row]));
  assert.equal(bySource.get("turn_missing").media_status, "missing");
  assert.equal(bySource.get("turn_missing").audio.playback_href, null);
  assert.equal(bySource.get("note_deleted").media_status, "deleted");
  assert.equal(bySource.get("note_tombstone").media_status, "tombstone");
  assert.equal(bySource.get("note_incognito").media_status, "incognito");
  for (const id of ["note_deleted", "note_tombstone", "note_incognito"]) {
    assert.equal(bySource.get(id).audio.playback_href, null);
  }
});

test("makes every transcript revision provenance field explicit", () => {
  const { history } = fixture();
  const voice = history.list({ subject: "usr_owner" }).records
    .find((row) => row.source_kind === "voice_turn");
  const required = [
    "provider", "api_version", "model", "method", "recognizer", "location",
    "language_codes", "prompt_digest", "audio_sha256", "audio_duration_ms",
    "chunk_strategy", "operation_id", "billed_duration_ms", "cost", "error",
  ];
  for (const revision of voice.transcript.revisions) {
    assert.deepEqual(Object.keys(revision.provenance), required);
    assert.equal(revision.provenance.provider, "unknown");
    assert.equal(revision.provenance.cost.currency, "unknown");
    assert.equal(revision.provenance.error.code, "unknown");
  }
  assert.equal("provenance" in voice, false);
});

test("binds list, detail, and playback to the configured single-user subject", async () => {
  const { history } = fixture();
  const calls = [];
  const handlers = createAudioHistoryHandlers({
    history,
    authorized: (request) => Boolean(request.headers.authorization),
    principal: (request) => request.headers["x-test-subject"],
    sendJson: (response, status, body) => { response.status = status; response.body = body; },
    sendVoiceAudio: async (_request, _response, url) => calls.push(["voice", url.pathname, url.search]),
    sendAudioNote: async (_response, url) => calls.push(["note", url.pathname]),
  });
  const denied = { setHeader() {} };
  assert.equal(await handlers.routeAudioHistory({ method: "GET", headers: {} }, denied, new URL("https://local/v1/audio-history")), true);
  assert.equal(denied.status, 401);

  const response = { setHeader() {} };
  await handlers.routeAudioHistory(
    { method: "GET", headers: { authorization: "Bearer secret", "x-test-subject": "usr_owner" } },
    response,
    new URL("https://local/v1/audio-history?limit=10"),
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.records.length, 5);

  const voice = response.body.records.find((row) => row.source_kind === "voice_turn");
  await handlers.routeAudioHistory(
    { method: "GET", headers: { authorization: "Bearer secret", "x-test-subject": "usr_owner" } },
    { setHeader() {} },
    new URL(`https://local${voice.audio.playback_href}`),
  );
  assert.deepEqual(calls[0], ["voice", "/v1/voice/audio/session_one/turn_one", "?kind=user"]);

  const note = response.body.records.find((row) => row.source_kind === "audio_note");
  await handlers.routeAudioHistory(
    { method: "GET", headers: { authorization: "Bearer secret", "x-test-subject": "usr_owner" } },
    { setHeader() {} },
    new URL(`https://local${note.audio.playback_href}`),
  );
  assert.deepEqual(calls[1], ["note", "/v1/audio-notes/note_one/audio"]);

  for (const target of [
    "/v1/audio-history",
    `/v1/audio-history/${voice.audio_record_id}`,
    voice.audio.playback_href,
  ]) {
    const crossOwner = { setHeader() {} };
    await handlers.routeAudioHistory(
      { method: "GET", headers: { authorization: "Bearer other", "x-test-subject": "usr_other" } },
      crossOwner,
      new URL(`https://local${target}`),
    );
    assert.equal(crossOwner.status, 404);
  }
  assert.equal(calls.length, 2);
});

test("rejects all mutation methods on the read-only slice", async () => {
  const { history } = fixture();
  const handlers = createAudioHistoryHandlers({
    history,
    authorized: () => true,
    principal: () => "usr_owner",
    sendJson: (response, status, body) => { response.status = status; response.body = body; },
  });
  const response = { setHeader() {} };
  await handlers.routeAudioHistory(
    { method: "POST", headers: {} },
    response,
    new URL("https://local/v1/audio-history"),
  );
  assert.equal(response.status, 405);
});
