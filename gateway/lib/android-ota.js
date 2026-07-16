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
const STORE_LOCK_DIRNAME = ".publish-lock";
const STORE_LOCK_OWNER_NAME = "owner";
const STORE_BUSY_ERROR_CODE = "OTA_STORE_BUSY";
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

function storeBusyError() {
  const error = new Error("android OTA store is busy");
  error.code = STORE_BUSY_ERROR_CODE;
  return error;
}

function acquireStoreLock(otaDir, purpose) {
  fs.mkdirSync(otaDir, { recursive: true });
  const lockPath = path.join(otaDir, STORE_LOCK_DIRNAME);
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error && error.code === "EEXIST") throw storeBusyError();
    throw error;
  }

  const boundedPurpose = String(purpose || "write")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(0, 32) || "write";
  const owner = `gateway-${boundedPurpose}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(path.join(lockPath, STORE_LOCK_OWNER_NAME), `${owner}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    fs.rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
  return { lockPath, owner };
}

function releaseStoreLock(lease) {
  const ownerPath = path.join(lease.lockPath, STORE_LOCK_OWNER_NAME);
  let observedOwner;
  try {
    observedOwner = fs.readFileSync(ownerPath, "utf8").trim();
  } catch {
    throw new Error("android OTA store lock ownership could not be verified");
  }
  if (observedOwner !== lease.owner) {
    throw new Error("android OTA store lock ownership changed");
  }
  fs.rmSync(lease.lockPath, { recursive: true });
}

function withStoreLock(otaDir, purpose, operation) {
  const lease = acquireStoreLock(otaDir, purpose);
  let release = true;
  try {
    return operation();
  } catch (error) {
    if (error && error.retainStoreLock === true) release = false;
    throw error;
  } finally {
    if (release) releaseStoreLock(lease);
  }
}

function fileSnapshot(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("android OTA canonical artifact is not a regular file");
  }
  return { kind: "file", bytes: fs.readFileSync(file), mode: stat.mode & 0o777 };
}

function pointerSnapshot(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (stat.isSymbolicLink()) return { kind: "symlink", target: fs.readlinkSync(file) };
  if (stat.isFile()) {
    return { kind: "file", bytes: fs.readFileSync(file), mode: stat.mode & 0o777 };
  }
  throw new Error("android OTA current pointer has an unsupported type");
}

function canonicalSnapshot(otaDir) {
  return {
    current: pointerSnapshot(currentLinkPath(otaDir)),
    legacyApk: fileSnapshot(path.join(otaDir, DEFAULT_APK_NAME)),
    latest: fileSnapshot(path.join(otaDir, LEGACY_MANIFEST_NAME)),
  };
}

function tempPath(otaDir, operationId, label) {
  return path.join(otaDir, `.gateway-ota-${operationId}-${label}.tmp`);
}

function writeTempFile(context, label, bytes, mode = 0o600) {
  const target = tempPath(context.otaDir, context.operationId, label);
  context.tempPaths.push(target);
  fs.writeFileSync(target, bytes, { flag: "wx", mode });
  return target;
}

function restoreFileSnapshot(context, target, snapshot, label) {
  if (snapshot.kind === "absent") {
    fs.rmSync(target, { force: true });
    return;
  }
  const tmp = writeTempFile(context, `restore-${label}`, snapshot.bytes, snapshot.mode);
  fs.renameSync(tmp, target);
  fs.chmodSync(target, snapshot.mode);
}

function restorePointerSnapshot(context, target, snapshot) {
  if (snapshot.kind === "absent") {
    fs.rmSync(target, { force: true });
    return;
  }
  const tmp = tempPath(context.otaDir, context.operationId, "restore-current");
  context.tempPaths.push(tmp);
  if (snapshot.kind === "symlink") fs.symlinkSync(snapshot.target, tmp);
  else fs.writeFileSync(tmp, snapshot.bytes, { flag: "wx", mode: snapshot.mode });
  fs.renameSync(tmp, target);
  if (snapshot.kind === "file") fs.chmodSync(target, snapshot.mode);
}

function snapshotsEqual(actual, expected) {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === "absent") return true;
  if (actual.kind === "symlink") return actual.target === expected.target;
  return actual.mode === expected.mode && actual.bytes.equals(expected.bytes);
}

