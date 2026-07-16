"use strict";

function createBillingRuntimeHandlers(deps) {
  const {
    authority,
    authorizedAgent,
    agentAuthError,
    readJsonBody,
    appendReceipt,
    sendJson,
    cleanError,
  } = deps;

  async function routeBillingRuntime(request, response, url) {
    const authorize = url.pathname === "/v1/billing/runtime/authorize";
    const usage = url.pathname === "/v1/billing/runtime/usage";
    if (!(authorize || usage) || request.method !== "POST") return false;
    if (!authorizedAgent(request)) {
      sendJson(response, 401, agentAuthError());
      return true;
    }
    await handle(request, response, usage);
    return true;
  }

  async function handle(request, response, recordUsage) {
    if (!authority) {
      sendJson(response, 503, { allowed: false, reason: "billing_runtime_unconfigured", charged: false });
      return;
    }
    try {
      const body = await readJsonBody(request);
      const result = recordUsage ? authority.recordUsage(body || {}) : authority.authorize(body || {});
      appendReceipt({ operation: recordUsage ? "usage" : "authorize", result });
      sendJson(response, result.allowed ? 200 : 402, { ...result, charged: false, mode: authority.mode });
    } catch (error) {
      sendJson(response, 400, {
        allowed: false,
        reason: "billing_authority_rejected",
        charged: false,
        error: cleanError(error),
      });
    }
  }

  return { routeBillingRuntime, handle };
}

module.exports = { createBillingRuntimeHandlers };
