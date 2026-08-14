"use strict";

async function attachEnrolledDevicePrincipal(request, authenticateDevice) {
  if (request?.moaAuthPrincipal?.user_id || typeof authenticateDevice !== "function") return null;
  const device = await authenticateDevice(request);
  const scopes = Array.isArray(device?.scopes) ? device.scopes.map(String) : [];
  if (!device?.owner_id || device.application_id !== "ag.companion"
      || !scopes.includes("conversation.read")
      || !scopes.includes("conversation.write")) return null;
  const principal = Object.freeze({
    user_id: String(device.owner_id),
    tenant_id: String(device.tenant_id || ""),
    device_id: String(device.device_id || ""),
    surface_id: String(device.surface_id || ""),
    credential_id: String(device.credential_id || ""),
    kind: "enrolled_device",
    scopes: Object.freeze(scopes),
  });
  request.moaAuthPrincipal = principal;
  return principal;
}

module.exports = { attachEnrolledDevicePrincipal };
