"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createWorkGraphHandlers, query } = require("../lib/work-graph-handlers");

function harness(overrides = {}) {
  const calls = [];
  const workGraph = {
    list: async (filter) => { calls.push(["list", filter]); return ["node"]; },
    listEvents: async (filter) => { calls.push(["events", filter]); return ["event"]; },
    listArtifacts: async (filter) => { calls.push(["artifacts", filter]); return ["artifact"]; },
  };
  const handlers = createWorkGraphHandlers({
    workGraph,
    authorizedAgent: overrides.authorizedAgent || (() => true),
    agentAuthError: () => ({ error: "unauthorized" }),
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    sendWorkNode: async (response, id) => { calls.push(["node", id]); response.status = 200; },
    handleCreateWorkNode: async () => calls.push(["create-node"]),
    handleWorkNodeAction: async (_request, _response, path) => calls.push(["action", path]),
    handleCreateWorkEvent: async () => calls.push(["create-event"]),
    handleCreateWorkArtifact: async () => calls.push(["create-artifact"]),
  });
  return { handlers, calls };
}

async function route(h, method, pathname) {
  const response = {};
  const handled = await h.handlers.routeWorkGraph({ method }, response, new URL(pathname, "http://local"));
  return { handled, ...response };
}

test("router authorizes the work family and ignores unrelated combinations", async () => {
  const denied = harness({ authorizedAgent: () => false });
  const response = await route(denied, "GET", "/v1/work/nodes");
  assert.equal(response.handled, true);
  assert.equal(response.status, 401);
  assert.deepEqual(response.payload, { error: "unauthorized" });
  const h = harness();
  assert.equal((await route(h, "GET", "/unrelated")).handled, false);
  assert.equal((await route(h, "DELETE", "/v1/work/nodes")).handled, false);
  assert.equal((await route(h, "GET", "/v1/work/unknown")).handled, false);
});

test("node collection reads filters and delegates creation", async () => {
  const h = harness();
  let response = await route(h, "GET", "/v1/work/nodes?status=running");
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls[0], ["list", { status: "running" }]);
  response = await route(h, "GET", "/v1/work/nodes");
  assert.deepEqual(h.calls[1], ["list", {}]);
  assert.equal((await route(h, "POST", "/v1/work/nodes")).handled, true);
  assert.deepEqual(h.calls[2], ["create-node"]);
});

test("event collection supports preferred, alias, and default query fields", async () => {
  const h = harness();
  let response = await route(h, "GET", "/v1/work/events?node_id=n1&nodeId=n2&run_id=r1&limit=4");
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls[0], ["events", { node_id: "n1", run_id: "r1", limit: 4 }]);
  response = await route(h, "GET", "/v1/work/events?nodeId=n2&runId=r2");
  assert.deepEqual(h.calls[1], ["events", { node_id: "n2", run_id: "r2", limit: 200 }]);
  await route(h, "GET", "/v1/work/events");
  assert.deepEqual(h.calls[2], ["events", { node_id: "", run_id: "", limit: 200 }]);
  await route(h, "POST", "/v1/work/events");
  assert.deepEqual(h.calls[3], ["create-event"]);
});

test("artifact collection supports filters, aliases, defaults, and creation", async () => {
  const h = harness();
  let response = await route(h, "GET", "/v1/work/artifacts?nodeId=n&runId=r&kind=report&query=find&limit=3");
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls[0], ["artifacts", { node_id: "n", run_id: "r", kind: "report", q: "find", limit: 3 }]);
  response = await route(h, "GET", "/v1/work/artifacts?q=preferred&query=alias");
  assert.equal(response.payload.artifacts[0], "artifact");
  assert.deepEqual(h.calls[1], ["artifacts", { node_id: "", run_id: "", kind: "", q: "preferred", limit: 100 }]);
  await route(h, "POST", "/v1/work/artifacts");
  assert.deepEqual(h.calls[2], ["create-artifact"]);
});

test("node item reads and action posts preserve the exact path remainder", async () => {
  const h = harness();
  let response = await route(h, "GET", "/v1/work/nodes/node%3A1");
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls[0], ["node", "node%3A1"]);
  response = await route(h, "POST", "/v1/work/nodes/node_1/enqueue");
  assert.equal(response.handled, true);
  assert.deepEqual(h.calls[1], ["action", "node_1/enqueue"]);
});

test("query helper respects preferred, alias, and missing values", () => {
  assert.equal(query(new URL("http://local/?one=a&two=b"), "one", "two"), "a");
  assert.equal(query(new URL("http://local/?two=b"), "one", "two"), "b");
  assert.equal(query(new URL("http://local/"), "one", "two"), "");
});
