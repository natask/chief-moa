"use strict";

function createDeviceCredentialHandlers(options = {}) {
  const registry = options.registry;
  const authorized = requiredFunction(options.authorized, "authorized");
  const tenantId = requiredFunction(options.tenantId, "tenantId");
  const readJsonBody = requiredFunction(options.readJsonBody, "readJsonBody");
  const sendJson = requiredFunction(options.sendJson, "sendJson");
  const ownerContext = typeof options.ownerContext === "function" ? options.ownerContext : () => null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const configuredRecentAge = Number(options.recentAuthMaxAgeMs || 5 * 60_000);
  const recentAuthMaxAgeMs = Number.isFinite(configuredRecentAge) && configuredRecentAge > 0
    ? Math.min(configuredRecentAge, 15 * 60_000) : 5 * 60_000;
  if (!registry || typeof registry.register !== "function" || typeof registry.revoke !== "function"
      || typeof registry.list !== "function") {
    throw new Error("registry is required");
  }

  return async function handle(request, response, pathname) {
    if (pathname === "/v1/device-credentials/current/revoke") {
      return revokeOwnCredential(request, response, { registry, readJsonBody, sendJson });
    }
    if (pathname === "/v1/device-credentials") {
      return listOwnerCredentials(request, response, {
        registry, ownerContext, now, recentAuthMaxAgeMs, sendJson,
      });
    }
    const ownerRevoke = String(pathname || "").match(/^\/v1\/device-credentials\/([^/]+)\/revoke$/);
    if (ownerRevoke) {
      return revokeOwnerCredential(request, response, decodeId(ownerRevoke[1]), {
        registry, ownerContext, now, recentAuthMaxAgeMs, readJsonBody, sendJson,
      });
    }
    if (pathname !== "/v1/device-credentials/registrations") return false;
    if (String(request.method || "").toUpperCase() !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!authorized(request)) {
      sendJson(response, 401, { error: "unauthorized" });
      return true;
    }
    try {
      const body = await readJsonBody(request);
      const result = await registry.register({
        tenant_id: tenantId(request),
        device_id: body?.device_id,
        surface_id: body?.surface_id,
        idempotency_key: body?.idempotency_key,
        credential_token: body?.credential_token,
      });
      sendJson(response, result.replay ? 200 : 201, {
        schema_version: 1,
        registration_receipt: result.receipt,
      });
    } catch (error) {
      const status = error?.code === "device_already_registered" ? 409 : 400;
      sendJson(response, status, {
        error: error?.code || "invalid_request",
        message: String(error?.message || error).slice(0, 300),
      });
    }
    return true;
  };
}

async function listOwnerCredentials(request, response, options) {
  if (String(request.method || "").toUpperCase() !== "GET") {
    options.sendJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  const owner = recentOwner(request, options);
  if (!owner.ok) {
    options.sendJson(response, 403, { error: owner.error });
    return true;
  }
  try {
    const url = new URL(request.url || "/v1/device-credentials", "http://gateway");
    options.sendJson(response, 200, await options.registry.list({
      tenant_id: owner.principal.tenant_id,
      limit: url.searchParams.get("limit") || undefined,
      cursor: url.searchParams.get("cursor") || undefined,
    }));
  } catch (error) {
    sendCredentialError(response, error, options.sendJson);
  }
  return true;
}

async function revokeOwnerCredential(request, response, credentialId, options) {
  if (String(request.method || "").toUpperCase() !== "POST") {
    options.sendJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  const owner = recentOwner(request, options);
  if (!owner.ok) {
    options.sendJson(response, 403, { error: owner.error });
    return true;
  }
  try {
    const body = await options.readJsonBody(request);
    denyForgedOwnerIdentity(body, owner.principal, credentialId);
    if (!String(body?.reason || "").trim()) {
      const error = new Error("reason is required");
      error.code = "invalid_device_revocation";
      error.statusCode = 400;
      throw error;
    }
    const result = await options.registry.revoke({
      tenant_id: owner.principal.tenant_id,
      credential_id: credentialId,
      reason: body.reason,
    });
    options.sendJson(response, 200, {
      schema_version: 1, revocation_receipt: result.receipt, replay: result.replay,
    });
  } catch (error) {
    sendCredentialError(response, error, options.sendJson);
  }
  return true;
}

function recentOwner(request, { ownerContext, now, recentAuthMaxAgeMs }) {
  const principal = ownerContext(request);
  const roles = Array.isArray(principal?.roles) ? principal.roles.map(String) : [];
  if (!principal?.tenant_id || !principal?.user_id
      || !roles.some((role) => role === "owner" || role === "admin")) {
    return { ok: false, error: "owner_session_required" };
  }
  const authenticatedAt = Date.parse(String(principal.recent_auth_at || ""));
  const age = Number(now()) - authenticatedAt;
  if (!Number.isFinite(authenticatedAt) || age < 0 || age > recentAuthMaxAgeMs) {
    return { ok: false, error: "recent_auth_required" };
  }
  return { ok: true, principal };
}

function denyForgedOwnerIdentity(body, principal, credentialId) {
  for (const [field, expected] of Object.entries({
    tenant_id: principal.tenant_id,
    owner_user_id: principal.user_id,
    user_id: principal.user_id,
    credential_id: credentialId,
  })) {
    if (Object.hasOwn(body || {}, field) && String(body[field] || "") !== String(expected)) {
      const error = new Error(`${field} cannot select another owner or credential`);
      error.code = "identity_mismatch";
      error.statusCode = 403;
      throw error;
    }
  }
}

function decodeId(value) {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function sendCredentialError(response, error, sendJson) {
  sendJson(response,
    Number(error?.statusCode) || (error?.code === "device_credential_not_found" ? 404 : 400), {
      error: error?.code || "invalid_request",
      message: String(error?.message || error).slice(0, 300),
    });
}

async function revokeOwnCredential(request, response, { registry, readJsonBody, sendJson }) {
  if (String(request.method || "").toUpperCase() !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  const principal = request.moaAuthPrincipal;
  if (principal?.kind !== "enrolled_device" || !principal.tenant_id || !principal.credential_id) {
    sendJson(response, 401, { error: "unauthorized" });
    return true;
  }
  try {
    const body = await readJsonBody(request);
    denyForgedCredentialIdentity(body, principal);
    const result = await registry.revoke({
      tenant_id: principal.tenant_id,
      credential_id: principal.credential_id,
      reason: body?.reason,
    });
    sendJson(response, 200, {
      schema_version: 1,
      revocation_receipt: result.receipt,
      replay: result.replay,
    });
  } catch (error) {
    sendJson(response, Number(error?.statusCode) || (error?.code === "device_credential_not_found" ? 404 : 400), {
      error: error?.code || "invalid_request",
      message: String(error?.message || error).slice(0, 300),
    });
  }
  return true;
}

function denyForgedCredentialIdentity(body, principal) {
  for (const [field, expected] of Object.entries({
    tenant_id: principal.tenant_id,
    credential_id: principal.credential_id,
    device_id: principal.device_id,
    user_id: principal.user_id,
  })) {
    if (Object.hasOwn(body || {}, field) && String(body[field] || "") !== String(expected || "")) {
      const error = new Error(`${field} cannot select another credential`);
      error.code = "identity_mismatch";
      error.statusCode = 403;
      throw error;
    }
  }
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}

module.exports = { createDeviceCredentialHandlers };
