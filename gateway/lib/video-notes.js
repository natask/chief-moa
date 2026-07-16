"use strict";

// Video notes: screen recordings with spoken narration, captured by a client
// surface and stored as raw blobs. Mirrors lib/audio-notes.js. Unlike audio
// notes, a video note can be attached to a voice turn (video_note_id) where it
// becomes a Gemini inline video part — the recording IS the user's question.
// Storage stays the source of truth; the turn only references the note id.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONTENT_TYPE = "video/webm";
const MAX_LIMIT = 500;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
// Per-request cap. Inline Gemini video rides base64 inside one generateContent
// request, so the raw blob must stay well under the provider request ceiling.
const DEFAULT_MAX_NOTE_BYTES = 24 * 1024 * 1024;

function createVideoNotesStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || "./data");
  const notesDir = path.join(dataDir, "video-notes");
  fs.mkdirSync(notesDir, { recursive: true });
  // Optional blob store: when present (BLOB_STORE=gcs), the on-disk note file
  // is a spool that gets write-behind-uploaded to the bucket, and reads fall
  // through to the bucket once the spool is pruned. Metadata JSON stays local.
  const blobStore = options.blobStore || null;
  const maxTotalBytes = normalizeMaxTotalBytes(options.maxTotalBytes);
  // Quota refuses new notes instead of pruning old ones: stored notes are
  // user screen recordings and must never be silently deleted. Explicit
  // deletion goes through remove().
  let totalBytes = listNoteFiles(notesDir)
    .map((filePath) => readNoteFile(filePath))
    .filter(Boolean)
    .reduce((sum, note) => sum + (Number(note.bytes) || 0), 0);

  function create(input = {}) {
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes || []);
    if (bytes.length <= 0) {
      throw new Error("video note body is empty");
    }
    if (totalBytes + bytes.length > maxTotalBytes) {
      const error = new Error("video notes storage quota exceeded; no existing notes were removed");
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
      video: {
        kind: "note",
        content_type: contentType,
        bytes: bytes.length,
        href: `/v1/video-notes/${encodeURIComponent(id)}/video`,
      },
    };

    const bytesPath = videoPathForNote(notesDir, note);
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

  function videoPath(id) {
    const note = get(id);
    if (!note) return "";
    const filePath = videoPathForNote(notesDir, note);
    return fs.existsSync(filePath) ? filePath : "";
  }

  // Dual read: spool first, then the bucket.
  async function readBytes(id) {
    const note = get(id);
    if (!note) return null;
    if (blobStore) {
      return blobStore.readBytes(noteBlobKey(note));
    }
    try {
      return fs.readFileSync(videoPathForNote(notesDir, note));
    } catch {
      return null;
    }
  }

  function readStream(id) {
    const filePath = videoPath(id);
    return filePath ? fs.createReadStream(filePath) : null;
  }

  // Dual read returning { stream, size, contentType } or null.
  async function stream(id) {
    const note = get(id);
    if (!note) return null;
    const contentType = note.content_type || "application/octet-stream";
    if (blobStore) {
      const found = await blobStore.getReadStream(noteBlobKey(note));
      return found ? { stream: found.stream, size: found.size, contentType } : null;
    }
    const filePath = videoPathForNote(notesDir, note);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    return { stream: fs.createReadStream(filePath), size: stat.size, contentType };
  }

  // Screen recordings are sensitive: unlike audio notes, users get an explicit
  // delete path. Removal frees quota immediately — and deletes the bucket
  // object, not just the spool.
  async function remove(id) {
    const note = get(id);
    if (!note) return false;
    if (blobStore) {
      try {
        await blobStore.delete(noteBlobKey(note));
      } catch {}
    } else {
      try {
        fs.rmSync(videoPathForNote(notesDir, note), { force: true });
      } catch {}
    }
    try {
      fs.rmSync(path.join(notesDir, `${note.id}.json`), { force: true });
    } catch {}
    totalBytes = Math.max(0, totalBytes - (Number(note.bytes) || 0));
    return true;
  }

  function status() {
    return {
      notes_dir: notesDir,
      count: listNoteFiles(notesDir).length,
      total_bytes: totalBytes,
      max_total_bytes: maxTotalBytes,
      endpoint: "/v1/video-notes",
    };
  }

  return {
    notesDir,
    create,
    list,
    get,
    videoPath,
    readBytes,
    readStream,
    stream,
    remove,
    status,
  };
}

function createVideoNoteHandlers(options = {}) {
  const store = options.store || createVideoNotesStore({ dataDir: options.dataDir });
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_NOTE_BYTES);
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
      sendJson(response, 400, { error: "video note body is empty" });
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
    const id = videoNoteIdFromPath(url.pathname);
    const note = id ? store.get(id) : null;
    if (!note) {
      sendJson(response, 404, { error: "video note not found" });
      return;
    }
    sendJson(response, 200, { note });
  }

  async function sendVideo(response, url) {
    const id = videoNoteIdFromPath(url.pathname.replace(/\/video$/, ""));
    const note = id ? store.get(id) : null;
    if (!note) {
      sendJson(response, 404, { error: "video note not found" });
      return;
    }
    let found;
    try {
      found = await store.stream(id);
    } catch (error) {
      sendJson(response, 502, { error: `video note read failed: ${cleanError(error)}` });
      return;
    }
    if (!found) {
      sendJson(response, 404, { error: "video note video not found" });
      return;
    }
    response.writeHead(200, {
      "content-type": found.contentType,
      "content-length": found.size,
      "cache-control": "private, no-store",
      "x-moa-video-note-id": note.id,
      "x-moa-video-kind": "note",
    });
    found.stream.pipe(response);
  }

  async function remove(response, url) {
    const id = videoNoteIdFromPath(url.pathname);
    const removed = id ? await store.remove(id) : false;
    if (!removed) {
      sendJson(response, 404, { error: "video note not found" });
      return;
    }
    sendJson(response, 200, { deleted: true, id });
  }

  return {
    create,
    list,
    get,
    sendVideo,
    remove,
  };
}

// The Gemini inline part for a stored note. Content-type parameters are
// stripped: inlineData wants a bare mime type ("video/webm"), not
// "video/webm;codecs=vp8,opus".
function videoInlinePart(note, bytes) {
  if (!note || !Buffer.isBuffer(bytes) || bytes.length <= 0) return null;
  return {
    inlineData: {
      mimeType: bareMimeType(note.content_type) || DEFAULT_CONTENT_TYPE,
      data: bytes.toString("base64"),
    },
  };
}

function bareMimeType(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
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

function videoPathForNote(notesDir, note) {
  return path.join(notesDir, `${cleanToken(note.id, 120)}${extensionForContentType(note.content_type)}`);
}

// DATA_DIR-relative blob-store key for a note's bytes.
function noteBlobKey(note) {
  return `video-notes/${cleanToken(note.id, 120)}${extensionForContentType(note.content_type)}`;
}

function createNoteId() {
  return `vnote_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function normalizeContentType(value) {
  const contentType = cleanText(value, 160);
  return contentType || DEFAULT_CONTENT_TYPE;
}

function extensionForContentType(contentType) {
  const lower = bareMimeType(contentType);
  if (lower === "video/webm") return ".webm";
  if (lower === "video/mp4") return ".mp4";
  return ".bin";
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

function videoNoteIdFromPath(pathname) {
  const rest = String(pathname || "").slice("/v1/video-notes/".length);
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
  createVideoNotesStore,
  createVideoNoteHandlers,
  videoInlinePart,
  bareMimeType,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_MAX_NOTE_BYTES,
};
