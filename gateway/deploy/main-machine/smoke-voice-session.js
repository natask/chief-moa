#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { WebSocket } = require("ws");

const target = process.argv[2] || process.env.MOA_VOICE_WS_URL || "ws://127.0.0.1:8787/v1/voice/sessions";
const token = process.argv[3] || process.env.MOA_GATEWAY_TOKEN || "";
const timeoutMs = Number(process.env.MOA_VOICE_SMOKE_TIMEOUT_MS || 30000);
const smokeAudio = voiceSmokePcm();
const sessionId = `smoke_${Date.now()}`;
const turnId = `turn_${Date.now()}`;
const requiredEvents = new Set([
  "session_ready",
  "transcript_final",
  "assistant_audio_start",
  "assistant_audio_done",
  "turn_done",
]);
const seenEvents = new Set();
let audioBytes = 0;

const headers = token ? { Authorization: `Bearer ${token}` } : {};
const ws = new WebSocket(target, { headers });
const timeout = setTimeout(() => {
  fail(`timed out waiting for ${target}`);
}, timeoutMs);

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "session_start",
    session_id: sessionId,
    turn_id: turnId,
    source: "main-machine-smoke",
    format: {
      encoding: "pcm16",
      sample_rate: 16000,
      channels: 1,
    },
  }));
});

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    audioBytes += Buffer.byteLength(data);
    return;
  }

  const event = JSON.parse(Buffer.from(data).toString("utf8"));
  if (event.type === "error") {
    fail(event.message || "gateway returned error");
    return;
  }

  seenEvents.add(event.type);
  if (event.type === "session_ready") {
    ws.send(smokeAudio);
    ws.send(JSON.stringify({
      type: "commit_turn",
      turn_id: turnId,
    }));
  }
  if (event.type === "turn_done") {
    finish();
  }
});

ws.on("error", (error) => {
  fail(error.message);
});

ws.on("close", () => {
  if (!seenEvents.has("turn_done")) {
    fail("websocket closed before turn_done");
  }
});

function finish() {
  const missing = [...requiredEvents].filter((event) => !seenEvents.has(event));
  if (missing.length) {
    fail(`missing events: ${missing.join(", ")}`);
    return;
  }
  if (audioBytes <= 0) {
    fail("assistant audio stream was empty");
    return;
  }
  clearTimeout(timeout);
  console.log(JSON.stringify({
    ok: true,
    target,
    session_id: sessionId,
    turn_id: turnId,
    input_audio_bytes: smokeAudio.length,
    events: [...seenEvents],
    assistant_audio_bytes: audioBytes,
  }, null, 2));
  ws.close(1000, "smoke complete");
}

function fail(message) {
  clearTimeout(timeout);
  console.error(JSON.stringify({
    ok: false,
    target,
    error: message,
    input_audio_bytes: smokeAudio.length,
    events: [...seenEvents],
    assistant_audio_bytes: audioBytes,
  }, null, 2));
  try {
    ws.close();
  } catch (error) {
    // Ignore close errors during failure reporting.
  }
  process.exitCode = 1;
}

function voiceSmokePcm() {
  const explicitPath = process.env.MOA_VOICE_SMOKE_PCM;
  if (explicitPath) {
    return fs.readFileSync(explicitPath);
  }

  if (process.platform !== "darwin") {
    return generatePcm16Tone(16000, 220, 0.2, 1200);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-smoke-"));
  const aiffPath = path.join(dir, "speech.aiff");
  const pcmPath = path.join(dir, "speech.pcm");
  try {
    const say = spawnSync("say", [
      "-o",
      aiffPath,
      "Say the word ready.",
    ], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (say.status !== 0) {
      return generatePcm16Tone(16000, 220, 0.2, 1200);
    }

    const ffmpeg = spawnSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      aiffPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      pcmPath,
    ], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (ffmpeg.status !== 0) {
      return generatePcm16Tone(16000, 220, 0.2, 1200);
    }

    const pcm = fs.readFileSync(pcmPath);
    return pcm.length > 0 ? pcm : generatePcm16Tone(16000, 220, 0.2, 1200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
