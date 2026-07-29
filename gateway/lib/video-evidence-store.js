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
    const lifecycle = deriveVideoEvidenceRecordLifecycle(recordKey, record);
    const owner = {
      request_id: recordKey,
      turn_id: requiredStoredText(record.turn.turn_id, `${recordKey}.turn_id`),
      session_id: requiredStoredText(record.turn.session_id, `${recordKey}.session_id`),
    };
    const evidence = lifecycle.evidence;
    if (!evidence) continue;
    const evidenceId = requiredStoredText(evidence.evidence_id, `${recordKey}.evidence_id`);
    const sha256 = requiredStoredText(evidence.sha256, `${recordKey}.sha256`);
    const blobRef = lifecycle.status === "deleted"
      ? requiredStoredText(lifecycle.deletion.deleted_blob_ref, `${recordKey}.deleted_blob_ref`)
      : requiredStoredText(evidence.blob_ref, `${recordKey}.blob_ref`);
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

function deriveVideoEvidenceRecordLifecycle(recordKey, record) {
  if (!plainObject(record) || record.request_id !== recordKey || !plainObject(record.turn)) {
    throw storeError("VIDEO_EVIDENCE_STORE_LIFECYCLE_CORRUPT", `record ${recordKey} has invalid identity`);
  }
  requiredStoredText(record.turn.turn_id, `${recordKey}.turn_id`);
  requiredStoredText(record.turn.session_id, `${recordKey}.session_id`);
  requiredStoredText(record.turn.surface_id, `${recordKey}.surface_id`);
  const createdAt = requiredIso(record.created_at, `${recordKey}.created_at`);
  if (!Array.isArray(record.receipts)) throw storeError("VIDEO_EVIDENCE_STORE_LIFECYCLE_CORRUPT", `record ${recordKey} receipts are invalid`);
  const derived = {
    status: "proposed",
    version: 1,
    updated_at: createdAt,
    capture: null,
    evidence: null,
    attached_at: null,
    processing: null,
    failure: null,
    deletion: null,
  };
  const receiptIds = new Set();
  for (const receipt of record.receipts) {
    if (!plainObject(receipt)) throw lifecycleError(recordKey, "receipt is invalid");
    const receiptId = requiredStoredText(receipt.receipt_id, `${recordKey}.receipt_id`);
    if (receiptIds.has(receiptId)) throw lifecycleError(recordKey, "receipt identity was replayed in history");
    receiptIds.add(receiptId);
    const event = requiredStoredText(receipt.event, `${recordKey}.receipt.event`);
    const at = requiredIso(receipt.at, `${recordKey}.${event}.at`);
    if (Date.parse(at) < Date.parse(derived.updated_at)) throw lifecycleError(recordKey, "receipt timestamps are reordered");
    assertLifecycleTransition(recordKey, derived.status, event, Boolean(derived.evidence));
    applyLifecycleReceipt(recordKey, record, derived, receipt, event, at);
    derived.status = event;
    derived.version += 1;
    derived.updated_at = at;
  }
  if (record.status !== derived.status || record.version !== derived.version || record.updated_at !== derived.updated_at) {
    throw lifecycleError(recordKey, "status, version, or updated_at differs from receipt replay");
  }
  for (const field of ["capture", "evidence", "attached_at", "processing", "failure", "deletion"]) {
    if (canonical(record[field] ?? null) !== canonical(derived[field])) {
      throw lifecycleError(recordKey, `${field} differs from receipt replay`);
    }
  }
  assertIdempotencyProjection(recordKey, record.idempotency, record.receipts);
  return clone(derived);
}

function assertLifecycleTransition(recordKey, from, event, hasEvidence) {
  const allowed = {
    proposed: ["user_started", "failed"],
    user_started: ["captured", "failed"],
    captured: ["uploaded", "failed"],
    uploaded: ["attached", "failed", "deleted"],
    attached: ["processed", "failed", "deleted"],
    processed: ["deleted"],
    failed: hasEvidence ? ["deleted"] : [],
    deleted: [],
  };
  if (!allowed[from]?.includes(event)) throw lifecycleError(recordKey, `impossible ${from} -> ${event} receipt sequence`);
}

