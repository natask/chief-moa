"use strict";

const LETTER = /\p{Letter}/u;
const SCRIPT_PATTERNS = Object.freeze({
  latin: /\p{Script=Latin}/u,
  ethiopic: /\p{Script=Ethiopic}/u,
  devanagari: /\p{Script=Devanagari}/u,
  bengali: /\p{Script=Bengali}/u,
});
const MIN_UNEXPECTED_LETTERS = 4;
const MIN_UNEXPECTED_RATE = 0.6;

function normalizedLanguageCodes(languageCodes) {
  return (Array.isArray(languageCodes) ? languageCodes : [])
    .map((code) => String(code || "").trim().toLowerCase())
    .filter(Boolean);
}

function expectedScripts(languageCodes) {
  const codes = normalizedLanguageCodes(languageCodes);
  const scripts = new Set();
  for (const code of codes) {
    if (code === "auto") continue;
    if (code.startsWith("en")) scripts.add("latin");
    if (code.startsWith("am")) scripts.add("ethiopic");
    if (code.startsWith("hi")) scripts.add("devanagari");
    if (code.startsWith("bn")) scripts.add("bengali");
  }
  return { codes, scripts };
}

function characterScript(character) {
  for (const [script, pattern] of Object.entries(SCRIPT_PATTERNS)) {
    if (pattern.test(character)) return script;
  }
  return "other";
}

function inspectTranscriptScript(text, languageCodes = []) {
  const configured = expectedScripts(languageCodes);
  const counts = {};
  const unexpectedCodePoints = [];
  let letterCount = 0;
  let unexpectedLetters = 0;

  for (const character of String(text || "").normalize("NFC")) {
    if (!LETTER.test(character)) continue;
    letterCount += 1;
    const script = characterScript(character);
    counts[script] = (counts[script] || 0) + 1;
    if (configured.scripts.size > 0 && !configured.scripts.has(script)) {
      unexpectedLetters += 1;
      if (unexpectedCodePoints.length < 8) {
        unexpectedCodePoints.push(
          `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
        );
      }
    }
  }

  const unexpectedRate = letterCount ? unexpectedLetters / letterCount : 0;
  // A stray name, symbol, or short code-switch is not enough to discard user
  // speech. Reject only when an unexpected script dominates a non-trivial
  // transcript under an explicit input-language profile.
  const wrongScript = configured.scripts.size > 0
    && unexpectedLetters >= MIN_UNEXPECTED_LETTERS
    && unexpectedRate >= MIN_UNEXPECTED_RATE;
  return {
    accepted: !wrongScript,
    policy: configured.scripts.size > 0 ? "configured-script-dominance" : "no-script-restriction",
    configured_languages: configured.codes,
    expected_scripts: Array.from(configured.scripts),
    letter_count: letterCount,
    script_letters: counts,
    unexpected_letters: unexpectedLetters,
    unexpected_letter_rate: unexpectedRate,
    unexpected_code_points: unexpectedCodePoints,
    reason: wrongScript ? "wrong_script" : "",
  };
}

function buildTranscriptRetryPrompt(basePrompt, quality) {
  const expected = Array.isArray(quality?.expected_scripts) ? quality.expected_scripts : [];
  return [
    String(basePrompt || "").trim(),
    "Quality retry for this retained audio:",
    `- the prior hypothesis was dominated by a script outside the configured input-language profile`,
    expected.length ? `- expected scripts from that profile: ${expected.join(", ")}` : "",
    "- transcribe the audio again verbatim; preserve genuine code-switches",
    "- do not translate, transliterate, or repeat the prior hypothesis",
  ].filter(Boolean).join("\n").slice(0, 4000);
}

async function finalizeTranscriptCandidate({ text, languageCodes, retry }) {
  const initialText = String(text || "").trim();
  const initial = inspectTranscriptScript(initialText, languageCodes);
  if (initial.accepted || !initialText || typeof retry !== "function") {
    return {
      text: initial.accepted ? initialText : "",
      languageRejected: !initial.accepted,
      transcript_quality: {
        ...initial,
        attempts: 1,
        retry_performed: false,
        status: initial.accepted ? "accepted" : "rejected",
      },
    };
  }

  const retried = await retry(initial);
  const retryText = String(retried?.text || "").trim();
  const retryQuality = inspectTranscriptScript(retryText, languageCodes);
  const accepted = retryQuality.accepted && Boolean(retryText);
  return {
    ...(retried && typeof retried === "object" ? retried : {}),
    text: accepted ? retryText : "",
    languageRejected: !accepted,
    transcript_quality: {
      ...retryQuality,
      accepted,
      reason: accepted ? "" : (retryQuality.reason || "retry_empty"),
      attempts: 2,
      retry_performed: true,
      status: accepted ? "accepted_after_retry" : "rejected_after_retry",
      initial_reason: initial.reason,
      initial_script_letters: initial.script_letters,
    },
  };
}

async function finalizeRetainedAudioTranscript({
  candidate,
  languageCodes,
  basePrompt,
  retryFromAudio,
}) {
  const finalized = await finalizeTranscriptCandidate({
    text: candidate?.text,
    languageCodes,
    retry: async (quality) => retryFromAudio(buildTranscriptRetryPrompt(basePrompt, quality)),
  });
  return { ...(candidate || {}), ...finalized };
}

async function finalizeStreamingOrBatchTranscript({
  stream,
  batch,
  reportStreamingFault,
  languageCodes,
  basePrompt,
  retryFromAudio,
}) {
  let candidate = null;
  if (stream && typeof stream.finalize === "function") {
    try {
      const result = await stream.finalize();
      if (result?.ok && result.text) {
        candidate = {
          text: result.text,
          languageRejected: false,
          streaming: true,
          rotations: result.rotations || 0,
        };
      } else if (result && !result.ok && result.error) {
        reportStreamingFault(`stt_stream_result: ${result.error}`);
      }
    } catch (error) {
      reportStreamingFault(`stt_stream_finalize: ${String(error?.message || error)}`);
    }
  }
  if (!candidate) candidate = await batch();
  return finalizeRetainedAudioTranscript({
    candidate, languageCodes, basePrompt, retryFromAudio,
  });
}

function selectFinalTranscript(providerResult, providerEvents) {
  const rejected = providerResult?.transcript_quality?.accepted === false;
  const raw = String(providerResult?.transcript || "").trim();
  const result = raw === "Voice captured." || rejected ? "" : raw;
  const streamed = String(providerEvents?.transcript || "").trim();
  return {
    rejected,
    transcript: rejected ? "" : (result || streamed),
    assistantText: rejected
      ? ""
      : String(providerResult?.assistant_text || providerEvents?.assistantText || "").trim(),
  };
}

module.exports = {
  buildTranscriptRetryPrompt,
  finalizeRetainedAudioTranscript,
  finalizeStreamingOrBatchTranscript,
  finalizeTranscriptCandidate,
  inspectTranscriptScript,
  selectFinalTranscript,
};
