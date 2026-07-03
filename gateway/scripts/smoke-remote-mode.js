#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  await assertRemoteModeRequiresDatabaseUrl();
  await assertRemoteModeRequiresToken();
  await assertLocalModeDefaultsLoopback();
  await assertSelfHostModeDefaultsRemoteBind();
  await assertSelfHostPublicUrls();
  console.log("smoke-remote-mode: ok");
}

async function assertRemoteModeRequiresDatabaseUrl() {
  const result = await runGatewayToExit({
    MOA_MODE: "self-host",
    MOA_GATEWAY_TOKEN: "remote-mode-token",
    DATABASE_URL: "",
  });
  assert.notEqual(result.code, 0, "self-host mode without DATABASE_URL must fail");
  assert.match(result.output, /requires DATABASE_URL/i);
}

async function assertRemoteModeRequiresToken() {
  const result = await runGatewayToExit({
    MOA_MODE: "self-host",
    MOA_GATEWAY_TOKEN: "",
    DATABASE_URL: "postgres://moa:moa@127.0.0.1:1/moa_gateway",
  });
  assert.notEqual(result.code, 0, "self-host mode without MOA_GATEWAY_TOKEN must fail");
  assert.match(result.output, /requires MOA_GATEWAY_TOKEN/i);
}

async function assertLocalModeDefaultsLoopback() {
  const server = await startGateway({
    MOA_MODE: "local",
    MOA_GATEWAY_TOKEN: "",
    DATABASE_URL: "",
  });
  try {
    const health = await getJson(server.baseUrl + "/health");
    assert.equal(health.mode, "local");
    assert.equal(health.remote_mode, false);
    assert.equal(health.bind.host, "127.0.0.1");
    assert.equal(health.trust_proxy, false);
  } finally {
    await stopGateway(server);
  }
}

async function assertSelfHostModeDefaultsRemoteBind() {
  const server = await startGateway({
    MOA_MODE: "self-host",
    MOA_GATEWAY_TOKEN: "remote-mode-token",
    DATABASE_URL: "postgres://moa:moa@127.0.0.1:1/moa_gateway",
  });
  try {
    const health = await getJson(server.baseUrl + "/health");
    assert.equal(health.mode, "self-host");
    assert.equal(health.remote_mode, true);
    assert.equal(health.bind.host, "0.0.0.0");
    assert.equal(health.trust_proxy, true);
    assert.equal(health.event_substrate.postgres_configured, true);
  } finally {
    await stopGateway(server);
  }
}

async function assertSelfHostPublicUrls() {
  const token = "remote-mode-token";
  const publicUrl = "https://api.example.test";
  const server = await startGateway({
    MOA_MODE: "self-host",
    MOA_GATEWAY_TOKEN: token,
    DATABASE_URL: "postgres://moa:moa@127.0.0.1:1/moa_gateway",
    PUBLIC_GATEWAY_URL: publicUrl,
  });
  try {
    writeOtaManifest(server.tempDir);
    const headers = { authorization: `Bearer ${token}` };
    const manifest = await getJson(server.baseUrl + "/v1/android/updates/latest", { headers });
    assert.equal(manifest.download_url, `${publicUrl}/v1/android/updates/latest.apk`);

    const ticket = await postJson(server.baseUrl + "/v1/voice/session-ticket", {
      source: "remote-mode-smoke",
      session_id: "remote-mode-smoke",
    }, { headers });
    assert.match(ticket.ws_url, /^wss:\/\/api\.example\.test\/v1\/voice\/sessions\?ticket=/);
  } finally {
    await stopGateway(server);
  }
}

async function runGatewayToExit(extraEnv) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-remote-mode-exit-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: gatewayEnv(tempDir, 0, extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
  return { code, output };
}

async function startGateway(extraEnv) {
  const port = await freePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-remote-mode-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: gatewayEnv(tempDir, port, extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  const server = {
    child,
    tempDir,
    baseUrl: `http://127.0.0.1:${port}`,
    logs: () => output,
  };
  await waitForHealth(server);
  return server;
}

function gatewayEnv(tempDir, port, extraEnv) {
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    PORT: port ? String(port) : "0",
    DATA_DIR: path.join(tempDir, "data"),
    ANDROID_OTA_DIR: path.join(tempDir, "data", "android-ota"),
    MODEL_PROVIDER: "openai-compatible",
    MODEL_ID: "remote-mode-smoke-model",
    MODEL_API_KEY: "",
    VOICE_PROVIDER: "loopback",
    VOICE_STT_PROVIDER: "loopback",
    VOICE_LLM_PROVIDER: "loopback",
    VOICE_TTS_PROVIDER: "loopback",
    DEFAULT_AGENT_HARNESS: "echo",
    PROBE_GEMINI_VERSION: "0",
    ...extraEnv,
  };
}

async function waitForHealth(server) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`gateway exited before health was ready\n${server.logs()}`);
    }
    try {
      const response = await fetch(server.baseUrl + "/health");
      if (response.ok) return;
    } catch {
      // Wait for listener.
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for health\n${server.logs()}`);
}

function writeOtaManifest(tempDir) {
  const otaDir = path.join(tempDir, "data", "android-ota");
  fs.mkdirSync(otaDir, { recursive: true });
  fs.writeFileSync(path.join(otaDir, "latest.json"), JSON.stringify({
    app_id: "ai.moa.assistant",
    version_code: 1,
    version_name: "remote-mode-smoke",
    apk_filename: "moa-assistant.apk",
    sha256: "0".repeat(64),
    size_bytes: 1,
  }, null, 2));
}

async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const json = await response.json();
  assert.ok(response.ok, `${url} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function postJson(url, body, options = {}) {
  const response = await fetch(url, {
    ...options,
    method: "POST",
    headers: {
      ...(options.headers || {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  assert.ok(response.ok, `${url} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function stopGateway(server) {
  server.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.child.once("exit", resolve)),
    sleep(1000).then(() => server.child.kill("SIGKILL")),
  ]);
  fs.rmSync(server.tempDir, { recursive: true, force: true });
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
