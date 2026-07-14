"use strict";

// Rollback-capable versioned Android OTA serving. Covers the pure release-store
// module (manifest with/without rollback, requires_reinstall, legacy-single
// migration, path-traversal rejection) and the HTTP surface exposed by
// server.js (release APK download, admin rollback happy path + no-previous
// refusal + auth refusal, release-APK traversal rejection).

const assert = require("node:assert/strict");
const { test, before, after, beforeEach } = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

// server.js reads ANDROID_OTA_DIR and MOA_GATEWAY_TOKEN at load time, so the
// env must be set before requiring it.
const HTTP_OTA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "moa-ota-http-"));
const GATEWAY_TOKEN = "test-ota-gateway-token";
process.env.ANDROID_OTA_DIR = HTTP_OTA_DIR;
process.env.MOA_GATEWAY_TOKEN = GATEWAY_TOKEN;

const androidOta = require("../lib/android-ota");
const { server } = require("../server");

function makeApk(marker) {
  return Buffer.from(`PK fake apk ${marker} ${crypto.randomBytes(8).toString("hex")}`);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "moa-ota-mod-"));
}

function publish(dir, { version_code, version_name, published_at, release_id, marker }) {
  const apk = makeApk(marker || version_code);
  return androidOta.publishRelease(dir, {
    apk,
    meta: {
      app_id: "ai.moa.assistant",
      version_code,
      version_name,
      git_sha: "deadbeef",
      published_at,
      release_id,
    },
  });
}

// ---------------------------------------------------------------------------
// Pure module behavior
// ---------------------------------------------------------------------------

