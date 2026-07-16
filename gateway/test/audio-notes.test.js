"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable, Writable } = require("node:stream");
const test = require("node:test");

const {
  createAudioNoteHandlers,
  createAudioNotesStore,
  DEFAULT_CONTENT_TYPE,
} = require("../lib/audio-notes");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-audio-notes-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

class MemoryResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.done = new Promise((resolve) => this.on("finish", resolve));
  }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = String(value);
    return this;
  }
  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }
  json() { return JSON.parse(Buffer.concat(this.chunks).toString("utf8")); }
}

function request(body = Buffer.alloc(0), headers = {}) {
  const req = Readable.from(body.length ? [body] : []);
  req.headers = headers;
  return req;
}

async function callCreate(handlers, req) {
  const response = new MemoryResponse();
  await handlers.create(req, response);
  await response.done;
  return response;
}

test("store normalizes formats and metadata and survives reload", async (t) => {
  const dataDir = tempDir(t);
  const store = createAudioNotesStore({ dataDir, maxTotalBytes: "invalid" });
  const pcm = store.create({ bytes: [1, 2], surface: "  phone\n overlay ", durationMs: -1 });
  const webm = store.create({ bytes: Buffer.from([3]), contentType: "audio/webm; codecs=opus", sessionId: " s!1 ", duration_ms: 1.6 });
  const binary = store.create({ bytes: "x", content_type: "audio/ogg", label: 42 });

  assert.equal(pcm.content_type, DEFAULT_CONTENT_TYPE);
  assert.equal(pcm.audio.encoding, "pcm16");
  assert.equal(pcm.surface, "phone overlay");
  assert.equal(pcm.duration_ms, null);
  assert.equal(webm.audio.encoding, "webm");
  assert.equal(webm.session_id, "s1");
  assert.equal(webm.duration_ms, 2);
  assert.equal(binary.audio.encoding, "binary");
  assert.match(store.audioPath(webm.id), /\.webm$/);
  assert.match(store.audioPath(binary.id), /\.bin$/);
  const stream = store.readStream(binary.id);
  assert.equal(stream.readable, true);
  stream.resume();
  await new Promise((resolve, reject) => stream.once("close", resolve).once("error", reject));
  assert.equal(store.get("bad/path"), null);
  assert.equal(store.get("missing"), null);
  assert.equal(store.audioPath("missing"), "");
  assert.equal(store.readStream("missing"), null);
  assert.equal(store.list({ limit: -1 }).length, 3);
  assert.equal(store.list({ limit: 9999 }).length, 3);
  assert.equal(store.list({ limit: "bad" }).length, 3);

  const reloaded = createAudioNotesStore({ dataDir });
  assert.equal(reloaded.status().total_bytes, 4);
  assert.equal(reloaded.status().count, 3);
});

test("store rejects empty and over-quota bodies without deleting bytes", (t) => {
  const dataDir = tempDir(t);
  const store = createAudioNotesStore({ dataDir, maxTotalBytes: 2.9 });
  assert.throws(() => store.create(), /body is empty/);
  const note = store.create({ bytes: Buffer.from([1, 2]) });
  assert.throws(() => store.create({ bytes: Buffer.from([3]) }), (error) => error.statusCode === 507);
  assert.deepEqual(fs.readFileSync(store.audioPath(note.id)), Buffer.from([1, 2]));
});

