"use strict";

const crypto = require("node:crypto");

// Android approvals are valid for 120 seconds. The claim must remain exclusive
// for that entire window, with enough margin for the dialog to dismiss and the
// terminal receipt to reach the gateway.
const TOOL_REQUEST_CLAIM_LEASE_MS = 150_000;
const MAX_TOOL_REQUEST_RECEIPTS = 8;
const STRICT_RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const TERMINAL_TOOL_REQUEST_STATUSES = new Set(["completed", "failed"]);

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
    let task = claimNextToolRequest(device);
    if (!task) { sendJson(response, 204, {}); return; }
    if (task.status !== "claimed" || TERMINAL_TOOL_REQUEST_STATUSES.has(task.status)) {
      sendJson(response, 409, { error: "tool request is not claimable" }); return;
    }
    if (task.claimed_by !== deviceId || (task.target_device_id && task.target_device_id !== deviceId)) {
      sendJson(response, 409, { error: "tool request claim identity mismatch" }); return;
    }
    const claimedAt = now();
    const claimedAtMs = Date.parse(claimedAt);
    if (!Number.isFinite(claimedAtMs)) {
      sendJson(response, 500, { error: "gateway claim clock is unavailable" }); return;
    }
    const claimId = strictStoredId(randomId("claim"));
    if (!claimId) {
      sendJson(response, 500, { error: "gateway could not bind the tool request claim" }); return;
    }
    const minimumLease = new Date(claimedAtMs + TOOL_REQUEST_CLAIM_LEASE_MS).toISOString();
    task = updateToolRequest(task.id, {
      claim_id: claimId,
      claimed_at: claimedAt,
      lease_expires_at: minimumLease,
      updated_at: claimedAt,
    });
    await recordToolRequestProductEvent(task, "claimed");
    sendJson(response, 200, {
      request: { ...summarizeToolRequest(task, { includeInput: true }), claim_id: claimId },
    });
  }

  async function handleToolRequestReceipt(request, response, id) {
    const requestId = sanitizeId(id);
    if (!toolRequestExists(requestId)) { sendJson(response, 404, { error: "tool request not found" }); return; }
    const body = await readJsonBody(request);
    const current = readToolRequest(requestId);
    const deviceId = normalizeDeviceId(body.device_id || body.deviceId || "");
    let receiptId;
    let claimId;
    try {
      receiptId = requiredAliasedId(body,
        ["receipt_id", "receiptId", "idempotency_key", "idempotencyKey"], "receipt_id");
      claimId = requiredAliasedId(body, ["claim_id", "claimId"], "claim_id");
    } catch (error) {
      sendJson(response, 400, { error: cleanError(error) }); return;
    }
    if (!deviceId) { sendJson(response, 400, { error: "device_id is required" }); return; }
    if (current.target_device_id && deviceId !== current.target_device_id) {
      sendJson(response, 403, { error: "receipt device_id does not match request target" }); return;
    }
    if (current.claimed_by && deviceId !== current.claimed_by) {
      sendJson(response, 403, { error: "receipt device_id does not match request claimant" }); return;
    }
    const timestamp = now();
    const nowMs = Date.parse(timestamp);
    if (!Number.isFinite(nowMs)) {
      sendJson(response, 500, { error: "gateway receipt clock is unavailable" }); return;
    }
    const normalized = normalizedReceiptBody(body, { truncate, sanitizeToolJson });
    const bindingDigest = receiptBindingDigest({
      requestId, deviceId, claimId, receipt: normalized,
    });
    const receipts = Array.isArray(current.receipts) ? current.receipts : [];
    const existing = receipts.find((item) => item && item.id === receiptId);
    if (TERMINAL_TOOL_REQUEST_STATUSES.has(current.status)) {
      if (existing && existing.binding_digest === bindingDigest) {
        sendJson(response, 200, {
          request: summarizeToolRequest(current), receipt: existing, idempotent_replay: true,
        });
      } else {
        sendJson(response, 409, { error: "terminal tool request receipt conflicts with stored result" });
      }
      return;
    }
    if (current.status !== "claimed") {
      sendJson(response, 409, { error: "tool request is not currently claimed" }); return;
    }
    if (!strictStoredId(current.claim_id) || claimId !== current.claim_id) {
      sendJson(response, 409, { error: "receipt claim_id is stale" }); return;
    }
    const leaseExpiresAt = Date.parse(current.lease_expires_at || "");
    if (!Number.isFinite(leaseExpiresAt) || nowMs >= leaseExpiresAt) {
      sendJson(response, 409, { error: "tool request claim lease expired" }); return;
    }
    if (existing) {
      sendJson(response, 409, { error: "receipt_id is already bound to a non-terminal request" }); return;
    }
    if (receipts.length >= MAX_TOOL_REQUEST_RECEIPTS) {
      sendJson(response, 507, { error: "tool request receipt capacity reached" }); return;
    }
    const receipt = {
      id: receiptId,
      idempotency_key: receiptId,
      binding_digest: bindingDigest,
      claim_id: claimId,
      ts: timestamp,
      ...normalized,
      device_id: deviceId,
    };
    const next = updateToolRequest(requestId, {
      status: receipt.ok ? "completed" : "failed", updated_at: timestamp, finished_at: timestamp,
      receipts: receipts.concat([receipt]), error: receipt.error,
    });
    await recordToolRequestProductEvent(next, "receipt", receipt);
    sendJson(response, 200, { request: summarizeToolRequest(next), receipt, idempotent_replay: false });
  }

  return { routeDeviceTools, handleDeviceClientHeartbeat, handleCreateToolRequest, handleClaimToolRequest, handleToolRequestReceipt };
}

function isToolRequestStateClaimable(requestRecord, nowMs) {
  if (requestRecord?.status === "pending") return true;
  if (requestRecord?.status !== "claimed") return false;
  const expires = Date.parse(requestRecord.lease_expires_at || "");
  return Number.isFinite(expires) && expires <= nowMs;
}

function requiredAliasedId(body, aliases, label) {
  const supplied = aliases
    .filter((key) => Object.prototype.hasOwnProperty.call(body, key))
    .map((key) => body[key]);
  if (!supplied.length) throw new Error(`${label} is required`);
  if (supplied.some((value) => typeof value !== "string" || !STRICT_RECEIPT_ID.test(value))) {
    throw new Error(`${label} is invalid`);
  }
  if (supplied.some((value) => value !== supplied[0])) {
    throw new Error(`${label} aliases conflict`);
  }
  return supplied[0];
}

function strictStoredId(value) {
  return typeof value === "string" && STRICT_RECEIPT_ID.test(value) ? value : "";
}

function normalizedReceiptBody(body, deps) {
  const error = body.error ? deps.truncate(String(body.error), 2000) : "";
  return {
    ok: body.ok !== false && !error,
    summary: deps.truncate(String(body.summary || ""), 2000),
    error,
    result: deps.sanitizeToolJson(body.result ?? body.output ?? null),
    local_receipt: deps.sanitizeToolJson(body.local_receipt || body.localReceipt || null),
  };
}

function receiptBindingDigest({ requestId, deviceId, claimId, receipt }) {
  return crypto.createHash("sha256").update(canonicalJson({
    request_id: requestId,
    device_id: deviceId,
    claim_id: claimId,
    result: receipt,
  })).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value || {}).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

module.exports = {
  MAX_TOOL_REQUEST_RECEIPTS,
  TOOL_REQUEST_CLAIM_LEASE_MS,
  createDeviceToolHandlers,
  isToolRequestStateClaimable,
};
