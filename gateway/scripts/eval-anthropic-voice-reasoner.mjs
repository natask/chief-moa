#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const manifestPath = path.resolve(process.argv[2] || "");
if (!manifestPath || !fs.existsSync(manifestPath)) throw new Error("a moa-voice-replay/v1 manifest is required");
const apiKey = process.env.ANTHROPIC_API_KEY || "";
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is missing");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.schema_version !== "moa-voice-replay/v1" || !Array.isArray(manifest.samples)) {
  throw new Error("audio manifest must use moa-voice-replay/v1");
}
const model = process.env.VOICE_EXPERIMENT_ANTHROPIC_MODEL || "claude-haiku-4-5";
const maxSamples = Math.max(1, Math.min(100, Number(process.env.VOICE_EXPERIMENT_MAX_SAMPLES || 10)));
const results = [];
for (const sample of manifest.samples.slice(0, maxSamples)) {
  results.push(await runReasoningTurn(sample));
}
console.log(JSON.stringify({
  ok: results.every((result) => result.status === "completed"),
  evaluated_at: new Date().toISOString(),
  provider: "anthropic",
  mode: "streaming_text_reasoner",
  model,
  prompt: experimentPrompt(),
  results,
}, null, 2));

async function runReasoningTurn(sample) {
  const startedAt = Date.now();
  let firstTextMs = null;
  let text = "";
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: Math.max(16, Math.min(1024, Number(process.env.VOICE_EXPERIMENT_MAX_TOKENS || 256))),
        stream: true,
        system: experimentPrompt(),
        messages: [{ role: "user", content: String(sample.original?.transcript || "") }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Anthropic HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    for await (const event of sseEvents(response.body)) {
      if (event.type === "error") throw new Error(event.error?.message || "Anthropic stream error");
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        if (firstTextMs === null) firstTextMs = Date.now() - startedAt;
        text += String(event.delta.text || "");
      }
    }
    return {
      id: sample.id,
      status: "completed",
      first_text_ms: firstTextMs,
      duration_ms: Date.now() - startedAt,
      assistant_text: text.trim(),
      original: sample.original || null,
      follow_up: sample.follow_up || null,
    };
  } catch (error) {
    return {
      id: sample.id,
      status: "error",
      duration_ms: Date.now() - startedAt,
      error: cleanError(error),
      original: sample.original || null,
      follow_up: sample.follow_up || null,
    };
  }
}

async function* sseEvents(stream) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    const blocks = buffered.split(/\r?\n\r?\n/);
    buffered = blocks.pop() || "";
    for (const block of blocks) {
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data) yield JSON.parse(data);
    }
  }
}

function experimentPrompt() {
  const custom = String(process.env.VOICE_EXPERIMENT_PROMPT || "").trim();
  if (custom) return custom;
  const output = process.env.VOICE_EXPERIMENT_OUTPUT_LANGUAGE || "the same language as the user";
  return `You are the reasoning stage of a voice conversation. Reply directly and briefly in ${output}. Return only words that should be spoken.`;
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 1200);
}
