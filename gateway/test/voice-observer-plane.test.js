"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createVoiceObserverPlane,
  createWordCountObserver,
  digestOf,
} = require("../lib/voice-observer-plane");
const { normalizeObserverPolicy } = require("../lib/voice-delivery-arbiter");

function makeTurn() {
  return { sessionId: "session_1", branchId: "default", turnId: "turn_1", status: "recording" };
}

function makeContext(overrides = {}) {
  const emitted = [];
  const recorded = [];
  return {
    emitted,
    recorded,
    context: {
      policy: normalizeObserverPolicy({ enabled: true, max_delivery: "overlay", ...overrides.policy }),
      emit: async (event) => { emitted.push(event); },
      record: async (type, payload) => { recorded.push({ type, payload }); },
      turnContext: () => ({
        replyInFlight: false,
        msSinceReplyEnd: 60_000,
        floorHolder: "user",
        scripts: ["latin"],
        hostedTtsAvailable: true,
        qualityAccepted: true,
        ...overrides.turnContext,
      }),
    },
  };
}

// The plane schedules the arbitration window on a timer; drain it deterministically.
async function settle(iterations = 40) {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function speak(plane, turn, context, texts, input = {}) {
  for (const text of texts) plane.note(turn, text, { trigger: "partial", context, ...input });
}

// Speak with room for each observation to finish. Without this the plane
// coalesces: a frame arriving while an observation is in flight replaces the
// pending one rather than queueing, which is the contract, not a bug.
async function speakSlowly(plane, turn, context, texts, input = {}) {
  for (const text of texts) {
    plane.note(turn, text, { trigger: "partial", context, ...input });
    await settle(3);
  }
}

test("registration validates and rejects duplicates", () => {
  const plane = createVoiceObserverPlane();
  assert.throws(() => plane.register({ id: "Bad Id", version: 1, triggers: ["pause"], observe() {} }), /kebab-case/);
  assert.throws(() => plane.register({ id: "no-fn", version: 1, triggers: ["pause"] }), /observe\(\)/);
  assert.throws(() => plane.register({ id: "old", version: 2, triggers: ["pause"], observe() {} }), /unsupported contract version/);
  assert.throws(() => plane.register({ id: "odd", version: 1, triggers: ["whenever"], observe() {} }), /unknown triggers/);
  assert.throws(() => plane.register({ id: "none", version: 1, triggers: [], observe() {} }), /unknown triggers/);

  plane.register(createWordCountObserver());
  assert.deepEqual(plane.registered(), ["word-count"]);
  assert.throws(() => plane.register(createWordCountObserver()), /already registered/);
});

test("a registered observer cannot raise its own ceiling afterwards", () => {
  const plane = createVoiceObserverPlane();
  const observer = plane.register(createWordCountObserver());
  assert.throws(() => { observer.maxDelivery = "interject"; }, TypeError);
  assert.equal(observer.maxDelivery, "overlay");
});

test("the pre-filter declines without running observer code", async () => {
  const plane = createVoiceObserverPlane();
  let calls = 0;
  plane.register({
    id: "pause-only", version: 1, triggers: ["pause"], minStability: 0.6,
    maxDelivery: "defer", observe() { calls += 1; return null; },
  });
  const turn = makeTurn();
  const { context } = makeContext();
  speak(plane, turn, context, ["one", "one two", "one two three", "one two three four"]);
  await settle(4);
  assert.equal(calls, 0, "a partial-triggered frame must not reach a pause-only observer");
});

test("a frame below the declared stability minimum never reaches the observer", async () => {
  const plane = createVoiceObserverPlane();
  const seen = [];
  plane.register({
    id: "picky", version: 1, triggers: ["partial"], minStability: 0.95, minIntervalMs: 0,
    maxDelivery: "defer", observe(frame) { seen.push(frame.stability.watermark); return null; },
  });
  const turn = makeTurn();
  const { context } = makeContext();
  // The first emission agrees with nothing, so its watermark is zero.
  speak(plane, turn, context, ["hello there"]);
  await settle(4);
  assert.deepEqual(seen, []);
});

test("the frame separates settled text from the live tail", async () => {
  const plane = createVoiceObserverPlane();
  const frames = [];
  plane.register({
    id: "recorder", version: 1, triggers: ["partial"], minStability: 0, minIntervalMs: 0,
    maxDelivery: "defer", observe(frame) { frames.push(frame); return null; },
  });
  const turn = makeTurn();
  const { context } = makeContext();
  speak(plane, turn, context, ["narrow the", "narrow the scope", "narrow the scope of"]);
  await settle(4);
  const last = frames[frames.length - 1];
  assert.equal(last.transcript.stable_text, "narrow the scope");
  assert.equal(last.transcript.tail_text, "of");
  assert.ok(last.stability.watermark > 0.8);
  assert.equal(Object.isFrozen(last), true);
  assert.equal(Object.isFrozen(last.transcript), true);
});

test("a rewritten prefix retires the digests every proposal was built on", async () => {
  const plane = createVoiceObserverPlane();
  const digests = [];
  plane.register({
    id: "recorder", version: 1, triggers: ["partial"], minStability: 0, minIntervalMs: 0,
    maxDelivery: "defer", observe(frame) { digests.push(digestOf(frame.transcript.stable_text)); return null; },
  });
  const turn = makeTurn();
  const { context } = makeContext();
  speak(plane, turn, context, ["ship the feature", "ship the feature now"]);
  await settle(4);
  const settledDigest = plane.currentStableDigest(turn);
  assert.equal(settledDigest, digestOf("ship the feature"));
  // The recognizer changes its mind about words it had already settled.
  speak(plane, turn, context, ["skip the feature entirely", "skip the feature at all"]);
  await settle(4);
  assert.notEqual(plane.currentStableDigest(turn), settledDigest);
});

test("a hanging observer never delays the turn and is abandoned at its budget", async () => {
  const plane = createVoiceObserverPlane();
  let resolveHang;
  plane.register({
    id: "hanger", version: 1, triggers: ["partial"], minStability: 0, minIntervalMs: 0,
    maxLatencyMs: 20, maxDelivery: "defer",
    observe: () => new Promise((resolve) => { resolveHang = resolve; }),
  });
  const turn = makeTurn();
  const { context, recorded, emitted } = makeContext();

  const before = Date.now();
  const returned = plane.note(turn, "this call must not wait", { trigger: "partial", context });
  assert.equal(typeof returned, "number", "note() is synchronous and returns the revision");
  assert.ok(Date.now() - before < 15, "note() returned without awaiting the observer");

  await settle(10);
  const fault = recorded.find((entry) => entry.type === "voice_observer_fault");
  assert.equal(fault.payload.fault, "timeout");
  assert.equal(fault.payload.observer_id, "hanger");

  // A late result is discarded rather than delivered.
  resolveHang({ mode_request: "overlay", text: "too late" });
  await settle(10);
  assert.equal(emitted.length, 0);
});

test("three faults quarantine only the failing observer", async () => {
  const plane = createVoiceObserverPlane();
  plane.register({
    id: "broken", version: 1, triggers: ["partial"], minStability: 0, minIntervalMs: 0,
    maxDelivery: "defer", observe() { throw new Error("boom"); },
  });
  let healthyCalls = 0;
  plane.register({
    id: "healthy", version: 1, triggers: ["partial"], minStability: 0, minIntervalMs: 0,
    maxDelivery: "defer", observe() { healthyCalls += 1; return null; },
  });
  const turn = makeTurn();
  const { context, recorded } = makeContext();
  await speakSlowly(plane, turn, context, ["a", "a b", "a b c", "a b c d", "a b c d e"]);
  await settle(10);

  assert.deepEqual(plane.quarantinedIds(), ["broken"]);
  const quarantine = recorded.find((entry) => entry.type === "voice_observer_quarantined");
  assert.equal(quarantine.payload.observer_id, "broken");
  assert.ok(healthyCalls >= 3, "the healthy observer keeps running");
  const faults = recorded.filter((entry) => entry.type === "voice_observer_fault");
  assert.equal(JSON.stringify(faults).includes("a b c"), false, "fault receipts carry no transcript");
});

test("an observer that declines produces no delivery and no content receipt", async () => {
  const plane = createVoiceObserverPlane();
  plane.register({
    id: "quiet", version: 1, triggers: ["partial"], minStability: 0, minIntervalMs: 0,
    maxDelivery: "overlay", observe() { return null; },
  });
  const turn = makeTurn();
  const { context, emitted, recorded } = makeContext();
  speak(plane, turn, context, ["nothing worth saying", "nothing worth saying here"]);
  await settle(10);
  assert.equal(emitted.length, 0);
  assert.equal(recorded.length, 0);
});

test("a disabled policy runs no observer at all", async () => {
  const plane = createVoiceObserverPlane();
  let calls = 0;
  plane.register({
    id: "eager", version: 1, triggers: ["partial"], minStability: 0, minIntervalMs: 0,
    maxDelivery: "overlay", observe() { calls += 1; return { mode_request: "overlay", text: "hi" }; },
  });
  const turn = makeTurn();
  const { context, emitted } = makeContext({ policy: { enabled: false } });
  speak(plane, turn, context, ["speak to me", "speak to me now"]);
  await settle(10);
  assert.equal(calls, 0);
  assert.equal(emitted.length, 0);
});

test("a proposal travels the whole path and lands as a delivery", async () => {
  const plane = createVoiceObserverPlane({ arbitrationWindowMs: 5 });
  plane.register({
    id: "word-count", version: 1, triggers: ["partial"], minStability: 0, minIntervalMs: 0,
    partialSafe: true, maxDelivery: "overlay",
    observe(frame) {
      return {
        mode_request: "overlay",
        text: `${frame.transcript.words} words`,
        urgency: 0.4, confidence: 1, ttl_ms: 4000, reason_code: "length",
      };
    },
  });
  const turn = makeTurn();
  const { context, emitted, recorded } = makeContext();
  await speakSlowly(plane, turn, context, ["one two", "one two three", "one two three four"]);
  await settle(10);

  const deliveries = emitted.filter((event) => event.type === "observer_delivery");
  // Early frames have little settled text, so they can only bubble. Audio
  // becomes available once the watermark clears 0.6.
  assert.equal(deliveries[0].mode, "defer");
  const delivery = deliveries[deliveries.length - 1];
  assert.equal(delivery.observer_id, "word-count");
  assert.equal(delivery.mode, "overlay");
  assert.equal(delivery.turn_id, "turn_1");
  assert.equal(turn.status, "recording", "an overlay delivery does not stop the user");

  const receipt = recorded.filter((entry) => entry.type === "voice_observer_delivery").pop();
  assert.equal(receipt.payload.mode, "overlay");
  assert.ok(receipt.payload.text_chars > 0);
  assert.equal(Object.hasOwn(receipt.payload, "text"), false, "receipts carry no content");
});

test("the user's bubble-instead-of-speaking setting silences an overlay proposal", async () => {
  const plane = createVoiceObserverPlane({ arbitrationWindowMs: 5 });
  plane.register({
    id: "coach", version: 1, triggers: ["partial"], minStability: 0, minIntervalMs: 0,
    partialSafe: true, quotesUser: true, maxDelivery: "overlay",
    observe: () => ({ mode_request: "overlay", text: "try: narrow the scope", speech_text: "try narrowing the scope", urgency: 0.3, confidence: 0.7, ttl_ms: 4000 }),
  });
  const turn = makeTurn();
  const { context, emitted } = makeContext({ policy: { max_delivery: "defer" } });
  speak(plane, turn, context, ["I was trying to say", "I was trying to say something"]);
  await settle(10);

  const delivery = emitted.find((event) => event.type === "observer_delivery");
  assert.equal(delivery.mode, "defer");
  assert.equal(delivery.requested_mode, "overlay");
  assert.equal(delivery.demoted_by, "user_policy");
  assert.equal(delivery.speech_text, "", "a bubble is never spoken");
  assert.equal(delivery.text, "try: narrow the scope");
});

test("a proposal arriving during an in-flight reply becomes a bubble and stops nothing", async () => {
  const plane = createVoiceObserverPlane({ arbitrationWindowMs: 5 });
  plane.register({
    id: "background", version: 1, triggers: ["partial"], minStability: 0, minIntervalMs: 0,
    partialSafe: true, maxDelivery: "interject",
    observe: () => ({ mode_request: "interject", text: "your run finished", urgency: 1, confidence: 1, ttl_ms: 4000 }),
  });
  const turn = makeTurn();
  const { context, emitted } = makeContext({ turnContext: { replyInFlight: true } });
  speak(plane, turn, context, ["still talking", "still talking here"]);
  await settle(10);

  const delivery = emitted.find((event) => event.type === "observer_delivery");
  assert.equal(delivery.mode, "defer");
  assert.equal(delivery.demoted_by, "reply_in_flight");
  assert.equal(turn.status, "recording", "the in-flight reply is untouched");
});

test("the word-count observer proves the path with no model call", async () => {
  const plane = createVoiceObserverPlane({ arbitrationWindowMs: 5 });
  plane.register(createWordCountObserver({ threshold: 4, minIntervalMs: 0 }));
  const turn = makeTurn();
  const { context, emitted } = makeContext();
  plane.note(turn, "one two three four five", { trigger: "pause", context });
  plane.note(turn, "one two three four five six", { trigger: "pause", context });
  await settle(10);

  const delivery = emitted.find((event) => event.type === "observer_delivery");
  assert.ok(delivery);
  assert.equal(delivery.observer_id, "word-count");
  assert.match(delivery.text, /words so far$/);
});

test("stopping a turn cancels pending work", async () => {
  const plane = createVoiceObserverPlane({ arbitrationWindowMs: 50 });
  plane.register({
    id: "slow-window", version: 1, triggers: ["partial"], minStability: 0, minIntervalMs: 0,
    partialSafe: true, maxDelivery: "overlay",
    observe: () => ({ mode_request: "overlay", text: "too late", urgency: 1, confidence: 1, ttl_ms: 4000 }),
  });
  const turn = makeTurn();
  const { context, emitted } = makeContext();
  speak(plane, turn, context, ["hold on", "hold on a moment"]);
  await settle(2);
  plane.stop(turn);
  await settle(20);
  assert.equal(emitted.length, 0);
});
