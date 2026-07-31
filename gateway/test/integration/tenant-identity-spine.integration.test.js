"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { after, before, describe, test } = require("node:test");
const { Client } = require("pg");

const { hasDatabaseUrl } = require("../smoke-manifest");
const { createIsolatedDatabase, dropIsolatedDatabase } = require("./isolated-db");

const gatewayRoot = path.resolve(__dirname, "../..");

describe("tenant identity spine", { skip: !hasDatabaseUrl() }, () => {
  let client;
  let databaseUrl;
  let databaseName;

  before(async () => {
    const isolated = await createIsolatedDatabase("tenant_identity_spine");
    databaseUrl = isolated.databaseUrl;
    databaseName = isolated.dbName;
    const migrated = spawnSync(
      process.execPath,
      ["node_modules/.bin/node-pg-migrate", "up"],
      {
        cwd: gatewayRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    assert.equal(migrated.status, 0, [migrated.stdout, migrated.stderr].join("\n"));
    client = new Client({ connectionString: databaseUrl });
    await client.connect();

    await client.query(`
      insert into users (id, kind, display)
        values ('user_b','account','User B');
      insert into tenants (id, kind, display)
        values ('tenant_b','personal','Tenant B');
      insert into tenant_memberships (tenant_id, user_id, role, status)
        values ('tenant_b','user_b','owner','active');
      update identities set auth_user_id = 'auth_owner' where id = 'owner';
    `);
  });

  after(async () => {
    if (client) await client.end();
    await dropIsolatedDatabase(databaseName);
  });

  test("one Better Auth account cannot bind to two internal identities", async () => {
    await assert.rejects(
      client.query(
        `insert into identities (id, user_id, auth_user_id, provider)
         values ('identity_b','user_b','auth_owner','better-auth')`,
      ),
      (error) => error?.code === "23505",
    );
  });

  test("moa_app sees only the active membership for its tenant and user", async () => {
    await client.query("set role moa_app");
    try {
      await setPrincipal(client, "owner", "owner");
      assert.deepEqual(await visibleIds(client, "tenants", "id"), ["owner"]);
      assert.deepEqual(await visibleIds(client, "tenant_memberships", "tenant_id"), ["owner"]);

      await setPrincipal(client, "user_b", "tenant_b");
      assert.deepEqual(await visibleIds(client, "tenants", "id"), ["tenant_b"]);
      assert.deepEqual(await visibleIds(client, "tenant_memberships", "tenant_id"), ["tenant_b"]);

      await setPrincipal(client, "user_b", "owner");
      assert.deepEqual(await visibleIds(client, "tenants", "id"), []);
      assert.deepEqual(await visibleIds(client, "tenant_memberships", "tenant_id"), []);
    } finally {
      await client.query("reset role");
    }
  });

  test("moa_app cannot create a membership for a different principal", async () => {
    await client.query("set role moa_app");
    try {
      await setPrincipal(client, "owner", "owner");
      await assert.rejects(
        client.query(
          `insert into tenant_memberships (tenant_id, user_id, role, status)
           values ('owner','user_b','member','active')`,
        ),
        (error) => error?.code === "42501",
      );
    } finally {
      await client.query("reset role");
    }
  });
});

async function setPrincipal(client, userId, tenantId) {
  await client.query("select set_config('moa.user_id', $1, false)", [userId]);
  await client.query("select set_config('moa.tenant_id', $1, false)", [tenantId]);
}

async function visibleIds(client, table, column) {
  const result = await client.query(`select ${column} from ${table} order by ${column}`);
  return result.rows.map((row) => row[column]);
}
