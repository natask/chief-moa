#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const PROVIDER = process.argv[2] || "";
const AUDIO_SOURCE_ARG = process.argv[3] || "";
const AUDIO_SOURCE = AUDIO_SOURCE_ARG ? path.resolve(AUDIO_SOURCE_ARG) : "";
const SECRET_FILE = process.argv[4] || "";
const configs = {
  openai: {
    model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1",
    endpoint: "wss://api.openai.com/v1/realtime",
    keyName: "OPENAI_API_KEY",
    voice: "marin",
    transcriptionModel: "gpt-realtime-whisper",
    shape: "openai",
  },
  xai: {
    model: process.env.XAI_REALTIME_MODEL || "grok-voice-latest",
    endpoint: "wss://api.x.ai/v1/realtime",
    keyName: "XAI_API_KEY",
    voice: "eve",
    transcriptionModel: "grok-transcribe",
    shape: "xai",
  },
};
const config = configs[PROVIDER];
if (!config) throw new Error("provider must be openai or xai");
if (!AUDIO_SOURCE || !fs.existsSync(AUDIO_SOURCE)
    || !fs.statSync(AUDIO_SOURCE).isDirectory() && !fs.statSync(AUDIO_SOURCE).isFile()) {
  throw new Error("a PCM directory or moa-voice-replay/v1 manifest is required");
}
const secrets = SECRET_FILE ? parseSecrets(fs.readFileSync(SECRET_FILE, "utf8")) : process.env;
const apiKey = secrets[config.keyName] || "";
if (!apiKey) throw new Error(`${config.keyName} is missing`);

const maxSeconds = Math.max(1, Math.min(60, Number(process.env.VOICE_EXPERIMENT_MAX_SECONDS || 30)));
const maxSamples = Math.max(1, Math.min(100, Number(process.env.VOICE_EXPERIMENT_MAX_SAMPLES || 10)));
const outputDir = process.env.VOICE_EXPERIMENT_OUTPUT_DIR
  ? path.resolve(process.env.VOICE_EXPERIMENT_OUTPUT_DIR)
  : "";
if (outputDir) fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const inputs = loadInputs(AUDIO_SOURCE).slice(0, maxSamples);
const results = [];
for (const input of inputs) {
  const sourcePcm = fs.readFileSync(input.path);
  const pcm = sourcePcm.subarray(0, Math.min(sourcePcm.length, maxSeconds * 16000 * 2));
  const base = {
    id: input.id,
    audio_bytes: pcm.length,
    audio_sha256: sha256(pcm),
    original: input.original,
    follow_up: input.follow_up,
  };
  const started = Date.now();
  try {
    results.push({ ...base, status: "completed", duration_ms: 0, ...await runTurn(config, apiKey, pcm, started, input.id) });
    results.at(-1).duration_ms = Date.now() - started;
  } catch (error) {
    results.push({
      ...base,
      status: "error",
      duration_ms: Date.now() - started,
      error: cleanError(error),
    });
  }
}

console.log(JSON.stringify({
  ok: results.every((result) => result.status === "completed"),
  evaluated_at: new Date().toISOString(),
  provider: PROVIDER,
  model: config.model,
  endpoint: `${config.endpoint}?model=${config.model}`,
  source_audio: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
  provider_audio: { encoding: "pcm16", sample_rate: 24000, channels: 1 },
  experiment: {
    prompt: experimentPrompt(),
    input_languages: process.env.VOICE_EXPERIMENT_INPUT_LANGUAGES || "en-US,am-ET",
    output_language: process.env.VOICE_EXPERIMENT_OUTPUT_LANGUAGE || "same as user",
    max_seconds_per_sample: maxSeconds,
    max_samples: maxSamples,
  },
  results,
}, null, 2));

