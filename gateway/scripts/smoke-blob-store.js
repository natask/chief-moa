#!/usr/bin/env node
"use strict";

// Smoke for the GCS blob-store lane: notes stores + voice-turn spool wired to
// a fake in-process GCS. Proves write-behind upload, dual-read after the
// spool is pruned, retranscribe-style ensureLocal, and delete-everywhere —
// with no real Google account.

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const { createBlobStore } = require(path.join(GATEWAY_DIR, "lib", "blob-store"));
const { createAudioNotesStore } = require(path.join(GATEWAY_DIR, "lib", "audio-notes"));
const { createVideoNotesStore } = require(path.join(GATEWAY_DIR, "lib", "video-notes"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-blob-store-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const fake = await startFakeGcs();

  try {
    const blobStore = createBlobStore({
      dataDir,
      env: { BLOB_STORE: "gcs", GCS_BUCKET: "smoke-bucket", GCS_ENDPOINT: fake.endpoint },
      tokenSource: { token: async () => "smoke-token", credentialType: () => "service_account" },
      retryDelaysMs: [10, 10],
    });

    await step("audio note create uploads write-behind, read survives spool prune", async () => {
      const store = createAudioNotesStore({ dataDir, blobStore });
      const note = store.create({ bytes: Buffer.from("pcm-note-bytes"), content_type: "audio/L16" });
      await blobStore.flush();
      assert.ok(fake.objects.has(`audio-notes/${note.id}.pcm`), "note bytes reached the bucket");

      fs.unlinkSync(path.join(dataDir, "audio-notes", `${note.id}.pcm`));
      const found = await store.stream(note.id);
      assert.ok(found, "dual read found the bucket copy");
      assert.strictEqual(found.size, 14);
      assert.strictEqual(Buffer.concat(await collect(found.stream)).toString(), "pcm-note-bytes");
      assert.strictEqual((await store.remove(note.id)).deleted, true);
      assert.ok(!fake.objects.has(`audio-notes/${note.id}.pcm`), "audio note delete removed the bucket copy");
      assert.strictEqual(store.get(note.id), null, "audio note delete removed canonical metadata");
    });

    await step("video note round-trips and remove deletes the bucket object", async () => {
      const store = createVideoNotesStore({ dataDir, blobStore });
      const note = store.create({ bytes: Buffer.from("webm-video-bytes"), content_type: "video/webm" });
      await blobStore.flush();
      const key = `video-notes/${note.id}.webm`;
      assert.ok(fake.objects.has(key), "video bytes reached the bucket");

      fs.unlinkSync(path.join(dataDir, "video-notes", `${note.id}.webm`));
      assert.strictEqual((await store.readBytes(note.id)).toString(), "webm-video-bytes");

      assert.strictEqual(await store.remove(note.id), true);
      assert.ok(!fake.objects.has(key), "bucket object deleted with the note");
      assert.strictEqual(store.get(note.id), null);
    });

    await step("voice-turn spool finalizes to the bucket; ensureLocal restores after prune", async () => {
      const key = "voice-sessions/smoke-session/turn-1.pcm";
      const spool = blobStore.localPath(key);
      fs.writeFileSync(spool, "streamed-voice-pcm");
      blobStore.finalizeSpool(key, { contentType: "audio/L16; rate=16000; channels=1" });
      await blobStore.flush();
      assert.ok(fake.objects.has(key), "voice pcm reached the bucket");

      fs.unlinkSync(spool);
      const restored = await blobStore.ensureLocal(key);
      assert.strictEqual(restored, spool, "ensureLocal rematerialized the spool path");
      assert.strictEqual(fs.readFileSync(restored, "utf8"), "streamed-voice-pcm");
    });

    await step("incognito delete tombstones a pending upload", async () => {
      fake.state.failUploads = 1;
      const key = "voice-sessions/smoke-session/incognito.pcm";
      fs.writeFileSync(blobStore.localPath(key), "must-not-survive");
      blobStore.finalizeSpool(key, { contentType: "audio/L16" });
      await blobStore.delete(key);
      await blobStore.flush();
      assert.ok(!fake.objects.has(key), "deleted turn never landed in the bucket");
      assert.ok(!fs.existsSync(blobStore.localPath(key).replace(/\.tmp$/, "")) || !fs.existsSync(path.join(dataDir, key)), "spool removed");
    });

    await step("status reports gcs mode with an empty queue", () => {
      const status = blobStore.status();
      assert.strictEqual(status.mode, "gcs");
      assert.strictEqual(status.bucket, "smoke-bucket");
      assert.strictEqual(status.pending_uploads, 0);
    });

    console.log("smoke-blob-store: ok");
  } finally {
    await fake.close();
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

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(chunks));
    stream.on("error", reject);
  });
}

// Minimal in-process GCS JSON/media API (upload, stat, media read, delete).
function startFakeGcs() {
  const objects = new Map();
  const state = { failUploads: 0 };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const sendJson = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "POST" && url.pathname.startsWith("/upload/storage/v1/b/")) {
      const name = decodeURIComponent(url.searchParams.get("name") || "");
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        if (state.failUploads > 0) {
          state.failUploads -= 1;
          sendJson(500, { error: "injected upload failure" });
          return;
        }
        const bytes = Buffer.concat(chunks);
        objects.set(name, { bytes, contentType: request.headers["content-type"] || "" });
        sendJson(200, { name, size: String(bytes.length) });
      });
      return;
    }
    const match = url.pathname.match(/^\/storage\/v1\/b\/[^/]+\/o\/([^/]+)$/);
    if (match) {
      const name = decodeURIComponent(match[1]);
      const object = objects.get(name);
      if (request.method === "GET") {
        if (!object) return sendJson(404, { error: "not found" });
        if (url.searchParams.get("alt") === "media") {
          response.writeHead(200, { "content-type": object.contentType });
          response.end(object.bytes);
          return;
        }
        return sendJson(200, { name, size: String(object.bytes.length), contentType: object.contentType });
      }
      if (request.method === "DELETE") {
        if (!object) return sendJson(404, { error: "not found" });
        objects.delete(name);
        response.writeHead(204);
        response.end();
        return;
      }
    }
    sendJson(400, { error: `unexpected ${request.method} ${request.url}` });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        endpoint: `http://127.0.0.1:${server.address().port}`,
        objects,
        state,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
