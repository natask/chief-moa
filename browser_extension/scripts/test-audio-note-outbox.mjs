import assert from "node:assert/strict";
import test from "node:test";
import {
  createAudioNoteOutbox,
  createMemoryAudioNoteOutboxStorage,
} from "../extension/audio-note-outbox.js";

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 7, 12, 0, tick++));
}

test("stopped audio survives a failed upload and a new runtime reads the exact bytes", async () => {
  const storage = createMemoryAudioNoteOutboxStorage();
  const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const failed = createAudioNoteOutbox({
    storage,
    now: clock(),
    randomId: () => "capture-one",
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => "provider unavailable" }),
  });
  const retained = await failed.retain({
    bytes: source,
    durationMs: 12,
    sessionId: "session_1",
    surface: "agee-extension",
  });
  source.fill(0);

  await assert.rejects(
    failed.upload(retained.id, { gatewayUrl: "https://api.agee.test", gatewayToken: "secret" }),
    /503.*provider unavailable/,
  );

  const afterRestart = createAudioNoteOutbox({ storage, now: clock(), randomId: () => "unused" });
  const pending = await afterRestart.list();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, retained.id);
  assert.equal(pending[0].attempts, 1);
  assert.match(pending[0].last_error, /provider unavailable/);
  assert.deepEqual([...new Uint8Array(await (await afterRestart.readBlob(retained.id)).arrayBuffer())], [1, 2, 3, 4, 5, 6]);
});

test("a later explicit retry uploads only to audio notes and clears the recovery copy", async () => {
  const storage = createMemoryAudioNoteOutboxStorage();
  const requests = [];
  const initial = createAudioNoteOutbox({ storage, now: clock(), randomId: () => "capture-two" });
  const retained = await initial.retain({ bytes: new Uint8Array([7, 8, 9]), durationMs: 4, sessionId: "session_2" });
  const restarted = createAudioNoteOutbox({
    storage,
    now: clock(),
    fetchImpl: async (url, request) => {
      requests.push({ url, request, bytes: [...new Uint8Array(request.body)] });
      return { ok: true, status: 201, text: async () => JSON.stringify({ note: { id: "note_1" } }) };
    },
  });

  const response = await restarted.upload(retained.id, {
    gatewayUrl: "https://api.agee.test/",
    gatewayToken: "token_1",
  });

  assert.equal(response.note.id, "note_1");
  assert.deepEqual(requests.map((entry) => entry.url), ["https://api.agee.test/v1/audio-notes"]);
  assert.deepEqual(requests[0].bytes, [7, 8, 9]);
  assert.equal(requests[0].request.headers.authorization, "Bearer token_1");
  assert.equal(requests[0].request.headers["x-moa-session-id"], "session_2");
  assert.deepEqual(await restarted.list(), []);
});

test("the local cap refuses a new capture without evicting retained evidence", async () => {
  const storage = createMemoryAudioNoteOutboxStorage();
  const outbox = createAudioNoteOutbox({
    storage,
    now: clock(),
    randomId: () => "bounded",
    maxItemBytes: 8,
    maxTotalBytes: 5,
  });
  await outbox.retain({ bytes: new Uint8Array([1, 2, 3]), durationMs: 1 });
  await assert.rejects(outbox.retain({ bytes: new Uint8Array([4, 5, 6]), durationMs: 1 }), /storage is full/);
  assert.equal((await outbox.list()).length, 1);
});
