"use strict";

const { LANGUAGE_OPTIONS } = require("./profile-options");

const LANGUAGE_LABEL_BY_CODE = new Map(
  LANGUAGE_OPTIONS.map((language) => [String(language.code || "").toLowerCase(), String(language.label || language.code || "")]),
);

function buildChirpTranscriptionPrompt(promptCodes) {
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
  return [
    "Transcribe the speaker verbatim. Do not translate, omit, or rewrite speech.",
    languageDirection,
    ...scriptDirections,
    "Preserve every language change and use each language's native writing system.",
    "When uncertain, mark or preserve the uncertain sound instead of substituting another language.",
  ].join(" ").slice(0, 2000);
}

module.exports = { buildChirpTranscriptionPrompt };
