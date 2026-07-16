"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STORE_VERSION = 1;
const MAX_BOOKMARKS = 5000;
const MAX_POSITION_MS = 31_536_000_000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const BOOKMARK_ID = /^[A-Za-z0-9_-]{1,120}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,200}$/;

function createMediaBookmarkStore(options = {}) {
  const dataDir = requiredText(options.dataDir, 4096, "dataDir");
  const filePath = path.join(dataDir, "media-bookmarks.json");
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
  const randomId = typeof options.randomId === "function"
    ? options.randomId
    : () => `bookmark_${crypto.randomUUID()}`;

  function readState() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return { version: STORE_VERSION, bookmarks: [] };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("media bookmark store is not valid JSON");
    }
    if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.bookmarks)) {
      throw new Error("media bookmark store has an unsupported shape");
    }
    return parsed;
  }

  function writeState(state) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, filePath);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
    }
  }

  function save(ownerId, input = {}) {
    const owner = requiredOwnerId(ownerId);
    const canonical = asValidation(() => canonicalInput(input));
    const state = readState();
    const replay = state.bookmarks.find((item) => item.owner_id === owner && item.idempotency_key === canonical.idempotency_key);
    if (replay) {
      if (canonicalDigest(replay) !== canonicalDigest(canonical)) {
        throw mediaBookmarkError("media bookmark idempotency collision", "idempotency_collision");
      }
      return clone(replay);
    }
    if (state.bookmarks.length >= MAX_BOOKMARKS) {
      throw mediaBookmarkError(`media bookmark capacity exceeded (${MAX_BOOKMARKS})`, "capacity");
    }
    const timestamp = validTimestamp(now(), "now");
    const bookmark = {
      id: requiredBookmarkId(randomId(), "generated bookmark id"),
      owner_id: owner,
      ...canonical,
      created_at: timestamp,
      updated_at: timestamp,
    };
    if (state.bookmarks.some((item) => item.id === bookmark.id)) {
      throw new Error("generated media bookmark id already exists");
    }
    state.bookmarks.push(bookmark);
    writeState(state);
    return clone(bookmark);
  }

  function list(ownerId, filter = {}) {
    const owner = requiredOwnerId(ownerId);
    const { videoId, surface, limit } = asValidation(() => ({
      videoId: optionalVideoId(filter.video_id || filter.videoId),
      surface: optionalText(filter.source_surface || filter.sourceSurface, 40, "source_surface"),
      limit: optionalLimit(filter.limit),
    }));
    return readState().bookmarks
      .filter((item) => item.owner_id === owner && (!videoId || item.video_id === videoId) && (!surface || item.source_surface === surface))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(clone);
  }

  function get(ownerId, id) {
    const owner = requiredOwnerId(ownerId);
    const safeId = asValidation(() => requiredBookmarkId(id));
    const bookmark = readState().bookmarks.find((item) => item.owner_id === owner && item.id === safeId);
    return bookmark ? clone(bookmark) : null;
  }

  function remove(ownerId, id) {
    const owner = requiredOwnerId(ownerId);
    const safeId = asValidation(() => requiredBookmarkId(id));
    const state = readState();
    const index = state.bookmarks.findIndex((item) => item.owner_id === owner && item.id === safeId);
    if (index < 0) return null;
    const [bookmark] = state.bookmarks.splice(index, 1);
    writeState(state);
    return clone(bookmark);
  }

  function resolve(ownerId, query, options = {}) {
    const owner = requiredOwnerId(ownerId);
    const { normalizedQuery, videoId } = asValidation(() => ({
      normalizedQuery: normalizeAlias(requiredText(query, 160, "bookmark query")),
      videoId: optionalVideoId(options.video_id || options.videoId),
    }));
    if (!normalizedQuery) throw mediaBookmarkError("bookmark query has no searchable tokens", "validation");
    const candidates = readState().bookmarks.filter((item) => item.owner_id === owner && (!videoId || item.video_id === videoId));
    const ranked = candidates.map((bookmark) => rankBookmark(bookmark, normalizedQuery))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.bookmark.updated_at.localeCompare(a.bookmark.updated_at) || a.bookmark.id.localeCompare(b.bookmark.id));
    if (!ranked.length) return { status: "not_found", candidates: [] };
    const top = ranked.filter((item) => item.score === ranked[0].score);
    if (top.length > 1) {
      return { status: "ambiguous", match_type: top[0].match_type, candidates: top.map((item) => clone(item.bookmark)) };
    }
    return { status: "matched", match_type: top[0].match_type, bookmark: clone(top[0].bookmark) };
  }

  return Object.freeze({ filePath, save, list, get, remove, resolve });
}

function canonicalInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("media bookmark input is required");
  if (input.user_approved !== true && input.userApproved !== true) {
    throw new Error("media bookmark requires explicit user approval");
  }
  if (input.provider != null && input.provider !== "youtube") {
    throw new Error("provider must be youtube");
  }
  const videoId = requiredVideoId(input.video_id || input.videoId);
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const suppliedUrl = optionalText(input.canonical_url || input.canonicalUrl, 2048, "canonical_url");
  if (suppliedUrl && suppliedUrl !== canonicalUrl) throw new Error("canonical_url must match video_id");
  const position = input.position_ms ?? input.positionMs;
  if (!Number.isSafeInteger(position) || position < 0 || position > MAX_POSITION_MS) {
    throw new Error(`position_ms must be an integer from 0 to ${MAX_POSITION_MS}`);
  }
  return {
    provider: "youtube",
    video_id: videoId,
    canonical_url: canonicalUrl,
    position_ms: position,
    label: requiredText(input.label, 120, "label"),
    title: optionalText(input.title, 240, "title"),
    note: optionalText(input.note, 1000, "note"),
    aliases: canonicalAliases(input.aliases, input.label),
    source_surface: requiredSurface(input.source_surface || input.sourceSurface),
    idempotency_key: requiredIdempotencyKey(input.idempotency_key ?? input.idempotencyKey),
    user_approved: true,
  };
}

function rankBookmark(bookmark, query) {
  const aliases = [bookmark.label, ...(bookmark.aliases || [])].map(normalizeAlias).filter(Boolean);
  if (aliases.includes(query)) return { bookmark, score: 3000, match_type: "exact_alias" };
  const phrase = aliases.some((alias) => alias.includes(query) || query.includes(alias));
  if (phrase) return { bookmark, score: 2000, match_type: "phrase" };
  const queryTokens = new Set(tokens(query));
  let overlap = 0;
  for (const alias of aliases) {
    const aliasTokens = new Set(tokens(alias));
    const shared = [...queryTokens].filter((token) => aliasTokens.has(token)).length;
    const score = shared ? Math.round((shared / Math.max(queryTokens.size, aliasTokens.size)) * 1000) : 0;
    overlap = Math.max(overlap, score);
  }
  return { bookmark, score: overlap, match_type: "token_overlap" };
}

function canonicalAliases(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error("aliases must be an array with at most 12 entries");
  const labelKey = normalizeAlias(label);
  const seen = new Set();
  const aliases = [];
  for (const raw of value) {
    const alias = requiredText(raw, 120, "alias");
    const key = normalizeAlias(alias);
    if (!key) throw new Error("alias has no searchable tokens");
    if (key !== labelKey && !seen.has(key)) {
      seen.add(key);
      aliases.push(alias);
    }
  }
  return aliases;
}

function canonicalDigest(value) {
  return JSON.stringify({
    provider: value.provider,
    video_id: value.video_id,
    canonical_url: value.canonical_url,
    position_ms: value.position_ms,
    label: value.label,
    title: value.title,
    note: value.note,
    aliases: value.aliases,
    source_surface: value.source_surface,
    idempotency_key: value.idempotency_key,
    user_approved: value.user_approved,
  });
}

function requiredVideoId(value) {
  if (typeof value !== "string" || !VIDEO_ID.test(value)) {
    throw new Error("video_id must be an exact 11-character YouTube video id");
  }
  return value;
}

function requiredBookmarkId(value, name = "bookmark id") {
  if (typeof value !== "string" || !BOOKMARK_ID.test(value)) throw new Error(`${name} has an invalid format`);
  return value;
}

function requiredIdempotencyKey(value) {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw new Error("idempotency_key must match [A-Za-z0-9_-]{1,200}");
  }
  return value;
}

function requiredOwnerId(value) {
  return requiredText(value, 120, "owner_id");
}

function mediaBookmarkError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function asValidation(run) {
  try { return run(); }
  catch (error) {
    if (!error.code) error.code = "validation";
    throw error;
  }
}

function optionalVideoId(value) {
  if (value == null || value === "") return "";
  return requiredVideoId(value);
}

function requiredSurface(value) {
  const surface = requiredText(value, 40, "source_surface").toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(surface)) throw new Error("source_surface has an invalid format");
  return surface;
}

function requiredText(value, max, name) {
  if (typeof value !== "string") throw new Error(`${name} is required`);
  const text = value.trim().replace(/\s+/gu, " ");
  if (!text) throw new Error(`${name} is required`);
  if (text.length > max) throw new Error(`${name} exceeds max length ${max}`);
  return text;
}

function optionalText(value, max, name) {
  if (value == null || value === "") return "";
  return requiredText(value, max, name);
}

function optionalLimit(value) {
  if (value == null || value === "") return 100;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer from 1 to 500");
  return limit;
}

function normalizeAlias(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function tokens(value) {
  return normalizeAlias(value).split(" ").filter(Boolean);
}

function validTimestamp(value, name) {
  const timestamp = requiredText(value, 40, name);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${name} must return an ISO timestamp`);
  return timestamp;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { createMediaBookmarkStore, normalizeAlias };
