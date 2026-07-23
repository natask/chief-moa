"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createReleaseControlPrincipalResolver } = require("../lib/release-control-principal");

test("returns only the verified device principal", async () => {
  const authenticate = createReleaseControlPrincipalResolver({
    authenticateDevice: async () => ({
      tenant_id: "personal_tenant",
      device_id: "phone_1",
      surface_id: "android",
      credential_id: "devc_123",
    }),
    ownerId: () => "usr_owner",
  });
  const principal = await authenticate({
    query: { tenant_id: "forged", device_id: "other" },
    body: { surface: "browser_extension" },
  });
  assert.deepEqual(principal, {
    tenant_id: "personal_tenant",
    actor_id: "devc_123",
    owner_id: "usr_owner",
    device_id: "phone_1",
    surface_id: "android",
    role_bindings: [{
      tenant_id: "personal_tenant",
      principal_id: "devc_123",
      role: "device",
      scope: { application_id: "chief-moa", channel: "*" },
    }],
    delegation_grants: [],
  });
  assert.equal(Object.isFrozen(principal), true);
});

test("fails closed without a complete verified device", async () => {
  for (const value of [
    null,
    {},
    { tenant_id: "owner", device_id: "phone" },
    { tenant_id: "owner", surface_id: "android" },
    { device_id: "phone", surface_id: "android" },
  ]) {
    const authenticate = createReleaseControlPrincipalResolver({
      authenticateDevice: async () => value,
      ownerId: () => "usr_owner",
    });
    assert.equal(await authenticate({}), null);
  }
});

test("requires stable device authentication and owner identity dependencies", () => {
  assert.throws(() => createReleaseControlPrincipalResolver(), /authenticateDevice is required/);
  assert.throws(() => createReleaseControlPrincipalResolver({
    authenticateDevice: async () => ({
      tenant_id: "personal", device_id: "phone", surface_id: "android",
    }),
  }), /ownerId is required/);
});