function runTurn(value, key, pcm, started, id) {
  return new Promise((resolve, reject) => {
    const url = `${value.endpoint}?model=${encodeURIComponent(value.model)}`;
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${key}` },
      maxPayload: 32 * 1024 * 1024,
    });
    let settled = false;
    let configured = false;
    let transcript = "";
    let assistantText = "";
    let assistantAudioBytes = 0;
    let firstAudioMs = null;
    let openedMs = null;
    let configuredMs = null;
    let committedAt = null;
    let partialCount = 0;
    const assistantAudio = [];
    const eventTypes = new Set();
    const timeout = setTimeout(() => finish(new Error(`${PROVIDER} timed out after 60000ms`)), 60_000);
    timeout.unref();

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket.close(1000, "evaluation complete"); } catch {}
      if (error) return reject(error);
      resolve({
        connection_open_ms: openedMs,
        session_configured_ms: configuredMs,
        first_audio_ms: firstAudioMs,
        first_audio_after_commit_ms: firstAudioMs === null || committedAt === null
          ? null
          : Math.max(0, firstAudioMs - committedAt),
        transcript: transcript.trim(),
        assistant_text: assistantText.trim(),
        assistant_audio_bytes: assistantAudioBytes,
        assistant_audio_path: writeAssistantAudio(id, assistantAudio),
        partial_count: partialCount,
        event_types: [...eventTypes].sort(),
      });
    }

    socket.on("open", () => {
      openedMs = Date.now() - started;
      socket.send(JSON.stringify(sessionUpdate(value)));
    });
    socket.on("message", (raw) => {
      let event;
      try { event = JSON.parse(String(raw)); } catch { return; }
      const type = String(event.type || "");
      if (type) eventTypes.add(type);
      if (type === "error") return finish(new Error(event.error?.message || event.message || "provider error"));
      if (type === "session.updated" && !configured) {
        configured = true;
        configuredMs = Date.now() - started;
        const audio = resamplePcm16Mono(pcm, 16000, 24000);
        for (let offset = 0; offset < audio.length; offset += 4800) {
          socket.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: audio.subarray(offset, Math.min(offset + 4800, audio.length)).toString("base64"),
          }));
        }
        socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        committedAt = Date.now() - started;
        socket.send(JSON.stringify({ type: "response.create" }));
      } else if (type === "conversation.item.input_audio_transcription.updated") {
        transcript = String(event.transcript || event.text || "");
        partialCount += 1;
      } else if (type === "conversation.item.input_audio_transcription.delta") {
        transcript += String(event.delta || "");
        partialCount += 1;
      } else if (type === "conversation.item.input_audio_transcription.completed") {
        transcript = String(event.transcript || transcript);
      } else if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
        assistantText += String(event.delta || "");
      } else if (type === "response.output_audio.delta" || type === "response.audio.delta") {
        if (firstAudioMs === null) firstAudioMs = Date.now() - started;
        const chunk = Buffer.from(String(event.delta || ""), "base64");
        assistantAudio.push(chunk);
        assistantAudioBytes += chunk.length;
      } else if (type === "response.done") {
        const message = event.response?.status_details?.error?.message;
        finish(message ? new Error(message) : null);
      }
    });
    socket.on("error", finish);
    socket.on("unexpected-response", (_request, response) => {
      const chunks = [];
      response.on("data", (chunk) => {
        if (chunks.reduce((total, value) => total + value.length, 0) < 4096) chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8").slice(0, 4096);
        finish(new Error(`HTTP ${response.statusCode}: ${body || "websocket upgrade rejected"}`));
      });
    });
    socket.on("close", (code, reason) => {
      if (!settled) finish(new Error(`websocket closed before response.done: ${code} ${String(reason || "")}`));
    });
  });
}

function sessionUpdate(value) {
  const prompt = experimentPrompt();
  const input = {
    format: { type: "audio/pcm", rate: 24000 },
    transcription: { model: value.transcriptionModel },
    turn_detection: null,
  };
  const output = { format: { type: "audio/pcm", rate: 24000 }, voice: value.voice };
  if (value.shape === "xai") {
    return { type: "session.update", session: {
      instructions: prompt,
      voice: value.voice,
      turn_detection: null,
      tools: [],
      audio: { input, output },
    } };
  }
  return { type: "session.update", session: {
    type: "realtime",
    model: value.model,
    instructions: prompt,
    output_modalities: ["audio"],
    tools: [],
    audio: { input, output },
  } };
}

function experimentPrompt() {
  const custom = String(process.env.VOICE_EXPERIMENT_PROMPT || "").trim();
  if (custom) return custom;
  const inputs = process.env.VOICE_EXPERIMENT_INPUT_LANGUAGES || "en-US, am-ET";
  const output = process.env.VOICE_EXPERIMENT_OUTPUT_LANGUAGE || "the same language as the user";
  return `You are in a voice conversation. Listen for ${inputs}. Reply briefly in ${output}. Preserve intentional language switching. Do not use tools.`;
}

function loadInputs(source) {
  if (fs.statSync(source).isDirectory()) {
    return fs.readdirSync(source)
      .filter((name) => name.endsWith(".pcm"))
      .sort()
      .map((name) => ({ id: path.basename(name, ".pcm"), path: path.join(source, name), original: null, follow_up: null }));
  }
  const manifest = JSON.parse(fs.readFileSync(source, "utf8"));
  if (manifest.schema_version !== "moa-voice-replay/v1" || !Array.isArray(manifest.samples)) {
    throw new Error("audio manifest must use moa-voice-replay/v1");
  }
  return manifest.samples.map((sample) => ({
    id: String(sample.id || sample.turn_id || "sample").replace(/[^a-zA-Z0-9_.-]+/g, "_"),
    path: sample.input_audio?.local_path || "",
    original: sample.original || null,
    follow_up: sample.follow_up || null,
  })).filter((input) => input.path && fs.existsSync(input.path));
}

function writeAssistantAudio(id, chunks) {
  if (!outputDir || chunks.length === 0) return null;
  const filePath = path.join(outputDir, `${String(id).replace(/[^a-zA-Z0-9_.-]+/g, "_")}.${PROVIDER}.assistant.pcm`);
  fs.writeFileSync(filePath, Buffer.concat(chunks), { mode: 0o600 });
  return filePath;
}

function parseSecrets(text) {
  const result = {};
  for (const line of String(text).split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

function resamplePcm16Mono(input, sourceRate, targetRate) {
  const source = Buffer.from(input);
  const sourceSamples = Math.floor(source.length / 2);
  const targetSamples = Math.max(1, Math.round(sourceSamples * targetRate / sourceRate));
  const output = Buffer.alloc(targetSamples * 2);
  for (let index = 0; index < targetSamples; index += 1) {
    const position = index * (sourceSamples - 1) / Math.max(1, targetSamples - 1);
    const lower = Math.floor(position);
    const upper = Math.min(sourceSamples - 1, lower + 1);
    const fraction = position - lower;
    const sample = Math.round(source.readInt16LE(lower * 2) * (1 - fraction) + source.readInt16LE(upper * 2) * fraction);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), index * 2);
  }
  return output;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cleanError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/https:\/\/console\.x\.ai\/team\/[A-Za-z0-9-]+/gi, "https://console.x.ai/team/[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1200);
}
