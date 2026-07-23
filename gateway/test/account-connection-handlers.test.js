"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAccountConnectionHandlers } = require("../lib/account-connection-handlers");

function harness(overrides = {}) {
  const calls = [];
  const connection = { id: "conn-1", provider_label: "Provider <One>", label: "Work & Home" };
  const store = {
    oauthStartRedirect: (state) => `https://provider.test/auth?state=${state}`,
    completeOauthCallback: async (input) => { calls.push(["callback", input]); return { connection }; },
    secretFormInfo: (token) => ({ token }),
    submitSecretForm: (token, body) => ({ connection, token, received: body.secret }),
    catalog: () => [{ id: "provider" }],
    list: (userId) => [{ id: "conn-1", userId }],
    create: (userId, body) => ({ statusCode: 201, connection: { id: "created", userId, ...body }, reauth_action: null }),
    listNotifications: (query) => [{ id: "notification", query }],
    recordNotificationReceipt: (userId, id, body) => ({ userId, id, ...body }),
    runHealthChecks: async () => ({ checked: 1 }),
    get: (userId, id) => ({ userId, id }),
    patch: (userId, id, body) => ({ userId, id, ...body }),
    requestRefresh: async (userId, id) => ({ statusCode: 202, connection: { userId, id, refreshed: true } }),
    requestReauth: (userId, id) => ({ connection: { userId, id }, reauth_action: { kind: "oauth" } }),
    disable: (userId, id) => ({ userId, id, status: "disabled" }),
    disconnect: async (userId, id) => ({ userId, id, status: "disconnected" }),
  };
  const deps = {
    accountConnections: store,
    authorizedAgent: () => true,
    agentAuthError: () => ({ error: "agent auth" }),
    accountUserId: () => "user-1",
    readJsonBody: async (request) => request.body || {},
    readFormOrJsonBody: async (request) => ({ body: request.body || {}, isForm: request.isForm === true }),
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    sendAccountHtml: (response, status, title, message) => Object.assign(response, { status, title, message }),
    sendAccountSecretForm: (response, info) => Object.assign(response, { status: 200, info }),
    escapeHtml: (value) => String(value).replaceAll("<", "&lt;").replaceAll("&", "&amp;"),
    cleanError: (error) => error.message,
    ...overrides,
  };
  return { handlers: createAccountConnectionHandlers(deps), store, calls, connection };
}

const request = (method, body = {}, extra = {}) => ({ method, body, ...extra });
const url = (path) => new URL(`http://gateway.test${path}`);

test("router ignores unrelated paths and protects token-authenticated routes", async () => {
  let state = harness();
  assert.equal(await state.handlers.routeAccountConnections(request("GET"), {}, url("/elsewhere")), false);
  state = harness({ authorizedAgent: () => false });
  const response = {};
  assert.equal(await state.handlers.routeAccountConnections(request("GET"), response, url("/v1/account-providers")), true);
  assert.deepEqual(response, { status: 401, payload: { error: "agent auth" } });
});

test("browser-facing OAuth and secret-form routes bypass bearer auth safely", async () => {
  const state = harness({ authorizedAgent: () => false });
  let response = { writeHead: (status, headers) => Object.assign(response, { status, headers }), end: () => { response.ended = true; } };
  await state.handlers.routeAccountConnections(request("GET"), response, url("/v1/account-connections/oauth/start?state=s-1"));
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "https://provider.test/auth?state=s-1");
  assert.equal(response.ended, true);

  response = {};
  await state.handlers.routeAccountConnections(request("GET"), response, url("/v1/account-connections/oauth/callback?state=s&code=c&error=e"));
  assert.equal(response.title, "Account connected");
  assert.deepEqual(state.calls[0][1], { state: "s", code: "c", error: "e" });

  response = {};
  await state.handlers.routeAccountConnections(request("GET"), response, url("/v1/account-connections/secret-form?token=t"));
  assert.equal(response.info.token, "t");

  response = {};
  await state.handlers.routeAccountConnections(request("POST", { token: "t", secret: "value" }), response, url("/v1/account-connections/secret-form"));
  assert.equal(response.payload.received, "value");
  response = {};
  await state.handlers.routeAccountConnections(request("POST", { token: "t", secret: "value" }, { isForm: true }), response, url("/v1/account-connections/secret-form"));
  assert.equal(response.title, "Credential stored");
  assert.match(response.message, /stored encrypted/);
});