test("manifest without any older release omits rollback fields", () => {
  const dir = tempDir();
  try {
    publish(dir, { version_code: 10, version_name: "0.1.10", published_at: "2026-07-01T00:00:00Z" });
    const manifest = androidOta.buildLatestManifest(dir);
    assert.equal(manifest.version_code, 10);
    assert.equal(manifest.release_id, "ai.moa.assistant-10");
    assert.equal(manifest.rollback_available, undefined);
    assert.equal(manifest.rollback, undefined);
    // Legacy compatibility keys are still present for pre-rollback clients.
    assert.equal(manifest.built_at, manifest.published_at);
    assert.equal(manifest.apk, "moa-assistant.apk");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest with an older release exposes rollback + requires_reinstall true on downgrade", () => {
  const dir = tempDir();
  try {
    publish(dir, { version_code: 10, version_name: "0.1.10", published_at: "2026-07-01T00:00:00Z" });
    publish(dir, { version_code: 11, version_name: "0.1.11", published_at: "2026-07-02T00:00:00Z" });
    const manifest = androidOta.buildLatestManifest(dir);
    assert.equal(manifest.version_code, 11);
    assert.equal(manifest.rollback_available, true);
    assert.equal(manifest.rollback.release_id, "ai.moa.assistant-10");
    assert.equal(manifest.rollback.version_code, 10);
    assert.equal(manifest.rollback.download_url, "/v1/android/updates/releases/ai.moa.assistant-10.apk");
    assert.equal(manifest.rollback.requires_reinstall, true);
    assert.equal(typeof manifest.rollback.sha256, "string");
    assert.equal(manifest.rollback.sha256.length, 64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("requires_reinstall is false when the rollback target shares the current version_code", () => {
  const dir = tempDir();
  try {
    publish(dir, {
      version_code: 20,
      version_name: "0.2.0",
      published_at: "2026-07-01T00:00:00Z",
      release_id: "ai.moa.assistant-20-a",
    });
    publish(dir, {
      version_code: 20,
      version_name: "0.2.0",
      published_at: "2026-07-02T00:00:00Z",
      release_id: "ai.moa.assistant-20-b",
    });
    const manifest = androidOta.buildLatestManifest(dir);
    assert.equal(manifest.release_id, "ai.moa.assistant-20-b");
    assert.equal(manifest.rollback_available, true);
    assert.equal(manifest.rollback.release_id, "ai.moa.assistant-20-a");
    assert.equal(manifest.rollback.requires_reinstall, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rollbackToPreviousRelease repoints current and refuses with no previous", () => {
  const dir = tempDir();
  try {
    publish(dir, { version_code: 10, version_name: "0.1.10", published_at: "2026-07-01T00:00:00Z" });
    publish(dir, { version_code: 11, version_name: "0.1.11", published_at: "2026-07-02T00:00:00Z" });
    assert.equal(androidOta.currentReleaseId(dir), "ai.moa.assistant-11");

    const rolled = androidOta.rollbackToPreviousRelease(dir);
    assert.equal(rolled.ok, true);
    assert.equal(rolled.from_release_id, "ai.moa.assistant-11");
    assert.equal(rolled.to_release_id, "ai.moa.assistant-10");
    assert.equal(androidOta.currentReleaseId(dir), "ai.moa.assistant-10");
    assert.equal(rolled.manifest.version_code, 10);

    // Now on the oldest release: another rollback must refuse.
    const refused = androidOta.rollbackToPreviousRelease(dir);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "no_previous_release");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveReleaseApkPath rejects path traversal and invalid ids", () => {
  const dir = tempDir();
  try {
    publish(dir, { version_code: 10, version_name: "0.1.10", published_at: "2026-07-01T00:00:00Z" });
    assert.equal(androidOta.resolveReleaseApkPath(dir, "../../etc/passwd"), null);
    assert.equal(androidOta.resolveReleaseApkPath(dir, "..%2f.."), null);
    assert.equal(androidOta.resolveReleaseApkPath(dir, "a/b"), null);
    assert.equal(androidOta.isValidReleaseId("../secret"), false);
    const good = androidOta.resolveReleaseApkPath(dir, "ai.moa.assistant-10");
    assert.equal(path.basename(good), "moa-assistant.apk");
    assert.ok(fs.existsSync(good));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy single moa-assistant.apk migrates into the versioned layout on first read", () => {
  const dir = tempDir();
  try {
    // Simulate the pre-rollback on-disk shape: a bare apk + latest.json, no releases/.
    const apk = makeApk("legacy");
    fs.writeFileSync(path.join(dir, "moa-assistant.apk"), apk);
    fs.writeFileSync(path.join(dir, "latest.json"), `${JSON.stringify({
      app_id: "ai.moa.assistant",
      version_code: 7,
      version_name: "0.1.7",
      apk: "moa-assistant.apk",
      size_bytes: apk.length,
      sha256: crypto.createHash("sha256").update(apk).digest("hex"),
      git_sha: "cafef00d",
      built_at: "2026-06-01T00:00:00Z",
      min_sdk: 26,
    }, null, 2)}\n`);
    assert.equal(fs.existsSync(path.join(dir, "releases")), false);

    const manifest = androidOta.buildLatestManifest(dir);
    assert.equal(manifest.version_code, 7);
    assert.equal(manifest.release_id, "ai.moa.assistant-7");
    assert.equal(manifest.rollback_available, undefined);
    // The migration persisted a release dir + current pointer.
    assert.ok(fs.existsSync(path.join(dir, "releases", "ai.moa.assistant-7", "release.json")));
    assert.equal(androidOta.currentReleaseId(dir), "ai.moa.assistant-7");
    const current = androidOta.readCurrentRelease(dir);
    assert.ok(fs.existsSync(current.apk_path));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HTTP surface (server.js routes)
// ---------------------------------------------------------------------------

let port;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(HTTP_OTA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset the shared HTTP OTA dir to two releases: current=11, rollback=10.
  fs.rmSync(HTTP_OTA_DIR, { recursive: true, force: true });
  fs.mkdirSync(HTTP_OTA_DIR, { recursive: true });
  publish(HTTP_OTA_DIR, { version_code: 10, version_name: "0.1.10", published_at: "2026-07-01T00:00:00Z" });
  publish(HTTP_OTA_DIR, { version_code: 11, version_name: "0.1.11", published_at: "2026-07-02T00:00:00Z" });
});

function request(method, pathname, { token } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: pathname, headers: token ? { authorization: `Bearer ${token}` } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(body.toString("utf8"));
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("GET release APK serves the requested release", async () => {
  const res = await request("GET", "/v1/android/updates/releases/ai.moa.assistant-10.apk", { token: GATEWAY_TOKEN });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/vnd.android.package-archive");
  const onDisk = fs.readFileSync(path.join(HTTP_OTA_DIR, "releases", "ai.moa.assistant-10", "moa-assistant.apk"));
  assert.ok(res.body.equals(onDisk));
});

test("GET release APK rejects path traversal with 400", async () => {
  const res = await request("GET", "/v1/android/updates/releases/..%2F..%2Fsecret.apk", { token: GATEWAY_TOKEN });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /invalid release_id/);
});

test("GET release APK requires auth", async () => {
  const res = await request("GET", "/v1/android/updates/releases/ai.moa.assistant-10.apk");
  assert.equal(res.status, 401);
});

test("POST rollback repoints current to the previous release", async () => {
  const res = await request("POST", "/v1/android/updates/rollback", { token: GATEWAY_TOKEN });
  assert.equal(res.status, 200);
  assert.equal(res.json.rolled_back, true);
  assert.equal(res.json.from_release_id, "ai.moa.assistant-11");
  assert.equal(res.json.to_release_id, "ai.moa.assistant-10");
  assert.equal(res.json.manifest.version_code, 10);
  assert.equal(androidOta.currentReleaseId(HTTP_OTA_DIR), "ai.moa.assistant-10");
});

test("POST rollback refuses with 409 when no previous release exists", async () => {
  // Roll all the way back to the oldest, then attempt one more.
  await request("POST", "/v1/android/updates/rollback", { token: GATEWAY_TOKEN });
  const res = await request("POST", "/v1/android/updates/rollback", { token: GATEWAY_TOKEN });
  assert.equal(res.status, 409);
  assert.equal(res.json.reason, "no_previous_release");
});

test("POST rollback requires auth", async () => {
  const res = await request("POST", "/v1/android/updates/rollback");
  assert.equal(res.status, 401);
  // The active release must be unchanged after an unauthorized attempt.
  assert.equal(androidOta.currentReleaseId(HTTP_OTA_DIR), "ai.moa.assistant-11");
});

test("GET latest manifest includes rollback metadata over HTTP", async () => {
  const res = await request("GET", "/v1/android/updates/latest", { token: GATEWAY_TOKEN });
  assert.equal(res.status, 200);
  assert.equal(res.json.version_code, 11);
  assert.equal(res.json.rollback_available, true);
  assert.equal(res.json.rollback.release_id, "ai.moa.assistant-10");
  assert.equal(res.json.rollback.requires_reinstall, true);
  assert.match(res.json.download_url, /\/v1\/android\/updates\/latest\.apk$/);
});