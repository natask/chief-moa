"use strict";

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
    if (!(isDeviceList || isHeartbeat || isToolList || isToolCreate || isToolClaim || isReceipt)) return false;
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
    if (!device && (body.surface_type || body.surfaceType || body.local_tool_manifest || body.tool_manifest || body.capabilities)) {
      try { device = upsertDeviceClient(body); }
      catch (error) { sendJson(response, 400, { error: cleanError(error) }); return; }
    }
    if (!device) { sendJson(response, 404, { error: "device client has not heartbeated" }); return; }
    const task = claimNextToolRequest(device);
    if (!task) { sendJson(response, 204, {}); return; }
    await recordToolRequestProductEvent(task, "claimed");
    sendJson(response, 200, { request: summarizeToolRequest(task, { includeInput: true }) });
  }

  async function handleToolRequestReceipt(request, response, id) {
    const requestId = sanitizeId(id);
    if (!toolRequestExists(requestId)) { sendJson(response, 404, { error: "tool request not found" }); return; }
    const body = await readJsonBody(request);
    const current = readToolRequest(requestId);
    const deviceId = normalizeDeviceId(body.device_id || body.deviceId || "");
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

  return { routeDeviceTools, handleDeviceClientHeartbeat, handleCreateToolRequest, handleClaimToolRequest, handleToolRequestReceipt };
}

module.exports = { createDeviceToolHandlers };