function verifyCanonicalSnapshot(context) {
  const actual = canonicalSnapshot(context.otaDir);
  if (!snapshotsEqual(actual.current, context.snapshot.current)
    || !snapshotsEqual(actual.legacyApk, context.snapshot.legacyApk)
    || !snapshotsEqual(actual.latest, context.snapshot.latest)) {
    throw new Error("android OTA canonical state restoration mismatch");
  }
}

function cleanupTransactionTemps(context) {
  for (const target of context.tempPaths) {
    fs.rmSync(target, { recursive: true, force: true });
    if (fs.existsSync(target)) throw new Error("android OTA transaction temporary cleanup failed");
  }
}

function restoreTransaction(context) {
  if (context.canonicalMutated) {
    restoreFileSnapshot(
      context,
      path.join(context.otaDir, DEFAULT_APK_NAME),
      context.snapshot.legacyApk,
      "legacy-apk",
    );
    restoreFileSnapshot(
      context,
      path.join(context.otaDir, LEGACY_MANIFEST_NAME),
      context.snapshot.latest,
      "latest",
    );
    restorePointerSnapshot(context, currentLinkPath(context.otaDir), context.snapshot.current);
  }
  if (context.createdReleaseDir) {
    fs.rmSync(context.createdReleaseDir, { recursive: true, force: true });
    if (fs.existsSync(context.createdReleaseDir)) {
      throw new Error("android OTA created release cleanup failed");
    }
  }
  cleanupTransactionTemps(context);
  verifyCanonicalSnapshot(context);
}

function restorationFailure(original, restoreError) {
  const error = new Error("android OTA mutation failed and exact restoration could not be verified");
  error.code = "OTA_STORE_RESTORE_FAILED";
  error.retainStoreLock = true;
  error.cause = restoreError;
  error.originalError = original;
  return error;
}

