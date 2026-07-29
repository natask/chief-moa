"use strict";

// Regression coverage for the deployment claim lease.
//
// A promotion run that dies between claiming and receipting leaves its own
// claim behind. Production froze this way: the droplet's promoter retried the
// same commit, presented the same worker id and the same deterministic
// claim_id, and was rejected with "already claimed by preview-deployer" --
// by itself. The 24h lease in scripts/vps/create-promotion-evidence.js meant
// the clock could not clear it either.

const assert = require("node:assert/strict");
const test = require("node:test");

const { currentDeploymentClaim, isClaimExpired, isClaimHeldByOther } = require("../lib/deployment-claims");
const { workHistoryTestInternals: u } = require("../lib/work-history");

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

function entry(overrides = {}) {
  return {
    request: { request_id: "dreq_1", status: "requested", target: "gateway" },
    review: { decision: "approved" },
    claims: new Map(),
    effects: new Map(),
    receipts: new Map(),
    records: [],
    verifications: [],
    ...overrides,
  };
}

test("a claim with no lease never expires and a past lease does", () => {
  assert.equal(isClaimExpired(null), false);
  assert.equal(isClaimExpired({ worker_id: "w" }), false);
  assert.equal(isClaimExpired({ worker_id: "w", lease_expires_at: FUTURE }), false);
  assert.equal(isClaimExpired({ worker_id: "w", lease_expires_at: PAST }), true);
  // An unparseable lease must not silently release the claim.
  assert.equal(isClaimExpired({ worker_id: "w", lease_expires_at: "not-a-date" }), false);
});

test("a live claim blocks other workers but not its own identical retry", () => {
  const claim = { worker_id: "preview-deployer", claim_id: "preview-eb56137493f8", lease_expires_at: FUTURE };

  // The retry that production could not perform.
  assert.equal(isClaimHeldByOther(claim, { worker_id: "preview-deployer", claim_id: "preview-eb56137493f8" }), false);

  // Mutual exclusion still holds against everyone else.
  assert.equal(isClaimHeldByOther(claim, { worker_id: "other-worker", claim_id: "preview-eb56137493f8" }), true);
  assert.equal(isClaimHeldByOther(claim, { worker_id: "preview-deployer", claim_id: "preview-other" }), true);

  // An unidentified claimant is treated as contention, so callers that do not
  // say who they are keep the stricter behaviour.
  assert.equal(isClaimHeldByOther(claim, undefined), true);
  assert.equal(isClaimHeldByOther(claim, { worker_id: "preview-deployer" }), true);

  // Nothing blocks when there is no claim, or when the lease has run out.
  assert.equal(isClaimHeldByOther(null, { worker_id: "w", claim_id: "c" }), false);
  assert.equal(isClaimHeldByOther({ ...claim, lease_expires_at: PAST }, { worker_id: "other", claim_id: "c" }), false);
});

test("currentDeploymentClaim reads the operation's claim", () => {
  const e = entry();
  assert.equal(currentDeploymentClaim(e, "preview"), null);
  const claim = { worker_id: "w", claim_id: "c" };
  e.claims.set("preview", claim);
  assert.equal(currentDeploymentClaim(e, "preview"), claim);
  assert.equal(currentDeploymentClaim(e, "apply"), null);
});

test("the claimable guard admits the holder's own retry and still rejects rivals", () => {
  const e = entry();
  e.claims.set("preview", { worker_id: "preview-deployer", claim_id: "preview-eb56137493f8", lease_expires_at: FUTURE });

  assert.doesNotThrow(() => u.assertDeploymentOperationClaimable(e, "preview", {
    worker_id: "preview-deployer", claim_id: "preview-eb56137493f8",
  }));
  assert.throws(() => u.assertDeploymentOperationClaimable(e, "preview", {
    worker_id: "rival-deployer", claim_id: "preview-eb56137493f8",
  }), /already claimed by preview-deployer/);

  // An expired lease is reclaimable by anyone; that is what the lease is for.
  e.claims.set("preview", { worker_id: "preview-deployer", claim_id: "preview-old", lease_expires_at: PAST });
  assert.doesNotThrow(() => u.assertDeploymentOperationClaimable(e, "preview", {
    worker_id: "rival-deployer", claim_id: "preview-new",
  }));

  // Admitting a retry must not skip the operation's own preconditions.
  const unreviewed = entry({ review: null });
  unreviewed.claims.set("preview", { worker_id: "w", claim_id: "c", lease_expires_at: FUTURE });
  assert.throws(() => u.assertDeploymentOperationClaimable(unreviewed, "preview", {
    worker_id: "w", claim_id: "c",
  }), /awaiting review/);
});
