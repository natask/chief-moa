#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
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

  await assertRemoteModeFailsWithoutDatabase();
  await assertLocalHealthSurfacesMode();

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "MOA_MODE defaults to local for direct node server.js runs",
      "self-host and hosted validate as remote modes",
      "remote modes require DATABASE_URL and auth",
      "self-host startup without DATABASE_URL exits with a clear error",
      "/health reports active mode without exposing secrets",
    ],
  }, null, 2));
}

async function assertRemoteModeFailsWithoutDatabase() {
  const port = await freePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-remote-mode-fail-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: path.join(tempDir, "data"),
      MOA_MODE: "self-host",
      MOA_GATEWAY_TOKEN: TOKEN,
      DATABASE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(child);
  const code = await onceExit(child, 3000);
  fs.rmSync(tempDir, { recursive: true, force: true });
  assert.notEqual(code, 0, "self-host without DATABASE_URL must fail");
  assert.match(logs.text(), /DATABASE_URL/, "startup error should name DATABASE_URL");
}

async function assertLocalHealthSurfacesMode() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-remote-mode-local-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: path.join(tempDir, "data"),
      MOA_MODE: "local",
      MOA_GATEWAY_TOKEN: TOKEN,
      MODEL_PROVIDER: "openai-compatible",
      MODEL_API_KEY: "",
      VOICE_PROVIDER: "loopback",
      VOICE_STT_PROVIDER: "loopback",
      VOICE_LLM_PROVIDER: "loopback",
      VOICE_TTS_PROVIDER: "loopback",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(child);
  try {
    await waitForHealth(baseUrl, logs);
    const health = await getJson(`${baseUrl}/health`);
    assert.equal(health.mode, "local");
    assert.equal(health.gateway_mode.mode, "local");
    assert.equal(health.gateway_mode.database_required, false);
    assert.equal(health.gateway_mode.token_auth_configured, true);
  } finally {
    child.kill("SIGTERM");
    await onceExit(child, 1500);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function getJson(url) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  const text = await response.text();
  assert.ok(response.ok, `${url} returned ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (logs.exited) throw new Error(`gateway exited early\n${logs.text()}`);
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
  const collect = (chunk) => chunks.push(String(chunk));
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("exit", () => { logs.exited = true; });
  const logs = { exited: false, text: () => chunks.join("") };
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
