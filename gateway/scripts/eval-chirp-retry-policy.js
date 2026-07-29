#!/usr/bin/env node
"use strict";

// Paid, consent-gated Chirp 3 recognition-policy experiment. Raw transcripts
// are used in memory for scoring and are never printed or persisted.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const FIXTURE_DIR = path.join(GATEWAY_DIR, "test", "fixtures", "voice", "chirp-language-regressions");
const CORPUS_PATH = path.join(FIXTURE_DIR, "corpus.json");
const DEFAULT_OUTPUT = path.join(
  GATEWAY_DIR,
  "..",
  "reference",
  "openspec",
  "changes",
  "provider-agnostic-voice-agent-runtime",
  "chirp-retry-policy-eval-20260725.json",
);
const TRIALS = Math.max(1, Math.min(10, Number(process.env.CHIRP_EVAL_TRIALS || 5)));
const PRICE_USD_PER_MINUTE = 0.016;
const BILINGUAL_PROMPT = [
  "Transcribe the speaker verbatim. Do not translate, omit, rewrite, or summarize speech.",
  "The speaker uses only Amharic and English and may switch between them within one utterance.",
  "Preserve Amharic in Ethiopic script and English in Latin script.",
  "Preserve technical English terms, acronyms, identifiers, and protocol names exactly when supported by the audio.",
  "Do not transliterate either language and do not substitute any other language or writing system.",
].join(" ");
const VARIANTS = Object.freeze([
  { id: "auto_no_prompt", language_codes: ["auto"], prompt: "" },
  { id: "auto_bilingual_prompt", language_codes: ["auto"], prompt: BILINGUAL_PROMPT },
  { id: "am_ET_bilingual_prompt", language_codes: ["am-ET"], prompt: BILINGUAL_PROMPT },
  { id: "en_US_am_ET_no_prompt", language_codes: ["en-US", "am-ET"], prompt: "" },
  { id: "en_US_am_ET_bilingual_prompt", language_codes: ["en-US", "am-ET"], prompt: BILINGUAL_PROMPT },
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tokenize(value, unit) {
  const text = String(value || "").normalize("NFC").trim();
  return unit === "character" ? Array.from(text) : text.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function errorRate(reference, observed, unit) {
  const expected = tokenize(reference, unit);
  const actual = tokenize(observed, unit);
  return expected.length ? editDistance(expected, actual) / expected.length : (actual.length ? 1 : 0);
}

function allowedScriptsForLanguages(languageCodes) {
  const scripts = new Set();
  for (const code of languageCodes) {
    const base = String(code || "").toLowerCase().split("-")[0];
    if (base === "am" || base === "gez") scripts.add("Ethiopic");
    if (base === "en") scripts.add("Latin");
  }
  return scripts;
}

function scriptProfile(text, languageCodes) {
  const allowed = allowedScriptsForLanguages(languageCodes);
  const counts = { letters: 0, Latin: 0, Ethiopic: 0, foreign: 0 };
  const foreignCodePoints = new Set();
  for (const character of String(text || "")) {
    if (!/\p{Letter}/u.test(character)) continue;
    counts.letters += 1;
    if (/\p{Script_Extensions=Latin}/u.test(character)) counts.Latin += 1;
    else if (/\p{Script_Extensions=Ethiopic}/u.test(character)) counts.Ethiopic += 1;
    else {
      counts.foreign += 1;
      foreignCodePoints.add(`U+${character.codePointAt(0).toString(16).toUpperCase()}`);
    }
  }
  const valid = counts.foreign === 0
    && (counts.Latin === 0 || allowed.has("Latin"))
    && (counts.Ethiopic === 0 || allowed.has("Ethiopic"));
  return {
    valid,
    allowed_scripts: [...allowed].sort(),
    letter_counts: counts,
    foreign_code_points: [...foreignCodePoints].sort().slice(0, 12),
  };
}

function sanitizeTrial(result, reference, policyLanguages) {
  const text = result.text;
  const script = scriptProfile(text, policyLanguages);
  return {
    _text: text,
    transcript_sha256: sha256(Buffer.from(text.normalize("NFC"), "utf8")),
    transcript_chars: Array.from(text).length,
    script,
    provider_language_codes: [...new Set(result.languageCodes.filter(Boolean))].sort(),
    provider_confidence_available: result.confidences.length > 0,
    provider_confidence: result.confidences.length
      ? result.confidences.reduce((sum, value) => sum + value, 0) / result.confidences.length
      : null,
    alternatives_returned: result.alternatives,
    latency_ms: result.latencyMs,
    wer_to_provider_observation: reference ? errorRate(reference, text, "word") : null,
    cer_to_provider_observation: reference ? errorRate(reference, text, "character") : null,
    embedded_technical_english_terms: null,
    embedded_technical_english_note: "unmeasured: consented corpus has no user-verified technical-English reference",
  };
}

function summarizeTrials(trials) {
  const hashes = new Map();
  for (const trial of trials) hashes.set(trial.transcript_sha256, (hashes.get(trial.transcript_sha256) || 0) + 1);
  const exactAgreement = Math.max(...hashes.values()) / trials.length;
  const valid = trials.filter((trial) => trial.script.valid);
  return {
    trial_count: trials.length,
    distinct_candidate_count: hashes.size,
    exact_candidate_agreement: exactAgreement,
    all_trials_identical: hashes.size === 1,
    script_valid_trials: valid.length,
    wrong_script_rate: 1 - valid.length / trials.length,
    mean_latency_ms: trials.reduce((sum, trial) => sum + trial.latency_ms, 0) / trials.length,
    p95_latency_ms: percentile(trials.map((trial) => trial.latency_ms), 0.95),
    mean_wer_to_provider_observation: meanNullable(trials.map((trial) => trial.wer_to_provider_observation)),
    mean_cer_to_provider_observation: meanNullable(trials.map((trial) => trial.cer_to_provider_observation)),
    provider_confidence_available: trials.some((trial) => trial.provider_confidence_available),
    provider_language_code_values: [...new Set(trials.flatMap((trial) => trial.provider_language_codes))].sort(),
    stop_on_valid_request_count: trials.findIndex((trial) => trial.script.valid) + 1 || trials.length,
    fixed_n_request_count: trials.length,
    medoid_transcript_sha256: medoidHash(trials),
  };
}

function percentile(values, quantile) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] || 0;
}

function meanNullable(values) {
  const present = values.filter((value) => Number.isFinite(value));
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

function medoidHash(trials) {
  const unique = new Map(trials.map((trial) => [trial.transcript_sha256, trial]));
  let best = null;
  for (const candidate of unique.values()) {
    const distance = trials.reduce(
      (sum, trial) => sum + errorRate(candidate._text, trial._text, "character"),
      0,
    );
    if (!best || distance < best.distance) best = { hash: candidate.transcript_sha256, distance };
  }
  return best?.hash || "";
}

async function recognize({ audio, variant, token, projectId, location }) {
  const features = { enableAutomaticPunctuation: true, maxAlternatives: 3 };
  if (variant.prompt) features.customPromptConfig = { customPrompt: variant.prompt };
  const started = Date.now();
  const response = await fetch(
    `https://${location}-speech.googleapis.com/v2/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/recognizers/_:recognize`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-goog-user-project": projectId,
      },
      body: JSON.stringify({
        config: {
          explicitDecodingConfig: {
            encoding: "LINEAR16",
            sampleRateHertz: 16000,
            audioChannelCount: 1,
          },
          languageCodes: variant.language_codes,
          model: "chirp_3",
          features,
        },
        content: audio.toString("base64"),
      }),
    },
  );
  const latencyMs = Date.now() - started;
  if (!response.ok) throw new Error(`${variant.id}: Chirp HTTP ${response.status}`);
  const body = await response.json();
  const results = Array.isArray(body.results) ? body.results : [];
  return {
    text: results.map((result) => result?.alternatives?.[0]?.transcript || "").filter(Boolean).join(" ").trim(),
    languageCodes: results.map((result) => result?.languageCode || result?.language_code || ""),
    confidences: results.flatMap((result) => (result?.alternatives || [])
      .map((alternative) => Number(alternative?.confidence))
      .filter(Number.isFinite)),
    alternatives: results.reduce((sum, result) => sum + Math.max(0, (result?.alternatives || []).length), 0),
    latencyMs,
  };
}

