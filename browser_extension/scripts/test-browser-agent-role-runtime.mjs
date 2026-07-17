import assert from "node:assert/strict";
import { browserDelegationEnvelope, browserIntentActionClasses, normalizeBrowserAgentRole } from "../extension/browser-agent-role-runtime.js";

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
assert.deepEqual(envelope.approval_policy.preauthorized, ["click", "type"]);
assert.deepEqual(envelope.approval_policy.always_ask, ["navigate", "sensitive", "destructive"]);
assert.equal(envelope.max_steps, 20);
assert.throws(() => browserDelegationEnvelope("task", "chrome://settings"));
assert.deepEqual(browserIntentActionClasses("scroll and capture a screenshot"), ["scroll", "screenshot"]);
assert.deepEqual(browserIntentActionClasses("organize this page"), ["click", "scroll", "wait"]);

console.log("browser agent role runtime tests passed");
