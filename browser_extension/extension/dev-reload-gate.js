// Dev-reload gate: never reload the extension out from under a live turn.
//
// chrome.runtime.reload() tears down the service worker, the offscreen capture
// document and every content script. Doing that while the user is mid-sentence
// drops the microphone, the streaming reply and the typed line — the deploy
// eats the turn. A reload is never urgent enough to cost a sentence, so a
// pending version waits for idle instead.
//
// Pure: takes a plain snapshot, returns a plain decision. No chrome APIs, no
// timers. Unit-tested directly (scripts/test-dev-reload-gate.mjs) because the
// only other way to exercise it is to interrupt a real turn.

// Statuses that mean the gateway still owes this turn something.
export const LIVE_TURN_STATUSES = Object.freeze(["running", "responding", "streaming", "queued", "starting"]);
// A composing tab reports a heartbeat while there is text in the box. Older
// than this and the tab is gone, or the caret was abandoned.
export const COMPOSE_STALE_MS = 90_000;

export function liveTurnStatus(status) {
  return LIVE_TURN_STATUSES.includes(String(status || "").trim().toLowerCase());
}

// The first reason the reload must wait, or "" when nothing is in flight.
// Ordered by how much a user would lose: speech first, then a reply being
// written, then work the agent is doing, then a typed line.
export function interruptionReason(state) {
  const s = state || {};
  if (s.voiceCaptureActive) return "a voice capture is open";
  if (s.recordSessionActive) return "an audio note is recording";
  if (s.videoNoteActive) return "a video note is recording";
  if (liveTurnStatus(s.turnStatus)) return "a turn is still streaming";
  if (Number(s.agentTaskCount) > 0 || s.agentLoopActive) return "an agent run is in flight";
  if (s.composingAt && Number(s.now) - Number(s.composingAt) < COMPOSE_STALE_MS) {
    return "there is an unsent line in the typing box";
  }
  return "";
}

// What to do with a freshly observed dev-server version.
//   record  — first sighting, just remember it (no reload)
//   none    — nothing changed
//   defer   — a new version, but a turn is live; wait and re-check
//   reload  — a new version and nothing to lose
//
// A deferral never advances the stored version: the next idle poll of the same
// running dev server still sees the change and applies it. A deploy that waited
// is applied late, not skipped.
export function devReloadDecision({ nextVersion, previousVersion, state } = {}) {
  const next = Number(nextVersion || 0);
  if (!next) return { action: "none", reason: "no version served" };
  if (!previousVersion) return { action: "record", version: next, reason: "first sighting" };
  if (next === Number(previousVersion)) return { action: "none", reason: "unchanged" };
  const reason = interruptionReason(state);
  if (reason) return { action: "defer", version: next, reason };
  return { action: "reload", version: next, reason: "idle" };
}
