"use strict";

const CONTRACT_VERSION = "moa.voice-turn-relation.v1";
const ASSISTANT_ACTIVE_STATUSES = new Set(["committed", "playback"]);
const FRESH_CONTEXT_ACTIONS = new Set(["new", "fork", "incognito"]);
const TERMINAL_STATUSES = new Set(["completed", "canceled", "error", "closed", "interrupted", "replaced", "no_speech"]);
const PENDING_TTL_MS = 30_000;
const PENDING_MAX = 64;

function planVoiceTurnRelation(activeTurn, nextTurn, options = {}) {
  if (!activeTurn) return null;
  const boundaryId = String(options.boundaryId || "").trim();
  if (!boundaryId) throw new Error("boundaryId is required");

  const assistantActive = ASSISTANT_ACTIVE_STATUSES.has(String(activeTurn.status || ""));
  const sameThread = sameIdentity(activeTurn.sessionId, nextTurn.sessionId)
    && sameIdentity(activeTurn.conversationId || activeTurn.sessionId, nextTurn.conversationId || nextTurn.sessionId)
    && sameIdentity(activeTurn.branchId || "default", nextTurn.branchId || "default")
    && !FRESH_CONTEXT_ACTIONS.has(String(nextTurn.contextAction || "").trim().toLowerCase());
  const kind = assistantActive && sameThread ? "steering" : (assistantActive ? "fresh_thread" : "replacement");
  const common = {
    version: CONTRACT_VERSION,
    boundary_id: boundaryId,
    kind,
    occurred_at: String(options.occurredAt || new Date().toISOString()),
    assistant_audio_policy: assistantActive ? "stop" : "not_applicable",
    provider_tail_policy: assistantActive ? "cancel_and_drop_late_output" : "not_applicable",
    partial_text_policy: assistantActive ? "persist_on_superseded_turn" : "not_applicable",
    inherit_partial_context: kind === "steering",
  };
  return {
    prior: {
      ...common,
      role: "superseded_turn",
      turn_id: String(activeTurn.turnId || ""),
      next_turn_id: String(nextTurn.turnId || ""),
    },
    next: {
      ...common,
      role: "admitted_turn",
      turn_id: String(nextTurn.turnId || ""),
      superseded_turn_id: String(activeTurn.turnId || ""),
    },
    closeStatus: assistantActive ? "interrupted" : "replaced",
  };
}

function sameIdentity(left, right) {
  return String(left || "") === String(right || "");
}

function createVoiceTurnSteeringCoordinator({ connections = new Set(), pending = new Map() } = {}) {
  function sameOwner(active, next, requireDevice = false) {
    if (!sameIdentity(active?.sessionId, next?.sessionId)) return false;
    if (!sameIdentity(active?.conversationId || active?.sessionId,
      next?.conversationId || next?.sessionId)) return false;
    const left = String(active?.deviceId || "");
    const right = String(next?.deviceId || "");
    return !(requireDevice && (!left || !right)) && (!left || !right || left === right);
  }
  function prune() {
    const now = Date.now();
    for (const [turnId, entry] of pending) {
      if (!entry?.expiresAt || entry.expiresAt <= now) pending.delete(turnId);
    }
  }
  return {
    findActive(current, next) {
      const candidates = [current, ...connections]
        .filter((item, index, list) => item && list.indexOf(item) === index)
        .filter((item) => item.turn && !TERMINAL_STATUSES.has(item.turn.status))
        .filter((item) => sameOwner(item.turn, next, item !== current));
      candidates.sort((a, b) => Date.parse(b.turn.startedAt || 0) - Date.parse(a.turn.startedAt || 0));
      return candidates[0] || null;
    },
    take(next) {
      prune();
      const entry = pending.get(String(next.turnId || ""));
      if (!entry || !sameOwner(entry.owner, next, true)) return null;
      pending.delete(String(next.turnId || ""));
      return entry;
    },
    store(nextTurnId, entry) {
      prune();
      while (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value);
      pending.set(nextTurnId, { ...entry, expiresAt: Date.now() + PENDING_TTL_MS });
    },
  };
}

module.exports = { CONTRACT_VERSION, createVoiceTurnSteeringCoordinator, planVoiceTurnRelation };
