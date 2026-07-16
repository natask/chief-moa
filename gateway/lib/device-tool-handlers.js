"use strict";

const {
  PROGRAM_TOOL,
  canonicalJson,
  sha256,
  validateSurfaceExecutionEvent,
  validateSurfaceProgramToolReceipt,
  validateSurfaceProgramTerminalReceipt,
} = require("./surface-program-protocol");

function createDeviceToolHandlers(deps) {
  const {
    authorized, sendJson, readJsonBody, listDeviceClients, listToolRequests,
    upsertDeviceClient, claimableToolRequestsForDevice, cleanError,
    createToolRequest, recordToolRequestProductEvent, summarizeToolRequest,
    normalizeDeviceId, readDeviceClientsMap, claimNextToolRequest,
    sanitizeId, toolRequestExists, readToolRequest, randomId, truncate,
    sanitizeToolJson, updateToolRequest,
  } = deps;
  const now = typeof deps.now === "function" ? deps.now : () => new Date().toISOString();

  async function routeDeviceTools(request, response, url) {
    const pathname = url.pathname;
    const isDeviceList = pathname === "/v1/device-clients" && request.method === "GET";
    const isHeartbeat = pathname === "/v1/device-clients/heartbeat" && request.method === "POST";
    const isToolList = pathname === "/v1/tool/requests" && request.method === "GET";
    const isToolCreate = pathname === "/v1/tool/requests" && request.method === "POST";
    const isToolClaim = pathname === "/v1/tool/requests/claim" && request.method === "POST";
    const isReceipt = request.method === "POST" && pathname.startsWith("/v1/tool/requests/") && pathname.endsWith("/receipts");
    const isExecutionEvent = request.method === "POST" && pathname.startsWith("/v1/tool/requests/") && pathname.endsWith("/events");
    const isToolReceipt = request.method === "POST" && pathname.startsWith("/v1/tool/requests/") && pathname.endsWith("/tool-receipts");
    if (!(isDeviceList || isHeartbeat || isToolList || isToolCreate || isToolClaim || isReceipt || isExecutionEvent || isToolReceipt)) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    if (isDeviceList) sendJson(response, 200, { devices: listDeviceClients() });
    else if (isHeartbeat) await handleDeviceClientHeartbeat(request, response);
    else if (isToolList) sendJson(response, 200, { requests: listToolRequests({
      status: url.searchParams.get("status") || "",
      targetDeviceId: url.searchParams.get("target_device_id") || url.searchParams.get("device_id") || "",
      sourceDeviceId: url.searchParams.get("source_device_id") || "",
      limit: Number(url.searchParams.get("limit") || 25),
    }) });
    else if (isToolCreate) await handleCreateToolRequest(request, response);
    else if (isToolClaim) await handleClaimToolRequest(request, response);
    else if (isExecutionEvent) await handleSurfaceExecutionEvent(request, response, pathname.slice("/v1/tool/requests/".length, -"/events".length));
    else if (isToolReceipt) await handleSurfaceToolReceipt(request, response, pathname.slice("/v1/tool/requests/".length, -"/tool-receipts".length));
    else await handleToolRequestReceipt(request, response, pathname.slice("/v1/tool/requests/".length, -"/receipts".length));
    return true;
  }

  async function handleDeviceClientHeartbeat(request, response) {
    const body = await readJsonBody(request);
    try {
      const device = upsertDeviceClient(body);
      sendJson(response, 200, {
        device,
        pending_request_count: claimableToolRequestsForDevice(device).length,
        requests_endpoint: "/v1/tool/requests/claim",
      });
    } catch (error) { sendJson(response, 400, { error: cleanError(error) }); }
  }

  async function handleCreateToolRequest(request, response) {
    const body = await readJsonBody(request);
    let toolRequest;
    try { toolRequest = createToolRequest(body); }
    catch (error) { sendJson(response, 400, { error: cleanError(error) }); return; }
    await recordToolRequestProductEvent(toolRequest, "queued");
    sendJson(response, 202, { request: summarizeToolRequest(toolRequest, { includeInput: true }) });
  }

  async function handleClaimToolRequest(request, response) {
    const body = await readJsonBody(request);
    const deviceId = normalizeDeviceId(body.device_id || body.deviceId || body.client_id || body.clientId || "");
    if (!deviceId) { sendJson(response, 400, { error: "device_id is required" }); return; }
    let device = readDeviceClientsMap()[deviceId];
    if (!device && !(body.execution_runtimes || body.executionRuntimes) && (body.surface_type || body.surfaceType || body.local_tool_manifest || body.tool_manifest || body.capabilities)) {
      try { device = upsertDeviceClient(body); }
      catch (error) { sendJson(response, 400, { error: cleanError(error) }); return; }
    }
    if (!device) { sendJson(response, 404, { error: "device client has not heartbeated" }); return; }
    const clientInstanceId = normalizeDeviceId(body.client_instance_id || body.clientInstanceId || "");
    if (device.client_instance_id && (!clientInstanceId || clientInstanceId !== device.client_instance_id)) {
      sendJson(response, 409, { error: "client_instance_id must match the current device heartbeat" }); return;
    }
    const task = claimNextToolRequest(device);
    if (!task) { sendJson(response, 204, {}); return; }
    await recordToolRequestProductEvent(task, "claimed");
    sendJson(response, 200, { request: summarizeToolRequest(task, { includeInput: true }) });
  }

  function activeSurfaceClaim(current, body, timestamp) {
    if (current.tool !== PROGRAM_TOOL || current.status !== "claimed" || !current.claim_id) throw Object.assign(new Error("surface program must have an active exact claim"), { code: "inactive_surface_claim" });
    const claimant = body?.claimant || {};
    if (claimant.device_id !== current.claimed_by || claimant.client_instance_id !== current.claimed_client_instance_id || claimant.surface_type !== current.input.target.surface_type) throw Object.assign(new Error("surface program claimant does not match the exact claim"), { code: "claimant_mismatch" });
    const leaseExpiresMs = Date.parse(current.lease_expires_at || "");
    if (!Number.isFinite(leaseExpiresMs) || Date.parse(timestamp) >= leaseExpiresMs) throw Object.assign(new Error("surface program claim lease expired"), { code: "claim_expired" });
    return { device_id: current.claimed_by, client_instance_id: current.claimed_client_instance_id };
  }

  function enforceEventTransition(current, event) {
    const events = current.surface_events || [];
    const previous = events[events.length - 1];
    if (previous && Date.parse(event.occurred_at) < Date.parse(previous.occurred_at)) throw Object.assign(new Error("execution event timestamps must be nondecreasing"), { code: "event_timestamp_reordered" });
    if (events.length === 0) {
      if (event.kind === "accepted") return;
      if (event.kind === "terminal" && event.payload.status === "rejected") return;
      throw Object.assign(new Error("first event must accept or reject the proposal"), { code: "invalid_first_event" });
    }
    if (events.some((item) => item.kind === "terminal")) throw Object.assign(new Error("execution already terminated"), { code: "execution_terminal" });
    const accepted = events[0].kind === "accepted";
    const started = events.some((item) => item.kind === "started");
    const unresolvedApprovals = events.filter((item) => item.kind === "approval_required" && !events.some((other) => other.kind === "approval_resolved" && other.payload.approval_id === item.payload.approval_id));
    if (event.kind === "accepted") throw Object.assign(new Error("execution can only be accepted once"), { code: "duplicate_acceptance" });
    if (event.kind === "started") {
      if (!accepted || started || unresolvedApprovals.length) throw Object.assign(new Error("runtime start is out of order"), { code: "invalid_started_transition" });
      return;
    }
    if (event.kind === "approval_required") {
      if (!accepted || events.some((item) => item.kind === "approval_required" && item.payload.approval_id === event.payload.approval_id)) throw Object.assign(new Error("approval request is out of order or reused"), { code: "invalid_approval_transition" });
      return;
    }
    if (event.kind === "approval_resolved") {
      const pending = unresolvedApprovals.find((item) => item.payload.approval_id === event.payload.approval_id);
      if (!pending || Date.parse(event.occurred_at) > Date.parse(pending.payload.expires_at) && event.payload.status !== "expired") throw Object.assign(new Error("approval resolution has no live matching request"), { code: "invalid_approval_resolution" });
      return;
    }
    if (["tool_started", "tool_finished", "progress", "stopping"].includes(event.kind) && !started) throw Object.assign(new Error("runtime event occurred before start"), { code: "event_before_start" });
    if (event.kind === "tool_started") {
      const attempts = events.filter((item) => item.kind === "tool_started" && item.payload.tool_call_id === event.payload.tool_call_id).map((item) => item.payload.attempt);
      if (event.payload.attempt !== attempts.length + 1 || events.some((item) => item.kind === "tool_started" && item.payload.tool_call_id === event.payload.tool_call_id && item.payload.attempt === event.payload.attempt)) throw Object.assign(new Error("tool attempts must start at one and remain contiguous"), { code: "invalid_tool_attempt" });
    }
    if (event.kind === "tool_finished") {
      const start = events.find((item) => item.kind === "tool_started" && item.payload.tool_call_id === event.payload.tool_call_id && item.payload.attempt === event.payload.attempt && item.payload.capability_id === event.payload.capability_id);
      const alreadyFinished = events.some((item) => item.kind === "tool_finished" && item.payload.tool_call_id === event.payload.tool_call_id && item.payload.attempt === event.payload.attempt);
      const receipt = (current.tool_receipts || []).find((item) => item.receipt_id === event.payload.receipt_id);
      if (!start || alreadyFinished || !receipt || receipt.tool_call_id !== event.payload.tool_call_id || receipt.attempt !== event.payload.attempt || receipt.capability_id !== event.payload.capability_id || receipt.status !== event.payload.status || receipt.receipt_sha256 !== event.payload.receipt_sha256) throw Object.assign(new Error("tool finish must match one durable receipt and start"), { code: "tool_finished_receipt_mismatch" });
    }
    if (event.kind === "terminal") {
      const terminal = current.terminal_receipt;
      const unfinished = events.filter((item) => item.kind === "tool_started" && !events.some((other) => other.kind === "tool_finished" && other.payload.tool_call_id === item.payload.tool_call_id && other.payload.attempt === item.payload.attempt));
      if (unfinished.length || unresolvedApprovals.length) throw Object.assign(new Error("execution cannot terminate with pending tools or approvals"), { code: "pending_execution_work" });
      if (!terminal || terminal.receipt_id !== event.payload.receipt_id || terminal.status !== event.payload.status || terminal.receipt_sha256 !== event.payload.receipt_sha256 || Date.parse(event.occurred_at) < Date.parse(terminal.finished_at)) throw Object.assign(new Error("terminal event must match its durable receipt"), { code: "terminal_receipt_mismatch" });
      if (!started && event.payload.status !== "rejected") throw Object.assign(new Error("an unstarted execution can only be rejected"), { code: "invalid_unstarted_terminal" });
    }
  }

  async function handleSurfaceExecutionEvent(request, response, id) {
    const requestId = sanitizeId(id);
    if (!toolRequestExists(requestId)) { sendJson(response, 404, { error: "tool request not found" }); return; }
    const body = await readJsonBody(request); const current = readToolRequest(requestId); const timestamp = now();
    const storedEvents = Array.isArray(current.surface_events) ? current.surface_events : [];
    const storedReplay = storedEvents.find((item) => item.event_id === body.event_id || item.sequence === body.sequence);
    if (storedReplay) {
      if (canonicalJson(storedReplay) === canonicalJson(body)) sendJson(response, 200, { event: storedReplay, idempotent_replay: true });
      else sendJson(response, 409, { error: "execution event conflicts with stored sequence or id" });
      return;
    }
    let event;
    try {
      const claim = activeSurfaceClaim(current, body, timestamp);
      event = validateSurfaceExecutionEvent(current.input, body, claim, { nowMs: Date.parse(timestamp) });
    } catch (error) { sendJson(response, 400, { error: cleanError(error), code: error.code || "invalid_execution_event" }); return; }
    const events = storedEvents;
    if (event.sequence !== events.length + 1) { sendJson(response, 409, { error: "execution event sequence must remain contiguous" }); return; }
    try { enforceEventTransition(current, event); }
    catch (error) { sendJson(response, 409, { error: cleanError(error), code: error.code || "invalid_event_transition" }); return; }
    const patch = { surface_events: events.concat([event]), updated_at: timestamp };
    if (event.kind === "terminal") {
      const terminal = current.terminal_receipt;
      patch.status = terminal.status === "completed" ? "completed" : ["stopped", "interrupted"].includes(terminal.status) ? "cancelled" : "failed";
      patch.finished_at = timestamp;
      patch.receipts = [{ id: randomId("receipt"), ts: timestamp, ok: terminal.status === "completed", device_id: terminal.claimant.device_id, summary: terminal.status, error: terminal.error?.message || "", result: terminal.result, local_receipt: terminal, terminal_digest: sha256(terminal) }];
      patch.error = terminal.error?.message || "";
    }
    const next = updateToolRequest(current.id, patch, Number(current.state_revision || 0));
    await recordToolRequestProductEvent(next, "surface_execution_event", event);
    sendJson(response, 202, { event });
  }

  async function handleSurfaceToolReceipt(request, response, id) {
    const requestId = sanitizeId(id);
    if (!toolRequestExists(requestId)) { sendJson(response, 404, { error: "tool request not found" }); return; }
    const body = await readJsonBody(request); const current = readToolRequest(requestId); const timestamp = now();
    if ((current.surface_events || []).some((item) => item.kind === "terminal")) { sendJson(response, 409, { error: "execution already terminated" }); return; }
    const receipts = Array.isArray(current.tool_receipts) ? current.tool_receipts : [];
    const rawReplay = receipts.find((item) => item.receipt_id === body.receipt_id || (item.tool_call_id === body.tool_call_id && item.attempt === body.attempt));
    if (rawReplay) {
      if (canonicalJson(rawReplay) === canonicalJson(body)) sendJson(response, 200, { receipt: rawReplay, idempotent_replay: true });
      else sendJson(response, 409, { error: "tool receipt conflicts with stored call attempt" });
      return;
    }
    let receipt;
    try {
      const claim = activeSurfaceClaim(current, body, timestamp);
      const approvals = (current.surface_events || []).filter((event) => event.kind === "approval_resolved" && event.payload.status === "approved").map((event) => event.payload.approval_id);
      const device = readDeviceClientsMap()[current.claimed_by] || {};
      const capability = (device.local_tool_manifest || []).find((item) => (item.capability_id || item.tool) === body.capability_id);
      receipt = validateSurfaceProgramToolReceipt(current.input, body, claim, { nowMs: Date.parse(timestamp), previousToolReceipt: receipts[receipts.length - 1] || null, toolReceipts: receipts, approvalIds: approvals, effectClass: capability?.effect_class });
      const started = (current.surface_events || []).find((event) => event.kind === "tool_started" && event.payload.tool_call_id === receipt.tool_call_id && event.payload.attempt === receipt.attempt && event.payload.capability_id === receipt.capability_id);
      if (!started) throw Object.assign(new Error("tool receipt has no matching tool_started lifecycle event"), { code: "missing_tool_started_event" });
    } catch (error) { sendJson(response, 400, { error: cleanError(error), code: error.code || "invalid_tool_receipt" }); return; }
    const next = updateToolRequest(current.id, { tool_receipts: receipts.concat([receipt]), updated_at: timestamp }, Number(current.state_revision || 0));
    await recordToolRequestProductEvent(next, "surface_tool_receipt", receipt);
    sendJson(response, 202, { receipt });
  }

  async function handleToolRequestReceipt(request, response, id) {
    const requestId = sanitizeId(id);
    if (!toolRequestExists(requestId)) { sendJson(response, 404, { error: "tool request not found" }); return; }
    const body = await readJsonBody(request);
    const current = readToolRequest(requestId);
    const deviceId = normalizeDeviceId(body.device_id || body.deviceId || body.claimant?.device_id || "");
    if (current.tool === PROGRAM_TOOL) {
      await handleSurfaceProgramReceipt(response, current, body, deviceId);
      return;
    }
    if (deviceId && current.target_device_id && deviceId !== current.target_device_id) {
      sendJson(response, 403, { error: "receipt device_id does not match request target" }); return;
    }
    if (deviceId && current.claimed_by && deviceId !== current.claimed_by) {
      sendJson(response, 403, { error: "receipt device_id does not match request claimant" }); return;
    }
    const timestamp = now();
    const ok = body.ok !== false && !body.error;
    const receipt = {
      id: randomId("receipt"), ts: timestamp, ok,
      device_id: deviceId || current.claimed_by || current.target_device_id || "",
      summary: truncate(String(body.summary || ""), 2000),
      error: body.error ? truncate(String(body.error), 2000) : "",
      result: sanitizeToolJson(body.result ?? body.output ?? null),
      local_receipt: sanitizeToolJson(body.local_receipt || body.localReceipt || null),
    };
    const receipts = Array.isArray(current.receipts) ? current.receipts.concat([receipt]) : [receipt];
    const next = updateToolRequest(requestId, {
      status: ok ? "completed" : "failed", updated_at: timestamp, finished_at: timestamp,
      receipts, error: receipt.error,
    });
    await recordToolRequestProductEvent(next, "receipt", receipt);
    sendJson(response, 200, { request: summarizeToolRequest(next), receipt });
  }

  async function handleSurfaceProgramReceipt(response, current, body, deviceId) {
    const existing = current.terminal_receipt || (Array.isArray(current.receipts) ? current.receipts[0]?.local_receipt : null);
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(body)) sendJson(response, 200, { request: summarizeToolRequest(current), receipt: existing, idempotent_replay: true });
      else sendJson(response, 409, { error: "surface program already has a different terminal receipt" });
      return;
    }
    if (current.status !== "claimed" || !current.claim_id || !deviceId) {
      sendJson(response, 409, { error: "surface program must be claimed by an exact device before receipt" });
      return;
    }
    const leaseExpiresMs = Date.parse(current.lease_expires_at || "");
    const timestamp = now();
    if (!Number.isFinite(leaseExpiresMs) || Date.parse(timestamp) >= leaseExpiresMs) {
      sendJson(response, 409, { error: "surface program claim lease expired" });
      return;
    }
    let terminal;
    try {
      terminal = validateSurfaceProgramTerminalReceipt(current.input, body, {
        device_id: current.claimed_by,
        client_instance_id: current.claimed_client_instance_id,
      }, { nowMs: Date.parse(timestamp), toolReceipts: current.tool_receipts || [] });
      const events = current.surface_events || [];
      const accepted = events[0]?.kind === "accepted";
      const started = events.some((event) => event.kind === "started");
      if (events.some((event) => event.kind === "terminal") || (!accepted && terminal.status !== "rejected") || (!started && terminal.status !== "rejected")) throw Object.assign(new Error("terminal receipt is inconsistent with lifecycle state"), { code: "terminal_state_mismatch" });
    } catch (error) {
      sendJson(response, 400, { error: cleanError(error), code: error.code || "invalid_terminal_receipt" });
      return;
    }
    const next = updateToolRequest(current.id, { terminal_receipt: terminal, updated_at: timestamp }, Number(current.state_revision || 0));
    await recordToolRequestProductEvent(next, "surface_terminal_receipt", terminal);
    sendJson(response, 202, { request: summarizeToolRequest(next), receipt: terminal });
  }

  return { routeDeviceTools, handleDeviceClientHeartbeat, handleCreateToolRequest, handleClaimToolRequest, handleToolRequestReceipt, handleSurfaceExecutionEvent, handleSurfaceToolReceipt, handleSurfaceProgramReceipt };
}

module.exports = { createDeviceToolHandlers };
