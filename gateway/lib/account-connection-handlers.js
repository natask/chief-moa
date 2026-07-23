"use strict";

function createAccountConnectionHandlers(deps) {
  const {
    accountConnections, authorizedAgent, agentAuthError, accountUserId,
    readJsonBody, readFormOrJsonBody, sendJson, sendAccountHtml,
    sendAccountSecretForm, escapeHtml, cleanError,
  } = deps;

  async function routeAccountConnections(request, response, url) {
    const { method } = request;
    const pathname = url.pathname;
    if (!(pathname === "/v1/account-providers" || pathname.startsWith("/v1/account-connections"))) return false;
    try {
      if (method === "GET" && pathname === "/v1/account-connections/oauth/start") {
        const redirect = accountConnections.oauthStartRedirect(url.searchParams.get("state") || "");
        response.writeHead(302, { location: redirect, "cache-control": "no-store" }); response.end(); return true;
      }
      if (method === "GET" && pathname === "/v1/account-connections/oauth/callback") {
        const result = await accountConnections.completeOauthCallback({
          state: url.searchParams.get("state") || "", code: url.searchParams.get("code") || "",
          error: url.searchParams.get("error") || "",
        });
        sendAccountHtml(response, 200, "Account connected", `${escapeHtml(result.connection.provider_label)} ("${escapeHtml(result.connection.label)}") is connected. You can close this window.`);
        return true;
      }
      if (method === "GET" && pathname === "/v1/account-connections/secret-form") {
        sendAccountSecretForm(response, accountConnections.secretFormInfo(url.searchParams.get("token") || "")); return true;
      }
      if (method === "POST" && pathname === "/v1/account-connections/secret-form") {
        const { body, isForm } = await readFormOrJsonBody(request);
        const result = accountConnections.submitSecretForm(String(body.token || ""), body);
        if (isForm) sendAccountHtml(response, 200, "Credential stored", `${escapeHtml(result.connection.provider_label)} ("${escapeHtml(result.connection.label)}") is connected. The secret is stored encrypted on the gateway. You can close this window.`);
        else sendJson(response, 200, result);
        return true;
      }
      if (!authorizedAgent(request)) { sendJson(response, 401, agentAuthError()); return true; }
      const userId = accountUserId();
      if (method === "GET" && pathname === "/v1/account-providers") {
        sendJson(response, 200, { providers: accountConnections.catalog() }); return true;
      }
      if (method === "GET" && pathname === "/v1/account-connections") {
        sendJson(response, 200, { connections: accountConnections.list(userId) }); return true;
      }
      if (method === "POST" && pathname === "/v1/account-connections") {
        const result = accountConnections.create(userId, await readJsonBody(request));
        sendJson(response, result.statusCode, { connection: result.connection, reauth_action: result.reauth_action }); return true;
      }
      if (method === "GET" && pathname === "/v1/account-connections/notifications") {
        sendJson(response, 200, { notifications: accountConnections.listNotifications({
          userId, deviceId: url.searchParams.get("device_id") || "", status: url.searchParams.get("status") || "",
        }) }); return true;
      }
      if (method === "POST" && pathname.startsWith("/v1/account-connections/notifications/") && pathname.endsWith("/receipt")) {
        const id = pathname.slice("/v1/account-connections/notifications/".length, -"/receipt".length);
        sendJson(response, 200, { notification: accountConnections.recordNotificationReceipt(userId, id, await readJsonBody(request)) });
        return true;
      }
      if (method === "POST" && pathname === "/v1/account-connections/health/run") {
        sendJson(response, 200, { summary: await accountConnections.runHealthChecks() }); return true;
      }
      const remainder = pathname.startsWith("/v1/account-connections/") ? pathname.slice("/v1/account-connections/".length) : "";
      const [connectionId, action, extra] = remainder.split("/");
      if (!connectionId || extra) { sendJson(response, 404, { error: "not found" }); return true; }
      if (method === "GET" && !action) sendJson(response, 200, { connection: accountConnections.get(userId, connectionId) });
      else if (method === "PATCH" && !action) sendJson(response, 200, { connection: accountConnections.patch(userId, connectionId, await readJsonBody(request)) });
      else if (method === "POST" && action === "refresh") {
        const result = await accountConnections.requestRefresh(userId, connectionId);
        sendJson(response, result.statusCode, { connection: result.connection });
      } else if (method === "POST" && action === "reauth") sendJson(response, 200, accountConnections.requestReauth(userId, connectionId));
      else if (method === "POST" && action === "disable") sendJson(response, 200, { connection: accountConnections.disable(userId, connectionId) });
      else if (method === "POST" && action === "disconnect") sendJson(response, 200, { connection: await accountConnections.disconnect(userId, connectionId) });
      else sendJson(response, 404, { error: "not found" });
      return true;
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      sendJson(response, status, { error: cleanError(error), ...(error?.payload || {}) });
      return true;
    }
  }

  return { routeAccountConnections };
}

module.exports = { createAccountConnectionHandlers };
