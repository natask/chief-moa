import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeterministicRouter,
  createMemoryDecisionStore,
  createSwitchboardClient,
} from "../src/index.js";

const makeEnvelope = (text, id = "1", occurredAt = "2026-07-26T10:00:00.000Z") => ({
  envelope_id: `env_${id}`,
  occurred_at: occurredAt,
  message: { role: "user", text },
  context: { product: { id: "chief-moa" }, provenance: { capture_id: `cap_${id}` } },
});

function harness() {
  const calls = [];
  const store = createMemoryDecisionStore();
  const intentManagement = {
    async readSnapshot() {
      calls.push("snapshot");
      return {
        revision: 3,
        intents: [{ intent_id: "intent_alpha", title: "Alpha", objective: "Ship alpha", status: "active" }],
        agents: [{ agent_id: "agent_alpha", intent_id: "intent_alpha", status: "running" }],
      };
    },
    async readAttention() { calls.push("attention"); return [{ notification_id: "note_1", receipt_state: "pending" }]; },
    async readIntent(intentId) { calls.push(`status:${intentId}`); return { intent_id: intentId, status: "active" }; },
    async updateIntent(intentId, input) { calls.push(`update:${intentId}`); return { intent_id: intentId, ...input }; },
    async createIntent(input) { calls.push("create"); return { intent_id: "intent_new", ...input }; },
    async recordObservation(input) { calls.push("observe"); return { intent_id: input.intent_id, observation_id: "obs_1" }; },
    async mergeIntents(input) { calls.push("merge"); return { intent_id: input.target_intent_id }; },
  };
  const launcher = {
    async launchOrReopen(input) { calls.push("launch"); return { intent_id: input.intent_id, run_id: "run_1" }; },
  };
  const durableMessages = {
    async supports() { calls.push("supports"); return true; },
    async send(input) { calls.push("send"); return { intent_id: input.intent_id, message_id: "msg_1" }; },
  };
  return {
    calls, store,
    client: createSwitchboardClient({
      intentManagement, launcher, durableMessages,
      router: createDeterministicRouter(), decisionStore: store,
    }),
  };
}

test("queries intent and attention before routing and never executes during inspect", async () => {
  const { client, calls } = harness();
  const result = await client.inspect([makeEnvelope("launch intent_alpha")]);
  assert.deepEqual(calls, ["snapshot", "attention"]);
  assert.equal(result.decisions[0].action.type, "launch");
  assert.equal(result.attention[0].notification_id, "note_1");
});

test("rejects non-chronological and duplicate envelopes", async () => {
  const { client } = harness();
  await assert.rejects(
    client.inspect([makeEnvelope("one", "1", "2026-07-26T11:00:00Z"), makeEnvelope("two", "2", "2026-07-26T10:00:00Z")]),
    /chronological/,
  );
  await assert.rejects(client.inspect([makeEnvelope("one"), makeEnvelope("two")]), /unique/);
});

test("apply requires confirmation and captures launcher run receipt", async () => {
  const { client, calls } = harness();
  const { decisions } = await client.inspect([makeEnvelope("launch intent_alpha")]);
  await assert.rejects(client.apply(decisions[0].decision_id), /confirmed/);
  assert.equal(calls.includes("launch"), false);
  const applied = await client.apply(decisions[0].decision_id, { confirmed: true });
  assert.equal(applied.state, "applied");
  assert.deepEqual(applied.links.run_ids, ["run_1"]);
  assert.equal(calls.at(-1), "launch");
});

test("steering uses only durable messages and links its receipt", async () => {
  const { client, calls } = harness();
  const { decisions } = await client.inspect([makeEnvelope("steer intent_alpha continue carefully")]);
  const applied = await client.apply(decisions[0].decision_id, { confirmed: true });
  assert.deepEqual(calls.slice(-2), ["supports", "send"]);
  assert.deepEqual(applied.links.message_ids, ["msg_1"]);
});

test("unsupported durable steering fails closed", async () => {
  const store = createMemoryDecisionStore();
  const client = createSwitchboardClient({
    intentManagement: {
      async readSnapshot() { return { revision: 1, intents: [], agents: [] }; },
      async readAttention() { return []; },
    },
    router: createDeterministicRouter(),
    decisionStore: store,
    durableMessages: { async supports() { return false; }, async send() { assert.fail("must not send"); } },
  });
  const { decisions } = await client.inspect([makeEnvelope("steer do it")]);
  await assert.rejects(client.apply(decisions[0].decision_id, { confirmed: true }), /does not support/);
  assert.equal((await store.get(decisions[0].decision_id)).state, "proposed");
});

test("reverse preserves original and creates a visible compensating decision", async () => {
  const { client } = harness();
  const { decisions } = await client.inspect([makeEnvelope("Alpha needs an update")]);
  const compensation = await client.reverse(decisions[0].decision_id, "wrong target");
  assert.equal(compensation.reverses, decisions[0].decision_id);
  assert.equal(compensation.action.type, "observation");
  assert.equal((await client.getDecision(decisions[0].decision_id)).state, "reversed");
});

test("memory store recovers inspectable decisions after client reconstruction", async () => {
  const { client, store } = harness();
  const { decisions } = await client.inspect([makeEnvelope("status intent_alpha")]);
  const recovered = createSwitchboardClient({
    intentManagement: {
      async readSnapshot() { return { intents: [], agents: [] }; },
      async readAttention() { return []; },
      async readIntent() { return {}; },
    },
    router: createDeterministicRouter(),
    decisionStore: store,
  });
  assert.deepEqual(await recovered.getDecision(decisions[0].decision_id), decisions[0]);
});
