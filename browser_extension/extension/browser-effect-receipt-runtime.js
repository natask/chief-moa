const RECEIPT_VERSION = "moa.browser-effect-receipt.v1";
const MAX_RECEIPTS = 128;
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_REFS = 8;

const OUTCOME_STATUSES = new Set(["succeeded", "failed", "blocked", "cancelled", "indeterminate"]);
const FOLLOWUP_STATUSES = new Set(["not_needed", "pending", "succeeded", "failed", "blocked"]);
const CHECKPOINT_STATUSES = new Set(["not_required", "required", "approved", "rejected", "expired"]);

function recordBrowserEffectAttempt(receipts, attempt) {
  const ledger = canonicalLedger(receipts);
  if (ledger.length > MAX_RECEIPTS) throw new Error("Browser effect receipt ledger exceeds its bound.");
  const receipt = createBrowserEffectReceipt(attempt);
  const prior = ledger.find((item) => item.idempotency_key === receipt.idempotency_key);
  if (prior) {
    if (stableJson(prior) !== stableJson(receipt)) throw new Error("Browser effect receipt idempotency conflict.");
    return deepFreeze({ receipt: prior, receipts: ledger, idempotent_replay: true });
  }
  if (ledger.length >= MAX_RECEIPTS) throw new Error("Browser effect receipt ledger is full.");
  return deepFreeze({ receipt, receipts: [...ledger, receipt], idempotent_replay: false });
}

function createBrowserEffectReceipt(attempt) {
  const idempotencyKey = requiredId(attempt?.idempotency_key, "idempotency_key");
  const effectAttemptId = requiredId(attempt?.effect_attempt_id, "effect_attempt_id");
  const receipt = {
    version: RECEIPT_VERSION,
    receipt_id: `ber_${idempotencyKey}`,
    idempotency_key: idempotencyKey,
    effect_attempt_id: effectAttemptId,
    attempted_at: timestamp(attempt?.attempted_at, "attempted_at"),
    task_id: requiredId(attempt?.task_id, "task_id"),
    run_id: requiredId(attempt?.run_id, "run_id"),
    delegation_envelope_id: requiredId(attempt?.delegation_envelope_id, "delegation_envelope_id"),
    executor: executorBinding(attempt?.executor),
    execution_profile: profileBinding(attempt?.execution_profile),
    target: targetBinding(attempt?.target),
    anchor: anchorBinding(attempt?.anchor),
    effect: effectBinding(attempt?.effect),
    before_after: beforeAfterBinding(attempt?.before_after),
    checkpoint: checkpointBinding(attempt?.checkpoint),
    result: resultBinding(attempt?.result),
    error: errorBinding(attempt?.error),
    cleanup: followupBinding(attempt?.cleanup, "cleanup"),
    rollback: followupBinding(attempt?.rollback, "rollback"),
  };
  validateCoherence(receipt);
  if (byteLength(receipt) > MAX_RECEIPT_BYTES) throw new Error("Browser effect receipt exceeds its byte bound.");
  return deepFreeze(receipt);
}

function executorBinding(value) {
  return {
    surface: exactEnum(value?.surface, ["browser_extension"], "executor.surface"),
    executor_id: requiredId(value?.executor_id, "executor.executor_id"),
    device_id: requiredId(value?.device_id, "executor.device_id"),
    version: boundedText(value?.version, 64, "executor.version"),
  };
}

function profileBinding(value) {
  return {
    profile_id: requiredId(value?.profile_id, "execution_profile.profile_id"),
    revision: boundedInteger(value?.revision, 1, Number.MAX_SAFE_INTEGER, "execution_profile.revision"),
    digest: digest(value?.digest, "execution_profile.digest"),
  };
}

function targetBinding(value) {
  return {
    tab_id: boundedInteger(value?.tab_id, 0, Number.MAX_SAFE_INTEGER, "target.tab_id"),
    document_id: requiredId(value?.document_id, "target.document_id"),
    frame_id: boundedInteger(value?.frame_id, 0, Number.MAX_SAFE_INTEGER, "target.frame_id"),
    origin: canonicalOrigin(value?.origin),
  };
}

