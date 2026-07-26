"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAgentRunLaunchHandlers } = require("../lib/agent-run-launch-handlers");

function makeHarness(overrides = {}) {
  const calls = { created: [], executed: [], events: [], contexts: [] };
  const runs = new Map([
    ["parent", {
      id: "parent", prompt: "old prompt", output: "old output", stderr: "", stdout: "",
      conversation_id: "conv_parent", branch_id: "branch_parent", intent_id: "intent_parent",
      harness: "echo", working_dir: "/tmp", profile_version: "v1",
    }],
  ]);
  let next = 1;
  const deps = {
    authorizedAgent: () => true,
    agentAuthError: () => ({ error: "unauthorized" }),
    readJsonBody: async (request) => request.body,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    cleanError: (error) => error.message,
    sanitizeId: (id) => id,
    runExists: (id) => runs.has(id),
    readAgentRun: (id) => runs.get(id),
    createAgentRun: (body) => {
      calls.created.push(body);
      const run = { id: `run_${next++}`, status: "queued", harness: body.harness || "echo", ...body };
      runs.set(run.id, run);
      return run;
    },
    executeAgentRun: async (id) => { calls.executed.push(id); const run = runs.get(id); run.status = "completed"; return run; },
    activeRuns: new Map(),
    agentRunBodyWithSessionContext: (body) => ({ ...body, prompt: `CTX:${body.prompt || ""}` }),
    useWorkerPullForAgentRuns: () => false,
    agentRunPayload: (run) => ({ run }),
    appendAgentEvent: (id, type, payload) => calls.events.push({ id, type, payload }),
    truncate: (value, max) => String(value).slice(0, max),
    agentPromptWithSessionContext: (prompt, options) => { calls.contexts.push(options); return `CTX:${prompt}`; },
    ...overrides,
  };
  return { handlers: createAgentRunLaunchHandlers(deps), calls, runs, deps };
}

async function route(handlers, method, pathname, body = {}) {
  const response = {};
  const handled = await handlers.routeAgentRunLaunches({ method, body }, response, new URL(`https://test${pathname}`));
  return { handled, response };
}

test("launch routes authorize and reject invalid run creation", async () => {
  const denied = makeHarness({ authorizedAgent: () => false }).handlers;
  assert.equal((await route(denied, "POST", "/v1/agent/runs")).response.status, 401);
  assert.equal((await route(denied, "POST", "/v1/agent/runs/parent/followups")).response.status, 401);

  const invalid = makeHarness({ createAgentRun: () => { throw new Error("invalid harness"); } }).handlers;
  const result = await route(invalid, "POST", "/v1/agent/runs", { prompt: "work" });
  assert.equal(result.response.status, 400);
  assert.equal(result.response.payload.error, "invalid harness");
});

test("launch supports queued worker, asynchronous local, and waited local execution", async () => {
  const worker = makeHarness({ useWorkerPullForAgentRuns: () => true });
  const queued = await route(worker.handlers, "POST", "/v1/agent/runs", { prompt: "work" });
  assert.equal(queued.response.status, 202);
  assert.equal(queued.response.payload.worker_pull.queued, true);
  assert.deepEqual(worker.calls.executed, []);

  const local = makeHarness();
  const asynchronous = await route(local.handlers, "POST", "/v1/agent/runs", { prompt: "work", wait: false });
  assert.equal(asynchronous.response.status, 202);
  await Promise.resolve();
  assert.deepEqual(local.calls.executed, ["run_1"]);

  const waited = makeHarness();
  const complete = await route(waited.handlers, "POST", "/v1/agent/runs", { prompt: "work" });
  assert.equal(complete.response.status, 200);
  assert.equal(complete.response.payload.run.status, "completed");
  assert.equal(waited.deps.activeRuns.size, 0);
});