function runCanonicalTransaction(otaDir, purpose, operation) {
  const context = {
    otaDir,
    operationId: `${purpose}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
    snapshot: canonicalSnapshot(otaDir),
    tempPaths: [],
    canonicalMutated: false,
    createdReleaseDir: null,
  };
  try {
    const result = operation(context);
    cleanupTransactionTemps(context);
    return result;
  } catch (error) {
    try {
      restoreTransaction(context);
    } catch (restoreError) {
      throw restorationFailure(error, restoreError);
    }
    throw error;
  }
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
function ensureMigratedUnlocked(otaDir) {
  const current = currentReleaseId(otaDir);
  if (current) return current;

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

function ensureMigrated(otaDir) {
  const current = currentReleaseId(otaDir);
  if (current) return current;
  return withStoreLock(otaDir, "migrate", () => ensureMigratedUnlocked(otaDir));
}

function writeReleaseMeta(dir, meta) {
  const payload = releaseMetaPayload(meta);
  const target = path.join(dir, RELEASE_META_NAME);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, serializeJson(payload));
  fs.renameSync(tmp, target);
}

function releaseMetaPayload(meta) {
  return {
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
}

function legacyManifestPayload(meta) {
  return {
    ...releaseMetaPayload(meta),
    built_at: meta.published_at,
    release_id: meta.release_id,
  };
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readRegularFile(file, description) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`android OTA ${description} is not a regular file`);
  }
  return fs.readFileSync(file);
}

function assertReleaseCollisionMatches(dir, normalized, apkBuffer) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("android OTA immutable release collision is not a directory");
  }
  let existingMeta;
  try {
    existingMeta = JSON.parse(readRegularFile(
      path.join(dir, RELEASE_META_NAME),
      "immutable release metadata",
    ).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("android OTA immutable release metadata is invalid");
    }
    throw error;
  }
  const existingApk = readRegularFile(
    path.join(dir, DEFAULT_APK_NAME),
    "immutable release APK",
  );
  if (!existingApk.equals(apkBuffer)
    || serializeJson(existingMeta) !== serializeJson(releaseMetaPayload(normalized))) {
    const error = new Error("android OTA immutable release_id collision");
    error.code = "OTA_RELEASE_COLLISION";
    throw error;
  }
}

function installImmutableRelease(context, normalized, apkBuffer) {
  fs.mkdirSync(releasesDir(context.otaDir), { recursive: true });
  const dir = releaseDir(context.otaDir, normalized.release_id);
  if (!dir) throw new Error("invalid release_id");
  try {
    fs.lstatSync(dir);
    assertReleaseCollisionMatches(dir, normalized, apkBuffer);
    return dir;
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }

  const stage = tempPath(context.otaDir, context.operationId, "release");
  context.tempPaths.push(stage);
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.writeFileSync(path.join(stage, DEFAULT_APK_NAME), apkBuffer, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(
    path.join(stage, RELEASE_META_NAME),
    serializeJson(releaseMetaPayload(normalized)),
    { flag: "wx", mode: 0o600 },
  );
  context.createdReleaseDir = dir;
  fs.renameSync(stage, dir);
  return dir;
}

function writePointerTemp(context, releaseId) {
  const target = tempPath(context.otaDir, context.operationId, "current");
  context.tempPaths.push(target);
  const relative = path.join(RELEASES_DIRNAME, releaseId);
  try {
    fs.symlinkSync(relative, target);
  } catch {
    fs.writeFileSync(target, `${releaseId}\n`, { flag: "wx", mode: 0o600 });
  }
  return target;
}

function updateCanonicalRelease(context, normalized, apkBuffer) {
  const digest = crypto.createHash("sha256").update(apkBuffer).digest("hex");
  if (normalized.sha256 !== digest || normalized.size_bytes !== apkBuffer.length) {
    throw new Error("android OTA release metadata does not match APK bytes");
  }
  const legacyApkTemp = writeTempFile(context, "legacy-apk", apkBuffer);
  const latestTemp = writeTempFile(
    context,
    "latest",
    Buffer.from(serializeJson(legacyManifestPayload(normalized))),
  );
  const currentTemp = writePointerTemp(context, normalized.release_id);
  context.canonicalMutated = true;
  fs.renameSync(legacyApkTemp, path.join(context.otaDir, DEFAULT_APK_NAME));
  fs.renameSync(latestTemp, path.join(context.otaDir, LEGACY_MANIFEST_NAME));
  fs.renameSync(currentTemp, currentLinkPath(context.otaDir));
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
  return withStoreLock(otaDir, "rollback", () => {
    const currentId = ensureMigratedUnlocked(otaDir);
    const currentMeta = currentId ? readReleaseMeta(otaDir, currentId) : null;
    if (!currentMeta) {
      return { ok: false, reason: "no_current_release" };
    }
    const current = {
      ...currentMeta,
      apk_path: path.join(releaseDir(otaDir, currentId), currentMeta.apk),
    };
    const previous = previousRelease(otaDir, current);
    if (!previous) {
      return { ok: false, reason: "no_previous_release", current_release_id: current.release_id };
    }
    return runCanonicalTransaction(otaDir, "rollback", (context) => {
      const previousDir = releaseDir(otaDir, previous.release_id);
      const apkBuffer = readRegularFile(
        path.join(previousDir, DEFAULT_APK_NAME),
        "rollback APK",
      );
      updateCanonicalRelease(context, previous, apkBuffer);
      return {
        ok: true,
        from_release_id: current.release_id,
        to_release_id: previous.release_id,
        manifest: buildLatestManifest(otaDir),
      };
    });
  });
}

// Publish a build into the versioned layout: write releases/<id>/apk +
// release.json and point `current` at it. Also refreshes the legacy
// moa-assistant.apk + latest.json so pre-rollback clients still work. `apk` may
// be a Buffer or a source file path.
function publishRelease(otaDir, { apk, meta = {}, updateLegacy = true } = {}) {
  return withStoreLock(otaDir, "publish", () => {
    if (updateLegacy !== true) {
      throw new Error("android OTA publication must update canonical legacy artifacts");
    }
    const apkBuffer = Buffer.isBuffer(apk) ? apk : fs.readFileSync(apk);
    const normalized = normalizeMeta(meta, { apkBuffer });
    if (!normalized.release_id) throw new Error("could not derive a valid release_id");
    normalized.apk = DEFAULT_APK_NAME;
    return runCanonicalTransaction(otaDir, "publish", (context) => {
      const dir = installImmutableRelease(context, normalized, apkBuffer);
      updateCanonicalRelease(context, normalized, apkBuffer);
      return { ...normalized, apk_path: path.join(dir, DEFAULT_APK_NAME) };
    });
  });
}

module.exports = {
  RELEASE_ID_PATTERN,
  STORE_BUSY_ERROR_CODE,
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
