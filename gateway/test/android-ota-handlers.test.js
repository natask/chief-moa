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

  state = harness({ androidOta: { rollbackToPreviousRelease: () => {
    const error = new Error("publication locked");
    error.code = "OTA_STORE_BUSY";
    throw error;
  } } });
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

// A second application id (ag.companion, the renamed app's own clean install)
// gets its own release chain -- a distinct otaDir, its own `/apps/<id>/...`
// routes, and its own current/manifest -- that never shares state with the
// default ai.moa.assistant channel above. These tests use two independent
// otaDir directories and an androidOta stub that only answers for the dir it
// was actually called with, so a bug that accidentally shared state (e.g. a
// missed channel.otaDir threading) would surface as a wrong-manifest failure.
const OTHER_APP_ID = "ag.companion";

function twoChannelHarness(overrides = {}) {
  const calls = { events: [], warnings: [] };
  const otaDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-ota-default-"));
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-ota-other-"));
  const defaultApkPath = path.join(otaDir, "app.apk");
  const otherApkPath = path.join(otherDir, "app.apk");
  fs.writeFileSync(defaultApkPath, "default-apk-body");
  fs.writeFileSync(otherApkPath, "other-apk-body");

  const manifests = {
    [otaDir]: {
      version_code: 12, version_name: "0.1.12", release_id: "default-release-12",
      built_at: "2026-07-15T00:00:00Z", git_sha: "abc123", rollback_available: false,
    },
    [otherDir]: {
      version_code: 5, version_name: "0.1.5", release_id: "companion-release-5",
      built_at: "2026-07-20T00:00:00Z", git_sha: "def456", rollback_available: false,
    },
  };
  const apkPaths = { [otaDir]: defaultApkPath, [otherDir]: otherApkPath };
  let rolledBack = { [otaDir]: false, [otherDir]: false };

  const androidOta = {
    buildLatestManifest: (dir) => manifests[dir] || null,
    readCurrentRelease: (dir) => (apkPaths[dir] ? { apk_path: apkPaths[dir] } : null),
    isValidReleaseId: (id) => typeof id === "string" && id.length > 0,
    resolveReleaseApkPath: (dir) => apkPaths[dir] || null,
    rollbackToPreviousRelease: (dir) => {
      rolledBack[dir] = true;
      return { ok: true, from_release_id: "x", to_release_id: "y", manifest: manifests[dir] };
    },
    ...overrides.androidOta,
  };
  const deps = {
    androidOta,
    otaDir,
    channels: { [OTHER_APP_ID]: otherDir },
    authorized: () => true,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    cleanError: (error) => error.message,
    externalOriginForRequest: () => "https://gateway.test",
    recordProductEventBestEffort: (event) => calls.events.push(event),
    warn: (message) => calls.warnings.push(message),
    ...overrides,
    androidOta,
  };
  return {
    handlers: createAndroidOtaHandlers(deps), calls, otaDir, otherDir, manifests, rolledBack,
    cleanup: () => {
      fs.rmSync(otaDir, { recursive: true, force: true });
      fs.rmSync(otherDir, { recursive: true, force: true });
    },
  };
}

test("an unrecognized application id is rejected rather than falling back to a default store", async (t) => {
  const state = twoChannelHarness();
  t.after(state.cleanup);
  const response = {};
  const ok = await state.handlers.routeAndroidOta(
    request("GET"), response, url("/v1/android/updates/apps/not.a.configured.app/latest"),
  );
  assert.equal(ok, true);
  assert.deepEqual(response, { status: 404, payload: { error: "unknown android application id" } });
});

test("two channels resolve independently and never leak each other's manifest, APK, or rollback state", async (t) => {
  const state = twoChannelHarness();
  t.after(state.cleanup);

  const defaultResponse = {};
  await state.handlers.routeAndroidOta(request("GET"), defaultResponse, url("/v1/android/updates/latest"));
  assert.equal(defaultResponse.status, 200);
  assert.equal(defaultResponse.payload.release_id, "default-release-12");
  assert.equal(defaultResponse.payload.download_url, "https://gateway.test/v1/android/updates/latest.apk");

  const otherResponse = {};
  await state.handlers.routeAndroidOta(
    request("GET"), otherResponse, url(`/v1/android/updates/apps/${OTHER_APP_ID}/latest`),
  );
  assert.equal(otherResponse.status, 200);
  assert.equal(otherResponse.payload.release_id, "companion-release-5");
  assert.equal(
    otherResponse.payload.download_url,
    `https://gateway.test/v1/android/updates/apps/${OTHER_APP_ID}/latest.apk`,
  );
  assert.notEqual(defaultResponse.payload.release_id, otherResponse.payload.release_id);

  // Publishing/rolling back one channel must not touch the other's state.
  const rollbackResponse = {};
  await state.handlers.routeAndroidOta(
    request("POST"), rollbackResponse, url(`/v1/android/updates/apps/${OTHER_APP_ID}/rollback`),
  );
  assert.equal(rollbackResponse.status, 200);
  assert.equal(state.rolledBack[state.otherDir], true);
  assert.equal(state.rolledBack[state.otaDir], false);
  assert.deepEqual(state.calls.events[0].payload, { from_release_id: "x", to_release_id: "y", app_id: OTHER_APP_ID });

  const apkResponse = responseStream();
  await state.handlers.routeAndroidOta(request("GET"), apkResponse, url("/v1/android/updates/latest.apk"));
  await finished(apkResponse);
  assert.equal(apkResponse.body().toString(), "default-apk-body");

  const otherApkResponse = responseStream();
  await state.handlers.routeAndroidOta(
    request("GET"), otherApkResponse, url(`/v1/android/updates/apps/${OTHER_APP_ID}/latest.apk`),
  );
  await finished(otherApkResponse);
  assert.equal(otherApkResponse.body().toString(), "other-apk-body");
});

test("health reports each configured channel independently alongside the default", (t) => {
  const state = twoChannelHarness();
  t.after(state.cleanup);
  const health = state.handlers.health();
  assert.equal(health.release_id, "default-release-12");
  assert.equal(health.channels[OTHER_APP_ID].release_id, "companion-release-5");
  assert.equal(health.channels[OTHER_APP_ID].dir, state.otherDir);
  assert.equal(health.channels[OTHER_APP_ID].endpoint, `/v1/android/updates/apps/${OTHER_APP_ID}/latest`);
});
