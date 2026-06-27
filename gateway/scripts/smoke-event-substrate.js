#!/usr/bin/env node
"use strict";

// Smoke for the product event substrate. It proves the local JSONL fallback,
// HTTP append/query endpoints, and mirrored chat/voice/tool events without
// requiring a model key or Postgres.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const { createEventSubstrateStore } = require(path.join(GATEWAY_DIR, "lib", "event-substrate"));
const TOKEN = "event-substrate-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-event-substrate-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    await step("jsonl store appends idempotently", () => assertJsonStore(dataDir));
    server = await startGateway({ port, dataDir });
    await step("events endpoints require and accept auth", () => assertEventEndpoints(baseUrl));
    await step("chat turn mirrors to product events", () => assertChatMirror(baseUrl));
    await step("voice turn mirrors accepted and completed events", () => assertVoiceMirror(baseUrl));
    await step("tool request receipt mirrors device events", () => assertToolReceiptMirror(baseUrl));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      data_dir: dataDir,
      checks: [
        "JSONL fallback appends with stream versions and idempotency",
        "HTTP /v1/events status, append, and query work",
        "chat turns mirror to chat.turn.completed",
        "voice turns mirror to voice.turn.accepted and voice.turn.completed",
        "tool request queue/claim/receipt mirrors to tool.request.* events",
      ],
    }, null, 2));
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function assertJsonStore(dataDir) {
  const store = createEventSubstrateStore({ dataDir, originId: "smoke-origin" });
  const first = await store.appendEvent({
    event_type: "smoke.created",
    stream_id: "smoke:one",
    idempotency_key: "smoke-one",
    actor: { kind: "system", id: "smoke" },
    payload: { hello: "world" },
  });
  assert.equal(first.stream_version, 1);

  const duplicate = await store.appendEvent({
    event_type: "smoke.created",
    stream_id: "smoke:one",
    idempotency_key: "smoke-one",
    actor: { kind: "system", id: "smoke" },
    payload: { hello: "again" },
  });
  assert.equal(duplicate.event_id, first.event_id, "idempotency key must return the original event");

  const second = await store.appendEvent({
    event_type: "smoke.updated",
    stream_id: "smoke:one",
    actor: { kind: "system", id: "smoke" },
    payload: {},
  });
  assert.equal(second.stream_version, 2);

  const listed = await store.listEvents({ event_type_prefix: "smoke.", order: "asc" });
  assert.equal(listed.length, 2);
  assert.equal(listed[0].event_type, "smoke.created");
  const info = await store.storageInfo();
  assert.equal(info.mode, "jsonl");
  assert.equal(info.event_count, 2);
}

