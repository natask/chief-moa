"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSupervisorHandlers } = require("../lib/supervisor-handlers");

function harness(overrides = {}) {
  const nodes = [
    { id: "open-1", title: "Open", status: "open", parentId: "root", executor: { kind: "worker" }, queue: ["a"], nextStep: "continue", updatedAt: "2026-01-02" },
    { id: "done-1", title: "Done", status: "completed", queue: null, updatedAt: "2026-01-01" },
  ];
  const workGraph = {
    list: async () => nodes,
    statuses: () => ["open", "completed", "blocked"],
    storageInfo: () => ({ work_graph: "postgres", postgres_configured: true }),
    graphPath: "/data/work-graph.json",
    ...overrides.workGraph,
  };
  const deps = {
    authorizedAgent: () => true,
    agentAuthError: () => ({ error: "agent auth" }),
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    harnessStatus: () => [{ name: "echo", available: true }],
    workGraph,
    listAllAgentRuns: () => [
      { id: "old", status: "completed", updated_at: "2026-01-01" },
      { id: "new", status: "running", updated_at: "2026-01-03" },
    ],
    isTerminalRunStatus: (status) => status === "completed",
    provider: "vertex",
    model: "gemini",
    providerConfigured: () => true,
    dataDir: "/data",
    brain: { available: () => true, slugPrefix: "moa" },
    voiceSessionServer: { status: () => ({ provider: "cascaded" }), endpoint: "/v1/voice/stream" },
    effectiveInstruction: (node) => `effective:${node.id}`,
    truncate: (value, limit) => `${value}:${limit}`,
    now: () => new Date("2026-07-15T12:00:00Z"),
    ...overrides,
    workGraph,
  };
  return { handlers: createSupervisorHandlers(deps), nodes };
}

const request = (method) => ({ method });
const url = (pathname) => new URL(`https://gateway.test${pathname}`);

test("router ignores unrelated traffic and authorizes both supervisor routes", async () => {
  let state = harness();
  assert.equal(await state.handlers.routeSupervisor(request("POST"), {}, url("/v1/supervisor/status")), false);
  assert.equal(await state.handlers.routeSupervisor(request("GET"), {}, url("/elsewhere")), false);

  state = harness({ authorizedAgent: () => false });
  for (const pathname of ["/v1/agent/harnesses", "/v1/supervisor/status"]) {
    const response = {};
    assert.equal(await state.handlers.routeSupervisor(request("GET"), response, url(pathname)), true);
    assert.deepEqual(response, { status: 401, payload: { error: "agent auth" } });
  }
});

test("harness discovery returns the bounded runtime catalog", async () => {
  const state = harness();
  const response = {};
  await state.handlers.routeSupervisor(request("GET"), response, url("/v1/agent/harnesses"));
  assert.deepEqual(response, { status: 200, payload: { harnesses: [{ name: "echo", available: true }] } });
});

test("status projection counts work, sorts runs, and exposes runtime evidence", async () => {
  const state = harness();
  const response = {};
  await state.handlers.routeSupervisor(request("GET"), response, url("/v1/supervisor/status"));
  const payload = response.payload;
  assert.equal(response.status, 200);
  assert.equal(payload.generated_at, "2026-07-15T12:00:00.000Z");
  assert.deepEqual(payload.storage, { agent_runs: "json-files", work_graph: "postgres", postgres_configured: true });
  assert.deepEqual(payload.work_graph.by_status, { open: 1, completed: 1, blocked: 0 });
  assert.equal(payload.work_graph.active.length, 1);
  assert.equal(payload.work_graph.active[0].queue_count, 1);
  assert.equal(payload.work_graph.active[0].effective_instruction, "effective:open-1:240");
  assert.deepEqual(payload.agent_runs.active.map((run) => run.id), ["new"]);
  assert.deepEqual(payload.agent_runs.recent.map((run) => run.id), ["new", "old"]);
  assert.deepEqual(payload.gateway, { provider: "vertex", model: "gemini", provider_configured: true, data_dir: "/data" });
  assert.equal(payload.brain.available, true);
  assert.equal(payload.voice.streaming_endpoint, "/v1/voice/stream");
});

test("legacy storage and empty node fields retain safe fallbacks and hard caps", async () => {
  const nodes = Array.from({ length: 30 }, (_, index) => ({
    id: `node-${index}`,
    title: `Node ${index}`,
    status: index === 29 ? "completed" : "blocked",
    queue: "legacy",
    nextStep: null,
    updatedAt: "now",
  }));
  const state = harness({
    workGraph: { list: async () => nodes, statuses: () => ["blocked", "completed"], storageInfo: null },
    now: undefined,
  });
  const payload = await state.handlers.statusPayload();
  assert.deepEqual(payload.storage, {
    agent_runs: "json-files",
    work_graph: "/data/work-graph.json",
    postgres_configured: false,
  });
  assert.equal(payload.work_graph.active.length, 25);
  assert.equal(payload.work_graph.active[0].queue_count, 0);
  assert.equal(payload.work_graph.active[0].next_step, "");
  assert.match(payload.generated_at, /^\d{4}-\d{2}-\d{2}T/);
});
