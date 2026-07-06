"use strict";

// Thread store: durable per-session branch metadata, the active-thread pointer,
// and rolling per-thread summaries.
//
// A "thread" is a branch inside the one shared session (ARCHITECTURE.md: threads
// inside the shared session are separated by `branch`). This store adds the
// lifecycle metadata the turn ledgers do not carry:
//   - kind: default | new | fork | incognito
//   - label: a short human name for the thread
//   - parent_branch_id + fork_point: a fork branches off its parent and inherits
//     the parent's history up to the fork point, with no data copy
//   - the active thread per surface, so every device resolves the same thread
//   - a rolling summary of the thread for semantic recall
//
// Storage is plain JSON files under DATA_DIR, matching the gateway's other
// file-backed stores. Reads are fail-soft: a missing or corrupt file yields an
// empty/default result and never throws, so a thread-metadata miss can never
// break a turn. Incognito threads are ephemeral by construction: they are never
// written here.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const INCOGNITO_PREFIX = "inc-";
const FORK_PREFIX = "fork-";
const NEW_PREFIX = "thr-";
const THREAD_KINDS = new Set(["default", "new", "fork", "incognito"]);

function sanitizeId(value, fallback = "default") {
  const safe = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return safe || fallback;
}

// The branch id an incognito turn rides on. Ephemeral by construction: nothing
// is persisted for it, so the id is only ever used within the request.
function isIncognitoBranch(branchId) {
  return String(branchId || "").startsWith(INCOGNITO_PREFIX);
}

function newBranchId(kind) {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  if (kind === "incognito") return `${INCOGNITO_PREFIX}${rand}`;
  if (kind === "fork") return `${FORK_PREFIX}${rand}`;
  return `${NEW_PREFIX}${rand}`;
}

