"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createBillingRuntimeHandlers } = require("../lib/billing-runtime-handlers");

function harness(overrides = {}) {
  const calls = [];
  const authority = overrides.unconfigured ? null : {
    mode: "sandbox_no_charge",
    authorize: (body) => { calls.push(["authorize", body]); return overrides.authorizeResult || { allowed: true, reservation: { id: "r1" } }; },
    recordUsage: (body) => { calls.push(["usage", body]); return overrides.usageResult || { allowed: true, usage: { id: "u1" } }; },
    ...overrides.authority,
  };
  const handlers = createBillingRuntimeHandlers({
    authority,
    authorizedAgent: overrides.authorizedAgent || (() => true),
    agentAuthError: () => ({ error: "unauthorized" }),
    readJsonBody: async (request) => request.body,
    appendReceipt: (receipt) => calls.push(["receipt", receipt]),
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    cleanError: (error) => String(error?.message || error),
  });
  return { handlers, calls };
}

async function route(h, method, pathname, body) {
  const response = {};
  const handled = await h.handlers.routeBillingRuntime(
    { method, body }, response, new URL(pathname, "http://local"),
  );
  return { handled, ...response };
}

test("router rejects unauthorized requests and ignores unrelated combinations", async () => {
  const denied = harness({ authorizedAgent: () => false });
  const response = await route(denied, "POST", "/v1/billing/runtime/authorize");
  assert.equal(response.handled, true);
  assert.equal(response.status, 401);
  assert.deepEqual(response.payload, { error: "unauthorized" });

  const h = harness();
  assert.equal((await route(h, "GET", "/v1/billing/runtime/authorize")).handled, false);
  assert.equal((await route(h, "POST", "/unrelated")).handled, false);
});

test("unconfigured authority fails closed for both endpoints", async () => {
  const h = harness({ unconfigured: true });
  for (const endpoint of ["authorize", "usage"]) {
    const response = await route(h, "POST", `/v1/billing/runtime/${endpoint}`, {});
    assert.equal(response.status, 503);
    assert.deepEqual(response.payload, {
      allowed: false, reason: "billing_runtime_unconfigured", charged: false,
    });
  }
});

test("authorize and usage record receipts and never claim a charge", async () => {
  const h = harness();
  let response = await route(h, "POST", "/v1/billing/runtime/authorize", null);
  assert.equal(response.status, 200);
  assert.equal(response.payload.charged, false);
  assert.equal(response.payload.mode, "sandbox_no_charge");
  assert.deepEqual(h.calls[0], ["authorize", {}]);
  assert.equal(h.calls[1][1].operation, "authorize");

  response = await route(h, "POST", "/v1/billing/runtime/usage", { operation_id: "op" });
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls[2], ["usage", { operation_id: "op" }]);
  assert.equal(h.calls[3][1].operation, "usage");
});

test("denials map to payment-required without becoming charges", async () => {
  const h = harness({
    authorizeResult: { allowed: false, reason: "over_budget" },
    usageResult: { allowed: false, reason: "entitlement_inactive" },
  });
  assert.equal((await route(h, "POST", "/v1/billing/runtime/authorize", {})).status, 402);
  const response = await route(h, "POST", "/v1/billing/runtime/usage", {});
  assert.equal(response.status, 402);
  assert.equal(response.payload.charged, false);
});

test("authority and receipt failures are bounded as rejected requests", async () => {
  let h = harness({ authority: { authorize() { throw new Error("bad authority"); } } });
  let response = await route(h, "POST", "/v1/billing/runtime/authorize", []);
  assert.equal(response.status, 400);
  assert.equal(response.payload.reason, "billing_authority_rejected");
  assert.equal(response.payload.error, "bad authority");

  const calls = [];
  const handlers = createBillingRuntimeHandlers({
    authority: { mode: "sandbox", authorize: () => ({ allowed: true }) },
    authorizedAgent: () => true,
    agentAuthError: () => ({}),
    readJsonBody: async () => ({}),
    appendReceipt() { calls.push("receipt"); throw new Error("disk full"); },
    sendJson: (res, status, payload) => Object.assign(res, { status, payload }),
    cleanError: (error) => error.message,
  });
  h = { handlers };
  response = await route(h, "POST", "/v1/billing/runtime/authorize", {});
  assert.deepEqual(calls, ["receipt"]);
  assert.equal(response.status, 400);
  assert.equal(response.payload.error, "disk full");
});

test("direct handler covers explicit authorize and usage dispatch", async () => {
  const h = harness();
  let response = {};
  await h.handlers.handle({ body: {} }, response, false);
  assert.equal(response.status, 200);
  response = {};
  await h.handlers.handle({ body: {} }, response, true);
  assert.equal(response.status, 200);
});
