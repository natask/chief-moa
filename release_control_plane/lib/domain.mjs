"use strict";

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ROLES = new Set(["owner", "administrator", "release_manager", "tester", "viewer", "device"]);
const ACTIONS = new Set([
  "read", "assign_channel", "propose_promotion", "approve_promotion",
  "record_evidence", "record_install_receipt", "record_release_feedback",
  "delegate_administration",
]);

const ROLE_ACTIONS = Object.freeze({
  owner: new Set(ACTIONS),
  administrator: new Set(["read", "assign_channel", "propose_promotion", "approve_promotion", "record_evidence", "record_install_receipt", "record_release_feedback", "delegate_administration"]),
  release_manager: new Set(["read", "assign_channel", "propose_promotion", "approve_promotion"]),
  tester: new Set(["read", "record_evidence", "record_install_receipt", "record_release_feedback"]),
  viewer: new Set(["read"]),
  device: new Set(["read", "assign_channel", "record_install_receipt", "record_release_feedback"]),
});

function cleanId(value, field) {
  const text = String(value || "").trim().toLowerCase();
  if (!ID.test(text)) throw new Error(`${field} is invalid`);
  return text;
}

function cleanDigest(value, field) {
  const text = String(value || "").trim().toLowerCase();
  if (!SHA256.test(text)) throw new Error(`${field} is invalid`);
  return text;
}

