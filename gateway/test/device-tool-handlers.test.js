"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_TOOL_REQUEST_RECEIPTS,
  TOOL_REQUEST_CLAIM_LEASE_MS,
  createDeviceToolHandlers,
  isToolRequestStateClaimable,
} = require("../lib/device-tool-handlers");

function harness(overrides = {}) {
  const { current: currentOverride, ...depOverrides } = overrides;
  const events = [];
  const updates = [];
  const devices = { phone: { id: "phone", surface_type: "android" } };
  const current = {
    id: "req-1",
    status: "claimed",
    target_device_id: "phone",
    claimed_by: "phone",
    claim_id: "claim-generated",
    claimed_at: "2026-07-15T00:00:00.000Z",
    lease_expires_at: "2026-07-15T00:05:00.000Z",
    receipts: [],
    ...(currentOverride || {}),
  };
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
    claimNextToolRequest: () => ({ ...current }),
    sanitizeId: (value) => String(value),
    toolRequestExists: () => true,
    readToolRequest: () => current,
    randomId: (prefix) => `${prefix}-generated`,
    truncate: (value, limit) => value.slice(0, limit),
    sanitizeToolJson: (value) => value,
    updateToolRequest: (id, patch) => { Object.assign(current, patch, { id }); updates.push({ ...current }); return { ...current }; },
    now: () => "2026-07-15T00:00:00.000Z",
    ...depOverrides,
  };
  return { handlers: createDeviceToolHandlers(deps), events, updates, devices, current };
}

function request(method, body = {}) { return { method, body }; }
function url(pathname) { return new URL(`http://gateway.test${pathname}`); }
function receiptBody(overrides = {}) {
  return {
    device_id: "phone",
    claim_id: "claim-generated",
    receipt_id: "receipt-1",
    ok: true,
    summary: "done",
    result: { done: true },
    ...overrides,
  };
}

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
  await handlers.routeDeviceTools(request("POST", receiptBody()), response, url("/v1/tool/requests/req-1/receipts"));
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

test("heartbeat and exact terminal receipt notify optional delivery hooks", async () => {
  const heartbeats = [];
  const receipts = [];
  const state = harness({
    onDeviceHeartbeat: async (device) => heartbeats.push(device.id),
    onTerminalReceipt: async (toolRequest, receipt) => receipts.push([toolRequest.id, receipt.id]),
  });
  let response = {};
  await state.handlers.handleDeviceClientHeartbeat(request("POST", { device_id: "phone" }), response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(heartbeats, ["phone"]);

  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", receiptBody()), response, "req-1");
  assert.deepEqual(receipts, [["req-1", "receipt-1"]]);
  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", receiptBody()), response, "req-1");
  assert.deepEqual(receipts, [["req-1", "receipt-1"], ["req-1", "receipt-1"]]);
});

test("delivery hook failures do not erase canonical heartbeat or receipt results", async () => {
  const state = harness({
    onDeviceHeartbeat: async () => { throw new Error("projection offline"); },
    onTerminalReceipt: async () => { throw new Error("projection offline"); },
  });
  let response = {};
  await state.handlers.handleDeviceClientHeartbeat(request("POST", { device_id: "phone" }), response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(response.status, 200);
  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", receiptBody()), response, "req-1");
  assert.equal(response.status, 200);
  assert.equal(response.payload.receipt.id, "receipt-1");
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
  assert.equal(response.payload.request.claim_id, "claim-generated");
});

test("receipts enforce target and claimant before recording success or failure", async () => {
  let state = harness({ toolRequestExists: () => false });
  let response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", {}), response, "missing");
  assert.equal(response.status, 404);

  state = harness({ readToolRequest: () => ({ target_device_id: "tablet", claimed_by: "tablet" }) });
  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", receiptBody({ deviceId: "phone", device_id: undefined })), response, "req-1");
  assert.equal(response.status, 403);

  state = harness({ readToolRequest: () => ({ target_device_id: "phone", claimed_by: "tablet" }) });
  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", receiptBody()), response, "req-1");
  assert.equal(response.status, 403);

  state = harness();
  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", receiptBody({
    result: undefined, output: { done: true }, localReceipt: { id: 1 },
  })), response, "req-1");
  assert.equal(response.payload.receipt.ok, true);
  assert.deepEqual(response.payload.receipt.result, { done: true });

  state = harness({
    now: undefined,
    current: { claimed_by: "", lease_expires_at: "2099-01-01T00:00:00.000Z" },
  });
  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", receiptBody({
    error: "failed", result: 0, local_receipt: { id: 2 },
  })), response, "req-1");
  assert.equal(response.payload.receipt.ok, false);
  assert.equal(response.payload.receipt.device_id, "phone");
  assert.match(response.payload.receipt.ts, /^2026-/);
  assert.equal(response.payload.request.status, "failed");
});

test("claim replaces any prior claim with a fresh strict id and covers the Android approval window plus margin", async () => {
  const state = harness({
    current: { claim_id: "claim-old", lease_expires_at: "2026-07-15T00:01:00.000Z" },
  });
  const response = {};
  await state.handlers.handleClaimToolRequest(request("POST", { device_id: "phone" }), response);
  assert.equal(response.status, 200);
  assert.equal(response.payload.request.claim_id, "claim-generated");
  assert.equal(state.current.claim_id, "claim-generated");
  assert.equal(
    Date.parse(response.payload.request.lease_expires_at) - Date.parse("2026-07-15T00:00:00.000Z"),
    TOOL_REQUEST_CLAIM_LEASE_MS,
  );
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0][1], "claimed");
});

