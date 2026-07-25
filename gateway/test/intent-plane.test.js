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

test("one physical plane supports reversible routing metadata", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  await f.plane.createIntent({
    intent_id: "intent_scope",
    title: "Scope",
    objective: "Route without physical partitioning",
    tenant_id: "nat",
    namespace_id: "work",
    sphere: "company",
    project_id: "chief-moa",
    user_confirmed: true,
    idempotency_key: "scope-create",
  });
  assert.equal((await f.plane.projection({ namespace_id: "work" })).intents.length, 1);
  assert.equal((await f.plane.projection({ namespace_id: "personal" })).intents.length, 0);

  const moved = await f.plane.updateIntent("intent_scope", {
    namespace_id: "personal",
    sphere: "personal",
    project_id: "research",
    idempotency_key: "scope-move",
  });
  assert.equal(moved.namespace_id, "personal");
  assert.equal(moved.project_id, "research");

  const restarted = createIntentPlane({ events: f.events, now: f.now });
  const explained = await restarted.explain("intent_scope");
  assert.equal(explained.intent.namespace_id, "personal");
  assert.equal(explained.intent.project_id, "research");
});

test("agent heartbeat exposes durable lease and restart recovery state", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  await f.plane.createIntent({
    intent_id: "intent_lease", title: "Lease", objective: "Detect disappeared agents",
    user_confirmed: true, idempotency_key: "lease-create",
  });
  await f.plane.registerAgent({
    agent_id: "agent_lease",
    intent_id: "intent_lease",
    launch_reason: "Run on the local Mac",
    runtime_type: "codex",
    execution_location: "macbook",
    endpoint_ref: "codex://thread/stable",
    recovery_policy: "relaunch",
    idempotency_key: "lease-register",
  });
  for (const [index, endpoint] of [
    "https://user@runtime.invalid/callback",
    "https://user:password@runtime.invalid/callback",
    "https://runtime.invalid/callback?token=secret",
    "https://runtime.invalid/callback?authorization=secret",
    "https://runtime.invalid/callback?to%6Ben=secret",
    "https://runtime.invalid/callback#api_key=secret",
    "https://runtime.invalid/callback#?credential=secret",
    "codex://thread/stable#Bearer secret",
  ].entries()) {
    await assert.rejects(() => f.plane.registerAgent({
      agent_id: `agent_secret_${index}`,
      intent_id: "intent_lease",
      launch_reason: "unsafe",
      endpoint_ref: endpoint,
      idempotency_key: `lease-secret-${index}`,
    }), /must not contain credentials/);
  }
  const heartbeat = await f.plane.heartbeatAgent("agent_lease", {
    progress: "working",
    lease_duration_ms: 60_000,
    idempotency_key: "lease-heartbeat",
  });
  assert.equal(heartbeat.recovery_state, "healthy");
  assert.equal(heartbeat.runtime_type, "codex");
  assert.equal(heartbeat.recovery_policy, "relaunch");
  const replay = await f.plane.heartbeatAgent("agent_lease", {
    progress: "working",
    lease_duration_ms: 60_000,
    idempotency_key: "lease-heartbeat",
  });
  assert.equal(replay.lease_expires_at, heartbeat.lease_expires_at);
  await assert.rejects(() => f.plane.heartbeatAgent("agent_lease", {
    progress: "different",
    lease_duration_ms: 60_000,
    idempotency_key: "lease-heartbeat",
  }), /idempotency collision/);

  const later = await f.plane.heartbeatAgent("agent_lease", {
    progress: "later work",
    lease_duration_ms: 120_000,
    idempotency_key: "lease-heartbeat-later",
  });
  assert.notEqual(later.lease_expires_at, heartbeat.lease_expires_at);
  const delayedReplay = await createIntentPlane({
    events: f.events,
    now: () => "2026-07-25T12:00:00.000Z",
  }).heartbeatAgent("agent_lease", {
    progress: "working",
    lease_duration_ms: 60_000,
    idempotency_key: "lease-heartbeat",
  });
  assert.deepEqual(delayedReplay, heartbeat);

  const stale = createIntentPlane({
    events: f.events,
    now: () => "2026-07-26T00:00:00.000Z",
  });
  const view = await stale.projection();
  assert.equal(view.agents[0].recovery_state, "stale");
  await assert.rejects(() => stale.heartbeatAgent("agent_lease", {
    status: "completed", progress: "invalid",
  }), /heartbeat status/);
});

