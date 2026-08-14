"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createDeviceCredentialRegistry,
  createMemoryDeviceCredentialStore,
  createPostgresDeviceCredentialStore,
} = require("../lib/device-credentials");

const nowMs = Date.parse("2026-07-23T12:00:00.000Z");
const deviceToken = `moa_dev_v1.${Buffer.alloc(32, 7).toString("base64url")}`;

function registry(overrides = {}) {
  return createDeviceCredentialRegistry({
    store: createMemoryDeviceCredentialStore(),
    now: () => nowMs,
    ...overrides,
  });
}

const registration = {
  tenant_id: "usr_owner",
  device_id: "phone_1",
  surface_id: "android",
  idempotency_key: "register-phone-1-20260723",
  credential_token: deviceToken,
};

test("registers only a token hash and authenticates its exact Device credential", async () => {
  const records = [];
  const store = {
    findByBinding: async (_tenant, key) => records.find((item) => item.binding_key === key) || null,
    findByTokenHash: async (hash) => records.find((item) => item.token_hash === hash) || null,
    insert: async (record) => (records.push(record), true),
    revoke: async () => null,
  };
  const credentials = registry({ store });
  const created = await credentials.register(registration);
  assert.equal(created.replay, false);
  assert.deepEqual(created.receipt, {
    credential_id: `devc_${crypto.createHash("sha256").update(deviceToken).digest("hex").slice(0, 32)}`,
    device_id: "phone_1",
    surface_id: "android",
    status: "active",
    created_at: "2026-07-23T12:00:00.000Z",
  });
  assert.equal(records.length, 1);
  assert.equal(JSON.stringify(records).includes(deviceToken), false);

  const principal = await credentials.authenticateRequest({
    headers: {
      authorization: `Device ${deviceToken}`,
      "x-moa-device-id": "phone_1",
      "x-moa-surface": "android",
    },
  });
  assert.equal(principal.tenant_id, "usr_owner");
  assert.equal(principal.device_id, "phone_1");
  assert.equal(principal.surface_id, "android");
});

test("exact retry verifies the same hash while any changed secret or key conflicts", async () => {
  const credentials = registry();
  const first = await credentials.register(registration);
  const replay = await credentials.register(registration);
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.receipt, first.receipt);

  await assert.rejects(
    credentials.register({ ...registration, idempotency_key: "different-register-key-20260723" }),
    (error) => error.code === "device_already_registered",
  );
  await assert.rejects(
    credentials.register({
      ...registration,
      credential_token: `moa_dev_v1.${Buffer.alloc(32, 8).toString("base64url")}`,
    }),
    (error) => error.code === "device_already_registered",
  );
});

test("rejects caller-forged assertions, bearer fallback, tampering, and malformed headers", async () => {
  const credentials = registry();
  await credentials.register(registration);
  const auth = `Device ${deviceToken}`;
  assert.equal(await credentials.authenticateRequest({ headers: { authorization: `Bearer ${deviceToken}` } }), null);
  assert.equal(await credentials.authenticateRequest({
    headers: { authorization: auth, "x-moa-device-id": "phone_2" },
  }), null);
  assert.equal(await credentials.authenticateRequest({
    headers: { authorization: auth, "x-moa-surface": "browser_extension" },
  }), null);
  assert.equal(await credentials.authenticateRequest({
    headers: { authorization: `${auth.slice(0, -1)}A` },
  }), null);
  assert.equal(await credentials.authenticateRequest({
    headers: { authorization: auth, "x-moa-device-id": ["phone_1", "phone_2"] },
  }), null);
});

