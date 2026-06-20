#!/usr/bin/env node
"use strict";

// Browser clients cannot set Authorization headers on WebSocket upgrades. This
// smoke proves the browser path: an authenticated HTTP request mints a short
// lived ticket, then a headerless WebSocket connects to /v1/voice/sessions with
// that ticket and receives assistant audio.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "browser-voice-ticket-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-browser-voice-ticket-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startGateway({ port, dataDir });
    await step("ticket endpoint rejects missing bearer token", async () => {
      const response = await fetch(`${baseUrl}/v1/voice/session-ticket`, { method: "POST", body: "{}" });
      assert.equal(response.status, 401);
    });
    const ticket = await step("ticket endpoint issues browser websocket URL", () => issueTicket(baseUrl));
    await step("browser-style websocket streams live voice with ticket", () => runVoiceTurn(ticket.ws_url));
    await step("ticket is single-use", () => assertTicketCannotBeReused(ticket.ws_url));
    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      checks: [
        "POST /v1/voice/session-ticket requires the gateway token",
        "ticket response includes a ws:// /v1/voice/sessions URL",
        "headerless browser WebSocket authenticates with the ticket",
        "PCM16 input returns assistant audio and turn_done",
        "the ticket cannot be reused",
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

async function issueTicket(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/voice/session-ticket`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      source: "browser-extension-smoke",
      session_id: `browser_voice_${Date.now().toString(36)}`,
    }),
  });
  const json = await response.json();
  assert.equal(response.status, 201, JSON.stringify(json));
  assert.match(String(json.ws_url || ""), /^ws:\/\/127\.0\.0\.1:\d+\/v1\/voice\/sessions\?ticket=/);
  assert.ok(json.expires_in_ms > 0, "ticket should report positive expiry");
  return json;
}

async function runVoiceTurn(wsUrl) {
  const ws = await openClient(wsUrl);
  const seen = new Set();
  let audioBytes = 0;
  try {
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        audioBytes += Buffer.byteLength(data);
        return;
      }
      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      seen.add(event.type);
    });
    ws.send(JSON.stringify({
      type: "session_start",
      source: "browser-extension-smoke",
      session_id: `browser_voice_${Date.now().toString(36)}`,
      turn_id: `turn_${Date.now().toString(36)}`,
      format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    }));
    await waitFor(() => seen.has("session_ready"), "session_ready missing");
    ws.send(generatePcm16Tone(16000, 220, 0.2, 260));
    ws.send(JSON.stringify({ type: "commit_turn" }));
    await waitFor(() => seen.has("turn_done"), "turn_done missing");
    for (const event of ["transcript_final", "assistant_audio_start", "assistant_audio_done"]) {
      assert.ok(seen.has(event), `missing ${event}`);
    }
    assert.ok(audioBytes > 0, "assistant audio stream was empty");
  } finally {
    ws.close(1000, "smoke done");
  }
}

async function assertTicketCannotBeReused(wsUrl) {
  await assert.rejects(openClient(wsUrl), /401|Unexpected server response/);
}

function openClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timed out opening websocket"));
    }, 4000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      reject(new Error(`Unexpected server response: ${response.statusCode}`));
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
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
      MODEL_ID: "browser-voice-ticket-smoke-model",
      MODEL_API_KEY: "",
      VOICE_PROVIDER: "loopback",
      VOICE_STT_PROVIDER: "loopback",
      VOICE_LLM_PROVIDER: "loopback",
      VOICE_TTS_PROVIDER: "loopback",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
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

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(message);
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generatePcm16Tone(sampleRate, frequencyHz, volume, durationMs) {
  const sampleCount = Math.floor(sampleRate * durationMs / 1000);
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * frequencyHz * index / sampleRate) * volume * 32767);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), index * 2);
  }
  return buffer;
}
