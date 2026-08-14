"use strict";

const BASE_PATH = "/v1/development-requests";

function createDevelopmentRequestCoordinatorResolver(options = {}) {
  const token = String(options.token || "");
  const authority = requiredFunction(options.authority, "authority");
  const reserved = (Array.isArray(options.reservedTokens) ? options.reservedTokens : [])
    .map(String).filter(Boolean);
  const usable = Boolean(token) && !reserved.includes(token);
  return function resolve(request = {}) {
    if (!usable || String(request.headers?.authorization || "") !== `Bearer ${token}`) return null;
    const owner = authority();
    if (!owner?.tenant_id || !owner?.owner_id) return null;
    return Object.freeze({
      kind: "development_request_coordinator",
      tenant_id: String(owner.tenant_id),
      user_id: String(owner.owner_id),
      scopes: Object.freeze(["development.request.progress"]),
    });
  };
}

function createDevelopmentRequestHandlers(options = {}) {
  const store = options.store;
  const readJsonBody = requiredFunction(options.readJsonBody, "readJsonBody");
  const sendJson = requiredFunction(options.sendJson, "sendJson");
  const coordinatorPrincipal = typeof options.coordinatorPrincipal === "function"
    ? options.coordinatorPrincipal : () => null;
  const cleanError = typeof options.cleanError === "function"
    ? options.cleanError
    : (error) => String(error?.message || error);
  if (!store || !["create", "list", "get", "rename", "updateProgress"]
    .every((method) => typeof store[method] === "function")) {
    throw new Error("development request store is required");
  }

  return async function routeDevelopmentRequests(request, response, url) {
    const route = parseRoute(url?.pathname);
    if (!route) return false;
    const method = String(request.method || "GET").toUpperCase();
    if (route.action === "progress" && method === "POST") {
      return updateProgress(request, response, route, {
        coordinatorPrincipal, store, readJsonBody, sendJson, cleanError,
      });
    }
    const principal = ownedPrincipal(request?.moaAuthPrincipal);
    if (!principal) {
      sendJson(response, 401, { error: "unauthorized" });
      return true;
    }
    if (!hasDevelopmentRequestScope(request.moaAuthPrincipal)) {
      sendJson(response, 403, { error: "development_request_scope_required" });
      return true;
    }

    try {
      if (route.action === "collection" && method === "POST") {
        const body = await ownedBody(request, principal, readJsonBody);
        sendJson(response, 201, { development_request: await store.create(principal, body) });
        return true;
      }
      if (route.action === "collection" && method === "GET") {
        sendJson(response, 200, await store.list(principal, {
          limit: url.searchParams.get("limit") || undefined,
          cursor: url.searchParams.get("cursor") || undefined,
        }));
        return true;
      }
      if (route.action === "detail" && method === "GET") {
        sendJson(response, 200, { development_request: await store.get(principal, route.requestId) });
        return true;
      }
      if (route.action === "rename" && method === "POST") {
        const body = await ownedBody(request, principal, readJsonBody);
        sendJson(response, 200, { development_request: await store.rename(principal, route.requestId, body) });
        return true;
      }
      sendJson(response, 405, { error: "method_not_allowed" });
    } catch (error) {
      sendJson(response, Number(error?.statusCode) || 400, {
        error: error?.code || "invalid_request",
        message: cleanError(error).slice(0, 300),
      });
    }
    return true;
  };
}

async function updateProgress(request, response, route, options) {
  const authority = options.coordinatorPrincipal(request);
  const coordinator = ownedPrincipal(authority);
  const scopes = authority?.scopes;
  if (!coordinator || !Array.isArray(scopes) || !scopes.includes("development.request.progress")) {
    options.sendJson(response, 403, { error: "development_request_coordinator_required" });
    return true;
  }
  try {
    const body = await ownedBody(request, coordinator, options.readJsonBody);
    options.sendJson(response, 200, {
      development_request: await options.store.updateProgress(coordinator, route.requestId, body),
    });
  } catch (error) {
    options.sendJson(response, Number(error?.statusCode) || 400, {
      error: error?.code || "invalid_request",
      message: options.cleanError(error).slice(0, 300),
    });
  }
  return true;
}

function parseRoute(pathname) {
  const path = String(pathname || "");
  if (path === BASE_PATH) return { action: "collection", requestId: "" };
  if (!path.startsWith(`${BASE_PATH}/`)) return null;
  const parts = path.slice(BASE_PATH.length + 1).split("/");
  if (parts.length < 1 || parts.length > 2 || !parts[0]) return null;
  let requestId;
  try {
    requestId = decodeURIComponent(parts[0]);
  } catch {
    return { action: "invalid", requestId: "" };
  }
  if (parts.length === 1) return { action: "detail", requestId };
  if (["rename", "progress"].includes(parts[1])) return { action: parts[1], requestId };
  return { action: "invalid", requestId };
}

function ownedPrincipal(principal) {
  const tenantId = String(principal?.tenant_id || "").trim();
  const userId = String(principal?.user_id || "").trim();
  if (!tenantId || !userId) return null;
  return Object.freeze({
    tenant_id: tenantId,
    user_id: userId,
    device_id: String(principal?.device_id || "").trim(),
  });
}

function hasDevelopmentRequestScope(principal) {
  if (principal?.kind !== "enrolled_device") return true;
  return Array.isArray(principal.scopes) && principal.scopes.includes("development.request");
}

async function ownedBody(request, principal, readJsonBody) {
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const identities = {
    tenant_id: principal.tenant_id,
    tenantId: principal.tenant_id,
    owner_user_id: principal.user_id,
    ownerUserId: principal.user_id,
    user_id: principal.user_id,
    userId: principal.user_id,
    device_id: principal.device_id,
    deviceId: principal.device_id,
  };
  for (const [field, expected] of Object.entries(identities)) {
    if (Object.hasOwn(body, field) && String(body[field] || "") !== expected) {
      const error = new Error(`${field} cannot select another identity`);
      error.code = "identity_mismatch";
      error.statusCode = 403;
      throw error;
    }
  }
  return body;
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}

module.exports = { createDevelopmentRequestCoordinatorResolver, createDevelopmentRequestHandlers };
