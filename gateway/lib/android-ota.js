"use strict";

// Versioned Android OTA release store. Serving is rollback-capable: every
// published build lives under releases/<release_id>/ with its own release.json,
// and an atomic `current` symlink names the active release. The manifest served
// to clients reports the current release plus, when an older previously-published
// release exists, a rollback target the client can fall back to.
//
// This module only reads and rearranges artifacts on disk. It never builds an
// APK, contacts a device, or installs anything. Release metadata validation
// reuses gateway/lib/release-registry.js where it fits (semver ordering); the
// registry's full immutable-release schema is heavier than a per-build
// release.json, so this module keeps its own light normalization for the small
// manifest shape the Android client consumes.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { compareSemanticVersions } = require("./release-registry");

const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SEMVER_LIKE = /^\d+\.\d+\.\d+/;

const DEFAULT_APK_NAME = "moa-assistant.apk";
const RELEASES_DIRNAME = "releases";
const CURRENT_LINK_NAME = "current";
const RELEASE_META_NAME = "release.json";
const LEGACY_MANIFEST_NAME = "latest.json";
const DEFAULT_APP_ID = "ai.moa.assistant";
const DEFAULT_MIN_SDK = 26;

function isValidReleaseId(value) {
  return typeof value === "string" && RELEASE_ID_PATTERN.test(value);
}

function releasesDir(otaDir) {
  return path.join(otaDir, RELEASES_DIRNAME);
}

function releaseDir(otaDir, releaseId) {
  if (!isValidReleaseId(releaseId)) return null;
  const base = releasesDir(otaDir);
  const resolvedBase = path.resolve(base);
  const target = path.resolve(base, releaseId);
  // Defense in depth: the pattern already forbids "/" and "..", but confirm the
  // resolved path stays inside releases/ before touching the filesystem.
  if (target !== path.join(resolvedBase, releaseId)) return null;
  if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) return null;
  return target;
}

function deriveReleaseId(appId, versionCode) {
  const base = String(appId || DEFAULT_APP_ID)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  const id = `${base || "app"}-${versionCode}`.slice(0, 128);
  return isValidReleaseId(id) ? id : null;
}

function normalizeMeta(input, { apkBuffer, releaseId } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const appId = String(source.app_id || DEFAULT_APP_ID);
  const versionCode = Number.isFinite(Number(source.version_code)) ? Number(source.version_code) : 0;
  const versionName = String(source.version_name || "0.0.0");

  let size = Number(source.size_bytes);
  if (!Number.isFinite(size) || size < 0) size = apkBuffer ? apkBuffer.length : 0;

  let sha256 = String(source.sha256 || "").toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    sha256 = apkBuffer ? crypto.createHash("sha256").update(apkBuffer).digest("hex") : "";
  }

  const gitSha = String(source.git_sha || "unknown");
  let publishedAt = String(source.published_at || source.built_at || "");
  if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) publishedAt = new Date().toISOString();

  const apk = sanitizeApkName(source.apk);
  const minSdk = Number.isFinite(Number(source.min_sdk)) ? Number(source.min_sdk) : DEFAULT_MIN_SDK;

  const id = releaseId
    || (isValidReleaseId(source.release_id) ? source.release_id : null)
    || deriveReleaseId(appId, versionCode);

  return {
    release_id: id,
    app_id: appId,
    version_code: versionCode,
    version_name: versionName,
    apk,
    size_bytes: size,
    sha256,
    git_sha: gitSha,
    published_at: publishedAt,
    min_sdk: minSdk,
  };
}

function sanitizeApkName(value) {
  const name = String(value || DEFAULT_APK_NAME).replace(/[/\\]/g, "");
  return name && !name.startsWith(".") ? name : DEFAULT_APK_NAME;
}

