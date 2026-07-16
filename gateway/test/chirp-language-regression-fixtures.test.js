"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  CHIRP_PROMPT_ALLOWED_LANGUAGE_CODES,
  CHIRP_TRANSCRIPTION_PROMPT_POLICY_VERSION,
  buildChirpTranscriptionPrompt,
} = require("../lib/chirp-transcription-prompt");
const {
  buildBatchRecognitionRequest,
  evaluateSttTranscript,
} = require("../lib/stt-transcript-policy");
const {
  liveResultMetadata,
} = require("../scripts/eval-chirp-transcription-fixtures");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "voice", "chirp-language-regressions");
const corpus = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "corpus.json"), "utf8"));

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("real voice regression fixtures remain byte exact, framed, and privacy documented", () => {
  assert.equal(corpus.schema_version, 1);
  assert.equal(corpus.consent.explicit_user_authorization, true);
  assert.equal(corpus.consent.privacy_class, "real_user_speech");
  assert.match(corpus.consent.durability_notice, /Git history and clones/i);
  assert.match(corpus.ground_truth, /not established linguistic ground truth/i);
  assert.deepEqual(corpus.audio_format, {
    encoding: "PCM16LE",
    sample_rate_hz: 16000,
    channels: 1,
    frame_bytes: 2,
  });
  assert.deepEqual(corpus.fixtures.map((fixture) => fixture.file), [
    "geez-hindi-001.pcm",
    "geez-hindi-002.pcm",
  ]);

  for (const fixture of corpus.fixtures) {
    assert.doesNotMatch(JSON.stringify(fixture), /voice_|turn_|session_|branch_/i);
    const audio = fs.readFileSync(path.join(FIXTURE_DIR, fixture.file));
    assert.equal(audio.length, fixture.bytes, `${fixture.id} byte count`);
    assert.equal(sha256(audio), fixture.sha256, `${fixture.id} SHA-256`);
    assert.equal(audio.length % corpus.audio_format.frame_bytes, 0, `${fixture.id} PCM framing`);
    const durationMs = audio.length * 1000
      / (corpus.audio_format.sample_rate_hz * corpus.audio_format.channels * corpus.audio_format.frame_bytes);
    assert.equal(durationMs, fixture.duration_ms, `${fixture.id} duration`);
  }
});

test("fixture corpus pins the current provider-auto prompt request contract", () => {
  const prompt = buildChirpTranscriptionPrompt();
  assert.equal(corpus.prompt_policy.version, CHIRP_TRANSCRIPTION_PROMPT_POLICY_VERSION);
  assert.equal(sha256(Buffer.from(prompt, "utf8")), corpus.prompt_policy.sha256_utf8);
  assert.deepEqual(corpus.prompt_policy.provider_language_codes, ["auto"]);
  assert.deepEqual(corpus.prompt_policy.semantic_languages, CHIRP_PROMPT_ALLOWED_LANGUAGE_CODES);

  const audio = fs.readFileSync(path.join(FIXTURE_DIR, corpus.fixtures[0].file));
  const request = buildBatchRecognitionRequest({
    audio,
    sampleRate: 16000,
    channels: 1,
    codes: ["auto"],
    model: "chirp_3",
    customPrompt: prompt,
  });
  assert.deepEqual(request.config.languageCodes, ["auto"]);
  assert.equal(request.config.model, "chirp_3");
  assert.deepEqual(request.config.explicitDecodingConfig, {
    encoding: "LINEAR16",
    sampleRateHertz: 16000,
    audioChannelCount: 1,
  });
  assert.equal(request.config.features.enableAutomaticPunctuation, true);
  assert.equal(request.config.features.customPromptConfig.customPrompt, prompt);
  assert.equal(sha256(Buffer.from(request.content, "base64")), corpus.fixtures[0].sha256);
});

test("known Hindi substitutions fail policy while prompted Ethiopic observations pass", () => {
  for (const fixture of corpus.fixtures) {
    for (const transcript of fixture.known_bad_transcripts) {
      const result = evaluateSttTranscript(transcript);
      assert.equal(result.accepted, false, `${fixture.id} known bad transcript`);
      assert.ok(result.disallowed_scripts.includes("Devanagari"));
    }
    for (const transcript of fixture.accepted_prompted_replay_observations) {
      const result = evaluateSttTranscript(transcript);
      assert.equal(result.accepted, true, `${fixture.id} prompted replay observation`);
      assert.match(result.text, /\p{Script_Extensions=Ethiopic}/u);
    }
  }
});

test("paid live evaluator output contains metadata but no transcript content", () => {
  const fixture = corpus.fixtures[0];
  const transcript = fixture.accepted_prompted_replay_observations[0];
  const metadata = liveResultMetadata(fixture, evaluateSttTranscript(transcript));

  assert.deepEqual(metadata, {
    fixture_id: fixture.id,
    audio_bytes: fixture.bytes,
    transcript_chars: transcript.length,
    script_policy: "accepted_ethiopic_no_disallowed_script",
  });
  assert.equal(Object.hasOwn(metadata, "transcript"), false);
  assert.doesNotMatch(JSON.stringify(metadata), new RegExp(transcript, "u"));
});
