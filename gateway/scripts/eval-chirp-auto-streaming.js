#!/usr/bin/env node
"use strict";

// Paid, opt-in provider probe. Replays raw 16 kHz mono LINEAR16 PCM through the
// same Chirp 3 streaming path used by a live voice turn and prints the final
// transcript. It never writes the supplied audio.

const fs = require("node:fs");
const path = require("node:path");
const { createVoiceProvider, resetVoiceStreamingBreakerForTests } = require("../lib/voice-providers");

async function main() {
  const audioPath = path.resolve(String(process.argv[2] || ""));
  if (!process.argv[2] || !fs.statSync(audioPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("usage: node scripts/eval-chirp-auto-streaming.js AUDIO.pcm [PROMPT_LANGUAGE_CODES]");
  }
  const promptLanguageCodes = String(process.argv[3] || "am-ET,en-US").trim() || "am-ET,en-US";
  const projectId = String(process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "").trim();
  if (!projectId) {
    throw new Error("GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT is required");
  }

  resetVoiceStreamingBreakerForTests();
  const provider = createVoiceProvider({
    env: {
      ...process.env,
      VOICE_PROVIDER: "chirp",
      VOICE_STT_PROVIDER: "chirp",
      VOICE_REASONING_PROVIDER: "gateway",
      VOICE_TTS_PROVIDER: "none",
      VOICE_STT_STREAMING: "1",
      GCP_PROJECT_ID: projectId,
      CHIRP_LOCATION: process.env.CHIRP_LOCATION || "us",
      CHIRP_MODEL: "chirp_3",
      CHIRP_PROMPT_LANGUAGE_CODES: promptLanguageCodes,
    },
  });
  const turn = {
    turnId: `chirp-auto-stream-eval-${Date.now()}`,
    format: { sample_rate: 16000, channels: 1 },
    effectiveProfile: {
      input_languages: promptLanguageCodes,
      input_language_primary: promptLanguageCodes.split(",")[0],
    },
  };
  const partials = [];
  const session = provider.createStreamingSttSession(turn, {
    onTranscriptPartial: (text) => partials.push(String(text || "")),
  });
  if (!session) {
    throw new Error("Chirp streaming session could not be created; check ADC credentials and streaming status");
  }

  const audio = fs.readFileSync(audioPath);
  const chunkBytes = 3200; // 100 ms at 16 kHz, PCM16 mono
  for (let offset = 0; offset < audio.length; offset += chunkBytes) {
    session.push(audio.subarray(offset, Math.min(offset + chunkBytes, audio.length)));
  }
  const result = await session.finalize();
  if (!result.ok || !result.text) {
    throw new Error(`Chirp streaming returned no usable transcript: ${result.error || "empty transcript"}`);
  }
  console.log(JSON.stringify({
    ok: true,
    model: "chirp_3",
    recognition_language_codes: ["auto"],
    prompt_language_codes: promptLanguageCodes.split(",").map((code) => code.trim()).filter(Boolean).slice(0, 2),
    transcript: result.text,
    provider_language_code: result.languageCode || "",
    partial_count: partials.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
