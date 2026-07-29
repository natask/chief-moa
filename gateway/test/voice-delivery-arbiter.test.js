"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  classifyFloorIntent,
  decide,
  deliveryReceipt,
  normalizeObserverPolicy,
  proposalScore,
  resolveMode,
  reviseFloorIntent,
} = require("../lib/voice-delivery-arbiter");

const DIGEST = "sha256:abcdef";

function baseContext(overrides = {}) {
  return {
    now: 1_000_000,
    policy: normalizeObserverPolicy({ enabled: true, max_delivery: "interject" }),
    turnStatus: "recording",
    currentRevision: 10,
    stableChain: new Set([DIGEST]),
    retiredDigests: new Set(),
    replyInFlight: false,
    msSinceReplyEnd: 60_000,
    floorHolder: "user",
    scripts: ["latin"],
    qualityAccepted: true,
    hostedTtsAvailable: true,
    ...overrides,
  };
}

function proposal(overrides = {}) {
  return {
    observer_id: "alpha",
    proposal_id: "prop_alpha_1",
    mode_request: "interject",
    text: "say it this way",
    urgency: 0.5,
    confidence: 0.8,
    stability_watermark: 0.9,
    transcript_revision: 10,
    stable_digest: DIGEST,
    proposed_at: 1_000_000,
    ttl_ms: 4000,
    partial_safe: true,
    trigger: "pause",
    observer_max_delivery: "interject",
    allow_defer_fallback: true,
    priority: 0,
    ...overrides,
  };
}

test("the plane is default-off and its default ceiling is a bubble", () => {
  const off = normalizeObserverPolicy(undefined);
  assert.equal(off.enabled, false);
  assert.equal(off.max_delivery, "defer");

  const on = normalizeObserverPolicy({ enabled: true });
  assert.equal(on.enabled, true);
  assert.equal(on.max_delivery, "defer", "enabling the plane must not grant audio");
});

test("a text reply modality clamps observer audio", () => {
  const policy = normalizeObserverPolicy(
    { enabled: true, max_delivery: "interject" },
    { responseModality: "text" },
  );
  assert.equal(policy.max_delivery, "defer");
  const [decision] = decide([proposal()], baseContext({ policy }));
  assert.equal(decision.mode, "defer");
  assert.equal(decision.demoted_by, "user_policy");
});

test("policy only ever lowers a delivery", () => {
  const audible = decide([proposal()], baseContext());
  assert.equal(audible[0].mode, "interject");

  const capped = decide([proposal()], baseContext({
    policy: normalizeObserverPolicy({ enabled: true, max_delivery: "defer" }),
  }));
  assert.equal(capped[0].mode, "defer");
  assert.equal(capped[0].requested_mode, "interject");
  assert.equal(capped[0].demoted_by, "user_policy");
  assert.equal(capped[0].speech_text, "", "a deferred delivery carries no spoken form");
});

test("an observer cannot exceed its own declared ceiling", () => {
  const [decision] = decide(
    [proposal({ observer_max_delivery: "overlay" })],
    baseContext(),
  );
  assert.equal(decision.mode, "overlay");
  assert.equal(decision.demoted_by, "observer_ceiling");
});

test("a per-observer setting can silence one observer without disabling the plane", () => {
  const policy = normalizeObserverPolicy({
    enabled: true,
    max_delivery: "overlay",
    per_observer: { alpha: { enabled: false } },
  });
  const decisions = decide([proposal(), proposal({ observer_id: "beta", proposal_id: "prop_beta_1" })],
    baseContext({ policy }));
  const alpha = decisions.find((entry) => entry.observer_id === "alpha");
  const beta = decisions.find((entry) => entry.observer_id === "beta");
  assert.equal(alpha.mode, "drop");
  assert.equal(alpha.drop_reason, "policy_disabled");
  assert.equal(beta.mode, "overlay");
});

test("an in-flight reply is never preempted by a proposal", () => {
  const [decision] = decide([proposal()], baseContext({ replyInFlight: true }));
  assert.equal(decision.mode, "defer");
  assert.equal(decision.demoted_by, "reply_in_flight");
});

test("audio stays blocked through the quiet period after a reply ends", () => {
  const [decision] = decide([proposal()], baseContext({ msSinceReplyEnd: 200 }));
  assert.equal(decision.mode, "defer");
  assert.equal(decision.demoted_by, "reply_quiet_period");

  const [after] = decide([proposal()], baseContext({ msSinceReplyEnd: 5000 }));
  assert.equal(after.mode, "interject");
});

