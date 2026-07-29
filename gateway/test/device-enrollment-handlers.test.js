"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createDeviceEnrollmentHandlers } = require("../lib/device-enrollment-handlers");

function response() { return { status: 0, body: null }; }

function handler(overrides = {}) {
  return createDeviceEnrollmentHandlers({
    service: {
      issue: async (input) => ({ schema_version: 1, observed: input }),
      exchange: async (input) => ({ schema_version: 1, observed: input }),
    },
    authorized: () => true,
    authenticateDevice: async () => ({
      tenant_id: "trusted_tenant", owner_id: "trusted_owner", application_id: "ag.companion",
      scopes: ["continuity.read", "profile.read"],
    }),
    authority: () => ({ tenant_id: "trusted_tenant", owner_id: "trusted_owner" }),
    readJsonBody: async (request) => request.body,
    sendJson: (target, status, body) => Object.assign(target, { status, body }),
    readAccountSettings: async () => ({
      profile: { assistant_name: "Ag", voice: "Aoede", system_prompt: "server-owned" },
      profile_version: "prof_3",
    }),
    ...overrides,
  });
}

test("owner-authenticated issuance ignores forged account authority", async () => {
  const target = response();
  await handler()({ method: "POST", body: {
    tenant_id: "attacker", owner_id: "attacker", device_id: "phone",
    surface_id: "android", application_id: "ag.companion",
  } }, target, "/v1/device-enrollments/capabilities");
  assert.equal(target.status, 201);
  assert.equal(target.body.observed.tenant_id, "trusted_tenant");
  assert.equal(target.body.observed.owner_id, "trusted_owner");
});

test("exchange needs only the one-use capability, never the gateway bearer", async () => {
  const target = response();
  await handler({ authorized: () => false })({ method: "POST", body: {
    enrollment_capability: "capability", credential_token: "credential",
  } }, target, "/v1/device-enrollments/exchanges");
  assert.equal(target.status, 201);
  assert.deepEqual(target.body.observed, {
    enrollment_capability: "capability", credential_token: "credential",
  });
});

test("scoped Ag credential returns gateway-owned continuity and no local-transfer claim", async () => {
  const target = response();
  await handler()({ method: "GET", headers: { authorization: "Device opaque" } }, target,
    "/v1/device-enrollments/continuity");
  assert.equal(target.status, 200);
  assert.deepEqual(target.body, {
    schema_version: 1,
    account_id: "trusted_owner",
    tenant_id: "trusted_tenant",
    restore: ["conversations", "sessions", "runs", "profile"],
    settings_endpoint: "/v1/device-enrollments/continuity/settings",
    local_state_transferred: false,
  });

  const denied = response();
  await handler({ authenticateDevice: async () => null })({ method: "GET" }, denied,
    "/v1/device-enrollments/continuity");
  assert.equal(denied.status, 401);
});

test("settings restore needs profile.read and returns only account-owned settings", async () => {
  const target = response();
  await handler()({ method: "GET", headers: { authorization: "Device opaque" } }, target,
    "/v1/device-enrollments/continuity/settings");
  assert.equal(target.status, 200);
  assert.equal(target.body.settings_schema_version, 1);
  assert.equal(target.body.account_id, "trusted_owner");
  assert.equal(target.body.profile_version, "prof_3");
  assert.equal(target.body.local_state_transferred, false);
  assert.deepEqual(target.body.settings, { assistant_name: "Ag", voice: "Aoede" });

  const denied = response();
  await handler({ authenticateDevice: async () => ({
    tenant_id: "trusted_tenant", owner_id: "trusted_owner", application_id: "ag.companion",
    scopes: ["continuity.read"],
  }) })({ method: "GET" }, denied, "/v1/device-enrollments/continuity/settings");
  assert.equal(denied.status, 401);

  const wrongApp = response();
  await handler({ authenticateDevice: async () => ({
    tenant_id: "trusted_tenant", owner_id: "trusted_owner", application_id: "ai.moa.assistant",
    scopes: ["profile.read"],
  }) })({ method: "GET" }, wrongApp, "/v1/device-enrollments/continuity/settings");
  assert.equal(wrongApp.status, 401);
});

test("issuance requires owner auth and handler rejects wrong methods and unrelated paths", async () => {
  const denied = response();
  await handler({ authorized: () => false })({ method: "POST" }, denied,
    "/v1/device-enrollments/capabilities");
  assert.equal(denied.status, 401);
  const wrongMethod = response();
  await handler()({ method: "GET" }, wrongMethod, "/v1/device-enrollments/exchanges");
  assert.equal(wrongMethod.status, 405);
  assert.equal(await handler()({ method: "POST" }, response(), "/v1/elsewhere"), false);
});

test("maps consumed and expired capabilities without exposing secrets", async () => {
  for (const [code, status] of [["enrollment_capability_consumed", 409], ["enrollment_capability_expired", 410]]) {
    const target = response();
    const handle = handler({ service: {
      issue: async () => ({}),
      exchange: async () => { throw Object.assign(new Error("exchange rejected"), { code }); },
    } });
    await handle({ method: "POST", body: {} }, target, "/v1/device-enrollments/exchanges");
    assert.equal(target.status, status);
    assert.equal(JSON.stringify(target.body).includes("credential_token"), false);
  }
});
