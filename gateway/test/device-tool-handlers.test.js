"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDeviceToolHandlers } = require("../lib/device-tool-handlers");

function harness(overrides = {}) {
  const events = [];
  const updates = [];
  const devices = { phone: { id: "phone", surface_type: "android" } };
  const current = { id: "req-1", target_device_id: "phone", claimed_by: "phone", receipts: [] };
  const deps = {
    authorized: () => true,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    readJsonBody: async (request) => request.body || {},
    listDeviceClients: () => Object.values(devices),
    listToolRequests: (query) => [{ id: "listed", query }],
    upsertDeviceClient: (body) => ({ id: body.device_id || body.deviceId || body.client_id || body.clientId || "phone" }),
    claimableToolRequestsForDevice: () => [{ id: "pending" }],
    cleanError: (error) => error.message,
    createToolRequest: (body) => ({ id: "req-created", ...body }),
    recordToolRequestProductEvent: async (...args) => events.push(args),
    summarizeToolRequest: (value, options = {}) => ({ ...value, include_input: options.includeInput === true }),
    normalizeDeviceId: (value) => String(value || "").trim(),
    readDeviceClientsMap: () => devices,
    claimNextToolRequest: () => ({ id: "req-1", target_device_id: "phone" }),
    sanitizeId: (value) => String(value),
    toolRequestExists: () => true,
    readToolRequest: () => current,
    randomId: () => "receipt-1",
    truncate: (value, limit) => value.slice(0, limit),
    sanitizeToolJson: (value) => value,
    updateToolRequest: (id, patch) => { const next = { ...current, ...patch, id }; updates.push(next); return next; },
    now: () => "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
  return { handlers: createDeviceToolHandlers(deps), events, updates, devices, current };
}

function request(method, body = {}) { return { method, body }; }
function url(pathname) { return new URL(`http://gateway.test${pathname}`); }

test("router authorizes device/tool routes and leaves unrelated traffic alone", async () => {
  const denied = harness({ authorized: () => false });
  let response = {};
  assert.equal(await denied.handlers.routeDeviceTools(request("GET"), response, url("/v1/device-clients")), true);
  assert.deepEqual(response, { status: 401, payload: { error: "missing or invalid gateway token" } });
  assert.equal(await denied.handlers.routeDeviceTools(request("GET"), {}, url("/unrelated")), false);

  const { handlers, events } = harness();
  response = {};
  await handlers.routeDeviceTools(request("GET"), response, url("/v1/device-clients"));
  assert.equal(response.payload.devices[0].id, "phone");
  response = {};
  await handlers.routeDeviceTools(request("POST", { device_id: "phone" }), response, url("/v1/device-clients/heartbeat"));
  assert.equal(response.payload.pending_request_count, 1);
  response = {};
  await handlers.routeDeviceTools(request("GET"), response, url("/v1/tool/requests?status=pending&device_id=phone&source_device_id=web&limit=7"));
  assert.deepEqual(response.payload.requests[0].query, { status: "pending", targetDeviceId: "phone", sourceDeviceId: "web", limit: 7 });
  response = {};
  await handlers.routeDeviceTools(request("POST", { tool_name: "open" }), response, url("/v1/tool/requests"));
  assert.equal(response.status, 202);
  response = {};
  await handlers.routeDeviceTools(request("POST", { device_id: "phone" }), response, url("/v1/tool/requests/claim"));
  assert.equal(response.status, 200);
  response = {};
  await handlers.routeDeviceTools(request("POST", { device_id: "phone" }), response, url("/v1/tool/requests/req-1/receipts"));
  assert.equal(response.status, 200);
  assert.deepEqual(events.map((entry) => entry[1]), ["queued", "claimed", "receipt"]);
});

test("list query supports preferred target and bounded defaults", async () => {
  const { handlers } = harness();
  let response = {};
  await handlers.routeDeviceTools(request("GET"), response, url("/v1/tool/requests?target_device_id=tablet"));
  assert.deepEqual(response.payload.requests[0].query, { status: "", targetDeviceId: "tablet", sourceDeviceId: "", limit: 25 });
  response = {};
  await handlers.routeDeviceTools(request("GET"), response, url("/v1/tool/requests"));
  assert.equal(response.payload.requests[0].query.targetDeviceId, "");
});

test("heartbeat and creation convert validation failures to bounded responses", async () => {
  let state = harness({ upsertDeviceClient: () => { throw new Error("bad device"); } });
  let response = {};
  await state.handlers.handleDeviceClientHeartbeat(request("POST", {}), response);
  assert.deepEqual(response, { status: 400, payload: { error: "bad device" } });
  state = harness({ createToolRequest: () => { throw new Error("bad request"); } });
  response = {};
  await state.handlers.handleCreateToolRequest(request("POST", {}), response);
  assert.deepEqual(response, { status: 400, payload: { error: "bad request" } });
});

test("claim validates identity, optional heartbeat, availability, and aliases", async () => {
  let state = harness();
  let response = {};
  await state.handlers.handleClaimToolRequest(request("POST", {}), response);
  assert.equal(response.status, 400);

  state = harness({ readDeviceClientsMap: () => ({}) });
  response = {};
  await state.handlers.handleClaimToolRequest(request("POST", { deviceId: "missing" }), response);
  assert.equal(response.status, 404);

  state = harness({ readDeviceClientsMap: () => ({}), upsertDeviceClient: () => { throw new Error("invalid manifest"); } });
  response = {};
  await state.handlers.handleClaimToolRequest(request("POST", { client_id: "new", surface_type: "android" }), response);
  assert.deepEqual(response, { status: 400, payload: { error: "invalid manifest" } });

  state = harness({ readDeviceClientsMap: () => ({}), claimNextToolRequest: () => null });
  response = {};
  await state.handlers.handleClaimToolRequest(request("POST", { clientId: "new", capabilities: ["screen"] }), response);
  assert.equal(response.status, 204);

  state = harness();
  response = {};
  await state.handlers.handleClaimToolRequest(request("POST", { device_id: "phone" }), response);
  assert.equal(response.payload.request.include_input, true);
});

test("receipts enforce target and claimant before recording success or failure", async () => {
  let state = harness({ toolRequestExists: () => false });
  let response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", {}), response, "missing");
  assert.equal(response.status, 404);

  state = harness({ readToolRequest: () => ({ target_device_id: "tablet", claimed_by: "tablet" }) });
  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", { deviceId: "phone" }), response, "req-1");
  assert.equal(response.status, 403);

  state = harness({ readToolRequest: () => ({ target_device_id: "phone", claimed_by: "tablet" }) });
  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", { device_id: "phone" }), response, "req-1");
  assert.equal(response.status, 403);

  state = harness({ readToolRequest: () => ({ id: "req-1", target_device_id: "phone", claimed_by: "phone" }) });
  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", { device_id: "phone", output: { done: true }, localReceipt: { id: 1 } }), response, "req-1");
  assert.equal(response.payload.receipt.ok, true);
  assert.deepEqual(response.payload.receipt.result, { done: true });

  state = harness({ now: undefined, readToolRequest: () => ({ id: "req-1", target_device_id: "phone", claimed_by: "" }) });
  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", { error: "failed", result: 0, local_receipt: { id: 2 } }), response, "req-1");
  assert.equal(response.payload.receipt.ok, false);
  assert.equal(response.payload.receipt.device_id, "phone");
  assert.match(response.payload.receipt.ts, /^2026-/);
  assert.equal(response.payload.request.status, "failed");
});