test("hosted synthesis being unavailable degrades to a bubble, never a local voice", () => {
  const [decision] = decide([proposal()], baseContext({ hostedTtsAvailable: false }));
  assert.equal(decision.mode, "defer");
  assert.equal(decision.demoted_by, "tts_unavailable");
});

test("unstable text caps delivery, and only settled text can be interjected", () => {
  const overlayOnly = decide([proposal({ stability_watermark: 0.7 })], baseContext());
  assert.equal(overlayOnly[0].mode, "overlay");
  assert.equal(overlayOnly[0].demoted_by, "unstable_text");

  const bubbleOnly = decide([proposal({ stability_watermark: 0.4 })], baseContext());
  assert.equal(bubbleOnly[0].mode, "defer");
  assert.equal(bubbleOnly[0].demoted_by, "unstable_text");
});

test("a proposal built from the live tail or a forged digest cannot be spoken", () => {
  const noDigest = decide([proposal({ stable_digest: "" })], baseContext());
  assert.equal(noDigest[0].mode, "defer");
  assert.equal(noDigest[0].demoted_by, "unverified_digest");

  const forged = decide([proposal({ stable_digest: "sha256:deadbeef" })], baseContext());
  assert.equal(forged[0].mode, "defer");
  assert.equal(forged[0].demoted_by, "unverified_digest");
});

test("a proposal whose settled words were rewritten is dropped as revised", () => {
  const [decision] = decide([proposal()], baseContext({
    stableChain: new Set(),
    retiredDigests: new Set([DIGEST]),
  }));
  assert.equal(decision.mode, "drop");
  assert.equal(decision.drop_reason, "revised");
});

test("a proposal that fell too far behind the transcript is stale", () => {
  const [decision] = decide([proposal({ transcript_revision: 4 })], baseContext());
  assert.equal(decision.drop_reason, "stale");
});

test("an expired or inactive proposal is dropped without delivery", () => {
  const expired = decide([proposal({ proposed_at: 1, ttl_ms: 100 })], baseContext());
  assert.equal(expired[0].drop_reason, "expired");

  const inactive = decide([proposal()], baseContext({ turnStatus: "committed" }));
  assert.equal(inactive[0].drop_reason, "inactive");
});

test("a rejected transcript withholds delivery", () => {
  const [decision] = decide([proposal()], baseContext({ qualityAccepted: false }));
  assert.equal(decision.drop_reason, "quality_rejected");
});

test("an observer that is not partial-safe can only bubble from a partial", () => {
  const fromPartial = decide([proposal({ partial_safe: false, trigger: "pause" })], baseContext());
  assert.equal(fromPartial[0].mode, "defer");
  assert.equal(fromPartial[0].demoted_by, "partial_unsafe");

  const fromFinal = decide([proposal({ partial_safe: false, trigger: "final" })], baseContext());
  assert.equal(fromFinal[0].mode, "interject");
});

test("a non-Latin turn cannot be interjected into, and word-quoting observers only bubble", () => {
  const overlayOnly = decide([proposal()], baseContext({ scripts: ["ethiopic"] }));
  assert.equal(overlayOnly[0].mode, "overlay");
  assert.equal(overlayOnly[0].demoted_by, "restricted_script");

  const coach = decide([proposal({ quotes_user: true })], baseContext({ scripts: ["ethiopic"] }));
  assert.equal(coach[0].mode, "defer");
  assert.equal(coach[0].demoted_by, "restricted_script");

  const raisedFloor = decide(
    [proposal({ stability_watermark: 0.7 })],
    baseContext({ scripts: ["ethiopic"] }),
  );
  assert.equal(raisedFloor[0].mode, "defer", "a restricted script needs 0.8 to be audible at all");
});

test("two proposals at once produce at most one voice", () => {
  const decisions = decide([
    proposal({ observer_id: "coach", proposal_id: "p_coach", urgency: 0.3, confidence: 0.7, stability_watermark: 0.82 }),
    proposal({ observer_id: "timer", proposal_id: "p_timer", urgency: 0.9, confidence: 1, stability_watermark: 1 }),
  ], baseContext());
  const audible = decisions.filter((entry) => entry.mode === "overlay" || entry.mode === "interject");
  assert.equal(audible.length, 1);
  assert.equal(audible[0].observer_id, "timer");
  const loser = decisions.find((entry) => entry.observer_id === "coach");
  assert.equal(loser.mode, "defer");
  assert.equal(loser.demoted_by, "superseded");
});