function anchorBinding(value) {
  return {
    anchor_id: requiredId(value?.anchor_id, "anchor.anchor_id"),
    observation_id: requiredId(value?.observation_id, "anchor.observation_id"),
    node_identity_digest: digest(value?.node_identity_digest, "anchor.node_identity_digest"),
  };
}

function effectBinding(value) {
  if (typeof value?.checkpoint_required !== "boolean") throw new Error("Invalid effect.checkpoint_required.");
  return {
    effect_class: boundedToken(value?.effect_class, 64, "effect.effect_class"),
    operation: boundedToken(value?.operation, 64, "effect.operation"),
    sensitivity: exactEnum(value?.sensitivity, ["ordinary", "sensitive", "destructive"], "effect.sensitivity"),
    checkpoint_required: value.checkpoint_required,
  };
}

function beforeAfterBinding(value) {
  const changed = value?.changed;
  if (typeof changed !== "boolean") throw new Error("Invalid before_after.changed.");
  return {
    before_digest: digest(value?.before_digest, "before_after.before_digest"),
    after_digest: optionalDigest(value?.after_digest, "before_after.after_digest"),
    changed,
    verification: exactEnum(value?.verification, ["matched", "mismatched", "failed", "unavailable"], "before_after.verification"),
  };
}

function checkpointBinding(value) {
  const status = exactEnum(value?.status, CHECKPOINT_STATUSES, "checkpoint.status");
  return {
    status,
    checkpoint_id: optionalId(value?.checkpoint_id, "checkpoint.checkpoint_id"),
    approval_id: optionalId(value?.approval_id, "checkpoint.approval_id"),
    binding_digest: optionalDigest(value?.binding_digest, "checkpoint.binding_digest"),
  };
}

function resultBinding(value) {
  return {
    status: exactEnum(value?.status, OUTCOME_STATUSES, "result.status"),
    code: boundedToken(value?.code, 64, "result.code"),
    summary: safeText(value?.summary, 500),
    evidence_refs: boundedRefs(value?.evidence_refs, "result.evidence_refs"),
  };
}

function errorBinding(value) {
  if (value == null) return null;
  return {
    code: boundedToken(value?.code, 64, "error.code"),
    stage: boundedToken(value?.stage, 64, "error.stage"),
    retryable: value?.retryable === true,
    summary: safeText(value?.summary, 500),
  };
}

function followupBinding(value, field) {
  const result = {
    status: exactEnum(value?.status, FOLLOWUP_STATUSES, `${field}.status`),
    code: boundedToken(value?.code, 64, `${field}.code`),
    evidence_refs: boundedRefs(value?.evidence_refs, `${field}.evidence_refs`),
  };
  if (result.status === "succeeded" && result.evidence_refs.length === 0) {
    throw new Error(`${field}.succeeded requires evidence.`);
  }
  if (result.status === "not_needed" && result.evidence_refs.length !== 0) {
    throw new Error(`${field}.not_needed cannot carry evidence.`);
  }
  return result;
}

