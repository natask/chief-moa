"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDeviceToolHandlers } = require("../lib/device-tool-handlers");
const {
  PROGRAM_TOOL,
  createSurfaceProgramEnvelope,
  receiptDigest,
  sanitizeExecutionRuntime,
  sha256,
  surfaceProgramReceiptBindings,
} = require("../lib/surface-program-protocol");

const PROGRAM_NOW = Date.parse("2026-07-15T00:00:00.000Z");
const hex = (letter) => letter.repeat(64);

function programEnvelope() {
  const advertisement = sanitizeExecutionRuntime({
    version: 1, type: "surface.runtime.advertised", advertisement_id: "ad-1",
    target: { surface_type: "browser_extension", device_id: "phone" },
    runtime: { runtime_id: "browser.javascript.v1", language: "javascript", bridge_version: 1, entrypoint: "main" },
    catalog: { version: 1, sha256: hex("a"), capability_ids: ["browser.observe"] },
    limits: { source_bytes: 4096, wall_ms: 30000, memory_bytes: 32 * 1024 * 1024, tool_calls: 10, parallel_calls: 4, result_bytes: 4096, log_bytes: 1024 },
    issued_at: new Date(PROGRAM_NOW - 1000).toISOString(), expires_at: new Date(PROGRAM_NOW + 60000).toISOString(),
  });
  return createSurfaceProgramEnvelope({
    source: "return await tools.browser.observe({});", session_id: "session-1", turn_id: "turn-1",
    bindings: { kind: "browser_document", tab_id: 1, window_id: 1, frame_id: 0, origin: "https://fixture.test", document_id: "doc-1", page_epoch: 1, observation_id: "obs", observation_sha256: hex("b"), state_sha256: hex("c") },
    approval_policy: { program: "local_policy", always_ask: [] }, expires_in_ms: 30000,
  }, { device: { device_id: "phone", surface_type: "browser_extension" }, advertisement }, { nowMs: PROGRAM_NOW, executionId: "exec-1", idempotencyKey: "idem-1" });
}

function terminalReceipt(envelope, overrides = {}) {
  const value = {
    version: 1, type: "surface.execution.receipt", receipt_id: "receipt-local-1",
    execution_id: envelope.execution_id, session_id: envelope.session_id, turn_id: envelope.turn_id,
    claimant: { surface_type: "browser_extension", device_id: "phone", client_instance_id: "client-1" },
    runtime_id: envelope.runtime.runtime_id, ...surfaceProgramReceiptBindings(envelope),
    started_at: new Date(PROGRAM_NOW + 100).toISOString(), finished_at: new Date(PROGRAM_NOW + 200).toISOString(), status: "completed",
    tool_attempts: { count: 0, first_receipt_sha256: null, last_receipt_sha256: null },
    result: { summary: "done", data_sha256: null, artifact_refs: [] }, final_state_sha256: hex("d"),
    error: { code: null, message: null }, previous_receipt_sha256: null, receipt_sha256: hex("e"), ...overrides,
  };
  value.receipt_sha256 = receiptDigest(value);
  return value;
}

function lifecycle(envelope, terminal = terminalReceipt(envelope)) {
  const claimant = { surface_type: "browser_extension", device_id: "phone", client_instance_id: "client-1" };
  return [
    { version: 1, type: "surface.execution.event", event_id: "event-1", execution_id: envelope.execution_id, sequence: 1, kind: "accepted", occurred_at: new Date(PROGRAM_NOW + 10).toISOString(), claimant, payload: { proposal_sha256: sha256(envelope) } },
    { version: 1, type: "surface.execution.event", event_id: "event-2", execution_id: envelope.execution_id, sequence: 2, kind: "terminal", occurred_at: new Date(PROGRAM_NOW + 20).toISOString(), claimant, payload: { status: terminal.status, receipt_id: terminal.receipt_id, receipt_sha256: terminal.receipt_sha256 } },
  ];
}

function programEvent(envelope, sequence, kind, payload) {
  return { version: 1, type: "surface.execution.event", event_id: `event-${sequence}`, execution_id: envelope.execution_id, sequence, kind, occurred_at: new Date(PROGRAM_NOW + sequence).toISOString(), claimant: { surface_type: "browser_extension", device_id: "phone", client_instance_id: "client-1" }, payload };
}

