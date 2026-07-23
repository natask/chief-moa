"use strict";

/**
 * Builds the authentication boundary used before release-control transport.
 *
 * Release-control authority comes only from a verified, device-scoped
 * credential. Caller query, body, and assertion headers cannot choose the
 * resulting tenant, device, or surface.
 */
function createReleaseControlPrincipalResolver(options = {}) {
  const authenticateDevice = requiredFunction(options.authenticateDevice, "authenticateDevice");
  const ownerId = requiredFunction(options.ownerId, "ownerId");

  return async function authenticate(request = {}) {
    const device = await authenticateDevice(request);
    if (!device?.tenant_id || !device?.device_id || !device?.surface_id || !device?.credential_id) return null;
    const owner = ownerId(request);
    if (!owner) return null;

    return Object.freeze({
      tenant_id: device.tenant_id,
      actor_id: device.credential_id,
      owner_id: owner,
      device_id: device.device_id,
      surface_id: device.surface_id,
      role_bindings: Object.freeze([Object.freeze({
        tenant_id: device.tenant_id,
        principal_id: device.credential_id,
        role: "device",
        scope: Object.freeze({ application_id: "chief-moa", channel: "*" }),
      })]),
      delegation_grants: Object.freeze([]),
    });
  };
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}

module.exports = { createReleaseControlPrincipalResolver };
