"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const crypto = require("node:crypto");
const {
  createDeviceCredentialRegistry,
  createMemoryDeviceCredentialStore,
} = require("../lib/device-credentials");
const {
  applyMigrations,
  assertSeparateDatabase,
  createReleaseControlRuntime,
  recoveryPrincipal,
  stableAuthority,
} = require("../lib/release-control-runtime");

test("disabled runtime does not claim release-control routes", async () => {
  const runtime = await createReleaseControlRuntime({ enabled: false });
  assert.equal(runtime.enabled, false);
  assert.equal(await runtime.route(), false);
});

test("recovery principal is device-bound, scope-specific, and revocation-aware", async () => {
  const active = {
    tenant_id: "tenant-1", owner_id: "user-1", device_id: "phone-1",
    surface_id: "android", credential_id: "credential-1", application_id: "ag.companion",
    scopes: ["release.recovery.read"],
  };
  const principal = await recoveryPrincipal(async () => active, {});
  assert.equal(principal.tenant_id, "tenant-1");
  assert.equal(principal.user_id, "user-1");
  assert.equal(principal.device_id, "phone-1");
  assert.equal(principal.application_id, "chief-moa");
  assert.equal(principal.device_application_id, "ag.companion");
  assert.deepEqual(principal.role_bindings[0].scope,
    { application_id: "chief-moa", channel: "*" });
  assert.equal(await recoveryPrincipal(async () => ({ ...active, scopes: ["release.read"] }), {}), null);
  assert.equal(await recoveryPrincipal(async () => null, {}), null);
  assert.equal(await recoveryPrincipal(async () => ({ ...active, surface_id: "desktop" }), {}), null);
  assert.equal(await recoveryPrincipal(async () => ({ ...active, application_id: "other.app" }), {}), null);

  const token = `ag_dev_v1.${Buffer.alloc(32, 4).toString("base64url")}`;
  const registry = createDeviceCredentialRegistry({
    now: () => Date.parse("2026-08-14T12:00:00.000Z"),
    store: createMemoryDeviceCredentialStore([{
      ...active,
      binding_key: "binding-1",
      token_hash: crypto.createHash("sha256").update(token).digest("hex"),
      status: "active",
      created_at: "2026-08-14T11:00:00.000Z",
    }]),
  });
  const request = { headers: { authorization: `Device ${token}` } };
  assert.equal((await recoveryPrincipal(registry.authenticateRequest, request)).device_id, "phone-1");
  await registry.revoke({ tenant_id: "tenant-1", credential_id: "credential-1", reason: "owner_requested" });
  assert.equal(await recoveryPrincipal(registry.authenticateRequest, request), null);
});

test("enabled runtime requires separate persistence and authentication", async () => {
  await assert.rejects(
    createReleaseControlRuntime({ enabled: true, authenticate: async () => null }),
    /RELEASE_CONTROL_DATABASE_URL is required/,
  );
  await assert.rejects(
    createReleaseControlRuntime({
      enabled: true,
      databaseUrl: "postgres://release.invalid/moa_release",
      tenantId: "tenant_personal",
      ownerId: "owner_personal",
    }),
    /authenticate/,
  );
  assert.throws(() => stableAuthority(), /TENANT_ID/);
  assert.throws(
    () => stableAuthority({ tenantId: "tenant", ownerId: "../owner" }),
    /OWNER_ID/,
  );
  assert.deepEqual(
    stableAuthority({ tenantId: "Tenant_Personal", ownerId: "Owner_Personal" }),
    { tenant_id: "tenant_personal", owner_id: "owner_personal" },
  );
  assert.throws(
    () => assertSeparateDatabase(
      "postgres://release:one@db/moa",
      "postgres://gateway:two@db/moa",
    ),
    /separate/,
  );
  assert.doesNotThrow(
    () => assertSeparateDatabase(
      "postgres://release:one@db/moa_release",
      "postgres://gateway:two@db/moa_gateway",
    ),
  );
});

test("migrations run in lexical order under one session lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-release-migration-"));
  fs.writeFileSync(path.join(dir, "002_second.sql"), "select 'second';\n");
  fs.writeFileSync(path.join(dir, "001_first.sql"), "select 'first';\n");
  const queries = [];
  let released = false;
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
    },
    release: () => {
      released = true;
    },
  };
  const pool = { connect: async () => client };

  await applyMigrations(pool, dir);

  assert.match(queries[0].sql, /pg_advisory_lock/);
  assert.equal(queries[1].sql, "select 'first';\n");
  assert.equal(queries[2].sql, "select 'second';\n");
  assert.match(queries[3].sql, /pg_advisory_unlock/);
  assert.equal(released, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("migration still unlocks and releases after SQL failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-release-migration-"));
  fs.writeFileSync(path.join(dir, "001_broken.sql"), "broken");
  const queries = [];
  let released = false;
  const client = {
    query: async (sql) => {
      queries.push(sql);
      if (sql === "broken") throw new Error("migration failed");
    },
    release: () => {
      released = true;
    },
  };

  await assert.rejects(applyMigrations({ connect: async () => client }, dir), /001_broken.*migration failed/);
  assert.match(queries.at(-1), /pg_advisory_unlock/);
  assert.equal(released, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
