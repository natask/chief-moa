"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAgentRunHandlers } = require("../lib/agent-run-handlers");

function makeHarness(overrides = {}) {
  const deps = {
    authorizedAgent: () => true, agentAuthError: () => ({ error: "unauthorized" }),
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    sanitizeId: (id) => { if (id === "bad") throw new Error("bad id"); return id; },
    runExists: (id) => id !== "missing",
    readAgentRun: (id) => ({ id, status: "running" }),
    readAgentEvents: (id) => [{ id: `event_${id}` }],
    isRunActive: (id) => id === "active",
    listAgentRuns: (limit) => [{ id: "run_1", limit }],
    cancelAgentRunById: (id) => ({ ok: true, status: "already_terminal", run: { id } }),
    agentRunPayload: (run) => ({ run }),
    ...overrides,
  };
  return createAgentRunHandlers(deps);
}

async function route(harness, method, pathname, query = "") {
  const response = {};
  const handled = await harness.routeAgentRunReads({ method }, response, new URL(`https://test${pathname}${query}`));
  return { handled, response };
}

test("run collection applies bounded list defaults", async () => {
  assert.equal((await route(makeHarness(), "GET", "/v1/agent/runs", "?limit=4")).response.payload.runs[0].limit, 4);
  assert.equal((await route(makeHarness(), "GET", "/v1/agent/runs")).response.payload.runs[0].limit, 25);
});

test("run detail returns events and active state", async () => {
  const active = await route(makeHarness(), "GET", "/v1/agent/runs/active");
  assert.equal(active.response.status, 200);
  assert.equal(active.response.payload.active, true);
  assert.equal(active.response.payload.events[0].id, "event_active");
  assert.equal((await route(makeHarness(), "GET", "/v1/agent/runs/missing")).response.status, 404);
  assert.equal((await route(makeHarness(), "GET", "/v1/agent/runs/bad")).response.status, 404);
});

test("cancel maps missing, requested, and terminal outcomes", async () => {
  const missing = makeHarness({ cancelAgentRunById: () => ({ ok: false, status: "not_found", run: null }) });
  assert.equal((await route(missing, "POST", "/v1/agent/runs/missing/cancel")).response.status, 404);
  const requested = makeHarness({ cancelAgentRunById: (id) => ({ ok: true, status: "cancel_requested", run: { id } }) });
  assert.equal((await route(requested, "POST", "/v1/agent/runs/run_1/cancel")).response.status, 202);
  const terminal = await route(makeHarness(), "POST", "/v1/agent/runs/run_1/cancel");
  assert.equal(terminal.response.status, 200);
  assert.equal(terminal.response.payload.run.id, "run_1");
});

test("all read and cancel routes enforce agent authorization", async () => {
  const denied = makeHarness({ authorizedAgent: () => false });
  for (const [method, path] of [["GET", "/v1/agent/runs"], ["GET", "/v1/agent/runs/run_1"], ["POST", "/v1/agent/runs/run_1/cancel"]]) {
    const result = await route(denied, method, path);
    assert.equal(result.handled, true); assert.equal(result.response.status, 401);
  }
});

test("launch and worker lifecycle routes remain with their owning handlers", async () => {
  const harness = makeHarness();
  assert.equal((await route(harness, "POST", "/v1/agent/runs")).handled, false);
  assert.equal((await route(harness, "POST", "/v1/agent/runs/run_1/followups")).handled, false);
  assert.equal((await route(harness, "POST", "/v1/agent/runs/run_1/events")).handled, false);
  assert.equal((await route(harness, "GET", "/v1/agent/other")).handled, false);
});