test("store ignores corrupt metadata and missing directories", (t) => {
  const dataDir = tempDir(t);
  const notesDir = path.join(dataDir, "audio-notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, "broken.json"), "{");
  fs.writeFileSync(path.join(notesDir, "invalid.json"), JSON.stringify({ id: "" }));
  fs.writeFileSync(path.join(notesDir, "primitive.json"), JSON.stringify(1));
  fs.writeFileSync(path.join(notesDir, "ignored.txt"), "ignored");
  const store = createAudioNotesStore({ dataDir });
  assert.deepEqual(store.list(), []);
  fs.rmSync(notesDir, { recursive: true, force: true });
  assert.deepEqual(store.list(), []);
  assert.equal(store.status().count, 0);
});

test("handlers can own the default audio-note store", async (t) => {
  const handlers = createAudioNoteHandlers({ dataDir: tempDir(t) });
  const response = new MemoryResponse();
  handlers.list(response, new URL("/v1/audio-notes", "http://local"));
  await response.done;
  assert.deepEqual(response.json(), { notes: [] });
});

test("store supports its public default options", (t) => {
  const cwd = tempDir(t);
  const previousCwd = process.cwd();
  try {
    process.chdir(cwd);
    assert.equal(createAudioNotesStore().status().endpoint, "/v1/audio-notes");
  } finally {
    process.chdir(previousCwd);
  }
});

test("create handler reports stream, size, storage, and event failures", async (t) => {
  const dataDir = tempDir(t);
  const store = createAudioNotesStore({ dataDir });
  const handlers = createAudioNoteHandlers({ store, maxBytes: 1, recordCreated: () => { throw new Error("event unavailable"); } });

  const oversized = await callCreate(handlers, request(Buffer.from([1, 2])));
  assert.equal(oversized.statusCode, 413);
  assert.match(oversized.json().error, /too large/);

  const failedRequest = new EventEmitter();
  failedRequest.headers = {};
  failedRequest.destroy = () => {};
  const failedResponse = new MemoryResponse();
  const pending = handlers.create(failedRequest, failedResponse);
  failedRequest.emit("error", new Error("stream\nfailure"));
  await pending;
  assert.equal(failedResponse.statusCode, 400);
  assert.equal(failedResponse.json().error, "stream failure");

  const empty = await callCreate(handlers, request());
  assert.equal(empty.statusCode, 400);

  const created = await callCreate(handlers, request(Buffer.from([9]), {
    "content-type": "audio/webm",
    "x-moa-surface": "browser",
  }));
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().note.audio.encoding, "webm");

  const quotaHandlers = createAudioNoteHandlers({
    store: { create() { const error = new Error("quota\nfull"); error.statusCode = 507; throw error; } },
  });
  const quota = await callCreate(quotaHandlers, request(Buffer.from([1])));
  assert.equal(quota.statusCode, 507);
  assert.equal(quota.json().error, "quota full");

  const unknownHandlers = createAudioNoteHandlers({ store: { create() { throw "unknown"; } } });
  const unknown = await callCreate(unknownHandlers, request(Buffer.from([1])));
  assert.equal(unknown.statusCode, 500);
  assert.equal(unknown.json().error, "unknown");
});

test("read handlers cover malformed, missing, absent, and non-file audio", async (t) => {
  const dataDir = tempDir(t);
  const store = createAudioNotesStore({ dataDir });
  const note = store.create({ bytes: Buffer.from([1, 2, 3]), content_type: "audio/ogg" });
  const handlers = createAudioNoteHandlers({ store });

  const fetched = new MemoryResponse();
  handlers.get(fetched, new URL(`/v1/audio-notes/${note.id}`, "http://local"));
  await fetched.done;
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().note.id, note.id);

  for (const pathname of ["/v1/audio-notes/missing", "/v1/audio-notes/bad/id", "/v1/audio-notes/%E0%A4%A"]) {
    const response = new MemoryResponse();
    handlers.get(response, new URL(pathname, "http://local"));
    await response.done;
    assert.equal(response.statusCode, 404);
  }

  const listed = new MemoryResponse();
  handlers.list(listed, new URL("/v1/audio-notes?limit=1", "http://local"));
  await listed.done;
  assert.equal(listed.json().notes.length, 1);

  const audioFile = store.audioPath(note.id);
  fs.rmSync(audioFile);
  let response = new MemoryResponse();
  handlers.sendAudio(response, new URL(note.audio.href, "http://local"));
  await response.done;
  assert.equal(response.statusCode, 404);

  fs.mkdirSync(audioFile);
  response = new MemoryResponse();
  handlers.sendAudio(response, new URL(note.audio.href, "http://local"));
  await response.done;
  assert.equal(response.statusCode, 404);

  response = new MemoryResponse();
  handlers.sendAudio(response, new URL("/v1/audio-notes/missing/audio", "http://local"));
  await response.done;
  assert.equal(response.statusCode, 404);
});

test("sendAudio streams bytes with fallback content type", async (t) => {
  const filePath = path.join(tempDir(t), "audio.bin");
  fs.writeFileSync(filePath, Buffer.from([7, 8]));
  const handlers = createAudioNoteHandlers({
    store: {
      get: () => ({ id: "note", content_type: "" }),
      audioPath: () => filePath,
    },
  });
  const response = new MemoryResponse();
  handlers.sendAudio(response, new URL("/v1/audio-notes/note/audio", "http://local"));
  await response.done;
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/octet-stream");
  assert.deepEqual(Buffer.concat(response.chunks), Buffer.from([7, 8]));
});
