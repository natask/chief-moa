"use strict";

// Lease semantics for deployment operation claims (preview / apply / rollback).
//
// A claim is a mutual-exclusion lease: it stops a second worker from applying
// a candidate while a first worker is still working on it. It is not a record
// that the operation happened -- that is the immutable receipt.
//
// Two rules make a claim releasable, and the deployment plane needs both:
//
// 1. Expiry. A claim whose `lease_expires_at` has passed no longer protects
//    anything; its holder must re-claim before acting.
// 2. Identity. A worker re-presenting the *same* claim_id it already holds is
//    retrying its own operation, not contending for someone else's. The
//    underlying event append is keyed on (request_id, operation, claim_id) and
//    returns the original event, so admitting the retry changes no state.
//
// Rule 2 is what makes a crashed run recoverable. Without it, a run that dies
// after claiming leaves a lease that only the clock can clear, and every retry
// -- including the identical retry by the identical worker -- is rejected with
// "already claimed by <itself>". That is the same shape as the Android OTA
// publish lock that could strand its own store, and it is why leases carry an
// expiry at all.

function currentDeploymentClaim(entry, operation) {
  return entry.claims.get(operation) || null;
}

function isClaimExpired(claim) {
  if (!claim?.lease_expires_at) return false;
  const expiry = new Date(claim.lease_expires_at);
  return Number.isFinite(expiry.getTime()) && expiry.getTime() <= Date.now();
}

// True when `claim` is a live lease belonging to someone other than `claimant`.
// A missing or expired claim blocks nobody. An anonymous claimant (no
// worker_id/claim_id offered) can never match, so callers that do not identify
// themselves keep the old, stricter behaviour.
function isClaimHeldByOther(claim, claimant) {
  if (!claim || isClaimExpired(claim)) return false;
  const worker = claimant?.worker_id;
  const claimId = claimant?.claim_id;
  if (!worker || !claimId) return true;
  return worker !== claim.worker_id || claimId !== claim.claim_id;
}

module.exports = { currentDeploymentClaim, isClaimExpired, isClaimHeldByOther };
