import assert from "node:assert/strict";
import { browserDelegationEnvelope, browserIntentActionClasses, browserIntentEffectClasses, normalizeBrowserAgentRole } from "../extension/browser-agent-role-runtime.js";

assert.equal(normalizeBrowserAgentRole(" Delegate "), "delegate");
assert.equal(normalizeBrowserAgentRole("HELP"), "help");
assert.equal(normalizeBrowserAgentRole("unknown"), "");

const envelope = browserDelegationEnvelope("  create   the project  ", "https://example.test/current?tab=1");
assert.equal(envelope.version, "moa.browser-delegation.v1");
assert.deepEqual(envelope.confirmation, { confirmed: true, source: "user_submission", user_intent: "create the project" });
assert.equal(envelope.goal, "create the project");
assert.equal(envelope.scope.page_url, "https://example.test/current?tab=1");
assert.deepEqual(envelope.scope.allowed_origins, ["https://example.test"]);
assert.deepEqual(envelope.allowed_action_classes, ["click", "type"]);
assert.deepEqual(envelope.allowed_effect_classes, []);
assert.deepEqual(envelope.approval_policy.preauthorized, ["click", "type"]);
assert.deepEqual(envelope.approval_policy.always_ask, []);
assert.deepEqual(envelope.approval_policy.always_ask_effects, []);
assert.equal(envelope.max_steps, 20);
assert.throws(() => browserDelegationEnvelope("task", "chrome://settings"));
assert.deepEqual(browserIntentActionClasses("scroll and capture a screenshot"), ["scroll", "screenshot"]);
assert.deepEqual(browserIntentActionClasses("organize this page"), ["click", "scroll", "wait"]);

const sensitiveIntents = [
  ["submit it", "external_submit"],
  ["send this email", "external_submit"],
  ["delete it", "destructive"],
  ["buy it", "purchase"],
  ["purchase it", "purchase"],
  ["pay it", "payment"],
  ["checkout", "checkout"],
  ["enter my password", "credential"],
];
for (const [intent, effectClass] of sensitiveIntents) {
  assert.deepEqual(browserIntentEffectClasses(intent), [effectClass], intent);
  const sensitive = browserDelegationEnvelope(intent, "https://example.test/current");
  assert.deepEqual(sensitive.allowed_effect_classes, [effectClass], intent);
  assert.deepEqual(sensitive.approval_policy.always_ask_effects, [effectClass], intent);
  assert.ok(sensitive.checkpoints.includes(`before_effect:${effectClass}`), intent);
  assert.ok(!sensitive.approval_policy.preauthorized.includes("click"), intent);
  assert.ok(!sensitive.approval_policy.preauthorized.includes("type"), intent);
}

assert.deepEqual(browserIntentEffectClasses("scroll and read this page"), []);

console.log("browser agent role runtime tests passed");