async function assertEventEndpoints(baseUrl) {
  const unauthorized = await fetch(`${baseUrl}/v1/events/status`);
  assert.equal(unauthorized.status, 401);

  const status = await getJson(`${baseUrl}/v1/events/status`);
  assert.equal(status.status, 200, JSON.stringify(status.json));
  assert.equal(status.json.event_substrate.mode, "jsonl");

  const created = await postJson(`${baseUrl}/v1/events`, {
    event_type: "smoke.http",
    stream_id: "smoke:http",
    idempotency_key: "smoke-http",
    actor: { kind: "system", id: "smoke" },
    payload: { ok: true },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.event.event_type, "smoke.http");

  const duplicate = await postJson(`${baseUrl}/v1/events`, {
    event_type: "smoke.http",
    stream_id: "smoke:http",
    idempotency_key: "smoke-http",
    actor: { kind: "system", id: "smoke" },
    payload: { ok: "duplicate" },
  });
  assert.equal(duplicate.status, 201, JSON.stringify(duplicate.json));
  assert.equal(duplicate.json.event.event_id, created.json.event.event_id);

  const query = await getJson(`${baseUrl}/v1/events?event_type_prefix=smoke.&order=asc`);
  assert.equal(query.status, 200, JSON.stringify(query.json));
  assert.ok(query.json.events.some((event) => event.event_type === "smoke.http"));
}

async function assertChatMirror(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/chat`, {
    conversation_id: "event_smoke_chat",
    session_id: "event_smoke",
    branch_id: "default",
    turn_id: "chat_turn_1",
    source: "event-substrate-smoke",
    messages: [{ role: "user", content: "what time is it" }],
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));

  const events = await getJson(`${baseUrl}/v1/events?event_type=chat.turn.completed&stream_id=session:event_smoke`);
  assert.equal(events.status, 200, JSON.stringify(events.json));
  const event = events.json.events.find((candidate) => candidate.payload.turn_id === "chat_turn_1");
  assert.ok(event, "chat turn event must be queryable");
  assert.equal(event.payload.session_id, "event_smoke");
}

async function assertVoiceMirror(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "event_smoke",
    branch_id: "default",
    turn_id: "voice_turn_1",
    source: "event-substrate-smoke",
    transcript: "what time is it",
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));

  const events = await getJson(`${baseUrl}/v1/events?event_type_prefix=voice.turn.&stream_id=session:event_smoke&order=asc`);
  assert.equal(events.status, 200, JSON.stringify(events.json));
  const types = events.json.events
    .filter((event) => event.payload.turn_id === "voice_turn_1")
    .map((event) => event.event_type);
  assert.ok(types.includes("voice.turn.accepted"), `missing accepted event; saw ${types.join(",")}`);
  assert.ok(types.includes("voice.turn.completed"), `missing completed event; saw ${types.join(",")}`);
}

async function assertToolReceiptMirror(baseUrl) {
  await postJson(`${baseUrl}/v1/device-clients/heartbeat`, {
    device_id: "android_event_smoke",
    surface_type: "android",
    session_id: "event_smoke",
    local_tool_manifest: [
      { tool: "audio.speak", risk: "local_output", approval: "implicit_user_command" },
    ],
  });

  const queued = await postJson(`${baseUrl}/v1/tool/requests`, {
    source: "event-substrate-smoke",
    target_surface_type: "android",
    tool: "audio.speak",
    input: { text: "hello" },
    session_id: "event_smoke",
  });
  assert.equal(queued.status, 202, JSON.stringify(queued.json));
  const requestId = queued.json.request.id;

  const claimed = await postJson(`${baseUrl}/v1/tool/requests/claim`, {
    device_id: "android_event_smoke",
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.json));
  assert.equal(claimed.json.request.id, requestId);

  const receipt = await postJson(`${baseUrl}/v1/tool/requests/${requestId}/receipts`, {
    device_id: "android_event_smoke",
    ok: true,
    summary: "spoke locally",
    local_receipt: { tool: "audio.speak", ok: true },
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.json));

  const events = await getJson(`${baseUrl}/v1/events?event_type_prefix=tool.request.&stream_id=session:event_smoke`);
  assert.equal(events.status, 200, JSON.stringify(events.json));
  const types = events.json.events
    .filter((event) => event.payload.request?.id === requestId)
    .map((event) => event.event_type);
  assert.ok(types.includes("tool.request.queued"), `missing queued event; saw ${types.join(",")}`);
  assert.ok(types.includes("tool.request.claimed"), `missing claimed event; saw ${types.join(",")}`);
  assert.ok(types.includes("tool.request.receipt"), `missing receipt event; saw ${types.join(",")}`);
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text.trim() ? JSON.parse(text) : {},
  };
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text.trim() ? JSON.parse(text) : {},
  };
}

async function startGateway({ port, dataDir }) {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      MOA_GATEWAY_TOKEN: TOKEN,
      MODEL_PROVIDER: "openai-compatible",
      MODEL_API_KEY: "",
      VOICE_PROVIDER: "loopback",
      VOICE_STT_PROVIDER: "loopback",
      VOICE_LLM_PROVIDER: "loopback",
      VOICE_TTS_PROVIDER: "loopback",
      ALLOW_AGENT_WITHOUT_TOKEN: "0",
      DATABASE_URL: "",
      MOA_ORIGIN_ID: "event-smoke-gateway",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const baseUrl = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (server.exitCode != null) {
      throw new Error(`gateway exited with ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return server;
    } catch {
      // Keep waiting.
    }
    await delay(100);
  }
  throw new Error("gateway did not start");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function onceExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once("exit", finish);
    setTimeout(finish, timeoutMs).unref();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