test("claim rejects invalid store state, identity, clock, and generated id", async () => {
  for (const overrides of [
    { current: { status: "completed" } },
    { current: { claimed_by: "tablet" } },
    { now: () => "invalid" },
    { randomId: () => " invalid" },
  ]) {
    const state = harness(overrides);
    const response = {};
    await state.handlers.handleClaimToolRequest(request("POST", { device_id: "phone" }), response);
    assert.ok([409, 500].includes(response.status), JSON.stringify(response));
    assert.equal(state.events.length, 0);
  }
});

test("claimability excludes terminal work and treats the exact lease boundary as expired", () => {
  const boundary = Date.parse("2026-07-15T00:02:30.000Z");
  assert.equal(isToolRequestStateClaimable({ status: "pending" }, boundary), true);
  assert.equal(isToolRequestStateClaimable({ status: "completed", lease_expires_at: "2000-01-01" }, boundary), false);
  assert.equal(isToolRequestStateClaimable({ status: "failed", lease_expires_at: "2000-01-01" }, boundary), false);
  assert.equal(isToolRequestStateClaimable({ status: "claimed", lease_expires_at: "2026-07-15T00:02:30.000Z" }, boundary), true);
  assert.equal(isToolRequestStateClaimable({ status: "claimed", lease_expires_at: "2026-07-15T00:02:30.001Z" }, boundary), false);
  assert.equal(isToolRequestStateClaimable({ status: "claimed", lease_expires_at: "invalid" }, boundary), false);
});

test("exact receipt retry returns the stored terminal receipt without another update or event", async () => {
  const state = harness();
  const body = receiptBody({
    idempotency_key: "receipt-1",
    result: { nested: { b: 2, a: 1 } },
  });
  let response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", body), response, "req-1");
  assert.equal(response.status, 200);
  assert.equal(response.payload.idempotent_replay, false);
  const first = response.payload.receipt;
  assert.match(first.binding_digest, /^[a-f0-9]{64}$/);

  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", {
    ...body,
    result: { nested: { a: 1, b: 2 } },
  }), response, "req-1");
  assert.equal(response.status, 200);
  assert.equal(response.payload.idempotent_replay, true);
  assert.deepEqual(response.payload.receipt, first);
  assert.equal(state.current.receipts.length, 1);
  assert.equal(state.updates.length, 1);
  assert.equal(state.events.filter((entry) => entry[1] === "receipt").length, 1);
});

test("conflicting receipt retries and alternate terminal receipts return 409", async () => {
  const state = harness();
  let response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", receiptBody()), response, "req-1");
  assert.equal(response.status, 200);

  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", receiptBody({ result: { done: false } })), response, "req-1");
  assert.equal(response.status, 409);

  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", receiptBody({ receipt_id: "receipt-2" })), response, "req-1");
  assert.equal(response.status, 409);
  assert.equal(state.current.receipts.length, 1);
  assert.equal(state.events.filter((entry) => entry[1] === "receipt").length, 1);
});

test("receipt identity aliases are required, strict, bounded, and equal", async () => {
  for (const body of [
    { device_id: "phone", claim_id: "claim-generated" },
    receiptBody({ receipt_id: " bad" }),
    receiptBody({ receipt_id: "x".repeat(121) }),
    receiptBody({ idempotency_key: "different" }),
    receiptBody({ claim_id: undefined }),
  ]) {
    const state = harness();
    const response = {};
    await state.handlers.handleToolRequestReceipt(request("POST", body), response, "req-1");
    assert.equal(response.status, 400, JSON.stringify(response));
    assert.equal(state.updates.length, 0);
  }
});

test("late receipts from expired or reassigned claims fail closed", async () => {
  let state = harness({ current: { lease_expires_at: "2026-07-15T00:00:00.000Z" } });
  let response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", receiptBody()), response, "req-1");
  assert.equal(response.status, 409);
  assert.match(response.payload.error, /expired/);

  state = harness({ current: { claim_id: "claim-newer" } });
  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", receiptBody()), response, "req-1");
  assert.equal(response.status, 409);
  assert.match(response.payload.error, /stale/);

  state = harness({ current: { claimed_by: "tablet", target_device_id: "" } });
  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", receiptBody()), response, "req-1");
  assert.equal(response.status, 403);
  assert.equal(state.updates.length, 0);
});

test("receipts reject invalid clocks, non-claimed state, and preexisting nonterminal ids", async () => {
  for (const overrides of [
    { now: () => "invalid" },
    { current: { status: "pending" } },
    { current: { receipts: [{ id: "receipt-1" }] } },
  ]) {
    const state = harness(overrides);
    const response = {};
    await state.handlers.handleToolRequestReceipt(request("POST", receiptBody()), response, "req-1");
    assert.ok([409, 500].includes(response.status), JSON.stringify(response));
    assert.equal(state.updates.length, 0);
    assert.equal(state.events.length, 0);
  }
});

test("receipt collection fails closed at its fixed capacity", async () => {
  const receipts = Array.from({ length: MAX_TOOL_REQUEST_RECEIPTS }, (_, index) => ({ id: `old-${index}` }));
  const state = harness({ current: { receipts } });
  const response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", receiptBody()), response, "req-1");
  assert.equal(response.status, 507);
  assert.equal(state.current.receipts.length, MAX_TOOL_REQUEST_RECEIPTS);
  assert.equal(state.updates.length, 0);
  assert.equal(state.events.length, 0);
});
