"use strict";

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ROLES = new Set(["owner", "administrator", "release_manager", "tester", "viewer"]);
const ACTIONS = new Set([
  "read", "assign_channel", "propose_promotion", "approve_promotion",
  "record_evidence", "delegate_administration",
]);

const ROLE_ACTIONS = Object.freeze({
  owner: new Set(ACTIONS),
  administrator: new Set(["read", "assign_channel", "propose_promotion", "approve_promotion", "record_evidence", "delegate_administration"]),
  release_manager: new Set(["read", "assign_channel", "propose_promotion", "approve_promotion"]),
  tester: new Set(["read", "record_evidence"]),
  viewer: new Set(["read"]),
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