test("catalog, collection, creation, notification, and health routes preserve scope", async () => {
  const state = harness();
  const cases = [
    ["GET", "/v1/account-providers", {}, 200, "providers"],
    ["GET", "/v1/account-connections", {}, 200, "connections"],
    ["POST", "/v1/account-connections", { label: "New" }, 201, "connection"],
    ["GET", "/v1/account-connections/notifications?device_id=phone&status=pending", {}, 200, "notifications"],
    ["POST", "/v1/account-connections/notifications/n-1/receipt", { ok: true }, 200, "notification"],
    ["POST", "/v1/account-connections/health/run", {}, 200, "summary"],
  ];
  for (const [method, path, body, status, key] of cases) {
    const response = {};
    await state.handlers.routeAccountConnections(request(method, body), response, url(path));
    assert.equal(response.status, status);
    assert.ok(response.payload[key]);
  }
  const notification = {};
  await state.handlers.routeAccountConnections(request("GET"), notification, url("/v1/account-connections/notifications"));
  assert.deepEqual(notification.payload.notifications[0].query, { userId: "user-1", deviceId: "", status: "" });
});

test("item read, patch, refresh, reauth, disable, and disconnect routes delegate exactly", async () => {
  const state = harness();
  const cases = [
    ["GET", "/v1/account-connections/conn-1", {}, 200, "connection"],
    ["PATCH", "/v1/account-connections/conn-1", { label: "Changed" }, 200, "connection"],
    ["POST", "/v1/account-connections/conn-1/refresh", {}, 202, "connection"],
    ["POST", "/v1/account-connections/conn-1/reauth", {}, 200, "reauth_action"],
    ["POST", "/v1/account-connections/conn-1/disable", {}, 200, "connection"],
    ["POST", "/v1/account-connections/conn-1/disconnect", {}, 200, "connection"],
  ];
  for (const [method, path, body, status, key] of cases) {
    const response = {};
    await state.handlers.routeAccountConnections(request(method, body), response, url(path));
    assert.equal(response.status, status);
    assert.ok(response.payload[key]);
  }
});

test("unknown collection methods, malformed paths, extra segments, and actions return 404", async () => {
  const state = harness();
  for (const [method, path] of [
    ["DELETE", "/v1/account-connections"],
    ["GET", "/v1/account-connections/"],
    ["GET", "/v1/account-connections/a/b/c"],
    ["POST", "/v1/account-connections/a/unknown"],
    ["POST", "/v1/account-providers"],
  ]) {
    const response = {};
    assert.equal(await state.handlers.routeAccountConnections(request(method), response, url(path)), true);
    assert.deepEqual(response, { status: 404, payload: { error: "not found" } });
  }
});

test("typed and unexpected failures retain status, payload, and bounded errors", async () => {
  let state = harness({ accountConnections: { oauthStartRedirect: () => { const error = new Error("expired"); error.statusCode = 410; error.payload = { code: "expired" }; throw error; } } });
  let response = {};
  await state.handlers.routeAccountConnections(request("GET"), response, url("/v1/account-connections/oauth/start"));
  assert.deepEqual(response, { status: 410, payload: { error: "expired", code: "expired" } });

  state = harness({ accountConnections: { catalog: () => { throw "offline"; } }, cleanError: String });
  response = {};
  await state.handlers.routeAccountConnections(request("GET"), response, url("/v1/account-providers"));
  assert.deepEqual(response, { status: 500, payload: { error: "offline" } });
});

test("empty browser-flow query parameters retain safe defaults", async () => {
  const state = harness();
  let response = { writeHead: (status, headers) => Object.assign(response, { status, headers }), end: () => {} };
  await state.handlers.routeAccountConnections(request("GET"), response, url("/v1/account-connections/oauth/start"));
  assert.match(response.headers.location, /state=$/);
  response = {};
  await state.handlers.routeAccountConnections(request("GET"), response, url("/v1/account-connections/oauth/callback"));
  assert.deepEqual(state.calls[0][1], { state: "", code: "", error: "" });
});
