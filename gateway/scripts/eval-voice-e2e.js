#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const FIXTURE_DIR = path.join(GATEWAY_DIR, "test", "fixtures", "voice");
const TOKEN = "voice-e2e-token";
const AUDIO_FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.audio && process.env.VOICE_EVAL_LIVE !== "1") {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: "--audio replay against real STT/TTS requires VOICE_EVAL_LIVE=1",
    }, null, 2));
    return;
  }
  if (args.audio) {
    await runLiveReplay(args);
    return;
  }

  const complete = await runDeterministicScenario({
    name: "cascaded-complete",
    sttTranscript: "hello can you hear me",
    sttLanguage: "en-US",
    modelFetchTimeoutMs: 2000,
    wallClockBoundMs: 6000,
  });
  const stalled = await runDeterministicScenario({
    name: "cascaded-reasoner-stall",
    sttTranscript: "please stall",
    sttLanguage: "en-US",
    modelFetchTimeoutMs: 120,
    reasonerStallMs: 600,
    wallClockBoundMs: 2500,
  });

  const results = [complete, stalled];
  console.log(JSON.stringify({
    ok: results.every((result) => result.ok),
    mode: "deterministic",
    scenarios: results,
    checks: [
      "HTTP voice-session ticket is minted before WebSocket connection",
      "real /v1/voice/sessions upgrade path is used",
      "transcript_final is observed for every committed turn",
      "turn_done arrives for completed and injected-stall turns within the wall-clock bound",
      "completed cascaded turn_done carries tts_spoke and reply_language",
      "stored user PCM fetched from /v1/voice/audio matches the streamed PCM byte-for-byte",
    ],
  }, null, 2));

  assert.ok(results.every((result) => result.ok), "one or more E2E voice scenarios failed");
}

