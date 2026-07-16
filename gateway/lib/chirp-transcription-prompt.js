"use strict";

const CHIRP_PROMPT_ALLOWED_LANGUAGE_CODES = Object.freeze(["gez", "am-ET", "en-US"]);
const CHIRP_TRANSCRIPTION_PROMPT_POLICY_VERSION = "chirp-geez-amharic-english-v1";
function buildChirpTranscriptionPrompt() {
  return "This speaker uses only Geʽez (ግዕዝ), Amharic (አማርኛ), and English. Transcribe verbatim in Ethiopic or Latin script as spoken; do not translate, transliterate, or use Devanagari.";
}

module.exports = {
  CHIRP_PROMPT_ALLOWED_LANGUAGE_CODES,
  CHIRP_TRANSCRIPTION_PROMPT_POLICY_VERSION,
  buildChirpTranscriptionPrompt,
};
