"use strict";

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizeReleaseAction,
  bindCandidateEvidence,
  createDelegationGrant,
  planPreviewSwitch,
  planPromotionProposal,
  planStableFallback,
  resolveChannelAssignment,
} from "../lib/domain.mjs";

const now = 1_800_000_000_000;
const digest = "a".repeat(64);

test("device assignment overrides user, cohort, and tenant without hiding source", () => {
  assert.deepEqual(resolveChannelAssignment({
    tenant: { channel: "stable", release_id: "stable-1" },
    cohort: { channel: "canary", release_id: "canary-2" },
    user: { channel: "preview", release_id: "preview-3" },
    device: { channel: "device-preview", release_id: "preview-4" },
  }), {
    source: "device", channel: "device-preview", release_id: "preview-4", feature_profile_id: null,
  });
});

test("preview switch records stable fallback but never claims installation", () => {
  const plan = planPreviewSwitch({
    current_assignments: { user: { channel: "stable", release_id: "stable-1" } },
    preview: { channel: "preview", release_id: "preview-2" },
    stable: { channel: "stable", release_id: "stable-1" },
  });
  assert.equal(plan.operation, "assign_preview");
  assert.equal(plan.to.release_id, "preview-2");
  assert.equal(plan.fallback.release_id, "stable-1");
  assert.equal(plan.install_confirmed, false);
});

test("stable fallback uses last known good and remains pending platform receipt", () => {
  const plan = planStableFallback({
    current_assignments: { device: { channel: "preview", release_id: "preview-2" } },
    last_known_good: { channel: "stable", release_id: "stable-1" },
  });
  assert.equal(plan.to.release_id, "stable-1");
  assert.equal(plan.install_confirmed, false);
});

test("owner is authorized and scoped administrator cannot escape application scope", () => {
  const owner = authorizeReleaseAction({
    actor_id: "nat", owner_id: "nat", tenant_id: "personal", action: "approve_promotion",
    resource: { application_id: "chief-moa", channel: "stable", cohort_id: "all" },
  });
  assert.equal(owner.allowed, true);
  const base = {
    actor_id: "admin-1", owner_id: "nat", tenant_id: "personal", action: "approve_promotion",
    role_bindings: [{ tenant_id: "personal", principal_id: "admin-1", role: "administrator", scope: { application_id: "chief-moa" } }],
  };
  assert.equal(authorizeReleaseAction({ ...base, resource: { application_id: "chief-moa", channel: "stable", cohort_id: "all" } }).allowed, true);
  assert.equal(authorizeReleaseAction({ ...base, resource: { application_id: "other-app", channel: "stable", cohort_id: "all" } }).allowed, false);
});

test("device role can operate its release surface but cannot administer releases", () => {
  const base = {
    actor_id: "devc_phone_1",
    owner_id: "nat",
    tenant_id: "personal",
    role_bindings: [{
      tenant_id: "personal",
      principal_id: "devc_phone_1",
      role: "device",
      scope: { application_id: "chief-moa", channel: "*" },
    }],
    resource: { application_id: "chief-moa", channel: "preview", cohort_id: "all" },
  };
  for (const action of [
    "read", "assign_channel", "record_install_receipt", "record_release_feedback",
  ]) {
    assert.equal(authorizeReleaseAction({ ...base, action }).allowed, true);
  }
  for (const action of [
    "propose_promotion", "approve_promotion", "record_evidence", "delegate_administration",
  ]) {
    assert.equal(authorizeReleaseAction({ ...base, action }).allowed, false);
  }
});

test("delegation is revocable, expiring, scoped, and never self-issued", () => {
  assert.throws(() => createDelegationGrant({
    grant_id: "g-1", tenant_id: "personal", grantor_id: "nat", grantee_id: "nat",
    actions: ["assign_channel"], issued_at_ms: now, expires_at_ms: now + 1000,
  }), /cannot grant itself/);
  const grant = createDelegationGrant({
    grant_id: "g-2", tenant_id: "personal", grantor_id: "nat", grantee_id: "admin-1",
    actions: ["assign_channel"], scope: { application_id: "chief-moa", channel: "preview" },
    issued_at_ms: now, expires_at_ms: now + 10_000,
  });
  const request = {
    actor_id: "admin-1", owner_id: "nat", tenant_id: "personal", action: "assign_channel", now_ms: now + 1,
    delegation_grants: [grant], resource: { application_id: "chief-moa", channel: "preview", cohort_id: "all" },
  };
  assert.equal(authorizeReleaseAction(request).allowed, true);
  assert.equal(authorizeReleaseAction({ ...request, now_ms: now + 20_000 }).allowed, false);
  assert.equal(authorizeReleaseAction({ ...request, delegation_grants: [{ ...grant, revoked: true }] }).allowed, false);
});

test("evidence binds exact release and artifact bytes", () => {
  const candidate = { release_id: "candidate-1", artifact_sha256: digest };
  assert.equal(bindCandidateEvidence(candidate, { release_id: "candidate-1", artifact_sha256: digest }).accepted, true);
  assert.equal(bindCandidateEvidence(candidate, { release_id: "candidate-2", artifact_sha256: digest }).reason, "release_mismatch");
  assert.equal(bindCandidateEvidence(candidate, { release_id: "candidate-1", artifact_sha256: "b".repeat(64) }).reason, "artifact_mismatch");
});

test("promotion remains a proposal and separates source merge from channel movement", () => {
  const result = planPromotionProposal({
    application_id: "chief-moa", target_channel: "stable", cohort_id: "all",
    candidate: { release_id: "candidate-1", artifact_sha256: digest },
    evidence_plan: { release_id: "candidate-1", artifact_sha256: digest, channel_advance_allowed: true },
    source_merge_required: true,
    authorization: { actor_id: "nat", owner_id: "nat", tenant_id: "personal" },
  });
  assert.equal(result.status, "ready_for_approval");
  assert.equal(result.source_merge_required, true);
  assert.equal(result.channel_moved, false);
});

test("promotion blocks missing or mismatched evidence", () => {
  const base = {
    application_id: "chief-moa", target_channel: "stable",
    candidate: { release_id: "candidate-1", artifact_sha256: digest },
    authorization: { actor_id: "nat", owner_id: "nat", tenant_id: "personal" },
  };
  assert.equal(planPromotionProposal({ ...base, evidence_plan: { release_id: "candidate-1", artifact_sha256: digest, channel_advance_allowed: false, missing_for_publication: ["device_qa"] } }).reason, "missing_release_evidence");
  assert.equal(planPromotionProposal({ ...base, evidence_plan: { release_id: "candidate-2", artifact_sha256: digest, channel_advance_allowed: true } }).reason, "evidence_candidate_mismatch");
});
