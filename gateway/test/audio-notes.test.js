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
  const streamed = await store.stream(binary.id);
  assert.equal(streamed.size, 1);
  assert.equal(streamed.contentType, "audio/ogg");
  streamed.stream.resume();
  await new Promise((resolve, reject) => streamed.stream.once("close", resolve).once("error", reject));
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

test("remove deletes metadata and bytes, frees quota, and is idempotent", async (t) => {
  const dataDir = tempDir(t);
  const store = createAudioNotesStore({ dataDir, maxTotalBytes: 2 });
  const note = store.create({ bytes: Buffer.from([1, 2]) });
  const blobPath = store.audioPath(note.id);

  assert.deepEqual(await store.remove(note.id), {
    deleted: true,
    id: note.id,
    already_deleted: false,
    metadata_deleted: true,
    local_deleted: true,
    remote_status: "not_applicable",
  });
  assert.equal(store.get(note.id), null);
  assert.equal(fs.existsSync(blobPath), false);
  assert.equal(store.status().total_bytes, 0);
  assert.equal((await store.remove(note.id)).already_deleted, true);
  assert.ok(store.create({ bytes: Buffer.from([3, 4]) }).id);
});

test("remove keeps metadata and quota when remote deletion is partial, then retries", async (t) => {
  const dataDir = tempDir(t);
  let remoteExists = true;
  let deletes = 0;
  const blobStore = {
    mode: "gcs",
    finalizeSpool: () => {},
    delete: async (key) => {
      deletes += 1;
      fs.rmSync(path.join(dataDir, key), { force: true });
      if (deletes > 1) remoteExists = false;
    },
    stat: async () => remoteExists ? { size: 2, source: "gcs" } : null,
  };
  const store = createAudioNotesStore({ dataDir, blobStore, maxTotalBytes: 2 });
  const note = store.create({ bytes: Buffer.from([1, 2]) });

  await assert.rejects(store.remove(note.id), (error) => {
    assert.equal(error.statusCode, 502);
    assert.deepEqual(error.deletion, {
      deleted: false,
      id: note.id,
      metadata_deleted: false,
      local_deleted: true,
      remote_status: "failed",
      retryable: true,
    });
    return true;
  });
  assert.ok(store.get(note.id));
  assert.equal(store.status().total_bytes, 2);
  assert.throws(() => store.create({ bytes: Buffer.from([3]) }), /quota/);

  const retried = await store.remove(note.id);
  assert.equal(retried.deleted, true);
  assert.equal(retried.remote_status, "deleted_or_absent");
  assert.equal(store.status().total_bytes, 0);
});

test("blob-backed notes finalize and stream through the blob store", async (t) => {
  const dataDir = tempDir(t);
  const calls = { finalized: [], streamed: [] };
  let streamResult = { stream: { id: "remote-audio" }, size: 8 };
  const blobStore = {
    finalizeSpool: (key, options) => calls.finalized.push({ key, options }),
    getReadStream: async (key) => { calls.streamed.push(key); return streamResult; },
  };
  const store = createAudioNotesStore({ dataDir, blobStore });
  const note = store.create({ bytes: Buffer.from("spool"), content_type: "audio/ogg" });

  assert.equal(calls.finalized.length, 1);
  assert.equal(calls.finalized[0].options.contentType, "audio/ogg");
  assert.deepEqual(await store.stream(note.id), {
    stream: { id: "remote-audio" },
    size: 8,
    contentType: "audio/ogg",
  });
  streamResult = null;
  assert.equal(await store.stream(note.id), null);
  assert.equal(await store.stream("missing"), null);
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
      stream: async () => ({
        stream: fs.createReadStream(filePath),
        size: 2,
        contentType: "application/octet-stream",
      }),
    },
  });
  const response = new MemoryResponse();
  handlers.sendAudio(response, new URL("/v1/audio-notes/note/audio", "http://local"));
  await response.done;
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/octet-stream");
  assert.deepEqual(Buffer.concat(response.chunks), Buffer.from([7, 8]));
});

