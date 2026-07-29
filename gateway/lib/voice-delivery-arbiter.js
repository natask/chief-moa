"use strict";

// The delivery arbiter for the live voice observer plane.
//
// An observer PROPOSES; this module DECIDES how a proposal reaches the user.
// It is the only path from an observer to the client, and it is deliberately
// pure: `decide()` takes proposals plus a snapshot of turn state and returns
// decisions. No I/O, no timers, no session handles — so every rule below is
// directly testable, and no observer can route around it.
//
// The one invariant everything else is built on: a delivery may only move DOWN
// the ladder. Nothing an observer, a model, or a client says can raise a
// delivery above what the user allowed.

const DELIVERY_LADDER = Object.freeze(["drop", "defer", "overlay", "interject"]);
const DEFAULT_ARBITRATION_WINDOW_MS = 120;
const DEFAULT_QUIET_MS_AFTER_REPLY = 1500;
const DEFAULT_MAX_REVISION_DRIFT = 1;
const DEFAULT_MIN_INTERVAL_MS = 8000;
const OVERLAY_MIN_WATERMARK = 0.6;
const INTERJECT_MIN_WATERMARK = 0.8;
const RESTRICTED_SCRIPT_MIN_WATERMARK = 0.8;
const MAX_TEXT_CHARS = 140;
// Everything except Latin is treated as partial-unstable until per-language
// evidence says otherwise. See design.md §4.4 — this is a restriction, not a
// claim about those languages.
const UNRESTRICTED_SCRIPTS = Object.freeze(new Set(["latin"]));

// Which constraint gets the blame when several would demote to the same mode.
// Ordered most-specific first so a receipt names the reason a human would.
const DEMOTION_PRECEDENCE = Object.freeze([
  "reply_in_flight",
  "reply_quiet_period",
  "floor_not_user",
  "unstable_text",
  "unverified_digest",
  "partial_unsafe",
  "restricted_script",
  "tts_unavailable",
  "user_policy",
  "observer_ceiling",
  "requested",
]);

function modeRank(mode) {
  const index = DELIVERY_LADDER.indexOf(String(mode || ""));
  return index === -1 ? 0 : index;
}

function lowerMode(left, right) {
  return modeRank(left) <= modeRank(right) ? normalizeMode(left) : normalizeMode(right);
}

function normalizeMode(mode) {
  const value = String(mode || "").trim().toLowerCase();
  return DELIVERY_LADDER.includes(value) ? value : "drop";
}

function normalizeCeiling(mode, fallback) {
  const value = String(mode || "").trim().toLowerCase();
  if (value === "off") return "drop";
  return DELIVERY_LADDER.includes(value) ? value : fallback;
}

// The user's control surface. Default-off, and when it is on the default
// ceiling is `defer` — a bubble, not a voice. Audio is always something the
// user turned on.
function normalizeObserverPolicy(input, options = {}) {
  const source = input && typeof input === "object" ? input : {};
  const textOnlyReply = String(options.responseModality || "").trim().toLowerCase() === "text";
  const declared = normalizeCeiling(source.max_delivery, "defer");
  const perObserver = {};
  const rawPerObserver = source.per_observer && typeof source.per_observer === "object"
    ? source.per_observer
    : {};
  for (const [id, entry] of Object.entries(rawPerObserver)) {
    if (!entry || typeof entry !== "object") continue;
    perObserver[String(id)] = {
      enabled: entry.enabled !== false,
      max_delivery: normalizeCeiling(entry.max_delivery, declared),
    };
  }
  return Object.freeze({
    version: 1,
    enabled: source.enabled === true,
    // A user who asked for text replies is not asking for a second voice.
    max_delivery: textOnlyReply ? lowerMode(declared, "defer") : declared,
    per_observer: Object.freeze(perObserver),
    quiet_ms_after_reply: boundedNonNegative(source.quiet_ms_after_reply, DEFAULT_QUIET_MS_AFTER_REPLY),
    min_interval_ms: boundedNonNegative(source.min_interval_ms, DEFAULT_MIN_INTERVAL_MS),
    text_only_reply: textOnlyReply,
  });
}

