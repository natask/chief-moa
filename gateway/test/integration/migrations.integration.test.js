"use strict";

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { after, before, describe, test } = require("node:test");
const { Client } = require("pg");

const { hasDatabaseUrl } = require("../smoke-manifest");
const { createIsolatedDatabase, dropIsolatedDatabase } = require("./isolated-db");

const gatewayRoot = path.resolve(__dirname, "../..");
// Set per run to an isolated database so this file never races the other
// integration file on the node-pg-migrate lock.
let env = { ...process.env };
let isolatedUrl = process.env.DATABASE_URL;
const relationalTables = [
  "users",
  "identities",
  "devices",
  "sessions",
  "branches",
  "turns",
  "voice_turns",
  "agent_runs",
  "browser_tasks",
  "tool_requests",
  "agent_profiles",
  "agent_profile_versions",
  "billing_price_versions",
  "billing_usage_facts",
  "billing_entitlement_facts",
  "billing_budget_versions",
  "billing_budget_reservations",
  "billing_webhook_receipts",
  "billing_adjustment_facts",
];

function runMigrateUp() {
  return spawnSync(
    process.execPath,
    ["node_modules/.bin/node-pg-migrate", "up"],
    {
      cwd: gatewayRoot,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }
  );
}

function assertMigrateSucceeded(result) {
  assert.strictEqual(
    result.status,
    0,
    [
      `node-pg-migrate up exited with status ${result.status}`,
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n")
  );
}

describe("node-pg-migrate relational schema", { skip: !hasDatabaseUrl() }, () => {
  let client;
  let isolatedDbName;

  before(async () => {
    const isolated = await createIsolatedDatabase("migrations");
    isolatedDbName = isolated.dbName;
    isolatedUrl = isolated.databaseUrl;
    env = { ...process.env, DATABASE_URL: isolatedUrl };
  });

  after(async () => {
    if (client) {
      await client.end();
    }
    await dropIsolatedDatabase(isolatedDbName);
  });

  test("applies migrations and no-ops on a second run", () => {
    const first = runMigrateUp();
    assertMigrateSucceeded(first);

    const second = runMigrateUp();
    assertMigrateSucceeded(second);
    assert.match(second.stdout, /No migrations to run!?/);
  });

  test("creates relational tables", async () => {
    client = new Client({ connectionString: isolatedUrl });
    await client.connect();

    const result = await client.query(
      `
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name = any($1::text[])
      `,
      [relationalTables]
    );
    const actualTables = new Set(result.rows.map((row) => row.table_name));

    assert.deepStrictEqual(
      relationalTables.filter((tableName) => !actualTables.has(tableName)),
      []
    );
  });

  test("enforces user isolation through moa_app role", async () => {
    if (!client) {
      client = new Client({ connectionString: isolatedUrl });
      await client.connect();
    }

    await client.query("set role moa_app");
    await client.query("set moa.user_id = 'owner'");

    const ownerResult = await client.query(
      "select id from users order by id asc"
    );
    assert.deepStrictEqual(
      ownerResult.rows.map((row) => row.id),
      ["owner"]
    );

    await client.query("set moa.user_id = 'nobody'");
    const nobodyResult = await client.query("select id from users");
    assert.strictEqual(nobodyResult.rowCount, 0);

    await client.query("reset role");
  });
});
