#!/usr/bin/env node
"use strict";

// Smoke for record-mode audio notes. This is the storage-only lane:
// raw bytes -> /v1/audio-notes -> DATA_DIR/audio-notes, with no STT/LLM/TTS.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable, Writable } = require("node:stream");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "audio-notes-smoke-token";
const { createAudioNoteHandlers, createAudioNotesStore } = require(path.join(GATEWAY_DIR, "lib", "audio-notes"));
const { createEventSubstrateStore } = require(path.join(GATEWAY_DIR, "lib", "event-substrate"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-audio-notes-smoke-"));
  const storeDir = path.join(tempDir, "store");
  const dataDir = path.join(tempDir, "data");

  try {
    await step("store writes bytes + metadata without voice providers", () => assertStore(storeDir));

    const store = createAudioNotesStore({ dataDir });
    const events = createEventSubstrateStore({ dataDir, originId: "audio-notes-smoke" });
    const handlers = createAudioNoteHandlers({
      store,
      recordCreated: (note) => events.appendEvent({
        event_type: "audio_note.created",
        stream_id: note.session_id ? `session:${note.session_id}` : `audio-note:${note.id}`,
        idempotency_key: `audio-note:${note.id}:created`,
        occurred_at: note.created_at,
        actor: { kind: "user", id: note.surface || "audio-note" },
        correlation_id: note.id,
        payload: {
          id: note.id,
          session_id: note.session_id || "",
          bytes: note.bytes || 0,
          audio: note.audio || null,
        },
      }),
    });
    await step("health exposes audio notes status", () => assertStatus(store));
    await step("POST stores synthetic PCM bytes", () => assertHttpRoundTrip(handlers));
    await step("missing note returns 404", () => assertMissingNote(handlers));
    await step("empty body returns 400", () => assertEmptyBody(handlers));
    await step("creation is mirrored as product event", () => assertProductEventMirrored(dataDir));
    await step("record mode did not invoke voice providers", () => assertNoVoiceProviderSideEffects(dataDir));

    console.log("smoke-audio-notes: ok");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

function assertStore(dir) {
  const providerLoaded = Object.keys(require.cache).some((filePath) => filePath.endsWith(`${path.sep}lib${path.sep}voice-providers.js`));
  assert.equal(providerLoaded, false, "audio-notes store must not load voice providers");

  const store = createAudioNotesStore({ dataDir: dir });
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  const note = store.create({
    bytes: pcm,
    content_type: "audio/L16; rate=16000; channels=1",
    surface: "smoke",
    session_id: "store-session",
    duration_ms: 250,
    label: "Store smoke",
  });

  assert.match(note.id, /^note_[a-z0-9]+_[a-f0-9]+$/, "note id must use the note_<timestamp>_<rand> shape");
  assert.equal(note.bytes, pcm.length, "metadata byte count must match input bytes");
  assert.equal(note.audio.kind, "note");
  assert.equal(note.audio.encoding, "pcm16");
  assert.equal(note.audio.href, `/v1/audio-notes/${encodeURIComponent(note.id)}/audio`);
  assert.deepEqual(fs.readFileSync(store.audioPath(note.id)), pcm, "stored bytes must match input bytes");
  assert.equal(store.get(note.id).label, "Store smoke", "stored metadata must reload");
  assert.equal(store.list({ limit: 10 })[0].id, note.id, "list must include the stored note");
}

async function assertStatus(store) {
  const status = store.status();
  assert.equal(status.count, 0, "fresh audio notes status must report zero notes");
  assert.equal(status.endpoint, "/v1/audio-notes");
}

async function assertHttpRoundTrip(handlers) {
  const pcm = Buffer.from([9, 0, 8, 0, 7, 0, 6, 0, 5, 0]);
  const posted = await requestRaw(handlers, "/v1/audio-notes", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "audio/L16; rate=16000; channels=1",
      "x-moa-surface": "smoke-http",
      "x-moa-session-id": "note-session",
      "x-moa-duration-ms": "500",
      "x-moa-label": "HTTP smoke",
    },
    body: pcm,
  });
  assert.equal(posted.status, 201, `POST must return 201: ${posted.text}`);
  const payload = JSON.parse(posted.text);
  assert.ok(payload.note?.id, "POST response must include note.id");
  assert.equal(payload.note.bytes, pcm.length, "POST response byte count must match");
  assert.equal(payload.note.session_id, "note-session", "session header must be stored");
  assert.equal(payload.note.label, "HTTP smoke", "label header must be stored");
  assert.equal(payload.note.audio.href, `/v1/audio-notes/${encodeURIComponent(payload.note.id)}/audio`);

  const audio = await requestRaw(handlers, payload.note.audio.href);
  assert.equal(audio.status, 200, `GET audio must return 200: ${audio.text}`);
  assert.equal(audio.contentType, "audio/L16; rate=16000; channels=1");
  assert.deepEqual(audio.buffer, pcm, "GET audio bytes must be byte-identical");

  const listed = await getJson(handlers, "/v1/audio-notes?limit=10");
  assert.ok(Array.isArray(listed.notes), "list response must include notes array");
  assert.ok(listed.notes.some((note) => note.id === payload.note.id), "list must include created note");

  const fetched = await getJson(handlers, `/v1/audio-notes/${encodeURIComponent(payload.note.id)}`);
  assert.equal(fetched.note.id, payload.note.id, "GET note must return the created note");
}

async function assertMissingNote(handlers) {
  const missing = await requestRaw(handlers, "/v1/audio-notes/note_missing/audio");
  assert.equal(missing.status, 404, "missing note audio must return 404");
}

async function assertEmptyBody(handlers) {
  const empty = await requestRaw(handlers, "/v1/audio-notes", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "audio/L16; rate=16000; channels=1",
    },
    body: Buffer.alloc(0),
  });
  assert.equal(empty.status, 400, `empty body must return 400: ${empty.text}`);
}

