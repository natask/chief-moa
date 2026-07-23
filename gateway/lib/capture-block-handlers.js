"use strict";

function createCaptureBlockHandlers(deps = {}) {
  const { authorized, sendJson, store } = deps;
  if (typeof authorized !== "function" || typeof sendJson !== "function" || !store) {
    throw new Error("capture block handlers require authorized, sendJson, and store");
  }

  async function routeCaptureBlocks(request, response, url) {
    if (request.method !== "GET") return false;
    const pathname = url.pathname;
    const collection = pathname === "/v1/capture-blocks";
    const search = pathname === "/v1/capture-blocks/search";
    const itemId = captureBlockIdFromPath(pathname);
    if (!collection && !search && itemId === null) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    if (typeof response.setHeader === "function") response.setHeader("cache-control", "no-store");
    if (itemId !== null) await readItem(response, itemId);
    else await readCollection(response, url, search);
    return true;
  }

  async function readCollection(response, url, forceSearch = false) {
    try {
      const query = url.searchParams.get("q") || url.searchParams.get("query") || "";
      const filters = {
        session_id: url.searchParams.get("session_id") || "",
        turn_id: url.searchParams.get("turn_id") || "",
        source_surface: url.searchParams.get("source_surface") || "",
        limit: url.searchParams.get("limit") || "",
        offset: url.searchParams.get("offset") || "",
      };
      if (forceSearch && !query.trim()) {
        sendJson(response, 400, { error: "q is required for capture block search" });
        return;
      }
      const result = query
        ? await store.search(query, filters)
        : await store.list(filters);
      sendJson(response, 200, {
        capture_blocks: result.items,
        offset: result.offset,
        limit: result.limit,
        has_more: result.has_more,
      });
    } catch (error) {
      sendCaptureError(response, error, sendJson);
    }
  }

  async function readItem(response, encodedId) {
    let item;
    try {
      item = await store.get(decodeCaptureBlockId(encodedId));
    } catch (error) {
      sendCaptureError(response, error, sendJson);
      return;
    }
    if (!item) {
      sendJson(response, 404, { error: "capture block not found" });
      return;
    }
    sendJson(response, 200, { capture_block: item });
  }

  return Object.freeze({ routeCaptureBlocks, readCollection, readItem });
}

function captureBlockIdFromPath(pathname) {
  const prefix = "/v1/capture-blocks/";
  const path = String(pathname || "");
  if (!path.startsWith(prefix) || path === `${prefix}search`) return null;
  const rest = path.slice(prefix.length);
  return rest && !rest.includes("/") ? rest : null;
}

function decodeCaptureBlockId(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw validationError("invalid capture block id");
  }
  if (!/^cap_[a-f0-9]{64}$/.test(decoded)) throw validationError("invalid capture block id");
  return decoded;
}

function sendCaptureError(response, error, sendJson) {
  if (error?.code === "validation") {
    sendJson(response, 400, { error: error.message });
    return;
  }
  sendJson(response, 500, { error: "capture block storage unavailable" });
}

function validationError(message) {
  return Object.assign(new Error(message), { code: "validation" });
}

module.exports = {
  createCaptureBlockHandlers,
  captureBlockIdFromPath,
  decodeCaptureBlockId,
  sendCaptureError,
};
