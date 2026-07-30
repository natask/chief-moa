"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_MONOTONIC_MS,
  MAX_TURN_DURATION_MS,
  VOICE_CLIENT_MILESTONES,
  VoiceClientTimingError,
  accumulateVoiceClientTiming,
  createVoiceClientTimingState,
  recordVoiceClientTiming,
  summarizeVoiceClientTiming,
} = require("../lib/voice-client-timing");

function event(milestone, monotonic_ms) {
  return { milestone, monotonic_ms };
}

function rejectsCode(run, code) {
  assert.throws(run, (error) => error instanceof VoiceClientTimingError && error.code === code);
}

test("accumulates reordered endpoint milestones into one monotonic summary", () => {
  const fixtures = [
    event("first_audio_receipt", 170),
    event("speech_start", 110),
    event("mic_armed", 100),
    event("first_model_delta", 150),
    event("first_partial", 120),
    event("commit", 140),
    event("completed", 210),
    event("final_transcript", 135),
    event("first_playout", 185),
  ];

  assert.deepEqual(accumulateVoiceClientTiming(fixtures), {
    schema_version: 1,
    completed: true,
    milestones_ms: {
      mic_armed: 0,
      speech_start: 10,
      first_partial: 20,
      final_transcript: 35,
      commit: 40,
      first_model_delta: 50,
      first_audio_receipt: 70,
      first_playout: 85,
      completed: 110,
    },
    missing_milestones: [],
  });
});

test("duplicates and stale duplicate delivery retain the earliest milestone", () => {
  let state = createVoiceClientTimingState();
  state = recordVoiceClientTiming(state, event("mic_armed", 1_000));
  state = recordVoiceClientTiming(state, event("speech_start", 1_100));
  state = recordVoiceClientTiming(state, event("speech_start", 1_100));
  state = recordVoiceClientTiming(state, event("speech_start", 1_400));
  state = recordVoiceClientTiming(state, event("first_partial", 1_200));

  assert.equal(summarizeVoiceClientTiming(state).milestones_ms.speech_start, 100);
  assert.deepEqual(Object.keys(state.milestones), ["mic_armed", "speech_start", "first_partial"]);
});

test("summary stays fixed-size and names every missing milestone explicitly", () => {
  const staleDuplicates = Array.from({ length: 10_000 }, (_, index) => (
    event("mic_armed", 50_000 + index)
  ));
  const summary = accumulateVoiceClientTiming(staleDuplicates);

  assert.deepEqual(Object.keys(summary.milestones_ms), VOICE_CLIENT_MILESTONES);
  assert.equal(JSON.stringify(summary).length < 1_000, true);
  assert.deepEqual(summary.missing_milestones, VOICE_CLIENT_MILESTONES.slice(1));
  assert.equal(summary.completed, false);
  assert.equal(summary.milestones_ms.mic_armed, 0);
  assert.equal(summary.milestones_ms.first_partial, null);
});

test("an earlier duplicate can correct a milestone without retaining history", () => {
  let state = createVoiceClientTimingState();
  state = recordVoiceClientTiming(state, event("mic_armed", 100));
  state = recordVoiceClientTiming(state, event("first_partial", 140));
  state = recordVoiceClientTiming(state, event("speech_start", 130));
  state = recordVoiceClientTiming(state, event("speech_start", 120));

  assert.equal(summarizeVoiceClientTiming(state).milestones_ms.speech_start, 20);
});

test("rejects impossible causality even when events arrive out of order", () => {
  let state = createVoiceClientTimingState();
  state = recordVoiceClientTiming(state, event("commit", 200));
  rejectsCode(
    () => recordVoiceClientTiming(state, event("final_transcript", 220)),
    "impossible_causality",
  );

  let later = createVoiceClientTimingState();
  later = recordVoiceClientTiming(later, event("first_playout", 500));
  rejectsCode(
    () => recordVoiceClientTiming(later, event("first_audio_receipt", 510)),
    "impossible_causality",
  );
});

test("requires injected bounded monotonic times and bounds a turn span", () => {
  const state = createVoiceClientTimingState();
  for (const invalid of [-1, 1.5, Number.NaN, MAX_MONOTONIC_MS + 1]) {
    rejectsCode(
      () => recordVoiceClientTiming(state, event("mic_armed", invalid)),
      "invalid_monotonic_time",
    );
  }

  const started = recordVoiceClientTiming(state, event("mic_armed", 0));
  rejectsCode(
    () => recordVoiceClientTiming(started, event("completed", MAX_TURN_DURATION_MS + 1)),
    "turn_duration_exceeded",
  );
});

test("rejects content, audio, and identifiers instead of retaining them", () => {
  const state = createVoiceClientTimingState();
  for (const extra of [
    { transcript: "private words" },
    { audio: Buffer.from("private audio") },
    { turn_id: "raw-turn-id" },
    { session_id: "raw-session-id" },
  ]) {
    rejectsCode(
      () => recordVoiceClientTiming(state, { ...event("mic_armed", 100), ...extra }),
      "unknown_field",
    );
  }

  const serialized = JSON.stringify(accumulateVoiceClientTiming([event("mic_armed", 100)]));
  assert.doesNotMatch(serialized, /private words|private audio|raw-turn-id|raw-session-id/);
});

test("rejects malformed events, states, and unsupported milestones", () => {
  const state = createVoiceClientTimingState();
  rejectsCode(() => recordVoiceClientTiming(state, event("unknown", 1)), "unknown_milestone");
  rejectsCode(() => recordVoiceClientTiming(state, { milestone: "mic_armed" }), "invalid_monotonic_time");
  rejectsCode(() => recordVoiceClientTiming({ ...state, extra: true }, event("mic_armed", 1)), "unknown_field");
  rejectsCode(() => recordVoiceClientTiming(new Date(), event("mic_armed", 1)), "invalid_shape");
  rejectsCode(
    () => recordVoiceClientTiming({ schema_version: 1, milestones: new Map() }, event("mic_armed", 1)),
    "invalid_shape",
  );
  rejectsCode(() => recordVoiceClientTiming(state, new Map()), "invalid_shape");
  rejectsCode(() => accumulateVoiceClientTiming(null), "invalid_shape");
});
