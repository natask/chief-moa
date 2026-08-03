"use strict";

function createDevelopmentPlaneHandlers({ plane, readJsonBody, sendJson, cleanError }) {
  async function routeDevelopmentPlane(request, response, url) {
    try {
      if (request.method === "POST" && url.pathname === "/v1/development/intents") {
        sendJson(response, 201, { intent: await plane.capture(await readJsonBody(request)) });
        return true;
      }
      const match = url.pathname.match(/^\/v1\/development\/intents\/([^/]+)(?:\/(plan|runnable|candidate|decision|tasks)(?:\/([^/]+)\/(claim|finish))?)?$/);
      if (!match) return false;
      const intentId = decodeURIComponent(match[1]);
      const action = match[2] || "";
      if (request.method === "GET" && !action) {
        const intent = await plane.get(intentId);
        sendJson(response, intent.exists ? 200 : 404, intent.exists ? { intent } : { error: "intent not found" });
        return true;
      }
      if (request.method === "GET" && action === "runnable") {
        sendJson(response, 200, { tasks: await plane.runnable(intentId, {
          max_parallel: url.searchParams.get("max_parallel"),
          memory_budget_mb: url.searchParams.get("memory_budget_mb"),
        }) });
        return true;
      }
      const body = await readJsonBody(request);
      if (request.method === "POST" && action === "plan") sendJson(response, 201, { intent: await plane.definePlan(intentId, body) });
      else if (request.method === "POST" && action === "candidate") sendJson(response, 200, { intent: await plane.freezeCandidate(intentId, body) });
      else if (request.method === "POST" && action === "decision") sendJson(response, 200, { intent: await plane.decide(intentId, body) });
      else if (request.method === "POST" && action === "tasks" && match[4] === "claim") sendJson(response, 200, { intent: await plane.claimTask(intentId, decodeURIComponent(match[3]), body) });
      else if (request.method === "POST" && action === "tasks" && match[4] === "finish") sendJson(response, 200, { intent: await plane.finishTask(intentId, decodeURIComponent(match[3]), body) });
      else return false;
      return true;
    } catch (error) {
      sendJson(response, error?.code === "EVENT_STREAM_VERSION_CONFLICT" ? 409 : 400, { error: cleanError(error) });
      return true;
    }
  }
  return { routeDevelopmentPlane };
}

module.exports = { createDevelopmentPlaneHandlers };
