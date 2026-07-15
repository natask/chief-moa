"use strict";

const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Writable } = require("node:stream");
const { createVideoNoteHandlers, createVideoNotesStore } = require("../lib/video-notes");

function tempStore(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-notes-edge-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return createVideoNotesStore({ dataDir, ...options });
}

test("store normalizes defaults, bounds, metadata, and corrupt files", (t) => {
  const store = tempStore(t, { maxTotalBytes: "invalid" });
  const note = store.create({
    bytes: [1, 2, 3],
    contentType: "",
    surface: " surface\nname ",
    sessionId: "bad/session id",
    durationMs: -1,
    label: " label\ntext ",
  });
  assert.equal(note.content_type, "video/webm");
  assert.equal(note.surface, "surface name");
  assert.equal(note.session_id, "badsessionid");
  assert.equal(note.duration_ms, null);
  assert.equal(note.label, "label text");
  assert.equal(store.status().count, 1);
  assert.equal(store.status().endpoint, "/v1/video-notes");
  assert.equal(store.list({ limit: 0 }).length, 1);
  assert.equal(store.list({ limit: "invalid" }).length, 1);
  assert.equal(store.list({ limit: 9999 }).length, 1);
  assert.equal(store.get("bad/path"), null);
  assert.equal(store.get(null), null);

  fs.writeFileSync(path.join(store.notesDir, "invalid.json"), "not-json");
  fs.writeFileSync(path.join(store.notesDir, "array.json"), "[]");
  fs.writeFileSync(path.join(store.notesDir, "missing-id.json"), "{}");
  assert.equal(store.list().length, 1);
});

test("store exposes byte streams and fails soft for missing blobs", async (t) => {
  const store = tempStore(t, { maxTotalBytes: 20.9 });
  const note = store.create({ bytes: Buffer.from("stream me"), duration_ms: 1.6 });
  assert.equal(note.duration_ms, 2);
  const stream = store.readStream(note.id);
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  await once(stream, "end");
  assert.equal(Buffer.concat(chunks).toString(), "stream me");
  const blob = store.videoPath(note.id);
  fs.rmSync(blob);
  fs.mkdirSync(blob);
  assert.equal(await store.readBytes(note.id), null);
  fs.rmSync(blob, { recursive: true });
  assert.equal(store.videoPath(note.id), "");
  assert.equal(await store.readBytes(note.id), null);
  assert.equal(store.readStream(note.id), null);
  assert.equal(await store.remove(note.id), true);
  assert.equal(store.status().total_bytes, 0);
});

test("handlers can own their default store and event callback", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-handler-default-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const handlers = createVideoNoteHandlers({ dataDir });
  const response = captureResponse();
  handlers.list(response, new URL("https://gateway.test/v1/video-notes"));
  assert.deepEqual(response.json.notes, []);
});

test("create handler accepts raw bytes and isolates product-event failure", async () => {
  const created = [];
  const store = {
    create: (input) => { created.push(input); return { id: "note-1", content_type: input.content_type }; },
  };
  const handlers = createVideoNoteHandlers({ store, recordCreated: () => { throw new Error("telemetry down"); } });
  const request = bodyRequest(Buffer.from("video"), {
    "content-type": "video/mp4",
    "x-moa-surface": "android",
    "x-moa-session-id": "session",
    "x-moa-duration-ms": "12",
    "x-moa-label": "demo",
  });
  const response = captureResponse();
  const pending = handlers.create(request, response);
  request.send();
  await pending;
  assert.equal(response.status, 201);
  assert.equal(response.json.note.id, "note-1");
  assert.equal(created[0].bytes.toString(), "video");
  assert.equal(created[0].surface, "android");
});

test("create handler rejects empty, oversized, stream-error, and storage-error bodies", async (t) => {
  await t.test("empty", async () => {
    const handlers = createVideoNoteHandlers({ store: { create: () => assert.fail("must not create") } });
    const request = bodyRequest(Buffer.alloc(0));
    const response = captureResponse();
    const pending = handlers.create(request, response);
    request.send();
    await pending;
    assert.equal(response.status, 400);
  });
  await t.test("oversized", async () => {
    const handlers = createVideoNoteHandlers({ maxBytes: 2, store: { create: () => assert.fail("must not create") } });
    const request = bodyRequest(Buffer.from("large"));
    const response = captureResponse();
    const pending = handlers.create(request, response);
    request.send();
    await pending;
    assert.equal(response.status, 413);
    assert.equal(request.destroyed, true);
  });
  await t.test("stream error", async () => {
    const handlers = createVideoNoteHandlers({ store: {} });
    const request = bodyRequest(null);
    const response = captureResponse();
    const pending = handlers.create(request, response);
    request.emit("error", new Error("stream\nfailed"));
    await pending;
    assert.equal(response.status, 400);
    assert.equal(response.json.error, "stream failed");
  });
  await t.test("storage error", async () => {
    const error = Object.assign(new Error("quota"), { statusCode: 507 });
    const handlers = createVideoNoteHandlers({ store: { create: () => { throw error; } } });
    const request = bodyRequest(Buffer.from("ok"));
    const response = captureResponse();
    const pending = handlers.create(request, response);
    request.send();
    await pending;
    assert.equal(response.status, 507);
  });
  await t.test("unknown storage failure", async () => {
    const handlers = createVideoNoteHandlers({ store: { create: () => { throw null; } } });
    const request = bodyRequest(Buffer.from("ok"));
    const response = captureResponse();
    const pending = handlers.create(request, response);
    request.send();
    await pending;
    assert.equal(response.status, 500);
    assert.equal(response.json.error, "unknown error");
  });
});

