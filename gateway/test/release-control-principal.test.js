"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createReleaseControlPrincipalResolver } = require("../lib/release-control-principal");

function resolver(overrides = {}) {
  return createReleaseControlPrincipalResolver({
    authorized: () => true,
    accountUserId: () => "usr_owner",
    resolveDevice: async ({ tenant_id, device_id }) => ({
      id: device_id,
      user_id: tenant_id,
      surface: "android",
    }),
    ...overrides,
  });
}

test("returns server-resolved owner and device identity", async () => {
  const authenticate = resolver();
  const principal = await authenticate({
    headers: { "x-moa-device-id": "phone_1", "x-moa-surface": "android" },
  });

  assert.deepEqual(principal, {
    tenant_id: "usr_owner",
    actor_id: "usr_owner",
    owner_id: "usr_owner",
    device_id: "phone_1",
    surface_id: "android",
    role_bindings: [],
    delegation_grants: [],
  });
  assert.equal(Object.isFrozen(principal), true);
});

test("fails closed without account authorization or required headers", async () => {
  const denied = resolver({ authorized: () => false });
  assert.equal(await denied({
    headers: { "x-moa-device-id": "phone_1", "x-moa-surface": "android" },
  }), null);
  assert.equal(await resolver()({ headers: { "x-moa-surface": "android" } }), null);
  assert.equal(await resolver()({ headers: { "x-moa-device-id": "phone_1" } }), null);
  assert.equal(await resolver()(), null);
  assert.equal(await resolver({ accountUserId: () => "../owner" })({
    headers: { "x-moa-device-id": "phone_1", "x-moa-surface": "android" },
  }), null);
});

test("rejects unknown surfaces and duplicate header values", async () => {
  const authenticate = resolver();
  assert.equal(await authenticate({
    headers: { "x-moa-device-id": "phone_1", "x-moa-surface": "web_page" },
  }), null);
  assert.equal(await authenticate({
    headers: { "x-moa-device-id": ["phone_1", "phone_2"], "x-moa-surface": "android" },
  }), null);
});

test("rejects cross-account, wrong-device, and wrong-surface registrations", async () => {
  const request = {
    headers: { "x-moa-device-id": "phone_1", "x-moa-surface": "android" },
  };
  const variants = [
    { id: "phone_2", user_id: "usr_owner", surface: "android" },
    { id: "phone_1", user_id: "usr_other", surface: "android" },
    { id: "phone_1", user_id: "usr_owner", surface: "browser_extension" },
    null,
  ];

  for (const device of variants) {
    const authenticate = resolver({ resolveDevice: async () => device });
    assert.equal(await authenticate(request), null);
  }
});

test("ignores caller-owned query and body identity fields", async () => {
  const authenticate = resolver();
  const principal = await authenticate({
    headers: { "x-moa-device-id": "phone_1", "x-moa-surface": "android" },
    query: { device_id: "forged", surface: "browser_extension", tenant_id: "other" },
    body: { device_id: "forged", surface: "browser_extension", tenant_id: "other" },
  });

  assert.equal(principal.device_id, "phone_1");
  assert.equal(principal.surface_id, "android");
  assert.equal(principal.tenant_id, "usr_owner");
});

test("accepts normalized device registration field aliases", async () => {
  const authenticate = resolver({
    resolveDevice: async () => ({
      device_id: "PHONE_1",
      tenant_id: "USR_OWNER",
      surface_id: "ANDROID",
    }),
  });
  const principal = await authenticate({
    headers: { "x-moa-device-id": "PHONE_1", "x-moa-surface": "ANDROID" },
  });
  assert.equal(principal.device_id, "phone_1");
});

test("requires all dependencies", () => {
  assert.throws(() => createReleaseControlPrincipalResolver(), /authorized is required/);
  assert.throws(() => createReleaseControlPrincipalResolver({
    authorized: () => true,
  }), /accountUserId is required/);
  assert.throws(() => createReleaseControlPrincipalResolver({
    authorized: () => true,
    accountUserId: () => "usr_owner",
  }), /resolveDevice is required/);
});
