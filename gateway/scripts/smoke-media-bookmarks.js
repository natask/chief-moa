#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "media-bookmarks-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-media-bookmarks-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let gateway;
  try {
    gateway = spawn(process.execPath, ["server.js"], {
      cwd: GATEWAY_DIR,
      env: {
        PATH: process.env.PATH || "",
        TMPDIR: process.env.TMPDIR || os.tmpdir(),
        HOST: "127.0.0.1",
        PORT: String(port),
        DATA_DIR: dataDir,
        ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
        MOA_GATEWAY_TOKEN: TOKEN,
        MODEL_PROVIDER: "openai-compatible",
        MODEL_API_KEY: "",
        OPENAI_API_KEY: "",
        DATABASE_URL: "",
        ACCOUNT_HEALTH_INTERVAL_MS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logs = collectLogs(gateway);
    await waitForHealth(baseUrl, logs);

    const preflight = await fetch(`${baseUrl}/v1/media/bookmarks/bookmark_1`, { method: "OPTIONS" });
    assert.match(preflight.headers.get("access-control-allow-methods") || "", /DELETE/);
    assert.equal((await request(baseUrl, "/v1/media/bookmarks", { auth: false })).status, 401);
    const created = await request(baseUrl, "/v1/media/bookmarks", {
      method: "POST",
      body: {
        provider: "youtube",
        video_id: "dQw4w9WgXcQ",
        position_ms: 42_500,
        label: "favorite chorus",
        title: "Smoke video",
        aliases: ["the harmony"],
        preferred_package: "app.revanced.android.youtube",
        preferred_instance: "YouTube Advanced",
        source_surface: "android",
        idempotency_key: "smoke-create-1",
        user_approved: true,
        owner_id: "usr_attacker_supplied",
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.bookmark.provider, "youtube");
    assert.equal(created.json.bookmark.canonical_url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    for (const privateField of ["owner_id", "idempotency_key", "user_approved", "preferred_package", "preferred_instance"]) {
      assert.equal(created.json.bookmark[privateField], undefined, `${privateField} leaked from the shared projection`);
    }
    const id = created.json.bookmark.id;

    const replay = await request(baseUrl, "/v1/media/bookmarks", { method: "POST", body: {
      provider: "youtube", video_id: "dQw4w9WgXcQ", position_ms: 42_500, label: "favorite chorus", title: "Smoke video",
      aliases: ["the harmony"], preferred_package: "app.revanced.android.youtube",
      preferred_instance: "YouTube Advanced", source_surface: "android",
      idempotency_key: "smoke-create-1", user_approved: true, owner_id: "usr_attacker_supplied",
    } });
    assert.equal(replay.json.bookmark.id, id);

    const listed = await request(baseUrl, "/v1/media/bookmarks?source_surface=android&limit=1");
    assert.deepEqual(listed.json.bookmarks.map((item) => item.id), [id]);
    const resolved = await request(baseUrl, "/v1/media/bookmarks?query=the%20harmony");
    assert.equal(resolved.json.resolution.bookmark.id, id);
    const beforeDelete = JSON.parse(fs.readFileSync(path.join(dataDir, "media-bookmarks.json"), "utf8"));
    assert.match(beforeDelete.bookmarks[0].owner_id, /^usr_[a-f0-9]{16}$/);
    assert.notEqual(beforeDelete.bookmarks[0].owner_id, "usr_attacker_supplied");
    assert.equal(beforeDelete.bookmarks[0].preferred_package, undefined);
    assert.equal(beforeDelete.bookmarks[0].preferred_instance, undefined);
    assert.equal((await request(baseUrl, `/v1/media/bookmarks/${encodeURIComponent(id)}`)).json.bookmark.id, id);
    for (const malformed of [`${id}%20`, `${id}%0A`, `${id}%2Fextra`, `${id}%00`, "a".repeat(121)]) {
      assert.equal((await request(baseUrl, `/v1/media/bookmarks/${malformed}`, { method: "DELETE" })).status, 400);
    }
    assert.equal((await request(baseUrl, `/v1/media/bookmarks/${encodeURIComponent(id)}`)).status, 200);
    assert.equal((await request(baseUrl, `/v1/media/bookmarks/${encodeURIComponent(id)}`, { method: "DELETE" })).status, 200);
    const repeatedDelete = await request(baseUrl, `/v1/media/bookmarks/${encodeURIComponent(id)}`, { method: "DELETE" });
    assert.deepEqual(repeatedDelete, { status: 200, json: { deleted: false, already_absent: true } });
    assert.equal((await request(baseUrl, `/v1/media/bookmarks/${encodeURIComponent(id)}`)).status, 404);

    const disk = JSON.parse(fs.readFileSync(path.join(dataDir, "media-bookmarks.json"), "utf8"));
    assert.deepEqual(disk, { version: 1, bookmarks: [] });
    console.log(JSON.stringify({ ok: true, checks: [
      "all media bookmark routes require gateway authorization",
      "browser preflight permits bookmark deletion",
      "approved create is canonical and idempotent",
      "synced records use the fixed youtube provider",
      "token-derived ownership and dedupe metadata stay private; device package hints are not persisted",
      "list, alias resolution, and item reads round-trip over HTTP",
      "delete removes the durable record",
      "strict opaque IDs reject aliases and valid repeated delete converges",
      "no provider endpoint is configured or called",
    ] }, null, 2));
  } finally {
    if (gateway) gateway.kill("SIGTERM");
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: {
      ...(options.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, json: await response.json() };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    if (logs.exited) throw new Error(`gateway exited before health\n${logs.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`gateway health timed out\n${logs.text()}`);
}

function collectLogs(child) {
  let output = "";
  const append = (chunk) => { output = (output + chunk.toString("utf8")).slice(-12_000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const logs = { exited: false, text: () => output };
  child.on("exit", () => { logs.exited = true; });
  return logs;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
