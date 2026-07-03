// agee — stop-intent matcher.
//
// The one local fast path that stays in the client: saying or typing "stop",
// "shut up", or "be quiet" must halt the assistant immediately and silently. It
// must not route through the gateway or any model, and it must not produce a
// spoken or written acknowledgment beyond a minimal visual state change.
//
// isStopCommand(text) -> true when the whole utterance is a request to stop.
//
// Conservative on purpose: it matches a whole or near-whole utterance so a real
// instruction like "stop opening tabs" or "stop sharing my location" is NOT
// swallowed. A trailing politeness ("stop please", "shut up now") is fine.
//
// A dependency-free ES module so background.js (module service worker) can
// import it and it stays unit-testable. content.js is a classic content-script
// IIFE and cannot import modules, so it mirrors this matcher inline; the verify
// harness pins the two copies together.

// Whole-utterance stop phrases. Kept short and unambiguous.
const STOP_PHRASES = [
  "stop",
  "stop it",
  "stop talking",
  "stop speaking",
  "shut up",
  "be quiet",
  "quiet",
  "silence",
  "hush",
  "enough",
];

// Trailing words that do not change the meaning of a stop command.
const TRAILING_FILLERS = ["please", "now", "already", "ok", "okay", "agee", "a g"];

function normalizeStopCommand(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Drop trailing filler words so "stop please" and "shut up now" still match the
// bare phrase, without letting a real object phrase ("stop opening tabs") slip
// through: only known fillers are stripped, and only from the end.
function stripTrailingFillers(lower) {
  let words = lower.split(" ").filter(Boolean);
  let changed = true;
  while (changed && words.length > 1) {
    changed = false;
    const last = words[words.length - 1];
    if (TRAILING_FILLERS.includes(last)) {
      words = words.slice(0, -1);
      changed = true;
    }
  }
  return words.join(" ");
}

function isStopCommand(text) {
  const lower = normalizeStopCommand(text);
  if (!lower) return false;
  const core = stripTrailingFillers(lower);
  return STOP_PHRASES.includes(core);
}

export { isStopCommand, STOP_PHRASES, TRAILING_FILLERS };
