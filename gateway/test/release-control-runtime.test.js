"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  applyMigrations,
  assertSeparateDatabase,
  createReleaseControlRuntime,
  stableAuthority,
} = require("../lib/release-control-runtime");

test("disabled runtime does not claim release-control routes", async () => {
  const runtime = await createReleaseControlRuntime({ enabled: false });
  assert.equal(runtime.enabled, false);
  assert.equal(await runtime.route(), false);
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
