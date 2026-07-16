#!/usr/bin/env node
"use strict";

// Smoke for the cross-device tool hub. It proves clients advertise local tool
// manifests, queue cross-device requests through the gateway, claim only work
// matching their capabilities, and post receipts without the gateway executing
// phone or browser-local actions itself.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "device-hub-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-device-hub-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startGateway({ port, dataDir });
    await step("device endpoints require auth", () => assertAuthRequired(baseUrl));
    await step("browser and android heartbeat", () => assertHeartbeats(baseUrl));
    const speakRequest = await step("browser queues Android speech request", () => queueAndroidSpeech(baseUrl));
    await step("Android claims and receipts speech request", () => claimAndReceiptAndroidSpeech(baseUrl, speakRequest.id));
    const tabRequest = await step("Android queues browser tab request", () => queueBrowserTabOpen(baseUrl));
    await step("browser claims and receipts tab request", () => claimAndReceiptBrowserTab(baseUrl, tabRequest.id));
    await step("latest context lists hub state", () => assertLatestContext(baseUrl));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      checks: [
        "device-client registry requires token auth",
        "browser and Android clients heartbeat with local tool manifests",
        "browser can queue an Android-owned audio.speak request",
        "Android claims only matching phone-local work and posts a receipt",
        "Android can queue a browser-owned browser.tab.open request",
        "browser claims only matching browser-local work and posts a receipt",
        "latest context exposes device clients and recent tool requests",
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
  const response = await fetch(`${baseUrl}/v1/device-clients`);
  assert.equal(response.status, 401);
}

async function assertHeartbeats(baseUrl) {
  const browser = await postJson(`${baseUrl}/v1/device-clients/heartbeat`, {
    device_id: "browser_smoke",
    surface_type: "browser_extension",
    session_id: "hub_smoke",
    local_tool_manifest: [
      { tool: "browser.tab.open", risk: "navigation", approval: "implicit_user_command" },
      { tool: "browser.task.claim", risk: "browser_local", approval: "none" },
      { tool: "page.snapshot", risk: "read_only", approval: "none" },
    ],
  });
  assert.equal(browser.status, 200, JSON.stringify(browser.json));

  const android = await postJson(`${baseUrl}/v1/device-clients/heartbeat`, {
    device_id: "android_smoke",
    surface_type: "android",
    session_id: "hub_smoke",
    local_tool_manifest: [
      { tool: "audio.speak", risk: "local_output", approval: "implicit_user_command" },
      { tool: "screen.summary", risk: "read_only", approval: "none" },
      { tool: "screen.tap_text", risk: "navigation", approval: "implicit_user_command" },
      { tool: "system.back", risk: "navigation", approval: "implicit_user_command" },
      { tool: "system.home", risk: "navigation", approval: "implicit_user_command" },
      { tool: "app.launch", risk: "navigation", approval: "implicit_user_command" },
    ],
  });
  assert.equal(android.status, 200, JSON.stringify(android.json));

  const list = await getJson(`${baseUrl}/v1/device-clients`);
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.ok(list.json.devices.some((device) => device.device_id === "browser_smoke"));
  assert.ok(list.json.devices.some((device) => device.device_id === "android_smoke"));
}

async function queueAndroidSpeech(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/tool/requests`, {
    source: "device-hub-smoke",
    source_device_id: "browser_smoke",
    source_surface_type: "browser_extension",
    target_surface_type: "android",
    tool: "audio.speak",
    input: { text: "Hello from browser smoke." },
    session_id: "hub_smoke",
    branch_id: "browser_to_phone",
  });
  assert.equal(response.status, 202, JSON.stringify(response.json));
  const request = response.json.request;
  assert.equal(request.tool, "audio.speak");
  assert.equal(request.target_device_id, "android_smoke");
  assert.equal(request.status, "pending");
  return request;
}

async function claimAndReceiptAndroidSpeech(baseUrl, requestId) {
  const claim = await postJson(`${baseUrl}/v1/tool/requests/claim`, {
    device_id: "android_smoke",
  });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  assert.equal(claim.json.request.id, requestId);
  assert.equal(claim.json.request.tool, "audio.speak");
  assert.equal(claim.json.request.input.text, "Hello from browser smoke.");
  assert.match(claim.json.request.claim_id, /^claim_[a-f0-9]{20}$/);

  const receiptBody = {
    device_id: "android_smoke",
    claim_id: claim.json.request.claim_id,
    receipt_id: `smoke_${requestId}`,
    idempotency_key: `smoke_${requestId}`,
    ok: true,
    summary: "Android spoke the requested text.",
    local_receipt: { tool: "audio.speak", success: true },
  };
  const receipt = await postJson(`${baseUrl}/v1/tool/requests/${requestId}/receipts`, receiptBody);
  assert.equal(receipt.status, 200, JSON.stringify(receipt.json));
  assert.equal(receipt.json.request.status, "completed");
  assert.equal(receipt.json.receipt.ok, true);
  assert.equal(receipt.json.idempotent_replay, false);

  const retry = await postJson(`${baseUrl}/v1/tool/requests/${requestId}/receipts`, receiptBody);
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  assert.equal(retry.json.idempotent_replay, true);
  assert.deepEqual(retry.json.receipt, receipt.json.receipt);
  assert.equal(retry.json.request.receipt_count, 1);

  const terminalClaim = await postJson(`${baseUrl}/v1/tool/requests/claim`, { device_id: "android_smoke" });
  assert.equal(terminalClaim.status, 204, "a terminal request must never be claimable again");
}

async function queueBrowserTabOpen(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/tool/requests`, {
    source: "device-hub-smoke",
    source_device_id: "android_smoke",
    source_surface_type: "android",
    target_surface_type: "browser_extension",
    tool: "browser.tab.open",
    input: { url: "https://example.com/" },
    session_id: "hub_smoke",
    branch_id: "phone_to_browser",
  });
  assert.equal(response.status, 202, JSON.stringify(response.json));
  const request = response.json.request;
  assert.equal(request.tool, "browser.tab.open");
  assert.equal(request.target_device_id, "browser_smoke");
  return request;
}

async function claimAndReceiptBrowserTab(baseUrl, requestId) {
  const claim = await postJson(`${baseUrl}/v1/tool/requests/claim`, {
    device_id: "browser_smoke",
  });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  assert.equal(claim.json.request.id, requestId);
  assert.equal(claim.json.request.tool, "browser.tab.open");

  const receipt = await postJson(`${baseUrl}/v1/tool/requests/${requestId}/receipts`, {
    device_id: "browser_smoke",
    claim_id: claim.json.request.claim_id,
    receipt_id: `smoke_${requestId}`,
    ok: true,
    summary: "Browser opened https://example.com/.",
    local_receipt: { tool: "browser.tab.open", success: true },
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.json));
  assert.equal(receipt.json.request.status, "completed");
}

async function assertLatestContext(baseUrl) {
  const context = await getJson(`${baseUrl}/v1/context/latest`);
  assert.equal(context.status, 200, JSON.stringify(context.json));
  assert.ok(context.json.device_clients.some((device) => device.device_id === "android_smoke"));
  assert.ok(context.json.device_clients.some((device) => device.device_id === "browser_smoke"));
  assert.ok(context.json.recent_tool_requests.some((request) => request.tool === "audio.speak" && request.status === "completed"));
  assert.ok(context.json.recent_tool_requests.some((request) => request.tool === "browser.tab.open" && request.status === "completed"));
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
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
