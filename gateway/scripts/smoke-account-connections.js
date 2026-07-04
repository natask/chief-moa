#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "account-connections-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-account-connections-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  try {
    server = await startGateway({ port, dataDir });
    await step("account endpoints require auth", () => assertAuthRequired(baseUrl));
    await step("provider catalog", () => assertProviderCatalog(baseUrl));
    await step("secret-looking JSON rejected", () => assertSecretFieldsRejected(baseUrl));
    const connection = await step("create connection skeleton", () => createConnection(baseUrl));
    await step("list and detail hide secrets", () => assertListAndDetail(baseUrl, connection.id));
    await step("patch status", () => patchStatus(baseUrl, connection.id));
    await step("reauth action", () => reauth(baseUrl, connection.id));
    await step("stored records contain no submitted secret", () => assertNoSecretStored(dataDir));

    console.log(JSON.stringify({
      ok: true,
      connection_id: connection.id,
      checks: [
        "account connection endpoints require token auth",
        "provider catalog is exposed",
        "secret-looking request fields are rejected",
        "connection create/list/detail/patch status work",
        "reauth returns a non-secret user action",
        "file-backed records contain summaries only",
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
  const response = await requestJson(`${baseUrl}/v1/account-connections`);
  assert.equal(response.status, 401);
}

async function assertProviderCatalog(baseUrl) {
  const response = await getJson(`${baseUrl}/v1/account-providers`);
  assert.ok(response.providers.some((provider) => provider.id === "openai"));
}

async function assertSecretFieldsRejected(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/account-connections`, {
    provider: "openai",
    label: "Bad secret",
    credential_kind: "api_key",
    api_key: "sk-thisShouldNeverBeStored123456789",
  });
  assert.equal(response.status, 400, JSON.stringify(response.json));
  assert.match(String(response.json.error || ""), /secret-looking/i);
}

async function createConnection(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/account-connections`, {
    provider: "openai",
    label: "Work OpenAI",
    credential_kind: "api_key",
    account_subject: { display: "nat@example.com", provider_account_id: "acct_123", organization_id: "org_123" },
    scopes: ["models.read", "responses.write"],
    device_notification_target: { device_id: "android_primary", surface_type: "android", channel: "credential_health", enabled: true },
  });
  assert.equal(response.status, 202, JSON.stringify(response.json));
  assert.equal(response.json.connection.provider, "openai");
  assert.equal(response.json.connection.status, "pending_user_auth");
  assert.equal(response.json.connection.needs_user_action, true);
  assert.equal(response.json.connection.credential_ref_kind, "none");
  assert.equal(response.json.connection.api_key, undefined);
  return response.json.connection;
}

async function assertListAndDetail(baseUrl, id) {
  const list = await getJson(`${baseUrl}/v1/account-connections`);
  assert.ok(list.connections.some((connection) => connection.id === id));
  const detail = await getJson(`${baseUrl}/v1/account-connections/${id}`);
  assert.equal(detail.connection.id, id);
  const serialized = JSON.stringify(detail.connection);
  assert.ok(!serialized.includes("sk-thisShouldNeverBeStored"), "detail must not include rejected secret");
  assert.ok(!serialized.includes("refresh_token"), "detail must not expose refresh tokens");
}

async function patchStatus(baseUrl, id) {
  const response = await patchJson(`${baseUrl}/v1/account-connections/${id}`, {
    status: "connected",
    status_reason: "",
    label: "Work OpenAI updated",
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.json.connection.status, "connected");
  assert.equal(response.json.connection.needs_user_action, false);
  assert.equal(response.json.connection.label, "Work OpenAI updated");
}

async function reauth(baseUrl, id) {
  const response = await postJson(`${baseUrl}/v1/account-connections/${id}/reauth`, { reason: "manual_smoke" });
  assert.equal(response.status, 202, JSON.stringify(response.json));
  assert.equal(response.json.connection_id, id);
  assert.equal(response.json.reauth_action.type, "gateway_secret_form");
  assert.ok(!JSON.stringify(response.json).includes("sk-"));
}

async function assertNoSecretStored(dataDir) {
  const stored = fs.readFileSync(path.join(dataDir, "account-connections.json"), "utf8");
  assert.ok(!stored.includes("sk-thisShouldNeverBeStored"));
  assert.ok(!stored.includes("api_key\":\"sk-"));
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
      MOA_MODE: "local",
      MOA_GATEWAY_TOKEN: TOKEN,
      MODEL_PROVIDER: "openai-compatible",
      MODEL_API_KEY: "",
      VOICE_PROVIDER: "loopback",
      VOICE_STT_PROVIDER: "loopback",
      VOICE_LLM_PROVIDER: "loopback",
      VOICE_TTS_PROVIDER: "loopback",
      HARNESS_STATUS_TIMEOUT_MS: "200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

async function getJson(url) {
  const response = await requestJson(url, { headers: authHeaders() });
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

function postJson(url, body) {
  return requestJson(url, { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify(body) });
}

function patchJson(url, body) {
  return requestJson(url, { method: "PATCH", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { status: response.status, json: text.trim() ? JSON.parse(text) : {} };
}

function authHeaders() {
  return { authorization: `Bearer ${TOKEN}` };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (logs.exited) throw new Error(`gateway exited before health\n${logs.text()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for health\n${logs.text()}`);
}

function collectLogs(child) {
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));
  const logs = { exited: false, text: () => chunks.join("") };
  child.on("exit", () => { logs.exited = true; });
  return logs;
}

function onceExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode != null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(child.exitCode ?? -1);
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function freePort() {
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
