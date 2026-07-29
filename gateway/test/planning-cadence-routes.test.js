"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-planning-cadence-routes-"));
process.env.DATA_DIR = dataDir;
process.env.MOA_MODE = "local";
process.env.MOA_GATEWAY_TOKEN = "planning-cadence-route-token";
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

test("authenticated plan/review create, lookup and rollup are wired", async () => {
  assert.equal((await call("GET", "/v1/planning-cadence/plans?horizon=day&period_key=2026-07-28", undefined, "")).status, 401);

  const plan = await call("POST", "/v1/planning-cadence/plans", {
    plan_id: "route_plan", horizon: "day", period_key: "2026-07-28",
    intentions: ["20 min exercise"], idempotency_key: "route-plan-create",
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.json));
  assert.equal(plan.json.plan.parent_period_key, "2026-W31");

  const fetched = await call("GET", "/v1/planning-cadence/plans?horizon=day&period_key=2026-07-28");
  assert.equal(fetched.json.plan.plan_id, "route_plan");

  const review = await call("POST", "/v1/planning-cadence/reviews", {
    review_id: "route_review", horizon: "day", period_key: "2026-07-28",
    outcome_summary: "exercised", idempotency_key: "route-review-create",
  });
  assert.equal(review.status, 201, JSON.stringify(review.json));
  assert.equal(review.json.review.plan_id, "route_plan");

  const rollup = await call("GET", "/v1/planning-cadence/rollup?horizon=week&period_key=2026-W31");
  assert.equal(rollup.status, 200);
  assert.equal(rollup.json.children[0].plan.plan_id, "route_plan");
  assert.equal(rollup.json.children[0].review.review_id, "route_review");

  const missingParams = await call("GET", "/v1/planning-cadence/rollup");
  assert.equal(missingParams.status, 400);
});
