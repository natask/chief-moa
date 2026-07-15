"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STORE_SCHEMA = "moa.video-evidence-store.v1";
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 5_000;
const MAX_CLAIMS_PER_KIND = 5_000;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function createEmptyState() {
  return {
    schema: STORE_SCHEMA,
    revision: 0,
    records: {},
    asset_claims: { evidence_id: {}, blob_ref: {}, sha256: {} },
  };
}

function createMemoryVideoEvidenceAdapter(initialState) {
  let state = normalizeState(initialState || createEmptyState());
  return {
    kind: "memory_untrusted_test_only",
    read() { return clone(state); },
    transact(mutator, options = {}) {
      assertMutator(mutator);
      assertExpectedRevision(state, options.expected_revision);
      const draft = clone(state);
      const result = mutator(draft);
      state = commitState(state, draft);
      return clone(result);
    },
  };
}

function createFileVideoEvidenceAdapter(options = {}) {
  const stateFile = path.resolve(requiredPath(options.stateFile));
  const lockDir = `${stateFile}.lock`;
  const lockTimeoutMs = boundedInteger(options.lockTimeoutMs, 5_000, 100, 60_000);
  const lockRetryMs = boundedInteger(options.lockRetryMs, 10, 1, 1_000);
  const staleLockMs = boundedInteger(options.staleLockMs, 30_000, 1_000, 300_000);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  return {
    kind: "atomic_json_file",
    stateFile,
    read() {
      return withLock(() => clone(readStateFile(stateFile)));
    },
    transact(mutator, transactionOptions = {}) {
      assertMutator(mutator);
      return withLock(() => {
        const current = readStateFile(stateFile);
        assertExpectedRevision(current, transactionOptions.expected_revision);
        const draft = clone(current);
        const result = mutator(draft);
        const next = commitState(current, draft);
        if (next.revision !== current.revision) writeStateFile(stateFile, next);
        return clone(result);
      });
    },
  };

  function withLock(fn) {
    const owner = acquireLock(lockDir, { lockTimeoutMs, lockRetryMs, staleLockMs });
    try {
      return fn();
    } finally {
      releaseLock(lockDir, owner);
    }
  }
}

function commitState(current, draft) {
  const normalized = normalizeState({ ...draft, revision: current.revision });
  if (canonical(normalized) === canonical(current)) return current;
  normalized.revision = current.revision + 1;
  return normalizeState(normalized);
}

function normalizeState(value) {
  if (!plainObject(value) || value.schema !== STORE_SCHEMA) throw storeError("VIDEO_EVIDENCE_STORE_CORRUPT", "invalid video evidence store schema");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw storeError("VIDEO_EVIDENCE_STORE_CORRUPT", "invalid store revision");
  const records = boundedObject(value.records, "records", MAX_RECORDS);
  const rawClaims = plainObject(value.asset_claims) ? value.asset_claims : null;
  if (!rawClaims) throw storeError("VIDEO_EVIDENCE_STORE_CORRUPT", "asset claims are required");
  const assetClaims = {};
  for (const key of ["evidence_id", "blob_ref", "sha256"]) {
    assetClaims[key] = boundedObject(rawClaims[key], `asset_claims.${key}`, MAX_CLAIMS_PER_KIND);
  }
  assertClaimGraph(records, assetClaims);
  return clone({ schema: STORE_SCHEMA, revision: value.revision, records, asset_claims: assetClaims });
}

function assertClaimGraph(records, actualClaims) {
  const expected = { evidence_id: {}, blob_ref: {}, sha256: {} };
  for (const [recordKey, record] of Object.entries(records)) {
    if (!plainObject(record) || record.request_id !== recordKey || !plainObject(record.turn)) {
      throw storeError("VIDEO_EVIDENCE_STORE_SEMANTIC_CORRUPT", `record ${recordKey} has invalid identity`);
    }
    const owner = {
      request_id: recordKey,
      turn_id: requiredStoredText(record.turn.turn_id, `${recordKey}.turn_id`),
      session_id: requiredStoredText(record.turn.session_id, `${recordKey}.session_id`),
    };
    const evidence = record.evidence;
    const evidenceRequired = ["uploaded", "attached", "processed", "deleted"].includes(record.status);
    if (!evidence) {
      if (evidenceRequired) throw storeError("VIDEO_EVIDENCE_STORE_SEMANTIC_CORRUPT", `record ${recordKey} lost required evidence`);
      continue;
    }
    if (!plainObject(evidence)) throw storeError("VIDEO_EVIDENCE_STORE_SEMANTIC_CORRUPT", `record ${recordKey} evidence is invalid`);
    const receipts = Array.isArray(record.receipts) ? record.receipts : [];
    if (!receipts.some((receipt) => receipt?.event === "uploaded")) {
      throw storeError("VIDEO_EVIDENCE_STORE_SEMANTIC_CORRUPT", `record ${recordKey} evidence lacks an upload receipt`);
    }
    const evidenceId = requiredStoredText(evidence.evidence_id, `${recordKey}.evidence_id`);
    const sha256 = requiredStoredText(evidence.sha256, `${recordKey}.sha256`);
    let blobRef;
    if (record.status === "deleted") {
      if (evidence.deleted !== true || evidence.blob_ref !== null || !plainObject(record.deletion)) {
        throw storeError("VIDEO_EVIDENCE_STORE_SEMANTIC_CORRUPT", `record ${recordKey} has an invalid deletion tombstone`);
      }
      blobRef = requiredStoredText(record.deletion.deleted_blob_ref, `${recordKey}.deleted_blob_ref`);
      requiredStoredText(record.deletion.blob_delete_receipt_ref, `${recordKey}.blob_delete_receipt_ref`);
      if (receipts.at(-1)?.event !== "deleted") {
        throw storeError("VIDEO_EVIDENCE_STORE_SEMANTIC_CORRUPT", `record ${recordKey} deletion receipt continuity is broken`);
      }
    } else {
      if (evidence.deleted === true) throw storeError("VIDEO_EVIDENCE_STORE_SEMANTIC_CORRUPT", `record ${recordKey} has an unexpected deletion tombstone`);
      blobRef = requiredStoredText(evidence.blob_ref, `${recordKey}.blob_ref`);
    }
    addExpectedClaim(expected.evidence_id, evidenceId, owner, "evidence_id");
    addExpectedClaim(expected.blob_ref, blobRef, owner, "blob_ref");
    addExpectedClaim(expected.sha256, sha256, owner, "sha256");
  }
  for (const key of ["evidence_id", "blob_ref", "sha256"]) {
    if (canonical(actualClaims[key]) !== canonical(expected[key])) {
      throw storeError("VIDEO_EVIDENCE_STORE_CLAIM_GRAPH_CORRUPT", `${key} claims do not exactly match persisted record ownership`);
    }
  }
}

