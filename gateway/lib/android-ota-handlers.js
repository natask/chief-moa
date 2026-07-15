"use strict";

const fs = require("node:fs");

function createAndroidOtaHandlers(deps) {
  const { androidOta, otaDir, authorized, sendJson, cleanError, externalOriginForRequest, recordProductEventBestEffort } = deps;
  const warn = typeof deps.warn === "function" ? deps.warn : console.warn;

  async function routeAndroidOta(request, response, url) {
    const path = url.pathname;
    const manifest = request.method === "GET" && path === "/v1/android/updates/latest";
    const currentApk = request.method === "GET" && path === "/v1/android/updates/latest.apk";
    const releaseMatch = request.method === "GET" && path.match(/^\/v1\/android\/updates\/releases\/([^/]+)\.apk$/);
    const rollback = request.method === "POST" && path === "/v1/android/updates/rollback";
    if (!(manifest || currentApk || releaseMatch || rollback)) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" }); return true;
    }
    if (manifest) sendManifest(request, response);
    else if (currentApk) sendCurrentApk(response);
    else if (releaseMatch) sendReleaseApk(response, decodeURIComponent(releaseMatch[1]));
    else await handleRollback(request, response);
    return true;
  }

  function readManifest() {
    try { return androidOta.buildLatestManifest(otaDir); }
    catch (error) { warn(`android OTA manifest read failed: ${cleanError(error)}`); return null; }
  }

  function absolutizeManifest(manifest, origin) {
    const served = { ...manifest, download_url: `${origin}/v1/android/updates/latest.apk` };
    if (manifest.rollback && typeof manifest.rollback === "object") {
      served.rollback = { ...manifest.rollback, download_url: `${origin}${manifest.rollback.download_url}` };
    }
    return served;
  }

  function sendManifest(request, response) {
    const manifest = readManifest();
    if (!manifest) { sendJson(response, 404, { error: "android update artifact not found", ota_dir: otaDir }); return; }
    sendJson(response, 200, absolutizeManifest(manifest, externalOriginForRequest(request)));
  }

  function sendCurrentApk(response) {
    let current;
    try { current = androidOta.readCurrentRelease(otaDir); }
    catch (error) { warn(`android OTA apk resolve failed: ${cleanError(error)}`); current = null; }
    if (!current) { sendJson(response, 404, { error: "android update artifact not found" }); return; }
    streamApk(response, current.apk_path);
  }

  function sendReleaseApk(response, releaseId) {
    if (!androidOta.isValidReleaseId(releaseId)) { sendJson(response, 400, { error: "invalid release_id" }); return; }
    const apkPath = androidOta.resolveReleaseApkPath(otaDir, releaseId);
    if (!apkPath) { sendJson(response, 400, { error: "invalid release_id" }); return; }
    streamApk(response, apkPath);
  }

  function streamApk(response, apkPath) {
    if (!apkPath || !fs.existsSync(apkPath)) { sendJson(response, 404, { error: "android APK not found" }); return; }
    const stat = fs.statSync(apkPath);
    response.writeHead(200, {
      "content-type": "application/vnd.android.package-archive", "content-length": stat.size, "cache-control": "no-store",
    });
    fs.createReadStream(apkPath).pipe(response);
  }

  async function handleRollback(request, response) {
    let result;
    try { result = androidOta.rollbackToPreviousRelease(otaDir); }
    catch (error) { sendJson(response, 500, { error: cleanError(error) }); return; }
    if (!result.ok) {
      sendJson(response, result.reason === "no_current_release" ? 404 : 409, {
        error: "rollback unavailable", reason: result.reason, current_release_id: result.current_release_id || null,
      });
      return;
    }
    recordProductEventBestEffort({
      stream_id: "android-ota", event_type: "android_ota.rollback", actor: { kind: "gateway", id: "admin" },
      payload: { from_release_id: result.from_release_id, to_release_id: result.to_release_id },
    });
    sendJson(response, 200, {
      rolled_back: true, from_release_id: result.from_release_id, to_release_id: result.to_release_id,
      manifest: absolutizeManifest(result.manifest, externalOriginForRequest(request)),
    });
  }

  function health() {
    const manifest = readManifest();
    if (!manifest) return { configured: false, dir: otaDir, endpoint: "/v1/android/updates/latest" };
    return {
      configured: true, dir: otaDir, endpoint: "/v1/android/updates/latest",
      version_code: manifest.version_code, version_name: manifest.version_name, release_id: manifest.release_id,
      built_at: manifest.built_at, git_sha: manifest.git_sha, rollback_available: Boolean(manifest.rollback_available),
    };
  }

  return { routeAndroidOta, readManifest, absolutizeManifest, sendManifest, sendCurrentApk, sendReleaseApk, streamApk, handleRollback, health };
}

module.exports = { createAndroidOtaHandlers };
