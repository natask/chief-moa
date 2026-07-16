"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_LIMIT = 500;

function createMediaNoteStore(options) {
  const notesDir = path.join(path.resolve(options.dataDir || "./data"), options.directory);
  fs.mkdirSync(notesDir, { recursive: true });
  const maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  let totalBytes = listMetadataFiles(notesDir)
    .map(readMetadata)
    .filter(Boolean)
    .reduce((sum, note) => sum + (Number(note.bytes) || 0), 0);

  function create(input = {}) {
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes || []);
    if (bytes.length === 0) {
      throw new Error(`${options.label} body is empty`);
    }
    if (totalBytes + bytes.length > maxTotalBytes) {
      const error = new Error(`${options.pluralLabel} storage quota exceeded; no existing notes were removed`);
      error.statusCode = 507;
      throw error;
    }
    const contentType = cleanText(input.content_type || input.contentType, 160) || options.defaultContentType;
    const id = `${options.idPrefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
    const note = {
      id,
      created_at: new Date().toISOString(),
      surface: cleanText(input.surface, 80),
      session_id: cleanToken(input.session_id || input.sessionId, 120),
      content_type: contentType,
      bytes: bytes.length,
      duration_ms: durationMs(input.duration_ms || input.durationMs),
      label: cleanText(input.label, 200),
      [options.mediaKey]: options.mediaDescriptor({ id, contentType, bytes: bytes.length }),
    };
    const filePath = blobPathFor(note);
    atomicWrite(filePath, bytes);
    atomicWrite(path.join(notesDir, `${id}.json`), JSON.stringify(note, null, 2));
    totalBytes += bytes.length;
    return clone(note);
  }

  function list(filter = {}) {
    return listMetadataFiles(notesDir)
      .map(readMetadata)
      .filter(Boolean)
      .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")))
      .slice(0, limit(filter.limit))
      .map(clone);
  }

  function get(id) {
    const safeId = cleanToken(id, 120);
    if (!safeId) return null;
    const filePath = path.join(notesDir, `${safeId}.json`);
    return fs.existsSync(filePath) ? readMetadata(filePath) : null;
  }

  function blobPath(id) {
    const note = get(id);
    if (!note) return "";
    const filePath = blobPathFor(note);
    return fs.existsSync(filePath) ? filePath : "";
  }

  function readBytes(id) {
    const filePath = blobPath(id);
    if (!filePath) return null;
    try {
      return fs.readFileSync(filePath);
    } catch {
      return null;
    }
  }

  function readStream(id) {
    const filePath = blobPath(id);
    return filePath ? fs.createReadStream(filePath) : null;
  }

  function remove(id) {
    const note = get(id);
    if (!note) return false;
    try {
      fs.rmSync(blobPathFor(note), { force: true });
    } catch {}
    try {
      fs.rmSync(path.join(notesDir, `${note.id}.json`), { force: true });
    } catch {}
    totalBytes = Math.max(0, totalBytes - (Number(note.bytes) || 0));
    return true;
  }

  function status() {
    return {
      notes_dir: notesDir,
      count: listMetadataFiles(notesDir).length,
      total_bytes: totalBytes,
      max_total_bytes: maxTotalBytes,
      endpoint: options.endpoint,
    };
  }

  function blobPathFor(note) {
    return path.join(notesDir, `${cleanToken(note.id, 120)}${options.extensionForContentType(note.content_type)}`);
  }

  return {
    notesDir,
    create,
    list,
    get,
    blobPath,
    readBytes,
    readStream,
    remove,
    status,
  };
}

function listMetadataFiles(notesDir) {
  if (!fs.existsSync(notesDir)) return [];
  return fs.readdirSync(notesDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(notesDir, name));
}

function readMetadata(filePath) {
  try {
    const note = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return note && typeof note === "object" && !Array.isArray(note) && cleanToken(note.id, 120) ? note : null;
  } catch {
    return null;
  }
}

function atomicWrite(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, value);
  fs.renameSync(tmpPath, filePath);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function durationMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function limit(value) {
  const number = Number(value || 100);
  return Number.isFinite(number) && number > 0 ? Math.min(MAX_LIMIT, Math.floor(number)) : 100;
}

function cleanToken(value, max) {
  return typeof value === "string" ? value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, max) : "";
}

function cleanText(value, max) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { createMediaNoteStore };
