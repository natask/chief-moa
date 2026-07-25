"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventSubstrateStore } = require("../lib/event-substrate");
const { createIntentPlane } = require("../lib/intent-plane");

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-intent-plane-"));
  const events = createEventSubstrateStore({ dataDir, originId: "test" });
  let index = 0;
  const now = () => `2026-07-25T00:00:0${index++}.000Z`;
  return { dataDir, events, plane: createIntentPlane({ events, now, idFactory: (prefix) => `${prefix}_stable` }), now };
}

test("confirmation gates admission and sensitive fields stay bounded", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  await assert.rejects(() => f.plane.createIntent({ title: "inferred", objective: "do it" }), /user_confirmed/);
  await assert.rejects(() => f.plane.createIntent({
    title: "x", objective: "x", user_confirmed: true, sensitivity: "secret",
  }), /sensitivity/);
  await assert.rejects(() => f.plane.createIntent({
    title: "x", objective: "x", user_confirmed: true,
    provenance: { nested: { api_token: "do-not-store" } },
  }), /must not contain credentials/);
});

test("intent, agent, run and artifacts rehydrate from durable events", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  const intent = await f.plane.createIntent({
    intent_id: "intent_1",
    title: "Ship a durable plane",
    objective: "Keep Chief Moa intent and agent state across restarts",
    source: { surface: "macos", session_id: "session_1" },
    provenance: { actor: "user", input: "typed" },
    sensitivity: "sensitive",
    next_action: "register implementer",
    artifact_refs: ["openspec:one"],
    user_confirmed: true,
    idempotency_key: "create-one",
  });
  assert.equal(intent.status, "admitted");

  const agent = await f.plane.registerAgent({
    agent_id: "agent_1",
    intent_id: intent.intent_id,
    launch_reason: "Manual fixture for the bounded slice",
    launcher_provenance: { launcher: "test", adapter: "manual" },
    capabilities: ["gateway", "tests"],
    authority_summary: "May edit the isolated candidate; no external action",
    current_run_id: "run_1",
    registration_mode: "manual",
    idempotency_key: "register-one",
  });
  assert.equal(agent.registration_mode, "manual");

  const progress = {
    status: "running",
    progress: "Implemented event projection",
    current_run_id: "run_1",
    latest_recap: "Projection is ready for verification",
    artifact_refs: ["commit:abc", "test:unit"],
    idempotency_key: "progress-one",
  };
  const first = await f.plane.progressAgent(agent.agent_id, progress);
  const replay = await f.plane.progressAgent(agent.agent_id, progress);
  assert.deepEqual(replay, first);

  // Simulate a gateway restart by constructing a new runtime over the same
  // event substrate. No in-memory registration is needed.
  const restarted = createIntentPlane({ events: f.events, now: f.now });
  const explained = await restarted.explain(intent.intent_id);
  assert.equal(explained.intent.source.surface, "macos");
  assert.deepEqual(explained.runs, [{ agent_id: "agent_1", run_id: "run_1" }]);
  assert.deepEqual(explained.artifacts.sort(), ["commit:abc", "openspec:one", "test:unit"]);
  assert.equal(explained.agents[0].latest_recap, "Projection is ready for verification");
});

test("completed and needs-user transitions create receiptable durable pings", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  await f.plane.createIntent({
    intent_id: "intent_ping", title: "Ping", objective: "Prove receipts",
    user_confirmed: true, idempotency_key: "create-ping",
  });
  const completed = await f.plane.updateIntent("intent_ping", {
    status: "completed", next_action: "Review the result", idempotency_key: "complete-ping",
  });
  assert.equal(completed.status, "completed");
  let view = await f.plane.projection();
  assert.equal(view.notifications.length, 1);
  assert.equal(view.notifications[0].receipt_state, "pending");

  const received = await f.plane.receiveNotification(view.notifications[0].notification_id, {
    actor: "user:test", note: "seen", idempotency_key: "receipt-ping",
  });
  assert.equal(received.receipt_state, "received");
  assert.equal(received.receipt.note, "seen");
  const replay = await f.plane.receiveNotification(received.notification_id, { actor: "other" });
  assert.deepEqual(replay, received);

  const restarted = createIntentPlane({ events: f.events, now: f.now });
  view = await restarted.projection();
  assert.equal(view.notifications[0].receipt_state, "received");
  assert.equal(view.authority.external_actions, "none");
});

test("foreign idempotency keys cannot hijack intent admission", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  await f.events.appendEvent({
    stream_id: "foreign:stream",
    event_type: "foreign.event",
    idempotency_key: "caller-key",
    payload: { foreign: true },
  });
  const intent = await f.plane.createIntent({
    intent_id: "intent_collision", title: "Collision", objective: "Stay isolated",
    user_confirmed: true, idempotency_key: "caller-key",
  });
  assert.equal(intent.intent_id, "intent_collision");
  assert.equal((await f.plane.projection()).intents.length, 1);
  await assert.rejects(() => f.plane.createIntent({
    intent_id: "intent_collision", title: "Changed", objective: "Different",
    user_confirmed: true, idempotency_key: "caller-key",
  }), /intent idempotency collision/);
});

test("retry after notification append failure repairs a terminal ping", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  await f.plane.createIntent({
    intent_id: "intent_repair", title: "Repair", objective: "Resume partial append",
    user_confirmed: true, idempotency_key: "repair-create",
  });
  let failNotificationOnce = true;
  const flakyEvents = {
    listEvents: (filter) => f.events.listEvents(filter),
    appendEvent: (event) => {
      if (failNotificationOnce && event.event_type === "intent_plane.notification.created") {
        failNotificationOnce = false;
        throw new Error("injected notification failure");
      }
      return f.events.appendEvent(event);
    },
  };
  const flaky = createIntentPlane({ events: flakyEvents, now: f.now });
  const command = { status: "completed", next_action: "Review", idempotency_key: "repair-complete" };
  await assert.rejects(() => flaky.updateIntent("intent_repair", command), /injected/);
  assert.equal((await f.plane.projection()).notifications.length, 0);

  const restarted = createIntentPlane({ events: f.events, now: f.now });
  const repaired = await restarted.updateIntent("intent_repair", command);
  assert.equal(repaired.status, "completed");
  const view = await restarted.projection();
  assert.equal(view.notifications.length, 1);
  assert.equal(view.notifications[0].receipt_state, "pending");
});

test("stable agent identity cannot move between intents and list is bounded", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  for (const id of ["one", "two"]) {
    await f.plane.createIntent({
      intent_id: `intent_${id}`, title: id, objective: id,
      user_confirmed: true, idempotency_key: `create-${id}`,
    });
  }
  await f.plane.registerAgent({
    agent_id: "agent_stable", intent_id: "intent_one", launch_reason: "one",
    idempotency_key: "agent-one",
  });
  await assert.rejects(() => f.plane.registerAgent({
    agent_id: "agent_stable", intent_id: "intent_two", launch_reason: "two",
    idempotency_key: "agent-two",
  }), /agent idempotency collision/);
  const page = await f.plane.projection({ limit: 1, offset: 1 });
  assert.deepEqual(page.page, { offset: 1, limit: 1, returned: 1, total: 2 });
  assert.equal(page.intents[0].intent_id, "intent_two");
});
