#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const EXPECTED_TRANSCRIPTION_PROMPT = "This speaker uses only Geʽez (ግዕዝ), Amharic (አማርኛ), and English. Transcribe verbatim in Ethiopic or Latin script as spoken; do not translate, transliterate, or use Devanagari.";
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
  const state = { expected: null, lastBody: null, transcript: "hello from chirp", languageCode: "en-US" };
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const body = JSON.parse(String(options.body || "{}"));
    state.lastBody = body;
    assert.equal(options.headers.Authorization, "Bearer test-chirp-token");
    assert.match(String(url), /^https:\/\/us-speech\.googleapis\.com\/v2\/projects\/test-project\/locations\/us\/recognizers\/_:recognize$/);
    assert.equal(body.config.model, state.expected.model);
    assert.deepEqual(body.config.languageCodes, ["auto"], "every Chirp request must use provider auto");
    assert.deepEqual(body.config.explicitDecodingConfig, {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      audioChannelCount: 1,
    });
    const customPrompt = body.config.features?.customPromptConfig?.customPrompt || "";
    assert.equal(customPrompt, EXPECTED_TRANSCRIPTION_PROMPT, "all batch STT paths must use the tested concise prompt unchanged");
    for (const pattern of [/verbatim/i, /Geʽez.*Amharic.*English/i, /Ethiopic or Latin script/i, /Devanagari/i, /do not translate/i, /transliterate/i]) {
      assert.match(customPrompt, pattern, `custom prompt must match ${pattern}`);
    }
    assert.ok(body.content.length > 0, "request must carry base64 audio content");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [{
          alternatives: [{ transcript: state.transcript }],
          languageCode: state.languageCode,
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
    // Case 1: provider recognition is auto while the strong prompt names the
    // expected Geʽez/Amharic/English set and verbatim/script rules.
    state.expected = { model: "chirp_3" };
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
    assert.deepEqual(status.input_languages, ["en-US", "am-ET"]);
    assert.deepEqual(status.prompt_language_codes, ["gez", "am-ET", "en-US"]);
    assert.equal(status.prompt_constraint, "best_effort");
    assert.equal(status.custom_prompt_configured, true);
    assert.equal(status.voice_stt.streaming_recognition, true, "provider auto must remain streaming-capable");
    const streamingConfig = provider.streamingRecognitionConfig(
      provider.sttLanguageCodes(),
      16000,
      1,
      provider.sttTranscriptionPrompt({ input_languages: "gez,am-ET,en-US" }),
    );
    assert.deepEqual(streamingConfig.streamingConfig.config.languageCodes, ["auto"], "streaming STT must use provider auto");
    assert.equal(streamingConfig.streamingConfig.config.features.customPromptConfig.customPrompt, EXPECTED_TRANSCRIPTION_PROMPT, "streaming STT must use the tested concise prompt unchanged");
    assert.match(streamingConfig.streamingConfig.config.features.customPromptConfig.customPrompt, /Geʽez.*Amharic.*English/i);
    assert.match(streamingConfig.streamingConfig.config.features.customPromptConfig.customPrompt, /Devanagari/i);

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

    // Geʽez remains a semantic profile language; it is never mapped to am-ET on
    // STT. Only the prompt changes emphasis while provider recognition is auto.
    state.expected = { model: "chirp_3" };
    const geezProvider = createVoiceProvider({
      env: {
        VOICE_PROVIDER: "chirp",
        GCP_PROJECT_ID: "test-project",
        CHIRP_ACCESS_TOKEN: "test-chirp-token",
        CHIRP_LOCATION: "us",
        CHIRP_MODEL: "chirp_3",
      },
      agentProfile: {
        effective: () => ({
          input_languages: "gez",
          input_language_primary: "gez",
          language: "gez",
          language_primary: "gez",
        }),
      },
    });
    assert.deepEqual(geezProvider.status().input_languages, ["gez"]);
    assert.deepEqual(geezProvider.status().language_codes, ["auto"]);
    assert.equal(geezProvider.status().language_compatibility_mode, true);
    await geezProvider.processTurn({
      ...turn,
      effectiveProfile: {
        input_languages: "gez",
        input_language_primary: "gez",
        language: "gez",
        language_primary: "gez",
      },
    }, {
      onTranscriptFinal: async () => {},
    });
    assert.equal(calls.length, 2, "Geʽez prompt turn should issue one additional recognize call");

    // A real failure observed under auto+prompt mixed Devanagari with Ethiopic
    // while reporting an allowed language. Script policy, not the provider
    // label, is the enforcement boundary.
    state.transcript = "वायरस सभा አንቺ...";
    state.languageCode = "am-ET";
    const rejectedEvents = [];
    const rejected = await geezProvider.processTurn({
      ...turn,
      effectiveProfile: {
        input_languages: "gez,am-ET,en-US",
        input_language_primary: "gez",
        language: "gez",
        language_primary: "gez",
      },
    }, {
      onTranscriptFinal: async (text) => rejectedEvents.push({ type: "transcript_final", text }),
      onTranscriptRejected: async (evidence) => rejectedEvents.push({ type: "stt_candidate_rejected", evidence }),
    });
    assert.equal(calls.length, 3, "rejected batch candidate still uses exactly one provider request");
    assert.equal(rejected.transcript, "", "rejected candidate must not become the provider transcript");
    assert.equal(rejected.transcript_language_rejected, true);
    assert.equal(rejected.transcript_rejection_reason, "disallowed_script");
    assert.equal(rejectedEvents.some((event) => event.type === "transcript_final"), false, "rejected text must not reach the final transcript hook");
    const rejectionEvent = rejectedEvents.find((event) => event.type === "stt_candidate_rejected");
    assert.equal(rejectionEvent.evidence.candidate_text, "वायरस सभा አንቺ...");
    assert.deepEqual(rejectionEvent.evidence.disallowed_scripts, ["Devanagari"]);
    assert.equal(rejectionEvent.evidence.provider_language_code, "am-ET", "allowed provider label must not bypass script policy");
    state.transcript = "hello from chirp";
    state.languageCode = "en-US";

    assert.equal(status.language_recognition, "auto");
    assert.equal(status.requires_chirp_3, true);
    assert.deepEqual(status.chirp_3_only_languages, []);

    // Semantic input selection remains visible but never changes provider auto.
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
    assert.deepEqual(capped.status().input_languages, ["en-US", "am-ET", "es-ES"], "semantic input state stays auditable and bounded");

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
    assert.equal(auto.status().language_recognition, "auto", "CHIRP_LANGUAGE_CODES=auto must stay language-agnostic");

    // Prompt-based provider auto requires Chirp 3.
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
      "automatic prompt-based STT with chirp_2 must be rejected",
    );

    console.log("smoke-chirp-provider: ok");
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
