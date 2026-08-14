"use strict";

function createDeviceCredentialHandlers(options = {}) {
  const registry = options.registry;
  const authorized = requiredFunction(options.authorized, "authorized");
  const tenantId = requiredFunction(options.tenantId, "tenantId");
  const readJsonBody = requiredFunction(options.readJsonBody, "readJsonBody");
  const sendJson = requiredFunction(options.sendJson, "sendJson");
  if (!registry || typeof registry.register !== "function" || typeof registry.revoke !== "function") {
    throw new Error("registry is required");
  }

  return async function handle(request, response, pathname) {
    if (pathname === "/v1/device-credentials/current/revoke") {
      return revokeOwnCredential(request, response, { registry, readJsonBody, sendJson });
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
