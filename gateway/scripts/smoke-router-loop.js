#!/usr/bin/env node
"use strict";

// Smoke for the router activation loop: a model/router POSTs an intent, the
// gateway LAUNCHES a disposable task agent (an agent run on the existing store)
// and returns a run id immediately, the caller polls status to completion, and
// the completion PING carries a result summary of what the agent did.
//
// Boots `node server.js` directly on a throwaway port + token + DATA_DIR so the
// real .env is never loaded. Uses the deterministic `echo` harness, so no model
// key is required.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "router-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-router-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startGateway({ port, dataDir });

    await step("auth required", () => assertAuthRequired(baseUrl));
    await step("echo harness available", () => assertEchoHarnessAvailable(baseUrl));
    const runId = await step("activate -> status -> ping", () => assertActivationLoop(baseUrl, dataDir));
    await step("missing intent rejected", () => assertMissingIntentRejected(baseUrl));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      activation_run_id: runId,
      checks: [
        "auth required on router endpoints",
        "deterministic echo harness available (no model key)",
        "POST /v1/router/activate returns run id immediately (202)",
        "GET status walks queued/running -> completed",
        "completion ping carries timestamp + result summary",
        "missing intent rejected (400)",
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
  const activate = await postJson(`${baseUrl}/v1/router/activate`, { intent: "hello" }, { auth: false });
  assert.equal(activate.status, 401, "router activate must require a token");

  const status = await requestJson(`${baseUrl}/v1/router/activations/run_does_not_exist`, { auth: false });
  assert.equal(status.status, 401, "router status must require a token");
}

async function assertEchoHarnessAvailable(baseUrl) {
  const health = await getJson(`${baseUrl}/health`);
  const echo = (health.agent_loop.harnesses || []).find((h) => h.name === "echo");
  assert.ok(echo, "echo harness must be registered");
  assert.equal(echo.available, true, "echo harness must be available with no model key");
}

async function assertActivationLoop(baseUrl, dataDir) {
  const started = Date.now();
  const intent = "summarize my unread email and draft a reply";
  const activate = await postJson(`${baseUrl}/v1/router/activate`, {
    intent,
    source: "router-smoke",
    conversation_id: "router_smoke_session",
  });
  const elapsedMs = Date.now() - started;

  // The router does not block on the harness; it returns a run id immediately.
  assert.equal(activate.status, 202, "activate must return 202 immediately");
  assert.ok(elapsedMs < 1500, `activate was too slow (blocking?): ${elapsedMs}ms`);
  const runId = activate.json.run_id;
  assert.ok(runId && runId.startsWith("run_"), "activate must return a run id");
  assert.equal(activate.json.activation_id, runId);
  assert.equal(activate.json.status_url, `/v1/router/activations/${runId}`);
  // The router routes; it does not speak. No answer field on the activation.
  assert.equal(activate.json.text, undefined, "router must not speak an answer");

  // Lifecycle is observable by run id.
  const detail = await waitForTerminalPing(baseUrl, runId);
  assert.equal(detail.status, "completed", `expected completed, got ${detail.status}`);

  // The completion ping carries a timestamp + a short result summary of what the
  // agent did.
  const ping = detail.ping;
  assert.ok(ping, "completion ping must be present");
  assert.equal(ping.type, "router_ping");
  assert.equal(ping.ok, true, "ping must report ok for a completed run");
  assert.equal(ping.run_status, "completed");
  assert.ok(ping.finished_at, "ping must carry a finished_at timestamp");
  assert.ok(!Number.isNaN(Date.parse(ping.finished_at)), "ping finished_at must be a valid timestamp");
  assert.ok(typeof ping.summary === "string" && ping.summary.length > 0, "ping must carry a result summary");
  assert.match(ping.summary, /completed|task agent/i, `summary should describe what the agent did: ${ping.summary}`);

  // Durable: the run + events persisted to DATA_DIR, including the ping.
  const eventPath = path.join(dataDir, "agent-runs", `${runId}.events.jsonl`);
  assert.ok(fs.existsSync(eventPath), "event log must be persisted");
  const eventTypes = fs.readFileSync(eventPath, "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line).type);
  assert.ok(eventTypes.includes("router_activated"), "router_activated event must be persisted");
  assert.ok(eventTypes.includes("queued"), "queued event must be persisted");
  assert.ok(eventTypes.includes("router_ping"), "router_ping event must be persisted");

  return runId;
}

async function assertMissingIntentRejected(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/router/activate`, { source: "router-smoke" });
  assert.equal(response.status, 400, "missing intent must be rejected");
  assert.match(String(response.json.error || ""), /intent/i);
}

async function waitForTerminalPing(baseUrl, runId) {
  const terminal = new Set(["completed", "failed", "timed-out", "canceled"]);
  const deadline = Date.now() + 8000;
  let last;
  while (Date.now() < deadline) {
    last = await getJson(`${baseUrl}/v1/router/activations/${runId}`);
    if (terminal.has(last.status) && last.ping) {
      return last;
    }
    await sleep(100);
  }
  throw new Error(`activation ${runId} did not finish with a ping; last=${JSON.stringify(last)}`);
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
  // A minimal, secret-free env. Notably NO model/provider keys -- the loop must
  // run on the deterministic echo harness alone.
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
    MOA_GATEWAY_TOKEN: TOKEN,
    ROUTER_DEFAULT_HARNESS: "echo",
    DEFAULT_AGENT_HARNESS: "echo",
    MODEL_PROVIDER: "openai-compatible",
    MODEL_ID: "router-smoke-model",
    MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GEMINI_API_KEY: "",
    AGENT_RUN_TIMEOUT_MS: "5000",
    HARNESS_STATUS_TIMEOUT_MS: "200",
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
