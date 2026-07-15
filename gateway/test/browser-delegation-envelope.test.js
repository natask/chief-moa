"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  VERSION,
  browserActionAllowedByEnvelope,
  validateBrowserDelegationEnvelope,
} = require("../lib/browser-delegation-envelope");

function envelope(intent = "Create the project", url = "https://example.test/projects") {
  return {
    version: VERSION,
    confirmation: { confirmed: true, user_intent: intent },
    goal: intent,
    scope: { page_url: url, allowed_origins: [new URL(url).origin] },
    allowed_action_classes: ["click", "type", "navigate", "wait"],
    approval_policy: { preauthorized: ["click", "type", "wait"], always_ask: ["navigate"] },
    checkpoints: ["before external submit"],
    stop_conditions: ["goal complete", "scope changed", "evidence stale"],
    max_steps: 12,
    completion_evidence: ["project identity", "task count"],
  };
}

test("confirmed envelope is normalized and bound to current intent and page", () => {
  const result = validateBrowserDelegationEnvelope(envelope(), {
    turnText: "Create the project",
    pageUrl: "https://example.test/projects",
  });
  assert.equal(result.ok, true);
  assert.equal(result.envelope.version, VERSION);
  assert.equal(result.envelope.max_steps, 12);
  assert.deepEqual(result.envelope.scope.allowed_origins, ["https://example.test"]);
});

test("missing, stale, and overbroad confirmations fail closed", () => {
  const missing = validateBrowserDelegationEnvelope(null, { turnText: "x", pageUrl: "https://example.test/" });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.length >= 8);

  const bad = envelope();
  bad.confirmation.user_intent = "Different intent";
  bad.scope.page_url = "javascript:alert(1)";
  bad.scope.allowed_origins = ["file:///tmp/x"];
  bad.allowed_action_classes = ["eval"];
  bad.approval_policy = { preauthorized: ["click"], always_ask: ["click"] };
  bad.max_steps = 100;
  const rejected = validateBrowserDelegationEnvelope(bad, {
    turnText: "Create the project",
    pageUrl: "https://example.test/projects",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join("\n"), /must match the current turn text/);
  assert.match(rejected.errors.join("\n"), /max_steps/);
});

test("planner policy enforces observed origin, class, approval, and navigation origin", () => {
  const valid = validateBrowserDelegationEnvelope(envelope(), {
    turnText: "Create the project",
    pageUrl: "https://example.test/projects",
  }).envelope;
  assert.deepEqual(browserActionAllowedByEnvelope({ kind: "click", index: 1 }, valid, { url: "https://example.test/projects" }), { ok: true });
  assert.match(browserActionAllowedByEnvelope({ kind: "scroll" }, valid, { url: "https://example.test/projects" }).reason, /outside delegated scope/);
  assert.match(browserActionAllowedByEnvelope({ kind: "navigate", url: "https://example.test/next" }, valid, { url: "https://example.test/projects" }).reason, /requires a new user approval/);
  const navigationApproved = {
    ...valid,
    approval_policy: { preauthorized: [...valid.approval_policy.preauthorized, "navigate"], always_ask: [] },
  };
  assert.match(browserActionAllowedByEnvelope({ kind: "navigate", url: "https://evil.test/" }, navigationApproved, { url: "https://example.test/projects" }).reason, /navigation origin is outside/);
  assert.match(browserActionAllowedByEnvelope({ kind: "click" }, valid, { url: "https://evil.test/" }).reason, /outside delegated scope/);
  assert.deepEqual(browserActionAllowedByEnvelope({ kind: "finish" }, valid, { url: "https://example.test/" }), { ok: true });
  assert.deepEqual(browserActionAllowedByEnvelope({ kind: "anything" }, null, {}), { ok: true });
});
