#!/usr/bin/env node
"use strict";

// Smoke for the gateway message broker. It proves the broker stores messages,
// routes explicit continuation to an existing session, recommends research
// skill workflow when requested, and persists inspectable route decisions.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "message-broker-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-message-broker-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startGateway({ port, dataDir });
    await step("broker auth required", () => assertAuthRequired(baseUrl));
    const sessionId = `broker_session_${Date.now().toString(36)}`;
    await step("seed existing session", () => seedVoiceTurn(baseUrl, sessionId));
    const continuation = await step("explicit session routes to continuation", () =>
      assertContinuationRoute(baseUrl, sessionId));
    await step("research message selects skill workflow and fork", () =>
      assertResearchRoute(baseUrl));
    await step("broker event persisted", () =>
      assertBrokerLedger(dataDir, continuation.event.id));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      session_id: sessionId,
      broker_event_id: continuation.event.id,
      checks: [
        "POST /v1/broker/messages requires a token",
        "broker stores a canonical message event",
        "explicit session_id returns a continue_session decision",
        "research/report message returns a landscape-research skill decision",
        "new work message can recommend create_new_fork without cancellation",
        "broker ledger persists route reasons",
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

async function assertAuthRequired(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/broker/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  assert.equal(response.status, 401);
}

async function seedVoiceTurn(baseUrl, sessionId) {
  const response = await postJson(`${baseUrl}/v1/voice/turns`, {
    source: "message-broker-smoke",
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: "default",
    transcript: "we are working on the browser extension broker routing",
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
}

async function assertContinuationRoute(baseUrl, sessionId) {
  const response = await postJson(`${baseUrl}/v1/broker/messages`, {
    source: "message-broker-smoke",
    session_id: sessionId,
    text: "continue the browser extension broker routing session",
  });
  assert.equal(response.status, 202, JSON.stringify(response.json));
  const route = response.json.decisions.find((decision) =>
    decision.target_type === "session" &&
    decision.target_id === sessionId &&
    decision.action === "continue_session");
  assert.ok(route, `expected continue_session route, got ${JSON.stringify(response.json.decisions)}`);
  assert.equal(route.cancellation_behavior, "none");
  assert.match(route.reason, /session_id|overlaps/);
  return response.json;
}

async function assertResearchRoute(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/broker/messages`, {
    source: "message-broker-smoke",
    text: "start a new research report and search online for the most optimal path",
  });
  assert.equal(response.status, 202, JSON.stringify(response.json));
  assert.ok(
    response.json.decisions.some((decision) =>
      decision.target_type === "skill" &&
      decision.target_id === "landscape-research" &&
      decision.action === "invoke_skill_workflow"),
    `expected landscape-research skill route, got ${JSON.stringify(response.json.decisions)}`,
  );
  assert.ok(
    response.json.decisions.some((decision) => decision.action === "create_new_fork"),
    `expected create_new_fork route, got ${JSON.stringify(response.json.decisions)}`,
  );
  assert.ok(response.json.decisions.every((decision) => decision.cancellation_behavior === "none"));
}

function assertBrokerLedger(dataDir, eventId) {
  const eventPath = path.join(dataDir, "broker-events", `${eventId}.json`);
  assert.ok(fs.existsSync(eventPath), "broker event JSON missing");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  assert.equal(event.id, eventId);
  assert.ok(Array.isArray(event.decisions) && event.decisions.length > 0, "broker event must store decisions");

  const ledgerPath = path.join(dataDir, "broker-events.jsonl");
  const lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
  assert.ok(lines.some((line) => JSON.parse(line).id === eventId), "broker ledger missing event id");
}

async function startGateway({ port, dataDir }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
      MOA_GATEWAY_TOKEN: TOKEN,
      MODEL_PROVIDER: "openai-compatible",
      MODEL_ID: "message-broker-smoke-model",
      MODEL_API_KEY: "",
      OPENAI_API_KEY: "",
      GOOGLE_API_KEY: "",
      GEMINI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    if (logs.exited) throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

function collectLogs(child) {
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (output.length > 12000) output = output.slice(-12000);
  };
  const logs = { exited: false, text: () => output };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", () => {
    logs.exited = true;
  });
  return logs;
}

async function onceExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => child.kill("SIGKILL")),
  ]);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
