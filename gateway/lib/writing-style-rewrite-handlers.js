"use strict";

function createWritingStyleRewriteHandlers(options = {}) {
  const { readJsonBody, sendJson, service } = options;
  if (typeof readJsonBody !== "function" || typeof sendJson !== "function" || typeof service?.rewrite !== "function") {
    throw new TypeError("writing-style rewrite handler dependencies are required");
  }
  async function route(request, response, url) {
    if (request.method !== "POST" || url.pathname !== "/v1/writing-style/rewrite") return false;
    try {
      const result = await service.rewrite(await readJsonBody(request));
      response.setHeader?.("cache-control", "no-store");
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, Number(error?.statusCode || 400), { error: String(error?.message || error), code: error?.code || "rewrite_failed" });
    }
    return true;
  }
  return Object.freeze({ route });
}

module.exports = { createWritingStyleRewriteHandlers };
