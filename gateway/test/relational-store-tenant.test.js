"use strict";

const assert = require("node:assert");
const { test } = require("node:test");

const { createRelationalStore } = require("../lib/relational-store");

test("relational store requires a trusted tenant identity", () => {
  const pool = fakePool();
  assert.throws(() => createRelationalStore({ pool }), /requires userId/);
  assert.throws(() => createRelationalStore({ pool, userId: "../escape" }), /userId is invalid/);
});

test("record input cannot replace the trusted tenant identity", async () => {
  const pool = fakePool();
  const store = createRelationalStore({ pool, userId: "user-a", originId: "test" });
  const attacks = [
    ["upsertSession", { id: "id" }],
    ["upsertBranch", { session_id: "session", branch_id: "branch" }],
    ["upsertChatTurn", { id: "turn", session_id: "session" }],
    ["upsertVoiceTurn", { id: "voice", session_id: "session" }],
    ["upsertAgentRun", { id: "run" }],
    ["upsertBrowserTask", { id: "task" }],
    ["upsertToolRequest", { id: "request" }],
  ];
  for (const [method, record] of attacks) {
    await assert.rejects(
      () => store[method]({ ...record, user_id: "user-b" }),
      /does not match trusted store identity/,
    );
  }
  assert.strictEqual(pool.sql.filter((sql) => sql === "begin").length, attacks.length);
  assert.strictEqual(pool.sql.filter((sql) => sql === "rollback").length, attacks.length);
});

test("tenant event namespace is unambiguous when user ids contain delimiters", async () => {
  const firstPool = fakePool({ returnBusinessRow: true });
  const secondPool = fakePool({ returnBusinessRow: true });
  await createRelationalStore({ pool: firstPool, userId: "a", originId: "test" })
    .upsertSession({ id: "b:session:c" });
  await createRelationalStore({ pool: secondPool, userId: "a:session:b", originId: "test" })
    .upsertSession({ id: "c" });
  const firstParams = firstPool.calls.find((call) => /insert into product_events/.test(call.sql)).params;
  const secondParams = secondPool.calls.find((call) => /insert into product_events/.test(call.sql)).params;
  assert.notStrictEqual(firstParams[2], secondParams[2]);
  assert.match(secondParams[2], /^user:a%3Asession%3Ab:/);
});

test("reserved legacy owner keeps pre-tenant event identity", async () => {
  const pool = fakePool({ returnBusinessRow: true });
  await createRelationalStore({ pool, userId: "owner", originId: "import" })
    .upsertSession({ id: "legacy-session" });
  const params = pool.calls.find((call) => /insert into product_events/.test(call.sql)).params;
  assert.strictEqual(params[2], "session:legacy-session");
  assert.strictEqual(params[12], "session:legacy-session:upserted");
  assert.match(params[9], /tenant_id/);
});

test("trusted tenant scopes row and event identities", async () => {
  const pool = fakePool({ returnBusinessRow: true });
  const store = createRelationalStore({ pool, userId: "user-a", originId: "test" });
  const result = await store.upsertSession({ id: "session-1", label: "A" });

  const insert = pool.calls.find((call) => /insert into sessions/.test(call.sql));
  assert.strictEqual(insert.params[1], "user-a");
  const eventInsert = pool.calls.find((call) => /insert into product_events/.test(call.sql));
  assert.ok(eventInsert, "expected event append");
  assert.match(JSON.stringify(eventInsert.params), /user:user-a:session:session-1/);
  assert.match(JSON.stringify(eventInsert.params), /tenant_id/);
  assert.strictEqual(result.row.user_id, "user-a");
});

function fakePool(options = {}) {
  const pool = { sql: [], calls: [] };
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).trim().toLowerCase();
      pool.sql.push(normalized);
      pool.calls.push({ sql: String(sql), params });
      if (/insert into sessions/.test(sql) && options.returnBusinessRow) {
        return { rowCount: 1, rows: [{ id: params[0], user_id: params[1], inserted: true }] };
      }
      if (/insert into product_events/.test(sql)) {
        return { rowCount: 1, rows: [{ event_id: "event-1" }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;
  return pool;
}
