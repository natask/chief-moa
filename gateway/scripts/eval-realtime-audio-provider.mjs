#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const PROVIDER = process.argv[2] || "";
const AUDIO_DIR = path.resolve(process.argv[3] || "");
const SECRET_FILE = process.argv[4] || "/tmp/chief-moa-voice-eval-keys";
const configs = {
  openai: {
    model: "gpt-realtime",
    endpoint: "wss://api.openai.com/v1/realtime",
    keyName: "OPENAI_API_KEY",
    voice: "marin",
    transcriptionModel: "gpt-realtime-whisper",
    shape: "openai",
  },
  xai: {
    model: "grok-voice-latest",
    endpoint: "wss://api.x.ai/v1/realtime",
    keyName: "XAI_API_KEY",
    voice: "eve",
    transcriptionModel: "grok-transcribe",
    shape: "xai",
  },
};
const config = configs[PROVIDER];
if (!config) throw new Error("provider must be openai or xai");
if (!AUDIO_DIR || !fs.statSync(AUDIO_DIR).isDirectory()) throw new Error("audio directory is required");
const secrets = parseSecrets(fs.readFileSync(SECRET_FILE, "utf8"));
const apiKey = secrets[config.keyName] || "";
if (!apiKey) throw new Error(`${config.keyName} is missing`);

const files = fs.readdirSync(AUDIO_DIR).filter((name) => name.endsWith(".pcm")).sort();
const results = [];
for (const file of files) {
  const pcm = fs.readFileSync(path.join(AUDIO_DIR, file));
  const base = {
    id: path.basename(file, ".pcm"),
    audio_bytes: pcm.length,
    audio_sha256: sha256(pcm),
  };
  const started = Date.now();
  try {
    results.push({ ...base, status: "completed", duration_ms: 0, ...await runTurn(config, apiKey, pcm, started) });
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
  results,
}, null, 2));

function runTurn(value, key, pcm, started) {
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
    let partialCount = 0;
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
        first_audio_ms: firstAudioMs,
        transcript: transcript.trim(),
        assistant_text: assistantText.trim(),
        assistant_audio_bytes: assistantAudioBytes,
        partial_count: partialCount,
        event_types: [...eventTypes].sort(),
      });
    }

    socket.on("open", () => socket.send(JSON.stringify(sessionUpdate(value))));
    socket.on("message", (raw) => {
      let event;
      try { event = JSON.parse(String(raw)); } catch { return; }
      const type = String(event.type || "");
      if (type) eventTypes.add(type);
      if (type === "error") return finish(new Error(event.error?.message || event.message || "provider error"));
      if (type === "session.updated" && !configured) {
        configured = true;
        const audio = resamplePcm16Mono(pcm, 16000, 24000);
        for (let offset = 0; offset < audio.length; offset += 4800) {
          socket.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: audio.subarray(offset, Math.min(offset + 4800, audio.length)).toString("base64"),
          }));
        }
        socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
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
        assistantAudioBytes += Buffer.from(String(event.delta || ""), "base64").length;
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
  const prompt = "Listen carefully. Respond briefly in the same language or languages as the user. Preserve language switching. Do not use tools.";
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
