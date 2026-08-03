"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONTENT_TYPE = "audio/L16; rate=16000; channels=1";
const MAX_LIMIT = 500;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

function createAudioNotesStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || "./data");
  const notesDir = path.join(dataDir, "audio-notes");
  fs.mkdirSync(notesDir, { recursive: true });
  // Optional blob store: when present (BLOB_STORE=gcs), the on-disk note file
  // is a spool that gets write-behind-uploaded to the bucket, and reads fall
  // through to the bucket once the spool is pruned. Metadata JSON stays local.
  const blobStore = options.blobStore || null;
  const maxTotalBytes = normalizeMaxTotalBytes(options.maxTotalBytes);
  const removals = new Map();
  // Quota refuses new notes instead of pruning old ones: stored notes are
  // user speech and must never be silently deleted.
  let totalBytes = listNoteFiles(notesDir)
    .map((filePath) => readNoteFile(filePath))
    .filter(Boolean)
    .reduce((sum, note) => sum + (Number(note.bytes) || 0), 0);

  function create(input = {}) {
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes || []);
    if (bytes.length <= 0) {
      throw new Error("audio note body is empty");
    }
    if (totalBytes + bytes.length > maxTotalBytes) {
      const error = new Error("audio notes storage quota exceeded; no existing notes were removed");
      error.statusCode = 507;
      throw error;
    }
    const contentType = normalizeContentType(input.content_type || input.contentType);
    const id = createNoteId();
    const now = new Date().toISOString();
    const note = {
      id,
      created_at: now,
      surface: cleanText(input.surface, 80),
      session_id: cleanToken(input.session_id || input.sessionId, 120),
      content_type: contentType,
      bytes: bytes.length,
      duration_ms: normalizeDurationMs(input.duration_ms || input.durationMs),
      label: cleanText(input.label, 200),
      audio: {
        kind: "note",
        encoding: encodingForContentType(contentType),
        content_type: contentType,
        bytes: bytes.length,
        href: `/v1/audio-notes/${encodeURIComponent(id)}/audio`,
      },
    };

    const bytesPath = audioPathForNote(notesDir, note);
    const bytesTmp = `${bytesPath}.${process.pid}.tmp`;
    fs.writeFileSync(bytesTmp, bytes);
    fs.renameSync(bytesTmp, bytesPath);
    writeNote(notesDir, note);
    totalBytes += bytes.length;
    if (blobStore) {
      // Respond as soon as the spool write lands; the uploader owns retries
      // and the janitor re-enqueues after a crash.
      blobStore.finalizeSpool(noteBlobKey(note), { contentType });
    }
    return clone(note);
  }

  function list(filter = {}) {
    const limit = clampLimit(filter.limit);
    return listNoteFiles(notesDir)
      .map((filePath) => readNoteFile(filePath))
      .filter(Boolean)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
      .slice(0, limit)
      .map(clone);
  }

  function get(id) {
    const safeId = cleanToken(id, 120);
    if (!safeId) return null;
    const filePath = path.join(notesDir, `${safeId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return readNoteFile(filePath);
  }

  function audioPath(id) {
    const note = get(id);
    if (!note) return "";
    const filePath = audioPathForNote(notesDir, note);
    return fs.existsSync(filePath) ? filePath : "";
  }

  function readStream(id) {
    const filePath = audioPath(id);
    return filePath ? fs.createReadStream(filePath) : null;
  }

  // Dual read: spool first, then the bucket. Returns
  // { stream, size, contentType } or null.
  async function stream(id) {
    const note = get(id);
    if (!note) return null;
    const contentType = note.content_type || "application/octet-stream";
    if (blobStore) {
      const found = await blobStore.getReadStream(noteBlobKey(note));
      return found ? { stream: found.stream, size: found.size, contentType } : null;
    }
    const filePath = audioPathForNote(notesDir, note);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    return { stream: fs.createReadStream(filePath), size: stat.size, contentType };
  }

  async function remove(id) {
    const safeId = cleanToken(id, 120);
    if (!safeId) return deletionReceipt("", true, remoteStatus(blobStore));
    if (removals.has(safeId)) return removals.get(safeId);
    const pending = removeOnce(safeId).finally(() => removals.delete(safeId));
    removals.set(safeId, pending);
    return pending;
  }

  async function removeOnce(id) {
    const note = get(id);
    if (!note) return deletionReceipt(id, true, remoteStatus(blobStore));
    const blobPath = audioPathForNote(notesDir, note);
    const key = noteBlobKey(note);
    if (blobStore) {
      try {
        await blobStore.delete(key);
        if (blobStore.mode === "gcs" && typeof blobStore.flush === "function") {
          await blobStore.flush();
        }
      } catch (error) {
        throw deletionError(note, "audio note blob deletion failed", error, "failed", !fs.existsSync(blobPath));
      }
      if (fs.existsSync(blobPath)) {
        throw deletionError(note, "audio note local spool deletion failed", null, "unverified", false);
      }
      if (blobStore.mode === "gcs" && typeof blobStore.stat === "function") {
        let remaining;
        try {
          remaining = await blobStore.stat(key);
        } catch (error) {
          throw deletionError(note, "audio note remote deletion could not be verified", error, "unverified", true);
        }
        if (remaining) {
          throw deletionError(note, "audio note remote blob remains after deletion", null, "failed", true);
        }
      }
    } else {
      try {
        fs.rmSync(blobPath, { force: true });
      } catch (error) {
        throw deletionError(note, "audio note local deletion failed", error, "not_applicable", !fs.existsSync(blobPath), 500);
      }
      if (fs.existsSync(blobPath)) {
        throw deletionError(note, "audio note local bytes remain after deletion", null, "not_applicable", false, 500);
      }
    }

    const metadataPath = path.join(notesDir, `${note.id}.json`);
    try {
      fs.rmSync(metadataPath, { force: true });
    } catch (error) {
      throw deletionError(note, "audio note metadata deletion failed", error, remoteStatus(blobStore), true, 500);
    }
    if (fs.existsSync(metadataPath)) {
      throw deletionError(note, "audio note metadata remains after deletion", null, remoteStatus(blobStore), true, 500);
    }
    totalBytes = Math.max(0, totalBytes - (Number(note.bytes) || 0));
    return deletionReceipt(note.id, false, remoteStatus(blobStore));
  }

  function status() {
    return {
      notes_dir: notesDir,
      count: listNoteFiles(notesDir).length,
      total_bytes: totalBytes,
      max_total_bytes: maxTotalBytes,
      endpoint: "/v1/audio-notes",
    };
  }

  return {
    notesDir,
    create,
    list,
    get,
    audioPath,
    readStream,
    stream,
    remove,
    status,
  };
}

function createAudioNoteHandlers(options = {}) {
  const store = options.store || createAudioNotesStore({ dataDir: options.dataDir });
  const maxBytes = Number(options.maxBytes || 32 * 1024 * 1024);
  const recordCreated = typeof options.recordCreated === "function" ? options.recordCreated : () => {};

  async function create(request, response) {
    let bytes;
    try {
      bytes = await readRawBody(request, maxBytes);
    } catch (error) {
      sendJson(response, Number(error?.statusCode) || 400, { error: cleanError(error) });
      return;
    }
    if (!bytes || bytes.length <= 0) {
      sendJson(response, 400, { error: "audio note body is empty" });
      return;
    }

    let note;
    try {
      note = store.create({
        bytes,
        content_type: request.headers["content-type"] || "",
        surface: request.headers["x-moa-surface"] || "",
        session_id: request.headers["x-moa-session-id"] || "",
        duration_ms: request.headers["x-moa-duration-ms"] || "",
        label: request.headers["x-moa-label"] || "",
      });
    } catch (error) {
      sendJson(response, Number(error?.statusCode) || 500, { error: cleanError(error) });
      return;
    }
    try {
      recordCreated(note);
    } catch {
      // Product-event mirroring is best-effort; storage is the source of truth.
    }
    sendJson(response, 201, { note });
  }

  function list(response, url) {
    sendJson(response, 200, {
      notes: store.list({ limit: url.searchParams.get("limit") }),
    });
  }

  function get(response, url) {
    const id = audioNoteIdFromPath(url.pathname);
    const note = id ? store.get(id) : null;
    if (!note) {
      sendJson(response, 404, { error: "audio note not found" });
      return;
    }
    sendJson(response, 200, { note });
  }

  async function sendAudio(response, url) {
    const id = audioNoteIdFromPath(url.pathname.replace(/\/audio$/, ""));
    const note = id ? store.get(id) : null;
    if (!note) {
      sendJson(response, 404, { error: "audio note not found" });
      return;
    }
    let found;
    try {
      found = await store.stream(id);
    } catch (error) {
      sendJson(response, 502, { error: `audio note read failed: ${cleanError(error)}` });
      return;
    }
    if (!found) {
      sendJson(response, 404, { error: "audio note audio not found" });
      return;
    }
    response.writeHead(200, {
      "content-type": found.contentType,
      "content-length": found.size,
      "cache-control": "private, no-store",
      "x-moa-audio-note-id": note.id,
      "x-moa-audio-kind": "note",
    });
    found.stream.pipe(response);
  }

  async function remove(response, url) {
    const id = audioNoteIdFromPath(url.pathname);
    if (!id) {
      sendJson(response, 404, { error: "audio note not found" });
      return;
    }
    try {
      sendJson(response, 200, await store.remove(id));
    } catch (error) {
      const payload = { error: cleanError(error) };
      if (error?.deletion) payload.deletion = error.deletion;
      sendJson(response, Number(error?.statusCode) || 500, payload);
    }
  }

  return {
    create,
    list,
    get,
    sendAudio,
    remove,
  };
}

function deletionReceipt(id, alreadyDeleted, remote) {
  return {
    deleted: true,
    id,
    already_deleted: alreadyDeleted,
    metadata_deleted: true,
    local_deleted: true,
    remote_status: remote,
  };
}

function deletionError(note, message, cause, remote, localDeleted, statusCode = 502) {
  const detail = cause ? `: ${cleanError(cause)}` : "";
  const error = new Error(`${message}${detail}`);
  error.statusCode = statusCode;
  error.deletion = {
    deleted: false,
    id: note.id,
    metadata_deleted: false,
    local_deleted: localDeleted,
    remote_status: remote,
    retryable: true,
  };
  return error;
}

function remoteStatus(blobStore) {
  return blobStore?.mode === "gcs" ? "deleted_or_absent" : "not_applicable";
}

function writeNote(notesDir, note) {
  const filePath = path.join(notesDir, `${note.id}.json`);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(note, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function readNoteFile(filePath) {
  try {
    const note = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!note || typeof note !== "object" || !cleanToken(note.id, 120)) {
      return null;
    }
    return note;
  } catch {
    return null;
  }
}

function listNoteFiles(notesDir) {
  if (!fs.existsSync(notesDir)) return [];
  return fs.readdirSync(notesDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(notesDir, name));
}

function audioPathForNote(notesDir, note) {
  return path.join(notesDir, `${cleanToken(note.id, 120)}${extensionForContentType(note.content_type)}`);
}

// DATA_DIR-relative blob-store key for a note's bytes.
function noteBlobKey(note) {
  return `audio-notes/${cleanToken(note.id, 120)}${extensionForContentType(note.content_type)}`;
}

function createNoteId() {
  return `note_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function normalizeContentType(value) {
  const contentType = cleanText(value, 160);
  return contentType || DEFAULT_CONTENT_TYPE;
}

function extensionForContentType(contentType) {
  const lower = String(contentType || "").toLowerCase();
  if (lower.startsWith("audio/l16")) return ".pcm";
  if (lower.startsWith("audio/webm")) return ".webm";
  return ".bin";
}

function encodingForContentType(contentType) {
  const lower = String(contentType || "").toLowerCase();
  if (lower.startsWith("audio/l16")) return "pcm16";
  if (lower.startsWith("audio/webm")) return "webm";
  return "binary";
}

function normalizeMaxTotalBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_MAX_TOTAL_BYTES;
  return Math.floor(number);
}

function normalizeDurationMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number);
}

function clampLimit(value) {
  const number = Number(value || 100);
  if (!Number.isFinite(number) || number <= 0) return 100;
  return Math.min(MAX_LIMIT, Math.floor(number));
}

function cleanToken(value, max) {
  return typeof value === "string"
    ? value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, max)
    : "";
}

function cleanText(value, max) {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, max)
    : "";
}

function audioNoteIdFromPath(pathname) {
  const rest = String(pathname || "").slice("/v1/audio-notes/".length);
  if (!rest || rest.includes("/")) return "";
  try {
    return decodeURIComponent(rest).trim();
  } catch {
    return "";
  }
}

function readRawBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        const error = new Error("request body too large");
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  createAudioNotesStore,
  createAudioNoteHandlers,
  DEFAULT_CONTENT_TYPE,
};
