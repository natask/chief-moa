"use strict";

const { LANGUAGE_OPTIONS } = require("./profile-options");

const LANGUAGE_LABEL_BY_CODE = new Map(
  LANGUAGE_OPTIONS.map((language) => [String(language.code || "").toLowerCase(), String(language.label || language.code || "")]),
);

function buildChirpTranscriptionPrompt(promptCodes, profile = {}) {
  const codes = (Array.isArray(promptCodes) ? promptCodes : [])
    .map((code) => String(code || "").trim())
    .filter((code) => code && code.toLowerCase() !== "auto");
  const labels = codes.map((code) => LANGUAGE_LABEL_BY_CODE.get(code.toLowerCase()) || code);
  const languageDirection = labels.length > 0
    ? `The speaker may speak or switch among ${labels.join(" and ")} within one utterance.`
    : "The speaker may switch languages within one utterance.";
  const scriptDirections = [];
  if (codes.some((code) => code.toLowerCase().startsWith("am"))) {
    scriptDirections.push("Preserve Amharic speech in Ethiopic (Ge'ez) script.");
  }
  if (codes.some((code) => code.toLowerCase().startsWith("en"))) {
    scriptDirections.push("Preserve English speech in Latin script.");
  }
  const vocabulary = String(profile?.stt_vocabulary || "").trim();
  const speakerContext = String(profile?.speaker_context || "").trim();
  return [
    "Transcribe the speaker verbatim. Do not translate, omit, or rewrite speech.",
    languageDirection,
    ...scriptDirections,
    "Preserve every language change and use each language's native writing system.",
    "When uncertain, mark or preserve the uncertain sound instead of substituting another language.",
    vocabulary ? `Prefer these exact user-provided terms, names, and spellings when the audio supports them: ${vocabulary}.` : "",
    speakerContext ? `The speaker's vocabulary/context is: ${speakerContext}. Use this only as recognition context; do not invent words that are not spoken.` : "",
  ].filter(Boolean).join(" ").slice(0, 3000);
}

module.exports = { buildChirpTranscriptionPrompt };
