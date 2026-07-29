"use strict";

function createIntentPlaneHandlers({ plane, readJsonBody, sendJson, cleanError }) {
  async function route(request, response, url) {
    try {
      if (request.method === "GET" && url.pathname === "/v1/intent-plane") {
        sendJson(response, 200, await plane.projection({
          status: url.searchParams.get("status") || "",
          limit: url.searchParams.get("limit") || undefined,
          offset: url.searchParams.get("offset") || undefined,
        }));
        return true;
      }
      // The notification inbox: a durable, reviewable, filterable list the
      // user (or the voice agent on the user's behalf) can page independent
      // of which intent produced each entry. This is the same store the
      // completed/needs_user pings above use; it is not a second inbox.
      if (request.method === "GET" && url.pathname === "/v1/intent-plane/notifications") {
        sendJson(response, 200, await plane.listNotifications({
          receipt_state: url.searchParams.get("receipt_state") || "",
          kind: url.searchParams.get("kind") || "",
          intent_id: url.searchParams.get("intent_id") || "",
          limit: url.searchParams.get("limit") || undefined,
          offset: url.searchParams.get("offset") || undefined,
        }));
        return true;
      }
      const dismiss = url.pathname.match(/^\/v1\/intent-plane\/notifications\/([^/]+)\/dismiss$/);
      if (dismiss && request.method === "POST") {
        sendJson(response, 200, {
          notification: await plane.dismissNotification(decodeURIComponent(dismiss[1]), await readJsonBody(request)),
        });
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/intent-plane/intents") {
        sendJson(response, 201, { intent: await plane.createIntent(await readJsonBody(request)) });
        return true;
      }
      const intent = url.pathname.match(/^\/v1\/intent-plane\/intents\/([^/]+)(?:\/(agents|explain))?$/);
      if (intent) {
        const intentId = decodeURIComponent(intent[1]);
        if (request.method === "GET" && !intent[2]) {
          const explained = await plane.explain(intentId);
          if (!explained) sendJson(response, 404, { error: "intent not found" });
          else sendJson(response, 200, { intent: explained.intent });
          return true;
        }
        if (request.method === "PATCH" && !intent[2]) {
          sendJson(response, 200, { intent: await plane.updateIntent(intentId, await readJsonBody(request)) });
          return true;
        }
        if (request.method === "GET" && intent[2] === "explain") {
          const explained = await plane.explain(intentId);
          if (!explained) sendJson(response, 404, { error: "intent not found" });
          else sendJson(response, 200, explained);
          return true;
        }
        if (request.method === "POST" && intent[2] === "agents") {
          sendJson(response, 201, { agent: await plane.registerAgent({ ...(await readJsonBody(request)), intent_id: intentId }) });
          return true;
        }
      }
      const agent = url.pathname.match(/^\/v1\/intent-plane\/agents\/([^/]+)\/progress$/);
      if (agent && request.method === "POST") {
        sendJson(response, 200, { agent: await plane.progressAgent(decodeURIComponent(agent[1]), await readJsonBody(request)) });
        return true;
      }
      const receipt = url.pathname.match(/^\/v1\/intent-plane\/notifications\/([^/]+)\/receipt$/);
      if (receipt && request.method === "POST") {
        sendJson(response, 200, { notification: await plane.receiveNotification(decodeURIComponent(receipt[1]), await readJsonBody(request)) });
        return true;
      }
    } catch (error) {
      sendJson(response, error?.code === "EVENT_STREAM_VERSION_CONFLICT" ? 409 : 400, { error: cleanError(error) });
      return true;
    }
    sendJson(response, 404, { error: "unknown intent-plane endpoint" });
    return true;
  }
  return { routeIntentPlane: route };
}

module.exports = { createIntentPlaneHandlers };