test("revocation immediately fails closed with identical HTTP and WebSocket behavior", async () => {
  const credentials = registry();
  const created = await credentials.register(registration);
  const request = {
    headers: {
      authorization: `Device ${deviceToken}`,
      "x-moa-device-id": registration.device_id,
      "x-moa-surface": registration.surface_id,
    },
  };

  assert.equal((await credentials.authenticateHttpRequest(request)).credential_id,
    created.receipt.credential_id);
  assert.equal((await credentials.authenticateWebSocketRequest(request)).credential_id,
    created.receipt.credential_id);

  const revoked = await credentials.revoke({
    tenant_id: registration.tenant_id,
    credential_id: created.receipt.credential_id,
    reason: "device_lost",
  });
  assert.equal(revoked.replay, false);
  assert.equal(revoked.receipt.status, "revoked");
  assert.equal(await credentials.authenticateHttpRequest(request), null);
  assert.equal(await credentials.authenticateWebSocketRequest(request), null);

  const replay = await credentials.revoke({
    tenant_id: registration.tenant_id,
    credential_id: created.receipt.credential_id,
    reason: "security_response",
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.receipt.status, "revoked");
  assert.equal((await credentials.register(registration)).receipt.status, "revoked");
});

test("revoked binding can re-pair once while the old token stays denied", async () => {
  const credentials = registry();
  const original = await credentials.register(registration);
  await credentials.revoke({
    tenant_id: registration.tenant_id,
    credential_id: original.receipt.credential_id,
    reason: "credential_rotated",
  });

  const replacementToken = `moa_dev_v1.${Buffer.alloc(32, 9).toString("base64url")}`;
  const replacement = {
    ...registration,
    idempotency_key: "replace-phone-1-20260723",
    credential_token: replacementToken,
  };
  const [left, right] = await Promise.all([
    credentials.register(replacement),
    credentials.register(replacement),
  ]);
  assert.deepEqual([left.replay, right.replay].sort(), [false, true]);
  assert.equal(left.receipt.credential_id, right.receipt.credential_id);

  assert.equal(await credentials.authenticateRequest({
    headers: { authorization: `Device ${deviceToken}` },
  }), null);
  const principal = await credentials.authenticateRequest({
    headers: { authorization: `Device ${replacementToken}` },
  });
  assert.equal(principal.credential_id, left.receipt.credential_id);

  await assert.rejects(credentials.register({
    ...replacement,
    idempotency_key: "competing-phone-1-20260723",
    credential_token: `moa_dev_v1.${Buffer.alloc(32, 10).toString("base64url")}`,
  }), (error) => error.code === "device_already_registered");
});

test("revocation rejects forged tenant, unknown credential, and invalid reason", async () => {
  const credentials = registry();
  const created = await credentials.register(registration);
  for (const input of [
    { tenant_id: "another_owner", credential_id: created.receipt.credential_id },
    { tenant_id: registration.tenant_id, credential_id: "devc_missing" },
  ]) {
    await assert.rejects(credentials.revoke(input),
      (error) => error.code === "device_credential_not_found");
  }
  await assert.rejects(credentials.revoke({
    tenant_id: registration.tenant_id,
    credential_id: created.receipt.credential_id,
    reason: "reactivate",
  }), (error) => error.code === "invalid_device_revocation");
});

test("validates registration input and store configuration", async () => {
  assert.throws(() => createDeviceCredentialRegistry(), /store is required/);
  for (const bad of [
    { ...registration, tenant_id: "../owner" },
    { ...registration, device_id: "" },
    { ...registration, surface_id: "web_page" },
    { ...registration, idempotency_key: "short" },
    { ...registration, credential_token: "not-a-device-token" },
  ]) {
    await assert.rejects(registry().register(bad), (error) => error.code === "invalid_device_registration");
  }
});

test("Postgres adapter queries exact hashes and inserts no plaintext secret", async () => {
  const calls = [];
  const client = {
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql.startsWith("insert")) return { rowCount: 1, rows: [{ credential_id: args[0] }] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const pool = {
    async query(sql, args) {
      calls.push({ sql, args });
      return { rowCount: 0, rows: [] };
    },
    async connect() { return client; },
  };
  const store = createPostgresDeviceCredentialStore(pool);
  await store.findByBinding("owner", "a".repeat(64));
  await store.findByTokenHash("b".repeat(64));
  await store.insert({
    credential_id: "devc_123", binding_key: "a".repeat(64), tenant_id: "owner",
    device_id: "phone", surface_id: "android", token_hash: "b".repeat(64),
    idempotency_hash: "c".repeat(64), status: "active",
    created_at: "2026-07-23T12:00:00.000Z",
  });
  const revoked = await store.revoke({
    tenant_id: "owner", credential_id: "devc_123", reason: "owner_requested",
    revoked_at: "2026-07-23T12:01:00.000Z",
  });
  assert.equal(revoked, null);
  assert.equal(calls.filter((call) => call.sql.includes("release_device_credentials")).length, 3);
  assert.equal(JSON.stringify(calls).includes(deviceToken), false);
  assert.equal(calls.some((call) => call.sql.includes("release_authenticate_device_credential")), true);
  assert.equal(calls.some((call) => call.sql.includes("on conflict do nothing")), true);
  assert.equal(calls.some((call) => call.sql.includes("release_device_credential_revocations")), true);
  assert.equal(calls.some((call) => call.sql.includes("pg_advisory_xact_lock")), true);
  assert.equal(calls.some((call) => call.sql.includes("release_device_credential_generations")), true);
});

test("generation migration preserves immutable history and serializes re-pair", () => {
  const sql = fs.readFileSync(path.join(__dirname,
    "../../release_control_plane/migrations/007_device_credential_generations.sql"), "utf8");
  assert.match(sql, /create table if not exists release_device_credential_generations/);
  assert.match(sql, /insert into release_device_credential_generations[\s\S]*release_device_credentials/);
  assert.match(sql, /release_device_credential_generations_append_only/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(capability\.binding_key, 0\)\)/);
  assert.match(sql, /not exists \([\s\S]*release_device_credential_revocations/);
  assert.match(sql, /create or replace function exchange_device_enrollment_capability/);
  assert.doesNotMatch(sql, /update public\.release_device_credentials/i);
  assert.doesNotMatch(sql, /delete from public\.release_device_credentials/i);
});

test("revocation migration is additive, tenant-scoped, append-only, and checked at authentication", () => {
  const sql = fs.readFileSync(path.join(__dirname,
    "../../release_control_plane/migrations/006_device_credential_revocations.sql"), "utf8");
  assert.match(sql, /create table if not exists release_device_credential_revocations/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /force row level security/);
  assert.match(sql, /tenant_id = current_setting\('moa\.tenant_id', true\)/);
  assert.match(sql, /release_device_credential_revocations_append_only/);
  assert.match(sql, /not exists \([\s\S]*release_device_credential_revocations/);
  assert.doesNotMatch(sql, /alter table release_device_credentials[\s\S]*alter column/i);
});