test("a loser that refuses defer fallback is dropped as superseded", () => {
  const decisions = decide([
    proposal({ observer_id: "quiet", proposal_id: "p_quiet", urgency: 0.1, allow_defer_fallback: false }),
    proposal({ observer_id: "loud", proposal_id: "p_loud", urgency: 1 }),
  ], baseContext());
  const loser = decisions.find((entry) => entry.observer_id === "quiet");
  assert.equal(loser.mode, "drop");
  assert.equal(loser.drop_reason, "superseded");
});

test("ranking is deterministic and breaks ties by priority", () => {
  const left = proposal({ observer_id: "aaa", proposal_id: "p_a", priority: 1 });
  const right = proposal({ observer_id: "bbb", proposal_id: "p_b", priority: 9 });
  assert.equal(proposalScore(left), proposalScore(right));
  for (const order of [[left, right], [right, left]]) {
    const decisions = decide(order, baseContext());
    const winner = decisions.find((entry) => entry.mode === "interject");
    assert.equal(winner.observer_id, "bbb");
  }
});

test("the score weights urgency over confidence over stability", () => {
  assert.equal(
    proposalScore({ urgency: 1, confidence: 0, stability_watermark: 0 }),
    0.5,
  );
  assert.equal(
    proposalScore({ urgency: 0, confidence: 1, stability_watermark: 0 }),
    0.3,
  );
  assert.equal(
    proposalScore({ urgency: 0, confidence: 0, stability_watermark: 1 }),
    0.2,
  );
});

test("resolveMode reports no demotion when the request survives every ceiling", () => {
  const { mode, demoted_by: demotedBy } = resolveMode(proposal(), baseContext());
  assert.equal(mode, "interject");
  assert.equal(demotedBy, "");
});

test("receipts carry reasons and lengths, never content", () => {
  const [decision] = decide([proposal({ text: "say it this way" })], baseContext({
    policy: normalizeObserverPolicy({ enabled: true, max_delivery: "defer" }),
  }));
  const receipt = deliveryReceipt(decision);
  assert.equal(receipt.text_chars, "say it this way".length);
  assert.equal(receipt.demoted_by, "user_policy");
  assert.equal(JSON.stringify(receipt).includes("say it this way"), false);
});

test("an explicit stop cue stops speech without a threshold", () => {
  const result = classifyFloorIntent({ stopCue: true, speechMs: 20, contentWords: 1 });
  assert.equal(result.intent, "stop_now");
  assert.equal(result.revisable, false);
});

test("a short backchannel lets the assistant keep speaking", () => {
  const result = classifyFloorIntent({ speechMs: 200, contentWords: 1 });
  assert.equal(result.intent, "backchannel");
  assert.equal(result.revisable, true);
});

test("sustained speech or enough content words takes the floor", () => {
  assert.equal(classifyFloorIntent({ speechMs: 900, contentWords: 0 }).intent, "take_floor");
  assert.equal(classifyFloorIntent({ speechMs: 200, contentWords: 4 }).intent, "take_floor");
});

test("a backchannel escalates upward but a taken floor is never given back", () => {
  const prior = classifyFloorIntent({ speechMs: 200, contentWords: 1 });
  const escalated = reviseFloorIntent(prior, { speechMs: 900, contentWords: 1, sinceClassifiedMs: 500 });
  assert.equal(escalated.intent, "take_floor");
  assert.equal(escalated.escalated_from, "backchannel");

  const taken = classifyFloorIntent({ speechMs: 900 });
  const unchanged = reviseFloorIntent(taken, { speechMs: 10, contentWords: 0, sinceClassifiedMs: 100 });
  assert.equal(unchanged.intent, "take_floor");
});

test("the revisit window closes a backchannel decision", () => {
  const prior = classifyFloorIntent({ speechMs: 200, contentWords: 1 });
  const late = reviseFloorIntent(prior, { speechMs: 5000, sinceClassifiedMs: 9000 });
  assert.equal(late.intent, "backchannel");
  assert.equal(late.revisable, false);
});