test("terminal agent progress cannot resurrect without explicit new run", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  await f.plane.createIntent({
    intent_id: "intent_terminal", title: "Terminal", objective: "Keep terminal states closed",
    user_confirmed: true, idempotency_key: "terminal-create",
  });
  for (const terminal of ["completed", "failed", "cancelled"]) {
    const agentId = `agent_${terminal}`;
    await f.plane.registerAgent({
      agent_id: agentId, intent_id: "intent_terminal", launch_reason: terminal,
      current_run_id: `run_${terminal}_one`, idempotency_key: `register-${terminal}`,
    });
    await f.plane.progressAgent(agentId, {
      status: "running", progress: "started", idempotency_key: `running-${terminal}`,
    });
    await f.plane.progressAgent(agentId, {
      status: terminal, progress: terminal, idempotency_key: `terminal-${terminal}`,
    });
    await assert.rejects(() => f.plane.progressAgent(agentId, {
      status: "running", progress: "resurrect", idempotency_key: `resurrect-${terminal}`,
    }), new RegExp(`illegal agent status transition: ${terminal} -> running`));
  }
});

test("explicit run start reopens a completed agent and pings each run separately", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true }));
  await f.plane.createIntent({
    intent_id: "intent_runs", title: "Runs", objective: "Track repeated attempts",
    user_confirmed: true, idempotency_key: "runs-create",
  });
  await f.plane.registerAgent({
    agent_id: "agent_runs", intent_id: "intent_runs", launch_reason: "attempts",
    current_run_id: "run_one", idempotency_key: "runs-register",
  });
  await f.plane.progressAgent("agent_runs", {
    status: "running", progress: "run one", idempotency_key: "run-one-running",
  });
  await f.plane.progressAgent("agent_runs", {
    status: "completed", progress: "run one done", idempotency_key: "run-one-completed",
  });
  await f.plane.updateIntent("intent_runs", {
    status: "completed", current_run_id: "run_one", next_action: "Review one",
    idempotency_key: "intent-run-one-completed",
  });

  const started = await f.plane.startAgentRun("agent_runs", {
    current_run_id: "run_two",
    reopen_intent: true,
    progress: "run two",
    idempotency_key: "run-two-start",
  });
  assert.equal(started.agent.status, "running");
  assert.equal(started.agent.current_run_id, "run_two");
  assert.equal(started.intent.status, "active");
  await assert.rejects(() => f.plane.startAgentRun("agent_runs", {
    current_run_id: "run_three", progress: "parallel", idempotency_key: "run-three-start",
  }), /running agent cannot start another run/);

  await f.plane.progressAgent("agent_runs", {
    status: "completed", progress: "run two done", idempotency_key: "run-two-completed",
  });
  await f.plane.updateIntent("intent_runs", {
    status: "completed", current_run_id: "run_two", next_action: "Review two",
    idempotency_key: "intent-run-two-completed",
  });
  const view = await f.plane.projection();
  assert.deepEqual(view.notifications.map((item) => item.run_id), ["run_one", "run_two"]);
  assert.notEqual(view.notifications[0].notification_id, view.notifications[1].notification_id);
  const delayedStartReplay = await createIntentPlane({
    events: f.events,
    now: () => "2026-07-26T00:00:00.000Z",
  }).startAgentRun("agent_runs", {
    current_run_id: "run_two",
    reopen_intent: true,
    progress: "run two",
    idempotency_key: "run-two-start",
  });
  assert.deepEqual(delayedStartReplay, started);
});
