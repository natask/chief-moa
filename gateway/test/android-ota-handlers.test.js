"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");
const { finished } = require("node:stream/promises");
const { createAndroidOtaHandlers } = require("../lib/android-ota-handlers");

function responseStream() {
  const chunks = [];
  const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  response.writeHead = (status, headers) => Object.assign(response, { status, headers });
  response.body = () => Buffer.concat(chunks);
  return response;
}

function harness(overrides = {}) {
  const calls = { events: [], warnings: [] };
  const otaDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-ota-handlers-"));
  const apkPath = path.join(otaDir, "app.apk");
  fs.writeFileSync(apkPath, "apk-body");
  const manifest = {
    version_code: 12,
    version_name: "0.1.12",
    release_id: "release-12",
    built_at: "2026-07-15T00:00:00Z",
    git_sha: "abc123",
    rollback_available: true,
    rollback: { release_id: "release-11", download_url: "/v1/android/updates/releases/release-11.apk" },
  };
  const androidOta = {
    buildLatestManifest: () => manifest,
    readCurrentRelease: () => ({ apk_path: apkPath }),
    isValidReleaseId: (id) => id.startsWith("release-"),
    resolveReleaseApkPath: () => apkPath,
    rollbackToPreviousRelease: () => ({
      ok: true,
      from_release_id: "release-12",
      to_release_id: "release-11",
      manifest,
    }),
    ...overrides.androidOta,
  };
  const deps = {
    androidOta,
    otaDir,
    authorized: () => true,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    cleanError: (error) => error.message,
    externalOriginForRequest: () => "https://gateway.test",
    recordProductEventBestEffort: (event) => calls.events.push(event),
    warn: (message) => calls.warnings.push(message),
    ...overrides,
    androidOta,
  };
  return { handlers: createAndroidOtaHandlers(deps), calls, otaDir, apkPath, manifest };
}

const request = (method) => ({ method });
const url = (pathname) => new URL(`https://gateway.test${pathname}`);

test("router ignores unrelated requests and protects every OTA route", async (t) => {
  let state = harness();
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  assert.equal(await state.handlers.routeAndroidOta(request("GET"), {}, url("/elsewhere")), false);

  state = harness({ authorized: () => false });
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  for (const [method, pathname] of [
    ["GET", "/v1/android/updates/latest"],
    ["GET", "/v1/android/updates/latest.apk"],
    ["GET", "/v1/android/updates/releases/release-1.apk"],
    ["POST", "/v1/android/updates/rollback"],
  ]) {
    const response = {};
    assert.equal(await state.handlers.routeAndroidOta(request(method), response, url(pathname)), true);
    assert.deepEqual(response, { status: 401, payload: { error: "missing or invalid gateway token" } });
  }
});

test("manifest serving absolutizes current and rollback downloads", async (t) => {
  const state = harness();
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  const response = {};
  assert.equal(await state.handlers.routeAndroidOta(request("GET"), response, url("/v1/android/updates/latest")), true);
  assert.equal(response.status, 200);
  assert.equal(response.payload.download_url, "https://gateway.test/v1/android/updates/latest.apk");
  assert.equal(response.payload.rollback.download_url, "https://gateway.test/v1/android/updates/releases/release-11.apk");
  assert.notEqual(response.payload, state.manifest);
  assert.deepEqual(state.handlers.absolutizeManifest({ version_code: 1 }, "http://local"), {
    version_code: 1,
    download_url: "http://local/v1/android/updates/latest.apk",
  });
  assert.deepEqual(state.handlers.absolutizeManifest({ rollback: null }, "http://local").rollback, null);
});

test("missing and unreadable manifests fail closed and emit bounded warnings", (t) => {
  let state = harness({ androidOta: { buildLatestManifest: () => null } });
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  let response = {};
  state.handlers.sendManifest(request("GET"), response);
  assert.deepEqual(response, { status: 404, payload: { error: "android update artifact not found", ota_dir: state.otaDir } });
  assert.equal(state.handlers.health().configured, false);

  state = harness({ androidOta: { buildLatestManifest: () => { throw new Error("bad manifest"); } } });
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  assert.equal(state.handlers.readManifest(), null);
  assert.deepEqual(state.calls.warnings, ["android OTA manifest read failed: bad manifest"]);
});