test("metadata list, get, and delete handlers cover found and missing notes", async () => {
  const notes = new Map([["note one", { id: "note one" }]]);
  const store = {
    list: (filter) => [{ limit: filter.limit }],
    get: (id) => notes.get(id) || null,
    remove: (id) => notes.delete(id),
  };
  const handlers = createVideoNoteHandlers({ store });
  let response = captureResponse();
  handlers.list(response, new URL("https://gateway.test/v1/video-notes?limit=7"));
  assert.equal(response.json.notes[0].limit, "7");
  response = captureResponse();
  handlers.get(response, new URL("https://gateway.test/v1/video-notes/note%20one"));
  assert.equal(response.status, 200);
  response = captureResponse();
  handlers.get(response, new URL("https://gateway.test/v1/video-notes/missing"));
  assert.equal(response.status, 404);
  response = captureResponse();
  handlers.get(response, { pathname: "/v1/video-notes/%E0%A4%A" });
  assert.equal(response.status, 404);
  response = captureResponse();
  await handlers.remove(response, new URL("https://gateway.test/v1/video-notes/note%20one"));
  assert.deepEqual(response.json, { deleted: true, id: "note one" });
  response = captureResponse();
  await handlers.remove(response, new URL("https://gateway.test/v1/video-notes/note%20one/extra"));
  assert.equal(response.status, 404);
});

test("video handler distinguishes metadata, blob, non-file, and successful stream", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-handler-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const blob = path.join(dir, "video.bin");
  fs.writeFileSync(blob, "bytes");
  const note = { id: "note", content_type: "video/webm" };
  let filePath = blob;
  const handlers = createVideoNoteHandlers({ store: {
    get: (id) => id === "note" ? note : null,
    videoPath: () => filePath,
    stream: async () => {
      if (!filePath) return null;
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return null;
      }
      if (!stat.isFile()) return null;
      return {
        stream: fs.createReadStream(filePath),
        size: stat.size,
        contentType: note.content_type || "application/octet-stream",
      };
    },
  } });

  let response = captureResponse();
  await handlers.sendVideo(response, new URL("https://gateway.test/v1/video-notes/missing/video"));
  assert.equal(response.status, 404);
  response = captureResponse();
  await handlers.sendVideo(response, new URL("https://gateway.test/v1/video-notes/bad/extra/video"));
  assert.equal(response.status, 404);
  filePath = "";
  response = captureResponse();
  await handlers.sendVideo(response, new URL("https://gateway.test/v1/video-notes/note/video"));
  assert.equal(response.json.error, "video note video not found");
  filePath = dir;
  response = captureResponse();
  await handlers.sendVideo(response, new URL("https://gateway.test/v1/video-notes/note/video"));
  assert.equal(response.status, 404);
  filePath = blob;
  response = captureResponse();
  const firstFinish = once(response, "finish");
  await handlers.sendVideo(response, new URL("https://gateway.test/v1/video-notes/note/video"));
  await firstFinish;
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-length"], 5);
  assert.equal(response.body.toString(), "bytes");

  note.content_type = "";
  response = captureResponse();
  const secondFinish = once(response, "finish");
  await handlers.sendVideo(response, new URL("https://gateway.test/v1/video-notes/note/video"));
  await secondFinish;
  assert.equal(response.headers["content-type"], "application/octet-stream");
});

function bodyRequest(body, headers = {}) {
  const request = new EventEmitter();
  request.headers = headers;
  request.destroyed = false;
  request.destroy = () => { request.destroyed = true; };
  request.send = () => {
    if (body?.length) request.emit("data", body);
    request.emit("end");
  };
  return request;
}

function captureResponse() {
  const chunks = [];
  const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
  response.on("finish", () => {
    response.body = Buffer.concat(chunks);
    try { response.json = JSON.parse(response.body.toString()); } catch {}
  });
  const originalEnd = response.end.bind(response);
  response.end = (chunk) => {
    if (chunk != null) chunks.push(Buffer.from(chunk));
    response.body = Buffer.concat(chunks);
    try { response.json = JSON.parse(response.body.toString()); } catch {}
    return originalEnd();
  };
  return response;
}