function policyCeilingFor(policy, observerId) {
  if (!policy?.enabled) return "drop";
  const entry = policy.per_observer?.[String(observerId)];
  if (entry && entry.enabled === false) return "drop";
  return lowerMode(policy.max_delivery, entry ? entry.max_delivery : policy.max_delivery);
}

function scriptsAreRestricted(scripts) {
  const list = Array.isArray(scripts) ? scripts.map((value) => String(value || "").toLowerCase()) : [];
  return list.some((script) => script && !UNRESTRICTED_SCRIPTS.has(script));
}

// Hard gate. Runs before any scoring: a proposal that fails here is not ranked,
// not demoted, not delivered — it is dropped with a reason on the receipt.
function gateProposal(proposal, context) {
  const policy = context.policy;
  if (policyCeilingFor(policy, proposal.observer_id) === "drop") return "policy_disabled";
  if (!proposal.text) return "empty";
  if (String(context.turnStatus || "") !== "recording") return "inactive";
  if (context.qualityAccepted === false) return "quality_rejected";
  const ttl = boundedNonNegative(proposal.ttl_ms, 0);
  if (ttl > 0 && context.now >= Number(proposal.proposed_at || 0) + ttl) return "expired";
  const drift = Number(context.currentRevision) - Number(proposal.transcript_revision);
  if (Number.isFinite(drift) && drift > boundedNonNegative(context.maxRevisionDrift, DEFAULT_MAX_REVISION_DRIFT)) {
    return "stale";
  }
  // A digest the plane once served but has since retired means the recognizer
  // revised the words this proposal reasoned over. That is not a stale
  // proposal, it is a wrong one.
  if (proposal.stable_digest && context.retiredDigests?.has(proposal.stable_digest)) return "revised";
  return "";
}

function proposalScore(proposal) {
  return round6(
    0.5 * clamp01(proposal.urgency)
    + 0.3 * clamp01(proposal.confidence)
    + 0.2 * clamp01(proposal.stability_watermark),
  );
}

// Total order, so the same inputs always pick the same winner.
function compareProposals(left, right) {
  const byScore = proposalScore(right) - proposalScore(left);
  if (byScore !== 0) return byScore;
  const byPriority = Number(right.priority || 0) - Number(left.priority || 0);
  if (byPriority !== 0) return byPriority;
  const byTime = Number(left.proposed_at || 0) - Number(right.proposed_at || 0);
  if (byTime !== 0) return byTime;
  return String(left.observer_id).localeCompare(String(right.observer_id));
}

// Every ceiling that applies to this proposal, named. The final mode is the
// lowest of them; the receipt blames the lowest-and-earliest by precedence.
function ceilingsFor(proposal, context) {
  const ceilings = [["requested", normalizeMode(proposal.mode_request)]];
  ceilings.push(["observer_ceiling", normalizeCeiling(proposal.observer_max_delivery, "defer")]);
  ceilings.push(["user_policy", policyCeilingFor(context.policy, proposal.observer_id)]);

  // An in-flight reply outranks everything an observer has to say. A background
  // task finishing must never step on a reply the user is already hearing.
  if (context.replyInFlight) ceilings.push(["reply_in_flight", "defer"]);
  else if (Number(context.msSinceReplyEnd ?? Infinity) < boundedNonNegative(
    context.policy?.quiet_ms_after_reply, DEFAULT_QUIET_MS_AFTER_REPLY)) {
    ceilings.push(["reply_quiet_period", "defer"]);
  }
  if (context.floorHolder && context.floorHolder !== "user") ceilings.push(["floor_not_user", "defer"]);
  if (context.hostedTtsAvailable === false) ceilings.push(["tts_unavailable", "defer"]);

  // Audible delivery is only ever allowed on text the plane actually served and
  // that has settled. A proposal that reasoned over the live tail carries no
  // digest, and a forged one matches nothing.
  if (!proposal.stable_digest || !context.stableChain?.has(proposal.stable_digest)) {
    ceilings.push(["unverified_digest", "defer"]);
  }
  if (proposal.partial_safe !== true && String(proposal.trigger || "") !== "final") {
    ceilings.push(["partial_unsafe", "defer"]);
  }

  const restricted = scriptsAreRestricted(context.scripts);
  const watermark = clamp01(proposal.stability_watermark);
  if (restricted) {
    ceilings.push(["restricted_script", proposal.quotes_user === true ? "defer" : "overlay"]);
  }
  const overlayFloor = restricted ? RESTRICTED_SCRIPT_MIN_WATERMARK : OVERLAY_MIN_WATERMARK;
  if (watermark < overlayFloor) ceilings.push(["unstable_text", "defer"]);
  else if (watermark < INTERJECT_MIN_WATERMARK) ceilings.push(["unstable_text", "overlay"]);

  return ceilings;
}