async function assertProductEventMirrored(dataDir) {
  const eventsPath = path.join(dataDir, "product-events.jsonl");
  await settle(() => {
    const events = readJsonLines(eventsPath);
    return events.some((event) => event.event_type === "audio_note.created");
  }, 1000, "audio_note.created event was not mirrored");
}

function assertNoVoiceProviderSideEffects(dataDir) {
  const providerEvents = path.join(dataDir, "voice-provider-events.jsonl");
  assert.equal(fs.existsSync(providerEvents), false, "audio notes must not create voice provider events");
}

async function getJson(handlers, url, options = {}) {
  const response = await requestRaw(handlers, url, { headers: options.auth === false ? {} : authHeaders() });
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${response.text}`);
  return JSON.parse(response.text);
}

async function requestRaw(handlers, pathname, options = {}) {
  const url = new URL(pathname, "http://127.0.0.1");
  const request = Readable.from(options.body ? [options.body] : []);
  request.method = options.method || "GET";
  request.url = `${url.pathname}${url.search}`;
  request.headers = { host: "127.0.0.1", ...(options.headers || authHeaders()) };
  const response = new MemoryResponse();
  if (request.method === "POST" && url.pathname === "/v1/audio-notes") {
    await handlers.create(request, response);
  } else if (request.method === "GET" && url.pathname === "/v1/audio-notes") {
    handlers.list(response, url);
  } else if (request.method === "GET" && url.pathname.startsWith("/v1/audio-notes/") && url.pathname.endsWith("/audio")) {
    handlers.sendAudio(response, url);
  } else if (request.method === "GET" && url.pathname.startsWith("/v1/audio-notes/")) {
    handlers.get(response, url);
  } else {
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not found" }));
  }
  await response.done;
  const buffer = Buffer.concat(response.chunks);
  return {
    status: response.statusCode,
    text: buffer.toString("utf8"),
    buffer,
    contentType: response.headers["content-type"] || "",
  };
}

class MemoryResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.done = new Promise((resolve) => this.on("finish", resolve));
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = String(value);
  }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) {
      this.setHeader(name, value);
    }
    return this;
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }
}

function authHeaders() {
  return { authorization: `Bearer ${TOKEN}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error(message);
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
