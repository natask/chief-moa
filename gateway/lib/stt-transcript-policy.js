"use strict";

// Provider language labels are evidence, not an enforcement boundary. Chirp
// can label a Devanagari transcript as am-ET, so the Geʽez/Amharic/English
// prompt also needs a deterministic script check before a candidate becomes a
// user transcript.
const ALLOWED_CHARACTER = /[\p{Script_Extensions=Latin}\p{Script_Extensions=Ethiopic}\p{Script=Common}\p{Script=Inherited}]/u;
const KNOWN_DISALLOWED_SCRIPTS = Object.freeze([
  ["Devanagari", /\p{Script_Extensions=Devanagari}/u],
  ["Arabic", /\p{Script_Extensions=Arabic}/u],
  ["Cyrillic", /\p{Script_Extensions=Cyrillic}/u],
  ["Han", /\p{Script_Extensions=Han}/u],
  ["Hebrew", /\p{Script_Extensions=Hebrew}/u],
]);
const EVIDENCE_TEXT_MAX_CHARS = 1000;

function evaluateSttTranscript(text) {
  const candidate = String(text || "").normalize("NFC").trim();
  const disallowedScripts = new Set();
  for (const character of candidate) {
    if (ALLOWED_CHARACTER.test(character)) continue;
    const known = KNOWN_DISALLOWED_SCRIPTS.find(([, pattern]) => pattern.test(character));
    disallowedScripts.add(known ? known[0] : "Other");
  }
  return {
    accepted: disallowedScripts.size === 0,
    text: candidate,
    reason: disallowedScripts.size > 0 ? "disallowed_script" : "",
    disallowed_scripts: Array.from(disallowedScripts),
  };
}

function rejectedTranscriptEvidence(evaluation, details = {}) {
  if (!evaluation || evaluation.accepted !== false) return null;
  return {
    phase: String(details.phase || "final").slice(0, 40),
    candidate_text: String(evaluation.text || "").slice(0, EVIDENCE_TEXT_MAX_CHARS),
    candidate_chars: String(evaluation.text || "").length,
    reason: evaluation.reason || "disallowed_script",
    disallowed_scripts: Array.isArray(evaluation.disallowed_scripts)
      ? evaluation.disallowed_scripts.slice(0, 8)
      : [],
    provider_language_code: String(details.providerLanguageCode || "").slice(0, 40),
  };
}

function extractSpeechTranscript(response, activeLanguageCodes = []) {
  const results = Array.isArray(response?.results) ? response.results : [];
  const restricted = new Set((Array.isArray(activeLanguageCodes) ? activeLanguageCodes : [])
    .map((code) => String(code || "").trim().toLowerCase())
    .filter((code) => code && code !== "auto"));
  let rejected = 0;
  const providerAccepted = results
    .filter((result) => {
      const languageCode = String(result?.languageCode || result?.language_code || "").trim().toLowerCase();
      if (!languageCode || restricted.size === 0 || restricted.has(languageCode)) return true;
      rejected += 1;
      return false;
    })
    .map((result) => result?.alternatives?.[0]?.transcript || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const evaluation = evaluateSttTranscript(providerAccepted);
  const languageCode = results
    .map((result) => result?.languageCode || result?.language_code || "")
    .find(Boolean) || "";
  if (!evaluation.accepted) {
    return {
      text: "",
      languageRejected: true,
      rejected_results: Math.max(1, rejected),
      rejection: rejectedTranscriptEvidence(evaluation, {
        phase: "batch_final",
        providerLanguageCode: languageCode,
      }),
    };
  }
  return {
    text: evaluation.text,
    languageRejected: rejected > 0 && !evaluation.text,
    rejected_results: rejected,
  };
}

function sttPartialTranscriptHook(hooks) {
  if (!hooks || typeof hooks.onTranscriptPartial !== "function") return null;
  return (text) => {
    const evaluation = evaluateSttTranscript(text);
    return evaluation.accepted ? hooks.onTranscriptPartial(evaluation.text) : undefined;
  };
}

function buildStreamingRecognitionConfig(options) {
  const features = { enableAutomaticPunctuation: true };
  if (options.customPrompt) {
    features.customPromptConfig = { customPrompt: options.customPrompt };
  }
  return {
    recognizer: options.recognizer,
    streamingConfig: {
      config: {
        explicitDecodingConfig: {
          encoding: "LINEAR16",
          sampleRateHertz: options.sampleRate,
          audioChannelCount: options.channels,
        },
        languageCodes: options.codes,
        model: options.model,
        features,
      },
      streamingFeatures: { interimResults: true },
    },
  };
}

function buildBatchRecognitionRequest(options) {
  const features = { enableAutomaticPunctuation: true };
  if (options.customPrompt) {
    features.customPromptConfig = { customPrompt: options.customPrompt };
  }
  return {
    config: {
      explicitDecodingConfig: {
        encoding: "LINEAR16",
        sampleRateHertz: options.sampleRate,
        audioChannelCount: options.channels,
      },
      languageCodes: options.codes,
      model: options.model,
      features,
    },
    content: Buffer.isBuffer(options.audio)
      ? options.audio.toString("base64")
      : Buffer.from(options.audio).toString("base64"),
  };
}

async function notifyTranscriptRejected(hooks, evidence) {
  if (!evidence || !hooks || typeof hooks.onTranscriptRejected !== "function") return;
  try {
    await hooks.onTranscriptRejected(evidence);
  } catch {
    // Enforcement already happened; evidence persistence must not fail a turn.
  }
}

module.exports = {
  buildBatchRecognitionRequest,
  buildStreamingRecognitionConfig,
  evaluateSttTranscript,
  extractSpeechTranscript,
  notifyTranscriptRejected,
  rejectedTranscriptEvidence,
  sttPartialTranscriptHook,
};
