"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createUiSpecHandlers } = require("../lib/ui-spec-handlers");

function harness(overrides = {}) {
  const calls = [];
  const store = {
    replace: (spec) => calls.push(["replace", spec]),
    reset: () => calls.push(["reset"]),
    ...overrides.store,
  };
  const handlers = createUiSpecHandlers({
    authorizedAgent: overrides.authorizedAgent || (() => true),
    agentAuthError: () => ({ error: "unauthorized" }),
    accountUserId: () => "usr_test",
    uiSpecForUser: (userId) => { calls.push(["store", userId]); return store; },
    uiSpecPayload: (userId) => ({ user_id: userId, spec: { surfaces: [] } }),
    readJsonBody: async (request) => request.body,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    cleanError: (error) => String(error?.message || error),
  });
  return { handlers, calls };
}

async function route(h, method, pathname, body) {
  const response = {};
  const handled = await h.handlers.routeUiSpec(
    { method, body }, response, new URL(pathname, "http://local"),
  );
  return { handled, ...response };
}

test("route authorizes the UI-spec family and ignores unrelated combinations", async () => {
  const denied = harness({ authorizedAgent: () => false });
  const response = await route(denied, "GET", "/v1/ui/spec");
  assert.equal(response.handled, true);
  assert.equal(response.status, 401);
  assert.deepEqual(response.payload, { error: "unauthorized" });

  const h = harness();
  assert.equal((await route(h, "GET", "/unrelated")).handled, false);
  assert.equal((await route(h, "DELETE", "/v1/ui/spec")).handled, false);
  assert.equal((await route(h, "GET", "/v1/ui/spec/reset")).handled, false);
});

test("GET returns the account-scoped effective payload", async () => {
  const response = await route(harness(), "GET", "/v1/ui/spec");
  assert.equal(response.status, 200);
  assert.equal(response.payload.user_id, "usr_test");
});

test("PUT accepts wrapped, bare, and primitive bodies and bounds errors", async () => {
  const h = harness();
  let response = await route(h, "PUT", "/v1/ui/spec", { spec: { surfaces: [{ id: "wrapped" }] } });
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls[1], ["replace", { surfaces: [{ id: "wrapped" }] }]);

  response = await route(h, "PUT", "/v1/ui/spec", { surfaces: [{ id: "bare" }] });
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls[3], ["replace", { surfaces: [{ id: "bare" }] }]);

  response = await route(h, "PUT", "/v1/ui/spec", null);
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls[5], ["replace", {}]);

  const failed = harness({ store: { replace() { throw new Error("invalid spec"); } } });
  response = await route(failed, "PUT", "/v1/ui/spec", []);
  assert.equal(response.status, 400);
  assert.equal(response.payload.error, "invalid spec");
});

test("reset clears the account-scoped store before returning defaults", async () => {
  const h = harness();
  const response = await route(h, "POST", "/v1/ui/spec/reset");
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls, [["store", "usr_test"], ["reset"]]);
});

test("direct PUT handler uses its account fallback", async () => {
  const h = harness();
  const response = {};
  await h.handlers.handlePut({ body: { surfaces: [{ id: "direct" }] } }, response);
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls[0], ["store", "usr_test"]);
});
