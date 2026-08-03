"use strict";

function createCaptureBlockHandlers(deps = {}) {
  const { authorized, sendJson, store, audioCapture, audioTranscription, readJsonBody, principal } = deps;
  if (typeof authorized !== "function" || typeof sendJson !== "function" || !store) {
    throw new Error("capture block handlers require authorized, sendJson, and store");
  }

  async function routeCaptureBlocks(request, response, url) {
    const pathname = url.pathname;
    const collection = pathname === "/v1/capture-blocks" && ["GET", "POST"].includes(request.method);
    const search = request.method === "GET" && pathname === "/v1/capture-blocks/search";
    const itemId = request.method === "GET" ? captureBlockIdFromPath(pathname) : null;
    const retryId = request.method === "POST" ? captureBlockActionIdFromPath(pathname, "retry") : null;
    if (!collection && !search && itemId === null && retryId === null) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    if (typeof response.setHeader === "function") response.setHeader("cache-control", "no-store");
    if (retryId !== null) await retryItem(response, retryId);
    else if (request.method === "POST") await createItem(request, response);
    else if (itemId !== null) await readItem(response, itemId);
    else await readCollection(response, url, search);
    return true;
  }

  async function retryItem(response, encodedId) {
    if (!audioTranscription?.retry) {
      sendJson(response, 501, { error: "capture transcription retry unavailable" });
      return;
    }
    try {
      const item = await audioTranscription.retry({ capture_block_id: decodeCaptureBlockId(encodedId) });
      sendJson(response, 200, { capture_block: item });
    } catch (error) {
      sendCaptureError(response, error, sendJson);
    }
  }

  async function createItem(request, response) {
    if (!audioCapture?.create || typeof readJsonBody !== "function" || typeof principal !== "function") {
      sendJson(response, 501, { error: "audio capture block creation unavailable" });
      return;
    }
    try {
      const body = await readJsonBody(request);
      const item = await audioCapture.create({
        audio_note_id: body.audio_note_id,
        idempotency_key: body.idempotency_key,
        source: body.source,
        owner_id: principal(),
      });
      sendJson(response, 201, { capture_block: item });
    } catch (error) {
      sendCaptureError(response, error, sendJson);
    }
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

  return Object.freeze({ routeCaptureBlocks, createItem, retryItem, readCollection, readItem });
}

function captureBlockIdFromPath(pathname) {
  const prefix = "/v1/capture-blocks/";
  const path = String(pathname || "");
  if (!path.startsWith(prefix) || path === `${prefix}search`) return null;
  const rest = path.slice(prefix.length);
  return rest && !rest.includes("/") ? rest : null;
}

function captureBlockActionIdFromPath(pathname, action) {
  const prefix = "/v1/capture-blocks/";
  const suffix = `/${action}`;
  const path = String(pathname || "");
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
  const rest = path.slice(prefix.length, -suffix.length);
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
  if (error?.code === "not_found" || error?.code === "conflict") {
    sendJson(response, Number(error.statusCode) || 400, { error: error.message });
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
  captureBlockActionIdFromPath,
  decodeCaptureBlockId,
  sendCaptureError,
};
