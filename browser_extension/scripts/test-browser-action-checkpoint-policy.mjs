import assert from "node:assert/strict";
import test from "node:test";
import {
  CHECKPOINT_MAX_AGE_MS,
  authorizeBrowserActionAttempt,
  classifyBrowserActionCheckpoint,
} from "../extension/browser-action-checkpoint-policy.js";

const NOW = 10_000;

function request(effect, overrides = {}) {
  return {
    task_id: "task-1",
    envelope_digest: "sha256:envelope-1",
    anchor_id: "anchor-1",
    before_hash: "sha256:before-1",
    background: false,
    effect,
    ...overrides,
  };
}

function approval(overrides = {}) {
  return {
    approval_id: "approval-1",
    task_id: "task-1",
    envelope_digest: "sha256:envelope-1",
    anchor_id: "anchor-1",
    before_hash: "sha256:before-1",
    issued_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 1_000,
    ...overrides,
  };
}

test("buy, pay, order, checkout, credential, submit, and destructive effects require checkpoints", () => {
  const effects = [
    { kind: "buy" },
    { action: "pay" },
    { effect_class: "dom.mutate", operation: "checkout" },
    { intent: "place-order" },
    { effect_class: "checkout" },
    { risk: "payment" },
    { input_type: "password" },
    { category: "external_submit" },
    { sensitivity: "destructive" },
    { label: "Place the order" },
    { description: "Delete account" },
  ];
  for (const effect of effects) {
    assert.equal(classifyBrowserActionCheckpoint(effect).required, true, JSON.stringify(effect));
    assert.equal(authorizeBrowserActionAttempt(request(effect), {}, { now: NOW }).code, "checkpoint_required");
  }
  assert.deepEqual(classifyBrowserActionCheckpoint({ kind: "scroll", label: "Read more" }), {
    required: false,
    reason: "known_safe",
  });
});

test("semantic fields cannot hide sensitive operations behind generic mutation actions", () => {
  const effects = [
    { effect_class: "dom.mutate", operation: "checkout" },
    { effect_class: "dom.mutate", action: "click", label: "Buy now" },
    { effect_class: "dom.mutate", action: "click", description: "Pay invoice" },
    { effect_class: "dom.mutate", operation: "type", label: "Password" },
    { effect_class: "dom.mutate", operation: "click", intent_text: "Submit application" },
    { effect_class: "dom.mutate", operation: "click", label: "Delete file" },
  ];
  for (const effect of effects) {
    const classified = classifyBrowserActionCheckpoint(effect);
    assert.equal(classified.required, true, JSON.stringify(effect));
    assert.notEqual(classified.reason, "unknown_side_effect", JSON.stringify(effect));
  }
});

test("malformed and unknown potentially effectful actions fail closed while explicit reads remain open", () => {
  for (const effect of [null, undefined, "click", [], {}, { action: "click" }, { effect_class: "dom.mutate" }]) {
    assert.equal(classifyBrowserActionCheckpoint(effect).required, true, String(effect));
  }

  for (const effect of [
    { effect_class: "read" },
    { effect_class: "dom-read", operation: "extract-text" },
    { kind: "observe", action: "screenshot" },
    { operation: "get-attribute" },
  ]) {
    assert.deepEqual(classifyBrowserActionCheckpoint(effect), { required: false, reason: "known_safe" });
    assert.equal(authorizeBrowserActionAttempt(request(effect), {}, { now: NOW }).ok, true);
  }
});

test("one fresh exact approval permits one foreground attempt", () => {
  const first = authorizeBrowserActionAttempt(
    request({ kind: "checkout" }, { approval: approval() }),
    {},
    { now: NOW },
  );
  assert.equal(first.ok, true);
  assert.equal(first.approval_id, "approval-1");
  assert.deepEqual(first.state, { consumed_approval_ids: ["approval-1"] });

  const replay = authorizeBrowserActionAttempt(
    request({ kind: "checkout" }, { approval: approval() }),
    first.state,
    { now: NOW },
  );
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "checkpoint_replayed");
  assert.deepEqual(replay.state, first.state);
});

test("expiry, excessive lifetime, future issue time, and exact binding mismatches fail closed", () => {
  const expired = approval({ issued_at_ms: NOW - 2_000, expires_at_ms: NOW });
  assert.equal(authorizeBrowserActionAttempt(request({ kind: "pay" }, { approval: expired }), {}, { now: NOW }).code, "checkpoint_expired");

  const longLived = approval({ issued_at_ms: NOW, expires_at_ms: NOW + CHECKPOINT_MAX_AGE_MS + 1 });
  assert.equal(authorizeBrowserActionAttempt(request({ kind: "pay" }, { approval: longLived }), {}, { now: NOW }).code, "checkpoint_expired");

  const future = approval({ issued_at_ms: NOW + 1, expires_at_ms: NOW + 1_000 });
  assert.equal(authorizeBrowserActionAttempt(request({ kind: "pay" }, { approval: future }), {}, { now: NOW }).code, "checkpoint_expired");

  for (const field of ["task_id", "envelope_digest", "anchor_id", "before_hash"]) {
    const changed = approval({ [field]: `different-${field}` });
    const result = authorizeBrowserActionAttempt(request({ kind: "pay" }, { approval: changed }), {}, { now: NOW });
    assert.equal(result.code, "checkpoint_mismatch", field);
  }
});

test("background execution and incomplete current bindings fail closed", () => {
  const background = authorizeBrowserActionAttempt(
    request({ kind: "purchase" }, { background: true, approval: approval() }),
    {},
    { now: NOW },
  );
  assert.equal(background.code, "checkpoint_background_denied");

  for (const field of ["task_id", "envelope_digest", "anchor_id", "before_hash"]) {
    const result = authorizeBrowserActionAttempt(
      request({ kind: "submit" }, { [field]: "", approval: approval() }),
      {},
      { now: NOW },
    );
    assert.equal(result.code, "checkpoint_binding_invalid", field);
  }
});

test("ordinary effects need no checkpoint and do not consume approval state", () => {
  const state = { consumed_approval_ids: ["approval-old"] };
  const result = authorizeBrowserActionAttempt(request({ kind: "scroll" }, { background: true }), state, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.checkpoint.required, false);
  assert.deepEqual(result.state, state);
  assert.notEqual(result.state, state);
});
