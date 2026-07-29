"use strict";

const CAPABILITY_PATH = "/v1/device-enrollments/capabilities";
const EXCHANGE_PATH = "/v1/device-enrollments/exchanges";
const CONTINUITY_PATH = "/v1/device-enrollments/continuity";

function createDeviceEnrollmentHandlers(options = {}) {
  const service = options.service;
  const authorized = requiredFunction(options.authorized, "authorized");
  const authenticateDevice = requiredFunction(options.authenticateDevice, "authenticateDevice");
  const authority = requiredFunction(options.authority, "authority");
  const readJsonBody = requiredFunction(options.readJsonBody, "readJsonBody");
  const sendJson = requiredFunction(options.sendJson, "sendJson");
  if (!service || typeof service.issue !== "function" || typeof service.exchange !== "function") {
    throw new Error("device enrollment service is required");
  }

  return async function handle(request, response, pathname) {
    if (pathname !== CAPABILITY_PATH && pathname !== EXCHANGE_PATH && pathname !== CONTINUITY_PATH) return false;
    const expectedMethod = pathname === CONTINUITY_PATH ? "GET" : "POST";
    if (String(request.method || "").toUpperCase() !== expectedMethod) {
      sendJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    if (pathname === CONTINUITY_PATH) {
      const principal = await authenticateDevice(request);
      if (!principal?.owner_id || principal.application_id !== "ag.companion"
          || !principal.scopes?.includes("continuity.read")) {
        sendJson(response, 401, { error: "invalid_device_credential" });
        return true;
      }
      sendJson(response, 200, {
        schema_version: 1,
        account_id: principal.owner_id,
        tenant_id: principal.tenant_id,
        restore: ["conversations", "sessions", "runs", "profile"],
        local_state_transferred: false,
      });
      return true;
    }
    if (pathname === CAPABILITY_PATH && !authorized(request)) {
      sendJson(response, 401, { error: "unauthorized" });
      return true;
    }
    try {
      const body = await readJsonBody(request);
      if (pathname === CAPABILITY_PATH) {
        const principal = authority(request);
        const result = await service.issue({
          tenant_id: principal.tenant_id,
          owner_id: principal.owner_id,
          device_id: body?.device_id,
          surface_id: body?.surface_id,
          application_id: body?.application_id,
          ttl_ms: body?.ttl_ms,
        });
        sendJson(response, 201, result);
      } else {
        sendJson(response, 201, await service.exchange({
          enrollment_capability: body?.enrollment_capability,
          credential_token: body?.credential_token,
        }));
      }
    } catch (error) {
      const status = error?.code === "enrollment_capability_expired" ? 410
        : error?.code === "enrollment_capability_consumed" || error?.code === "device_credential_conflict" ? 409
          : 400;
      sendJson(response, status, {
        error: error?.code || "invalid_request",
        message: String(error?.message || error).slice(0, 300),
      });
    }
    return true;
  };
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}

module.exports = { createDeviceEnrollmentHandlers };
