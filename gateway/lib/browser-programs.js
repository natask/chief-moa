"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROGRAM_SCHEMA = "moa.browser-program.v2";
const RECEIPT_SCHEMA = "moa.browser-program-receipt.v1";
const STORE_SCHEMA = "moa.browser-program-store.v1";
const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_PROGRAMS = 1_000;
const MAX_RECEIPTS = 10_000;
const MAX_RESULT_BYTES = 16 * 1024;
const ID = /^[a-z][a-z0-9._:-]{1,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MATCH = /^(https|http):\/\/([^/*]+|\*)\/(?:[^\s]*)$/;
const SECRET_KEY = /^(authorization|cookie|set-cookie|password|passwd|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret)$/i;
const SECRET_TEXT = /(authorization\s*[:=]\s*(?:bearer\s+)?\S+|(?:api[-_]?key|password|passwd|access[-_]?token|refresh[-_]?token|client[-_]?secret|cookie)\s*[:=]\s*\S+|\bsk-[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/gi;

class BrowserProgramValidationError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = "BrowserProgramValidationError";
    this.code = code;
    if (field) this.field = field;
  }
}

function createBrowserProgramStore(options = {}) {
  const adapter = options.adapter || createFileBrowserProgramAdapter(
    path.join(path.resolve(options.dataDir || "./data"), "browser-programs.json"),
  );

  function propose(input) {
    const artifact = validateBrowserProgram(input);
    const state = readState(adapter);
    const key = programKey(artifact.artifact_id, artifact.revision);
    const existing = state.programs[key];
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(artifact)) {
        fail("immutable_revision", "artifact_id and revision already name different program bytes", "revision");
      }
      return proposalResult(existing, true);
    }
    if (Object.keys(state.programs).length >= MAX_PROGRAMS) fail("store_full", "program store is full");
    validateRevisionLineage(artifact, state);
    state.programs[key] = artifact;
    adapter.write(state);
    return proposalResult(artifact, false);
  }

  function get(artifactId, revision) {
    const key = programKey(cleanId(artifactId, "artifact_id"), integer(revision, "revision", 1, Number.MAX_SAFE_INTEGER));
    const artifact = readState(adapter).programs[key];
    return artifact ? copy(artifact) : null;
  }

  function list(artifactId) {
    const id = artifactId == null ? null : cleanId(artifactId, "artifact_id");
    return Object.values(readState(adapter).programs)
      .filter((artifact) => id == null || artifact.artifact_id === id)
      .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id) || a.revision - b.revision)
      .map(copy);
  }

  function ingestReceipt(input) {
    const receipt = validateBrowserProgramReceipt(input);
    const state = readState(adapter);
    const artifact = state.programs[programKey(receipt.artifact_id, receipt.revision)];
    if (!artifact) fail("program_not_found", "receipt must bind an existing program revision", "revision");
    validateReceiptBinding(receipt, artifact);
    validateReceiptTransition(receipt, artifact, state);
    const existingById = state.receipts[receipt.receipt_id];
    const existingByKey = Object.values(state.receipts)
      .find((item) => item.idempotency_key === receipt.idempotency_key);
    const existing = existingById || existingByKey;
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(receipt)) {
        fail("receipt_replay_conflict", "receipt id or idempotency key was replayed with different content", "idempotency_key");
      }
      return receiptResult(existing, true);
    }
    if (Object.keys(state.receipts).length >= MAX_RECEIPTS) fail("store_full", "receipt store is full");
    state.receipts[receipt.receipt_id] = receipt;
    adapter.write(state);
    return receiptResult(receipt, false);
  }

  function listReceipts(artifactId, revision) {
    const id = cleanId(artifactId, "artifact_id");
    const rev = revision == null ? null : integer(revision, "revision", 1, Number.MAX_SAFE_INTEGER);
    return Object.values(readState(adapter).receipts)
      .filter((receipt) => receipt.artifact_id === id && (rev == null || receipt.revision === rev))
      .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.receipt_id.localeCompare(b.receipt_id))
      .map(copy);
  }

  return Object.freeze({ propose, get, list, ingestReceipt, listReceipts });
}

function validateBrowserProgram(input) {
  object(input, "program");
  closed(input, ["schema", "artifact_id", "revision", "source_turn_id", "name", "purpose", "source",
    "source_sha256", "mode", "world", "target", "timing", "effect", "authority", "bridge_capabilities",
    "limits", "rollback"], "program");
  exact(input.schema, PROGRAM_SCHEMA, "schema");
  const artifactId = cleanId(input.artifact_id, "artifact_id");
  const revision = integer(input.revision, "revision", 1, Number.MAX_SAFE_INTEGER);
  const source = canonicalizeSource(input.source);
  const sourceSha256 = sourceDigest(source);
  if (input.source_sha256 !== sourceSha256) fail("source_digest_mismatch", "source_sha256 does not match canonical source", "source_sha256");
  assertNoCredentials(source, "source");
  const mode = oneOf(input.mode, ["immediate", "persistent"], "mode");
  const world = oneOf(input.world, ["USER_SCRIPT", "MAIN"], "world");
  const target = validateTarget(input.target, mode);
  const timing = oneOf(input.timing, ["explicit", "document_start", "document_end", "document_idle"], "timing");
  validateTiming(mode, timing);
  const effect = validateEffect(input.effect);
  const authority = validateAuthority(input.authority, { mode, world, target, timing, effect });
  const bridgeCapabilities = validateBridges(input.bridge_capabilities, authority);
  const limits = validateLimits(input.limits);
  const rollback = validateRollback(input.rollback, revision);
  const artifact = {
    schema: PROGRAM_SCHEMA,
    artifact_id: artifactId,
    revision,
    source_turn_id: cleanId(input.source_turn_id, "source_turn_id"),
    name: boundedText(input.name, "name", 160),
    purpose: boundedText(input.purpose, "purpose", 2_000),
    source,
    source_sha256: sourceSha256,
    mode,
    world,
    target,
    timing,
    effect,
    authority,
    bridge_capabilities: bridgeCapabilities,
    limits,
    rollback,
  };
  if (authority.profile === "reviewed_standalone_v1") {
    if (authority.standalone.approved_source_sha256 !== sourceSha256) {
      fail("approval_binding_mismatch", "standalone approval does not bind this source", "authority.standalone.approved_source_sha256");
    }
    if (authority.standalone.approved_scope_digest !== scopeDigest(artifact)) {
      fail("approval_binding_mismatch", "standalone approval does not bind this scope", "authority.standalone.approved_scope_digest");
    }
  }
  return deepFreeze(artifact);
}

function validateTarget(input, mode) {
  object(input, "target");
  closed(input, ["tab_id", "document_id", "frame_scope", "origins", "matches", "excludes"], "target");
  const target = {
    tab_id: nullableInteger(input.tab_id, "target.tab_id", 0, 2_147_483_647),
    document_id: nullableId(input.document_id, "target.document_id"),
    frame_scope: oneOf(input.frame_scope, ["top", "all"], "target.frame_scope"),
    origins: uniqueSorted(input.origins, (value) => cleanOrigin(value, "target.origins"), "target.origins", 32),
    matches: uniqueSorted(input.matches, (value) => cleanMatch(value, "target.matches"), "target.matches", 64),
    excludes: uniqueSorted(input.excludes, (value) => cleanMatch(value, "target.excludes"), "target.excludes", 64),
  };
  if (!target.origins.length) fail("invalid_scope", "target.origins must not be empty", "target.origins");
  if (mode === "immediate" && (target.tab_id == null || target.document_id == null || target.matches.length || target.excludes.length)) {
    fail("invalid_scope", "immediate programs require tab/document and no match patterns", "target");
  }
  if (mode === "persistent" && (target.tab_id != null || target.document_id != null || !target.matches.length)) {
    fail("invalid_scope", "persistent programs require matches and no tab/document", "target");
  }
  if (target.matches.some((pattern) => !target.origins.includes(matchOrigin(pattern)))) {
    fail("invalid_scope", "every match must bind a declared exact origin", "target.matches");
  }
  if (target.excludes.some((pattern) => !target.matches.some((match) => sameMatchOrigin(pattern, match)))) {
    fail("invalid_scope", "every exclude must fall under a declared match host", "target.excludes");
  }
  return target;
}

function validateEffect(input) {
  object(input, "effect");
  closed(input, ["class", "operations"], "effect");
  const effectClass = oneOf(input.class, ["visual_modification", "browser_automation", "instrumentation", "destructive_site_action"], "effect.class");
  const operations = uniqueSorted(input.operations, (value) => oneOf(value,
    ["hide", "detach", "insert", "restyle", "draw", "navigate", "click", "type", "observe", "delete_application_data"],
    "effect.operations"), "effect.operations", 16);
  if (!operations.length) fail("invalid_effect", "effect.operations must not be empty", "effect.operations");
  const destructive = operations.includes("delete_application_data");
  if (destructive !== (effectClass === "destructive_site_action")) {
    fail("effect_class_mismatch", "application-data deletion must be classified as destructive_site_action", "effect.class");
  }
  return { class: effectClass, operations };
}

function validateAuthority(input, context) {
  const authority = validateAuthorityRecord(input);
  if (authority.profile === "reviewed_standalone_v1") {
    if (context.world !== "USER_SCRIPT" || context.target.frame_scope !== "top") {
      fail("invalid_standalone_authority", "standalone programs require top-frame USER_SCRIPT", "authority.profile");
    }
    if (context.effect.class === "destructive_site_action") {
      fail("invalid_standalone_authority", "standalone visual authority cannot approve destructive site actions", "effect.class");
    }
    if ((context.mode === "immediate" && context.timing !== "explicit")
      || (context.mode === "persistent" && context.timing !== "document_idle")) {
      fail("invalid_standalone_authority", "standalone timing must be explicit or document_idle for its mode", "timing");
    }
  }
  return authority;
}

function validateAuthorityRecord(input) {
  object(input, "authority");
  closed(input, ["profile", "standalone", "delegated"], "authority");
  const profile = oneOf(input.profile, ["reviewed_standalone_v1", "delegated_runtime_v1"], "authority.profile");
  if (profile === "reviewed_standalone_v1") {
    if (input.delegated != null) fail("mixed_authority", "standalone authority cannot contain delegated fields", "authority.delegated");
    object(input.standalone, "authority.standalone");
    closed(input.standalone, ["approval_id", "approved_source_sha256", "approved_scope_digest"], "authority.standalone");
    return {
      profile,
      standalone: {
        approval_id: cleanId(input.standalone.approval_id, "authority.standalone.approval_id"),
        approved_source_sha256: cleanSha(input.standalone.approved_source_sha256, "authority.standalone.approved_source_sha256"),
        approved_scope_digest: cleanSha(input.standalone.approved_scope_digest, "authority.standalone.approved_scope_digest"),
      },
    };
  }
  if (input.standalone != null) fail("mixed_authority", "delegated authority cannot contain standalone fields", "authority.standalone");
  object(input.delegated, "authority.delegated");
  closed(input.delegated, ["role", "task_id", "run_id", "delegation_envelope_id", "grant_ids", "checkpoint_approval_id"], "authority.delegated");
  exact(input.delegated.role, "delegate", "authority.delegated.role");
  const grantIds = uniqueSorted(input.delegated.grant_ids, (value) => cleanId(value, "authority.delegated.grant_ids"), "authority.delegated.grant_ids", 64);
  if (!grantIds.length) fail("invalid_delegated_authority", "delegated authority requires exact grants", "authority.delegated.grant_ids");
  return {
    profile,
    delegated: {
      role: "delegate",
      task_id: cleanId(input.delegated.task_id, "authority.delegated.task_id"),
      run_id: cleanId(input.delegated.run_id, "authority.delegated.run_id"),
      delegation_envelope_id: cleanId(input.delegated.delegation_envelope_id, "authority.delegated.delegation_envelope_id"),
      grant_ids: grantIds,
      checkpoint_approval_id: input.delegated.checkpoint_approval_id == null
        ? null
        : cleanId(input.delegated.checkpoint_approval_id, "authority.delegated.checkpoint_approval_id"),
    },
  };
}

function validateBridges(input, authority) {
  const bridges = array(input, "bridge_capabilities", 16).map((bridge, index) => {
    object(bridge, `bridge_capabilities.${index}`);
    closed(bridge, ["name", "grant_id"], `bridge_capabilities.${index}`);
    return { name: cleanId(bridge.name, `bridge_capabilities.${index}.name`), grant_id: cleanId(bridge.grant_id, `bridge_capabilities.${index}.grant_id`) };
  });
  const names = new Set();
  for (const bridge of bridges) {
    if (names.has(bridge.name)) fail("invalid_bridge", "bridge capability names must be unique", "bridge_capabilities");
    names.add(bridge.name);
    if (authority.profile === "reviewed_standalone_v1") fail("invalid_bridge", "standalone programs cannot request bridge capabilities", "bridge_capabilities");
    if (!authority.delegated.grant_ids.includes(bridge.grant_id)) fail("invalid_bridge", "bridge grant must be present in delegated grant_ids", "bridge_capabilities");
  }
  return bridges.sort((a, b) => a.name.localeCompare(b.name));
}

function validateLimits(input) {
  object(input, "limits");
  closed(input, ["timeout_ms", "max_result_bytes"], "limits");
  return {
    timeout_ms: integer(input.timeout_ms, "limits.timeout_ms", 50, 30_000),
    max_result_bytes: integer(input.max_result_bytes, "limits.max_result_bytes", 0, MAX_RESULT_BYTES),
  };
}

function validateRollback(input, revision) {
  object(input, "rollback");
  closed(input, ["prior_revision", "capability", "cleanup_entrypoint", "unavailable_reason"], "rollback");
  const priorRevision = nullableInteger(input.prior_revision, "rollback.prior_revision", 1, Number.MAX_SAFE_INTEGER);
  const capability = oneOf(input.capability, ["prior_revision", "cleanup_entrypoint", "unavailable"], "rollback.capability");
  const cleanup = nullableText(input.cleanup_entrypoint, "rollback.cleanup_entrypoint", 160);
  const reason = nullableText(input.unavailable_reason, "rollback.unavailable_reason", 500);
  if (priorRevision != null && priorRevision >= revision) fail("invalid_rollback", "prior_revision must be older", "rollback.prior_revision");
  if (revision === 1 && priorRevision != null) fail("invalid_rollback", "first revision cannot name a prior revision", "rollback.prior_revision");
  if (capability === "prior_revision" && priorRevision == null) fail("invalid_rollback", "prior_revision rollback requires prior_revision", "rollback.capability");
  if (capability === "cleanup_entrypoint" && !cleanup) fail("invalid_rollback", "cleanup rollback requires cleanup_entrypoint", "rollback.cleanup_entrypoint");
  if (capability === "unavailable" && !reason) fail("invalid_rollback", "unavailable rollback requires a reason", "rollback.unavailable_reason");
  if (capability !== "cleanup_entrypoint" && cleanup != null) fail("invalid_rollback", "cleanup_entrypoint is not applicable", "rollback.cleanup_entrypoint");
  if (capability !== "unavailable" && reason != null) fail("invalid_rollback", "unavailable_reason is not applicable", "rollback.unavailable_reason");
  return { prior_revision: priorRevision, capability, cleanup_entrypoint: cleanup, unavailable_reason: reason };
}

function validateBrowserProgramReceipt(input) {
  object(input, "receipt");
  closed(input, ["schema", "receipt_id", "idempotency_key", "operation", "status", "artifact_id", "revision",
    "source_sha256", "authority", "surface_id", "executor", "world", "target_digest", "before_evidence_refs",
    "after_evidence_refs", "result", "registration", "rollback", "recorded_at"], "receipt");
  exact(input.schema, RECEIPT_SCHEMA, "schema");
  const operation = oneOf(input.operation, ["proposal", "apply", "disable", "rollback"], "operation");
  const statuses = {
    proposal: ["proposed", "rejected"],
    apply: ["applied", "rejected", "failed"],
    disable: ["disabled", "rejected", "failed"],
    rollback: ["rolled_back", "rollback_unavailable", "rejected", "failed"],
  };
  return deepFreeze({
    schema: RECEIPT_SCHEMA,
    receipt_id: cleanId(input.receipt_id, "receipt_id"),
    idempotency_key: cleanId(input.idempotency_key, "idempotency_key"),
    operation,
    status: oneOf(input.status, statuses[operation], "status"),
    artifact_id: cleanId(input.artifact_id, "artifact_id"),
    revision: integer(input.revision, "revision", 1, Number.MAX_SAFE_INTEGER),
    source_sha256: cleanSha(input.source_sha256, "source_sha256"),
    authority: validateAuthorityRecord(input.authority),
    surface_id: cleanId(input.surface_id, "surface_id"),
    executor: oneOf(input.executor, ["none", "user_scripts_execute", "user_scripts_register", "cdp_runtime_evaluate"], "executor"),
    world: oneOf(input.world, ["USER_SCRIPT", "MAIN"], "world"),
    target_digest: cleanSha(input.target_digest, "target_digest"),
    before_evidence_refs: cleanRefs(input.before_evidence_refs, "before_evidence_refs"),
    after_evidence_refs: cleanRefs(input.after_evidence_refs, "after_evidence_refs"),
    result: cleanResult(input.result),
    registration: cleanRegistration(input.registration),
    rollback: cleanRollbackResult(input.rollback),
    recorded_at: cleanTimestamp(input.recorded_at, "recorded_at"),
  });
}

function validateReceiptBinding(receipt, artifact) {
  if (receipt.source_sha256 !== artifact.source_sha256
    || canonicalJson(receipt.authority) !== canonicalJson(artifact.authority)
    || receipt.world !== artifact.world
    || receipt.target_digest !== scopeDigest(artifact)) {
    fail("receipt_binding_mismatch", "receipt does not match the immutable program binding");
  }
  if (receipt.rollback.prior_revision !== artifact.rollback.prior_revision) {
    fail("receipt_binding_mismatch", "receipt does not bind the artifact prior revision", "rollback.prior_revision");
  }
  if (receipt.operation === "proposal" && receipt.executor !== "none") fail("non_executable_proposal", "proposal receipts cannot claim execution", "executor");
  if (receipt.operation !== "proposal" && receipt.status !== "rejected" && receipt.executor === "none") fail("invalid_executor", "effect receipts require an executor", "executor");
  if (artifact.authority.profile === "reviewed_standalone_v1" && receipt.executor === "cdp_runtime_evaluate") {
    fail("invalid_executor", "standalone programs cannot use CDP", "executor");
  }
  if (artifact.mode === "persistent" && receipt.operation !== "proposal" && receipt.status !== "rejected"
    && receipt.executor !== "user_scripts_register") {
    fail("invalid_executor", "persistent effects require the registration executor", "executor");
  }
  if (artifact.mode === "immediate" && receipt.registration.registration_id != null) {
    fail("invalid_registration", "immediate effects cannot claim a persistent registration", "registration.registration_id");
  }
  if (artifact.mode === "persistent" && receipt.operation === "apply" && receipt.status === "applied"
    && (!receipt.registration.registration_id || !receipt.registration.read_back_verified)) {
    fail("invalid_registration", "persistent apply requires exact registration read-back", "registration");
  }
  if (artifact.mode === "persistent" && receipt.operation === "disable" && receipt.status === "disabled"
    && !receipt.registration.removal_verified) {
    fail("invalid_registration", "persistent disable requires verified removal", "registration.removal_verified");
  }
}

function validateReceiptTransition(receipt, artifact, state) {
  const prior = Object.values(state.receipts).filter((item) => item.artifact_id === receipt.artifact_id && item.revision === receipt.revision);
  if (receipt.operation === "apply" && !prior.some((item) => item.operation === "proposal" && item.status === "proposed")) {
    fail("proposal_receipt_required", "apply requires a proposed receipt");
  }
  if (receipt.operation === "disable" && !prior.some((item) => item.operation === "apply" && item.status === "applied")) {
    fail("apply_receipt_required", "disable requires an applied receipt");
  }
  if (receipt.operation === "rollback") {
    if (!prior.some((item) => item.operation === "apply" && item.status === "applied")) fail("apply_receipt_required", "rollback requires an applied receipt");
    if (artifact.rollback.capability === "unavailable" && receipt.status !== "rollback_unavailable") {
      fail("rollback_unavailable", "artifact declares rollback unavailable", "status");
    }
    if (artifact.rollback.capability !== "unavailable" && receipt.status === "rollback_unavailable") {
      fail("invalid_rollback_status", "rollback is declared available", "status");
    }
  }
}

function cleanResult(input) {
  object(input, "result");
  closed(input, ["summary", "error", "console"], "result");
  const result = {
    summary: redact(nullableText(input.summary, "result.summary", MAX_RESULT_BYTES)),
    error: redact(nullableText(input.error, "result.error", MAX_RESULT_BYTES)),
    console: array(input.console, "result.console", 32).map((value, index) => redact(boundedRawText(value, `result.console.${index}`, 1_000))),
  };
  if (Buffer.byteLength(canonicalJson(result), "utf8") > MAX_RESULT_BYTES) fail("result_too_large", "redacted receipt result exceeds its bound", "result");
  return result;
}

function cleanRegistration(input) {
  object(input, "registration");
  closed(input, ["registration_id", "read_back_verified", "removal_verified"], "registration");
  return {
    registration_id: nullableId(input.registration_id, "registration.registration_id"),
    read_back_verified: boolean(input.read_back_verified, "registration.read_back_verified"),
    removal_verified: boolean(input.removal_verified, "registration.removal_verified"),
  };
}

function cleanRollbackResult(input) {
  object(input, "rollback");
  closed(input, ["prior_revision", "cleanup_attempted", "cleanup_succeeded", "reason"], "receipt.rollback");
  return {
    prior_revision: nullableInteger(input.prior_revision, "receipt.rollback.prior_revision", 1, Number.MAX_SAFE_INTEGER),
    cleanup_attempted: boolean(input.cleanup_attempted, "receipt.rollback.cleanup_attempted"),
    cleanup_succeeded: boolean(input.cleanup_succeeded, "receipt.rollback.cleanup_succeeded"),
    reason: redact(nullableText(input.reason, "receipt.rollback.reason", 500)),
  };
}

function validateRevisionLineage(artifact, state) {
  const prior = artifact.rollback.prior_revision;
  if (artifact.revision > 1 && prior == null) fail("prior_revision_required", "later revisions must name their prior revision", "rollback.prior_revision");
  if (prior != null && !state.programs[programKey(artifact.artifact_id, prior)]) {
    fail("prior_revision_not_found", "prior revision must already exist", "rollback.prior_revision");
  }
}

function proposalResult(artifact, duplicate) {
  return deepFreeze({ state: "proposed", executable: false, duplicate, artifact: copy(artifact) });
}

function receiptResult(receipt, duplicate) {
  return deepFreeze({ state: "audit_copy_stored", executable: false, duplicate, receipt: copy(receipt) });
}

function createInMemoryBrowserProgramAdapter(initial = emptyState()) {
  let state = normalizeState(initial);
  return Object.freeze({ read: () => copy(state), write: (next) => { state = normalizeState(next); } });
}

function createFileBrowserProgramAdapter(filePath) {
  const target = path.resolve(String(filePath || ""));
  if (!filePath) fail("invalid_file_path", "filePath is required", "filePath");
  return Object.freeze({
    read() {
      if (!fs.existsSync(target)) return emptyState();
      try {
        return normalizeState(JSON.parse(fs.readFileSync(target, "utf8")));
      } catch (error) {
        fail("invalid_store", `browser program store cannot be read: ${error.message}`);
      }
    },
    write(next) {
      const state = normalizeState(next);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, target);
    },
  });
}

function normalizeState(input) {
  object(input, "store");
  closed(input, ["schema", "programs", "receipts"], "store");
  exact(input.schema, STORE_SCHEMA, "store.schema");
  object(input.programs, "store.programs");
  object(input.receipts, "store.receipts");
  if (Object.keys(input.programs).length > MAX_PROGRAMS || Object.keys(input.receipts).length > MAX_RECEIPTS) fail("store_full", "persisted store exceeds bounds");
  const programs = {};
  for (const [key, value] of Object.entries(input.programs)) {
    const program = validateBrowserProgram(value);
    if (key !== programKey(program.artifact_id, program.revision)) fail("invalid_store", "program key does not match its artifact");
    programs[key] = program;
  }
  const receipts = {};
  for (const [key, value] of Object.entries(input.receipts)) {
    const receipt = validateBrowserProgramReceipt(value);
    if (key !== receipt.receipt_id) fail("invalid_store", "receipt key does not match receipt_id");
    receipts[key] = receipt;
  }
  return { schema: STORE_SCHEMA, programs, receipts };
}

function readState(adapter) {
  return normalizeState(adapter.read());
}

function emptyState() {
  return { schema: STORE_SCHEMA, programs: {}, receipts: {} };
}

function canonicalizeSource(value) {
  if (typeof value !== "string") fail("invalid_source", "source must be text", "source");
  const source = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const bytes = Buffer.byteLength(source, "utf8");
  if (!source.trim() || bytes > MAX_SOURCE_BYTES || source.includes("\0")) fail("invalid_source", "source is empty, oversized, or contains NUL", "source");
  return source;
}

function sourceDigest(source) {
  return `sha256:${crypto.createHash("sha256").update(source, "utf8").digest("hex")}`;
}

function scopeDigest(artifact) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson({
    mode: artifact.mode,
    world: artifact.world,
    target: artifact.target,
    timing: artifact.timing,
    effect: artifact.effect,
    bridge_capabilities: artifact.bridge_capabilities,
    limits: artifact.limits,
  })).digest("hex")}`;
}

function validateTiming(mode, timing) {
  if (mode === "immediate" && timing !== "explicit") fail("invalid_timing", "immediate programs use explicit timing", "timing");
  if (mode === "persistent" && timing === "explicit") fail("invalid_timing", "persistent programs require document timing", "timing");
}

function cleanRefs(input, field) {
  return uniqueSorted(input, (value) => cleanId(value, field), field, 32);
}

function cleanOrigin(value, field) {
  const text = String(value || "").trim();
  let parsed;
  try { parsed = new URL(text); } catch { fail("invalid_scope", `${field} contains an invalid origin`, field); }
  const localHttp = parsed.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !localHttp) || text.includes("@") || parsed.origin !== text) {
    fail("invalid_scope", `${field} contains a non-canonical or unsafe origin`, field);
  }
  return parsed.origin;
}

function cleanMatch(value, field) {
  const text = String(value || "").trim();
  const match = text.match(MATCH);
  if (!match || text.includes("@") || text.includes("<all_urls>") || match[2].includes("*")) fail("invalid_scope", `${field} contains an unsafe match pattern`, field);
  return text;
}

function matchOrigin(pattern) {
  const parsed = new URL(pattern.replace(/\*.*$/, ""));
  return parsed.origin;
}

function sameMatchOrigin(a, b) {
  return a.split("/").slice(0, 3).join("/") === b.split("/").slice(0, 3).join("/");
}

function uniqueSorted(input, cleaner, field, max) {
  const values = array(input, field, max).map(cleaner);
  if (new Set(values).size !== values.length) fail("duplicate_value", `${field} contains duplicates`, field);
  return values.sort();
}

function assertNoCredentials(value, field) {
  SECRET_TEXT.lastIndex = 0;
  const secretText = SECRET_TEXT.test(value);
  SECRET_TEXT.lastIndex = 0;
  if (secretText || /document\.cookie|localStorage\.(?:getItem|setItem)\s*\(\s*["'](?:token|password|secret)/i.test(value)) {
    fail("credentials_forbidden", `${field} contains credential-like material`, field);
  }
}

function redact(value) {
  if (value == null) return null;
  SECRET_TEXT.lastIndex = 0;
  const redacted = value.replace(SECRET_TEXT, "[REDACTED]");
  SECRET_TEXT.lastIndex = 0;
  return redacted;
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail("invalid_schema", `${field} must be a plain object`, field);
  }
  for (const key of Object.keys(value)) if (SECRET_KEY.test(key)) fail("credentials_forbidden", `${field} contains a credential-shaped field`, `${field}.${key}`);
  return value;
}

function closed(value, allowed, field) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("unknown_field", `${field}.${key} is not allowed`, `${field}.${key}`);
}

function array(value, field, max) {
  if (!Array.isArray(value) || value.length > max) fail("invalid_schema", `${field} must be an array with at most ${max} entries`, field);
  return value;
}

function cleanId(value, field) {
  const text = String(value || "");
  if (!ID.test(text)) fail("invalid_id", `${field} is invalid`, field);
  return text;
}

function nullableId(value, field) {
  return value == null ? null : cleanId(value, field);
}

function cleanSha(value, field) {
  if (typeof value !== "string" || !SHA256.test(value)) fail("invalid_digest", `${field} is invalid`, field);
  return value;
}

function boundedText(value, field, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("invalid_text", `${field} is invalid`, field);
  assertNoCredentials(value, field);
  return value.trim();
}

function boundedRawText(value, field, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("invalid_text", `${field} is invalid`, field);
  return value.trim();
}

function nullableText(value, field, max) {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > max) fail("invalid_text", `${field} is invalid`, field);
  return value.trim() || null;
}

function integer(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("invalid_integer", `${field} is invalid`, field);
  return value;
}

function nullableInteger(value, field, min, max) {
  return value == null ? null : integer(value, field, min, max);
}

function boolean(value, field) {
  if (typeof value !== "boolean") fail("invalid_boolean", `${field} is invalid`, field);
  return value;
}

function oneOf(value, values, field) {
  if (!values.includes(value)) fail("invalid_enum", `${field} must be one of ${values.join(", ")}`, field);
  return value;
}

function exact(value, expected, field) {
  if (value !== expected) fail("unsupported_schema", `${field} must be ${expected}`, field);
  return value;
}

function cleanTimestamp(value, field) {
  const parsed = typeof value === "string" && value ? new Date(value) : null;
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail("invalid_timestamp", `${field} is invalid`, field);
  return value;
}

function programKey(id, revision) {
  return `${id}@${revision}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function fail(code, message, field) {
  throw new BrowserProgramValidationError(code, message, field);
}

module.exports = {
  BrowserProgramValidationError,
  MAX_PROGRAMS,
  MAX_RECEIPTS,
  MAX_RESULT_BYTES,
  MAX_SOURCE_BYTES,
  PROGRAM_SCHEMA,
  RECEIPT_SCHEMA,
  canonicalizeSource,
  createBrowserProgramStore,
  createFileBrowserProgramAdapter,
  createInMemoryBrowserProgramAdapter,
  scopeDigest,
  sourceDigest,
  validateBrowserProgram,
  validateBrowserProgramReceipt,
};