function programToolReceipt(envelope, overrides = {}) {
  const value = {
    version: 1, type: "surface.execution.tool_receipt", receipt_id: "tool-receipt-1", execution_id: envelope.execution_id,
    claimant: { surface_type: "browser_extension", device_id: "phone", client_instance_id: "client-1" },
    tool_call_id: "call-1", attempt: 1, capability_id: "browser.observe", ...surfaceProgramReceiptBindings(envelope),
    input_sha256: hex("1"), pre_state_sha256: envelope.bindings.state_sha256, approval_id: null,
    started_at: new Date(PROGRAM_NOW + 10).toISOString(), finished_at: new Date(PROGRAM_NOW + 20).toISOString(), status: "succeeded",
    result: { summary: "Observed fixture", data_sha256: null, resource_id: "fixture" }, post_state_sha256: hex("2"),
    previous_receipt_sha256: null, receipt_sha256: hex("3"), ...overrides,
  };
  value.receipt_sha256 = receiptDigest(value);
  return value;
}

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

  state = harness({ readDeviceClientsMap: () => ({ phone: { id: "phone", client_instance_id: "instance-1" } }) });
  response = {};
  await state.handlers.handleClaimToolRequest(request("POST", { device_id: "phone" }), response);
  assert.equal(response.status, 409);
  response = {};
  await state.handlers.handleClaimToolRequest(request("POST", { device_id: "phone", client_instance_id: "instance-1" }), response);
  assert.equal(response.status, 200);
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

test("surface program receipts require a live exact claim and accept one terminal outcome", async () => {
  const input = programEnvelope();
  const body = terminalReceipt(input);
  const current = {
    id: "req-1", tool: PROGRAM_TOOL, input, status: "claimed", target_device_id: "phone",
    claimed_by: "phone", claimed_client_instance_id: "client-1", claim_id: "claim-1", claim_attempt: 1,
    lease_expires_at: new Date(PROGRAM_NOW + 60000).toISOString(), receipts: [], tool_receipts: [], surface_events: lifecycle(input, body),
  };
  const state = harness({ readToolRequest: () => current });
  let response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", body), response, "req-1");
  assert.equal(response.status, 200);
  assert.equal(response.payload.request.status, "completed");
  assert.equal(response.payload.receipt.local_receipt.execution_id, "exec-1");
  assert.equal(state.events[0][1], "receipt");

  const existing = { ...response.payload.receipt, terminal_digest: sha256(body) };
  const replay = harness({ readToolRequest: () => ({ ...current, receipts: [existing] }) });
  response = {};
  await replay.handlers.handleToolRequestReceipt(request("POST", body), response, "req-1");
  assert.equal(response.payload.idempotent_replay, true);

  response = {};
  await replay.handlers.handleToolRequestReceipt(request("POST", { ...body, receipt_id: "different" }), response, "req-1");
  assert.equal(response.status, 409);
});

test("surface program receipt rejects missing/expired claims and forged terminals", async () => {
  const input = programEnvelope();
  const completed = terminalReceipt(input);
  const base = {
    id: "req-1", tool: PROGRAM_TOOL, input, target_device_id: "phone", claimed_by: "phone",
    claimed_client_instance_id: "client-1", claim_id: "claim-1", claim_attempt: 1,
    lease_expires_at: new Date(PROGRAM_NOW + 60000).toISOString(), receipts: [], tool_receipts: [], surface_events: lifecycle(input, completed),
  };
  let state = harness({ readToolRequest: () => ({ ...base, status: "pending" }) });
  let response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", terminalReceipt(input)), response, "req-1");
  assert.equal(response.status, 409);

  state = harness({ readToolRequest: () => ({ ...base, status: "claimed", lease_expires_at: new Date(PROGRAM_NOW).toISOString() }) });
  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", terminalReceipt(input)), response, "req-1");
  assert.equal(response.status, 409);

  state = harness({ readToolRequest: () => ({ ...base, status: "claimed" }) });
  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", terminalReceipt(input, { runtime_id: "forged" })), response, "req-1");
  assert.equal(response.status, 400);
  assert.equal(response.payload.code, "runtime_id_mismatch");

  response = {};
  const stoppedBody = terminalReceipt(input, { status: "stopped", error: { code: "stopped", message: "user stopped" } });
  const stopped = { ...base, status: "claimed", surface_events: lifecycle(input, stoppedBody) };
  state = harness({ readToolRequest: () => stopped });
  await state.handlers.handleToolRequestReceipt(request("POST", stoppedBody), response, "req-1");
  assert.equal(response.status, 200);
  assert.equal(response.payload.request.status, "cancelled");
});