function applyLifecycleReceipt(recordKey, record, derived, receipt, event, at) {
  if (["user_started", "captured", "uploaded", "attached", "deleted"].includes(event)) {
    assertSurfaceReceiptProjection(recordKey, record, receipt);
  }
  if (event === "captured") derived.capture = requiredSnapshot(receipt.capture, recordKey, "capture");
  if (event === "uploaded") {
    const evidence = requiredSnapshot(receipt.evidence, recordKey, "evidence");
    if (!derived.capture
      || evidence.subject !== derived.capture.capture_scope
      || evidence.duration_seconds !== derived.capture.duration_seconds
      || evidence.has_audio !== derived.capture.has_audio) {
      throw lifecycleError(recordKey, "uploaded evidence differs from captured receipt");
    }
    derived.evidence = evidence;
  }
  if (event === "attached") {
    const binding = requiredSnapshot(receipt.attachment_binding, recordKey, "attachment_binding");
    assertAttachmentProjection(recordKey, record, derived.evidence, binding);
    if (receipt.attached_at !== at) throw lifecycleError(recordKey, "attached timestamp differs from receipt");
    derived.attached_at = receipt.attached_at;
  }
  if (event === "processed") {
    if (receipt.authority_verifier_accepted !== true) throw lifecycleError(recordKey, "provider verifier acceptance is missing");
    const provider = requiredSnapshot(receipt.provider_binding, recordKey, "provider_binding");
    assertProviderProjection(recordKey, record, derived.evidence, provider);
    const processing = requiredSnapshot(receipt.processing, recordKey, "processing");
    if (processing.provider_receipt_ref !== provider.receipt_ref
      || processing.provider !== provider.provider
      || processing.model !== provider.model
      || processing.evidence_id !== derived.evidence?.evidence_id
      || processing.evidence_sha256 !== derived.evidence?.sha256
      || processing.processed_at !== at) {
      throw lifecycleError(recordKey, "processing fields differ from provider receipt binding");
    }
    derived.processing = processing;
  }
  if (event === "failed") {
    const failure = requiredSnapshot(receipt.failure, recordKey, "failure");
    if (failure.failed_at !== at) throw lifecycleError(recordKey, "failure timestamp differs from receipt");
    derived.failure = failure;
  }
  if (event === "deleted") {
    if (!derived.evidence || receipt.blob_authority_verifier_accepted !== true) throw lifecycleError(recordKey, "deletion authority or evidence is missing");
    const blob = requiredSnapshot(receipt.blob_delete_binding, recordKey, "blob_delete_binding");
    const deletion = requiredSnapshot(receipt.deletion, recordKey, "deletion");
    const tombstone = requiredSnapshot(receipt.deleted_evidence, recordKey, "deleted_evidence");
    if (blob.evidence_id !== derived.evidence.evidence_id
      || blob.blob_ref !== derived.evidence.blob_ref
      || blob.sha256 !== derived.evidence.sha256
      || blob.deleted !== true
      || deletion.deleted_blob_ref !== blob.blob_ref
      || deletion.blob_delete_receipt_ref !== blob.receipt_ref
      || deletion.deleted_at !== at
      || tombstone.evidence_id !== derived.evidence.evidence_id
      || tombstone.sha256 !== derived.evidence.sha256
      || tombstone.blob_ref !== null
      || tombstone.deleted !== true) {
      throw lifecycleError(recordKey, "deletion fields differ from blob receipt binding");
    }
    derived.evidence = tombstone;
    derived.deletion = deletion;
  }
}

function assertSurfaceReceiptProjection(recordKey, record, receipt) {
  if (receipt.assertion_kind !== "surface_user_action" || receipt.authority_verifier_accepted !== true) {
    throw lifecycleError(recordKey, "Surface verifier acceptance is missing");
  }
  const expected = {
    request_id: recordKey,
    turn_id: record.turn.turn_id,
    session_id: record.turn.session_id,
    surface_id: record.turn.surface_id,
  };
  assertExactProjection(recordKey, receipt.turn_binding, expected, "Surface turn binding");
}

