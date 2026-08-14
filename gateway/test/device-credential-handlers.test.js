"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createDeviceCredentialHandlers } = require("../lib/device-credential-handlers");

function response() {
  return { status: 0, body: null };
}

function handler(overrides = {}) {
  return createDeviceCredentialHandlers({
    registry: {
      register: async (input) => ({
        replay: false,
        receipt: {
          credential_id: "devc_1",
          device_id: input.device_id,
          surface_id: input.surface_id,
        },
      }),
      revoke: async () => ({ replay: false, receipt: { credential_id: "devc_1", status: "revoked" } }),
    },
    authorized: () => true,
    tenantId: () => "stable_personal_tenant",
    readJsonBody: async (request) => request.body,
    sendJson: (target, status, body) => Object.assign(target, { status, body }),
    ...overrides,
  });
}

test("registers under the server-authenticated account and ignores a forged tenant", async () => {
  let observed;
  const handle = handler({
    registry: {
      register: async (input) => {
        observed = input;
        return { replay: false, receipt: { credential_id: "devc_1" } };
      },
      revoke: async () => ({ replay: false, receipt: {} }),
    },
  });
  const target = response();
  assert.equal(await handle({
    method: "POST",
    body: {
      tenant_id: "attacker",
      device_id: "phone_1",
      surface_id: "android",
      idempotency_key: "register-phone-1-20260723",
      credential_token: `moa_dev_v1.${Buffer.alloc(32, 1).toString("base64url")}`,
    },
  }, target, "/v1/device-credentials/registrations"), true);
  assert.equal(target.status, 201);
  assert.equal(observed.tenant_id, "stable_personal_tenant");
  assert.equal(observed.device_id, "phone_1");
});

test("fails closed, rejects wrong methods, and does not claim unrelated paths", async () => {
  const denied = handler({ authorized: () => false });
  const deniedResponse = response();
  await denied({ method: "POST" }, deniedResponse, "/v1/device-credentials/registrations");
  assert.equal(deniedResponse.status, 401);

  const wrongMethod = response();
  await handler()({ method: "GET" }, wrongMethod, "/v1/device-credentials/registrations");
  assert.equal(wrongMethod.status, 405);
  assert.equal(await handler()({ method: "POST" }, response(), "/v1/elsewhere"), false);
});

test("maps duplicate binding to conflict and exact retry to success", async () => {
  const conflict = response();
  const handleConflict = handler({
    registry: {
      register: async () => {
        const error = new Error("already registered");
        error.code = "device_already_registered";
        throw error;
      },
      revoke: async () => ({ replay: false, receipt: {} }),
    },
  });
  await handleConflict({ method: "POST", body: {} }, conflict, "/v1/device-credentials/registrations");
  assert.equal(conflict.status, 409);

  const replay = response();
  const handleReplay = handler({
    registry: {
      register: async () => ({
        replay: true,
        receipt: { credential_id: "devc_1" },
      }),
      revoke: async () => ({ replay: false, receipt: {} }),
    },
  });
  await handleReplay({ method: "POST", body: {} }, replay, "/v1/device-credentials/registrations");
  assert.equal(replay.status, 200);
});

test("an enrolled device revokes only its authenticated credential", async () => {
  let observed;
  const handle = handler({
    registry: {
      register: async () => ({ replay: false, receipt: {} }),
      revoke: async (input) => {
        observed = input;
        return { replay: false, receipt: { credential_id: input.credential_id, status: "revoked" } };
      },
    },
  });
  const target = response();
  await handle({
    method: "POST",
    moaAuthPrincipal: {
      kind: "enrolled_device",
      tenant_id: "tenant_owner",
      user_id: "user_owner",
      device_id: "phone_owner",
      credential_id: "devc_owner",
    },
    body: { reason: "owner_requested" },
  }, target, "/v1/device-credentials/current/revoke");

  assert.equal(target.status, 200);
  assert.deepEqual(observed, {
    tenant_id: "tenant_owner",
    credential_id: "devc_owner",
    reason: "owner_requested",
  });
  assert.equal(target.body.revocation_receipt.status, "revoked");
});

test("own-device revocation denies forged identities and missing shared authentication", async () => {
  let calls = 0;
  const handle = handler({
    registry: {
      register: async () => ({ replay: false, receipt: {} }),
      revoke: async () => { calls += 1; return { replay: false, receipt: {} }; },
    },
  });
  const principal = {
    kind: "enrolled_device", tenant_id: "tenant_owner", user_id: "user_owner",
    device_id: "phone_owner", credential_id: "devc_owner",
  };
  for (const body of [
    { reason: "owner_requested", tenant_id: "tenant_other" },
    { reason: "owner_requested", credential_id: "devc_other" },
    { reason: "owner_requested", device_id: "phone_other" },
    { reason: "owner_requested", user_id: "user_other" },
  ]) {
    const target = response();
    await handle({ method: "POST", moaAuthPrincipal: principal, body }, target,
      "/v1/device-credentials/current/revoke");
    assert.equal(target.status, 403);
    assert.equal(target.body.error, "identity_mismatch");
  }
  const missing = response();
  await handle({ method: "POST", body: { reason: "owner_requested" } }, missing,
    "/v1/device-credentials/current/revoke");
  assert.equal(missing.status, 401);
  assert.equal(calls, 0);
});
