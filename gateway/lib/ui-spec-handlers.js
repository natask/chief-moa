"use strict";

function createUiSpecHandlers(deps) {
  const {
    authorizedAgent,
    agentAuthError,
    accountUserId,
    uiSpecForUser,
    uiSpecPayload,
    readJsonBody,
    sendJson,
    cleanError,
  } = deps;

  async function routeUiSpec(request, response, url) {
    const isSpec = url.pathname === "/v1/ui/spec";
    const isReset = url.pathname === "/v1/ui/spec/reset";
    if (!(isSpec || isReset)) return false;
    if (!authorizedAgent(request)) {
      sendJson(response, 401, agentAuthError());
      return true;
    }
    const userId = accountUserId();
    if (isSpec && request.method === "GET") {
      sendJson(response, 200, uiSpecPayload(userId));
      return true;
    }
    if (isSpec && request.method === "PUT") {
      await handlePut(request, response, userId);
      return true;
    }
    if (isReset && request.method === "POST") {
      uiSpecForUser(userId).reset();
      sendJson(response, 200, uiSpecPayload(userId));
      return true;
    }
    return false;
  }

  async function handlePut(request, response, userId = accountUserId()) {
    const body = await readJsonBody(request);
    const incoming = body && typeof body === "object" ? (body.spec || body) : {};
    try {
      uiSpecForUser(userId).replace(incoming);
      sendJson(response, 200, uiSpecPayload(userId));
    } catch (error) {
      sendJson(response, 400, { error: cleanError(error) });
    }
  }

  return { routeUiSpec, handlePut };
}

module.exports = { createUiSpecHandlers };
