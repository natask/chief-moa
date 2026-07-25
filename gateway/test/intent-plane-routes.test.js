"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-intent-plane-routes-"));
process.env.DATA_DIR = dataDir;
process.env.MOA_MODE = "local";
process.env.MOA_GATEWAY_TOKEN = "intent-plane-route-token";
process.env.GBRAIN_BIN = "__missing__";
process.env.BRAIN_STORE_DIR = dataDir;
const { server } = require("../server");
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, pathname, body, token = process.env.MOA_GATEWAY_TOKEN) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { authorization: token ? `Bearer ${token}` : "", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test("authenticated CRUD, projection, explanation and receipts are wired", async () => {
  assert.equal((await call("GET", "/v1/intent-plane", undefined, "")).status, 401);
  const created = await call("POST", "/v1/intent-plane/intents", {
    intent_id: "route_intent", title: "Route", objective: "Exercise API",
    source: { surface: "browser" }, user_confirmed: true, idempotency_key: "route-create",
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const registered = await call("POST", "/v1/intent-plane/intents/route_intent/agents", {
    agent_id: "route_agent", launch_reason: "manual fixture",
    launcher_provenance: { surface: "gateway-test" }, capabilities: ["test"],
    authority_summary: "test only", current_run_id: "route_run", idempotency_key: "route-register",
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  const heartbeat = await call("POST", "/v1/intent-plane/agents/route_agent/heartbeat", {
    progress: "alive", lease_duration_ms: 60000, idempotency_key: "route-heartbeat",
  });
  assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.json));
  assert.equal(heartbeat.json.agent.recovery_state, "healthy");
  assert.equal((await call("POST", "/v1/intent-plane/agents/route_agent/progress", {
    status: "completed", progress: "done", latest_recap: "complete",
    artifact_refs: ["artifact:route"], idempotency_key: "route-progress",
  })).status, 200);
  assert.equal((await call("GET", "/v1/intent-plane/intents/route_intent")).status, 200);
  const explained = await call("GET", "/v1/intent-plane/intents/route_intent/explain");
  assert.equal(explained.json.runs[0].run_id, "route_run");
  assert.deepEqual(explained.json.artifacts, ["artifact:route"]);

  const started = await call("POST", "/v1/intent-plane/agents/route_agent/runs", {
    current_run_id: "route_run_two",
    progress: "second run",
    idempotency_key: "route-run-two-start",
  });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  assert.equal(started.json.agent.current_run_id, "route_run_two");

  const patched = await call("PATCH", "/v1/intent-plane/intents/route_intent", {
    status: "needs_user", next_action: "Review", idempotency_key: "route-needs-user",
  });
  assert.equal(patched.status, 200);
  const projection = await call("GET", "/v1/intent-plane");
  assert.equal(projection.json.schema, "moa.intent-plane.v1");
  assert.equal(projection.json.intents[0].namespace_id, "namespace_default");
  assert.equal(projection.json.notifications[0].receipt_state, "pending");
  const receipt = await call("POST", `/v1/intent-plane/notifications/${projection.json.notifications[0].notification_id}/receipt`, {
    actor: "route-user", note: "shown", idempotency_key: "route-receipt",
  });
  assert.equal(receipt.json.notification.receipt_state, "received");
});
