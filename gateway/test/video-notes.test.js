"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createVideoNotesStore,
  videoInlinePart,
  bareMimeType,
  DEFAULT_CONTENT_TYPE,
} = require("../lib/video-notes");

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "video-notes-test-"));
}

test("create stores bytes and metadata, get and readBytes round-trip", async () => {
  const dataDir = tempDataDir();
  const store = createVideoNotesStore({ dataDir });
  const bytes = Buffer.from("webm-bytes-placeholder");
  const note = store.create({
    bytes,
    content_type: "video/webm;codecs=vp8,opus",
    surface: "agee-extension",
    session_id: "session-1",
    duration_ms: "12000",
  });

  assert.ok(note.id.startsWith("vnote_"));
  assert.strictEqual(note.bytes, bytes.length);
  assert.strictEqual(note.duration_ms, 12000);
  assert.strictEqual(note.video.href, `/v1/video-notes/${note.id}/video`);

  const loaded = store.get(note.id);
  assert.strictEqual(loaded.id, note.id);
  assert.deepStrictEqual(await store.readBytes(note.id), bytes);
  // codecs parameter maps to the .webm extension
  assert.ok(store.videoPath(note.id).endsWith(".webm"));
  assert.strictEqual(store.list().length, 1);
});

test("empty body is refused and quota refuses instead of pruning", () => {
  const dataDir = tempDataDir();
  const store = createVideoNotesStore({ dataDir, maxTotalBytes: 10 });
  assert.throws(() => store.create({ bytes: Buffer.alloc(0) }), /empty/);

  store.create({ bytes: Buffer.alloc(8), content_type: "video/webm" });
  assert.throws(
    () => store.create({ bytes: Buffer.alloc(8), content_type: "video/webm" }),
    (error) => error.statusCode === 507 && /quota/.test(error.message),
  );
  // The first note survives the quota refusal.
  assert.strictEqual(store.list().length, 1);
});

test("remove deletes blob and metadata and frees quota", async () => {
  const dataDir = tempDataDir();
  const store = createVideoNotesStore({ dataDir, maxTotalBytes: 10 });
  const note = store.create({ bytes: Buffer.alloc(8), content_type: "video/webm" });
  const blobPath = store.videoPath(note.id);
  assert.ok(fs.existsSync(blobPath));

  assert.strictEqual(await store.remove(note.id), true);
  assert.strictEqual(store.get(note.id), null);
  assert.ok(!fs.existsSync(blobPath));
  assert.strictEqual(await store.remove(note.id), false);

  // Quota was freed: a new note fits again.
  const next = store.create({ bytes: Buffer.alloc(8), content_type: "video/webm" });
  assert.ok(next.id);
});

test("store reloads existing totals from disk", () => {
  const dataDir = tempDataDir();
  const first = createVideoNotesStore({ dataDir, maxTotalBytes: 10 });
  first.create({ bytes: Buffer.alloc(8), content_type: "video/webm" });

  const second = createVideoNotesStore({ dataDir, maxTotalBytes: 10 });
  assert.strictEqual(second.status().total_bytes, 8);
  assert.throws(() => second.create({ bytes: Buffer.alloc(8) }), /quota/);
});

test("videoInlinePart strips codec parameters and base64-encodes", () => {
  const note = { content_type: "video/webm;codecs=vp8,opus" };
  const bytes = Buffer.from("abc");
  const part = videoInlinePart(note, bytes);
  assert.strictEqual(part.inlineData.mimeType, "video/webm");
  assert.strictEqual(part.inlineData.data, bytes.toString("base64"));

  assert.strictEqual(videoInlinePart(note, Buffer.alloc(0)), null);
  assert.strictEqual(videoInlinePart(null, bytes), null);
  assert.strictEqual(videoInlinePart({}, bytes).inlineData.mimeType, DEFAULT_CONTENT_TYPE);
});

test("bareMimeType and extension mapping", () => {
  assert.strictEqual(bareMimeType("Video/MP4; foo=bar"), "video/mp4");
  const dataDir = tempDataDir();
  const store = createVideoNotesStore({ dataDir });
  const mp4 = store.create({ bytes: Buffer.alloc(4), content_type: "video/mp4" });
  assert.ok(store.videoPath(mp4.id).endsWith(".mp4"));
  const other = store.create({ bytes: Buffer.alloc(4), content_type: "application/octet-stream" });
  assert.ok(store.videoPath(other.id).endsWith(".bin"));
});
