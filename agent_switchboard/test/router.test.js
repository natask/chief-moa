import assert from "node:assert/strict";
import test from "node:test";
import { createDeterministicRouter, validateEnvelope } from "../src/index.js";

const router = createDeterministicRouter();
const snapshot = {
  revision: 8,
  intents: [
    { intent_id: "intent_alpha", title: "Alpha router", objective: "Build routing client", status: "active" },
    { intent_id: "intent_beta", title: "Beta docs", objective: "Write integration guide", status: "active" },
  ],
  agents: [{ agent_id: "agent_alpha", intent_id: "intent_alpha", status: "running" }],
};
const envelope = (text, id = text.replace(/\W/g, "_")) => validateEnvelope({
  envelope_id: `env_${id}`,
  occurred_at: "2026-07-26T10:00:00.000Z",
  message: { role: "user", text },
  context: {},
});

test("routes every supported explicit action deterministically", () => {
  const cases = [
    ["observation intent_alpha: tests are green", "observation"],
    ["new unrelated capture", "new"],
    ["routing client needs recovery", "update"],
    ["fork intent_alpha into schema review", "fork"],
    ["merge intent_alpha intent_beta", "merge"],
    ["status intent_alpha", "status"],
    ["steer intent_alpha keep history visible", "steer"],
    ["launch intent_alpha", "launch"],
  ];
  for (const [message, expected] of cases) {
    const first = router.route({ envelope: envelope(message), snapshot });
    const second = router.route({ envelope: envelope(message), snapshot });
    assert.equal(first.action.type, expected, message);
    assert.deepEqual(first, second, "same envelope and snapshot must yield the same decision");
    assert.equal(first.source_envelope_id, envelope(message).envelope_id);
    assert.equal(first.visibility, "required");
    assert.equal(first.reversible, true);
  }
});

test("leaves weak unmatched prose as a new intent", () => {
  const decision = router.route({ envelope: envelope("photograph garden seed packets"), snapshot });
  assert.equal(decision.action.type, "new");
  assert.equal(decision.confidence, 0.6);
});