function resolveMode(proposal, context) {
  const ceilings = ceilingsFor(proposal, context);
  let mode = "interject";
  for (const [, value] of ceilings) mode = lowerMode(mode, value);
  const blamed = DEMOTION_PRECEDENCE.find(
    (name) => ceilings.some(([key, value]) => key === name && normalizeMode(value) === mode),
  );
  return { mode, demoted_by: mode === normalizeMode(proposal.mode_request) ? "" : (blamed || "") };
}

// Decide one arbitration window. At most one proposal may be audible; every
// other survivor becomes a bubble or is dropped as superseded. Two observers
// firing at once therefore produce at most one voice.
function decide(proposals, context = {}) {
  const resolved = {
    ...context,
    now: Number(context.now ?? Date.now()),
    policy: context.policy?.version === 1 ? context.policy : normalizeObserverPolicy(context.policy),
  };
  const decisions = [];
  const survivors = [];
  for (const raw of Array.isArray(proposals) ? proposals : []) {
    const proposal = normalizeProposal(raw, resolved.now);
    const dropReason = gateProposal(proposal, resolved);
    if (dropReason) {
      decisions.push(dropDecision(proposal, dropReason));
      continue;
    }
    survivors.push(proposal);
  }
  survivors.sort(compareProposals);
  survivors.forEach((proposal, index) => {
    if (index === 0) {
      const { mode, demoted_by: demotedBy } = resolveMode(proposal, resolved);
      decisions.push(deliveryDecision(proposal, mode, demotedBy));
      return;
    }
    if (proposal.allow_defer_fallback === false) {
      decisions.push(dropDecision(proposal, "superseded"));
      return;
    }
    // A loser can still be a bubble, but never a second voice.
    const { mode } = resolveMode(proposal, resolved);
    const capped = lowerMode(mode, "defer");
    if (capped === "drop") decisions.push(dropDecision(proposal, "policy_disabled"));
    else decisions.push(deliveryDecision(proposal, capped, "superseded"));
  });
  return decisions;
}

function deliveryDecision(proposal, mode, demotedBy) {
  if (mode === "drop") return dropDecision(proposal, demotedBy || "policy_disabled");
  return {
    version: "moa.voice-delivery.v1",
    proposal_id: proposal.proposal_id,
    observer_id: proposal.observer_id,
    mode,
    requested_mode: normalizeMode(proposal.mode_request),
    demoted_by: demotedBy || "",
    score: proposalScore(proposal),
    text: proposal.text,
    speech_text: mode === "defer" ? "" : (proposal.speech_text || proposal.text),
    transcript_revision: proposal.transcript_revision,
    reason_code: proposal.reason_code,
  };
}

function dropDecision(proposal, reason) {
  return {
    version: "moa.voice-delivery.v1",
    proposal_id: proposal.proposal_id,
    observer_id: proposal.observer_id,
    mode: "drop",
    requested_mode: normalizeMode(proposal.mode_request),
    demoted_by: "",
    drop_reason: reason,
    score: proposalScore(proposal),
    transcript_revision: proposal.transcript_revision,
  };
}

function normalizeProposal(raw, now) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    ...source,
    observer_id: String(source.observer_id || ""),
    proposal_id: String(source.proposal_id || ""),
    mode_request: normalizeMode(source.mode_request),
    text: singleLine(source.text),
    speech_text: singleLine(source.speech_text),
    urgency: clamp01(source.urgency),
    confidence: clamp01(source.confidence),
    stability_watermark: clamp01(source.stability_watermark),
    transcript_revision: Number(source.transcript_revision) || 0,
    stable_digest: String(source.stable_digest || ""),
    proposed_at: Number(source.proposed_at) || now,
    ttl_ms: boundedNonNegative(source.ttl_ms, 0),
    reason_code: String(source.reason_code || "").slice(0, 40),
  };
}