function assertAttachmentProjection(recordKey, record, evidence, binding) {
  if (!evidence) throw lifecycleError(recordKey, "attachment lacks uploaded evidence");
  const expected = {
    turn_id: record.turn.turn_id,
    session_id: record.turn.session_id,
    branch: record.turn.branch,
    role: record.turn.role,
    original_query: record.turn.original_query,
    query_revision: record.turn.query_revision,
    source: record.turn.source,
    surface_id: record.turn.surface_id,
    delegation_envelope_id: record.turn.delegation_envelope_id,
    capability_snapshot_id: record.capability_snapshot?.id,
    capability_snapshot_digest: record.capability_snapshot?.digest,
    provider: record.provider_support?.provider,
    provider_model: record.provider_support?.model,
    provider_direct_video_input: record.provider_support?.direct_video_input,
    provider_posture_digest: record.provider_support?.posture_digest,
    evidence_id: evidence.evidence_id,
    blob_ref: evidence.blob_ref,
    evidence_sha256: evidence.sha256,
  };
  assertExactProjection(recordKey, binding, expected, "attachment binding");
}

function assertProviderProjection(recordKey, record, evidence, binding) {
  if (!evidence) throw lifecycleError(recordKey, "provider processing lacks attached evidence");
  const expected = {
    assertion_kind: "provider_processing",
    request_id: recordKey,
    turn_id: record.turn.turn_id,
    session_id: record.turn.session_id,
    evidence_id: evidence.evidence_id,
    blob_ref: evidence.blob_ref,
    sha256: evidence.sha256,
    provider: record.provider_support?.provider,
    model: record.provider_support?.model,
    direct_video_input: record.provider_support?.direct_video_input,
    direct_video_received: true,
    capability_snapshot_id: record.capability_snapshot?.id,
    capability_snapshot_digest: record.capability_snapshot?.digest,
    provider_posture_digest: record.provider_support?.posture_digest,
  };
  assertExactProjection(recordKey, binding, expected, "provider binding");
  requiredStoredText(binding.receipt_ref, `${recordKey}.provider_receipt_ref`);
}

function assertExactProjection(recordKey, actual, expected, label) {
  if (!plainObject(actual)) throw lifecycleError(recordKey, `${label} is missing`);
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw lifecycleError(recordKey, `${label} ${key} differs from the record envelope`);
  }
}

function assertIdempotencyProjection(recordKey, idempotency, receipts) {
  if (!plainObject(idempotency)) throw lifecycleError(recordKey, "idempotency projection is invalid");
  const expectedIds = receipts.map((receipt) => receipt.receipt_id).sort();
  if (canonical(Object.keys(idempotency).sort()) !== canonical(expectedIds)) {
    throw lifecycleError(recordKey, "idempotency projection differs from receipt identities");
  }
  for (const receipt of receipts) {
    const entry = idempotency[receipt.receipt_id];
    if (!plainObject(entry) || entry.target !== receipt.event || !String(entry.fingerprint || "").trim()) {
      throw lifecycleError(recordKey, "idempotency transition differs from receipt history");
    }
  }
}

function requiredSnapshot(value, recordKey, field) {
  if (!plainObject(value)) throw lifecycleError(recordKey, `${field} snapshot is missing`);
  return clone(value);
}

function requiredIso(value, field) {
  const text = String(value || "");
  if (!Number.isFinite(Date.parse(text))) throw storeError("VIDEO_EVIDENCE_STORE_LIFECYCLE_CORRUPT", `${field} is not a timestamp`);
  return new Date(text).toISOString();
}

function lifecycleError(recordKey, message) {
  return storeError("VIDEO_EVIDENCE_STORE_LIFECYCLE_CORRUPT", `record ${recordKey}: ${message}`);
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
