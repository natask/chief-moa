"use strict";

function createMediaBookmarkHandlers(deps) {
  const { authorized, sendJson, readJsonBody, principal, store } = deps;

  async function routeMediaBookmarks(request, response, url) {
    const pathname = url.pathname;
    const collection = pathname === "/v1/media/bookmarks";
    const itemId = bookmarkIdFromPath(pathname);
    const recognized = (collection && ["GET", "POST"].includes(request.method))
      || (itemId !== null && ["GET", "DELETE"].includes(request.method));
    if (!recognized) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    const ownerId = principal(request);
    if (typeof response.setHeader === "function") response.setHeader("cache-control", "no-store");
    if (collection && request.method === "POST") await create(request, response, ownerId);
    else if (collection) readCollection(response, url, ownerId);
    else if (request.method === "DELETE") remove(response, itemId, ownerId);
    else readItem(response, itemId, ownerId);
    return true;
  }

  async function create(request, response, ownerId = principal(request)) {
    let body;
    try { body = await readJsonBody(request); }
    catch { sendJson(response, 400, { error: "request body must be valid JSON" }); return; }
    try { sendJson(response, 201, { bookmark: publicBookmark(store.save(ownerId, body)) }); }
    catch (error) { sendStoreError(response, error, sendJson); }
  }

  function readCollection(response, url, ownerId) {
    try {
      const query = url.searchParams.get("query") || url.searchParams.get("q") || "";
      const videoId = url.searchParams.get("video_id") || url.searchParams.get("videoId") || "";
      if (query) {
        sendJson(response, 200, { resolution: publicResolution(store.resolve(ownerId, query, { video_id: videoId })) });
        return;
      }
      sendJson(response, 200, { bookmarks: store.list(ownerId, {
        video_id: videoId,
        source_surface: url.searchParams.get("source_surface") || url.searchParams.get("sourceSurface") || "",
        limit: url.searchParams.get("limit") || "",
      }).map(publicBookmark) });
    } catch (error) { sendStoreError(response, error, sendJson); }
  }

  function readItem(response, encodedId, ownerId) {
    let bookmark;
    try { bookmark = store.get(ownerId, decodeId(encodedId)); }
    catch (error) { sendStoreError(response, error, sendJson); return; }
    if (!bookmark) { sendJson(response, 404, { error: "media bookmark not found" }); return; }
    sendJson(response, 200, { bookmark: publicBookmark(bookmark) });
  }

  function remove(response, encodedId, ownerId) {
    let bookmark;
    try { bookmark = store.remove(ownerId, decodeId(encodedId)); }
    catch (error) { sendStoreError(response, error, sendJson); return; }
    if (!bookmark) {
      sendJson(response, 200, { deleted: false, already_absent: true });
      return;
    }
    sendJson(response, 200, { deleted: true, bookmark: publicBookmark(bookmark) });
  }

  return Object.freeze({ routeMediaBookmarks, create, readCollection, readItem, remove });
}

function publicBookmark(bookmark) {
  const fields = ["id", "provider", "video_id", "canonical_url", "position_ms", "label", "title", "note", "aliases", "source_surface", "created_at", "updated_at"];
  return Object.fromEntries(fields
    .filter((field) => bookmark[field] !== undefined && (field !== "title" || bookmark[field] !== ""))
    .map((field) => [field, bookmark[field]]));
}

function publicResolution(resolution) {
  if (resolution.status === "matched") return { ...resolution, bookmark: publicBookmark(resolution.bookmark) };
  return { ...resolution, candidates: (resolution.candidates || []).map(publicBookmark) };
}

function decodeId(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(decoded)) throw new Error("invalid");
    return decoded;
  }
  catch { const error = new Error("invalid media bookmark id"); error.code = "validation"; throw error; }
}

function sendStoreError(response, error, sendJson) {
  if (error?.code === "idempotency_collision") { sendJson(response, 409, { error: "media bookmark idempotency collision" }); return; }
  if (error?.code === "capacity") { sendJson(response, 507, { error: "media bookmark capacity exceeded" }); return; }
  if (error?.code === "validation") { sendJson(response, 400, { error: error.message }); return; }
  sendJson(response, 500, { error: "media bookmark storage unavailable" });
}

function bookmarkIdFromPath(pathname) {
  const prefix = "/v1/media/bookmarks/";
  if (!String(pathname || "").startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  return rest && !rest.includes("/") ? rest : null;
}

module.exports = { createMediaBookmarkHandlers, bookmarkIdFromPath, publicBookmark, publicResolution, sendStoreError };