test("follow-up rejects missing parents, empty text, and invalid continuations", async () => {
  const harness = makeHarness();
  assert.equal((await route(harness.handlers, "POST", "/v1/agent/runs/missing/followups", { text: "hi" })).response.status, 404);
  assert.equal((await route(harness.handlers, "POST", "/v1/agent/runs/parent/followups")).response.status, 400);

  const invalid = makeHarness({ createAgentRun: () => { throw new Error("bad continuation"); } });
  const result = await route(invalid.handlers, "POST", "/v1/agent/runs/parent/followups", { transcript: "continue" });
  assert.equal(result.response.status, 400);
  assert.equal(result.response.payload.error, "bad continuation");

  const mismatch = await route(harness.handlers, "POST", "/v1/agent/runs/parent/followups", {
    text: "wrong scope", branch_id: "other",
  });
  assert.equal(mismatch.response.status, 409);
});

test("worker follow-up preserves parent defaults and queues without execution", async () => {
  const harness = makeHarness({ useWorkerPullForAgentRuns: () => true });
  const result = await route(harness.handlers, "POST", "/v1/agent/runs/parent/followups", { text: "continue" });
  assert.equal(result.response.status, 202);
  assert.equal(result.response.payload.parent_run_id, "parent");
  assert.equal(result.response.payload.worker_pull.claim_url, "/v1/agent/workers/claim");
  assert.deepEqual(harness.calls.executed, []);
  assert.equal(harness.calls.created[0].conversation_id, "conv_parent");
  assert.equal(harness.calls.created[0].branch_id, "branch_parent");
  assert.equal(harness.calls.created[0].intent_id, "intent_parent");
  assert.equal(harness.calls.created[0].source, "android-follow-up");
  assert.equal(harness.calls.events[0].payload.source, "android-overlay");
  assert.match(harness.calls.created[0].prompt, /New user follow-up:\ncontinue/);
});

test("local follow-up honors overrides, session context, and output fallbacks", async () => {
  const harness = makeHarness();
  harness.runs.set("parent", {
    ...harness.runs.get("parent"), output: "", stderr: "old error", stdout: "old stdout",
  });
  const body = {
    prompt: "next", source: "phone", session_id: "session_1", branch_id: "branch_parent",
    intent_id: "intent_parent",
    all_branches_context: true, conversation_id: "conv_new", harness: "codex",
    working_dir: "/work", screen: { text: "evidence" }, profile_version: "v2",
  };
  const result = await route(harness.handlers, "POST", "/v1/agent/runs/parent/followups", body);
  assert.equal(result.response.status, 202);
  assert.deepEqual(harness.calls.executed, ["run_1"]);
  assert.deepEqual(harness.calls.contexts[0], { sessionId: "session_1", branchId: "branch_parent", allBranches: true });
  assert.equal(harness.calls.created[0].harness, "codex");
  assert.equal(harness.calls.created[0].branch_id, "branch_parent");
  assert.equal(harness.calls.created[0].intent_id, "intent_parent");
  assert.match(harness.calls.created[0].prompt, /old error/);
});

test("repeated follow-ups preserve the same branch and intent on every child", async () => {
  const harness = makeHarness();
  const first = await route(harness.handlers, "POST", "/v1/agent/runs/parent/followups", {
    text: "first", branch_id: "branch_parent", intent_id: "intent_parent",
  });
  assert.equal(first.response.status, 202);
  const second = await route(harness.handlers, "POST", "/v1/agent/runs/run_1/followups", {
    text: "second", branch_id: "branch_parent", intent_id: "intent_parent",
  });
  assert.equal(second.response.status, 202);
  assert.deepEqual(harness.calls.created.map((run) => ({
    parent_run_id: run.parent_run_id,
    branch_id: run.branch_id,
    intent_id: run.intent_id,
  })), [
    { parent_run_id: "parent", branch_id: "branch_parent", intent_id: "intent_parent" },
    { parent_run_id: "run_1", branch_id: "branch_parent", intent_id: "intent_parent" },
  ]);
});

test("unrelated methods and paths fall through", async () => {
  const { handlers } = makeHarness();
  assert.equal((await route(handlers, "GET", "/v1/agent/runs")).handled, false);
  assert.equal((await route(handlers, "POST", "/v1/agent/runs/parent/result")).handled, false);
});