async function runDeterministicScenario(options) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `moa-voice-e2e-${options.name}-`));
  const dataDir = path.join(tempDir, "data");
  const fakeGoogle = await startFakeGoogle({
    transcript: options.sttTranscript,
    languageCode: options.sttLanguage,
  });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let gateway = null;

  try {
    gateway = await startGateway({
      port,
      dataDir,
      env: {
        MOA_MODE: "local",
        MOA_GATEWAY_TOKEN: TOKEN,
        MODEL_PROVIDER: "openai-compatible",
        MODEL_API_KEY: "",
        MODEL_FETCH_TIMEOUT_MS: String(options.modelFetchTimeoutMs),
        MOA_TEST_REASONER_STALL_MS: String(options.reasonerStallMs || 0),
        VOICE_PROVIDER: "chirp",
        VOICE_TTS_PROVIDER: "cloud-tts",
        VOICE_REASONING_PROVIDER: "gateway",
        GCP_PROJECT_ID: "test-project",
        CHIRP_ACCESS_TOKEN: "test-token",
        CHIRP_MODEL: "chirp_3",
        CHIRP_LANGUAGE_CODES: "en-US,am-ET",
        CLOUD_TTS_TIMEOUT_MS: "1000",
        MOA_TEST_CHIRP_ENDPOINT: `${fakeGoogle.baseUrl}/v2/projects/test/locations/us/recognizers/_:recognize`,
        MOA_TEST_CLOUD_TTS_ENDPOINT: `${fakeGoogle.baseUrl}/v1/text:synthesize`,
      },
    });

    const pcm = fs.readFileSync(path.join(FIXTURE_DIR, "en-hello.pcm"));
    const turn = await driveTurn({
      baseUrl,
      sessionId: `e2e_${options.name}`,
      turnId: `turn_${options.name}`,
      pcm,
      wallClockBoundMs: options.wallClockBoundMs,
    });

    assert.ok(turn.events.some((event) => event.type === "transcript_final"), `${options.name}: transcript_final missing`);
    assert.ok(turn.turnDone, `${options.name}: turn_done missing`);
    assert.ok(turn.elapsedMs <= options.wallClockBoundMs, `${options.name}: turn_done exceeded wall-clock bound`);

    if (options.reasonerStallMs) {
      assert.equal(turn.turnDone.status, "error", `${options.name}: stall must become status=error`);
      assert.equal(turn.turnDone.reason, "timeout", `${options.name}: stall reason must be timeout`);
    } else {
      assert.equal(turn.turnDone.status, "completed", `${options.name}: completed turn status`);
      assert.equal(turn.turnDone.tts_spoke, true, `${options.name}: hosted TTS should speak en-US`);
      assert.equal(turn.turnDone.reply_language, "en-US", `${options.name}: reply_language missing`);
      assert.ok(turn.events.some((event) => event.type === "assistant_text") || turn.assistantAudioBytes > 0, `${options.name}: no assistant output`);
    }

    const storedPcm = await fetchStoredPcm(baseUrl, turn.sessionId, turn.turnId);
    assert.deepEqual(storedPcm, pcm, `${options.name}: stored PCM differs from streamed PCM`);

    return {
      name: options.name,
      ok: true,
      status: turn.turnDone.status,
      reason: turn.turnDone.reason || "",
      elapsed_ms: turn.elapsedMs,
      transcript_final: turn.events.find((event) => event.type === "transcript_final")?.text || "",
      assistant_audio_bytes: turn.assistantAudioBytes,
      tts_spoke: typeof turn.turnDone.tts_spoke === "boolean" ? turn.turnDone.tts_spoke : null,
      reply_language: turn.turnDone.reply_language || "",
      stored_pcm_bytes: storedPcm.length,
      fake_google_calls: fakeGoogle.calls,
    };
  } finally {
    if (gateway) {
      gateway.kill("SIGTERM");
      await onceExit(gateway, 1500);
    }
    await fakeGoogle.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runLiveReplay(args) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-e2e-live-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let gateway = null;
  try {
    gateway = await startGateway({
      port,
      dataDir,
      env: {
        ...process.env,
        MOA_MODE: process.env.MOA_MODE || "local",
        MOA_GATEWAY_TOKEN: TOKEN,
        DATA_DIR: dataDir,
        HOST: "127.0.0.1",
        PORT: String(port),
      },
    });
    const pcm = fs.readFileSync(path.resolve(args.audio));
    const turn = await driveTurn({
      baseUrl,
      sessionId: `replay_${Date.now().toString(36)}`,
      turnId: `turn_${Date.now().toString(36)}`,
      pcm,
      rate: args.rate,
      wallClockBoundMs: 90000,
    });
    const transcript = turn.events.find((event) => event.type === "transcript_final")?.text || "";
    if (args.expect) {
      assert.match(transcript.toLowerCase(), new RegExp(escapeRegExp(args.expect.toLowerCase())), "expected transcript not found");
    }
    console.log(JSON.stringify({
      ok: true,
      mode: "live-replay",
      status: turn.turnDone?.status || "",
      transcript,
      elapsed_ms: turn.elapsedMs,
      assistant_audio_bytes: turn.assistantAudioBytes,
    }, null, 2));
  } finally {
    if (gateway) {
      gateway.kill("SIGTERM");
      await onceExit(gateway, 1500);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function driveTurn({ baseUrl, sessionId, turnId, pcm, rate = 16000, wallClockBoundMs }) {
  const ticket = await issueTicket(baseUrl, sessionId);
  const events = [];
  const binaryFrames = [];
  const start = Date.now();
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(ticket.ws_url);
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timed out waiting for turn_done after ${wallClockBoundMs}ms`));
    }, wallClockBoundMs);
    timeout.unref?.();
    const leadingFrameBytes = Math.min(640, pcm.length);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session_start",
        source: "voice-e2e",
        session_id: sessionId,
        turn_id: turnId,
        format: { ...AUDIO_FORMAT, sample_rate: rate },
      }));
      ws.send(pcm.subarray(0, leadingFrameBytes));
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        binaryFrames.push(Buffer.from(data));
        return;
      }
      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      events.push(event);
      if (event.type === "session_ready") {
        for (let offset = leadingFrameBytes; offset < pcm.length; offset += 640) {
          ws.send(pcm.subarray(offset, Math.min(offset + 640, pcm.length)));
        }
        ws.send(JSON.stringify({ type: "commit_turn", turn_id: turnId }));
      }
      if (event.type === "turn_done") {
        clearTimeout(timeout);
        ws.close(1000, "voice e2e done");
        resolve();
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return {
    sessionId,
    turnId,
    events,
    turnDone: events.find((event) => event.type === "turn_done") || null,
    elapsedMs: Date.now() - start,
    assistantAudioBytes: binaryFrames.reduce((sum, frame) => sum + frame.length, 0),
  };
}

async function issueTicket(baseUrl, sessionId) {
  const response = await fetch(`${baseUrl}/v1/voice/session-ticket`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ source: "voice-e2e", session_id: sessionId }),
  });
  const json = await response.json();
  assert.equal(response.status, 201, JSON.stringify(json));
  assert.ok(String(json.ws_url || "").includes("/v1/voice/sessions?ticket="), "ticket must return real WS session URL");
  return json;
}

async function fetchStoredPcm(baseUrl, sessionId, turnId) {
  const response = await fetch(`${baseUrl}/v1/voice/audio/${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (response.status !== 200) {
    throw new Error(`stored PCM fetch failed (${response.status}): ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function startGateway({ port, dataDir, env }) {
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
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

async function startFakeGoogle({ transcript, languageCode }) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {}
    if (request.url.includes(":recognize")) {
      calls.push({ kind: "stt", language_codes: body?.config?.languageCodes || [] });
      sendJson(response, 200, {
        results: [{
          languageCode,
          alternatives: [{ transcript }],
        }],
      });
      return;
    }
    if (request.url.includes("text:synthesize")) {
      calls.push({ kind: "tts", voice: body?.voice || {} });
      sendJson(response, 200, { audioContent: wavBase64() });
      return;
    }
    sendJson(response, 404, { error: "not found" });
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function wavBase64() {
  const sampleRate = 24000;
  const samples = 240;
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(i / 5) * 6000), 44 + i * 2);
  }
  return buffer.toString("base64");
}

function parseArgs(argv) {
  const result = { audio: "", rate: 16000, expect: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--audio") result.audio = argv[++i] || "";
    else if (arg === "--rate") result.rate = Math.max(1, Number(argv[++i] || 16000));
    else if (arg === "--expect") result.expect = argv[++i] || "";
  }
  return result;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    server.on("error", reject);
  });
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 6000;
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

function collectLogs(child) {
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.on("exit", () => {
    logs.exited = true;
  });
  const logs = {
    exited: false,
    text: () => Buffer.concat(chunks).toString("utf8").slice(-6000),
  };
  return logs;
}

function onceExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
