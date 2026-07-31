#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createVoiceProvider } = require("../lib/voice-providers");

const sourcePath = path.resolve(process.argv[2] || "");
const pcmPath = resolvePcmPath(sourcePath);
if (!pcmPath || !fs.statSync(pcmPath).isFile()) throw new Error("a PCM16 file or local moa-voice-replay/v1 manifest is required");
const sourcePcm = fs.readFileSync(pcmPath);
const maxSeconds = Math.max(1, Math.min(30, Number(process.env.VOICE_EXPERIMENT_MAX_SECONDS || 12)));
const pcm = sourcePcm.subarray(0, Math.min(sourcePcm.length, maxSeconds * 16000 * 2));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-vertex-live-eval-"));
const boundedPcmPath = path.join(tempDir, "input.pcm");
fs.writeFileSync(boundedPcmPath, pcm, { mode: 0o600 });
const startedAt = Date.now();
let firstAudioMs = null;
let assistantAudioBytes = 0;
let transcript = "";
let assistantText = "";
const toolCalls = [];
const assistantAudio = [];

const env = {
  ...process.env,
  VOICE_PROVIDER: "vertex-live",
  VOICE_STT_PROVIDER: "vertex-live",
  VOICE_REASONING_PROVIDER: "vertex-live",
  VOICE_TTS_PROVIDER: "vertex-live",
};
const provider = createVoiceProvider({ env });
try {
  const result = await provider.processTurn({
    pcmPath: boundedPcmPath,
    audioBytes: pcm.length,
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    sessionId: `vertex_eval_${Date.now()}`,
    turnId: "turn_1",
    effectiveProfile: {
      system_prompt: experimentPrompt(),
      language: process.env.VOICE_EXPERIMENT_OUTPUT_LANGUAGE || "en-US",
      input_languages: process.env.VOICE_EXPERIMENT_INPUT_LANGUAGES || "en-US,am-ET",
      voice: process.env.VOICE_EXPERIMENT_VOICE || "Kore",
    },
  }, {
    onTranscriptPartial: async (text) => { transcript = String(text || transcript); },
    onTranscriptFinal: async (text) => { transcript = String(text || transcript); },
    onAssistantText: async (text) => { assistantText = String(text || assistantText); },
    onAssistantAudioStart: async () => {},
    sendAudio: async (chunk) => {
      if (firstAudioMs === null) firstAudioMs = Date.now() - startedAt;
      const value = Buffer.from(chunk);
      assistantAudio.push(value);
      assistantAudioBytes += value.length;
    },
    onAssistantAudioDone: async () => {},
    onToolCall: async (call) => {
      toolCalls.push(String(call?.name || "unknown"));
      return { ok: false, error: "tools disabled in provider experiment" };
    },
  });
  printResult({
    ok: assistantAudioBytes > 0,
    model: result.model || provider.status?.().model || "",
    transcript: transcript || result.transcript || "",
    assistant_text: assistantText || result.assistant_text || "",
    tool_calls: toolCalls,
    assistant_audio_path: writeAssistantAudio(),
  });
} catch (error) {
  process.exitCode = 1;
  printResult({ ok: false, model: provider.status?.().model || "", error: cleanError(error) });
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function printResult(fields) {
  console.log(JSON.stringify({
    ...fields,
    evaluated_at: new Date().toISOString(),
    provider: "vertex",
    source_audio: {
      path: path.basename(pcmPath),
      original_bytes: sourcePcm.length,
      evaluated_bytes: pcm.length,
      evaluated_seconds: pcm.length / (16000 * 2),
      sha256: crypto.createHash("sha256").update(pcm).digest("hex"),
    },
    first_audio_ms: firstAudioMs,
    assistant_audio_bytes: assistantAudioBytes,
  }, null, 2));
}

function resolvePcmPath(source) {
  if (!source || !fs.existsSync(source)) return "";
  if (source.endsWith(".pcm")) return source;
  const manifest = JSON.parse(fs.readFileSync(source, "utf8"));
  if (manifest.schema_version !== "moa-voice-replay/v1" || !Array.isArray(manifest.samples)) return "";
  const index = Math.max(0, Number(process.env.VOICE_EXPERIMENT_SAMPLE_INDEX || 0));
  return manifest.samples[index]?.input_audio?.local_path || "";
}

function experimentPrompt() {
  return String(process.env.VOICE_EXPERIMENT_PROMPT || "").trim()
    || "You are in a voice conversation. Answer briefly in the requested output language. Preserve intentional language switching. Do not use tools.";
}

function writeAssistantAudio() {
  const outputDir = String(process.env.VOICE_EXPERIMENT_OUTPUT_DIR || "").trim();
  if (!outputDir || assistantAudio.length === 0) return null;
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const filePath = path.resolve(outputDir, `${path.basename(pcmPath, ".pcm")}.vertex.assistant.pcm`);
  fs.writeFileSync(filePath, Buffer.concat(assistantAudio), { mode: 0o600 });
  return filePath;
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 1200);
}
