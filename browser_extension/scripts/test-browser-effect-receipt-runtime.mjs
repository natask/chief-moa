import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RECEIPTS,
  RECEIPT_VERSION,
  createBrowserEffectReceipt,
  recordBrowserEffectAttempt,
} from "../extension/browser-effect-receipt-runtime.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function attempt(overrides = {}) {
  return {
    idempotency_key: "attempt-key-1",
    effect_attempt_id: "effect-attempt-1",
    attempted_at: "2026-07-29T12:00:00.000Z",
    task_id: "task-1",
    run_id: "run-1",
    delegation_envelope_id: "envelope-1",
    executor: { surface: "browser_extension", executor_id: "executor-1", device_id: "device-1", version: "1.2.3" },
    execution_profile: { profile_id: "delegated_runtime_v1", revision: 3, digest: HASH_A },
    target: { tab_id: 17, document_id: "document-1", frame_id: 0, origin: "https://shop.example" },
    anchor: { anchor_id: "anchor-1", observation_id: "observation-1", node_identity_digest: HASH_B },
    effect: { effect_class: "dom.mutate", operation: "element.insert", sensitivity: "sensitive", checkpoint_required: true },
    before_after: { before_digest: HASH_A, after_digest: HASH_B, changed: true, verification: "matched" },
    checkpoint: { status: "approved", checkpoint_id: "checkpoint-1", approval_id: "approval-1", binding_digest: HASH_A },
    result: { status: "succeeded", code: "effect_applied", summary: "Inserted one bounded annotation.", evidence_refs: ["evidence-1"] },
    error: null,
    cleanup: { status: "not_needed", code: "none", evidence_refs: [] },
    rollback: { status: "pending", code: "rollback_available", evidence_refs: ["rollback-1"] },
    ...overrides,
  };
}

test("receipt binds every execution authority and effect outcome", () => {
  const receipt = createBrowserEffectReceipt(attempt());
  assert.equal(receipt.version, RECEIPT_VERSION);
  assert.equal(receipt.receipt_id, "ber_attempt-key-1");
  assert.equal(receipt.task_id, "task-1");
  assert.equal(receipt.run_id, "run-1");
  assert.equal(receipt.delegation_envelope_id, "envelope-1");
  assert.deepEqual(receipt.executor, { surface: "browser_extension", executor_id: "executor-1", device_id: "device-1", version: "1.2.3" });
  assert.equal(receipt.execution_profile.digest, HASH_A);
  assert.deepEqual(receipt.target, { tab_id: 17, document_id: "document-1", frame_id: 0, origin: "https://shop.example" });
  assert.equal(receipt.anchor.node_identity_digest, HASH_B);
  assert.equal(receipt.before_after.after_digest, HASH_B);
  assert.equal(receipt.checkpoint.approval_id, "approval-1");
  assert.equal(receipt.result.status, "succeeded");
  assert.equal(receipt.cleanup.status, "not_needed");
  assert.equal(receipt.rollback.status, "pending");
  assert.equal(Object.isFrozen(receipt), true);
});

