"use strict";

const fs = require("node:fs");

// Stable Android delivery has one canonical store. The app-scoped route family
// exists only for compatibility with clients shipped during the package rename.
// `channels` remains a map for caller compatibility, but its values must never
// select another store: configured keys are only an allowlist of route aliases.
const DEFAULT_APP_ID = "ai.moa.assistant";

function createAndroidOtaHandlers(deps) {
  const {
    androidOta, otaDir, authorized, sendJson, cleanError, externalOriginForRequest,
    recordProductEventBestEffort, channels = {},
  } = deps;
  const warn = typeof deps.warn === "function" ? deps.warn : console.warn;

  const defaultChannel = { appId: DEFAULT_APP_ID, otaDir, base: "/v1/android/updates" };

  // Keep accepting the historical { app_id: otaDir } shape while deliberately
  // ignoring its values. This lets a candidate roll over an older deployment
  // configuration without reading, migrating, or mutating its retired stores.
  function resolveChannel(appId) {
    if (appId === DEFAULT_APP_ID) return defaultChannel;
    if (!Object.prototype.hasOwnProperty.call(channels, appId)) return null;
    return { appId, otaDir, base: `/v1/android/updates/apps/${encodeURIComponent(appId)}` };
  }

  async function routeAndroidOta(request, response, url) {
    const path = url.pathname;
    const manifest = request.method === "GET" && path === "/v1/android/updates/latest";
    const currentApk = request.method === "GET" && path === "/v1/android/updates/latest.apk";
    const releaseMatch = request.method === "GET" && path.match(/^\/v1\/android\/updates\/releases\/([^/]+)\.apk$/);
    const rollback = request.method === "POST" && path === "/v1/android/updates/rollback";
    const appManifest = request.method === "GET" && path.match(/^\/v1\/android\/updates\/apps\/([^/]+)\/latest$/);
    const appApk = request.method === "GET" && path.match(/^\/v1\/android\/updates\/apps\/([^/]+)\/latest\.apk$/);
    const appReleaseMatch = request.method === "GET"
      && path.match(/^\/v1\/android\/updates\/apps\/([^/]+)\/releases\/([^/]+)\.apk$/);
    const appRollback = request.method === "POST" && path.match(/^\/v1\/android\/updates\/apps\/([^/]+)\/rollback$/);
    if (!(manifest || currentApk || releaseMatch || rollback
      || appManifest || appApk || appReleaseMatch || appRollback)) return false;
    // Temporary pre-device-auth bootstrap: an installed Android app must be
    // able to discover and download the current signed update without carrying
    // the shared gateway bearer token. Keep the public surface exact: only the
    // current manifest and its current APK, on the canonical route or a
    // configured compatibility alias. Version-pinned artifacts and every
    // mutation remain protected.
    const publicCurrentRead = Boolean(manifest || currentApk || appManifest || appApk);
    if (!publicCurrentRead && !authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" }); return true;
    }

    const scopedMatch = appManifest || appApk || appReleaseMatch || appRollback;
    const channel = scopedMatch ? resolveChannel(decodeURIComponent(scopedMatch[1])) : defaultChannel;
    if (!channel) { sendJson(response, 404, { error: "unknown android application id" }); return true; }

    if (manifest || appManifest) sendManifest(request, response, channel);
    else if (currentApk || appApk) sendCurrentApk(response, channel);
    else if (releaseMatch) sendReleaseApk(response, decodeURIComponent(releaseMatch[1]), channel);
    else if (appReleaseMatch) sendReleaseApk(response, decodeURIComponent(appReleaseMatch[2]), channel);
    else await handleRollback(request, response, channel);
    return true;
  }

  // Every handler below defaults its `channel` argument to the canonical route,
  // preserving the existing direct-call contract.
  function readManifest(channel = defaultChannel) {
    try { return androidOta.buildLatestManifest(channel.otaDir); }
    catch (error) {
      const suffix = channel.appId === DEFAULT_APP_ID ? "" : ` (${channel.appId})`;
      warn(`android OTA manifest read failed${suffix}: ${cleanError(error)}`);
      return null;
    }
  }

  function absolutizeManifest(manifest, origin, channel = defaultChannel) {
    const served = { ...manifest, download_url: `${origin}${channel.base}/latest.apk` };
    if (manifest.rollback && typeof manifest.rollback === "object") {
      served.rollback = {
        ...manifest.rollback,
        download_url: `${origin}${channel.base}${releaseSuffix(manifest.rollback.download_url)}`,
      };
    }
    return served;
  }

  // Rebase the canonical store's rollback link onto the requested route family
  // so an app-scoped client keeps using its compatibility alias.
  function releaseSuffix(downloadUrl) {
    const match = String(downloadUrl || "").match(/\/releases\/[^/]+\.apk$/);
    return match ? match[0] : downloadUrl;
  }

  function sendManifest(request, response, channel = defaultChannel) {
    const manifest = readManifest(channel);
    if (!manifest) {
      sendJson(response, 404, { error: "android update artifact not found", ota_dir: channel.otaDir });
      return;
    }
    sendJson(response, 200, absolutizeManifest(manifest, externalOriginForRequest(request), channel));
  }

  function sendCurrentApk(response, channel = defaultChannel) {
    let current;
    try { current = androidOta.readCurrentRelease(channel.otaDir); }
    catch (error) {
      const suffix = channel.appId === DEFAULT_APP_ID ? "" : ` (${channel.appId})`;
      warn(`android OTA apk resolve failed${suffix}: ${cleanError(error)}`);
      current = null;
    }
    if (!current) { sendJson(response, 404, { error: "android update artifact not found" }); return; }
    streamApk(response, current.apk_path);
  }

  function sendReleaseApk(response, releaseId, channel = defaultChannel) {
    if (!androidOta.isValidReleaseId(releaseId)) { sendJson(response, 400, { error: "invalid release_id" }); return; }
    const apkPath = androidOta.resolveReleaseApkPath(channel.otaDir, releaseId);
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

  async function handleRollback(request, response, channel = defaultChannel) {
    let result;
    try { result = androidOta.rollbackToPreviousRelease(channel.otaDir); }
    catch (error) {
      if (error && error.code === "OTA_STORE_BUSY") {
        sendJson(response, 409, { error: "android OTA store busy", reason: "publication_in_progress" });
      } else {
        sendJson(response, 500, { error: cleanError(error) });
      }
      return;
    }
    if (!result.ok) {
      sendJson(response, result.reason === "no_current_release" ? 404 : 409, {
        error: "rollback unavailable", reason: result.reason, current_release_id: result.current_release_id || null,
      });
      return;
    }
    const payload = { from_release_id: result.from_release_id, to_release_id: result.to_release_id };
    if (channel.appId !== DEFAULT_APP_ID) payload.app_id = channel.appId;
    recordProductEventBestEffort({
      stream_id: "android-ota", event_type: "android_ota.rollback", actor: { kind: "gateway", id: "admin" }, payload,
    });
    sendJson(response, 200, {
      rolled_back: true, from_release_id: result.from_release_id, to_release_id: result.to_release_id,
      manifest: absolutizeManifest(result.manifest, externalOriginForRequest(request), channel),
    });
  }

  function health() {
    const manifest = readManifest(defaultChannel);
    const channelIds = Object.keys(channels);
    const result = manifest
      ? {
        configured: true, dir: otaDir, endpoint: "/v1/android/updates/latest",
        version_code: manifest.version_code, version_name: manifest.version_name, release_id: manifest.release_id,
        built_at: manifest.built_at, git_sha: manifest.git_sha, rollback_available: Boolean(manifest.rollback_available),
      }
      : { configured: false, dir: otaDir, endpoint: "/v1/android/updates/latest" };
    // Only attach a `channels` key when an alias is configured, preserving the
    // original health shape for callers without aliases.
    if (channelIds.length === 0) return result;
    const channelHealth = {};
    for (const appId of channelIds) {
      const channel = resolveChannel(appId);
      channelHealth[appId] = manifest
        ? {
          configured: true, dir: channel.otaDir, endpoint: `${channel.base}/latest`,
          version_code: manifest.version_code, version_name: manifest.version_name,
          release_id: manifest.release_id, built_at: manifest.built_at,
          git_sha: manifest.git_sha, rollback_available: Boolean(manifest.rollback_available),
        }
        : { configured: false, dir: channel.otaDir, endpoint: `${channel.base}/latest` };
    }
    return { ...result, channels: channelHealth };
  }

  return { routeAndroidOta, readManifest, absolutizeManifest, sendManifest, sendCurrentApk, sendReleaseApk, streamApk, handleRollback, health };
}

module.exports = { createAndroidOtaHandlers, DEFAULT_APP_ID };