async function main() {
  if (process.env.VOICE_EVAL_LIVE !== "1" || process.env.CHIRP_EVAL_CONSENT !== "1") {
    throw new Error("paid real-user-audio eval refused: require VOICE_EVAL_LIVE=1 and CHIRP_EVAL_CONSENT=1");
  }
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));
  if (corpus.consent?.explicit_user_authorization !== true) throw new Error("corpus does not record explicit authorization");
  const projectId = String(process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || "").trim();
  const location = String(process.env.CHIRP_LOCATION || "us").trim();
  if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT or GCP_PROJECT_ID is required");
  const token = execFileSync("gcloud", ["auth", "application-default", "print-access-token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  }).trim();
  const policyLanguages = ["am-ET", "en-US"];
  const fixtures = [];
  let requestCount = 0;
  let billedSeconds = 0;
  for (const fixture of corpus.fixtures) {
    const audio = fs.readFileSync(path.join(FIXTURE_DIR, fixture.file));
    if (audio.length !== fixture.bytes || sha256(audio) !== fixture.sha256) throw new Error(`${fixture.id}: fixture integrity failed`);
    const reference = fixture.accepted_prompted_replay_observations?.[0] || "";
    const variants = [];
    for (const variant of VARIANTS) {
      const trials = [];
      for (let trial = 0; trial < TRIALS; trial += 1) {
        const result = await recognize({ audio, variant, token, projectId, location });
        trials.push(sanitizeTrial(result, reference, policyLanguages));
        requestCount += 1;
        billedSeconds += Math.ceil(fixture.duration_ms / 1000);
      }
      const summary = summarizeTrials(trials);
      for (const trial of trials) delete trial._text;
      variants.push({
        id: variant.id,
        language_codes: variant.language_codes,
        custom_prompt_sha256: variant.prompt ? sha256(Buffer.from(variant.prompt, "utf8")) : null,
        summary,
        trials,
      });
    }
    fixtures.push({
      fixture_id: fixture.id,
      audio_bytes: fixture.bytes,
      audio_sha256: fixture.sha256,
      duration_ms: fixture.duration_ms,
      reference_kind: reference ? "prior_prompted_provider_observation_not_user_ground_truth" : "none",
      variants,
    });
  }
  const artifact = {
    schema_version: 1,
    evaluated_at: new Date().toISOString(),
    corpus_id: corpus.corpus_id,
    privacy: {
      transcript_text_persisted: false,
      audio_replicated: false,
      identifiers: "pseudonymous fixture ids only",
    },
    provider_contract: {
      provider: "google-cloud-speech-v2",
      model: "chirp_3",
      location,
      method: "Recognize",
      decoding: "explicit LINEAR16 16000Hz mono",
      prompt_field: "RecognitionConfig.features.customPromptConfig.customPrompt",
      language_semantics: {
        auto: "language-agnostic dominant-language transcription",
        explicit_list: "condition recognition on listed BCP-47 locales; result reports most likely detected language when supplied",
      },
      requested_max_alternatives: 3,
      confidence_contract: "record only if provider actually returns it",
    },
    user_policy: {
      allowed_language_codes: policyLanguages,
      allowed_scripts: [...allowedScriptsForLanguages(policyLanguages)].sort(),
      no_translation: true,
    },
    trials_per_audio_variant: TRIALS,
    request_count: requestCount,
    billed_audio_seconds_estimate: billedSeconds,
    estimated_cost_usd_at_0_016_per_minute: billedSeconds / 60 * PRICE_USD_PER_MINUTE,
    technical_english_preservation: "unmeasured: no consented user-verified technical-English reference in this corpus",
    fixtures,
  };
  const output = path.resolve(process.env.CHIRP_EVAL_OUTPUT || DEFAULT_OUTPUT);
  fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    ok: true,
    output,
    request_count: requestCount,
    estimated_cost_usd: artifact.estimated_cost_usd_at_0_016_per_minute,
    raw_transcripts_persisted: false,
  }));
}

main().catch((error) => {
  console.error(String(error?.message || error).replace(/[\r\n]+/g, " ").slice(0, 1000));
  process.exitCode = 1;
});
