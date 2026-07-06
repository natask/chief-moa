#!/usr/bin/env node
"use strict";

// LiveKit voice-transport PROTOTYPE smoke (flag-gated).
//
// Proves the gateway side of the Option-A spike without any LiveKit Cloud
// credentials or real model/TTS network:
//   1. lib/livekit-transport unit shape (config gate, room name, minted JWT).
//   2. Unconfigured gateway 503s the token route + the three internal hooks.
//   3. Configured gateway (fake LIVEKIT env) mints a room token, and the three
//      /v1/internal/voice/* hooks round-trip through the SAME reasoning + TTS +
//      turn-record paths the WS pipeline uses. The model runs on the gateway's
//      deterministic no-key fallback and Cloud TTS is stubbed via
//      MOA_TEST_CLOUD_TTS_ENDPOINT, so this is deterministic and offline.

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  livekitConfigured,
  livekitRoomName,
  livekitStatus,
  mintRoomToken,
} = require("../lib/livekit-transport");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "livekit-transport-smoke-token";
const FAKE_LIVEKIT_ENV = {
  LIVEKIT_URL: "wss://fake-project.livekit.cloud",
  LIVEKIT_API_KEY: "APIfakekey123456",
  LIVEKIT_API_SECRET: "fakesecretfakesecretfakesecret0123456789",
};

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  await step("lib config gate + room name + minted JWT", assertTransportUnit);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-livekit-transport-"));
  let unconfigured;
  let configured;
  let ttsServer;
  try {
    // --- Unconfigured gateway: every LiveKit route reports not_configured. ---
    unconfigured = await startGateway({ dataDir: path.join(tempDir, "off"), env: {} });
    await step("token route 503s when LiveKit is not configured", async () => {
      const res = await post(unconfigured.baseUrl, "/v1/voice/livekit/token", { session_id: "s1" });
      assert.equal(res.status, 503, res.text);
      assert.equal(res.json.status, "not_configured");
    });
    await step("internal hooks 503 when LiveKit is not configured", async () => {
      for (const route of ["/v1/internal/voice/reason", "/v1/internal/voice/synthesize", "/v1/internal/voice/turn-record"]) {
        const res = await post(unconfigured.baseUrl, route, { transcript: "hi", text: "hi" });
        assert.equal(res.status, 503, `${route}: ${res.text}`);
        assert.equal(res.json.status, "not_configured");
      }
    });
    await step("health reports livekit_voice disabled when unconfigured", async () => {
      const res = await get(unconfigured.baseUrl, "/health");
      assert.equal(res.json.livekit_voice.enabled, false);
    });
    unconfigured.stop();
    unconfigured = null;

    // --- Configured gateway: token shape + internal round trips. ---
    ttsServer = await startFakeTtsServer();
    configured = await startGateway({
      dataDir: path.join(tempDir, "on"),
      env: {
        ...FAKE_LIVEKIT_ENV,
        VOICE_PROVIDER: "chirp",
        VOICE_TTS_PROVIDER: "cloud-tts",
        GCP_PROJECT_ID: "test-project",
        CHIRP_ACCESS_TOKEN: "test-token",
        CHIRP_MODEL: "chirp_3",
        CHIRP_LANGUAGE_CODES: "en-US,am-ET",
        MOA_TEST_CLOUD_TTS_ENDPOINT: ttsServer.url,
      },
    });

    await step("health reports livekit_voice enabled when configured", async () => {
      const res = await get(configured.baseUrl, "/health");
      assert.equal(res.json.livekit_voice.enabled, true);
      assert.equal(res.json.livekit_voice.url, FAKE_LIVEKIT_ENV.LIVEKIT_URL);
    });

    await step("token route mints a room token with the session/branch room", async () => {
      const res = await post(configured.baseUrl, "/v1/voice/livekit/token", {
        session_id: "sess-abc",
        branch_id: "thr-42",
        device_id: "dev-9",
      });
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.url, FAKE_LIVEKIT_ENV.LIVEKIT_URL);
      assert.equal(res.json.room, "moa-sess-abc-thr-42");
      assert.equal(res.json.identity, "dev-9");
      assert.equal(res.json.branch_id, "thr-42");
      assert.equal(String(res.json.token).split(".").length, 3, "token must be a 3-part JWT");
      assert.ok(res.json.expires_in_ms > 0, "token must report positive expiry");
    });

    await step("reason hook wraps the cascaded reasoner (deterministic fallback)", async () => {
      const res = await post(configured.baseUrl, "/v1/internal/voice/reason", {
        transcript: "tell me something short",
        session_id: "sess-reason",
        branch_id: "default",
        turn_id: "turn-r1",
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.classification, "chat");
      assert.equal(typeof res.json.language, "string");
      assert.equal(typeof res.json.speak, "string");
    });

    await step("synthesize hook returns PCM16@16k via the active provider TTS leg", async () => {
      const res = await postRaw(configured.baseUrl, "/v1/internal/voice/synthesize", {
        text: "hello master",
        language: "en-US",
      });
      assert.equal(res.status, 200, res.text());
      assert.equal(res.headers["content-type"], "application/octet-stream");
      assert.equal(res.headers["x-moa-audio-encoding"], "pcm16");
      assert.equal(res.headers["x-moa-audio-sample-rate"], "16000");
      assert.ok(res.body.length > 0, "synthesized PCM must be non-empty");
      assert.equal(res.body.length % 2, 0, "PCM16 byte length must be even");
    });

    await step("turn-record hook stores a turn through the shared record path", async () => {
      const turnId = "turn-lk-1";
      const sessionId = "sess-record";
      const res = await post(configured.baseUrl, "/v1/internal/voice/turn-record", {
        session_id: sessionId,
        branch_id: "default",
        turn_id: turnId,
        transcript: "remember the plan",
        assistant_text: "Noted, master.",
        provider: "livekit",
        reply_language: "en-US",
        tts_spoke: true,
        modality: "speech",
        status: "completed",
      });
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.turn_id, turnId);

      // The turn must be retrievable through the same durable voice-turn store.
      const stored = await get(configured.baseUrl, `/v1/voice/turns/${turnId}?session_id=${sessionId}`);
      assert.equal(stored.status, 200, stored.text);
      assert.equal(stored.json.transcript, "remember the plan");
    });

    console.log("smoke-livekit-transport: ok");
  } finally {
    if (unconfigured) unconfigured.stop();
    if (configured) configured.stop();
    if (ttsServer) await ttsServer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function assertTransportUnit() {
  assert.equal(livekitConfigured({}), false, "empty env must be unconfigured");
  assert.equal(livekitConfigured(FAKE_LIVEKIT_ENV), true, "full env must be configured");
  assert.equal(livekitRoomName("s 1", "fork-9"), "moa-s-1-fork-9");
  assert.equal(livekitRoomName("", ""), "moa-default-default");
  assert.equal(livekitStatus({}).enabled, false);

  const minted = await mintRoomToken({
    env: FAKE_LIVEKIT_ENV,
    sessionId: "s",
    branchId: "b",
    identity: "dev-1",
    ttlSeconds: 120,
  });
  assert.equal(minted.room, "moa-s-b");
  assert.equal(minted.identity, "dev-1");
  assert.equal(minted.url, FAKE_LIVEKIT_ENV.LIVEKIT_URL);
  assert.equal(String(minted.token).split(".").length, 3, "minted token must be a JWT");
}

// --- fake Cloud TTS endpoint: returns a base64 WAV so synthesizeSpeech can
// decode PCM without hitting Google. ---
function startFakeTtsServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ audioContent: makeWavBase64(24000, 100) }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/text:synthesize`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function makeWavBase64(sampleRate, durationMs) {
  const samples = Math.floor(sampleRate * durationMs / 1000);
  const dataLen = samples * 2;
  const buffer = Buffer.alloc(44 + dataLen);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataLen, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / sampleRate) * 12000), 44 + i * 2);
  }
  return buffer.toString("base64");
}

// --- gateway spawn helpers ---
async function startGateway({ dataDir, env }) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      HOST: "127.0.0.1",
      PORT: String(port),
      MOA_MODE: "local",
      DATA_DIR: dataDir,
      ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
      MOA_GATEWAY_TOKEN: TOKEN,
      MODEL_PROVIDER: "openai-compatible",
      MODEL_ID: "livekit-transport-smoke-model",
      MODEL_API_KEY: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(child);
  await waitForHealth(baseUrl, logs);
  return {
    baseUrl,
    stop: () => child.kill("SIGTERM"),
  };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {}
    if (logs.exited) throw new Error(`gateway exited before health\n${logs.text()}`);
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

async function post(baseUrl, route, payload) {
  const res = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json: json || {}, text };
}

async function postRaw(baseUrl, route, payload) {
  const res = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const headers = Object.fromEntries(res.headers.entries());
  return { status: res.status, headers, body: buffer, text: () => buffer.toString("utf8") };
}

async function get(baseUrl, route) {
  const res = await fetch(`${baseUrl}${route}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json: json || {}, text };
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
  child.on("exit", () => { logs.exited = true; });
  return logs;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
