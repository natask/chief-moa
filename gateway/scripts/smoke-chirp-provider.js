#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const {
  createVoiceProvider,
  generatePcm16Tone,
} = require(path.join(GATEWAY_DIR, "lib", "voice-providers"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const previousFetch = global.fetch;
  const state = { expected: null, lastBody: null, transcripts: [] };
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const body = JSON.parse(String(options.body || "{}"));
    state.lastBody = body;
    assert.equal(options.headers.Authorization, "Bearer test-chirp-token");
    assert.match(String(url), /^https:\/\/us-speech\.googleapis\.com\/v2\/projects\/test-project\/locations\/us\/recognizers\/_:recognize$/);
    assert.equal(body.config.model, state.expected.model);
    assert.deepEqual(body.config.languageCodes, ["auto"], "Chirp recognition must stay automatic");
    assert.deepEqual(body.config.explicitDecodingConfig, {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      audioChannelCount: 1,
    });
    const customPrompt = body.config.features?.customPromptConfig?.customPrompt || "";
    for (const expectedText of state.expected.promptIncludes || []) {
      assert.ok(customPrompt.includes(expectedText), `custom prompt must include ${expectedText}`);
    }
    for (const excludedText of state.expected.promptExcludes || []) {
      assert.ok(!customPrompt.includes(excludedText), `custom prompt must exclude ${excludedText}`);
    }
    assert.ok(body.content.length > 0, "request must carry base64 audio content");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [{
          alternatives: [{ transcript: state.transcripts.shift() || "hello from chirp" }],
        }],
      }),
    };
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-chirp-smoke-"));
  const pcmPath = path.join(tempDir, "turn.pcm");
  fs.writeFileSync(pcmPath, generatePcm16Tone({
    durationMs: 80,
    frequencyHz: 220,
    sampleRate: 16000,
    volume: 0.25,
  }));
  const turn = {
    pcmPath,
    audioBytes: fs.statSync(pcmPath).size,
    format: {
      encoding: "pcm16",
      sample_rate: 16000,
      channels: 1,
    },
  };

  try {
    // Case 1: provider recognition stays auto while env/profile languages shape
    // the custom prompt.
    state.expected = { model: "chirp_3", promptIncludes: ["English", "Amharic", "verbatim"] };
    const provider = createVoiceProvider({
      env: {
        VOICE_PROVIDER: "chirp",
        GCP_PROJECT_ID: "test-project",
        CHIRP_ACCESS_TOKEN: "test-chirp-token",
        CHIRP_LOCATION: "us",
        CHIRP_MODEL: "chirp_3",
        CHIRP_LANGUAGE_CODES: "en-US,am-ET",
      },
    });
    const status = provider.status();
    assert.equal(status.provider, "chirp");
    assert.equal(status.runtime_mode, "modular");
    assert.equal(status.selected_providers.stt, "chirp");
    assert.equal(status.selected_providers.reasoning, "gateway");
    assert.equal(status.selected_providers.tts, "android-tts");
    assert.equal(status.configuration.configured, true);
    assert.equal(status.capabilities.transcription_only, true);
    assert.deepEqual(status.language_codes, ["auto"]);
    assert.deepEqual(status.prompt_language_codes, ["en-US", "am-ET"]);
    assert.equal(status.custom_prompt_configured, true);

    const events = [];
    const result = await provider.processTurn(turn, {
      onTranscriptFinal: async (text) => events.push({ type: "transcript_final", text }),
    });

    assert.equal(calls.length, 1, "provider should issue one Chirp recognize call");
    assert.deepEqual(events, [{ type: "transcript_final", text: "hello from chirp" }]);
    assert.equal(result.provider, "chirp");
    assert.equal(result.model, "chirp_3");
    assert.equal(result.transcript, "hello from chirp");
    assert.equal(result.assistant_text, "");
    assert.equal(result.transcription_only, true);

    assert.equal(status.language_recognition, "auto");
    assert.equal(status.requires_chirp_3, true);
    assert.deepEqual(status.chirp_3_only_languages, []);

    // A cascaded deployment still honors a per-turn dictation request. It runs
    // Chirp and returns the literal transcript without touching reasoning or
    // TTS, which is the browser/macOS Wispr Flow replacement path.
    let reasonerCalls = 0;
    const dictationProvider = createVoiceProvider({
      env: {
        VOICE_PROVIDER: "chirp",
        VOICE_REASONING_PROVIDER: "gateway",
        VOICE_TTS_PROVIDER: "cloud-tts",
        GCP_PROJECT_ID: "test-project",
        CHIRP_ACCESS_TOKEN: "test-chirp-token",
        CHIRP_LOCATION: "us",
        CHIRP_MODEL: "chirp_3",
        CHIRP_LANGUAGE_CODES: "en-US,am-ET",
      },
      reasoner: async () => {
        reasonerCalls += 1;
        return { speak: "must not run" };
      },
    });
    state.expected = { model: "chirp_3", promptIncludes: ["English", "Amharic", "verbatim"] };
    const dictation = await dictationProvider.processTurn({
      ...turn,
      transcriptionOnly: true,
    }, {
      onTranscriptFinal: async (text) => events.push({ type: "dictation_final", text }),
    });
    assert.equal(calls.length, 2, "dictation should issue only one additional Chirp request");
    assert.equal(reasonerCalls, 0, "dictation must not run the reasoner");
    assert.equal(
      calls.filter((call) => !String(call.url).includes(":recognize")).length,
      0,
      "dictation must issue zero TTS requests",
    );
    assert.equal(dictation.transcript, "hello from chirp");
    assert.equal(dictation.assistant_text, "");
    assert.equal(dictation.transcription_only, true);

    // A turn-pinned profile change changes only the prompt, never the provider
    // recognition language code.
    state.expected = { model: "chirp_3", promptIncludes: ["Amharic", "Ethiopic"], promptExcludes: ["English"] };
    state.transcripts = ["ሰላም ከቺርፕ"];
    await provider.processTurn({
      ...turn,
      effectiveProfile: {
        input_languages: "am-ET",
        input_language_primary: "am-ET",
        speaker_context: "The speaker discusses authentication, speech systems, and mathematics.",
      },
    }, { onTranscriptFinal: async () => {} });
    assert.equal(calls.length, 3, "profile-prompt turn should issue another Chirp recognize call");

    // A streaming shortfall falls back to batch over the same stored PCM. That
    // path must retain the immutable turn-pinned context instead of consulting
    // a later global profile.
    state.expected = {
      model: "chirp_3",
      promptIncludes: ["authentication, speech systems, and mathematics", "technical terms"],
    };
    await provider.transcribePcmWindowed({
      ...turn,
      effectiveProfile: {
        input_languages: "en-US,am-ET",
        input_language_primary: "en-US",
        speaker_context: "The speaker discusses authentication, speech systems, and mathematics.",
      },
    });
    assert.equal(calls.length, 4, "batch fallback should preserve the turn-pinned speaker context");

    // A dominant unexpected-script final retries exactly once from retained
    // audio with the same profile evidence plus the bounded quality instruction.
    state.expected = {
      model: "chirp_3",
      promptIncludes: ["English", "Amharic", "verbatim"],
    };
    state.transcripts = ["यह गलत लिपि में आया", "corrected retained audio transcript"];
    const beforeQualityRetry = calls.length;
    const recovered = await provider.processTurn(turn, { onTranscriptFinal: async () => {} });
    assert.equal(calls.length - beforeQualityRetry, 2, "wrong-script recovery makes one initial request and one retry");
    assert.equal(recovered.transcript, "corrected retained audio transcript");
    assert.match(
      JSON.parse(String(calls.at(-1).options.body)).config.features.customPromptConfig.customPrompt,
      /Quality retry for this retained audio/,
    );

    // More than two prompt languages is capped at primary + one alternate so
    // the transcription instruction stays focused and bounded.
    const capped = createVoiceProvider({
      env: {
        VOICE_PROVIDER: "chirp",
        GCP_PROJECT_ID: "test-project",
        CHIRP_ACCESS_TOKEN: "test-chirp-token",
        CHIRP_MODEL: "chirp_3",
        CHIRP_LANGUAGE_CODES: "en-US,am-ET,es-ES,fr-FR",
      },
    });
    assert.deepEqual(capped.status().language_codes, ["auto"]);
    assert.deepEqual(capped.status().prompt_language_codes, ["en-US", "am-ET"], "prompt languages cap at primary + one alternate");

    // auto stays language-agnostic.
    const auto = createVoiceProvider({
      env: {
        VOICE_PROVIDER: "chirp",
        GCP_PROJECT_ID: "test-project",
        CHIRP_ACCESS_TOKEN: "test-chirp-token",
        CHIRP_MODEL: "chirp_3",
        CHIRP_LANGUAGE_CODES: "auto",
      },
    });
    assert.equal(auto.status().language_recognition, "auto");
    assert.deepEqual(auto.status().prompt_language_codes, ["auto"]);

    // am-ET on a non-chirp_3 model must refuse rather than degrade silently.
    const wrongModel = createVoiceProvider({
      env: {
        VOICE_PROVIDER: "chirp",
        GCP_PROJECT_ID: "test-project",
        CHIRP_ACCESS_TOKEN: "test-chirp-token",
        CHIRP_MODEL: "chirp_2",
        CHIRP_LANGUAGE_CODES: "en-US,am-ET",
      },
    });
    await assert.rejects(
      () => wrongModel.processTurn({ pcmPath, audioBytes: 10, format: { sample_rate: 16000, channels: 1 } }, {}),
      /requires model=chirp_3/,
      "prompt-based automatic recognition must reject non-Chirp-3 models",
    );

    console.log("smoke-chirp-provider: ok");
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