test("same attempt is one stable receipt and conflicting replay fails", () => {
  const first = recordBrowserEffectAttempt([], attempt());
  const replay = recordBrowserEffectAttempt(first.receipts, attempt({ ignored_runtime_value: Math.random() }));
  assert.equal(first.idempotent_replay, false);
  assert.equal(replay.idempotent_replay, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(replay.receipts.length, 1);
  const duplicatedLedger = recordBrowserEffectAttempt([first.receipt, first.receipt], attempt());
  assert.equal(duplicatedLedger.receipts.length, 1);
  assert.throws(
    () => recordBrowserEffectAttempt(first.receipts, attempt({ result: { ...attempt().result, summary: "Different success claim." } })),
    /idempotency conflict/,
  );
});

test("receipt excludes raw source, page content, arbitrary result data, and secrets", () => {
  const value = attempt({
    source: "document.documentElement.outerHTML",
    page: "<html>full page</html>",
    result: {
      ...attempt().result,
      summary: "authorization=Bearer-secret token=private-token sk_live_abcdefghijk",
      raw: { html: "<html>full page</html>", cookie: "session-secret" },
    },
    error: { code: "executor_failed", stage: "execute", retryable: false, summary: "Bearer top-secret password=hunter2" },
  });
  value.result.status = "failed";
  const receipt = createBrowserEffectReceipt(value);
  const json = JSON.stringify(receipt);
  assert.equal(json.includes("outerHTML"), false);
  assert.equal(json.includes("full page"), false);
  assert.equal(json.includes("private-token"), false);
  assert.equal(json.includes("abcdefghijk"), false);
  assert.equal(json.includes("hunter2"), false);
  assert.match(receipt.result.summary, /\[REDACTED\]/);
  assert.match(receipt.error.summary, /\[REDACTED\]/);
});

test("failed and indeterminate attempts still produce bounded receipts", () => {
  for (const status of ["failed", "indeterminate"]) {
    const receipt = createBrowserEffectReceipt(attempt({
      idempotency_key: `attempt-${status}`,
      effect_attempt_id: `effect-${status}`,
      result: { status, code: `effect_${status}`, summary: "x".repeat(2_000), evidence_refs: Array.from({ length: 8 }, (_, index) => `evidence-${index}`) },
      error: { code: "effect_error", stage: "execute", retryable: status === "failed", summary: "y".repeat(2_000) },
    }));
    assert.equal(receipt.result.summary.length, 500);
    assert.equal(receipt.error.summary.length, 500);
    assert.ok(new TextEncoder().encode(JSON.stringify(receipt)).byteLength < 16 * 1024);
  }
});

test("impossible sensitive success receipts fail closed", () => {
  for (const checkpoint of [
    { status: "not_required", checkpoint_id: null, approval_id: null, binding_digest: null },
    { status: "approved", checkpoint_id: null, approval_id: "approval-1", binding_digest: HASH_A },
    { status: "approved", checkpoint_id: "checkpoint-1", approval_id: null, binding_digest: HASH_A },
    { status: "approved", checkpoint_id: "checkpoint-1", approval_id: "approval-1", binding_digest: null },
  ]) {
    assert.throws(() => createBrowserEffectReceipt(attempt({ checkpoint })), /requires bound approval/);
  }
  assert.throws(() => createBrowserEffectReceipt(attempt({
    before_after: { ...attempt().before_after, after_digest: null },
  })), /requires an after digest/);
  for (const verification of ["mismatched", "failed", "unavailable"]) {
    assert.throws(() => createBrowserEffectReceipt(attempt({
      before_after: { ...attempt().before_after, verification },
    })), /requires matched verification/);
  }
});

test("failed, cancelled, cleanup, and rollback semantics cannot overclaim", () => {
  assert.throws(() => createBrowserEffectReceipt(attempt({
    result: { ...attempt().result, status: "failed" },
    error: null,
  })), /failed browser effect requires an error/);

  const cancelled = attempt({
    result: { status: "cancelled", code: "user_cancelled", summary: "Cancelled before execution.", evidence_refs: [] },
    error: null,
    before_after: { before_digest: HASH_A, after_digest: null, changed: false, verification: "unavailable" },
    checkpoint: { status: "required", checkpoint_id: "checkpoint-1", approval_id: null, binding_digest: HASH_A },
    cleanup: { status: "not_needed", code: "none", evidence_refs: [] },
    rollback: { status: "not_needed", code: "none", evidence_refs: [] },
  });
  assert.equal(createBrowserEffectReceipt(cancelled).result.status, "cancelled");
  const blocked = createBrowserEffectReceipt({
    ...cancelled,
    idempotency_key: "attempt-blocked",
    effect_attempt_id: "effect-blocked",
    result: { status: "blocked", code: "approval_required", summary: "Awaiting approval.", evidence_refs: [] },
  });
  assert.equal(blocked.result.status, "blocked");
  assert.throws(() => createBrowserEffectReceipt({
    ...cancelled,
    before_after: { ...cancelled.before_after, changed: true, after_digest: HASH_B },
  }), /cancelled browser effect cannot claim a state change/);
  assert.throws(() => createBrowserEffectReceipt({
    ...cancelled,
    rollback: { status: "succeeded", code: "rolled_back", evidence_refs: [] },
  }), /rollback.succeeded requires evidence/);
  assert.throws(() => createBrowserEffectReceipt(attempt({
    cleanup: { status: "succeeded", code: "cleaned", evidence_refs: [] },
  })), /cleanup.succeeded requires evidence/);
});

test("invalid scope, unbounded collections, and a full ledger fail closed", () => {
  for (const corruptLedger of [null, {}, { receipts: [] }, "[]"]) {
    assert.throws(
      () => recordBrowserEffectAttempt(corruptLedger, attempt()),
      /ledger must be an array/,
    );
  }
  assert.throws(() => createBrowserEffectReceipt(attempt({ target: { ...attempt().target, origin: "https://user:secret@shop.example/path" } })), /target.origin/);
  assert.throws(() => createBrowserEffectReceipt(attempt({ result: { ...attempt().result, evidence_refs: Array.from({ length: 9 }, (_, index) => `ref-${index}`) } })), /result.evidence_refs/);
  assert.throws(() => createBrowserEffectReceipt(attempt({ task_id: "" })), /task_id/);

  const ledger = Array.from({ length: MAX_RECEIPTS }, (_, index) => createBrowserEffectReceipt(attempt({
    idempotency_key: `key-${index}`,
    effect_attempt_id: `effect-${index}`,
  })));
  assert.throws(() => recordBrowserEffectAttempt(ledger, attempt({ idempotency_key: "overflow", effect_attempt_id: "overflow" })), /ledger is full/);
});
