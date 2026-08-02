#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "reminder-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-reminder-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  try {
    server = await startGateway({ port, dataDir });
    await assertAuthRequired(baseUrl);
    const scheduled = await createReminder(baseUrl, {
      message: "Check the oven",
      delay_seconds: 3600,
      idempotency_key: "oven-once",
      source: { surface: "android", session_id: "reminder-smoke" },
    });
    assert.equal(scheduled.status, "scheduled");
    assert.equal(scheduled.delivery.status, "not_configured");

    const retry = await createReminder(baseUrl, {
      message: "Check the oven",
      delay_seconds: 3600,
      idempotency_key: "oven-once",
    });
    assert.equal(retry.id, scheduled.id, "idempotent creation must reuse the durable reminder");
    const collision = await postJson(`${baseUrl}/v1/reminders`, {
      message: "A different reminder",
      delay_seconds: 3600,
      idempotency_key: "oven-once",
    });
    assert.equal(collision.status, 409, JSON.stringify(collision.json));

    const dueAfterRestart = await createReminder(baseUrl, {
      message: "Restart-safe deadline",
      delay_seconds: 0.15,
    });
    await assertExternalAppRejected(baseUrl);
    await stopGateway(server);
    server = null;
    await delay(250);
    server = await startGateway({ port, dataDir });

    const due = await getJson(`${baseUrl}/v1/reminders/${dueAfterRestart.id}`);
    assert.equal(due.status, 200, JSON.stringify(due.json));
    assert.equal(due.json.reminder.status, "due");
    assert.equal(due.json.reminder.delivery.status, "not_configured");
    assert.ok(due.json.reminder.became_due_at);

    const canceled = await postJson(`${baseUrl}/v1/reminders/${scheduled.id}/cancel`, {});
    assert.equal(canceled.status, 200, JSON.stringify(canceled.json));
    assert.equal(canceled.json.reminder.status, "canceled");
    const canceledAgain = await postJson(`${baseUrl}/v1/reminders/${scheduled.id}/cancel`, {});
    assert.equal(canceledAgain.status, 200, JSON.stringify(canceledAgain.json));
    assert.equal(canceledAgain.json.reminder.canceled_at, canceled.json.reminder.canceled_at);

    const list = await getJson(`${baseUrl}/v1/reminders?status=due`);
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.deepEqual(list.json.reminders.map((item) => item.id), [dueAfterRestart.id]);

    console.log(JSON.stringify({
      ok: true,
      checks: [
        "reminder routes require gateway authentication",
        "create is durable and idempotent",
        "idempotency key reuse with changed intent fails closed",
        "due state materializes after a gateway restart",
        "delivery remains explicitly not configured",
        "cancel is durable and idempotent",
        "named external timer apps are rejected as a separate local action",
      ],
    }, null, 2));
  } finally {
    if (server) await stopGateway(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function assertAuthRequired(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/reminders`);
  assert.equal(response.status, 401);
}

async function assertExternalAppRejected(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/reminders`, {
    message: "Use Clock to count down",
    delay_seconds: 60,
    timer_app: "Clock",
  });
  assert.equal(response.status, 400, JSON.stringify(response.json));
  assert.match(response.json.error, /separate explicit device-local action/);
}

async function createReminder(baseUrl, body) {
  const response = await postJson(`${baseUrl}/v1/reminders`, body);
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.reminder;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return responsePayload(response);
}

async function getJson(url) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  return responsePayload(response);
}

async function responsePayload(response) {
  const body = await response.text();
  return { status: response.status, json: body.trim() ? JSON.parse(body) : {} };
}

async function startGateway({ port, dataDir }) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      MOA_GATEWAY_TOKEN: TOKEN,
      MODEL_PROVIDER: "openai-compatible",
      MODEL_API_KEY: "",
      ACCOUNT_HEALTH_INTERVAL_MS: "0",
      REMINDER_SWEEP_INTERVAL_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await waitForHealth(`http://127.0.0.1:${port}/health`, child, () => stderr);
  return child;
}

async function waitForHealth(url, child, stderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`gateway exited early: ${stderr()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Startup still in progress.
    }
    await delay(50);
  }
  throw new Error(`gateway did not become healthy: ${stderr()}`);
}

async function stopGateway(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([onceExit(child), delay(1500)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function onceExit(child) {
  return new Promise((resolve) => child.once("exit", resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
