"use strict";

function createAgentRunHandlers({
  authorizedAgent, agentAuthError, sendJson, sanitizeId,
  runExists, readAgentRun, readAgentEvents, isRunActive,
  listAgentRuns, cancelAgentRunById, agentRunPayload,
}) {
  function authorize(request, response) {
    if (authorizedAgent(request)) return true;
    sendJson(response, 401, agentAuthError());
    return false;
  }

  function sendRun(response, id) {
    let safeId;
    try { safeId = sanitizeId(id); }
    catch { sendJson(response, 404, { error: "agent run not found" }); return; }
    if (!runExists(safeId)) {
      sendJson(response, 404, { error: "agent run not found" });
      return;
    }
    sendJson(response, 200, {
      run: readAgentRun(safeId),
      events: readAgentEvents(safeId),
      active: isRunActive(safeId),
    });
  }

  function cancelRun(response, id) {
    const result = cancelAgentRunById(id);
    if (!result.ok && result.status === "not_found") {
      sendJson(response, 404, { error: "agent run not found" });
    } else if (result.status === "cancel_requested") {
      sendJson(response, 202, agentRunPayload(result.run));
    } else {
      sendJson(response, 200, agentRunPayload(result.run));
    }
  }

  async function routeAgentRunReads(request, response, url) {
    if (url.pathname === "/v1/agent/runs" && request.method === "GET") {
      if (authorize(request, response)) {
        sendJson(response, 200, { runs: listAgentRuns(Number(url.searchParams.get("limit") || 25)) });
      }
      return true;
    }
    if (request.method === "POST" && url.pathname.startsWith("/v1/agent/runs/") && url.pathname.endsWith("/cancel")) {
      if (authorize(request, response)) {
        const id = url.pathname.replace("/v1/agent/runs/", "").replace("/cancel", "");
        cancelRun(response, id);
      }
      return true;
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/agent/runs/")) {
      if (authorize(request, response)) sendRun(response, url.pathname.replace("/v1/agent/runs/", ""));
      return true;
    }
    return false;
  }

  return { routeAgentRunReads, sendRun, cancelRun };
}

module.exports = { createAgentRunHandlers };