function validateCoherence(receipt) {
  const { before_after: state, checkpoint, effect, result, error, cleanup, rollback } = receipt;
  const checkpointed = effect.checkpoint_required || effect.sensitivity !== "ordinary";
  if (state.changed && state.after_digest === null) {
    throw new Error("A changed browser effect requires an after digest.");
  }
  if (state.verification === "matched" && state.after_digest === null) {
    throw new Error("Matched verification requires an after digest.");
  }
  if (state.verification === "matched" && state.changed === (state.before_digest === state.after_digest)) {
    throw new Error("Browser effect changed state conflicts with its digests.");
  }
  if (result.status === "succeeded") {
    if (error !== null) throw new Error("A successful browser effect receipt cannot carry an error.");
    if (state.verification !== "matched") throw new Error("A successful browser effect requires matched verification.");
    if (checkpointed && (
      checkpoint.status !== "approved"
      || checkpoint.checkpoint_id === null
      || checkpoint.approval_id === null
      || checkpoint.binding_digest === null
    )) throw new Error("A sensitive or checkpointed browser effect requires bound approval.");
  }
  if (["failed", "indeterminate"].includes(result.status) && error === null) {
    throw new Error(`${result.status} browser effect requires an error.`);
  }
  if (["blocked", "cancelled"].includes(result.status)) {
    if (state.changed || state.after_digest !== null || state.verification !== "unavailable") {
      throw new Error(`${result.status} browser effect cannot claim a state change.`);
    }
    if (result.status === "cancelled" && error !== null) {
      throw new Error("A cancelled browser effect is not an execution error.");
    }
    if (cleanup.status !== "not_needed" || rollback.status !== "not_needed") {
      throw new Error(`${result.status} browser effect cannot claim cleanup or rollback work.`);
    }
  }
  if (!state.changed && rollback.status !== "not_needed") {
    throw new Error("An unchanged browser effect cannot claim rollback work.");
  }
}

function boundedRefs(value, field) {
  if (!Array.isArray(value) || value.length > MAX_REFS) throw new Error(`Invalid ${field}.`);
  const refs = value.map((item) => requiredId(item, field));
  if (new Set(refs).size !== refs.length) throw new Error(`Duplicate ${field}.`);
  return refs;
}

function canonicalStoredReceipt(value) {
  const receipt = createBrowserEffectReceipt(value);
  if (value?.version !== RECEIPT_VERSION || value?.receipt_id !== receipt.receipt_id) {
    throw new Error("Invalid stored browser effect receipt.");
  }
  return receipt;
}

function canonicalLedger(values) {
  if (!Array.isArray(values)) throw new Error("Browser effect receipt ledger must be an array.");
  const receipts = [];
  const byKey = new Map();
  for (const value of values) {
    const receipt = canonicalStoredReceipt(value);
    const prior = byKey.get(receipt.idempotency_key);
    if (prior && stableJson(prior) !== stableJson(receipt)) {
      throw new Error("Browser effect receipt ledger contains an idempotency conflict.");
    }
    if (!prior) {
      byKey.set(receipt.idempotency_key, receipt);
      receipts.push(receipt);
    }
  }
  return receipts;
}

function canonicalOrigin(value) {
  if (typeof value !== "string" || value.length > 512) throw new Error("Invalid target.origin.");
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("Invalid target.origin."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || value !== parsed.origin) {
    throw new Error("Invalid target.origin.");
  }
  return parsed.origin;
}

function timestamp(value, field) {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${field}.`);
  return new Date(value).toISOString();
}

function requiredId(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) throw new Error(`Invalid ${field}.`);
  return value;
}

function optionalId(value, field) {
  return value == null ? null : requiredId(value, field);
}

function digest(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${field}.`);
  return value;
}

function optionalDigest(value, field) {
  return value == null ? null : digest(value, field);
}

function boundedToken(value, max, field) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || !/^[a-z][a-z0-9._-]*$/.test(value)) throw new Error(`Invalid ${field}.`);
  return value;
}

function boundedText(value, max, field) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid ${field}.`);
  return value;
}

function safeText(value, max) {
  if (typeof value !== "string") return "";
  return redactSecrets(value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max));
}

function redactSecrets(value) {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "[REDACTED]")
    .replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b(?:password|passwd|token|secret|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

function exactEnum(value, allowed, field) {
  const contains = allowed instanceof Set ? allowed.has(value) : allowed.includes(value);
  if (!contains) throw new Error(`Invalid ${field}.`);
  return value;
}

function boundedInteger(value, min, max, field) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${field}.`);
  return value;
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export { MAX_RECEIPTS, RECEIPT_VERSION, createBrowserEffectReceipt, recordBrowserEffectAttempt };