test("surface lifecycle and tool receipt routes enforce sequence, replay, and chains", async () => {
  const input = programEnvelope();
  let stored = {
    id: "req-1", tool: PROGRAM_TOOL, input, status: "claimed", target_device_id: "phone", claimed_by: "phone",
    claimed_client_instance_id: "client-1", claim_id: "claim-1", claim_attempt: 1,
    lease_expires_at: new Date(PROGRAM_NOW + 60000).toISOString(), receipts: [], surface_events: [], tool_receipts: [],
  };
  const state = harness({
    readToolRequest: () => stored,
    updateToolRequest: (_id, patch) => { stored = { ...stored, ...patch }; return stored; },
  });
  let response = {};
  const gap = programEvent(input, 2, "started", {});
  await state.handlers.handleSurfaceExecutionEvent(request("POST", gap), response, "req-1");
  assert.equal(response.status, 409);

  const accepted = programEvent(input, 1, "accepted", { proposal_sha256: sha256(input) });
  response = {};
  await state.handlers.handleSurfaceExecutionEvent(request("POST", accepted), response, "req-1");
  assert.equal(response.status, 202);
  response = {};
  await state.handlers.handleSurfaceExecutionEvent(request("POST", accepted), response, "req-1");
  assert.equal(response.payload.idempotent_replay, true);
  response = {};
  await state.handlers.handleSurfaceExecutionEvent(request("POST", { ...accepted, event_id: "conflict" }), response, "req-1");
  assert.equal(response.status, 409);

  const started = programEvent(input, 2, "tool_started", { capability_id: "browser.observe", tool_call_id: "call-1", attempt: 1 });
  response = {};
  await state.handlers.handleSurfaceExecutionEvent(request("POST", started), response, "req-1");
  assert.equal(response.status, 202);
  const tool = programToolReceipt(input);
  response = {};
  await state.handlers.handleSurfaceToolReceipt(request("POST", tool), response, "req-1");
  assert.equal(response.status, 202);
  response = {};
  await state.handlers.handleSurfaceToolReceipt(request("POST", tool), response, "req-1");
  assert.equal(response.payload.idempotent_replay, true);
  response = {};
  await state.handlers.handleSurfaceToolReceipt(request("POST", { ...tool, receipt_id: "conflict", result: { ...tool.result, summary: "different" } }), response, "req-1");
  assert.ok([400, 409].includes(response.status));

  const terminal = terminalReceipt(input, {
    tool_attempts: { count: 1, first_receipt_sha256: tool.receipt_sha256, last_receipt_sha256: tool.receipt_sha256 },
    previous_receipt_sha256: tool.receipt_sha256,
  });
  const terminalEvent = programEvent(input, 3, "terminal", { status: "completed", receipt_id: "receipt-local-1", receipt_sha256: terminal.receipt_sha256 });
  response = {};
  await state.handlers.handleSurfaceExecutionEvent(request("POST", terminalEvent), response, "req-1");
  assert.equal(response.status, 202);
  response = {};
  await state.handlers.handleSurfaceExecutionEvent(request("POST", programEvent(input, 4, "progress", { message: "late", completed: 1, total: 1 })), response, "req-1");
  assert.equal(response.status, 409);

  response = {};
  await state.handlers.handleToolRequestReceipt(request("POST", terminal), response, "req-1");
  assert.equal(response.status, 200);
  assert.equal(response.payload.request.status, "completed");
});

test("surface lifecycle routes reject missing, inactive, stale, mismatched, and unstarted input", async () => {
  const input = programEnvelope();
  const active = {
    id: "req-1", tool: PROGRAM_TOOL, input, status: "claimed", target_device_id: "phone", claimed_by: "phone",
    claimed_client_instance_id: "client-1", claim_id: "claim-1", lease_expires_at: new Date(PROGRAM_NOW + 60000).toISOString(),
    surface_events: [], tool_receipts: [], receipts: [],
  };
  let state = harness({ toolRequestExists: () => false });
  let response = {};
  await state.handlers.handleSurfaceExecutionEvent(request("POST", {}), response, "missing");
  assert.equal(response.status, 404);
  response = {};
  await state.handlers.handleSurfaceToolReceipt(request("POST", {}), response, "missing");
  assert.equal(response.status, 404);

  state = harness({ readToolRequest: () => ({ ...active, status: "pending" }) });
  response = {};
  await state.handlers.handleSurfaceExecutionEvent(request("POST", programEvent(input, 1, "accepted", { proposal_sha256: sha256(input) })), response, "req-1");
  assert.equal(response.status, 400);

  state = harness({ readToolRequest: () => ({ ...active, lease_expires_at: new Date(PROGRAM_NOW).toISOString() }) });
  response = {};
  await state.handlers.handleSurfaceExecutionEvent(request("POST", programEvent(input, 1, "accepted", { proposal_sha256: sha256(input) })), response, "req-1");
  assert.equal(response.payload.code, "claim_expired");

  const wrongClaimant = programEvent(input, 1, "accepted", { proposal_sha256: sha256(input) });
  wrongClaimant.claimant.client_instance_id = "other";
  state = harness({ readToolRequest: () => active });
  response = {};
  await state.handlers.handleSurfaceExecutionEvent(request("POST", wrongClaimant), response, "req-1");
  assert.equal(response.payload.code, "claimant_mismatch");

  response = {};
  await state.handlers.handleSurfaceToolReceipt(request("POST", programToolReceipt(input)), response, "req-1");
  assert.equal(response.payload.code, "missing_tool_started_event");

  const missingRoute = harness({ toolRequestExists: () => false });
  response = {};
  assert.equal(await missingRoute.handlers.routeDeviceTools(request("POST", {}), response, url("/v1/tool/requests/missing/events")), true);
  assert.equal(response.status, 404);
  response = {};
  assert.equal(await missingRoute.handlers.routeDeviceTools(request("POST", {}), response, url("/v1/tool/requests/missing/tool-receipts")), true);
  assert.equal(response.status, 404);
});
