"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createBlobStore, createGcsClient, contentTypeForKey } = require("../lib/blob-store");

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "blob-store-test-"));
}

const FAKE_TOKEN_SOURCE = {
  token: async () => "test-token",
  credentialType: () => "service_account",
};

// Minimal in-process GCS: upload (uploadType=media), stat, media read, delete.
// options.failUploads makes the next N uploads return 500 (retry testing).
function startFakeGcs(options = {}) {
  const objects = new Map(); // name -> { bytes, contentType }
  const state = { failUploads: Number(options.failUploads || 0), uploads: 0 };
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
        state.uploads += 1;
        if (state.failUploads > 0) {
          state.failUploads -= 1;
          sendJson(500, { error: "injected upload failure" });
          return;
        }
        if (url.searchParams.get("ifGenerationMatch") === "0" && objects.has(name)) {
          sendJson(412, { error: "precondition failed" });
          return;
        }
        objects.set(name, {
          bytes: Buffer.concat(chunks),
          contentType: request.headers["content-type"] || "application/octet-stream",
        });
        sendJson(200, { name, size: String(Buffer.concat(chunks).length) });
      });
      return;
    }
    const objectMatch = url.pathname.match(/^\/storage\/v1\/b\/[^/]+\/o\/([^/]+)$/);
    if (objectMatch) {
      const name = decodeURIComponent(objectMatch[1]);
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

function gcsStore(dataDir, endpoint, extraEnv = {}) {
  return createBlobStore({
    dataDir,
    env: {
      BLOB_STORE: "gcs",
      GCS_BUCKET: "test-bucket",
      GCS_ENDPOINT: endpoint,
      ...extraEnv,
    },
    tokenSource: FAKE_TOKEN_SOURCE,
    // Fast retries so failure tests finish quickly.
    retryDelaysMs: [10, 10, 10],
  });
}

test("local driver round-trips put/stat/read/delete with no bucket", async () => {
  const dataDir = tempDataDir();
  const store = createBlobStore({ dataDir, env: {} });
  assert.strictEqual(store.mode, "local");

  await store.put("audio-notes/a.pcm", Buffer.from("pcm-data"), { contentType: "audio/L16" });
  assert.strictEqual(fs.readFileSync(path.join(dataDir, "audio-notes/a.pcm"), "utf8"), "pcm-data");
  // No .tmp residue from the atomic write.
  assert.deepStrictEqual(
    fs.readdirSync(path.join(dataDir, "audio-notes")).filter((name) => name.endsWith(".tmp")),
    [],
  );

  assert.strictEqual((await store.stat("audio-notes/a.pcm")).size, 8);
  const found = await store.getReadStream("audio-notes/a.pcm");
  assert.strictEqual(found.source, "local");
  assert.strictEqual(found.size, 8);
  found.stream.destroy();
  assert.deepStrictEqual(await store.readBytes("audio-notes/a.pcm"), Buffer.from("pcm-data"));
  assert.strictEqual(await store.ensureLocal("audio-notes/a.pcm"), path.join(dataDir, "audio-notes/a.pcm"));

  await store.delete("audio-notes/a.pcm");
  assert.strictEqual(await store.stat("audio-notes/a.pcm"), null);
  assert.strictEqual(await store.getReadStream("audio-notes/a.pcm"), null);
  assert.deepStrictEqual(store.status(), { mode: "local" });
});

test("invalid keys are rejected", () => {
  const store = createBlobStore({ dataDir: tempDataDir(), env: {} });
  assert.throws(() => store.localPath("../escape"), /invalid blob key/);
  assert.throws(() => store.localPath("/absolute"), /invalid blob key/);
  assert.throws(() => store.localPath(""), /invalid blob key/);
});

test("gcs mode requires GCS_BUCKET", () => {
  assert.throws(
    () => createBlobStore({ dataDir: tempDataDir(), env: { BLOB_STORE: "gcs" } }),
    /GCS_BUCKET/,
  );
});

test("gcs put uploads write-behind and reads fall through after spool prune", async () => {
  const fake = await startFakeGcs();
  const dataDir = tempDataDir();
  const store = gcsStore(dataDir, fake.endpoint);

  await store.put("voice-sessions/s1/t1.pcm", Buffer.from("voice-bytes"), {
    contentType: "audio/L16; rate=16000; channels=1",
  });
  await store.flush();
  assert.ok(fake.objects.has("voice-sessions/s1/t1.pcm"));
  assert.strictEqual(
    fake.objects.get("voice-sessions/s1/t1.pcm").contentType,
    "audio/L16; rate=16000; channels=1",
  );

  // Spool-first read.
  let found = await store.getReadStream("voice-sessions/s1/t1.pcm");
  assert.strictEqual(found.source, "local");
  found.stream.destroy();

  // Prune the spool: reads fall through to the bucket.
  fs.unlinkSync(path.join(dataDir, "voice-sessions/s1/t1.pcm"));
  found = await store.getReadStream("voice-sessions/s1/t1.pcm");
  assert.strictEqual(found.source, "gcs");
  assert.strictEqual(found.size, 11);
  const chunks = [];
  for await (const chunk of found.stream) chunks.push(chunk);
  assert.strictEqual(Buffer.concat(chunks).toString(), "voice-bytes");

  // ensureLocal downloads the object back to the spool.
  const restored = await store.ensureLocal("voice-sessions/s1/t1.pcm");
  assert.strictEqual(restored, path.join(dataDir, "voice-sessions/s1/t1.pcm"));
  assert.strictEqual(fs.readFileSync(restored, "utf8"), "voice-bytes");

  await fake.close();
});

test("finalizeSpool uploads an externally written spool file", async () => {
  const fake = await startFakeGcs();
  const dataDir = tempDataDir();
  const store = gcsStore(dataDir, fake.endpoint);

  const spoolPath = store.localPath("voice-sessions/s1/t2.assistant.pcm");
  fs.writeFileSync(spoolPath, "assistant-bytes");
  store.finalizeSpool("voice-sessions/s1/t2.assistant.pcm", { contentType: "audio/L16" });
  await store.flush();
  assert.strictEqual(
    fake.objects.get("voice-sessions/s1/t2.assistant.pcm").bytes.toString(),
    "assistant-bytes",
  );
  await fake.close();
});

test("upload retries after failures and status reports them", async () => {
  const fake = await startFakeGcs({ failUploads: 2 });
  const store = gcsStore(tempDataDir(), fake.endpoint);

  await store.put("audio-notes/n1.pcm", Buffer.from("note"), { contentType: "audio/L16" });
  await store.flush();
  assert.ok(fake.objects.has("audio-notes/n1.pcm"));
  assert.ok(fake.state.uploads >= 3);
  const status = store.status();
  assert.strictEqual(status.mode, "gcs");
  assert.strictEqual(status.pending_uploads, 0);
  assert.ok(status.failed_upload_attempts >= 2);
  assert.match(String(status.last_error), /injected upload failure/);
  await fake.close();
});

test("delete removes spool and bucket object and tombstones in-flight uploads", async () => {
  const fake = await startFakeGcs();
  const dataDir = tempDataDir();
  const store = gcsStore(dataDir, fake.endpoint);

  // Simple delete: object present in both places, gone from both.
  await store.put("video-notes/v1.webm", Buffer.from("video"), { contentType: "video/webm" });
  await store.flush();
  assert.ok(fake.objects.has("video-notes/v1.webm"));
  await store.delete("video-notes/v1.webm");
  assert.ok(!fake.objects.has("video-notes/v1.webm"));
  assert.ok(!fs.existsSync(path.join(dataDir, "video-notes/v1.webm")));

  // Tombstone race: delete while the first upload attempt is failing. The
  // retried upload must not resurrect the object.
  const failing = await startFakeGcs({ failUploads: 1 });
  const store2 = gcsStore(tempDataDir(), failing.endpoint);
  await store2.put("voice-sessions/s/incog.pcm", Buffer.from("secret"), { contentType: "audio/L16" });
  await store2.delete("voice-sessions/s/incog.pcm");
  await store2.flush();
  assert.ok(!failing.objects.has("voice-sessions/s/incog.pcm"));
  await failing.close();
  await fake.close();
});

test("janitor re-enqueues unuploaded spool files and prunes confirmed old ones", async () => {
  const fake = await startFakeGcs();
  const dataDir = tempDataDir();
  const store = createBlobStore({
    dataDir,
    env: {
      BLOB_STORE: "gcs",
      GCS_BUCKET: "test-bucket",
      GCS_ENDPOINT: fake.endpoint,
      BLOB_SPOOL_MAX_AGE_MS: "3600000",
    },
    tokenSource: FAKE_TOKEN_SOURCE,
    retryDelaysMs: [10],
  });

  // A spool file the store never saw (e.g. written before a crash/restart),
  // aged past the mid-write guard.
  const orphan = store.localPath("audio-notes/orphan.pcm");
  fs.writeFileSync(orphan, "orphan-bytes");
  const oldTime = new Date(Date.now() - 120000);
  fs.utimesSync(orphan, oldTime, oldTime);

  await store.sweepSpool();
  await store.flush();
  assert.strictEqual(fake.objects.get("audio-notes/orphan.pcm").bytes.toString(), "orphan-bytes");
  // Confirmed but younger than max age: stays.
  assert.ok(fs.existsSync(orphan));

  // Age it past the retention window: the next sweep prunes the spool copy.
  const ancient = new Date(Date.now() - 7200000);
  fs.utimesSync(orphan, ancient, ancient);
  await store.sweepSpool();
  assert.ok(!fs.existsSync(orphan));
  // The bucket copy is untouched and reads still work.
  assert.deepStrictEqual(await store.readBytes("audio-notes/orphan.pcm"), Buffer.from("orphan-bytes"));

  await fake.close();
});

test("createGcsClient ifAbsent upload treats 412 as already-uploaded", async () => {
  const fake = await startFakeGcs();
  const client = createGcsClient({
    bucket: "test-bucket",
    endpoint: fake.endpoint,
    tokenSource: FAKE_TOKEN_SOURCE,
  });
  const first = await client.upload("k1", Buffer.from("abc"), "text/plain", { ifAbsent: true });
  assert.strictEqual(first.existed, false);
  const second = await client.upload("k1", Buffer.from("abc"), "text/plain", { ifAbsent: true });
  assert.strictEqual(second.existed, true);
  assert.strictEqual((await client.stat("k1")).size, 3);
  await client.delete("k1");
  assert.strictEqual(await client.stat("k1"), null);
  // Deleting a missing object is tolerated.
  await client.delete("k1");
  await fake.close();
});

test("contentTypeForKey maps blob extensions", () => {
  assert.match(contentTypeForKey("voice-sessions/s/t.pcm"), /audio\/L16/);
  assert.strictEqual(contentTypeForKey("audio-notes/n.webm"), "audio/webm");
  assert.strictEqual(contentTypeForKey("video-notes/v.webm"), "video/webm");
  assert.strictEqual(contentTypeForKey("video-notes/v.mp4"), "video/mp4");
  assert.strictEqual(contentTypeForKey("audio-notes/n.bin"), "application/octet-stream");
});
