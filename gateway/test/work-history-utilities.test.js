"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createWorkHistoryStore, workHistoryTestInternals: u } = require("../lib/work-history");

function entry(overrides = {}) {
  return {
    request: { request_id: "dreq_1", status: "requested", target: "gateway" },
    review: null,
    claims: new Map(),
    effects: new Map(),
    receipts: new Map(),
    records: [],
    verifications: [],
    effect_adoptions: [],
    ...overrides,
  };
}

function preview(overrides = {}) {
  return {
    deployment_id: "dep_preview",
    mode: "preview",
    status: "available",
    worker_id: "worker",
    claim_id: "claim_preview",
    recorded_at: "2026-07-15T00:00:00Z",
    ...overrides,
  };
}

function verification(overrides = {}) {
  return {
    operation: "preview",
    deployment_id: "dep_preview",
    claim_id: "claim_preview",
    created_by_worker_id: "worker",
    status: "passed",
    finished_at: "2026-07-15T00:01:00Z",
    ...overrides,
  };
}

test("store requires complete atomic event substrate support", () => {
  assert.throws(() => createWorkHistoryStore({}), /appendEvent\/listEvents/);
  assert.throws(() => createWorkHistoryStore({ events: { appendEvent() {}, listEvents() {} } }), /atomic stream transition/);
});

test("stream, target, actor, scalar, and idempotency helpers normalize safely", () => {
  assert.equal(u.isTerminalRunStatus("completed"), true);
  assert.equal(u.isTerminalRunStatus("running"), false);
  assert.equal(u.taskStream(""), "work-task:unknown");
  assert.equal(u.runStream(null), "work-run:unknown");
  assert.equal(u.streamForTarget(), "work-history:feedback");
  assert.equal(u.streamForTarget({ type: "run", id: "wr_1" }), "work-run:wr_1");
  assert.equal(u.streamForTarget({ type: "task", id: "wt_1" }), "work-task:wt_1");
  assert.equal(u.streamForTarget({ type: "deployment", id: "dep_1" }), "deployment:dep_1");
  assert.equal(u.streamForTarget({ type: "other" }), "work-history:feedback");
  assert.deepEqual(u.actor({ kind: "worker", id: "w" }), { kind: "worker", id: "w" });
  assert.deepEqual(u.actor([], "gateway", "g"), { kind: "gateway", id: "g" });
  assert.deepEqual(u.actor({}, "gateway"), { kind: "gateway", id: "gateway" });
  assert.equal(u.requireText(" value ", "field"), "value");
  assert.throws(() => u.requireText("", "field"), /field is required/);
  assert.equal(u.text(null, 10), "");
  assert.equal(u.text(" 123456 ", 3), "123");
  assert.equal(u.integer(3), 3);
  assert.equal(u.integer(-1), 0);
  assert.equal(u.integer(1.5), 0);
  assert.deepEqual(u.plain({ ok: true }), { ok: true });
  assert.deepEqual(u.plain([]), {});
  assert.equal(u.idem(" explicit ", "scope", "op"), "explicit");
  assert.equal(u.idem("", "scope", "op"), "wh:scope:op");
  assert.equal(u.idem("", "", "op"), "");
  assert.equal(u.idem("", "scope", ""), "");
});

test("feedback targets infer bounded typed identities", () => {
  assert.deepEqual(u.normalizeFeedbackTargets(), []);
  assert.deepEqual(u.normalizeFeedbackTargets("wr_1"), [{ type: "run", id: "wr_1" }]);
  assert.deepEqual(u.normalizeFeedbackTargets([
    "wt_1", "wg_2", "dep_1", "other", "",
    { type: "verification", id: "ver_1" },
    { type: "bad", id: "run_2" },
    { type: "run", id: "" },
    null,
    42,
    "wr_ignored",
  ]), [
    { type: "task", id: "wt_1" },
    { type: "task", id: "wg_2" },
    { type: "deployment", id: "dep_1" },
    { type: "run", id: "other" },
    { type: "verification", id: "ver_1" },
    { type: "run", id: "run_2" },
  ]);
  assert.equal(u.inferTargetType(""), null);
  assert.deepEqual(u.inferTargetType("run_3"), { type: "run", id: "run_3" });
});

