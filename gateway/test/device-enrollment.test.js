"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  createDeviceEnrollmentService,
  createMemoryDeviceEnrollmentStore,
  createPostgresDeviceEnrollmentStore,
} = require("../lib/device-enrollment");

const startedAt = Date.parse("2026-07-28T12:00:00.000Z");
const credential = `ag_dev_v1.${Buffer.alloc(32, 9).toString("base64url")}`;

function service(overrides = {}) {
  return createDeviceEnrollmentService({
    store: createMemoryDeviceEnrollmentStore(),
    now: () => startedAt,
    randomBytes: () => Buffer.alloc(32, 7),
    ...overrides,
  });
}

const request = {
  tenant_id: "personal_tenant",
  owner_id: "owner_1",
  device_id: "android_phone_1",
  surface_id: "android",
  application_id: "ag.companion",
};

test("issues a short-lived device-bound capability and restores account continuity", async () => {
  const enrollment = service();
  const issued = await enrollment.issue(request);
  assert.match(issued.enrollment_capability, /^ag_enroll_v1\./);
  assert.deepEqual(issued.enrollment, {
    capability_id: `enrc_${crypto.createHash("sha256").update(issued.enrollment_capability).digest("hex").slice(0, 32)}`,
    device_id: "android_phone_1",
    surface_id: "android",
    application_id: "ag.companion",
    expires_at: "2026-07-28T12:05:00.000Z",
  });
  const exchanged = await enrollment.exchange({
    enrollment_capability: issued.enrollment_capability,
    credential_token: credential,
  });
  assert.equal(exchanged.device_credential.application_id, "ag.companion");
  assert.deepEqual(exchanged.device_credential.scopes, [
    "continuity.read", "conversation.read", "conversation.write", "profile.read",
    "release.read", "device.receipts.write",
  ]);
  assert.deepEqual(exchanged.continuity, {
    account_id: "owner_1",
    tenant_id: "personal_tenant",
    restore: ["conversations", "sessions", "runs", "profile"],
    local_state_transferred: false,
  });
});

test("capability is single-use and expiry fails closed", async () => {
  let clock = startedAt;
  let randomByte = 1;
  const enrollment = service({
    now: () => clock,
    randomBytes: () => Buffer.alloc(32, randomByte++),
  });
  const issued = await enrollment.issue(request);
  await enrollment.exchange({ enrollment_capability: issued.enrollment_capability, credential_token: credential });
  await assert.rejects(
    enrollment.exchange({ enrollment_capability: issued.enrollment_capability, credential_token: credential }),
    (error) => error.code === "enrollment_capability_consumed",
  );

  const second = await enrollment.issue({ ...request, device_id: "android_phone_2" });
  clock += 5 * 60 * 1000 + 1;
  await assert.rejects(
    enrollment.exchange({
      enrollment_capability: second.enrollment_capability,
      credential_token: `ag_dev_v1.${Buffer.alloc(32, 8).toString("base64url")}`,
    }),
    (error) => error.code === "enrollment_capability_expired",
  );
});

test("rejects unsupported identities, caller-selected scopes, and malformed secrets", async () => {
  const enrollment = service();
  for (const bad of [
    { ...request, application_id: "ai.moa.assistant" },
    { ...request, surface_id: "server" },
    { ...request, tenant_id: "../tenant" },
    { ...request, ttl_ms: 10_001 },
  ]) {
    await assert.rejects(enrollment.issue(bad), (error) => error.code === "invalid_enrollment_request");
  }
  await assert.rejects(enrollment.exchange({
    enrollment_capability: "bad", credential_token: credential,
  }), (error) => error.code === "invalid_enrollment_capability");
  await assert.rejects(enrollment.exchange({
    enrollment_capability: `ag_enroll_v1.${Buffer.alloc(32).toString("base64url")}`,
    credential_token: "moa_dev_v1.not-new",
  }), (error) => error.code === "invalid_device_credential");
});

test("Postgres adapter passes hashes only to atomic exchange", async () => {
  const calls = [];
  const pool = {
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql.startsWith("insert")) return { rowCount: 1, rows: [{ capability_id: args[0] }] };
      return { rows: [{
        credential_id: "devc_1", tenant_id: "tenant", owner_id: "owner",
        device_id: "phone", surface_id: "android", application_id: "ag.companion",
        scopes: ["continuity.read"], created_at: new Date(startedAt),
      }] };
    },
  };
  const store = createPostgresDeviceEnrollmentStore(pool);
  assert.equal(await store.insertCapability({
    capability_id: "enrc_1", capability_hash: "a".repeat(64), binding_key: "b".repeat(64),
    tenant_id: "tenant", owner_id: "owner", device_id: "phone", surface_id: "android",
    application_id: "ag.companion", scopes: ["continuity.read"],
    issued_at: new Date(startedAt).toISOString(), expires_at: new Date(startedAt + 60_000).toISOString(),
  }), true);
  const result = await store.exchangeCapability({
    capability_hash: "a".repeat(64), credential_hash: "c".repeat(64),
    exchanged_at: new Date(startedAt).toISOString(),
  });
  assert.equal(result.application_id, "ag.companion");
  assert.equal(JSON.stringify(calls).includes("ag_enroll_v1"), false);
  assert.equal(calls.some((call) => call.sql.includes("exchange_device_enrollment_capability")), true);
});
