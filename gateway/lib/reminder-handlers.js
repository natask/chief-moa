"use strict";

function createReminderHandlers({ authorized, sendJson, readJsonBody, store, userId }) {
  if (typeof authorized !== "function" || typeof sendJson !== "function"
      || typeof readJsonBody !== "function" || !store || typeof userId !== "function") {
    throw new Error("reminder handlers require auth, JSON, store, and user identity dependencies");
  }

  async function routeReminders(request, response, url) {
    const path = url.pathname;
    const collection = path === "/v1/reminders";
    const cancelId = pathPart(path, "/cancel");
    const itemId = cancelId === null ? pathPart(path, "") : null;
    const recognized = collection || cancelId !== null || itemId !== null;
    if (!recognized) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    if (typeof response.setHeader === "function") response.setHeader("cache-control", "no-store");
    try {
      if (collection && request.method === "POST") {
        const body = await readJsonBody(request);
        const reminder = await store.create({ ...body, user_id: userId(request) });
        sendJson(response, 201, { reminder });
      } else if (collection && request.method === "GET") {
        const result = await store.list(userId(request), {
          status: url.searchParams.get("status") || "",
          limit: url.searchParams.get("limit") || "",
          offset: url.searchParams.get("offset") || "",
        });
        sendJson(response, 200, { reminders: result.items, offset: result.offset, limit: result.limit, has_more: result.has_more });
      } else if (itemId !== null && request.method === "GET") {
        const reminder = await store.get(userId(request), decodeURIComponent(itemId));
        if (!reminder) sendJson(response, 404, { error: "reminder not found" });
        else sendJson(response, 200, { reminder });
      } else if (cancelId !== null && request.method === "POST") {
        const reminder = await store.cancel(userId(request), decodeURIComponent(cancelId));
        if (!reminder) sendJson(response, 404, { error: "reminder not found" });
        else sendJson(response, 200, { reminder });
      } else {
        sendJson(response, 405, { error: "method not allowed" });
      }
    } catch (error) {
      if (error?.code === "conflict") sendJson(response, 409, { error: error.message });
      else if (error?.code === "validation" || error instanceof URIError) sendJson(response, 400, { error: error.message });
      else sendJson(response, 500, { error: "reminder storage unavailable" });
    }
    return true;
  }

  return Object.freeze({ routeReminders });
}

function pathPart(pathname, suffix) {
  const prefix = "/v1/reminders/";
  const path = String(pathname || "");
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (!rest || (suffix && !rest.endsWith(suffix))) return null;
  const id = suffix ? rest.slice(0, -suffix.length) : rest;
  return id && !id.includes("/") ? id : null;
}

module.exports = { createReminderHandlers, pathPart };
