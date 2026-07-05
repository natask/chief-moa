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
  const maxTotalBytes = normalizeMaxTotalBytes(options.maxTotalBytes);
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

  function sendAudio(response, url) {
    const id = audioNoteIdFromPath(url.pathname.replace(/\/audio$/, ""));
    const note = id ? store.get(id) : null;
    if (!note) {
      sendJson(response, 404, { error: "audio note not found" });
      return;
    }
    const filePath = store.audioPath(id);
    if (!filePath || !fs.existsSync(filePath)) {
      sendJson(response, 404, { error: "audio note audio not found" });
      return;
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      sendJson(response, 404, { error: "audio note audio not found" });
      return;
    }
    response.writeHead(200, {
      "content-type": note.content_type || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": "private, no-store",
      "x-moa-audio-note-id": note.id,
      "x-moa-audio-kind": "note",
    });
    fs.createReadStream(filePath).pipe(response);
  }

  return {
    create,
    list,
    get,
    sendAudio,
  };
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
