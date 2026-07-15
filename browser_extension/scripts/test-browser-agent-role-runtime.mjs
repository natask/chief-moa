import assert from "node:assert/strict";
import { browserDelegationEnvelope, normalizeBrowserAgentRole } from "../extension/browser-agent-role-runtime.js";

assert.equal(normalizeBrowserAgentRole(" Delegate "), "delegate");
assert.equal(normalizeBrowserAgentRole("HELP"), "help");
assert.equal(normalizeBrowserAgentRole("unknown"), "");

const envelope = browserDelegationEnvelope("  create   the project  ", "https://example.test/current?tab=1");
assert.equal(envelope.version, "moa.browser-delegation.v1");
assert.deepEqual(envelope.confirmation, { confirmed: true, user_intent: "create the project" });
assert.equal(envelope.goal, "create the project");
assert.equal(envelope.scope.page_url, "https://example.test/current?tab=1");
assert.deepEqual(envelope.scope.allowed_origins, ["https://example.test"]);
assert.ok(envelope.approval_policy.preauthorized.includes("click"));
assert.deepEqual(envelope.approval_policy.always_ask, ["navigate"]);
assert.equal(envelope.max_steps, 20);
assert.throws(() => browserDelegationEnvelope("task", "chrome://settings"));

console.log("browser agent role runtime tests passed");
