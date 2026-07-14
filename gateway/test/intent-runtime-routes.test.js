"use strict";

// Route-level coverage for the intent-runtime HTTP surface wired into server.js.
// Boots the real gateway on an ephemeral port and drives the endpoints end to
// end (auth guard, capture, get, transition, connect, transactional focus,
// list, rehydrate). Domain behavior is covered by intent-runtime.test.js; this
// asserts the wiring: routing, auth, status codes, and payload passthrough.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-intent-routes-"));
process.env.DATA_DIR = dataDir;
process.env.MOA_MODE = "local";
process.env.MOA_GATEWAY_TOKEN = "s6-intent-route-token";
process.env.GBRAIN_BIN = "__missing_gbrain_for_intent_routes__";
process.env.BRAIN_STORE_DIR = dataDir;

const TOKEN = process.env.MOA_GATEWAY_TOKEN;
const { server } = require("../server");

let baseUrl = "";

test.before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, pathname, { body, token = TOKEN } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  const rawText = await response.text();
  if (rawText) { try { json = JSON.parse(rawText); } catch { json = { raw: rawText }; } }
  return { status: response.status, json };
}

async function activate(intentId, capture) {
  const created = await call("POST", "/v1/intent-runtime/intents", { body: { intent_id: intentId, ...capture } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  for (const type of ["intent.disambiguated", "intent.planned", "intent.execution_started"]) {
    const stepped = await call("POST", `/v1/intent-runtime/intents/${intentId}/transition`, {
      body: { type, idempotency_key: `${intentId}:${type}` },
    });
    assert.equal(stepped.status, 200, JSON.stringify(stepped.json));
  }
}

test("unauthenticated intent-runtime requests are rejected", async () => {
  const denied = await call("POST", "/v1/intent-runtime/intents", { body: { statement: "x" }, token: "" });
  assert.equal(denied.status, 401);
});

test("capture, get, and unknown-intent lookup are wired", async () => {
  const created = await call("POST", "/v1/intent-runtime/intents", {
    body: {
      intent_id: "intent_route_capture",
      statement: "wire the intent runtime routes",
      normalized_objective: "Expose intent runtime over HTTP",
      project_id: "proj_routes",
      session_id: "sess_routes",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.intent.lifecycle_state, "captured");

  const fetched = await call("GET", "/v1/intent-runtime/intents/intent_route_capture");
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.intent.normalized_objective, "Expose intent runtime over HTTP");

  const missing = await call("GET", "/v1/intent-runtime/intents/intent_does_not_exist");
  assert.equal(missing.status, 404);
});

test("transition advances lifecycle and rejects illegal jumps", async () => {
  await call("POST", "/v1/intent-runtime/intents", {
    body: { intent_id: "intent_route_transition", statement: "advance me", normalized_objective: "advance", project_id: "proj_routes" },
  });
  const clarified = await call("POST", "/v1/intent-runtime/intents/intent_route_transition/transition", {
    body: { type: "intent.disambiguated", idempotency_key: "route-clarified" },
  });
  assert.equal(clarified.status, 200);
  assert.equal(clarified.json.intent.lifecycle_state, "clarified");

  const illegal = await call("POST", "/v1/intent-runtime/intents/intent_route_transition/transition", {
    body: { type: "intent.completed", idempotency_key: "route-illegal", outcome: "done" },
  });
  assert.equal(illegal.status, 400);
});

test("connect records a relation between existing intents", async () => {
  await call("POST", "/v1/intent-runtime/intents", {
    body: { intent_id: "intent_route_a", statement: "a", normalized_objective: "a", project_id: "proj_routes" },
  });
  await call("POST", "/v1/intent-runtime/intents", {
    body: { intent_id: "intent_route_b", statement: "b", normalized_objective: "b", project_id: "proj_routes" },
  });
  const connected = await call("POST", "/v1/intent-runtime/intents/intent_route_a/connect", {
    body: { target_intent_id: "intent_route_b", relation_type: "depends_on", idempotency_key: "route-rel" },
  });
  assert.equal(connected.status, 200, JSON.stringify(connected.json));

  const missingTarget = await call("POST", "/v1/intent-runtime/intents/intent_route_a/connect", {
    body: { target_intent_id: "intent_route_absent", relation_type: "blocks" },
  });
  assert.equal(missingTarget.status, 400);
});

test("transactional focus push, complete, and pop restore the parent", async () => {
  await activate("intent_route_parent", {
    statement: "parent objective", normalized_objective: "parent", project_id: "proj_focus_routes", session_id: "sess_focus_routes",
  });
  await activate("intent_route_child", {
    statement: "child objective", normalized_objective: "child", project_id: "proj_focus_routes",
    session_id: "sess_focus_routes", parent_intent_id: "intent_route_parent", return_to_intent_id: "intent_route_parent",
  });

  const pushed = await call("POST", "/v1/intent-runtime/focus", {
    body: {
      intent_id: "intent_route_child", session_id: "sess_focus_routes",
      parent_intent_id: "intent_route_parent", return_to_intent_id: "intent_route_parent", idempotency_key: "route-focus-push",
    },
  });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.json));

  const completed = await call("POST", "/v1/intent-runtime/intents/intent_route_child/complete", {
    body: { idempotency_key: "route-focus-complete", outcome: "child done", receipt_refs: ["receipt://route/1"] },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.json));

  const popped = await call("POST", "/v1/intent-runtime/focus/pop", {
    body: { intent_id: "intent_route_child", session_id: "sess_focus_routes", idempotency_key: "route-focus-pop" },
  });
  assert.equal(popped.status, 200, JSON.stringify(popped.json));
  assert.equal(popped.json.focus.lifecycle_state, "completed");
  assert.equal(popped.json.focus.restored_intent_id, "intent_route_parent");
});

test("list and rehydrate expose projections", async () => {
  const listed = await call("GET", "/v1/intent-runtime/intents?project_id=proj_routes&limit=50");
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.json.items));
  const ids = listed.json.items.map((item) => item.intent_id);
  assert.ok(ids.includes("intent_route_capture"), `expected capture in ${JSON.stringify(ids)}`);

  const rehydratedProject = await call("POST", "/v1/intent-runtime/rehydrate", { body: { project_id: "proj_focus_routes" } });
  assert.equal(rehydratedProject.status, 200, JSON.stringify(rehydratedProject.json));

  const rehydratedIntent = await call("POST", "/v1/intent-runtime/rehydrate", { body: { intent_id: "intent_route_capture" } });
  assert.equal(rehydratedIntent.status, 200);
  assert.equal(rehydratedIntent.json.intent_id, "intent_route_capture");

  const badRehydrate = await call("POST", "/v1/intent-runtime/rehydrate", { body: {} });
  assert.equal(badRehydrate.status, 400);
});