test("sendAudio reports blob read failures", async () => {
  const handlers = createAudioNoteHandlers({
    store: {
      get: () => ({ id: "note" }),
      stream: async () => { throw new Error("bucket unavailable"); },
    },
  });
  const response = new MemoryResponse();
  await handlers.sendAudio(response, new URL("/v1/audio-notes/note/audio", "http://local"));
  await response.done;
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error, "audio note read failed: bucket unavailable");
});

test("remove handler returns idempotent receipts and honest partial failures", async () => {
  let attempts = 0;
  const handlers = createAudioNoteHandlers({
    store: {
      remove: async (id) => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("remote unavailable");
          error.statusCode = 502;
          error.deletion = { deleted: false, id, remote_status: "unverified", retryable: true };
          throw error;
        }
        return { deleted: true, id, already_deleted: attempts > 2 };
      },
    },
  });

  let response = new MemoryResponse();
  await handlers.remove(response, new URL("/v1/audio-notes/note_1", "http://local"));
  await response.done;
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().deletion.remote_status, "unverified");

  response = new MemoryResponse();
  await handlers.remove(response, new URL("/v1/audio-notes/note_1", "http://local"));
  await response.done;
  assert.deepEqual(response.json(), { deleted: true, id: "note_1", already_deleted: false });

  response = new MemoryResponse();
  await handlers.remove(response, new URL("/v1/audio-notes/note_1/audio", "http://local"));
  await response.done;
  assert.equal(response.statusCode, 404);
});

test("remove coalesces concurrent deletion attempts and validates empty identifiers", async (t) => {
  const dataDir = tempDir(t);
  let releaseDelete;
  let deleteCalls = 0;
  const deleteStarted = new Promise((resolve) => {
    releaseDelete = resolve;
  });
  const blobStore = {
    mode: "gcs",
    finalizeSpool: () => {},
    delete: async (key) => {
      deleteCalls += 1;
      await deleteStarted;
      fs.rmSync(path.join(dataDir, key), { force: true });
    },
    flush: async () => {},
    stat: async () => null,
  };
  const store = createAudioNotesStore({ dataDir, blobStore });
  const note = store.create({ bytes: Buffer.from([1, 2]) });

  const first = store.remove(note.id);
  const second = store.remove(note.id);
  assert.equal(deleteCalls, 1);
  releaseDelete();
  assert.deepEqual(await first, await second);
  assert.equal(deleteCalls, 1);
  assert.deepEqual(await store.remove(null), {
    deleted: true,
    id: "",
    already_deleted: true,
    metadata_deleted: true,
    local_deleted: true,
    remote_status: "deleted_or_absent",
  });
});

test("remove preserves metadata when remote deletion fails", async (t) => {
  const dataDir = tempDir(t);
  const blobStore = {
    mode: "gcs",
    finalizeSpool: () => {},
    delete: async () => { throw new Error("bucket denied"); },
  };
  const store = createAudioNotesStore({ dataDir, blobStore });
  const note = store.create({ bytes: Buffer.from([1, 2]) });

  await assert.rejects(store.remove(note.id), (error) => {
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /blob deletion failed: bucket denied/);
    assert.equal(error.deletion.local_deleted, false);
    assert.equal(error.deletion.remote_status, "failed");
    return true;
  });
  assert.ok(store.get(note.id));
  assert.equal(store.status().total_bytes, 2);
});

test("remove reports an undeleted local spool after remote deletion", async (t) => {
  const dataDir = tempDir(t);
  let flushCalls = 0;
  const blobStore = {
    mode: "gcs",
    finalizeSpool: () => {},
    delete: async () => {},
    flush: async () => { flushCalls += 1; },
  };
  const store = createAudioNotesStore({ dataDir, blobStore });
  const note = store.create({ bytes: Buffer.from([1]) });

  await assert.rejects(store.remove(note.id), (error) => {
    assert.match(error.message, /local spool deletion failed/);
    assert.equal(error.deletion.local_deleted, false);
    assert.equal(error.deletion.remote_status, "unverified");
    return true;
  });
  assert.equal(flushCalls, 1);
  assert.ok(store.get(note.id));
});