function cleanInteger(value, field, minimum = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${field} is invalid`);
  return number;
}

function cleanText(value, field, maximum) {
  const text = String(value || "").trim();
  if (!text || text.length > maximum) throw new Error(`${field} is invalid`);
  return text;
}

function cleanRole(value) {
  const role = cleanId(value, "role");
  if (!ROLES.has(role)) throw new Error("role is unsupported");
  return role;
}

function cleanAction(value) {
  const action = cleanId(value, "action");
  if (!ACTIONS.has(action)) throw new Error("action is unsupported");
  return action;
}

function inScope(scope, resource) {
  if (!scope || typeof scope !== "object") return false;
  for (const key of ["application_id", "channel", "cohort_id"]) {
    const allowed = scope[key];
    if (allowed == null || allowed === "*") continue;
    if (cleanId(allowed, `scope.${key}`) !== cleanId(resource[key], `resource.${key}`)) return false;
  }
  return true;
}

export function authorizeReleaseAction(input) {
  const actorId = cleanId(input.actor_id, "actor_id");
  const tenantId = cleanId(input.tenant_id, "tenant_id");
  const action = cleanAction(input.action);
  const resource = input.resource || {};
  const now = Number.isFinite(input.now_ms) ? input.now_ms : Date.now();

  if (actorId === cleanId(input.owner_id, "owner_id")) {
    return { allowed: true, reason: "tenant_owner", role: "owner" };
  }

  for (const binding of input.role_bindings || []) {
    if (cleanId(binding.tenant_id, "binding.tenant_id") !== tenantId) continue;
    if (cleanId(binding.principal_id, "binding.principal_id") !== actorId) continue;
    const role = cleanRole(binding.role);
    if (!ROLE_ACTIONS[role].has(action) || !inScope(binding.scope || {}, resource)) continue;
    return { allowed: true, reason: "role_binding", role };
  }

  for (const grant of input.delegation_grants || []) {
    if (cleanId(grant.tenant_id, "grant.tenant_id") !== tenantId) continue;
    if (cleanId(grant.grantee_id, "grant.grantee_id") !== actorId) continue;
    if (cleanId(grant.grantor_id, "grant.grantor_id") === actorId) continue;
    if (grant.revoked === true || !Number.isFinite(grant.expires_at_ms) || grant.expires_at_ms <= now) continue;
    const actions = new Set((grant.actions || []).map(cleanAction));
    if (!actions.has(action) || !inScope(grant.scope || {}, resource)) continue;
    return { allowed: true, reason: "delegation_grant", role: "delegated" };
  }

  return { allowed: false, reason: "not_authorized", role: null };
}

export function createDelegationGrant(input) {
  const grantorId = cleanId(input.grantor_id, "grantor_id");
  const granteeId = cleanId(input.grantee_id, "grantee_id");
  if (grantorId === granteeId) throw new Error("a principal cannot grant itself authority");
  const issuedAt = Number(input.issued_at_ms);
  const expiresAt = Number(input.expires_at_ms);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
    throw new Error("grant expiry must be after issuance");
  }
  const actions = [...new Set((input.actions || []).map(cleanAction))].sort();
  if (actions.length === 0) throw new Error("grant must contain an action");
  return Object.freeze({
    grant_id: cleanId(input.grant_id, "grant_id"),
    tenant_id: cleanId(input.tenant_id, "tenant_id"),
    grantor_id: grantorId,
    grantee_id: granteeId,
    actions,
    scope: Object.freeze({ ...(input.scope || {}) }),
    issued_at_ms: issuedAt,
    expires_at_ms: expiresAt,
    revoked: false,
  });
}

export function resolveChannelAssignment(input) {
  const candidates = [
    ["device", input.device],
    ["user", input.user],
    ["cohort", input.cohort],
    ["tenant", input.tenant],
  ];
  for (const [source, assignment] of candidates) {
    if (!assignment) continue;
    return {
      source,
      channel: cleanId(assignment.channel, `${source}.channel`),
      release_id: cleanId(assignment.release_id, `${source}.release_id`),
      feature_profile_id: assignment.feature_profile_id == null
        ? null : cleanId(assignment.feature_profile_id, `${source}.feature_profile_id`),
    };
  }
  return null;
}

export function planPreviewSwitch(input) {
  const current = resolveChannelAssignment(input.current_assignments || {});
  const preview = input.preview;
  if (!preview) throw new Error("preview assignment is required");
  const stable = input.stable;
  if (!stable) throw new Error("stable fallback is required");
  return Object.freeze({
    operation: "assign_preview",
    from: current,
    to: resolveChannelAssignment({ device: preview }),
    fallback: resolveChannelAssignment({ device: stable }),
    install_confirmed: false,
  });
}

export function planStableFallback(input) {
  if (!input.last_known_good) throw new Error("last_known_good is required");
  return Object.freeze({
    operation: "assign_stable_fallback",
    from: resolveChannelAssignment(input.current_assignments || {}),
    to: resolveChannelAssignment({ device: input.last_known_good }),
    install_confirmed: false,
  });
}

export function bindCandidateEvidence(candidate, evidence) {
  const releaseId = cleanId(candidate.release_id, "candidate.release_id");
  const artifactSha256 = cleanDigest(candidate.artifact_sha256, "candidate.artifact_sha256");
  if (cleanId(evidence.release_id, "evidence.release_id") !== releaseId) {
    return { accepted: false, reason: "release_mismatch" };
  }
  if (cleanDigest(evidence.artifact_sha256, "evidence.artifact_sha256") !== artifactSha256) {
    return { accepted: false, reason: "artifact_mismatch" };
  }
  return { accepted: true, reason: "exact_candidate_match", release_id: releaseId, artifact_sha256: artifactSha256 };
}

export function planPromotionProposal(input) {
  const authorization = authorizeReleaseAction({
    ...input.authorization,
    action: "propose_promotion",
    resource: {
      application_id: input.application_id,
      channel: input.target_channel,
      cohort_id: input.cohort_id || "all",
    },
  });
  if (!authorization.allowed) return { status: "denied", reason: authorization.reason };
  if (input.evidence_plan?.release_id !== cleanId(input.candidate.release_id, "candidate.release_id")
      || input.evidence_plan?.artifact_sha256 !== cleanDigest(input.candidate.artifact_sha256, "candidate.artifact_sha256")) {
    return { status: "blocked", reason: "evidence_candidate_mismatch" };
  }
  if (input.evidence_plan.channel_advance_allowed !== true) {
    return { status: "blocked", reason: "missing_release_evidence", missing: input.evidence_plan.missing_for_publication || [] };
  }
  return {
    status: "ready_for_approval",
    reason: "authorized_candidate_evidenced",
    release_id: cleanId(input.candidate.release_id, "candidate.release_id"),
    artifact_sha256: cleanDigest(input.candidate.artifact_sha256, "candidate.artifact_sha256"),
    target_channel: cleanId(input.target_channel, "target_channel"),
    source_merge_required: input.source_merge_required === true,
    channel_moved: false,
  };
}

// These normalizers deliberately select known fields instead of rejecting
// unknown additive fields. An N-1 reader can therefore consume records written
// by a newer control-plane version without inheriting new semantics.
export function normalizeReleaseBundle(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("bundle is invalid");
  const artifacts = (input.artifacts || []).map((artifact, index) => Object.freeze({
    surface_id: cleanId(artifact.surface_id, `artifacts[${index}].surface_id`),
    release_id: cleanId(artifact.release_id, `artifacts[${index}].release_id`),
    semantic_version: cleanText(artifact.semantic_version, `artifacts[${index}].semantic_version`, 80),
    artifact_sha256: cleanDigest(artifact.artifact_sha256, `artifacts[${index}].artifact_sha256`),
    artifact_size: cleanInteger(artifact.artifact_size, `artifacts[${index}].artifact_size`, 1),
    git_sha: cleanText(artifact.git_sha, `artifacts[${index}].git_sha`, 64),
    download_url: artifact.download_url == null ? null : cleanText(artifact.download_url, `artifacts[${index}].download_url`, 2048),
    app_id: artifact.app_id == null ? null : cleanText(artifact.app_id, `artifacts[${index}].app_id`, 200),
    version_code: artifact.version_code == null ? null : cleanInteger(artifact.version_code, `artifacts[${index}].version_code`, 1),
    version_name: artifact.version_name == null ? null : cleanText(artifact.version_name, `artifacts[${index}].version_name`, 80),
  }));
  if (!artifacts.length) throw new Error("bundle.artifacts is invalid");
  const surfaceIds = new Set();
  for (const artifact of artifacts) {
    if (surfaceIds.has(artifact.surface_id)) throw new Error("bundle has duplicate surface");
    surfaceIds.add(artifact.surface_id);
  }
  return Object.freeze({
    tenant_id: cleanId(input.tenant_id, "bundle.tenant_id"),
    application_id: cleanId(input.application_id, "bundle.application_id"),
    bundle_id: cleanId(input.bundle_id, "bundle.bundle_id"),
    compatibility_version: cleanInteger(input.compatibility_version ?? 1, "bundle.compatibility_version", 1),
    lineage: normalizeBundleLineage(input.lineage, input.bundle_id),
    artifacts: Object.freeze(artifacts),
    created_at: cleanText(input.created_at, "bundle.created_at", 80),
  });
}

export function normalizeBundleLineage(input, bundleId) {
  const value = input == null ? {} : input;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bundle.lineage is invalid");
  const seriesParent = value.series_parent_bundle_id == null
    ? null : cleanId(value.series_parent_bundle_id, "bundle.lineage.series_parent_bundle_id");
  const parallelParents = [...new Set((value.parallel_parent_bundle_ids || []).map((item) =>
    cleanId(item, "bundle.lineage.parallel_parent_bundle_ids")))].sort();
  if (parallelParents.length > 32) throw new Error("bundle.lineage.parallel_parent_bundle_ids is invalid");
  const self = cleanId(bundleId, "bundle.bundle_id");
  if (seriesParent === self || parallelParents.includes(self)) throw new Error("bundle lineage cannot reference itself");
  if (seriesParent && parallelParents.includes(seriesParent)) throw new Error("bundle lineage parent is duplicated");
  const kind = cleanId(value.kind || (parallelParents.length ? "composed" : seriesParent ? "series" : "root"), "bundle.lineage.kind");
  if (!["root", "series", "parallel", "composed"].includes(kind)) throw new Error("bundle.lineage.kind is invalid");
  return Object.freeze({ kind, series_parent_bundle_id: seriesParent, parallel_parent_bundle_ids: Object.freeze(parallelParents) });
}

export function artifactForSurface(bundle, surfaceId) {
  const normalized = normalizeReleaseBundle(bundle);
  return normalized.artifacts.find((artifact) => artifact.surface_id === cleanId(surfaceId, "surface_id")) || null;
}

export function bindExactRelease(bundle, anchor) {
  const normalized = normalizeReleaseBundle(bundle);
  if (cleanId(anchor.bundle_id, "anchor.bundle_id") !== normalized.bundle_id) {
    return { accepted: false, reason: "bundle_mismatch" };
  }
  const artifact = artifactForSurface(normalized, anchor.surface_id);
  if (!artifact) return { accepted: false, reason: "surface_mismatch" };
  if (cleanId(anchor.release_id, "anchor.release_id") !== artifact.release_id) {
    return { accepted: false, reason: "release_mismatch" };
  }
  if (cleanDigest(anchor.artifact_sha256, "anchor.artifact_sha256") !== artifact.artifact_sha256) {
    return { accepted: false, reason: "artifact_mismatch" };
  }
  return { accepted: true, reason: "exact_release_match", bundle: normalized, artifact };
}

export function normalizeChannelHead(input) {
  return Object.freeze({
    tenant_id: cleanId(input.tenant_id, "channel_head.tenant_id"),
    application_id: cleanId(input.application_id, "channel_head.application_id"),
    channel: cleanId(input.channel, "channel_head.channel"),
    bundle_id: cleanId(input.bundle_id, "channel_head.bundle_id"),
    sequence: cleanInteger(input.sequence, "channel_head.sequence", 1),
    updated_at: cleanText(input.updated_at, "channel_head.updated_at", 80),
  });
}

export function normalizeAssignmentEvent(input) {
  return Object.freeze({
    event_id: cleanId(input.event_id, "assignment.event_id"),
    tenant_id: cleanId(input.tenant_id, "assignment.tenant_id"),
    application_id: cleanId(input.application_id, "assignment.application_id"),
    scope_type: cleanId(input.scope_type, "assignment.scope_type"),
    scope_id: cleanId(input.scope_id, "assignment.scope_id"),
    sequence: cleanInteger(input.sequence, "assignment.sequence", 1),
    channel: cleanId(input.channel, "assignment.channel"),
    bundle_id: cleanId(input.bundle_id, "assignment.bundle_id"),
    stable_fallback_bundle_id: cleanId(input.stable_fallback_bundle_id, "assignment.stable_fallback_bundle_id"),
    operation: cleanId(input.operation, "assignment.operation"),
    idempotency_key: input.idempotency_key == null ? null : cleanText(input.idempotency_key, "assignment.idempotency_key", 200),
    actor_id: cleanId(input.actor_id, "assignment.actor_id"),
    created_at: cleanText(input.created_at, "assignment.created_at", 80),
  });
}

export function normalizeInstallReceipt(input, options = {}) {
  const incomingStatus = cleanId(input.status, "install_receipt.status");
  const knownStatuses = [
    "offered", "download_verified", "installer_opened", "installed", "activated",
    "smoked", "refused", "failed",
  ];
  if (!knownStatuses.includes(incomingStatus) && options.allow_unknown_status !== true) {
    throw new Error("install_receipt.status is invalid");
  }
  const status = knownStatuses.includes(incomingStatus) ? incomingStatus : "unknown";
  return Object.freeze({
    receipt_id: cleanId(input.receipt_id, "install_receipt.receipt_id"),
    tenant_id: cleanId(input.tenant_id, "install_receipt.tenant_id"),
    application_id: cleanId(input.application_id, "install_receipt.application_id"),
    device_id: cleanId(input.device_id, "install_receipt.device_id"),
    assignment_event_id: cleanId(input.assignment_event_id, "install_receipt.assignment_event_id"),
    bundle_id: cleanId(input.bundle_id, "install_receipt.bundle_id"),
    surface_id: cleanId(input.surface_id, "install_receipt.surface_id"),
    release_id: cleanId(input.release_id, "install_receipt.release_id"),
    artifact_sha256: cleanDigest(input.artifact_sha256, "install_receipt.artifact_sha256"),
    status,
    idempotency_key: cleanText(input.idempotency_key, "install_receipt.idempotency_key", 200),
    created_at: cleanText(input.created_at, "install_receipt.created_at", 80),
  });
}

export function normalizeReleaseFeedback(input) {
  if (Array.isArray(input.evidence_refs) && input.evidence_refs.length > 20) {
    throw new Error("feedback.evidence_refs is invalid");
  }
  const evidenceRefs = Array.isArray(input.evidence_refs)
    ? input.evidence_refs.map((value, index) => cleanText(value, `feedback.evidence_refs[${index}]`, 1024))
    : [];
  return Object.freeze({
    feedback_id: cleanId(input.feedback_id, "feedback.feedback_id"),
    tenant_id: cleanId(input.tenant_id, "feedback.tenant_id"),
    application_id: cleanId(input.application_id, "feedback.application_id"),
    device_id: cleanId(input.device_id, "feedback.device_id"),
    assignment_event_id: cleanId(input.assignment_event_id, "feedback.assignment_event_id"),
    bundle_id: cleanId(input.bundle_id, "feedback.bundle_id"),
    surface_id: cleanId(input.surface_id, "feedback.surface_id"),
    release_id: cleanId(input.release_id, "feedback.release_id"),
    artifact_sha256: cleanDigest(input.artifact_sha256, "feedback.artifact_sha256"),
    text: cleanText(input.text, "feedback.text", 8000),
    evidence_refs: Object.freeze(evidenceRefs),
    idempotency_key: cleanText(input.idempotency_key, "feedback.idempotency_key", 200),
    created_at: cleanText(input.created_at, "feedback.created_at", 80),
  });
}
