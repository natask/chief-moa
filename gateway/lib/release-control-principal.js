"use strict";

const SURFACES = new Set(["android", "browser_extension", "desktop"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * Builds the authentication boundary used before release-control transport.
 *
 * A gateway bearer token authenticates the account, not a device. Callers must
 * therefore present a device identifier and surface that resolve to a
 * server-owned device registration for that same account. Query/body fields
 * are deliberately ignored: the HTTP adapter overwrites them with this trusted
 * result.
 */
function createReleaseControlPrincipalResolver(options = {}) {
  const authorized = requiredFunction(options.authorized, "authorized");
  const accountUserId = requiredFunction(options.accountUserId, "accountUserId");
  const resolveDevice = requiredFunction(options.resolveDevice, "resolveDevice");

  return async function authenticate(request = {}) {
    if (!authorized(request)) return null;

    const tenantId = safeId(accountUserId(request));
    const deviceId = safeId(header(request, "x-moa-device-id"));
    const surfaceId = safeId(header(request, "x-moa-surface"));
    if (!tenantId || !deviceId || !SURFACES.has(surfaceId)) return null;

    const device = await resolveDevice({ tenant_id: tenantId, device_id: deviceId });
    if (!device || safeId(device.id || device.device_id) !== deviceId) return null;
    if (safeId(device.user_id || device.tenant_id) !== tenantId) return null;
    if (safeId(device.surface || device.surface_id) !== surfaceId) return null;

    return Object.freeze({
      tenant_id: tenantId,
      actor_id: tenantId,
      owner_id: tenantId,
      device_id: deviceId,
      surface_id: surfaceId,
      role_bindings: Object.freeze([]),
      delegation_grants: Object.freeze([]),
    });
  };
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}

function header(request, name) {
  const headers = request?.headers || {};
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? "" : String(value || "").trim();
}

function safeId(value) {
  const result = String(value || "").trim().toLowerCase();
  return ID_PATTERN.test(result) ? result : "";
}

module.exports = { createReleaseControlPrincipalResolver };
