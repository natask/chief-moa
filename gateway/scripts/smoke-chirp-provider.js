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
  const state = { expected: null, lastBody: null };
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const body = JSON.parse(String(options.body || "{}"));
    state.lastBody = body;
    assert.equal(options.headers.Authorization, "Bearer test-chirp-token");
    assert.match(String(url), /^https:\/\/us-speech\.googleapis\.com\/v2\/projects\/test-project\/locations\/us\/recognizers\/_:recognize$/);
    assert.equal(body.config.model, state.expected.model);
    assert.deepEqual(body.config.languageCodes, state.expected.languageCodes);
    assert.deepEqual(body.config.explicitDecodingConfig, {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      audioChannelCount: 1,
    });
    // Restricted recognition never carries the "auto" sentinel, and it never
    // exceeds a primary + one alternative — either would flip Chirp 3 back to
    // auto language detection where languageCodes are only hints.
    assert.ok(!body.config.languageCodes.includes("auto"), "restricted config must not send the auto sentinel");
    assert.ok(body.config.languageCodes.length <= 2, "restricted config keeps primary + at most one alternative");
    assert.ok(body.content.length > 0, "request must carry base64 audio content");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [{
          alternatives: [{ transcript: "hello from chirp" }],
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
    // Case 1: the documented restricted config restricts to exactly en-US,am-ET.
    state.expected = { model: "chirp_3", languageCodes: ["en-US", "am-ET"] };
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
    assert.deepEqual(status.language_codes, ["en-US", "am-ET"]);

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

    // Case 2: restriction semantics hold even when the env fights them. An
    // "auto" sentinel, extra codes, and an older Chirp model must collapse to
    // the restricted en-US,am-ET allowlist on chirp_3 (am-ET needs chirp_3).
    state.expected = { model: "chirp_3", languageCodes: ["en-US", "am-ET"] };
    const messyProvider = createVoiceProvider({
      env: {
        VOICE_PROVIDER: "chirp",
        GCP_PROJECT_ID: "test-project",
        CHIRP_ACCESS_TOKEN: "test-chirp-token",
        CHIRP_LOCATION: "us",
        CHIRP_MODEL: "chirp_2",
        CHIRP_LANGUAGE_CODES: "auto, en-US, am-ET, fr-FR",
      },
    });
    const messyStatus = messyProvider.status();
    assert.deepEqual(messyStatus.language_codes, ["en-US", "am-ET"], "auto is stripped and the list is capped");
    assert.equal(messyStatus.model, "chirp_3", "am-ET forces the chirp_3 model");
    await messyProvider.processTurn(turn, { onTranscriptFinal: async () => {} });
    assert.equal(calls.length, 2, "second restricted turn should issue one more recognize call");

    console.log("smoke-chirp-provider: ok");
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
