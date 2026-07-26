import { createDeterministicRouter, createMemoryDecisionStore, createSwitchboardClient } from "../src/index.js";

const intents = [{ intent_id: "intent_switchboard", title: "Build Agent Switchboard", objective: "Ship a reversible router", status: "active" }];
const intentManagement = {
  async readSnapshot() { return { revision: 1, intents, agents: [] }; },
  async readAttention() { return [{ kind: "needs_user", intent_id: "intent_switchboard" }]; },
  async readIntent(id) { return intents.find((item) => item.intent_id === id); },
};
const client = createSwitchboardClient({
  intentManagement,
  router: createDeterministicRouter(),
  decisionStore: createMemoryDecisionStore(),
});
const review = await client.inspect([{
  envelope_id: "env_example_1",
  occurred_at: "2026-07-26T10:00:00.000Z",
  message: { role: "user", text: "status intent_switchboard" },
  context: { product: { name: "Chief MOA" } },
}]);
console.log(JSON.stringify(review, null, 2));
