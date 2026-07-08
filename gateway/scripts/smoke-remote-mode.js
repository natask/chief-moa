#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { resolveRemoteMode } = require("../lib/remote-mode");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "remote-mode-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  assert.equal(resolveRemoteMode({}).mode, "local");
  assert.equal(resolveRemoteMode({ MOA_MODE: "self-host", DATABASE_URL: "postgres://example", MOA_GATEWAY_TOKEN: TOKEN }).valid, true);
  assert.equal(resolveRemoteMode({ MOA_MODE: "hosted", DATABASE_URL: "postgres://example", MOA_AUTH: "better-auth" }).valid, true);
  assert.match(resolveRemoteMode({ MOA_MODE: "self-host", MOA_GATEWAY_TOKEN: TOKEN }).issues.join(" "), /DATABASE_URL/);
  assert.match(resolveRemoteMode({ MOA_MODE: "self-host", DATABASE_URL: "postgres://example" }).issues.join(" "), /MOA_GATEWAY_TOKEN/);

  await assertRemoteModeFailsWithoutDatabase();
  await assertRemoteModeFailsWithoutToken();
  await assertLocalHealthSurfacesMode();
  await assertSelfHostHealthSurfacesRemoteDefaults();
  await assertSelfHostPublicUrls();

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "MOA_MODE defaults to local for direct node server.js runs",
      "self-host and hosted validate as remote modes",
      "remote modes require DATABASE_URL and auth",
      "self-host startup failures name missing remote-mode requirements",
      "/health reports active mode without exposing secrets",
      "PUBLIC_GATEWAY_URL drives OTA and voice WebSocket public URLs",
    ],
  }, null, 2));
}

async function assertRemoteModeFailsWithoutDatabase() {
  const result = await runGatewayToExit({
    MOA_MODE: "self-host",
    MOA_GATEWAY_TOKEN: TOKEN,
    DATABASE_URL: "",
  });
  assert.notEqual(result.code, 0, "self-host without DATABASE_URL must fail");
  assert.match(result.output, /DATABASE_URL/, "startup error should name DATABASE_URL");
}

async function assertRemoteModeFailsWithoutToken() {
  const result = await runGatewayToExit({
    MOA_MODE: "self-host",
    MOA_GATEWAY_TOKEN: "",
    DATABASE_URL: "postgres://moa:moa@127.0.0.1:1/moa_gateway",
  });
  assert.notEqual(result.code, 0, "self-host without MOA_GATEWAY_TOKEN must fail");
  assert.match(result.output, /MOA_GATEWAY_TOKEN/, "startup error should name MOA_GATEWAY_TOKEN");
}

async function assertLocalHealthSurfacesMode() {
  const server = await startGateway({
    HOST: "127.0.0.1",
    MOA_MODE: "local",
    MOA_GATEWAY_TOKEN: TOKEN,
    DATABASE_URL: "",
  });
  try {
    const health = await getJson(`${server.baseUrl}/health`);
    assert.equal(health.mode, "local");
    assert.equal(health.gateway_mode.mode, "local");
    assert.equal(health.gateway_mode.remote, false);
    assert.equal(health.gateway_mode.database_required, false);
    assert.equal(health.gateway_mode.token_auth_configured, true);
    assert.equal(health.bind.host, "127.0.0.1");
    assert.equal(health.trust_proxy, false);
    assertVoiceActivityHealth(health);
  } finally {
    await stopGateway(server);
  }
}

async function assertSelfHostHealthSurfacesRemoteDefaults() {
  const server = await startGateway({
    MOA_MODE: "self-host",
    MOA_GATEWAY_TOKEN: TOKEN,
    DATABASE_URL: "postgres://moa:moa@127.0.0.1:1/moa_gateway",
  });
  try {
    const health = await getJson(`${server.baseUrl}/health`);
    assert.equal(health.mode, "self-host");
    assert.equal(health.gateway_mode.mode, "self-host");
    assert.equal(health.gateway_mode.remote, true);
    assert.equal(health.gateway_mode.database_required, true);
    assert.equal(health.gateway_mode.database_configured, true);
    assert.equal(health.gateway_mode.token_auth_configured, true);
    assert.equal(health.bind.host, "0.0.0.0");
    assert.equal(health.trust_proxy, true);
    assert.equal(health.event_substrate.postgres_configured, true);
    assertVoiceActivityHealth(health);
  } finally {
    await stopGateway(server);
  }
}

async function assertSelfHostPublicUrls() {
  const publicUrl = "https://api.example.test";
  const server = await startGateway({
    MOA_MODE: "self-host",
    MOA_GATEWAY_TOKEN: TOKEN,
    DATABASE_URL: "postgres://moa:moa@127.0.0.1:1/moa_gateway",
    PUBLIC_GATEWAY_URL: publicUrl,
  });
  try {
    writeOtaManifest(server.tempDir);
    const manifest = await getJson(`${server.baseUrl}/v1/android/updates/latest`);
    assert.equal(manifest.download_url, `${publicUrl}/v1/android/updates/latest.apk`);

    const ticket = await postJson(`${server.baseUrl}/v1/voice/session-ticket`, {
      source: "remote-mode-smoke",
      session_id: "remote-mode-smoke",
    });
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
  const logs = collectLogs(child);
  const code = await onceExit(child, 3000);
  fs.rmSync(tempDir, { recursive: true, force: true });
  return { code, output: logs.text() };
}

async function startGateway(extraEnv) {
  const port = await freePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-remote-mode-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: gatewayEnv(tempDir, port, extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(child);
  const server = {
    child,
    tempDir,
    baseUrl: `http://127.0.0.1:${port}`,
    logs,
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
    VOICE_MULTI_AGENT_HARNESSES: "echo",
    PROBE_GEMINI_VERSION: "0",
    ...extraEnv,
  };
}

async function waitForHealth(server) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (server.logs.exited) throw new Error(`gateway exited early\n${server.logs.text()}`);
    try {
      const response = await fetch(`${server.baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for health\n${server.logs.text()}`);
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

function assertVoiceActivityHealth(health) {
  assert.equal(health.voice_stream?.activity?.active_voice_connections, 0);
  assert.equal(health.voice_stream?.activity?.active_recording_turns, 0);
  assert.equal(health.voice_stream?.activity?.active_committed_turns, 0);
  assert.equal(health.voice_stream?.activity?.active_responding_connections, 0);
  assert.equal(health.voice_stream?.activity?.drain_safe, true);
}

async function getJson(url) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  const text = await response.text();
  assert.ok(response.ok, `${url} returned ${response.status}: ${text}`);
  return JSON.parse(text);
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
  assert.ok(response.ok, `${url} returned ${response.status}: ${text}`);
  return JSON.parse(text);
}

function collectLogs(child) {
  const chunks = [];
  const collect = (chunk) => chunks.push(String(chunk));
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const logs = { exited: false, text: () => chunks.join("") };
  child.on("exit", () => { logs.exited = true; });
  return logs;
}

async function stopGateway(server) {
  server.child.kill("SIGTERM");
  await onceExit(server.child, 1500);
  fs.rmSync(server.tempDir, { recursive: true, force: true });
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