function createThreadStore(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, "..", "data");
  const threadsDir = path.join(dataDir, "threads");
  const activeDir = path.join(dataDir, "thread-active");
  const summariesDir = path.join(dataDir, "thread-summaries");

  function sessionThreadsDir(sessionId) {
    return path.join(threadsDir, sanitizeId(sessionId));
  }

  function threadPath(sessionId, branchId) {
    return path.join(sessionThreadsDir(sessionId), `${sanitizeId(branchId)}.json`);
  }

  function activePath(sessionId) {
    return path.join(activeDir, `${sanitizeId(sessionId)}.json`);
  }

  function summaryPath(sessionId, branchId) {
    return path.join(summariesDir, sanitizeId(sessionId), `${sanitizeId(branchId)}.json`);
  }

  function readJson(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  function writeJsonAtomic(filePath, record) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  function getThread(sessionId, branchId) {
    return readJson(threadPath(sessionId, branchId));
  }

  // Create the branch metadata if missing, or merge provided fields into it.
  // Incognito branches are ephemeral and never written. parent_branch_id and
  // fork_point are set once (on fork creation) and never overwritten by a later
  // continue, so a fork keeps its lineage. Best-effort: a write failure is
  // swallowed and the in-memory record is returned so a turn never fails.
  function ensureThread(sessionId, branchId, meta = {}) {
    const safeSession = sanitizeId(sessionId);
    const safeBranch = sanitizeId(branchId);
    if (isIncognitoBranch(safeBranch)) {
      return {
        session_id: safeSession,
        branch_id: safeBranch,
        kind: "incognito",
        label: String(meta.label || "Incognito"),
        parent_branch_id: String(meta.parent_branch_id || ""),
        fork_point: meta.fork_point || null,
        ephemeral: true,
      };
    }
    const now = new Date().toISOString();
    const existing = getThread(safeSession, safeBranch);
    const kind = existing?.kind && THREAD_KINDS.has(existing.kind)
      ? existing.kind
      : (THREAD_KINDS.has(meta.kind) ? meta.kind : (safeBranch === "default" ? "default" : "new"));
    const record = {
      session_id: safeSession,
      branch_id: safeBranch,
      kind,
      label: String(meta.label || existing?.label || defaultLabel(safeBranch, kind)),
      parent_branch_id: String(existing?.parent_branch_id || meta.parent_branch_id || ""),
      fork_point: existing?.fork_point || meta.fork_point || null,
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    try {
      writeJsonAtomic(threadPath(safeSession, safeBranch), record);
    } catch {
      // Best-effort: metadata is a convenience layer over the turn ledgers.
    }
    return record;
  }

  function touchThread(sessionId, branchId) {
    const safeBranch = sanitizeId(branchId);
    if (isIncognitoBranch(safeBranch)) return null;
    const existing = getThread(sessionId, safeBranch);
    if (!existing) return ensureThread(sessionId, safeBranch);
    existing.updated_at = new Date().toISOString();
    try {
      writeJsonAtomic(threadPath(sessionId, safeBranch), existing);
    } catch {
      // Best-effort.
    }
    return existing;
  }

  function listThreads(sessionId) {
    const dir = sessionThreadsDir(sessionId);
    if (!fs.existsSync(dir)) return [];
    const records = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const record = readJson(path.join(dir, name));
      if (record && record.branch_id) records.push(record);
    }
    return records.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  }

  // Record the active thread for a session. Writes both a global pointer and a
  // per-surface pointer so a phone and a browser can each track where they are
  // while still sharing the same underlying threads. Returns the active state.
  function recordSwitch(sessionId, input = {}) {
    const safeSession = sanitizeId(sessionId);
    const branchId = sanitizeId(input.branch_id || input.branchId, "default");
    const surface = String(input.surface || "").slice(0, 60);
    const deviceId = String(input.device_id || input.deviceId || "").slice(0, 120);
    const turnId = String(input.turn_id || input.turnId || "").slice(0, 120);
    const at = String(input.at || new Date().toISOString());
    const state = readActive(safeSession);
    const pointer = { branch_id: branchId, surface, device_id: deviceId, turn_id: turnId, at };
    state.active = pointer;
    if (surface) {
      state.surfaces = state.surfaces && typeof state.surfaces === "object" ? state.surfaces : {};
      state.surfaces[surface] = pointer;
    }
    state.session_id = safeSession;
    state.updated_at = at;
    try {
      writeJsonAtomic(activePath(safeSession), state);
    } catch {
      // Best-effort.
    }
    return state;
  }

  function readActive(sessionId) {
    const record = readJson(activePath(sessionId));
    if (record && typeof record === "object") {
      return record;
    }
    return { session_id: sanitizeId(sessionId), active: null, surfaces: {}, updated_at: "" };
  }

  // Resolve the active thread. A surface-scoped lookup falls back to the global
  // active pointer, which falls back to the default branch.
  function getActive(sessionId, surface = "") {
    const state = readActive(sessionId);
    const key = String(surface || "").slice(0, 60);
    if (key && state.surfaces && state.surfaces[key]) {
      return state.surfaces[key];
    }
    if (state.active) {
      return state.active;
    }
    return { branch_id: "default", surface: key, device_id: "", turn_id: "", at: "" };
  }

  function readSummary(sessionId, branchId) {
    return readJson(summaryPath(sessionId, branchId));
  }

  // Store a rolling summary for a thread. Incognito threads are never summarized.
  function writeSummary(sessionId, branchId, summary, meta = {}) {
    const safeBranch = sanitizeId(branchId);
    if (isIncognitoBranch(safeBranch)) return null;
    const now = new Date().toISOString();
    const record = {
      session_id: sanitizeId(sessionId),
      branch_id: safeBranch,
      summary: String(summary || "").slice(0, 8000),
      turn_count: Number(meta.turn_count) || 0,
      last_turn_id: String(meta.last_turn_id || ""),
      source: String(meta.source || "model"),
      updated_at: now,
    };
    try {
      writeJsonAtomic(summaryPath(sessionId, safeBranch), record);
    } catch {
      return null;
    }
    return record;
  }

  return {
    dataDir,
    ensureThread,
    touchThread,
    getThread,
    listThreads,
    recordSwitch,
    getActive,
    readActive,
    readSummary,
    writeSummary,
    newBranchId,
    isIncognitoBranch,
    paths: { threadsDir, activeDir, summariesDir },
  };
}

function defaultLabel(branchId, kind) {
  if (branchId === "default") return "Main thread";
  if (kind === "fork") return "Forked thread";
  if (kind === "new") return "New thread";
  return branchId;
}

module.exports = {
  createThreadStore,
  isIncognitoBranch,
  newBranchId,
  INCOGNITO_PREFIX,
  FORK_PREFIX,
  NEW_PREFIX,
  THREAD_KINDS,
};
