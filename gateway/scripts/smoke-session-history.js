#!/usr/bin/env node
"use strict";

// Smoke for chat-history persistence: a client POSTs several conversational
// voice turns under the SAME session id, then reads that session's ordered
// turns back via GET /v1/sessions/:id/turns. This is what lets the overlay
// reload prior turns across reopens instead of starting empty.
//
// Boots `node server.js` directly on a throwaway port + token + DATA_DIR so the
// real .env is never loaded. No model provider is configured, so the gateway's
// deterministic fallback reply stands in for a model answer (no key required).

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "session-history-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-session-history-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startGateway({ port, dataDir });

    await step("auth required", () => assertAuthRequired(baseUrl));
    const sessionId = `agee_smoke_${Date.now().toString(36)}`;
    await step("turns persist + reload in order", () => assertSessionHistory(baseUrl, sessionId));
    await step("unknown session is empty", () => assertEmptySession(baseUrl, sessionId));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      session_id: sessionId,
      checks: [
        "GET /v1/sessions/:id/turns requires a token",
        "two voice turns under one session id both persist",
        "history reloads in chronological order with transcript + reply",
        "a different session id returns 0 turns",
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

async function assertAuthRequired(baseUrl) {
  const unauth = await requestJson(`${baseUrl}/v1/sessions/whatever/turns`, { auth: false });
  assert.equal(unauth.status, 401, "session turns must require a token");
}

async function assertSessionHistory(baseUrl, sessionId) {
  // Two simple conversational lines: neither is an action verb, so each
  // classifies as "chat" and the gateway produces (and stores) a reply.
  const first = await postJson(`${baseUrl}/v1/voice/turns`, {
    source: "session-history-smoke",
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: "cue-1",
    transcript: "hello there gateway",
  });
  assert.equal(first.status, 200, `first turn must succeed: ${JSON.stringify(first.json)}`);
  assert.equal(first.json.classification, "chat", "first turn must classify as chat");
  assert.ok(String(first.json.display || "").length > 0, "first turn must carry a reply");

  // Ensure a distinct created_at so chronological ordering is observable.
  await sleep(15);

  const second = await postJson(`${baseUrl}/v1/voice/turns`, {
    source: "session-history-smoke",
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: "cue-2",
    transcript: "tell me about voice capture",
  });
  assert.equal(second.status, 200, `second turn must succeed: ${JSON.stringify(second.json)}`);
  assert.equal(second.json.classification, "chat", "second turn must classify as chat");

  const history = await getJson(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/turns`);
  assert.equal(history.session_id, sessionId, "history must echo the session id");
  assert.ok(Array.isArray(history.turns), "history.turns must be an array");
  assert.equal(history.turns.length, 2, `expected 2 turns, got ${history.turns.length}`);

  const [a, b] = history.turns;
  assert.equal(a.transcript, "hello there gateway", "first turn transcript must round-trip");
  assert.ok(String(a.reply || "").length > 0, "first turn must carry a stored reply");
  assert.equal(b.transcript, "tell me about voice capture", "second turn transcript must round-trip");
  assert.ok(String(b.reply || "").length > 0, "second turn must carry a stored reply");

  // Chronological order: oldest first.
  assert.ok(
    String(a.created_at) <= String(b.created_at),
    `turns must be in chronological order: ${a.created_at} <= ${b.created_at}`
  );
}

async function assertEmptySession(baseUrl, usedSessionId) {
  const otherId = `${usedSessionId}_other`;
  const history = await getJson(`${baseUrl}/v1/sessions/${encodeURIComponent(otherId)}/turns`);
  assert.ok(Array.isArray(history.turns), "history.turns must be an array");
  assert.equal(history.turns.length, 0, "a fresh session id must return 0 turns");
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
  // Secret-free env with NO model/provider key: the conversational turn falls
  // back to the gateway's deterministic reply, so no model access is needed.
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
    MODEL_ID: "session-history-smoke-model",
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
    } catch (error) {
      // Server may still be starting.
    }
    if (logs.exited) {
      throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

async function getJson(url, options) {
  const response = await requestJson(url, options);
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { headers: options.auth === false ? {} : authHeaders() });
  const json = await response.json();
  return { status: response.status, json };
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
