"use strict";

const CONTRACT_VERSION = "moa.voice-turn-relation.v1";
const ASSISTANT_ACTIVE_STATUSES = new Set(["committed", "playback"]);
const FRESH_CONTEXT_ACTIONS = new Set(["new", "fork", "incognito"]);

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

module.exports = { CONTRACT_VERSION, planVoiceTurnRelation };
