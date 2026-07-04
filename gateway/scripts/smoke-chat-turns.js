#!/usr/bin/env node
"use strict";

// Smoke for:
//  1. GET /v1/sessions/:id/chat-turns — paged typed-chat history. Posts two
//     chat turns under the same session id and reads them back.
//  2. GET /v1/voice/audio/:turn_id — voice audio serving. Posts a voice turn
//     (which writes no actual PCM in the HTTP path), then verifies the
//     endpoint returns a 404 with the correct shape rather than a 500, and
//     that the auth guard works.
//
// Boots `node server.js` on a throwaway port + token + DATA_DIR. No model
// provider is configured, so the gateway's deterministic fallback reply is used.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "chat-turns-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-chat-turns-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startGateway({ port, dataDir });

    await step("chat-turns auth required", () => assertChatTurnsAuthRequired(baseUrl));
    const sessionId = `chat_smoke_${Date.now().toString(36)}`;
    await step("chat turns persist + reload in order", () => assertChatTurnHistory(baseUrl, sessionId));
    await step("unknown session returns empty list", () => assertEmptyChatHistory(baseUrl, sessionId));
    await step("voice audio auth required", () => assertAudioAuthRequired(baseUrl));
    await step("voice audio 404 shape", () => assertAudioNotFound(baseUrl));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      session_id: sessionId,
      checks: [
        "GET /v1/sessions/:id/chat-turns requires a token",
        "two chat turns under one session id both persist and reload in order",
        "unknown session returns empty turn list",
        "GET /v1/voice/audio/:turn_id requires a token",
        "GET /v1/voice/audio/:turn_id for missing turn returns 404 JSON (not 500)",
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

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

async function assertChatTurnsAuthRequired(baseUrl) {
  const unauth = await requestRaw(`${baseUrl}/v1/sessions/whatever/chat-turns`, { auth: false });
  assert.equal(unauth.status, 401, "chat-turns must require a token");
}

async function assertChatTurnHistory(baseUrl, sessionId) {
  // Use /v1/chat to create two typed-chat turns under the same session.
  const first = await postJson(`${baseUrl}/v1/chat`, {
    session_id: sessionId,
    conversation_id: sessionId,
    source: "chat-turns-smoke",
    messages: [{ role: "user", content: "hello from chat smoke test" }],
  });
  assert.equal(first.status, 200, `first chat turn must succeed: ${JSON.stringify(first.json)}`);
  assert.ok(first.json.conversation_id, "response must include conversation_id");

  await sleep(15); // ensure distinct created_at

  const second = await postJson(`${baseUrl}/v1/chat`, {
    session_id: sessionId,
    conversation_id: sessionId,
    source: "chat-turns-smoke",
    messages: [{ role: "user", content: "second chat turn for smoke" }],
  });
  assert.equal(second.status, 200, `second chat turn must succeed: ${JSON.stringify(second.json)}`);

  const history = await getJson(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/chat-turns`);
  assert.equal(history.session_id, sessionId, "history must echo the session id");
  assert.ok(Array.isArray(history.turns), "history.turns must be an array");
  assert.equal(history.turns.length, 2, `expected 2 turns, got ${history.turns.length}: ${JSON.stringify(history.turns)}`);
  assert.ok(typeof history.total === "number", "history.total must be a number");
  assert.ok(typeof history.limit === "number", "history.limit must be a number");

  const [a, b] = history.turns;
  assert.ok(String(a.response_text || "").length > 0, "first turn must carry a response_text");
  assert.ok(String(b.response_text || "").length > 0, "second turn must carry a response_text");
  // Chronological order: oldest first.
  assert.ok(
    String(a.created_at) <= String(b.created_at),
    `turns must be in chronological order: ${a.created_at} <= ${b.created_at}`
  );
}

async function assertEmptyChatHistory(baseUrl, usedSessionId) {
  const otherId = `${usedSessionId}_other`;
  const history = await getJson(`${baseUrl}/v1/sessions/${encodeURIComponent(otherId)}/chat-turns`);
  assert.ok(Array.isArray(history.turns), "turns must be an array for unknown session");
  assert.equal(history.turns.length, 0, "unknown session must return 0 turns");
  assert.equal(history.total, 0, "total must be 0 for unknown session");
}

async function assertAudioAuthRequired(baseUrl) {
  const unauth = await requestRaw(`${baseUrl}/v1/voice/audio/some-turn-id`, { auth: false });
  assert.equal(unauth.status, 401, "voice audio must require a token");
}

async function assertAudioNotFound(baseUrl) {
  // A syntactically valid turn_id that does not correspond to any stored turn.
  const fakeTurnId = `turn_nonexistent_${Date.now().toString(36)}`;
  const result = await requestRaw(`${baseUrl}/v1/voice/audio/${fakeTurnId}`);
  assert.equal(result.status, 404, `missing turn audio must return 404, got ${result.status}`);
  let body;
  try {
    body = JSON.parse(result.text);
  } catch {
    throw new Error(`audio 404 must return JSON, got: ${result.text.slice(0, 200)}`);
  }
  assert.ok(body.error, "404 response must include an error field");
}

async function startGateway({ port, dataDir }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: gatewayEnv({ port, dataDir }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

function gatewayEnv({ port, dataDir }) {
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
    MOA_GATEWAY_TOKEN: TOKEN,
    MODEL_PROVIDER: "openai-compatible",
    MODEL_ID: "chat-turns-smoke-model",
    MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GEMINI_API_KEY: "",
  };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Server may still be starting.
    }
    if (logs.exited) {
      throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

async function getJson(url, options = {}) {
  const response = await requestRaw(url, options);
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${response.text}`);
  return JSON.parse(response.text);
}

async function requestRaw(url, options = {}) {
  const response = await fetch(url, { headers: options.auth === false ? {} : authHeaders() });
  const text = await response.text();
  return { status: response.status, text };
}

async function postJson(url, body, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...(options.auth === false ? {} : authHeaders()),
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function collectLogs(child) {
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (output.length > 12000) output = output.slice(-12000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", () => {
    logs.exited = true;
  });
  const logs = {
    exited: false,
    text: () => output,
  };
  return logs;
}

async function onceExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
