"use strict";

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, describe, test } = require("node:test");
const { Pool } = require("pg");

const { createRelationalStore } = require("../../lib/relational-store");
const { hasDatabaseUrl } = require("../smoke-manifest");
const { createIsolatedDatabase, dropIsolatedDatabase } = require("./isolated-db");

const gatewayRoot = path.resolve(__dirname, "../..");
// Populated per run with the isolated database URL so migrate + Pool + store all
// target the same fresh database and never race the other integration file.
let env = { ...process.env };

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

function runImporter(dataDir) {
  const result = spawnSync(
    process.execPath,
    ["scripts/import-datadir.js", `--data-dir=${dataDir}`],
    {
      cwd: gatewayRoot,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }
  );

  assert.strictEqual(
    result.status,
    0,
    [
      `import-datadir exited with status ${result.status}`,
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n")
  );
  return JSON.parse(result.stdout);
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

describe("relational store DATA_DIR import", { skip: !hasDatabaseUrl() }, () => {
  let pool;
  let isolatedDbName;
  const tempDirs = [];

  after(async () => {
    if (pool) {
      await pool.end();
    }
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await dropIsolatedDatabase(isolatedDbName);
  });

  test("imports rows and product events idempotently", async () => {
    const isolated = await createIsolatedDatabase("relstore");
    isolatedDbName = isolated.dbName;
    env = { ...process.env, DATABASE_URL: isolated.databaseUrl };
    assertMigrateSucceeded(runMigrateUp());

    pool = new Pool({ connectionString: isolated.databaseUrl });
    const prefix = `relstore_${Date.now().toString(36)}_${process.pid}`;
    const fixture = writeFixture(prefix);
    tempDirs.push(fixture.root);

    const first = runImporter(fixture.dataDir);
    assert.deepStrictEqual(first.conversations, { files: 2, rows: 2, events: 2 });
    assert.deepStrictEqual(first.voice_turns, { files: 1, rows: 1, events: 1 });
    assert.deepStrictEqual(first.agent_runs, { files: 1, rows: 1, events: 1 });
    assert.deepStrictEqual(first.browser_tasks, { files: 0, rows: 0, events: 0 });
    assert.deepStrictEqual(first.tool_requests, { files: 0, rows: 0, events: 0 });

    await assertImportedCounts(pool, fixture);

    const beforeEvents = await eventCount(pool, fixture.eventKeys);
    const second = runImporter(fixture.dataDir);
    assert.deepStrictEqual(second.conversations, { files: 2, rows: 0, events: 0 });
    assert.deepStrictEqual(second.voice_turns, { files: 1, rows: 0, events: 0 });
    assert.deepStrictEqual(second.agent_runs, { files: 1, rows: 0, events: 0 });
    assert.strictEqual(await eventCount(pool, fixture.eventKeys), beforeEvents);
    await assertImportedCounts(pool, fixture);

    await assertBusinessFailureRollsBackEvent(pool, prefix);
  });
});

function writeFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-relational-import-"));
  const dataDir = path.join(root, "data");
  const conversationsDir = path.join(dataDir, "conversations");
  const voiceTurnsDir = path.join(dataDir, "voice-turns");
  const agentRunsDir = path.join(dataDir, "agent-runs");
  fs.mkdirSync(conversationsDir, { recursive: true });
  fs.mkdirSync(voiceTurnsDir, { recursive: true });
  fs.mkdirSync(agentRunsDir, { recursive: true });

  const sessionId = `${prefix}_session`;
  const chatIds = [`${prefix}_chat_1`, `${prefix}_chat_2`];
  const voiceId = `${prefix}_voice_1`;
  const runId = `${prefix}_run_1`;
  const now = new Date().toISOString();

  writeJson(path.join(conversationsDir, `${chatIds[0]}.json`), {
    id: `${prefix}_conversation_1`,
    session_id: sessionId,
    branch_id: "default",
    turn_id: chatIds[0],
    source: "integration-test",
    model: "test-model",
    profile_version: "pv-1",
    updated_at: now,
    messages: [
      { role: "user", content: "hello from the importer" },
      { role: "assistant", content: "hello back" },
    ],
  });
  writeJson(path.join(conversationsDir, `${chatIds[1]}.json`), {
    id: `${prefix}_conversation_2`,
    session_id: sessionId,
    branch_id: "default",
    turn_id: chatIds[1],
    source: "integration-test",
    model: "test-model",
    profile_version: "pv-1",
    updated_at: now,
    request_messages: [{ role: "user", content: "second imported turn" }],
    response_text: "second imported response",
  });
  writeJson(path.join(voiceTurnsDir, `${voiceId}.json`), {
    id: voiceId,
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: "default",
    profile_version: "pv-1",
    classification: "chat",
    source: "integration-test",
    transcript: "voice import transcript",
    response: {
      display: "voice import response",
      speak: "voice import response",
      actions: [],
    },
    references: {
      agent_run_ids: [runId],
    },
    created_at: now,
    updated_at: now,
  });
  writeJson(path.join(agentRunsDir, `${runId}.json`), {
    id: runId,
    status: "completed",
    harness: "echo",
    conversation_id: sessionId,
    branch_id: "default",
    prompt: "import an agent run",
    output: "agent run imported",
    created_at: now,
    updated_at: now,
    finished_at: now,
  });

  return {
    root,
    dataDir,
    sessionId,
    chatIds,
    voiceId,
    runId,
    eventKeys: [
      `chat:${sessionId}:${chatIds[0]}:completed`,
      `chat:${sessionId}:${chatIds[1]}:completed`,
      `voice:${sessionId}:${voiceId}:completed`,
      `agent-run:${runId}:import:completed`,
    ],
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

async function assertImportedCounts(pool, fixture) {
  assert.strictEqual(await rowCount(pool, "turns", fixture.chatIds), 2);
  assert.strictEqual(await rowCount(pool, "voice_turns", [fixture.voiceId]), 1);
  assert.strictEqual(await rowCount(pool, "agent_runs", [fixture.runId]), 1);
  assert.strictEqual(await eventCount(pool, fixture.eventKeys), 4);
}

async function rowCount(pool, tableName, ids) {
  assert.ok(["turns", "voice_turns", "agent_runs"].includes(tableName));
  const result = await pool.query(
    `select count(*)::int as count from ${tableName} where id = any($1::text[])`,
    [ids]
  );
  return Number(result.rows[0]?.count || 0);
}

async function eventCount(pool, idempotencyKeys) {
  const result = await pool.query(
    "select count(*)::int as count from product_events where idempotency_key = any($1::text[])",
    [idempotencyKeys]
  );
  return Number(result.rows[0]?.count || 0);
}

async function assertBusinessFailureRollsBackEvent(pool, prefix) {
  const store = createRelationalStore({ pool, originId: "relational-store-test" });
  const badSessionId = `${prefix}_bad_session`;
  const badTurnId = `${prefix}_bad_turn`;
  const missingUserId = `${prefix}_missing_user`;
  await assert.rejects(
    () => store.upsertChatTurn({
      id: badTurnId,
      session_id: badSessionId,
      turn_id: badTurnId,
      user_id: missingUserId,
      messages: [
        { role: "user", content: "this row should fail" },
        { role: "assistant", content: "no event should survive" },
      ],
    }),
    /foreign key constraint|violates/
  );

  assert.strictEqual(await rowCount(pool, "turns", [badTurnId]), 0);
  assert.strictEqual(await eventCount(pool, [`chat:${badSessionId}:${badTurnId}:completed`]), 0);
}
