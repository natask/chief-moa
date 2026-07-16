#!/usr/bin/env node
"use strict";

// Paid, explicit live regression eval. It sends only the committed PCM to the
// production Chirp STT request path; it does not invoke an LLM or TTS provider.

const fs = require("node:fs");
const path = require("node:path");
const { evaluateSttTranscript } = require("../lib/stt-transcript-policy");

const FIXTURE_DIR = path.join(__dirname, "..", "test", "fixtures", "voice", "chirp-language-regressions");
const corpus = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "corpus.json"), "utf8"));

function liveResultMetadata(fixture, evaluation) {
  return {
    fixture_id: fixture.id,
    audio_bytes: fixture.bytes,
    transcript_chars: evaluation.text.length,
    script_policy: "accepted_ethiopic_no_disallowed_script",
  };
}

async function main() {
  const liveRequested = process.argv.slice(2).some((arg) => arg === "live" || arg === "--live");
  if (!liveRequested) {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: "network-free default; pass live and set VOICE_EVAL_LIVE=1 for paid Chirp STT",
      corpus_id: corpus.corpus_id,
      fixture_count: corpus.fixtures.length,
    }));
    return;
  }
  if (process.env.VOICE_EVAL_LIVE !== "1") {
    throw new Error("paid live eval refused: set VOICE_EVAL_LIVE=1 and pass live explicitly");
  }

  const { createVoiceProvider } = require("../lib/voice-providers");
  const provider = createVoiceProvider({
    env: {
      ...process.env,
      VOICE_PROVIDER: "chirp",
      VOICE_STT_PROVIDER: "chirp",
      VOICE_REASONING_PROVIDER: "gateway",
      VOICE_TTS_PROVIDER: "none",
      CHIRP_MODEL: "chirp_3",
      CHIRP_LANGUAGE_CODES: "auto",
      CHIRP_PROMPT_LANGUAGE_CODES: "gez,am-ET,en-US",
    },
  });
  if (!provider.configured()) {
    throw new Error("Chirp is not configured; provide a GCP project and production-supported Google credentials");
  }

  const results = [];
  for (const fixture of corpus.fixtures) {
    const pcmPath = path.join(FIXTURE_DIR, fixture.file);
    const transcription = await provider.transcribePcmFile({
      pcmPath,
      audioBytes: fixture.bytes,
      format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
      effectiveProfile: {
        input_languages: "gez,am-ET,en-US",
        input_language_primary: "gez",
      },
    }, ["gez", "am-ET", "en-US"]);
    const evaluation = evaluateSttTranscript(transcription.text);
    if (!evaluation.text) throw new Error(`${fixture.id}: Chirp returned an empty transcript`);
    if (!evaluation.accepted) {
      throw new Error(`${fixture.id}: transcript violated script policy (${evaluation.disallowed_scripts.join(",")})`);
    }
    if (!/\p{Script_Extensions=Ethiopic}/u.test(evaluation.text)) {
      throw new Error(`${fixture.id}: transcript contained no Ethiopic text`);
    }
    results.push(liveResultMetadata(fixture, evaluation));
  }

  console.log(JSON.stringify({
    ok: true,
    live: true,
    paid_provider_calls: results.length,
    provider: "chirp",
    model: "chirp_3",
    language_codes: ["auto"],
    prompt_policy_version: corpus.prompt_policy.version,
    results,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(String(error?.message || error).replace(/[\r\n]+/g, " ").slice(0, 1000));
    process.exitCode = 1;
  });
}

module.exports = {
  liveResultMetadata,
};
