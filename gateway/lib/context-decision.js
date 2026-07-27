"use strict";

// Context management decision: where does this user turn belong?
//
//   continue  = same thread (the current branch)
//   new       = an unrelated fresh thread (cold start)
//   fork      = branch off the current thread, keeping its history
//   incognito = answer the turn without saving anything
//
// This is a HYBRID decision. A deterministic prior runs first; the model's
// context_management tool call may refine it, with two hard gates:
//   1. An explicit client `context_action` in the request body ALWAYS wins. The
//      model cannot override an explicit client choice (a future UI button).
//   2. The model may only choose "incognito" when the transcript carries an
//      explicit linguistic warrant (incognito / off the record / don't save /
//      private). This mirrors the liveToolAllowsProfileUpdate double gate.
//
// Everything here is pure and deterministic (no model, no IO) so it is directly
// unit-testable and can never fail a turn.

const CONTEXT_ACTIONS = ["continue", "new", "fork", "incognito"];

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeContextAction(value) {
  const v = normalize(value).replace(/ /g, "");
  return CONTEXT_ACTIONS.includes(v) ? v : "";
}

// An explicit linguistic warrant to NOT save this turn. Deliberately narrow:
// phrase-based, so a lone "private" in ordinary speech does not trigger it.
const INCOGNITO_PATTERNS = [
  /\bincognito\b/,
  /\boff the record\b/,
  /\b(do not|dont|don t) (save|record|store|remember|log|keep) (this|that|it)?\b/,
  /\b(do not|dont|don t) (save|record|store|remember|log)\b/,
  /\bkeep (this|it|that) (private|off the record|between us)\b/,
  /\bprivate (mode|conversation|chat)\b/,
  /\bno memory\b/,
  /\bforget (this|that|it) (after|when|once)\b/,
  /\bdo not keep (this|that|it)\b/,
];

function hasIncognitoWarrant(text) {
  const t = normalize(text);
  if (!t) return false;
  return INCOGNITO_PATTERNS.some((pattern) => pattern.test(t));
}

// Explicit "branch off, keep the history" phrasing.
const FORK_PATTERN = /\b(fork|branch off|branch from|split off|offshoot|side thread|tangent|spin off)\b/;
// Explicit "unrelated fresh topic" phrasing. Also catches the broker's generic
// new-work markers as a weaker fallback to lift the prior off continue.
const NEW_PATTERN = /\b(new (topic|thread|subject|conversation|chat|question)|different (topic|subject|thing|conversation)|change (the )?subject|switch topics?|unrelated|start over|starting over|forget (that|this)|something else|separate thread|clean slate)\b/;
const BROKER_NEW_WORK_PATTERN = /\b(start|new|another|different|fork|separate|besides)\b/;

function looksLikeFork(text) {
  return FORK_PATTERN.test(normalize(text));
}

function looksLikeNew(text) {
  const t = normalize(text);
  return NEW_PATTERN.test(t) || BROKER_NEW_WORK_PATTERN.test(t);
}

// The deterministic prior accepts only typed client state. Free-form text is
// interpreted by the model's context_management tool; when that tool is absent
// or fails, the safe default is to continue the current thread.
function deterministicPrior(input = {}) {
  const clientAction = normalizeContextAction(input.contextAction || input.context_action);
  if (clientAction) {
    return { action: clientAction, source: "client" };
  }
  return { action: "continue", source: "default" };
}

// Resolve the final, inspectable decision from the deterministic prior plus an
// optional model tool call. Never throws. The returned record is stored on the
// turn and mirrored as a product event.
//
//   toolCall: the raw args the model passed to context_management, or null.
function resolveContextDecision(input = {}) {
  const text = input.text || "";
  const clientAction = normalizeContextAction(input.contextAction || input.context_action);
  const prior = deterministicPrior({ text, contextAction: clientAction });
  const toolCall = input.toolCall && typeof input.toolCall === "object" ? input.toolCall : null;

  const record = {
    action: prior.action,
    prior: prior.action,
    prior_source: prior.source,
    tool_called: Boolean(toolCall),
    model_action: "",
    model_override: false,
    incognito_warrant: false,
    retrieval_query: "",
    thread_label: "",
    reason: "",
  };

  if (toolCall) {
    record.model_action = normalizeContextAction(toolCall.action);
    record.retrieval_query = String(toolCall.retrieval_query || "").slice(0, 240);
    record.thread_label = String(toolCall.thread_label || "").slice(0, 120);
    record.reason = String(toolCall.reason || "").slice(0, 400);
  }

  // Gate 1: an explicit client choice always wins; the model cannot move the
  // action, though its retrieval_query/label still enrich the record.
  if (clientAction) {
    record.action = clientAction;
    return record;
  }

  // No tool call (or the provider has no tools): the prior stands.
  if (!toolCall || !record.model_action) {
    return record;
  }

  record.action = record.model_action;
  record.model_override = record.model_action !== prior.action;
  return record;
}

// The tool schema offered to the reasoning model, alongside the profile tools.
const CONTEXT_MANAGEMENT_TOOL_SCHEMA = {
  name: "context_management",
  description: "Decide where this user turn belongs before answering. continue = same thread; new = unrelated fresh thread; fork = branch off current thread keeping its history; incognito = answer without saving. Also return retrieval_query: a short search phrase (entities/task keywords, rewritten, not verbatim) for recalling relevant past threads.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["continue", "new", "fork", "incognito"] },
      retrieval_query: { type: "string" },
      thread_label: { type: "string", description: "short label when action is new or fork" },
      reason: { type: "string" },
    },
    required: ["action", "retrieval_query"],
  },
};

// Build the tool definition for callModelToolLoop. The handler records the raw
// args into `capture` (so the caller sees the model's choice) and returns a
// bounded acknowledgement; it never persists anything itself.
function buildContextManagementToolDef(capture) {
  const sink = capture && typeof capture === "object" ? capture : {};
  return {
    name: CONTEXT_MANAGEMENT_TOOL_SCHEMA.name,
    description: CONTEXT_MANAGEMENT_TOOL_SCHEMA.description,
    parameters: CONTEXT_MANAGEMENT_TOOL_SCHEMA.parameters,
    handler(args) {
      const call = args && typeof args === "object" ? args : {};
      sink.action = call.action;
      sink.retrieval_query = call.retrieval_query;
      sink.thread_label = call.thread_label;
      sink.reason = call.reason;
      sink.called = true;
      return { ok: true, recorded: true, action: normalizeContextAction(call.action) || "continue" };
    },
  };
}

module.exports = {
  CONTEXT_ACTIONS,
  normalizeContextAction,
  hasIncognitoWarrant,
  looksLikeFork,
  looksLikeNew,
  deterministicPrior,
  resolveContextDecision,
  CONTEXT_MANAGEMENT_TOOL_SCHEMA,
  buildContextManagementToolDef,
};
