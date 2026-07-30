"use strict";

const SCHEMA_VERSION = 1;
const MAX_MONOTONIC_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_TURN_DURATION_MS = 24 * 60 * 60 * 1_000;

const VOICE_CLIENT_MILESTONES = Object.freeze([
  "mic_armed",
  "speech_start",
  "first_partial",
  "final_transcript",
  "commit",
  "first_model_delta",
  "first_audio_receipt",
  "first_playout",
  "completed",
]);

const MILESTONE_SET = new Set(VOICE_CLIENT_MILESTONES);
const EVENT_FIELDS = new Set(["milestone", "monotonic_ms"]);
const STATE_FIELDS = new Set(["schema_version", "milestones"]);

class VoiceClientTimingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VoiceClientTimingError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new VoiceClientTimingError(code, message);
}

function plainObject(value, name) {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)
  ) {
    fail("invalid_shape", `${name} must be an object`);
  }
  return value;
}

function rejectUnknown(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    fail("unknown_field", `${name} contains unknown field: ${unknown[0]}`);
  }
}

function monotonicTime(value, name = "monotonic_ms") {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MONOTONIC_MS) {
    fail("invalid_monotonic_time", `${name} must be a bounded non-negative safe integer`);
  }
  return value;
}

function milestoneName(value) {
  if (typeof value !== "string" || !MILESTONE_SET.has(value)) {
    fail("unknown_milestone", "milestone is not part of the voice client timing contract");
  }
  return value;
}

function freezeState(milestones) {
  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    milestones: Object.freeze({ ...milestones }),
  });
}

function createVoiceClientTimingState() {
  return freezeState({});
}

function normalizeState(value) {
  plainObject(value, "timing state");
  rejectUnknown(value, STATE_FIELDS, "timing state");
  if (value.schema_version !== SCHEMA_VERSION) {
    fail("unsupported_schema", `schema_version must be ${SCHEMA_VERSION}`);
  }
  const input = plainObject(value.milestones, "timing state milestones");
  const milestones = {};
  for (const [rawName, rawTime] of Object.entries(input)) {
    const name = milestoneName(rawName);
    milestones[name] = monotonicTime(rawTime, `milestones.${name}`);
  }
  assertCausality(milestones);
  return milestones;
}

function normalizeEvent(value) {
  plainObject(value, "timing event");
  rejectUnknown(value, EVENT_FIELDS, "timing event");
  return {
    milestone: milestoneName(value.milestone),
    monotonic_ms: monotonicTime(value.monotonic_ms),
  };
}

function assertCausality(milestones) {
  let previousName;
  let previousTime;
  for (const name of VOICE_CLIENT_MILESTONES) {
    const time = milestones[name];
    if (time === undefined) continue;
    if (previousTime !== undefined && time < previousTime) {
      fail(
        "impossible_causality",
        `${name} cannot precede ${previousName} on one monotonic client clock`,
      );
    }
    previousName = name;
    previousTime = time;
  }

  const times = Object.values(milestones);
  if (times.length > 1 && Math.max(...times) - Math.min(...times) > MAX_TURN_DURATION_MS) {
    fail("turn_duration_exceeded", "voice timing milestones exceed the bounded turn duration");
  }
}

/**
 * Return a new accumulator state. A duplicate keeps the earliest observation
 * for that semantic milestone, so delayed duplicate delivery cannot move a
 * first-occurrence metric forward.
 */
function recordVoiceClientTiming(state, event) {
  const milestones = normalizeState(state);
  const normalized = normalizeEvent(event);
  const current = milestones[normalized.milestone];

  if (current !== undefined && current <= normalized.monotonic_ms) {
    return freezeState(milestones);
  }

  const next = { ...milestones, [normalized.milestone]: normalized.monotonic_ms };
  assertCausality(next);
  return freezeState(next);
}

function summarizeVoiceClientTiming(state) {
  const milestones = normalizeState(state);
  const presentTimes = Object.values(milestones);
  const origin = presentTimes.length > 0 ? Math.min(...presentTimes) : 0;
  const milestoneOffsets = {};
  const missing = [];

  for (const name of VOICE_CLIENT_MILESTONES) {
    if (milestones[name] === undefined) {
      milestoneOffsets[name] = null;
      missing.push(name);
    } else {
      milestoneOffsets[name] = milestones[name] - origin;
    }
  }

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    completed: milestones.completed !== undefined,
    milestones_ms: Object.freeze(milestoneOffsets),
    missing_milestones: Object.freeze(missing),
  });
}

function accumulateVoiceClientTiming(events) {
  if (!events || typeof events[Symbol.iterator] !== "function") {
    fail("invalid_shape", "timing events must be iterable");
  }
  let state = createVoiceClientTimingState();
  for (const event of events) state = recordVoiceClientTiming(state, event);
  return summarizeVoiceClientTiming(state);
}

module.exports = {
  MAX_MONOTONIC_MS,
  MAX_TURN_DURATION_MS,
  VOICE_CLIENT_MILESTONES,
  VoiceClientTimingError,
  accumulateVoiceClientTiming,
  createVoiceClientTimingState,
  recordVoiceClientTiming,
  summarizeVoiceClientTiming,
};