test("remove reports remote verification failures without discarding metadata", async (t) => {
  const dataDir = tempDir(t);
  const blobStore = {
    mode: "gcs",
    finalizeSpool: () => {},
    delete: async (key) => fs.rmSync(path.join(dataDir, key), { force: true }),
    stat: async () => { throw new Error("stat unavailable"); },
  };
  const store = createAudioNotesStore({ dataDir, blobStore });
  const note = store.create({ bytes: Buffer.from([1]) });

  await assert.rejects(store.remove(note.id), (error) => {
    assert.match(error.message, /remote deletion could not be verified: stat unavailable/);
    assert.equal(error.deletion.local_deleted, true);
    assert.equal(error.deletion.remote_status, "unverified");
    return true;
  });
  assert.ok(store.get(note.id));
});

test("remove reports local byte deletion failures and retained bytes", async (t) => {
  const dataDir = tempDir(t);
  const throwingStore = createAudioNotesStore({ dataDir: path.join(dataDir, "throwing") });
  const throwingNote = throwingStore.create({ bytes: Buffer.from([1]) });
  const throwingPath = throwingStore.audioPath(throwingNote.id);
  const originalRmSync = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (target === throwingPath) throw new Error("disk denied");
    return originalRmSync(target, options);
  };
  try {
    await assert.rejects(throwingStore.remove(throwingNote.id), (error) => {
      assert.equal(error.statusCode, 500);
      assert.match(error.message, /local deletion failed: disk denied/);
      assert.equal(error.deletion.local_deleted, false);
      return true;
    });
  } finally {
    fs.rmSync = originalRmSync;
  }

  const retainedStore = createAudioNotesStore({ dataDir: path.join(dataDir, "retained") });
  const retainedNote = retainedStore.create({ bytes: Buffer.from([2]) });
  const retainedPath = retainedStore.audioPath(retainedNote.id);
  fs.rmSync = (target, options) => target === retainedPath ? undefined : originalRmSync(target, options);
  try {
    await assert.rejects(retainedStore.remove(retainedNote.id), (error) => {
      assert.equal(error.statusCode, 500);
      assert.match(error.message, /local bytes remain after deletion/);
      assert.equal(error.deletion.local_deleted, false);
      return true;
    });
  } finally {
    fs.rmSync = originalRmSync;
  }
});

test("remove reports metadata deletion failures and retained metadata", async (t) => {
  const dataDir = tempDir(t);
  const throwingStore = createAudioNotesStore({ dataDir: path.join(dataDir, "throwing") });
  const throwingNote = throwingStore.create({ bytes: Buffer.from([1]) });
  const throwingMetadata = path.join(throwingStore.notesDir, `${throwingNote.id}.json`);
  const originalRmSync = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (target === throwingMetadata) throw new Error("metadata denied");
    return originalRmSync(target, options);
  };
  try {
    await assert.rejects(throwingStore.remove(throwingNote.id), (error) => {
      assert.equal(error.statusCode, 500);
      assert.match(error.message, /metadata deletion failed: metadata denied/);
      assert.equal(error.deletion.local_deleted, true);
      return true;
    });
  } finally {
    fs.rmSync = originalRmSync;
  }

  const retainedStore = createAudioNotesStore({ dataDir: path.join(dataDir, "retained") });
  const retainedNote = retainedStore.create({ bytes: Buffer.from([2]) });
  const retainedMetadata = path.join(retainedStore.notesDir, `${retainedNote.id}.json`);
  fs.rmSync = (target, options) => target === retainedMetadata ? undefined : originalRmSync(target, options);
  try {
    await assert.rejects(retainedStore.remove(retainedNote.id), (error) => {
      assert.equal(error.statusCode, 500);
      assert.match(error.message, /metadata remains after deletion/);
      assert.equal(error.deletion.local_deleted, true);
      return true;
    });
  } finally {
    fs.rmSync = originalRmSync;
  }
});