test("current and versioned APK routes stream artifacts and reject bad targets", async (t) => {
  let state = harness();
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  let response = responseStream();
  await state.handlers.routeAndroidOta(request("GET"), response, url("/v1/android/updates/latest.apk"));
  await finished(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/vnd.android.package-archive");
  assert.equal(response.headers["content-length"], 8);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body().toString(), "apk-body");

  response = responseStream();
  await state.handlers.routeAndroidOta(request("GET"), response, url("/v1/android/updates/releases/release%2D11.apk"));
  await finished(response);
  assert.equal(response.body().toString(), "apk-body");

  response = {};
  state.handlers.sendReleaseApk(response, "invalid");
  assert.deepEqual(response, { status: 400, payload: { error: "invalid release_id" } });

  state = harness({ androidOta: { resolveReleaseApkPath: () => null } });
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  response = {};
  state.handlers.sendReleaseApk(response, "release-1");
  assert.deepEqual(response, { status: 400, payload: { error: "invalid release_id" } });
  response = {};
  state.handlers.streamApk(response, path.join(state.otaDir, "missing.apk"));
  assert.deepEqual(response, { status: 404, payload: { error: "android APK not found" } });
  response = {};
  state.handlers.streamApk(response, null);
  assert.equal(response.status, 404);
});

test("current APK resolution errors and absent releases return 404", (t) => {
  let state = harness({ androidOta: { readCurrentRelease: () => null } });
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  let response = {};
  state.handlers.sendCurrentApk(response);
  assert.equal(response.status, 404);

  state = harness({ androidOta: { readCurrentRelease: () => { throw new Error("pointer corrupt"); } } });
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  response = {};
  state.handlers.sendCurrentApk(response);
  assert.equal(response.status, 404);
  assert.deepEqual(state.calls.warnings, ["android OTA apk resolve failed: pointer corrupt"]);
});

test("rollback maps failures and records a successful product event", async (t) => {
  for (const [result, status, current] of [
    [{ ok: false, reason: "no_current_release" }, 404, null],
    [{ ok: false, reason: "no_previous_release", current_release_id: "release-12" }, 409, "release-12"],
  ]) {
    const state = harness({ androidOta: { rollbackToPreviousRelease: () => result } });
    t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
    const response = {};
    await state.handlers.handleRollback(request("POST"), response);
    assert.equal(response.status, status);
    assert.equal(response.payload.current_release_id, current);
  }

  let state = harness({ androidOta: { rollbackToPreviousRelease: () => { throw new Error("disk locked"); } } });
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  let response = {};
  await state.handlers.handleRollback(request("POST"), response);
  assert.deepEqual(response, { status: 500, payload: { error: "disk locked" } });

  const busy = Object.assign(new Error("foreign lock detail"), { code: "OTA_STORE_BUSY" });
  state = harness({ androidOta: { rollbackToPreviousRelease: () => { throw busy; } } });
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  response = {};
  await state.handlers.handleRollback(request("POST"), response);
  assert.deepEqual(response, {
    status: 409,
    payload: { error: "android OTA store busy", reason: "publication_in_progress" },
  });

  state = harness();
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  response = {};
  await state.handlers.routeAndroidOta(request("POST"), response, url("/v1/android/updates/rollback"));
  assert.equal(response.status, 200);
  assert.equal(response.payload.manifest.download_url, "https://gateway.test/v1/android/updates/latest.apk");
  assert.deepEqual(state.calls.events[0], {
    stream_id: "android-ota",
    event_type: "android_ota.rollback",
    actor: { kind: "gateway", id: "admin" },
    payload: { from_release_id: "release-12", to_release_id: "release-11" },
  });
});

test("health reports release identity and normalizes rollback availability", (t) => {
  const state = harness({ androidOta: { buildLatestManifest: () => ({
    version_code: 3, version_name: "0.1.3", release_id: "r3", built_at: "now", git_sha: "sha",
  }) } });
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  assert.deepEqual(state.handlers.health(), {
    configured: true,
    dir: state.otaDir,
    endpoint: "/v1/android/updates/latest",
    version_code: 3,
    version_name: "0.1.3",
    release_id: "r3",
    built_at: "now",
    git_sha: "sha",
    rollback_available: false,
  });
});
