"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createDevelopmentRequestCoordinatorResolver,
  createDevelopmentRequestHandlers,
} = require("../lib/development-request-handlers");

const principal = Object.freeze({
  kind: "enrolled_device",
  tenant_id: "tenant_owner",
  user_id: "user_owner",
  device_id: "phone_owner",
  scopes: ["development.request"],
});

function response() {
  return { status: 0, body: null };
}

function harness(overrides = {}) {
  const calls = [];
  const result = { request_id: "devreq_1", display_name: "Repair voice", status: "captured" };
  const store = {
    create: async (...args) => { calls.push(["create", ...args]); return result; },
    list: async (...args) => { calls.push(["list", ...args]); return { items: [result], next_cursor: "" }; },
    get: async (...args) => { calls.push(["get", ...args]); return result; },
    rename: async (...args) => { calls.push(["rename", ...args]); return result; },
    updateProgress: async (...args) => { calls.push(["progress", ...args]); return result; },
    ...overrides.store,
  };
  const route = createDevelopmentRequestHandlers({
    store,
    readJsonBody: async (request) => request.body,
    sendJson: (target, status, body) => Object.assign(target, { status, body }),
    cleanError: (error) => error.message,
    coordinatorPrincipal: overrides.coordinatorPrincipal,
  });
  return { route, calls };
}

async function call(route, method, pathname, body, authPrincipal = principal, query = "") {
  const target = response();
  const handled = await route(
    { method, body, moaAuthPrincipal: authPrincipal },
    target,
    new URL(`http://gateway${pathname}${query}`),
  );
  return { handled, ...target };
}

test("HTTP collection, detail, and rename routes use only authenticated ownership", async () => {
  const { route, calls } = harness();
  assert.equal((await call(route, "POST", "/v1/development-requests", {
    idempotency_key: "submit-request-0001", display_name: "Repair voice",
  })).status, 201);
  assert.equal((await call(route, "GET", "/v1/development-requests", undefined, principal,
    "?limit=10&cursor=20")).status, 200);
  assert.equal((await call(route, "GET", "/v1/development-requests/devreq_1")).status, 200);
  assert.equal((await call(route, "POST", "/v1/development-requests/devreq_1/rename", {
    display_name: "Repair mobile voice", idempotency_key: "rename-request-0001",
  })).status, 200);
  assert.deepEqual(calls.map(([name]) => name), ["create", "list", "get", "rename"]);
  for (const [, observedPrincipal] of calls) {
    assert.deepEqual(observedPrincipal, {
      tenant_id: "tenant_owner", user_id: "user_owner", device_id: "phone_owner",
    });
  }
  assert.deepEqual(calls[1][2], { limit: "10", cursor: "20" });
});

test("Device progress is denied while exact coordinator scope can update the owner record", async () => {
  const coordinator = {
    kind: "development_request_coordinator",
    tenant_id: "tenant_owner",
    user_id: "user_owner",
    scopes: ["development.request.progress"],
  };
  const { route, calls } = harness({ coordinatorPrincipal: (request) => request.coordinator });
  const denied = await call(route, "POST", "/v1/development-requests/devreq_1/progress", {
    state: "running", summary: "forged phone progress", idempotency_key: "progress-phone-0001",
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, "development_request_coordinator_required");

  const target = response();
  await route({
    method: "POST",
    coordinator,
    body: { state: "running", summary: "Gateway task running", idempotency_key: "progress-server-0001" },
  }, target, new URL("http://gateway/v1/development-requests/devreq_1/progress"));
  assert.equal(target.status, 200);
  assert.deepEqual(calls, [["progress", {
    tenant_id: "tenant_owner", user_id: "user_owner", device_id: "",
  }, "devreq_1", {
    state: "running", summary: "Gateway task running", idempotency_key: "progress-server-0001",
  }]]);

  coordinator.scopes = ["development.request"];
  const wrongScope = response();
  await route({ method: "POST", coordinator, body: {} }, wrongScope,
    new URL("http://gateway/v1/development-requests/devreq_1/progress"));
  assert.equal(wrongScope.status, 403);
});

test("coordinator resolver requires one distinct exact Bearer token and server authority", () => {
  const resolve = createDevelopmentRequestCoordinatorResolver({
    token: "coordinator-secret",
    reservedTokens: ["gateway-secret"],
    authority: () => ({ tenant_id: "tenant_owner", owner_id: "user_owner" }),
  });
  assert.deepEqual(resolve({ headers: { authorization: "Bearer coordinator-secret" } }), {
    kind: "development_request_coordinator",
    tenant_id: "tenant_owner",
    user_id: "user_owner",
    scopes: ["development.request.progress"],
  });
  for (const authorization of [
    "Device coordinator-secret", "Bearer gateway-secret", "Bearer coordinator-secret-extra", "",
  ]) assert.equal(resolve({ headers: { authorization } }), null);

  const duplicate = createDevelopmentRequestCoordinatorResolver({
    token: "gateway-secret",
    reservedTokens: ["gateway-secret"],
    authority: () => ({ tenant_id: "tenant_owner", owner_id: "user_owner" }),
  });
  assert.equal(duplicate({ headers: { authorization: "Bearer gateway-secret" } }), null);
});

test("HTTP routes reject missing scope, missing principal, forged identities, and cross-owner detail", async () => {
  let storeCalls = 0;
  const crossOwner = new Error("not found");
  crossOwner.code = "development_request_not_found";
  crossOwner.statusCode = 404;
  const { route } = harness({
    store: {
      create: async () => { storeCalls += 1; },
      get: async () => { throw crossOwner; },
    },
  });
  const noScope = { ...principal, scopes: ["conversation.write"] };
  assert.equal((await call(route, "POST", "/v1/development-requests", {}, noScope)).status, 403);
  assert.equal((await call(route, "GET", "/v1/development-requests", undefined, null)).status, 401);
  for (const body of [
    { tenant_id: "tenant_other" },
    { owner_user_id: "user_other" },
    { user_id: "user_other" },
    { device_id: "phone_other" },
  ]) {
    const result = await call(route, "POST", "/v1/development-requests", body);
    assert.equal(result.status, 403);
    assert.equal(result.body.error, "identity_mismatch");
  }
  assert.equal((await call(route, "GET", "/v1/development-requests/foreign")).status, 404);
  assert.equal(storeCalls, 0);
});

test("HTTP router does not claim privileged development paths or unknown operations", async () => {
  const { route } = harness();
  assert.equal((await call(route, "POST", "/v1/development/intents", {})).handled, false);
  const unknown = await call(route, "POST", "/v1/development-requests/devreq_1/dispatch", {});
  assert.equal(unknown.handled, true);
  assert.equal(unknown.status, 405);
  assert.equal((await call(route, "DELETE", "/v1/development-requests/devreq_1")).status, 405);
});
