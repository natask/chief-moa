"use strict";

// Deterministic matcher for memory-worthy statements. NO LLM: a turn either
// matches one of these explicit patterns or it does not. The Steward writes a
// matched statement to the Brain as a durable fact/persona memory.
//
// Each matcher returns { kind, fact } where:
//   kind = "identity" | "preference" | "persona" | "note"
//   fact = the canonical sentence to store (stable phrasing, not the raw turn).
// Returns null when nothing memory-worthy is found.

// "call me Bob" / "you can call me Bob"
const CALL_ME = /\b(?:you can )?call me ([\p{L}][\p{L}\p{N} .'-]{0,60})/iu;
// "my name is Bob" / "i'm Bob" / "i am Bob"
const MY_NAME_IS = /\bmy name(?:'s| is) ([\p{L}][\p{L}\p{N} .'-]{0,60})/iu;
const I_AM_NAME = /\bi(?:'m| am) ([\p{L}][\p{L}\p{N} .'-]{0,40})$/iu;
// "remember that ..." / "please remember ..."
const REMEMBER_THAT = /\b(?:please )?remember(?: that)? (.+)/iu;
// "i prefer ..." / "i like ..." / "i'd like you to ..." / "i want you to ..."
const I_PREFER = /\bi(?: (?:prefer|like|would prefer)|'d prefer)\b (.+)/iu;
const I_WANT_YOU = /\bi(?: (?:want|would like)|'d like) you to (.+)/iu;

// Persona-style requests: how the assistant should sound. These steer the
// PERSONA the Steward recalls; they are stored as memories (the operational
// persona/config remains the agent-profile store's job — a separate Ledger).
const PERSONA_PATTERNS = [
  /\btalk to me like (.+)/iu,
  /\bspeak to me like (.+)/iu,
  /\btalk like (.+)/iu,
  /\bbe more (formal|casual|concise|brief|verbose|friendly|professional|playful|serious|terse|polite)\b/iu,
  /\bbe less (formal|casual|verbose|terse|playful|serious)\b/iu,
  /\bsound more (.+)/iu,
];

// Words that, when they trail "i am / i'm", are almost certainly NOT a name
// (so "i am tired" is not stored as the name "tired").
const NOT_A_NAME = new Set([
  "tired", "happy", "sad", "busy", "done", "ready", "good", "fine", "ok", "okay",
  "here", "sure", "back", "sorry", "confused", "lost", "hungry", "late", "early",
]);

function matchMemoryStatement(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return null;
  }

  let m = trimmed.match(CALL_ME);
  if (m) {
    const name = cleanName(m[1]);
    if (name) {
      return { kind: "identity", fact: `The user wants to be called ${name}.` };
    }
  }

  m = trimmed.match(MY_NAME_IS);
  if (m) {
    const name = cleanName(m[1]);
    if (name) {
      return { kind: "identity", fact: `The user's name is ${name}.` };
    }
  }

  m = trimmed.match(I_AM_NAME);
  if (m) {
    const name = cleanName(m[1]);
    if (name && !NOT_A_NAME.has(name.toLowerCase()) && /^[\p{Lu}]/u.test(name)) {
      return { kind: "identity", fact: `The user's name is ${name}.` };
    }
  }

  for (const pattern of PERSONA_PATTERNS) {
    const pm = trimmed.match(pattern);
    if (pm) {
      return { kind: "persona", fact: `Persona preference: the user wants the assistant to ${personaPhrase(trimmed)}.` };
    }
  }

  m = trimmed.match(I_WANT_YOU);
  if (m) {
    const detail = clip(m[1]);
    if (detail) {
      return { kind: "preference", fact: `The user wants the assistant to ${detail}.` };
    }
  }

  m = trimmed.match(I_PREFER);
  if (m) {
    const detail = clip(m[1]);
    if (detail) {
      return { kind: "preference", fact: `The user prefers ${detail}.` };
    }
  }

  m = trimmed.match(REMEMBER_THAT);
  if (m) {
    const detail = clip(m[1]);
    if (detail) {
      return { kind: "note", fact: capitalize(detail) };
    }
  }

  return null;
}

function personaPhrase(text) {
  // Store the user's own phrasing for the persona request, lightly normalized.
  return clip(text.replace(/^\s*(please\s+)?/i, "")).replace(/[.?!]+$/, "");
}

function cleanName(raw) {
  let name = String(raw).trim().replace(/[.?!,]+$/, "").trim();
  // Strip a trailing clause if the user kept talking ("call me Bob and ...").
  name = name.split(/\b(?:and|but|please|because|so)\b/i)[0].trim();
  name = name.replace(/\s+/g, " ").slice(0, 60).trim();
  if (!name) return "";
  return name;
}

function clip(raw) {
  return String(raw).trim().replace(/\s+/g, " ").replace(/[.?!]+$/, "").slice(0, 240).trim();
}

function capitalize(text) {
  const s = String(text).trim();
  const out = s.charAt(0).toUpperCase() + s.slice(1);
  return `${out}.`;
}

module.exports = { matchMemoryStatement };
