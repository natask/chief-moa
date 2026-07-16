"use strict";

const CHIRP_PROMPT_ALLOWED_LANGUAGE_CODES = Object.freeze(["gez", "am-ET", "en-US"]);
function buildChirpTranscriptionPrompt() {
  return "This speaker uses only Geʽez (ግዕዝ), Amharic (አማርኛ), and English. Transcribe verbatim in Ethiopic or Latin script as spoken; do not translate, transliterate, or use Devanagari.";
}

module.exports = {
  CHIRP_PROMPT_ALLOWED_LANGUAGE_CODES,
  buildChirpTranscriptionPrompt,
};
