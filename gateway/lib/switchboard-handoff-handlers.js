"use strict";

const { decodeCaptureBlockId } = require("./capture-block-handlers");

function createSwitchboardHandoffHandlers(deps = {}) {
  const { authorized, sendJson, readJsonBody, captureBlocks, handoffs } = deps;
  if (typeof authorized !== "function" || typeof sendJson !== "function"
      || typeof readJsonBody !== "function" || !captureBlocks || !handoffs) {
    throw new Error("Switchboard handoff handlers require auth, JSON, capture blocks, and handoffs");
  }

  async function routeSwitchboardHandoffs(request, response, url) {
    const encodedId = captureHandoffId(url.pathname);
    if (encodedId === null) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    if (typeof response.setHeader === "function") response.setHeader("cache-control", "no-store");
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method not allowed" });
      return true;
    }
    try {
      const block = await captureBlocks.get(decodeCaptureBlockId(encodedId));
      if (!block) {
        sendJson(response, 404, { error: "capture block not found" });
        return true;
      }
      const body = await readJsonBody(request);
      const receipt = await handoffs.handoffCaptureBlock({ ...body, captureBlock: block });
      sendJson(response, 202, { handoff: receipt });
    } catch (error) {
      const status = Number(error?.statusCode);
      if ([400, 403, 409, 502, 503].includes(status)) sendJson(response, status, { error: error.message });
      else if (error?.code === "validation" || error instanceof URIError) sendJson(response, 400, { error: error.message });
      else sendJson(response, 500, { error: "Switchboard handoff unavailable" });
    }
    return true;
  }

  return Object.freeze({ routeSwitchboardHandoffs });
}

function captureHandoffId(pathname) {
  const match = String(pathname || "").match(/^\/v1\/capture-blocks\/([^/]+)\/handoff$/);
  return match ? match[1] : null;
}

module.exports = { captureHandoffId, createSwitchboardHandoffHandlers };
