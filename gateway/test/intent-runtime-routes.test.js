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

test("ordinary messages route into durable intents with packet, claim, and progress APIs", async () => {
  const ingested = await call("POST", "/v1/intent-runtime/messages", {
    body: {
      message: "Build the hosted intent authority from the existing runtime.",
      idempotency_key: "route-message-1",
      workspace_id: "personal",
      project_id: "proj_routes",
      artifact_context: { artifact_id: "contract", version: "3" },
      routing: { action: "new_intent", confidence: 0.9, reason: "Durable outcome" },
      constraints: [{ summary: "Do not deploy without explicit authority." }],
      completion_criteria: ["Independent verification passes."],
    },
  });
  assert.equal(ingested.status, 201, JSON.stringify(ingested.json));
  assert.equal(ingested.json.route, "new_intent");
  const intentId = ingested.json.intent_id;

  const packet = await call("GET", `/v1/intent-runtime/intents/${intentId}/context-packet`);
  assert.equal(packet.status, 200, JSON.stringify(packet.json));
  assert.match(packet.json.context_packet.continuation_text, /Do not deploy/);

  const claimed = await call("POST", `/v1/intent-runtime/intents/${intentId}/claim`, {
    body: {
      agent_id: "agent_route_worker",
      run_id: "run_route_worker",
      idempotency_key: "route-claim-1",
      expected_intent_version: packet.json.context_packet.intent_version,
    },
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.json));

  const progressed = await call("POST", `/v1/intent-runtime/intents/${intentId}/progress`, {
    body: {
      agent_id: "agent_route_worker",
      run_id: "run_route_worker",
      fencing_token: claimed.json.intent.fencing_token,
      idempotency_key: "route-progress-1",
      expected_intent_version: claimed.json.intent.version,
      progress: "Created the operational contract.",
      next_step: "Run independent verification.",
      evidence_refs: ["test://route"],
    },
  });
  assert.equal(progressed.status, 200, JSON.stringify(progressed.json));
  assert.equal(progressed.json.intent.latest_progress, "Created the operational contract.");
});

test("product routes enforce server ownership and immutable revision heads", async () => {
  const forged = await call("POST", "/v1/intent-runtime/products", {
    body: {
      owner_id: "usr_foreign",
      product_id: "product_route_forbidden",
      product_type: "text_document",
      idempotency_key: "forged-owner",
    },
  });
  assert.equal(forged.status, 400);

  const created = await call("POST", "/v1/intent-runtime/products", {
    body: {
      product_id: "product_route_document",
      product_type: "text_document",
      title: "Route document",
      idempotency_key: "product-route-create",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const revised = await call("POST", "/v1/intent-runtime/products/product_route_document/revisions", {
    body: {
      revision_id: "revision_route_1",
      expected_head_revision_id: "",
      ref: "blob://route/1",
      content_hash: "hash_route_1",
      idempotency_key: "product-route-revision",
    },
  });
  assert.equal(revised.status, 201, JSON.stringify(revised.json));
  assert.equal(revised.json.product.head_revision_id, "revision_route_1");
  const conflict = await call("POST", "/v1/intent-runtime/products/product_route_document/revisions", {
    body: {
      revision_id: "revision_route_conflict",
      expected_head_revision_id: "",
      ref: "blob://route/conflict",
      content_hash: "hash_route_conflict",
      idempotency_key: "product-route-conflict",
    },
  });
  assert.equal(conflict.status, 400);
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

test("work-history creation exposes a durable delivery projection", async () => {
  const created = await call("POST", "/v1/work-history/turns", {
    body: {
      text: "queue a run to implement the durable intent linkage",
      turn_id: "turn_delivery_route",
      session_id: "sess_delivery_route",
      project_id: "chief-moa",
      acceptance_contract_ref: "openspec://durable-intent-delivery-pipeline/task-1",
    },
  });
  assert.equal(created.status, 202, JSON.stringify(created.json));
  assert.ok(created.json.refs.intent_id);
  assert.ok(created.json.refs.task_id);
  assert.ok(created.json.refs.run_id);

  const retried = await call("POST", "/v1/work-history/turns", {
    body: {
      text: "queue a run to implement the durable intent linkage",
      turn_id: "turn_delivery_route",
      session_id: "sess_delivery_route",
      project_id: "chief-moa",
      acceptance_contract_ref: "openspec://durable-intent-delivery-pipeline/task-1",
    },
  });
  assert.equal(retried.status, 202, JSON.stringify(retried.json));
  assert.equal(retried.json.refs.intent_id, created.json.refs.intent_id);
  assert.equal(retried.json.refs.task_id, created.json.refs.task_id);
  assert.equal(retried.json.refs.run_id, created.json.refs.run_id);

  const delivery = await call(
    "GET",
    `/v1/intent-runtime/intents/${encodeURIComponent(created.json.refs.intent_id)}/delivery`,
  );
  assert.equal(delivery.status, 200, JSON.stringify(delivery.json));
  assert.equal(delivery.json.delivery.intent_id, created.json.refs.intent_id);
  assert.deepEqual(delivery.json.delivery.task_refs.map((ref) => ref.task_id), [created.json.refs.task_id]);
  assert.deepEqual(delivery.json.delivery.run_refs.map((ref) => ref.run_id), [created.json.refs.run_id]);
  assert.equal(delivery.json.delivery.execution_started, false);
  assert.equal(delivery.json.delivery.promotion_recorded, false);

  const missing = await call("GET", "/v1/intent-runtime/intents/intent_missing_delivery/delivery");
  assert.equal(missing.status, 404);
});
