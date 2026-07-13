#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "voice-diagnosis-smoke-token";
const SESSION_ID = "diagnosis_session";
const PROVIDER_IDS = {
  native_live: "diagnosis-live",
  stt: "chirp",
  reasoning: "gateway",
  tts: "cloud-tts",
};

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-diagnosis-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    seedFixtures(dataDir);
    server = await startGateway({ port, dataDir });

    await step("auth required", () => assertAuthRequired(baseUrl));
    await step("bounded query + reasoner fault + redaction", () => assertReasoningFault(baseUrl));
    await step("tts fault attribution", () => assertTtsFault(baseUrl));
    await step("storage fault attribution", () => assertStorageFault(baseUrl));
    await step("anti-gaming negative proof", () => assertAntiGaming(baseUrl));

    console.log(JSON.stringify({
      ok: true,
      checks: [
        "GET /v1/voice/diagnosis requires a token",
        "diagnosis query is bounded and can target a stored turn",
        "reasoning faults are attributed without leaking transcript or secret-like error detail",
        "TTS faults stay distinct from playback emission when partial audio already flowed",
        "storage faults are attributed from missing archived artifacts",
        "insufficient evidence stays unknown instead of claiming a made-up root cause",
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

async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

async function assertAuthRequired(baseUrl) {
  const response = await requestJson(`${baseUrl}/v1/voice/diagnosis`, { auth: false });
  assert.equal(response.status, 401, "diagnosis query must require a token");
}

async function assertReasoningFault(baseUrl) {
  const bounded = await getJson(`${baseUrl}/v1/voice/diagnosis?session_id=${encodeURIComponent(SESSION_ID)}&limit=99`);
  assert.equal(bounded.limit, 20, "diagnosis query limit must be capped");
  assert.equal(bounded.diagnoses.length, 4, "diagnosis query must return every seeded turn in the session");

  const payload = await getJson(`${baseUrl}/v1/voice/diagnosis?session_id=${encodeURIComponent(SESSION_ID)}&turn_id=reasoning_fault`);
  assert.equal(payload.diagnoses.length, 1, "turn_id filter must isolate one diagnosis");
  const diagnosis = payload.diagnoses[0];
  assert.equal(diagnosis.primary_fault?.category, "reasoning");
  assert.equal(diagnosis.attributions.capture.status, "ok");
  assert.equal(diagnosis.attributions.transport.status, "ok");
  assert.equal(diagnosis.attributions.context.status, "ok");
  assert.equal(diagnosis.attributions.reasoning.status, "fault");
  assert.ok(diagnosis.evidence_gaps.includes("playback"), "missing playback proof must remain an evidence gap");
  assert.ok(
    diagnosis.diagnosis_events.every((event) => !("text" in event) && !("assistant_text" in event) && !("transcript" in event)),
    "diagnosis event view must omit transcript-bearing fields",
  );
  const eventJson = JSON.stringify(diagnosis.diagnosis_events);
  assert.ok(/\[redacted\]/.test(eventJson), `secret-like diagnostic text must be redacted: ${eventJson}`);
  assert.ok(!/Bearer secret-token/.test(eventJson), `raw bearer token leaked: ${eventJson}`);
  assert.ok(!/sk-live-secret/.test(eventJson), `raw API-key-like token leaked: ${eventJson}`);
  assert.ok(!/AIzaFakeSecret/.test(eventJson), `raw Google-style token leaked: ${eventJson}`);
}

async function assertTtsFault(baseUrl) {
  const payload = await getJson(`${baseUrl}/v1/voice/diagnosis?session_id=${encodeURIComponent(SESSION_ID)}&turn_id=tts_fault`);
  const diagnosis = payload.diagnoses[0];
  assert.equal(diagnosis.primary_fault?.category, "tts");
  assert.equal(diagnosis.attributions.tts.status, "fault");
  assert.equal(diagnosis.attributions.playback.status, "emitted");
  assert.ok(
    diagnosis.attributions.playback.summary.includes("client playback is not observed"),
    `playback summary must avoid claiming real client playback success: ${diagnosis.attributions.playback.summary}`,
  );
}

async function assertStorageFault(baseUrl) {
  const payload = await getJson(`${baseUrl}/v1/voice/diagnosis?session_id=${encodeURIComponent(SESSION_ID)}&turn_id=storage_fault`);
  const diagnosis = payload.diagnoses[0];
  assert.equal(diagnosis.primary_fault?.category, "storage");
  assert.equal(diagnosis.attributions.storage.status, "fault");
  assert.match(diagnosis.attributions.storage.summary, /assistant audio archive missing/);
}

async function assertAntiGaming(baseUrl) {
  const payload = await getJson(`${baseUrl}/v1/voice/diagnosis?session_id=${encodeURIComponent(SESSION_ID)}&turn_id=anti_gaming`);
  const diagnosis = payload.diagnoses[0];
  assert.equal(diagnosis.primary_fault, null, "insufficient evidence must not invent a root cause");
  assert.equal(diagnosis.attributions.reasoning.status, "unknown");
  assert.equal(diagnosis.attributions.transport.status, "unknown");
  assert.equal(diagnosis.attributions.context.status, "unknown");
  assert.equal(diagnosis.attributions.playback.status, "unknown");
}

function seedFixtures(dataDir) {
  writeFixture(dataDir, fixtureReasoningFault());
  writeFixture(dataDir, fixtureTtsFault());
  writeFixture(dataDir, fixtureStorageFault());
  writeFixture(dataDir, fixtureAntiGaming());
}

function fixtureReasoningFault() {
  const turnId = "reasoning_fault";
  const createdAt = "2026-07-10T18:01:00.000Z";
  const providerEvents = [
    event(turnId, "context_attached", { enabled: true, chars: 42, all_branches_context: true }),
    event(turnId, "capture_committed", { input_kind: "audio", audio_bytes: 640, audio_chunks: 1 }),
    event(turnId, "transport_committed", { transport: "websocket_process_turn", input_kind: "audio", committed: true }),
    event(turnId, "stage_done", { stage: "stt", duration_ms: 12, transcript_chars: 18 }),
    event(turnId, "stage_error", {
      stage: "reasoning",
      duration_ms: 44,
      error_summary: "Bearer secret-token sk-live-secret AIzaFakeSecret reasoning exploded",
    }),
    event(turnId, "turn_error", {
      duration_ms: 50,
      error_summary: "reasoning failed while planning",
      reason: "provider_error",
      stage_timings: { stt_ms: 12, reasoning_ms: 44, completion_ms: 50 },
    }),
  ];
  return {
    turnId,
    createdAt,
    transcript: "why did the model stall",
    assistantText: "",
    status: "error",
    incomplete: true,
    audioBytes: 640,
    assistantBytes: 0,
    stageTimings: { stt_ms: 12, reasoning_ms: 44, completion_ms: 50 },
    context: { enabled: true, chars: 42, all_branches_context: true },
    capture: { input_kind: "audio", audio_bytes: 640, audio_chunks: 1 },
    transport: { transport: "websocket_process_turn", input_kind: "audio", committed: true },
    providerEvents,
    error: "reasoning failed while planning",
    createUserAudio: true,
    createAssistantAudio: false,
  };
}

function fixtureTtsFault() {
  const turnId = "tts_fault";
  const createdAt = "2026-07-10T18:02:00.000Z";
  const providerEvents = [
    event(turnId, "context_attached", { enabled: true, chars: 12, all_branches_context: false }),
    event(turnId, "capture_committed", { input_kind: "audio", audio_bytes: 640, audio_chunks: 1 }),
    event(turnId, "transport_committed", { transport: "websocket_process_turn", input_kind: "audio", committed: true }),
    event(turnId, "stage_done", { stage: "stt", duration_ms: 8, transcript_chars: 11 }),
    event(turnId, "stage_done", { stage: "reasoning", duration_ms: 14, speak_chars: 16 }),
    event(turnId, "stage_done", { stage: "first_audio", duration_ms: 31, audio_bytes: 160 }),
    event(turnId, "stage_error", { stage: "tts", duration_ms: 70, error_summary: "hosted TTS upstream closed early" }),
    event(turnId, "turn_completed", {
      duration_ms: 72,
      tts_error: "hosted TTS upstream closed early",
      stage_timings: { stt_ms: 8, reasoning_ms: 14, first_audio_ms: 31, tts_ms: 70, completion_ms: 72 },
    }),
  ];
  return {
    turnId,
    createdAt,
    transcript: "read this aloud",
    assistantText: "Here is the reply.",
    status: "completed",
    incomplete: false,
    audioBytes: 640,
    assistantBytes: 160,
    stageTimings: { stt_ms: 8, reasoning_ms: 14, first_audio_ms: 31, tts_ms: 70, completion_ms: 72 },
    context: { enabled: true, chars: 12, all_branches_context: false },
    capture: { input_kind: "audio", audio_bytes: 640, audio_chunks: 1 },
    transport: { transport: "websocket_process_turn", input_kind: "audio", committed: true },
    providerEvents,
    ttsError: "hosted TTS upstream closed early",
    ttsSpoke: true,
    modality: "speech",
    createUserAudio: true,
    createAssistantAudio: true,
  };
}

function fixtureStorageFault() {
  const turnId = "storage_fault";
  const createdAt = "2026-07-10T18:03:00.000Z";
  const providerEvents = [
    event(turnId, "context_attached", { enabled: true, chars: 9, all_branches_context: false }),
    event(turnId, "capture_committed", { input_kind: "audio", audio_bytes: 640, audio_chunks: 1 }),
    event(turnId, "transport_committed", { transport: "websocket_process_turn", input_kind: "audio", committed: true }),
    event(turnId, "stage_done", { stage: "stt", duration_ms: 7, transcript_chars: 9 }),
    event(turnId, "stage_done", { stage: "reasoning", duration_ms: 11, speak_chars: 6 }),
    event(turnId, "stage_done", { stage: "tts", duration_ms: 23, audio_bytes: 320, segments: 1, spoke: true }),
    event(turnId, "turn_completed", {
      duration_ms: 25,
      stage_timings: { stt_ms: 7, reasoning_ms: 11, tts_ms: 23, completion_ms: 25 },
    }),
  ];
  return {
    turnId,
    createdAt,
    transcript: "store this",
    assistantText: "Stored.",
    status: "completed",
    incomplete: false,
    audioBytes: 640,
    assistantBytes: 320,
    stageTimings: { stt_ms: 7, reasoning_ms: 11, tts_ms: 23, completion_ms: 25 },
    context: { enabled: true, chars: 9, all_branches_context: false },
    capture: { input_kind: "audio", audio_bytes: 640, audio_chunks: 1 },
    transport: { transport: "websocket_process_turn", input_kind: "audio", committed: true },
    providerEvents,
    ttsSpoke: true,
    modality: "speech",
    createUserAudio: true,
    createAssistantAudio: false,
  };
}

function fixtureAntiGaming() {
  const turnId = "anti_gaming";
  const createdAt = "2026-07-10T18:04:00.000Z";
  return {
    turnId,
    createdAt,
    transcript: "partial turn",
    assistantText: "",
    status: "interrupted",
    incomplete: true,
    audioBytes: 0,
    assistantBytes: 0,
    stageTimings: {},
    context: {},
    capture: {},
    transport: {},
    providerEvents: [
      event(turnId, "turn_closed", { status: "interrupted" }),
    ],
    createUserAudio: false,
    createAssistantAudio: false,
  };
}

function writeFixture(dataDir, fixture) {
  const voiceTurnsDir = path.join(dataDir, "voice-turns", SESSION_ID);
  const voiceSessionsDir = path.join(dataDir, "voice-sessions", SESSION_ID);
  fs.mkdirSync(voiceTurnsDir, { recursive: true });
  fs.mkdirSync(voiceSessionsDir, { recursive: true });

  const canonical = canonicalRecord(fixture);
  fs.writeFileSync(path.join(voiceTurnsDir, `${fixture.turnId}.json`), JSON.stringify(canonical, null, 2));
  fs.writeFileSync(path.join(voiceSessionsDir, `${fixture.turnId}.json`), JSON.stringify(metadataRecord(fixture), null, 2));

  if (fixture.createUserAudio) {
    fs.writeFileSync(path.join(voiceSessionsDir, `${fixture.turnId}.pcm`), Buffer.alloc(fixture.audioBytes, 7));
  }
  if (fixture.createAssistantAudio) {
    fs.writeFileSync(path.join(voiceSessionsDir, `${fixture.turnId}.assistant.pcm`), Buffer.alloc(fixture.assistantBytes, 3));
  }
}

function canonicalRecord(fixture) {
  return {
    id: fixture.turnId,
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    branch_id: "default",
    profile_version: "profile_v0001",
    device_id: "diagnosis_device",
    source: "voice-diagnosis-smoke",
    transcript: fixture.transcript,
    transcript_source: "stt",
    classification: "chat",
    screen: null,
    created_at: fixture.createdAt,
    updated_at: fixture.createdAt,
    response: {
      turn_id: fixture.turnId,
      session_id: SESSION_ID,
      conversation_id: SESSION_ID,
      branch_id: "default",
      profile_version: "profile_v0001",
      classification: "chat",
      action: "chat",
      transcript: fixture.transcript,
      transcript_source: "stt",
      speak: fixture.assistantText,
      display: fixture.assistantText,
      text: fixture.assistantText,
      actions: [],
      agent_run: null,
      agent_runs: [],
      follow_up_expected: false,
      end_of_turn: true,
    },
    references: {
      voice_session: {
        provider: "chirp-cascaded",
        model: "diagnosis-model",
        input_languages: ["en-US"],
        reply_language: "en-US",
        tts_spoke: fixture.ttsSpoke === true,
        modality: fixture.modality || "speech",
        tts_error: fixture.ttsError || "",
        stage_timings: fixture.stageTimings || {},
        transcript_language_rejected: false,
        audio: {
          pcm_file: `${fixture.turnId}.pcm`,
          bytes: fixture.audioBytes,
          chunks: fixture.audioBytes > 0 ? 1 : 0,
        },
        assistant_audio: {
          pcm_file: `${fixture.turnId}.assistant.pcm`,
          bytes: fixture.assistantBytes,
          chunks: fixture.assistantBytes > 0 ? 1 : 0,
        },
        context: fixture.context || {},
        capture: fixture.capture || {},
        transport: fixture.transport || {},
        playback_policy: { assistant_overlap: false },
        provider_events: fixture.providerEvents,
        transcription_only: false,
        incomplete: fixture.incomplete === true,
        status: fixture.status,
        error: fixture.error || "",
      },
    },
  };
}

function metadataRecord(fixture) {
  return {
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    branch_id: "default",
    turn_id: fixture.turnId,
    profile_version: "profile_v0001",
    provider: "chirp-cascaded",
    provider_ids: PROVIDER_IDS,
    source: "voice-diagnosis-smoke",
    input_format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    playback_policy: { assistant_overlap: false },
    context: fixture.context || {},
    capture: fixture.capture || {},
    transport: fixture.transport || {},
    status: fixture.status,
    started_at: fixture.createdAt,
    updated_at: fixture.createdAt,
    audio: {
      pcm_file: `${fixture.turnId}.pcm`,
      bytes: fixture.audioBytes,
      chunks: fixture.audioBytes > 0 ? 1 : 0,
    },
    assistant_audio: {
      pcm_file: `${fixture.turnId}.assistant.pcm`,
      bytes: fixture.assistantBytes,
      chunks: fixture.assistantBytes > 0 ? 1 : 0,
    },
    provider_events: fixture.providerEvents,
    stage_timings: fixture.stageTimings || {},
  };
}

function event(turnId, type, extra = {}) {
  return {
    id: `voice_evt_${turnId}_${type}`,
    ts: "2026-07-10T18:00:00.000Z",
    type,
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    branch_id: "default",
    turn_id: turnId,
    profile_version: "profile_v0001",
    device_id: "diagnosis_device",
    provider: "chirp-cascaded",
    provider_ids: PROVIDER_IDS,
    ...extra,
  };
}

async function startGateway({ port, dataDir }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: gatewayEnv({ port, dataDir }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

function gatewayEnv({ port, dataDir }) {
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
    MOA_GATEWAY_TOKEN: TOKEN,
    MODEL_PROVIDER: "openai-compatible",
    MODEL_ID: "voice-diagnosis-smoke-model",
    MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GEMINI_API_KEY: "",
  };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Server may still be starting.
    }
    if (logs.exited) {
      throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

function collectLogs(child) {
  let stdout = "";
  let stderr = "";
  let exited = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("exit", () => {
    exited = true;
  });
  return {
    get exited() {
      return exited;
    },
    text() {
      return `${stdout}${stderr}`.trim();
    },
  };
}

async function getJson(url) {
  const response = await requestJson(url);
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: options.auth === false ? {} : { Authorization: `Bearer ${TOKEN}` },
  });
  const json = await response.json();
  return { status: response.status, json };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function onceExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
