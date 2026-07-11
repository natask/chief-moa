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
  const firstParams = productEventParams(firstPool);
  const secondParams = productEventParams(secondPool);
  assert.notStrictEqual(firstParams[2], secondParams[2]);
  assert.match(firstParams[2], /^tenant:v1:stream:[a-f0-9]{64}:session:h:[a-f0-9]{64}$/);
  assert.match(secondParams[2], /^tenant:v1:stream:[a-f0-9]{64}:session:h:[a-f0-9]{64}$/);
  assert.match(secondParams[12], /^tenant:v1:idempotency:[a-f0-9]{64}:session:h:[a-f0-9]{64}$/);
});

test("tenant event namespace uses the full trusted user id for hostile long ids", async () => {
  const firstPool = fakePool({ returnBusinessRow: true });
  const secondPool = fakePool({ returnBusinessRow: true });
  const firstUserId = `u${"a".repeat(198)}x`;
  const secondUserId = `u${"a".repeat(198)}y`;
  const sessionId = `session-${"s".repeat(220)}`;
  await createRelationalStore({ pool: firstPool, userId: firstUserId, originId: "test" })
    .upsertSession({ id: sessionId });
  await createRelationalStore({ pool: secondPool, userId: secondUserId, originId: "test" })
    .upsertSession({ id: sessionId });
  const firstParams = productEventParams(firstPool);
  const secondParams = productEventParams(secondPool);
  assert.notStrictEqual(firstParams[2], secondParams[2]);
  assert.notStrictEqual(firstParams[12], secondParams[12]);
  assert.ok(firstParams[2].length <= 240);
  assert.ok(firstParams[12].length <= 240);
  assert.ok(secondParams[2].length <= 240);
  assert.ok(secondParams[12].length <= 240);
});

test("derived identifiers cannot alias a caller-supplied digest-shaped id", async () => {
  const userId = `u${"x".repeat(199)}`;
  const longPool = fakePool({ returnBusinessRow: true });
  await createRelationalStore({ pool: longPool, userId, originId: "test" })
    .upsertSession({ id: `session-${"a".repeat(220)}` });
  const derived = productEventParams(longPool)[2];
  const forgedId = derived.slice(derived.indexOf(":session:h:") + ":session:".length);
  const forgedPool = fakePool({ returnBusinessRow: true });
  await createRelationalStore({ pool: forgedPool, userId, originId: "test" })
    .upsertSession({ id: forgedId });
  assert.notStrictEqual(productEventParams(forgedPool)[2], derived);
});

test("hostile long ids preserve session stream sharing and distinct event identities", async () => {
  const pool = fakePool({ returnBusinessRow: true });
  const store = createRelationalStore({
    pool,
    userId: `u${"x".repeat(199)}`,
    originId: "test",
  });
  const sessionId = `session-${"s".repeat(220)}`;
  const branchId = `branch-${"b".repeat(220)}`;
  const chatTurnId = `turn-${"t".repeat(220)}`;
  const voiceTurnId = `voice-${"v".repeat(220)}`;
  const runId = `run-${"r".repeat(220)}`;
  const taskId = `task-${"k".repeat(220)}`;
  const requestId = `request-${"q".repeat(220)}`;

  await store.upsertSession({ id: sessionId });
  await store.upsertBranch({ session_id: sessionId, branch_id: branchId });
  await store.upsertChatTurn({ id: chatTurnId, session_id: sessionId });
  await store.upsertVoiceTurn({ id: voiceTurnId, session_id: sessionId });
  await store.upsertAgentRun({ id: runId });
  await store.upsertBrowserTask({ id: taskId });
  await store.upsertToolRequest({ id: requestId });

  const [sessionEvent, branchEvent, chatEvent, voiceEvent, runEvent, taskEvent, requestEvent] = productEventCalls(pool);
  assert.strictEqual(sessionEvent.params[2], branchEvent.params[2]);
  assert.strictEqual(sessionEvent.params[2], chatEvent.params[2]);
  assert.strictEqual(sessionEvent.params[2], voiceEvent.params[2]);
  assert.notStrictEqual(sessionEvent.params[2], runEvent.params[2]);
  assert.notStrictEqual(runEvent.params[2], taskEvent.params[2]);
  assert.notStrictEqual(taskEvent.params[2], requestEvent.params[2]);

  const idempotencyKeys = [
    sessionEvent.params[12],
    branchEvent.params[12],
    chatEvent.params[12],
    voiceEvent.params[12],
    runEvent.params[12],
    taskEvent.params[12],
    requestEvent.params[12],
  ];
  assert.strictEqual(new Set(idempotencyKeys).size, idempotencyKeys.length);
  for (const key of [sessionEvent.params[2], ...idempotencyKeys, runEvent.params[2], taskEvent.params[2], requestEvent.params[2]]) {
    assert.ok(key.length <= 240, `expected bounded event identifier, got ${key.length}`);
  }
});

test("reserved legacy owner keeps pre-tenant event identity", async () => {
  const pool = fakePool({ returnBusinessRow: true });
  await createRelationalStore({ pool, userId: "owner", originId: "import" })
    .upsertSession({ id: "legacy-session" });
  const params = productEventParams(pool);
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
  const eventInsert = productEventCalls(pool)[0];
  assert.ok(eventInsert, "expected event append");
  assert.match(eventInsert.params[2], /^tenant:v1:stream:[a-f0-9]{64}:session:h:[a-f0-9]{64}$/);
  assert.match(eventInsert.params[12], /^tenant:v1:idempotency:[a-f0-9]{64}:session:h:[a-f0-9]{64}$/);
  assert.match(JSON.stringify(eventInsert.params), /tenant_id/);
  assert.strictEqual(result.row.user_id, "user-a");
});

function productEventCalls(pool) {
  return pool.calls.filter((call) => /insert into product_events/.test(call.sql));
}

function productEventParams(pool) {
  return productEventCalls(pool)[0]?.params || null;
}

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
      if (/insert into branches/.test(sql) && options.returnBusinessRow) {
        return { rowCount: 1, rows: [{ session_id: params[0], branch_id: params[1], user_id: params[2], inserted: true }] };
      }
      if (/insert into turns/.test(sql) && options.returnBusinessRow) {
        return { rowCount: 1, rows: [{ id: params[0], user_id: params[1], inserted: true }] };
      }
      if (/insert into voice_turns/.test(sql) && options.returnBusinessRow) {
        return { rowCount: 1, rows: [{ id: params[0], user_id: params[1], inserted: true }] };
      }
      if (/insert into agent_runs/.test(sql) && options.returnBusinessRow) {
        return { rowCount: 1, rows: [{ id: params[0], user_id: params[1], inserted: true }] };
      }
      if (/insert into browser_tasks/.test(sql) && options.returnBusinessRow) {
        return { rowCount: 1, rows: [{ id: params[0], user_id: params[1], inserted: true }] };
      }
      if (/insert into tool_requests/.test(sql) && options.returnBusinessRow) {
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
