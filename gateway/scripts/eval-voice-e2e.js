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
const STREAMING_STT_PRELOAD = path.join(__dirname, "fixtures", "fake-streaming-speech-preload.js");
const TOKEN = "voice-e2e-token";
const AUDIO_FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };
const COMBINED_TRANSCRIPT = "streamed combined input";
const COMBINED_REPLY = "The middle reasoner produced this unique first sentence. Chunked Gemini speech proves the second sentence arrived.";

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
  const combined = await runDeterministicScenario({
    name: "cascaded-streaming-stt-reasoner-gemini-tts",
    sttTranscript: COMBINED_TRANSCRIPT,
    sttLanguage: "en-US",
    modelReply: COMBINED_REPLY,
    streamingStt: true,
    geminiTts: true,
    modelFetchTimeoutMs: 2000,
    wallClockBoundMs: 6000,
  });

  const results = [complete, stalled, combined];
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
      "one combined turn uses fake streaming STT, the real gateway reasoner over model HTTP/SSE, and chunked fake Gemini TTS",
      "the combined turn returns the unique model reply and cannot pass through the canned missing-model fallback",
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
    modelReply: options.modelReply,
    rejectBatchStt: options.streamingStt,
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
        MODEL_API_KEY: options.modelReply ? "test-model-key" : "",
        MODEL_BASE_URL: options.modelReply ? `${fakeGoogle.baseUrl}/v1` : "https://api.openai.com/v1",
        MODEL_ID: options.modelReply ? "test-streaming-reasoner" : "gpt-4o-mini",
        MODEL_FETCH_TIMEOUT_MS: String(options.modelFetchTimeoutMs),
        MOA_TEST_REASONER_STALL_MS: String(options.reasonerStallMs || 0),
        VOICE_PROVIDER: "chirp",
        VOICE_TTS_PROVIDER: options.geminiTts ? "gemini-tts" : "cloud-tts",
        VOICE_REASONING_PROVIDER: "gateway",
        GCP_PROJECT_ID: "test-project",
        CHIRP_ACCESS_TOKEN: "test-token",
        ...(options.streamingStt ? {
          CHIRP_SERVICE_ACCOUNT_KEY: JSON.stringify({ client_email: "fake@example.test", private_key: "fake" }),
          MOA_TEST_STREAMING_STT_TRANSCRIPT: options.sttTranscript,
          MOA_TEST_STREAMING_STT_LANGUAGE: options.sttLanguage,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${STREAMING_STT_PRELOAD}`.trim(),
        } : {}),
        CHIRP_MODEL: "chirp_3",
        CHIRP_LANGUAGE_CODES: "en-US,am-ET",
        CLOUD_TTS_TIMEOUT_MS: "1000",
        MOA_TEST_CHIRP_ENDPOINT: `${fakeGoogle.baseUrl}/v2/projects/test/locations/us/recognizers/_:recognize`,
        MOA_TEST_CLOUD_TTS_ENDPOINT: `${fakeGoogle.baseUrl}/v1/text:synthesize`,
        ...(options.geminiTts ? {
          GEMINI_TTS_MODEL: "gemini-2.5-flash-tts-test",
          GEMINI_TTS_VOICE: "Kore",
          VOICE_CHUNK_MIN_CHARS: "20",
          VOICE_CHUNK_FIRST_MAX_CHARS: "80",
          VOICE_CHUNK_MAX_CHARS: "120",
        } : {}),
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

    if (options.modelReply) {
      const assistantText = turn.events
        .filter((event) => event.type === "assistant_text")
        .map((event) => event.text || "")
        .join("");
      assert.equal(turn.events.find((event) => event.type === "transcript_final")?.text, options.sttTranscript,
        `${options.name}: streaming STT final transcript mismatch`);
      assert.ok(turn.events.some((event) => event.type === "transcript_partial" && event.text === options.sttTranscript),
        `${options.name}: fake streaming STT partial was not observed`);
      assert.equal(assistantText, options.modelReply, `${options.name}: assistant reply did not come from the fake model`);
      assert.doesNotMatch(assistantText, /need you to give me access to a configured model provider/i,
        `${options.name}: canned missing-model fallback must fail the combined E2E`);
      assert.ok(fakeGoogle.calls.some((call) => call.kind === "model-stream"),
        `${options.name}: gateway did not use model HTTP/SSE`);
      assert.equal(fakeGoogle.calls.some((call) => call.kind === "stt"), false,
        `${options.name}: streaming STT unexpectedly fell back to batch recognition`);
      const ttsCalls = fakeGoogle.calls.filter((call) => call.kind === "tts");
      assert.ok(ttsCalls.length >= 2, `${options.name}: expected chunked Gemini TTS, got ${ttsCalls.length} request(s)`);
      assert.ok(ttsCalls.every((call) => call.voice?.modelName === "gemini-2.5-flash-tts-test"),
        `${options.name}: TTS requests did not use the configured Gemini model`);
      assert.ok(turn.assistantAudioFrames >= 2, `${options.name}: expected multiple binary assistant audio frames`);
      assert.ok(Number(turn.turnDone.tts_segments) >= 2, `${options.name}: terminal receipt did not report multiple TTS segments`);
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
      assistant_audio_frames: turn.assistantAudioFrames,
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
      reason: turn.turnDone?.reason || "",
      error_events: turn.events.filter((event) => event.type === "error").slice(0, 3),
      transcript,
      reply_text: turn.events.filter((event) => event.type === "assistant_text").map((event) => event.text).join("").slice(0, 300),
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
    assistantAudioFrames: binaryFrames.length,
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

async function startFakeGoogle({ transcript, languageCode, modelReply = "", rejectBatchStt = false }) {
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
      if (rejectBatchStt) {
        sendJson(response, 500, { error: "batch STT must not run in the combined streaming scenario" });
        return;
      }
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
    if (request.url.includes("/chat/completions")) {
      if (body?.stream === true) {
        calls.push({ kind: "model-stream", model: body?.model || "" });
        sendOpenAiSse(response, modelReply);
      } else {
        calls.push({ kind: "model", model: body?.model || "" });
        sendJson(response, 200, { choices: [{ message: { role: "assistant", content: modelReply } }] });
      }
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

function sendOpenAiSse(response, value) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const midpoint = Math.max(1, Math.floor(value.length / 2));
  for (const content of [value.slice(0, midpoint), value.slice(midpoint)]) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
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