function addExpectedClaim(index, identity, owner, kind) {
  const existing = index[identity];
  if (existing && canonical(existing) !== canonical(owner)) {
    throw storeError("VIDEO_EVIDENCE_STORE_CLAIM_CONFLICT", `${kind} is owned by conflicting records`);
  }
  index[identity] = owner;
}

function requiredStoredText(value, field) {
  const text = String(value || "").trim();
  if (!text || text.length > 240) throw storeError("VIDEO_EVIDENCE_STORE_SEMANTIC_CORRUPT", `${field} is invalid`);
  return text;
}

function boundedObject(value, field, maxEntries) {
  if (!plainObject(value)) throw storeError("VIDEO_EVIDENCE_STORE_CORRUPT", `${field} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > maxEntries) throw storeError("VIDEO_EVIDENCE_STORE_BOUNDED", `${field} exceeds its entry bound`);
  return Object.fromEntries(entries);
}

function readStateFile(filePath) {
  if (!fs.existsSync(filePath)) return createEmptyState();
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw storeError("VIDEO_EVIDENCE_STORE_UNSAFE", "state path must be a regular file");
  if (stat.size > MAX_STATE_BYTES) throw storeError("VIDEO_EVIDENCE_STORE_BOUNDED", "state file exceeds its byte bound");
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (cause) {
    const error = storeError("VIDEO_EVIDENCE_STORE_CORRUPT", "state file is not valid JSON");
    error.cause = cause;
    throw error;
  }
  return normalizeState(value);
}

function writeStateFile(filePath, state) {
  const serialized = `${JSON.stringify(normalizeState(state), null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw storeError("VIDEO_EVIDENCE_STORE_BOUNDED", "state exceeds its byte bound");
  const temp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0);
  const handle = fs.openSync(temp, flags, 0o600);
  try {
    fs.writeFileSync(handle, serialized);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temp, filePath);
  const dirHandle = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
  try { fs.fsyncSync(dirHandle); } finally { fs.closeSync(dirHandle); }
}

function acquireLock(lockDir, options) {
  const deadline = Date.now() + options.lockTimeoutMs;
  while (Date.now() <= deadline) {
    const owner = { pid: process.pid, nonce: crypto.randomUUID(), created_at: new Date().toISOString() };
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      return owner;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
        throw error;
      }
    }
    reclaimDeadLock(lockDir, options.staleLockMs);
    Atomics.wait(WAIT_BUFFER, 0, 0, options.lockRetryMs);
  }
  throw storeError("VIDEO_EVIDENCE_STORE_LOCK_TIMEOUT", "timed out acquiring video evidence store lock", 409);
}

function reclaimDeadLock(lockDir, staleLockMs) {
  let stat;
  try {
    stat = fs.statSync(lockDir);
  } catch {
    return false;
  }
  let owner = {};
  try { owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")); } catch {}
  if (Date.now() - stat.mtimeMs < staleLockMs || pidAlive(owner.pid)) return false;
  const tombstone = `${lockDir}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockDir, tombstone);
    fs.rmSync(tombstone, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockDir, owner) {
  let current;
  try { current = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")); } catch { return; }
  if (current.nonce !== owner.nonce || current.pid !== owner.pid) return;
  const tombstone = `${lockDir}.released-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockDir, tombstone);
    fs.rmSync(tombstone, { recursive: true, force: true });
  } catch {}
}

function pidAlive(value) {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function assertExpectedRevision(state, expected) {
  if (expected == null) return;
  if (!Number.isSafeInteger(expected) || expected < 0) throw storeError("VIDEO_EVIDENCE_STORE_INVALID_CAS", "expected revision is invalid");
  if (expected !== state.revision) throw storeError("VIDEO_EVIDENCE_STORE_CAS_CONFLICT", `expected store revision ${expected}, found ${state.revision}`, 409);
}

function assertMutator(value) {
  if (typeof value !== "function") throw new TypeError("video evidence adapter transact requires a function");
}
function requiredPath(value) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError("stateFile is required");
  return text;
}
function boundedInteger(value, fallback, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function clone(value) { return value == null ? value : structuredClone(value); }
function storeError(code, message, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  MAX_CLAIMS_PER_KIND,
  MAX_RECORDS,
  MAX_STATE_BYTES,
  STORE_SCHEMA,
  createEmptyState,
  createFileVideoEvidenceAdapter,
  createMemoryVideoEvidenceAdapter,
};