function readReleaseMeta(otaDir, releaseId) {
  const dir = releaseDir(otaDir, releaseId);
  if (!dir) return null;
  const metaPath = path.join(dir, RELEASE_META_NAME);
  if (!fs.existsSync(metaPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
  const meta = normalizeMeta(parsed, { releaseId });
  return meta.release_id === releaseId ? meta : { ...meta, release_id: releaseId };
}

function listReleases(otaDir) {
  const dir = releasesDir(otaDir);
  if (!fs.existsSync(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const releases = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isValidReleaseId(entry.name)) continue;
    const meta = readReleaseMeta(otaDir, entry.name);
    if (meta) releases.push(meta);
  }
  return releases.sort(compareReleasesAsc);
}

// Ordered by publish time so "previous" means the previously-published release.
// version_code and semver break ties for builds published in the same instant.
function compareReleasesAsc(a, b) {
  const at = Date.parse(a.published_at) || 0;
  const bt = Date.parse(b.published_at) || 0;
  if (at !== bt) return at - bt;
  if (a.version_code !== b.version_code) return a.version_code - b.version_code;
  if (SEMVER_LIKE.test(a.version_name) && SEMVER_LIKE.test(b.version_name)) {
    try {
      const bySemver = compareSemanticVersions(a.version_name, b.version_name);
      if (bySemver !== 0) return bySemver;
    } catch {
      /* fall through to release_id ordering */
    }
  }
  return a.release_id.localeCompare(b.release_id);
}

function currentLinkPath(otaDir) {
  return path.join(otaDir, CURRENT_LINK_NAME);
}

function currentReleaseId(otaDir) {
  const link = currentLinkPath(otaDir);
  let stat;
  try {
    stat = fs.lstatSync(link);
  } catch {
    return null;
  }
  let target = "";
  if (stat.isSymbolicLink()) {
    try {
      target = fs.readlinkSync(link);
    } catch {
      return null;
    }
  } else if (stat.isFile()) {
    // Portability fallback for filesystems without symlink support.
    try {
      target = fs.readFileSync(link, "utf8").trim();
    } catch {
      return null;
    }
  } else {
    return null;
  }
  const id = path.basename(target.trim());
  return isValidReleaseId(id) ? id : null;
}

function pointCurrent(otaDir, releaseId) {
  if (!isValidReleaseId(releaseId)) throw new Error("invalid release_id for current pointer");
  const link = currentLinkPath(otaDir);
  const tmp = path.join(otaDir, `.${CURRENT_LINK_NAME}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const relTarget = path.join(RELEASES_DIRNAME, releaseId);
  fs.mkdirSync(otaDir, { recursive: true });
  try {
    try {
      fs.symlinkSync(relTarget, tmp);
    } catch {
      // Symlinks unavailable: write a pointer file naming the release id.
      fs.writeFileSync(tmp, `${releaseId}\n`);
    }
    fs.renameSync(tmp, link);
  } finally {
    if (fs.existsSync(tmp)) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best effort cleanup */
      }
    }
  }
}

// If the legacy single moa-assistant.apk exists without a versioned releases
// layout, adopt it as the sole release so old publishers keep working. Writes
// releases/<id>/ + release.json and points `current` at it.
function ensureMigrated(otaDir) {
  if (currentReleaseId(otaDir)) return currentReleaseId(otaDir);

  const legacyApk = path.join(otaDir, DEFAULT_APK_NAME);
  if (!fs.existsSync(legacyApk)) {
    // Nothing to migrate; maybe a release dir exists without `current`.
    const existing = listReleases(otaDir);
    if (existing.length) {
      const newest = existing[existing.length - 1];
      pointCurrent(otaDir, newest.release_id);
      return newest.release_id;
    }
    return null;
  }

  let legacyMeta = {};
  const legacyManifest = path.join(otaDir, LEGACY_MANIFEST_NAME);
  if (fs.existsSync(legacyManifest)) {
    try {
      legacyMeta = JSON.parse(fs.readFileSync(legacyManifest, "utf8"));
    } catch {
      legacyMeta = {};
    }
  }
  const apkBuffer = fs.readFileSync(legacyApk);
  const meta = normalizeMeta(legacyMeta, { apkBuffer });
  const releaseId = meta.release_id || deriveReleaseId(meta.app_id, meta.version_code) || "ai.moa.assistant-legacy";
  meta.release_id = releaseId;
  meta.apk = DEFAULT_APK_NAME;

  const dir = releaseDir(otaDir, releaseId);
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(legacyApk, path.join(dir, DEFAULT_APK_NAME));
  writeReleaseMeta(dir, meta);
  pointCurrent(otaDir, releaseId);
  return releaseId;
}

function writeReleaseMeta(dir, meta) {
  const payload = {
    app_id: meta.app_id,
    version_code: meta.version_code,
    version_name: meta.version_name,
    apk: meta.apk,
    size_bytes: meta.size_bytes,
    sha256: meta.sha256,
    git_sha: meta.git_sha,
    published_at: meta.published_at,
    min_sdk: meta.min_sdk,
  };
  const target = path.join(dir, RELEASE_META_NAME);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmp, target);
}

function readCurrentRelease(otaDir) {
  const id = ensureMigrated(otaDir);
  if (!id) return null;
  const meta = readReleaseMeta(otaDir, id);
  if (!meta) return null;
  const apkPath = path.join(releaseDir(otaDir, id), meta.apk);
  return { ...meta, apk_path: apkPath };
}

// The release published immediately before the current one. requires_reinstall
// is decided separately from version_code, so a same-version_code rebuild can be
// a rollback target without forcing a reinstall.
function previousRelease(otaDir, current) {
  const all = listReleases(otaDir);
  const index = all.findIndex((r) => r.release_id === current.release_id);
  if (index <= 0) return null;
  return all[index - 1];
}

function resolveReleaseApkPath(otaDir, releaseId) {
  const dir = releaseDir(otaDir, releaseId);
  if (!dir) return null;
  const meta = readReleaseMeta(otaDir, releaseId);
  const apkName = meta ? meta.apk : DEFAULT_APK_NAME;
  return path.join(dir, apkName);
}

// Build the manifest served at /v1/android/updates/latest. Adds rollback fields
// when an older previously-published release exists. Returns null when no
// release is available.
function buildLatestManifest(otaDir) {
  const current = readCurrentRelease(otaDir);
  if (!current) return null;

  const manifest = {
    app_id: current.app_id,
    version_code: current.version_code,
    version_name: current.version_name,
    apk: current.apk,
    size_bytes: current.size_bytes,
    sha256: current.sha256,
    git_sha: current.git_sha,
    published_at: current.published_at,
    // Legacy key retained so pre-rollback clients keep parsing the manifest.
    built_at: current.published_at,
    min_sdk: current.min_sdk,
    release_id: current.release_id,
  };

  const previous = previousRelease(otaDir, current);
  if (previous) {
    manifest.rollback_available = true;
    manifest.rollback = {
      release_id: previous.release_id,
      version_code: previous.version_code,
      version_name: previous.version_name,
      download_url: `/v1/android/updates/releases/${previous.release_id}.apk`,
      sha256: previous.sha256,
      size_bytes: previous.size_bytes,
      requires_reinstall: previous.version_code < current.version_code,
    };
  }

  return manifest;
}

// Atomically repoint `current` to the previous (older) release. Idempotent in
// the sense that it always targets the deterministic previous release; refuses
// when the current release is already the oldest (no previous exists).
function rollbackToPreviousRelease(otaDir) {
  const current = readCurrentRelease(otaDir);
  if (!current) {
    return { ok: false, reason: "no_current_release" };
  }
  const previous = previousRelease(otaDir, current);
  if (!previous) {
    return { ok: false, reason: "no_previous_release", current_release_id: current.release_id };
  }
  pointCurrent(otaDir, previous.release_id);
  return {
    ok: true,
    from_release_id: current.release_id,
    to_release_id: previous.release_id,
    manifest: buildLatestManifest(otaDir),
  };
}

// Publish a build into the versioned layout: write releases/<id>/apk +
// release.json and point `current` at it. Also refreshes the legacy
// moa-assistant.apk + latest.json so pre-rollback clients still work. `apk` may
// be a Buffer or a source file path.
function publishRelease(otaDir, { apk, meta = {}, updateLegacy = true } = {}) {
  const apkBuffer = Buffer.isBuffer(apk) ? apk : fs.readFileSync(apk);
  const normalized = normalizeMeta(meta, { apkBuffer });
  if (!normalized.release_id) throw new Error("could not derive a valid release_id");
  normalized.apk = DEFAULT_APK_NAME;

  const dir = releaseDir(otaDir, normalized.release_id);
  if (!dir) throw new Error("invalid release_id");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, DEFAULT_APK_NAME), apkBuffer);
  writeReleaseMeta(dir, normalized);
  pointCurrent(otaDir, normalized.release_id);

  if (updateLegacy) {
    fs.mkdirSync(otaDir, { recursive: true });
    fs.writeFileSync(path.join(otaDir, DEFAULT_APK_NAME), apkBuffer);
    const legacyManifest = {
      app_id: normalized.app_id,
      version_code: normalized.version_code,
      version_name: normalized.version_name,
      apk: DEFAULT_APK_NAME,
      size_bytes: normalized.size_bytes,
      sha256: normalized.sha256,
      git_sha: normalized.git_sha,
      built_at: normalized.published_at,
      published_at: normalized.published_at,
      release_id: normalized.release_id,
      min_sdk: normalized.min_sdk,
    };
    fs.writeFileSync(path.join(otaDir, LEGACY_MANIFEST_NAME), `${JSON.stringify(legacyManifest, null, 2)}\n`);
  }

  return { ...normalized, apk_path: path.join(dir, DEFAULT_APK_NAME) };
}

module.exports = {
  RELEASE_ID_PATTERN,
  DEFAULT_APK_NAME,
  isValidReleaseId,
  deriveReleaseId,
  listReleases,
  currentReleaseId,
  ensureMigrated,
  readCurrentRelease,
  previousRelease,
  resolveReleaseApkPath,
  buildLatestManifest,
  rollbackToPreviousRelease,
  publishRelease,
};
