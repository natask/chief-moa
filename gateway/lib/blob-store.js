"use strict";

// Blob store for user media (voice-turn PCM, audio notes, video notes).
// Two drivers behind one interface, selected by BLOB_STORE:
//
//   local (default) — bytes live under DATA_DIR exactly as before. Every
//     method is plain fs; upload/janitor are no-ops. Self-host needs no
//     Google account.
//   gcs — the DATA_DIR file becomes a short-lived spool. Bytes still land
//     locally first (voice audio streams to the spool mid-turn and several
//     STT paths read it back during the live turn), then a write-behind
//     uploader copies them to the bucket. Reads go spool-first, then GCS.
//     The spool file is the durability floor: it is never deleted until the
//     object is confirmed in GCS, so a GCS outage degrades to exactly the
//     local behavior and user speech is never lost.
//
// Keys are DATA_DIR-relative POSIX paths (voice-sessions/<sid>/<tid>.pcm,
// audio-notes/<id>.webm, ...). The GCS object name is GCS_PREFIX + key.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { createGoogleTokenSource } = require("./google-auth");

const DEFAULT_ENDPOINT = "https://storage.googleapis.com";
const DEFAULT_SPOOL_DIRS = ["voice-sessions", "audio-notes", "video-notes"];
// Local cache retention after a confirmed upload; 0 = keep forever.
const DEFAULT_SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_JANITOR_INTERVAL_MS = 15 * 60 * 1000;
// Files younger than this are skipped by the janitor: they may still be
// mid-write (a live voice turn appends to its spool for the whole turn).
const JANITOR_MIN_AGE_MS = 60 * 1000;
const TOMBSTONE_TTL_MS = 60 * 60 * 1000;
const UPLOAD_CONCURRENCY = 2;
const RETRY_DELAYS_MS = [5000, 30000, 120000, 600000, 3600000];