// A content-free receipt: ids, reasons, numbers, lengths. Never the transcript
// and never the proposal text.
function deliveryReceipt(decision, extra = {}) {
  return {
    proposal_id: decision.proposal_id,
    observer_id: decision.observer_id,
    mode: decision.mode,
    requested_mode: decision.requested_mode,
    ...(decision.demoted_by ? { demoted_by: decision.demoted_by } : {}),
    ...(decision.drop_reason ? { drop_reason: decision.drop_reason } : {}),
    score: decision.score,
    transcript_revision: decision.transcript_revision,
    text_chars: decision.text ? Array.from(decision.text).length : 0,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Floor intent: the user is talking while the assistant is speaking. Do they
// mean "stop", or are they talking alongside?
//
// This does not implement barge-in. `take_floor` hands off to the existing
// path in voice-turn-steering.js (planVoiceTurnRelation closes the active turn
// as `interrupted` and admits the next one as `steering`), and `stop_now` hands
// off to the shipped silent-stop path and its interruption cutoff ledger. All
// this decides is WHEN those fire.

const DEFAULT_TAKE_FLOOR_MS = 700;
const DEFAULT_MIN_CONTENT_WORDS = 3;
const DEFAULT_REVISIT_MS = 2000;

function classifyFloorIntent(signals = {}, options = {}) {
  const takeFloorMs = boundedNonNegative(options.takeFloorMs, DEFAULT_TAKE_FLOOR_MS);
  const minContentWords = boundedNonNegative(options.minContentWords, DEFAULT_MIN_CONTENT_WORDS);
  // The user said what they meant. No threshold applies.
  if (signals.stopCue === true) {
    return { intent: "stop_now", reason: "stop_cue", revisable: false };
  }
  const speechMs = boundedNonNegative(signals.speechMs, 0);
  const contentWords = boundedNonNegative(signals.contentWords, 0);
  if (speechMs >= takeFloorMs) {
    return { intent: "take_floor", reason: "sustained_speech", revisable: false };
  }
  if (contentWords >= minContentWords) {
    return { intent: "take_floor", reason: "content_words", revisable: false };
  }
  // Cutting the assistant off wrongly destroys something the user wanted to
  // hear; being late to stop is recoverable. So the default is: keep speaking.
  return { intent: "backchannel", reason: "below_threshold", revisable: true };
}

// Upward only. A backchannel call may become a take_floor when speech keeps
// going; a taken floor is never quietly handed back.
function reviseFloorIntent(prior, signals = {}, options = {}) {
  if (!prior || prior.intent !== "backchannel" || prior.revisable === false) return prior;
  const elapsed = boundedNonNegative(signals.sinceClassifiedMs, 0);
  if (elapsed > boundedNonNegative(options.revisitMs, DEFAULT_REVISIT_MS)) {
    return { ...prior, revisable: false, reason: "revisit_window_closed" };
  }
  const next = classifyFloorIntent(signals, options);
  if (modeRankFloor(next.intent) > modeRankFloor(prior.intent)) {
    return { ...next, escalated_from: "backchannel" };
  }
  return prior;
}

function modeRankFloor(intent) {
  return ["backchannel", "take_floor", "stop_now"].indexOf(String(intent || ""));
}

function clamp01(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function singleLine(value) {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, MAX_TEXT_CHARS);
}

function boundedNonNegative(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

module.exports = {
  DEFAULT_ARBITRATION_WINDOW_MS,
  DEFAULT_MAX_REVISION_DRIFT,
  DELIVERY_LADDER,
  INTERJECT_MIN_WATERMARK,
  OVERLAY_MIN_WATERMARK,
  classifyFloorIntent,
  compareProposals,
  decide,
  deliveryReceipt,
  gateProposal,
  lowerMode,
  normalizeObserverPolicy,
  policyCeilingFor,
  proposalScore,
  resolveMode,
  reviseFloorIntent,
};
