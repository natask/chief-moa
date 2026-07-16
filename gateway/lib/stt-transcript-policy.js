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

module.exports = {
  evaluateSttTranscript,
  rejectedTranscriptEvidence,
};