function createBlobStore(options = {}) {
  const env = options.env || process.env;
  const dataDir = path.resolve(options.dataDir || "./data");
  const mode = String(env.BLOB_STORE || "local").trim().toLowerCase() === "gcs" ? "gcs" : "local";
  const spoolDirs = options.spoolDirs || DEFAULT_SPOOL_DIRS;
  const spoolMaxAgeMs = normalizeMs(env.BLOB_SPOOL_MAX_AGE_MS, DEFAULT_SPOOL_MAX_AGE_MS);
  const janitorIntervalMs = normalizeMs(env.BLOB_JANITOR_INTERVAL_MS, DEFAULT_JANITOR_INTERVAL_MS);
  const retryDelays = options.retryDelaysMs || RETRY_DELAYS_MS;

  let gcs = null;
  if (mode === "gcs") {
    const bucket = String(env.GCS_BUCKET || "").trim();
    if (!bucket) {
      throw new Error("BLOB_STORE=gcs requires GCS_BUCKET");
    }
    gcs = createGcsClient({
      bucket,
      prefix: String(env.GCS_PREFIX || "").trim(),
      endpoint: String(env.GCS_ENDPOINT || "").trim() || DEFAULT_ENDPOINT,
      userProject:
        String(env.GCS_PROJECT_ID || env.GCP_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || "").trim(),
      tokenSource: options.tokenSource || createGoogleTokenSource({ env }),
    });
  }

  // Upload bookkeeping (gcs mode only, all in-memory: the janitor sweep
  // reconciles against the bucket after a restart).
  const queue = new Map(); // key -> { contentType, attempts, timer, running, waiters }
  const tombstones = new Map(); // key -> tombstoned-at ms (deleted while upload may be pending)
  const uploaded = new Map(); // key -> confirmed-at ms
  let runningUploads = 0;
  let failedUploads = 0;
  let lastError = "";
  let lastUploadAt = "";
  let janitorTimer = null;
  let janitorRunning = false;

  function localPath(key) {
    const safe = safeKey(key);
    const filePath = path.join(dataDir, safe);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return filePath;
  }

  function statLocal(key) {
    try {
      const stats = fs.statSync(path.join(dataDir, safeKey(key)));
      return stats.isFile() ? { size: stats.size, source: "local" } : null;
    } catch {
      return null;
    }
  }

  async function put(key, bytes, { contentType } = {}) {
    const filePath = localPath(key);
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, bytes);
    fs.renameSync(tmpPath, filePath);
    enqueueUpload(key, contentType);
  }

  // For spool files written externally (the voice session server streams
  // straight to localPath(key) over the life of a turn).
  function finalizeSpool(key, { contentType } = {}) {
    enqueueUpload(key, contentType);
  }

  async function stat(key) {
    const local = statLocal(key);
    if (local) return local;
    if (!gcs) return null;
    const remote = await gcs.stat(safeKey(key));
    return remote ? { size: remote.size, source: "gcs" } : null;
  }

  async function getReadStream(key) {
    const safe = safeKey(key);
    // Open by fd so a concurrent janitor prune between stat and first read
    // cannot surface as an async ENOENT on the returned stream.
    let fd = null;
    try {
      fd = fs.openSync(path.join(dataDir, safe), "r");
    } catch {}
    if (fd !== null) {
      try {
        const stats = fs.fstatSync(fd);
        if (stats.isFile()) {
          return { stream: fs.createReadStream("", { fd }), size: stats.size, source: "local" };
        }
        fs.closeSync(fd);
      } catch {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
    if (!gcs) return null;
    const remote = await gcs.stat(safe);
    if (!remote) return null;
    const stream = await gcs.readStream(safe);
    if (!stream) return null;
    return { stream, size: remote.size, source: "gcs" };
  }

  async function readBytes(key) {
    const safe = safeKey(key);
    try {
      return fs.readFileSync(path.join(dataDir, safe));
    } catch {}
    if (!gcs) return null;
    return gcs.readBytes(safe);
  }

  // Materialize the blob on local disk (for code that hands a file path to
  // downstream readers, e.g. retranscribe). Returns "" when missing in both.
  async function ensureLocal(key) {
    const safe = safeKey(key);
    const filePath = path.join(dataDir, safe);
    if (fs.existsSync(filePath)) return filePath;
    if (!gcs) return "";
    const bytes = await gcs.readBytes(safe);
    if (!bytes) return "";
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, bytes);
    fs.renameSync(tmpPath, filePath);
    return filePath;
  }

  // Delete everywhere. The tombstone closes the race with an in-flight
  // upload: the uploader checks it before and after each attempt, so a blob
  // deleted mid-upload (incognito audio) never survives in the bucket.
  async function deleteBlob(key) {
    const safe = safeKey(key);
    if (gcs) tombstones.set(safe, Date.now());
    const entry = queue.get(safe);
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      if (!entry.running) queue.delete(safe);
    }
    uploaded.delete(safe);
    try {
      fs.unlinkSync(path.join(dataDir, safe));
    } catch {}
    if (gcs) {
      try {
        await gcs.delete(safe);
      } catch (error) {
        lastError = `delete ${safe}: ${cleanError(error)}`;
      }
    }
  }

  function enqueueUpload(key, contentType) {
    if (!gcs) return;
    const safe = safeKey(key);
    if (tombstones.has(safe)) return;
    const existing = queue.get(safe);
    if (existing) {
      existing.contentType = contentType || existing.contentType;
      return;
    }
    queue.set(safe, {
      contentType: contentType || "application/octet-stream",
      attempts: 0,
      timer: null,
      running: false,
      waiters: [],
    });
    pump();
  }

  function pump() {
    if (!gcs) return;
    for (const [key, entry] of queue) {
      if (runningUploads >= UPLOAD_CONCURRENCY) return;
      if (entry.running || entry.timer) continue;
      entry.running = true;
      runningUploads += 1;
      performUpload(key, entry).finally(() => {
        runningUploads -= 1;
        pump();
      });
    }
  }

  async function performUpload(key, entry) {
    try {
      if (tombstones.has(key)) {
        settle(key, entry);
        return;
      }
      let bytes;
      try {
        bytes = fs.readFileSync(path.join(dataDir, key));
      } catch {
        // Spool vanished (deleted or never written) — nothing to upload.
        settle(key, entry);
        return;
      }
      await gcs.upload(key, bytes, entry.contentType);
      if (tombstones.has(key)) {
        // Deleted while the upload was in flight — take the object back out.
        try {
          await gcs.delete(key);
        } catch {}
        settle(key, entry);
        return;
      }
      uploaded.set(key, Date.now());
      lastUploadAt = new Date().toISOString();
      settle(key, entry);
    } catch (error) {
      lastError = `upload ${key}: ${cleanError(error)}`;
      entry.attempts += 1;
      failedUploads += 1;
      entry.running = false;
      const delay = retryDelays[Math.min(entry.attempts - 1, retryDelays.length - 1)];
      entry.timer = setTimeout(() => {
        entry.timer = null;
        pump();
      }, delay);
      if (entry.timer.unref) entry.timer.unref();
      // Wake any flush() waiter so a drain re-drives the retry instead of
      // hanging until the backoff timer fires.
      for (const waiter of entry.waiters.splice(0)) waiter();
    }
  }

  function settle(key, entry) {
    entry.running = false;
    queue.delete(key);
    for (const waiter of entry.waiters.splice(0)) waiter();
  }

  // Drain the queue (tests, shutdown). Retry timers are fired immediately.
  // Entries that keep failing past maxAttempts are left queued for the
  // background backoff so a dead bucket cannot spin the drain forever.
  async function flush({ maxAttempts = 10 } = {}) {
    if (!gcs) return;
    while ([...queue.values()].some((entry) => entry.attempts < maxAttempts)) {
      for (const entry of queue.values()) {
        if (entry.timer && entry.attempts < maxAttempts) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
      }
      pump();
      await new Promise((resolve) => {
        const pending = [...queue.values()].filter((entry) => entry.running || !entry.timer);
        if (pending.length === 0) return resolve();
        pending[0].waiters.push(resolve);
      });
    }
  }

  // The janitor is simultaneously crash recovery (spool files with no
  // matching object get re-enqueued), incremental backfill, and the disk
  // bound (spool files confirmed in GCS are pruned after spoolMaxAgeMs).
  async function sweepSpool() {
    if (!gcs || janitorRunning) return;
    janitorRunning = true;
    try {
      const now = Date.now();
      for (const [key, at] of tombstones) {
        if (now - at > TOMBSTONE_TTL_MS && !queue.has(key)) tombstones.delete(key);
      }
      for (const dir of spoolDirs) {
        for (const key of walkBlobFiles(path.join(dataDir, dir), dataDir)) {
          if (queue.has(key) || tombstones.has(key)) continue;
          let stats;
          try {
            stats = fs.statSync(path.join(dataDir, key));
          } catch {
            continue;
          }
          if (now - stats.mtimeMs < JANITOR_MIN_AGE_MS) continue;
          const reclaimable = spoolMaxAgeMs > 0 && now - stats.mtimeMs > spoolMaxAgeMs;
          if (reclaimable) {
            // `uploaded` is only an in-memory scheduling hint. The object may
            // have been removed or replaced after this process uploaded it,
            // and a restart can reconstruct that hint from size alone. Before
            // deleting the durability-floor spool, verify this exact local
            // file against fresh metadata for this exact GCS object. MD5 is
            // required because size alone cannot detect same-size corruption.
            const verification = await verifyReclaimableObject(gcs, key, path.join(dataDir, key), stats);
            if (!verification.verified) {
              uploaded.delete(key);
              enqueueUpload(key, contentTypeForKey(key));
              continue;
            }
            try {
              const current = fs.statSync(path.join(dataDir, key));
              if (!sameFile(current, verification.localStats)) {
                uploaded.delete(key);
                enqueueUpload(key, contentTypeForKey(key));
                continue;
              }
              fs.unlinkSync(path.join(dataDir, key));
              uploaded.delete(key);
            } catch {}
            continue;
          }

          if (!uploaded.has(key)) {
            const remote = await gcs.stat(key);
            if (remote && remote.size === stats.size) {
              uploaded.set(key, now);
            } else {
              enqueueUpload(key, contentTypeForKey(key));
            }
          }
        }
      }
    } catch (error) {
      lastError = `janitor: ${cleanError(error)}`;
    } finally {
      janitorRunning = false;
    }
  }

  function startJanitor() {
    if (!gcs || janitorTimer) return;
    sweepSpool();
    janitorTimer = setInterval(sweepSpool, janitorIntervalMs);
    if (janitorTimer.unref) janitorTimer.unref();
  }

  function stopJanitor() {
    if (janitorTimer) {
      clearInterval(janitorTimer);
      janitorTimer = null;
    }
  }

  function status() {
    const base = { mode };
    if (!gcs) return base;
    return {
      ...base,
      bucket: gcs.bucket,
      prefix: gcs.prefix,
      pending_uploads: queue.size,
      failed_upload_attempts: failedUploads,
      uploaded_since_boot: uploaded.size,
      last_upload_at: lastUploadAt || null,
      last_error: lastError || null,
    };
  }

  return {
    mode,
    dataDir,
    localPath,
    statLocal,
    put,
    finalizeSpool,
    stat,
    getReadStream,
    readBytes,
    ensureLocal,
    delete: deleteBlob,
    status,
    flush,
    startJanitor,
    stopJanitor,
    sweepSpool,
  };
}

