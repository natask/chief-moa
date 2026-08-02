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

test("router exposes only current reads and protects versioned artifacts and mutations", async (t) => {
  let state = harness();
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  assert.equal(await state.handlers.routeAndroidOta(request("GET"), {}, url("/elsewhere")), false);

  state = harness({ authorized: () => false });
  t.after(() => fs.rmSync(state.otaDir, { recursive: true, force: true }));
  const manifestResponse = {};
  assert.equal(
    await state.handlers.routeAndroidOta(request("GET"), manifestResponse, url("/v1/android/updates/latest")),
    true,
  );
  assert.equal(manifestResponse.status, 200);

  const apkResponse = responseStream();
  assert.equal(
    await state.handlers.routeAndroidOta(request("GET"), apkResponse, url("/v1/android/updates/latest.apk")),
    true,
  );
  await finished(apkResponse);
  assert.equal(apkResponse.status, 200);
  assert.equal(apkResponse.body().toString(), "apk-body");

  for (const [method, pathname] of [
    ["GET", "/v1/android/updates/releases/release-1.apk"],
    ["POST", "/v1/android/updates/rollback"],
  ]) {
    const response = {};
    assert.equal(await state.handlers.routeAndroidOta(request(method), response, url(pathname)), true);
    assert.deepEqual(response, { status: 401, payload: { error: "missing or invalid gateway token" } });
  }
});

test("configured app channels expose only current reads without authentication", async (t) => {
  const state = twoChannelHarness({ authorized: () => false });
  t.after(state.cleanup);

  const manifestResponse = {};
  await state.handlers.routeAndroidOta(
    request("GET"), manifestResponse, url(`/v1/android/updates/apps/${OTHER_APP_ID}/latest`),
  );
  assert.equal(manifestResponse.status, 200);
  assert.equal(manifestResponse.payload.release_id, "default-release-12");

  const apkResponse = responseStream();
  await state.handlers.routeAndroidOta(
    request("GET"), apkResponse, url(`/v1/android/updates/apps/${OTHER_APP_ID}/latest.apk`),
  );
  await finished(apkResponse);
  assert.equal(apkResponse.status, 200);
  assert.equal(apkResponse.body().toString(), "default-apk-body");

  for (const [method, pathname] of [
    ["GET", `/v1/android/updates/apps/${OTHER_APP_ID}/releases/companion-release-4.apk`],
    ["POST", `/v1/android/updates/apps/${OTHER_APP_ID}/rollback`],
  ]) {
    const response = {};
    await state.handlers.routeAndroidOta(request(method), response, url(pathname));
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

// The historical channels map carried an app-specific otaDir. It now acts only
// as an alias allowlist: even if an older caller still supplies a populated
// retired store, every app-scoped operation resolves through the canonical
// otaDir and leaves the retired bytes untouched.
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

test("app-scoped routes alias the canonical manifest, APK, and rollback state", async (t) => {
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
  assert.equal(otherResponse.payload.release_id, "default-release-12");
  assert.equal(
    otherResponse.payload.download_url,
    `https://gateway.test/v1/android/updates/apps/${OTHER_APP_ID}/latest.apk`,
  );
  assert.equal(defaultResponse.payload.release_id, otherResponse.payload.release_id);

  // The alias mutates the canonical head and never touches the retired store.
  const rollbackResponse = {};
  await state.handlers.routeAndroidOta(
    request("POST"), rollbackResponse, url(`/v1/android/updates/apps/${OTHER_APP_ID}/rollback`),
  );
  assert.equal(rollbackResponse.status, 200);
  assert.equal(state.rolledBack[state.otaDir], true);
  assert.equal(state.rolledBack[state.otherDir], false);
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
  assert.equal(otherApkResponse.body().toString(), "default-apk-body");
});

test("health reports configured aliases from the canonical release snapshot", (t) => {
  const state = twoChannelHarness();
  t.after(state.cleanup);
  const health = state.handlers.health();
  assert.equal(health.release_id, "default-release-12");
  assert.equal(health.channels[OTHER_APP_ID].release_id, "default-release-12");
  assert.equal(health.channels[OTHER_APP_ID].dir, state.otaDir);
  assert.equal(health.channels[OTHER_APP_ID].endpoint, `/v1/android/updates/apps/${OTHER_APP_ID}/latest`);
});