test("event summaries and canonical deployment hashes are stable", () => {
  assert.deepEqual(u.eventSummary({
    event_id: "e", event_type: "run.started", recorded_at: "r", occurred_at: "o", actor: {}, payload: { summary: "x".repeat(500) },
  }), {
    event_id: "e", event_type: "run.started", recorded_at: "r", occurred_at: "o", actor: {}, summary: "x".repeat(400),
  });
  assert.equal(u.canonicalJson({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
  assert.equal(u.deploymentPayloadDigest("x", { b: 1, a: 2 }), u.deploymentPayloadDigest("x", { a: 2, b: 1 }));
  assert.match(u.deploymentIdem("review", "dreq_1", "approved"), /^wh:deployment:review:[a-f0-9]{64}$/);
  assert.throws(() => u.deploymentIdem("", "part"), /domain is required/);
  assert.throws(() => u.deploymentIdem("review", ""), /component is required/);
});

test("returned event validation detects idempotency collisions", () => {
  const valid = { event_type: "deployment.reviewed", payload: { request_id: "dreq_1" } };
  assert.doesNotThrow(() => u.assertDeploymentReturnedEvent(valid, "deployment.reviewed", { request_id: "dreq_1" }));
  for (const bad of [null, {}, { event_type: "other", payload: {} }, { event_type: "deployment.reviewed" }]) {
    assert.throws(() => u.assertDeploymentReturnedEvent(bad, "deployment.reviewed"), /invalid/);
  }
  assert.throws(() => u.assertDeploymentReturnedEvent(valid, "deployment.reviewed", { request_id: "other" }), /mismatched/);
});

test("reference validators reject control syntax, secrets, bad schemes, and bounds", () => {
  assert.equal(u.deploymentString(null, "field", 10), "");
  assert.throws(() => u.deploymentString("", "field", 10, true), /required/);
  assert.throws(() => u.deploymentString(4, "field", 10), /must be a string/);
  assert.throws(() => u.deploymentString("x".repeat(11), "field", 10), /exceeds/);
  for (const value of ["a\nb", "a && b", "$(bad)", "secret=abcdefghijk", "Bearer abcdefgh"]) {
    assert.throws(() => u.deploymentString(value, "field", 100), /control syntax|secret-like/);
  }
  assert.equal(u.workHistoryRef("artifact://valid/path", "ref"), "artifact://valid/path");
  assert.equal(u.workHistoryRef("", "ref"), "");
  assert.throws(() => u.workHistoryRef("bad space", "ref"), /typed bounded/);
  assert.equal(u.deploymentRef("artifact://valid", "ref"), "artifact://valid");
  assert.equal(u.deploymentRef("", "ref"), "");
  assert.throws(() => u.deploymentRef("https://example.test", "ref"), /typed non-secret/);
  assert.equal(u.deploymentUrl("https://example.test/path", "url"), "https://example.test/path");
  assert.equal(u.deploymentUrl("", "url"), "");
  for (const value of ["bad", "http://example.test", "https://user:pass@example.test"]) {
    assert.throws(() => u.deploymentUrl(value, "url"), /https URL/);
  }
});

test("reference arrays and deployment candidates cover aliases and invalid shapes", () => {
  assert.deepEqual(u.refs(), []);
  assert.deepEqual(u.refs(["artifact://a", ""]), ["artifact://a"]);
  assert.throws(() => u.refs("bad"), /must be an array/);
  assert.throws(() => u.refs(Array(51).fill("x")), /exceeds 50/);
  assert.deepEqual(u.deploymentRefs(null, "refs"), []);
  assert.deepEqual(u.deploymentRefs(["artifact://a", ""], "refs"), ["artifact://a"]);
  assert.throws(() => u.deploymentRefs("bad", "refs"), /must be an array/);
  assert.throws(() => u.deploymentRefs(Array(51).fill("artifact://a"), "refs"), /exceeds 50/);
  assert.deepEqual(u.deploymentCandidateRefs(null), []);
  assert.deepEqual(u.deploymentCandidateRefs([
    "candidate-one",
    { candidateId: "candidate-two", target: "gateway", artifactRef: "artifact://two", provenanceRef: "provenance://two" },
    { id: "candidate-three" },
    {},
    [],
    null,
  ]), [
    { candidate_id: "candidate-one" },
    { candidate_id: "candidate-two", target: "gateway", artifact_ref: "artifact://two", provenance_ref: "provenance://two" },
    { candidate_id: "candidate-three", target: "", artifact_ref: "", provenance_ref: "" },
  ]);
  assert.equal(u.deploymentCandidateRefs(Array.from({ length: 25 }, (_, i) => `candidate-${i}`)).length, 20);
});

test("time and deployment selectors distinguish current records", () => {
  assert.equal(u.iso("", "fallback"), "fallback");
  assert.equal(u.iso("bad", "fallback"), "fallback");
  assert.equal(u.iso("2026-07-15T00:00:00Z", "fallback"), "2026-07-15T00:00:00.000Z");
  const oldPreview = preview({ deployment_id: "old", recorded_at: "2026-01-01" });
  const currentPreview = preview();
  const applied = { mode: "applied", status: "applied", deployment_id: "live", recorded_at: "2026-07-15" };
  const e = entry({ records: [oldPreview, applied, currentPreview], verifications: [verification({ status: "failed", finished_at: "2026-01-01" }), verification()] });
  assert.equal(u.latestPreviewRecord(e).deployment_id, "dep_preview");
  assert.equal(u.latestAppliedRecord(e).deployment_id, "live");
  assert.equal(u.latestDeploymentVerification(e).status, "passed");
  assert.equal(u.matchingPreviewVerification(e, null), null);
  assert.equal(u.matchingPreviewVerification(e, currentPreview).status, "passed");
  assert.equal(u.currentDeploymentClaim(e, "apply"), null);
  assert.equal(u.currentDeploymentEffect(e, "apply"), null);
  e.effects.set("apply", { effect_id: "effect-1" });
  assert.equal(u.currentDeploymentEffect(e, "apply", "wrong"), null);
  assert.equal(u.currentDeploymentEffect(e, "apply", "effect-1").effect_id, "effect-1");
  e.effect_adoptions.push({ operation: "apply", effect_id: "effect-1", adopted_at: "1" }, { operation: "apply", effect_id: "effect-1", adopted_at: "2" });
  assert.equal(u.currentEffectAdoption(e, "apply", "effect-1").adopted_at, "2");
  assert.equal(u.currentEffectAdoption(e, "rollback", "effect-1"), null);
  e.receipts.set("rollback", {});
  assert.equal(u.latestAppliedRecord(e), null);
});

test("claim expiry and deployment guards expose every state", () => {
  assert.equal(u.isClaimExpired(null), false);
  assert.equal(u.isClaimExpired({ lease_expires_at: "bad" }), false);
  assert.equal(u.isClaimExpired({ lease_expires_at: "2000-01-01" }), true);
  let e = entry();
  assert.deepEqual(u.deploymentApplyGuard(e), { status: "blocked", reason: "awaiting review approval" });
  e.review = { decision: "approved" };
  assert.match(u.deploymentApplyGuard(e).reason, /preview is not available/);
  e.records.push(preview({ status: "building" }));
  assert.match(u.deploymentApplyGuard(e).reason, /preview is not available/);
  e.records = [preview()];
  assert.match(u.deploymentApplyGuard(e).reason, /verification has not passed/);
  e.verifications.push(verification({ status: "failed" }));
  assert.equal(u.deploymentRequestStatus(e), "verification_failed");
  e.verifications.push(verification());
  assert.equal(u.deploymentApplyGuard(e).status, "ready");
  assert.equal(u.deploymentRequestStatus(e), "verified");
  e.receipts.set("apply", {});
  assert.match(u.deploymentApplyGuard(e).reason, /already receipted/);
  assert.equal(u.deploymentRequestStatus(e), "applied");
  assert.equal(u.deploymentRollbackGuard(e).status, "blocked");
  e.records.push({ mode: "applied", status: "applied", recorded_at: "2026-07-15" });
  assert.equal(u.deploymentRollbackGuard(e).status, "ready");
  e.receipts.set("rollback", {});
  assert.match(u.deploymentRollbackGuard(e).reason, /already receipted/);
  assert.equal(u.deploymentRequestStatus(e), "rolled_back");
  assert.equal(u.deploymentRequestBlockingReason(e), "");
});

test("deployment request statuses and blocking reasons cover claims and effects", () => {
  let e = entry({ review: { decision: "approved" } });
  assert.equal(u.deploymentRequestStatus(e), "approved");
  e.claims.set("preview", { worker_id: "p" });
  assert.equal(u.deploymentRequestStatus(e), "preview_claimed");
  e.claims.set("apply", { worker_id: "a" });
  assert.equal(u.deploymentRequestStatus(e), "apply_claimed");
  assert.match(u.deploymentRequestBlockingReason(e), /apply claimed/);
  e.effects.set("apply", {});
  assert.match(u.deploymentRequestBlockingReason(e), /apply effect observed/);
  e.claims.delete("apply");
  e.claims.set("rollback", { worker_id: "r" });
  assert.match(u.deploymentRequestBlockingReason(e), /rollback claimed/);
  e.effects.set("rollback", {});
  assert.match(u.deploymentRequestBlockingReason(e), /rollback effect observed/);
  e = entry({ review: { decision: "rejected" } });
  assert.equal(u.deploymentRequestStatus(e), "rejected");
  e = entry({ records: [preview()] });
  assert.equal(u.deploymentRequestStatus(e), "preview_available");
});

test("operation claim guards reject missing, duplicate, stale, and unsafe work", () => {
  assert.throws(() => u.assertDeploymentOperationClaimable(null, "preview"), /not found/);
  let e = entry({ review: { decision: "approved" } });
  e.effects.set("preview", {});
  assert.throws(() => u.assertDeploymentOperationClaimable(e, "preview"), /effect is already observed/);
  e.effects.clear();
  e.claims.set("preview", { worker_id: "worker", lease_expires_at: "2099-01-01" });
  assert.throws(() => u.assertDeploymentOperationClaimable(e, "preview"), /already claimed/);
  e.claims.clear();
  assert.doesNotThrow(() => u.assertDeploymentOperationClaimable(e, "preview"));
  e.review = null;
  assert.throws(() => u.assertDeploymentOperationClaimable(e, "preview"), /awaiting review/);
  e = entry({ review: { decision: "approved" }, records: [preview()], verifications: [verification()] });
  assert.throws(() => u.assertDeploymentOperationClaimable(e, "preview"), /verified available preview/);
  assert.doesNotThrow(() => u.assertDeploymentOperationClaimable(e, "apply"));
  assert.throws(() => u.assertDeploymentOperationClaimable(entry(), "apply"), /cannot apply/);
  assert.throws(() => u.assertDeploymentOperationClaimable(entry(), "rollback"), /cannot roll back/);
});

test("claim, receipt, effect, and observed-evidence assertions cover authority failures", () => {
  const e = entry();
  const claim = { worker_id: "worker", claim_id: "claim", lease_expires_at: "2099-01-01" };
  assert.throws(() => u.assertDeploymentOperationClaim(e, { operation: "apply", worker: "worker", claim_id: "claim" }), /no apply claim/);
  assert.throws(() => u.assertDeploymentOperationClaim(e, { operation: "apply", worker: "other", claim_id: "claim", claim }), /claimed by/);
  assert.throws(() => u.assertDeploymentOperationClaim(e, { operation: "apply", worker: "worker", claim_id: "wrong", claim }), /claim is stale/);
  assert.doesNotThrow(() => u.assertDeploymentOperationClaim(e, { operation: "apply", worker: "worker", claim_id: "claim", claim, require_fresh: true }));
  assert.throws(() => u.assertDeploymentOperationClaim(e, { operation: "apply", worker: "worker", claim_id: "claim", claim: { ...claim, lease_expires_at: "2000-01-01" }, require_fresh: true }), /lease expired/);

  assert.doesNotThrow(() => u.assertDeploymentReceiptAuthority(e, { operation: "apply", worker: "worker", claimId: "claim", claim, observed: { worker_id: "worker", claim_id: "claim" } }));
  assert.throws(() => u.assertDeploymentReceiptAuthority(e, { operation: "apply", worker: "worker", claimId: "claim", claim, observed: { worker_id: "old", claim_id: "old", effect_id: "effect" } }), /recorded adoption/);
  e.effect_adoptions.push({ operation: "apply", effect_id: "effect", adopted_by_worker_id: "other", adopted_claim_id: "claim", adopted_at: "1" });
  assert.throws(() => u.assertDeploymentReceiptAuthority(e, { operation: "apply", worker: "worker", claimId: "claim", claim, observed: { worker_id: "old", claim_id: "old", effect_id: "effect" } }), /adopted claim/);
  e.effect_adoptions.push({ operation: "apply", effect_id: "effect", adopted_by_worker_id: "worker", adopted_claim_id: "claim", adopted_at: "2" });
  assert.doesNotThrow(() => u.assertDeploymentReceiptAuthority(e, { operation: "apply", worker: "worker", claimId: "claim", claim, observed: { worker_id: "old", claim_id: "old", effect_id: "effect" } }));

  e.effects.set("apply", {});
  assert.throws(() => u.assertDeploymentEffectAllowed(e, "apply"), /already has/);
  e.effects.clear();
  assert.throws(() => u.assertDeploymentEffectAllowed(e, "apply"), /cannot apply/);
  assert.throws(() => u.assertDeploymentEffectAllowed(e, "rollback"), /cannot roll back/);
});

test("observed effects require complete rollout and rollback evidence", () => {
  const apply = { operation: "apply", backup_record_ref: "b", restore_check_ref: "r", smoke_artifact_ref: "s", drain_status: "drained", compatibility_status: "compatible", rollback_ref: "rb" };
  assert.doesNotThrow(() => u.assertDeploymentObservedEffect(entry(), apply));
  for (const [field, message] of [
    ["backup_record_ref", /backup_record_ref/], ["restore_check_ref", /backup_record_ref/], ["smoke_artifact_ref", /smoke_artifact_ref/],
    ["drain_status", /drain_status/], ["compatibility_status", /compatibility_status/], ["rollback_ref", /rollback_ref/],
  ]) {
    assert.throws(() => u.assertDeploymentObservedEffect(entry(), { ...apply, [field]: "" }), message);
  }
  assert.doesNotThrow(() => u.assertDeploymentObservedEffect(entry(), { operation: "rollback", rollback_ref: "r", smoke_artifact_ref: "s" }));
  assert.throws(() => u.assertDeploymentObservedEffect(entry(), { operation: "rollback", smoke_artifact_ref: "s" }), /rollback_ref/);
  assert.throws(() => u.assertDeploymentObservedEffect(entry(), { operation: "rollback", rollback_ref: "r" }), /smoke_artifact_ref/);
});
