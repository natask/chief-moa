"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "development-plane-routes-"));
process.env.DATA_DIR = dataDir;
process.env.MOA_MODE = "local";
process.env.MOA_GATEWAY_TOKEN = "development-plane-route-token";
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

test("riff, graph, runnable work, QA, candidate, and acceptance are one API record", async () => {
  assert.equal((await call("POST", "/v1/development/intents", { riff: "denied" }, "")).status, 401);
  const created = await call("POST", "/v1/development/intents", {
    intent_id: "route_dev_intent",
    riff: "Build what I described and keep the intent durable.",
    evidence_refs: ["recording://riff"],
    acceptance_criteria: ["The final app matches the riff."],
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const planned = await call("POST", "/v1/development/intents/route_dev_intent/plan", {
    tasks: [
      { task_id: "build", title: "Build", acceptance_check: "tests pass", path_claims: ["app"] },
      { task_id: "qa", title: "QA", kind: "qa", depends_on: ["build"], acceptance_check: "real QA passes", path_claims: ["qa"] },
    ],
  });
  assert.equal(planned.status, 201, JSON.stringify(planned.json));
  const runnable = await call("GET", "/v1/development/intents/route_dev_intent/runnable?max_parallel=4&memory_budget_mb=4096");
  assert.deepEqual(runnable.json.tasks.map((task) => task.task_id), ["build"]);

  assert.equal((await call("POST", "/v1/development/intents/route_dev_intent/tasks/build/claim", { worker_id: "worker", run_id: "run" })).status, 200);
  assert.equal((await call("POST", "/v1/development/intents/route_dev_intent/tasks/build/finish", { passed: true, output_refs: ["commit://build"], verification_refs: ["test://build"] })).status, 200);
  assert.equal((await call("POST", "/v1/development/intents/route_dev_intent/tasks/qa/claim", { worker_id: "qa", run_id: "qa-run" })).status, 200);
  assert.equal((await call("POST", "/v1/development/intents/route_dev_intent/tasks/qa/finish", { passed: true, verification_refs: ["qa://receipt"] })).status, 200);
  assert.equal((await call("POST", "/v1/development/intents/route_dev_intent/candidate", { candidate_ref: "git://candidate", candidate_digest: "digest-1", summary: "Ready", verification_refs: ["qa://receipt"] })).status, 200);
  assert.equal((await call("POST", "/v1/development/intents/route_dev_intent/decision", { decision: "accepted", candidate_digest: "digest-1" })).status, 200);

  const fetched = await call("GET", "/v1/development/intents/route_dev_intent");
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.intent.riff, "Build what I described and keep the intent durable.");
  assert.equal(fetched.json.intent.status, "accepted");
});
