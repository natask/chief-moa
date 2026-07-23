"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserTaskHandlers, queryOptions, sliceId } = require("../lib/browser-task-handlers");

function harness(overrides = {}) {
  const events = [];
  const runUpdates = [];
  const taskUpdates = [];
  const loop = {
    list: (query) => [{ id: "agent-listed", query }],
    get: (id) => id === "agent-1" ? { id } : null,
    claim: () => ({ id: "agent-1", claimed_by: "extension", lease_expires_at: "later", agent_run_id: "run-1" }),
    step: async () => ({ task: { id: "agent-1", agent_run_id: "run-1" }, action: { kind: "click" }, step: 2, done: false }),
    finish: () => ({ task: { id: "agent-1" }, agent_run_id: "run-1", status: "done", summary: "finished" }),
    summarize: (task, options = {}) => ({ ...task, include_steps: options.includeSteps === true }),
  };
  const currentTask = { id: "task-1", receipts: [], agent_run_id: "run-1" };
  const deps = {
    authorizedAgent: () => true,
    agentAuthError: () => ({ error: "agent auth" }),
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    readJsonBody: async (request) => request.body || {},
    listBrowserTasks: (query) => [{ id: "legacy-listed", query }],
    claimNextBrowserTask: () => ({ id: "task-1", claimed_by: "extension", lease_expires_at: "later", agent_run_id: "run-1" }),
    appendAgentEvent: (...args) => events.push(args),
    recordBrowserTaskProductEvent: async (...args) => events.push(args),
    summarizeBrowserTask: (task, options = {}) => ({ ...task, include_actions: options.includeActions === true }),
    createBrowserTask: (body) => ({ id: "task-created", instruction: "do it", url: "https://example.test", cdp_actions: [], ...body }),
    cleanError: (error) => error.message,
    truncate: (value, limit) => value.slice(0, limit),
    sanitizeId: String,
    browserTaskExists: () => true,
    randomId: () => "receipt-1",
    sanitizeBrowserActionResults: (value) => value || [],
    sanitizeBrowserPageState: (value) => value || null,
    sanitizeBrowserScreenshot: (value) => value || null,
    readBrowserTask: () => currentTask,
    updateBrowserTask: (id, patch) => { const value = { ...currentTask, ...patch, id }; taskUpdates.push(value); return value; },
    agentRunExists: () => true,
    readAgentRun: () => ({ id: "run-1", output: "prior" }),
    updateAgentRun: (id, patch) => runUpdates.push({ id, ...patch }),
    launchBrowserAgentTaskInternal: (body) => ({ task: { id: "agent-created", ...body } }),
    browserAgentLoop: loop,
    now: () => "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
  return { handlers: createBrowserTaskHandlers(deps), loop, events, runUpdates, taskUpdates, currentTask };
}

const request = (method, body = {}) => ({ method, body });
const url = (path) => new URL(`http://gateway.test${path}`);

test("router rejects unauthorized matches and ignores unrelated methods and paths", async () => {
  const { handlers } = harness({ authorizedAgent: () => false });
  const response = {};
  assert.equal(await handlers.routeBrowserTasks(request("GET"), response, url("/v1/browser/tasks")), true);
  assert.deepEqual(response, { status: 401, payload: { error: "agent auth" } });
  assert.equal(await handlers.routeBrowserTasks(request("DELETE"), {}, url("/v1/browser/tasks")), false);
  assert.equal(await handlers.routeBrowserTasks(request("GET"), {}, url("/elsewhere")), false);
});

test("router covers legacy collections, claim, receipt, aliases, and defaults", async () => {
  const { handlers } = harness();
  let response = {};
  await handlers.routeBrowserTasks(request("GET"), response, url("/v1/browser/tasks?status=pending&limit=7"));
  assert.deepEqual(response.payload.tasks[0].query, { status: "pending", limit: 7 });
  response = {};
  await handlers.routeBrowserTasks(request("GET"), response, url("/v1/browser/tasks"));
  assert.deepEqual(response.payload.tasks[0].query, { status: "", limit: 25 });
  response = {};
  await handlers.routeBrowserTasks(request("POST", { source: "voice" }), response, url("/v1/browser/tasks"));
  assert.equal(response.status, 202);
  response = {};
  await handlers.routeBrowserTasks(request("POST", { client: "chrome" }), response, url("/v1/browser/tasks/claim"));
  assert.equal(response.status, 200);
  response = {};
  await handlers.routeBrowserTasks(request("POST", { ok: true }), response, url("/v1/browser/tasks/task-1/receipts"));
  assert.equal(response.status, 200);
});

test("router covers agent collection, claim, step, finish, and item reads", async () => {
  const { handlers } = harness();
  for (const [method, path, expected] of [
    ["GET", "/v1/browser/agent-tasks?status=queued&limit=3", 200],
    ["POST", "/v1/browser/agent-tasks", 202],
    ["POST", "/v1/browser/agent-tasks/claim", 200],
    ["POST", "/v1/browser/agent-tasks/agent-1/steps", 200],
    ["POST", "/v1/browser/agent-tasks/agent-1/finish", 200],
    ["GET", "/v1/browser/agent-tasks/agent-1", 200],
    ["GET", "/v1/browser/agent-tasks/missing", 404],
  ]) {
    const response = {};
    assert.equal(await handlers.routeBrowserTasks(request(method, { instruction: "go", client_id: "chrome" }), response, url(path)), true);
    assert.equal(response.status, expected);
  }
  const response = {};
  await handlers.routeBrowserTasks(request("GET"), response, url("/v1/browser/agent-tasks/agent%2D1"));
  assert.equal(response.payload.task.id, "agent-1");
});

test("legacy create and claim cover validation, defaults, empty queues, and run events", async () => {
  let state = harness({ createBrowserTask: () => { throw new Error("invalid task"); } });
  let response = {};
  await state.handlers.handleCreateBrowserTask(request("POST"), response);
  assert.deepEqual(response, { status: 400, payload: { error: "invalid task" } });

  state = harness({ createBrowserTask: (body) => ({ id: "task", instruction: "x", url: "", cdp_actions: [], source: body.source }) });
  response = {};
  await state.handlers.handleCreateBrowserTask(request("POST"), response);
  assert.equal(response.payload.task.source, "api");
  assert.equal(state.events.length, 1);

  state = harness({ createBrowserTask: (body) => ({ id: "task", instruction: "x", url: "https://example.test", cdp_actions: [1], source: body.source, agent_run_id: "run-1" }) });
  response = {};
  await state.handlers.handleCreateBrowserTask(request("POST", { source: "voice" }), response);
  assert.equal(state.events[0][1], "browser_task_queued");
  assert.equal(state.events[0][2].action_count, 1);

  state = harness({ claimNextBrowserTask: () => null });
  response = {};
  await state.handlers.handleClaimBrowserTask(request("POST"), response);
  assert.equal(response.status, 204);

  state = harness({ claimNextBrowserTask: (client) => ({ id: "task", claimed_by: client, agent_run_id: "" }) });
  response = {};
  await state.handlers.handleClaimBrowserTask(request("POST", { client_id: " direct " }), response);
  assert.equal(response.payload.task.claimed_by, "direct");
  assert.equal(state.events.length, 1);
});

test("legacy receipts cover missing tasks, success, failure, receipts, and run projection", async () => {
  let state = harness({ browserTaskExists: () => false });
  let response = {};
  await state.handlers.handleBrowserTaskReceipt(request("POST"), response, "missing");
  assert.equal(response.status, 404);

  state = harness({ now: undefined, readBrowserTask: () => ({ id: "task-1" }), updateBrowserTask: (id, patch) => ({ id, ...patch, agent_run_id: "" }) });
  response = {};
  await state.handlers.handleBrowserTaskReceipt(request("POST", { client_id: "chrome", summary: "done", action_results: [1], page_state: { url: "x" }, screenshot: { id: 1 } }), response, "task-1");
  assert.equal(response.payload.receipt.ok, true);
  assert.match(response.payload.receipt.ts, /^2026-/);

  state = harness();
  response = {};
  await state.handlers.handleBrowserTaskReceipt(request("POST", { error: "failed", summary: "nope" }), response, "task-1");
  assert.equal(response.payload.task.status, "failed");
  assert.match(state.runUpdates[0].output, /failed: failed/);

  state = harness({ readAgentRun: () => ({ output: "" }) });
  response = {};
  await state.handlers.handleBrowserTaskReceipt(request("POST", {}), response, "task-1");
  assert.match(state.runUpdates[0].output, /receipt received/);
});

test("agent creation and claim cover errors, empty queues, aliases, and absent runs", async () => {
  let state = harness({ launchBrowserAgentTaskInternal: () => { throw new Error("bad delegation"); } });
  let response = {};
  await state.handlers.handleCreateBrowserAgentTask(request("POST"), response);
  assert.equal(response.status, 400);

  state = harness();
  response = {};
  await state.handlers.handleCreateBrowserAgentTask(request("POST", { instruction: "go" }), response);
  assert.equal(response.payload.task.include_steps, true);

  state.loop.claim = () => null;
  response = {};
  await state.handlers.handleClaimBrowserAgentTask(request("POST"), response);
  assert.equal(response.status, 204);

  state = harness({ agentRunExists: () => false });
  state.loop.claim = (client) => ({ id: "agent", claimed_by: client, agent_run_id: "run-missing" });
  response = {};
  await state.handlers.handleClaimBrowserAgentTask(request("POST", { client: "edge" }), response);
  assert.equal(response.payload.task.claimed_by, "edge");
  assert.equal(state.events.length, 0);
});

test("agent steps cover throws, typed errors, fallbacks, and run events", async () => {
  let state = harness();
  state.loop.step = async () => { throw new Error("planner failed"); };
  let response = {};
  await state.handlers.handleBrowserAgentTaskStep(request("POST"), response, "agent");
  assert.equal(response.status, 400);

  state = harness();
  state.loop.step = async () => ({ error: "conflict", code: 409 });
  response = {};
  await state.handlers.handleBrowserAgentTaskStep(request("POST"), response, "agent");
  assert.equal(response.status, 409);

  state = harness();
  state.loop.step = async () => ({ error: "bad" });
  response = {};
  await state.handlers.handleBrowserAgentTaskStep(request("POST"), response, "agent");
  assert.equal(response.status, 400);

  state = harness({ agentRunExists: () => false });
  response = {};
  await state.handlers.handleBrowserAgentTaskStep(request("POST"), response, "agent");
  assert.equal(response.status, 200);
  assert.equal(state.events.length, 0);
});

test("agent finish covers errors, completed and failed run projections, and absent runs", async () => {
  let state = harness();
  state.loop.finish = () => ({ error: "missing", code: 404 });
  let response = {};
  await state.handlers.handleBrowserAgentTaskFinish(request("POST"), response, "agent");
  assert.equal(response.status, 404);

  state = harness();
  state.loop.finish = () => ({ error: "bad" });
  response = {};
  await state.handlers.handleBrowserAgentTaskFinish(request("POST"), response, "agent");
  assert.equal(response.status, 400);

  state = harness({ now: undefined });
  response = {};
  await state.handlers.handleBrowserAgentTaskFinish(request("POST"), response, "agent");
  assert.equal(state.runUpdates[0].status, "completed");
  assert.match(state.runUpdates[0].finished_at, /^2026-/);

  state = harness();
  state.loop.finish = () => ({ task: { id: "agent" }, agent_run_id: "run-1", status: "failed", summary: "" });
  response = {};
  await state.handlers.handleBrowserAgentTaskFinish(request("POST"), response, "agent");
  assert.match(state.runUpdates[0].output, /failed: failed/);

  state = harness({ agentRunExists: () => false });
  response = {};
  await state.handlers.handleBrowserAgentTaskFinish(request("POST"), response, "agent");
  assert.equal(state.runUpdates.length, 0);
});

test("public query and slicing helpers preserve bounds and exact path remainders", () => {
  assert.deepEqual(queryOptions(url("/x")), { status: "", limit: 25 });
  assert.equal(sliceId("/prefix/a%2Fb/end", "/prefix/", "/end"), "a%2Fb");
});