// Thin REST client over the GCS JSON/media API. Raw fetch to match how the
// gateway talks to every other Google service; no resumable uploads — the
// largest blob is a 24 MiB video note and retry re-sends the whole object
// from the spool.
function createGcsClient(options = {}) {
  const bucket = String(options.bucket || "").trim();
  if (!bucket) throw new Error("GCS client requires a bucket");
  const prefix = String(options.prefix || "");
  const endpoint = String(options.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const userProject = String(options.userProject || "").trim();
  const tokenSource = options.tokenSource;
  if (!tokenSource || typeof tokenSource.token !== "function") {
    throw new Error("GCS client requires a tokenSource");
  }

  async function headers(extra = {}) {
    const value = { authorization: `Bearer ${await tokenSource.token()}`, ...extra };
    // authorized_user tokens carry no project; GCS bills their requests to a
    // quota project, same as the Chirp REST path.
    if (
      userProject &&
      (typeof tokenSource.credentialType !== "function" ||
        tokenSource.credentialType() !== "service_account")
    ) {
      value["x-goog-user-project"] = userProject;
    }
    return value;
  }

  function objectName(key) {
    return encodeURIComponent(`${prefix}${key}`);
  }

  async function upload(key, bytes, contentType, { ifAbsent = false } = {}) {
    const params = ifAbsent ? "&ifGenerationMatch=0" : "";
    const response = await fetch(
      `${endpoint}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${objectName(key)}${params}`,
      {
        method: "POST",
        headers: await headers({ "content-type": contentType || "application/octet-stream" }),
        body: bytes,
      },
    );
    if (ifAbsent && response.status === 412) {
      // Object already exists — create-only upload counts as done.
      await drain(response);
      return { existed: true };
    }
    if (!response.ok) {
      throw new Error(`GCS upload failed (${response.status}): ${cleanError(await response.text())}`);
    }
    await drain(response);
    return { existed: false };
  }

  async function stat(key) {
    const response = await fetch(`${endpoint}/storage/v1/b/${bucket}/o/${objectName(key)}`, {
      headers: await headers(),
    });
    if (response.status === 404) {
      await drain(response);
      return null;
    }
    if (!response.ok) {
      throw new Error(`GCS stat failed (${response.status}): ${cleanError(await response.text())}`);
    }
    const body = await response.json();
    return {
      size: Number(body.size || 0),
      contentType: String(body.contentType || ""),
      generation: String(body.generation || ""),
      md5Hash: String(body.md5Hash || ""),
    };
  }

  async function mediaResponse(key) {
    const response = await fetch(
      `${endpoint}/storage/v1/b/${bucket}/o/${objectName(key)}?alt=media`,
      { headers: await headers() },
    );
    if (response.status === 404) {
      await drain(response);
      return null;
    }
    if (!response.ok) {
      throw new Error(`GCS read failed (${response.status}): ${cleanError(await response.text())}`);
    }
    return response;
  }

  async function readStream(key) {
    const response = await mediaResponse(key);
    return response ? Readable.fromWeb(response.body) : null;
  }

  async function readBytes(key) {
    const response = await mediaResponse(key);
    return response ? Buffer.from(await response.arrayBuffer()) : null;
  }

  async function deleteObject(key) {
    const response = await fetch(`${endpoint}/storage/v1/b/${bucket}/o/${objectName(key)}`, {
      method: "DELETE",
      headers: await headers(),
    });
    if (response.status === 404 || response.status === 204 || response.ok) {
      await drain(response);
      return;
    }
    throw new Error(`GCS delete failed (${response.status}): ${cleanError(await response.text())}`);
  }

  return { bucket, prefix, endpoint, upload, stat, readStream, readBytes, delete: deleteObject };
}

async function verifyReclaimableObject(gcs, key, filePath, expectedStats) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, "r");
    const before = await handle.stat();
    if (!sameFile(before, expectedStats)) return { verified: false };

    const hash = crypto.createHash("md5");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);

    const after = await handle.stat();
    if (!sameFile(after, before)) return { verified: false };
    const digest = hash.digest("base64");

    // Fetch metadata after hashing so this per-object check sits immediately
    // before reclamation rather than before a potentially long local read.
    const remote = await gcs.stat(key);
    if (!remote || remote.size !== after.size || !remote.md5Hash) {
      return { verified: false };
    }
    const final = await handle.stat();
    if (!sameFile(final, after)) return { verified: false };
    return {
      verified: digest === remote.md5Hash,
      localStats: final,
    };
  } catch {
    return { verified: false };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function sameFile(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function* walkBlobFiles(dir, root) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkBlobFiles(full, root);
    } else if (entry.isFile() && !entry.name.endsWith(".json") && !entry.name.endsWith(".tmp")) {
      yield path.relative(root, full).split(path.sep).join("/");
    }
  }
}

function contentTypeForKey(key) {
  if (key.endsWith(".pcm")) return "audio/L16; rate=16000; channels=1";
  if (key.endsWith(".webm")) return key.includes("video-notes/") ? "video/webm" : "audio/webm";
  if (key.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

function safeKey(key) {
  const value = String(key || "").split(path.sep).join("/");
  if (!value || value.startsWith("/") || value.includes("..") || value.includes("\0")) {
    throw new Error(`invalid blob key: ${value.slice(0, 100)}`);
  }
  return value;
}

async function drain(response) {
  try {
    await response.arrayBuffer();
  } catch {}
}

function normalizeMs(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}

module.exports = { createBlobStore, createGcsClient, contentTypeForKey };
