"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAgentWorkerHandlers } = require("../lib/agent-worker-handlers");
const { WorkerPullError } = require("../lib/worker-pull");

function makeHarness(overrides = {}) {
  const calls = { auth: [], events: [], remembered: [], synced: [], canonical: [] };
  const workerPull = {
    authenticate: (_request, scope) => { calls.auth.push(scope); return { scope }; },
    createRegistration: (body, request) => ({ kind: "registration", body, actor: request.actor }),
    registerWorker: (body) => ({ kind: "registered", body }),
    claim: (body, auth) => ({ kind: "claim", body, auth }),
    heartbeat: (id, body, auth) => ({ kind: "heartbeat", id, body, auth }),
    appendEvents: (id, body, auth) => ({ kind: "events", id, body, auth }),
    result: (id, body, auth) => ({ kind: "result", id, body, auth }),
    ...overrides.workerPull,
  };
  const deps = {
    authorizedAgent: () => true,
    agentAuthError: () => ({ error: "unauthorized" }),
    readJsonBody: async (request) => request.body,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    workerPull,
    WorkerPullError,
    randomId: (prefix) => `${prefix}_1`,
    cleanError: (error) => error.message,
    ownerActor: () => ({ kind: "user", id: "owner" }),
    readAgentRun: (id) => ({ id, status: "completed" }),
    rememberRunOutcome: (run) => calls.remembered.push(run.id),
    syncWorkGraphFromRun: (run) => { calls.synced.push(run.id); return Promise.resolve(); },
    recordCanonicalCompletion: async (run) => { calls.canonical.push(run.id); },
    appendAgentEvent: (id, type, payload) => calls.events.push({ id, type, payload }),
    ...overrides,
    workerPull,
  };
  return { handlers: createAgentWorkerHandlers(deps), calls };
}

async function route(harness, method, pathname, body = { value: 1 }) {
  const response = {};
  const handled = await harness.routeAgentWorkers({ method, body }, response, new URL(`https://test${pathname}`));
  return { handled, response };
}

test("registration creation requires agent auth and binds the owner actor", async () => {
  const denied = makeHarness({ authorizedAgent: () => false }).handlers;
  assert.equal((await route(denied, "POST", "/v1/agent/workers/registrations")).response.status, 401);

  const allowed = makeHarness().handlers;
  const result = await route(allowed, "POST", "/v1/agent/workers/registrations", { name: "worker" });
  assert.equal(result.response.status, 201);
  assert.deepEqual(result.response.payload.actor, { kind: "user", id: "owner" });
});

test("register and claim routes delegate bodies and scoped authentication", async () => {
  const { handlers, calls } = makeHarness();
  const registered = await route(handlers, "POST", "/v1/agent/workers/register", { code: "setup" });
  assert.equal(registered.response.payload.kind, "registered");
  const claimed = await route(handlers, "POST", "/v1/agent/workers/claim", { limit: 1 });
  assert.equal(claimed.response.payload.kind, "claim");
  assert.deepEqual(calls.auth, ["agent_runs:claim"]);
});

test("heartbeat and event routes extract run ids and use distinct scopes", async () => {
  const { handlers, calls } = makeHarness();
  const heartbeat = await route(handlers, "POST", "/v1/agent/runs/run_1/heartbeat");
  const events = await route(handlers, "POST", "/v1/agent/runs/run_2/events");
  assert.equal(heartbeat.response.payload.id, "run_1");
  assert.equal(events.response.payload.id, "run_2");
  assert.deepEqual(calls.auth, ["agent_runs:heartbeat", "agent_runs:append_event"]);
  assert.equal((await route(handlers, "GET", "/v1/agent/workers/claim")).handled, false);
});

test("result completion durably bridges canonical completion before acknowledging", async () => {
  const { handlers, calls } = makeHarness();
  const result = await route(handlers, "POST", "/v1/agent/runs/run_3/result", { status: "completed" });
  assert.equal(result.response.status, 200);
  assert.equal(result.response.payload.kind, "result");
  assert.deepEqual(calls.auth, ["agent_runs:complete"]);
  assert.deepEqual(calls.remembered, ["run_3"]);
  assert.deepEqual(calls.synced, ["run_3"]);
  assert.deepEqual(calls.canonical, ["run_3"]);
});

test("completion hooks record synchronous and asynchronous failures", async () => {
  const syncFailure = makeHarness({ readAgentRun: () => { throw new Error("read failed"); } });
  assert.equal((await route(syncFailure.handlers, "POST", "/v1/agent/runs/run_4/result")).response.status, 400);
  assert.equal(syncFailure.calls.events[0].type, "completion_hooks_failed");

  const asyncFailure = makeHarness({ syncWorkGraphFromRun: () => Promise.reject(new Error("sync failed")) });
  await route(asyncFailure.handlers, "POST", "/v1/agent/runs/run_5/result");
  await Promise.resolve();
  assert.equal(asyncFailure.calls.events[0].type, "work_node_sync_failed");

  const canonicalFailure = makeHarness({ recordCanonicalCompletion: async () => { throw new Error("canonical failed"); } });
  const failed = await route(canonicalFailure.handlers, "POST", "/v1/agent/runs/run_6/result");
  assert.equal(failed.response.status, 400);
  assert.equal(canonicalFailure.calls.events[0].type, "completion_hooks_failed");
});

test("worker errors retain protocol details and normalize other failures", async () => {
  const protocol = makeHarness({
    workerPull: { registerWorker: () => { throw new WorkerPullError(409, "registration_used", "used", true); } },
  });
  const protocolResult = await route(protocol.handlers, "POST", "/v1/agent/workers/register");
  assert.equal(protocolResult.response.status, 409);
  assert.deepEqual(protocolResult.response.payload.error, { code: "registration_used", message: "used", retryable: true });

  const generic = makeHarness({ readJsonBody: async () => { throw new Error("bad json"); } });
  const genericResult = await route(generic.handlers, "POST", "/v1/agent/workers/claim");
  assert.equal(genericResult.response.status, 400);
  assert.deepEqual(genericResult.response.payload.error, { code: "invalid_request", message: "bad json", retryable: false });
});
