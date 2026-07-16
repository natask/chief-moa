import assert from "node:assert/strict";

await import(`../extension/content-voice-policy-runtime.js?test=${Date.now()}`);
const policy = globalThis.AgeeContentVoicePolicyRuntime;

assert.equal(policy.finiteNumber("bad", undefined, 3), 3);
assert.equal(policy.finiteNumber("bad", undefined), null);
assert.equal(policy.normalizeAssistantAudioSegment(null), null);
assert.equal(policy.normalizeAssistantAudioSegment({ pcm_ms: 0 }), null);
assert.deepEqual(policy.normalizeAssistantAudioSegment({
  source_duration_ms: "120", playback_rate: "1.5", text_char_start: -2, text_char_end: 10.4, segment_index: 2.6,
}), {
  segmentIndex: 3, sourceDurationMs: 120, playbackRate: 1.5, textStartChar: 0, textEndChar: 10,
});
assert.deepEqual(policy.normalizeAssistantAudioSegment({ sourceDurationMs: 80, playbackRate: 0, textStartChar: null, textEndChar: null }), {
  segmentIndex: null, sourceDurationMs: 80, playbackRate: null, textStartChar: 0, textEndChar: 0,
});
assert.equal(policy.normalizeAssistantAudioSegment({ duration_ms: 42, rate: 2 }).sourceDurationMs, 42);
assert.equal(policy.normalizeAssistantAudioSegment({ durationMs: 43, index: 1 }).sourceDurationMs, 43);

policy.recordAssistantPlaybackSegment({}, {}, { duration: 1 }, 0, 1);
const playback = {
  pendingAssistantAudioSegments: [
    { segmentIndex: 0, sourceDurationMs: 1000, playbackRate: null, textStartChar: 0, textEndChar: 20 },
    { segmentIndex: 1, sourceDurationMs: 500, playbackRate: 2, textStartChar: null, textEndChar: null },
  ],
};
policy.recordAssistantPlaybackSegment(playback, {}, { duration: 1 }, 5, 0);
policy.recordAssistantPlaybackSegment(playback, {}, { duration: 0.25 }, 6, 1);
assert.equal(playback.playedAssistantAudioSegments[0].playbackRate, 1);
assert.equal(playback.playedAssistantAudioSegments[1].sourceStartMs, 1000);
assert.equal(playback.playedAssistantAudioSegments[1].wallDurationMs, 125);

assert.equal(policy.computePlaybackProgress(null, 1), null);
assert.equal(policy.computePlaybackProgress(playback, NaN), null);
const textProgress = policy.computePlaybackProgress({ ...playback, turnId: "turn" }, 5.5);
assert.equal(textProgress.played_pcm_ms, 500);
assert.equal(textProgress.played_text_char_end, 10);
const progress = policy.computePlaybackProgress({ ...playback, turnId: "turn" }, 6.1);
assert.equal(progress.type, "playback_progress");
assert.equal(progress.turn_id, "turn");
assert.equal(progress.played_pcm_ms, 1200);
const invalidPlayback = { playedAssistantAudioSegments: [
  null,
  { sourceDurationMs: 0, sourceStartMs: 0, scheduledAt: 0 },
  { sourceDurationMs: 100, sourceStartMs: -1, scheduledAt: 0 },
  { sourceDurationMs: 100, sourceStartMs: 0, scheduledAt: NaN },
  { sourceDurationMs: 100, sourceStartMs: 0, scheduledAt: 10, playbackRate: 0 },
] };
assert.equal(policy.computePlaybackProgress(invalidPlayback, 9), null);

assert.equal(policy.mergeLiveVoiceTranscript("", " hello "), "hello");
assert.equal(policy.mergeLiveVoiceTranscript("hello", ""), "hello");
assert.equal(policy.mergeLiveVoiceTranscript("hello", "hello world"), "hello world");
assert.equal(policy.mergeLiveVoiceTranscript("hello world", "world"), "hello world");
assert.equal(policy.mergeLiveVoiceTranscript("one two three", "two three four"), "one two three four");
assert.equal(policy.mergeLiveVoiceTranscript("one two", "three four"), "one two three four");

assert.equal(policy.normalizeSpokenCommand(" Don't—STOP! "), "don t stop");
for (const text of ["", "x".repeat(261), "one\ntwo\nthree\nfour", "hello there"]) {
  assert.equal(policy.isPageContextTranscript(text), false);
}
for (const text of [
  "What am I looking at?", "What's on my screen?", "summarize this page", "what is on this tab",
  "review the current site", "describe the visible screen?",
]) {
  assert.equal(policy.isPageContextTranscript(text), true, text);
}

assert.equal(policy.parseAssistantSpeechOverlapIntent(""), null);
for (const text of [
  "turn barge in back on", "barge in back on", "stop talking when I talk", "stop speaking when I speak",
  "interrupt yourself when I talk", "interrupt yourself when I speak", "do not talk over me", "dont talk over me",
]) {
  assert.deepEqual(policy.parseAssistantSpeechOverlapIntent(text), { enabled: false }, text);
}
for (const text of [
  "continue talking even though I speak", "keep talking even though I speak", "continue talking while I speak",
  "keep talking while I speak", "keep speaking while I speak", "continue speaking while I speak",
  "talk in the background", "speak in the background", "keep talking in the background",
  "do not interrupt yourself", "don t interrupt yourself", "dont interrupt yourself",
]) {
  assert.deepEqual(policy.parseAssistantSpeechOverlapIntent(text), { enabled: true }, text);
}
assert.equal(policy.parseAssistantSpeechOverlapIntent("ordinary request"), null);

assert.equal(policy.isProfileControlTranscript(""), false);
for (const text of [
  "what prompt are you using", "which prompt", "current prompt", "change system prompt",
  "what is your name", "what's your name", "who are you", "your name should be Aggie", "call yourself Aggie", "you are now called Aggie",
  "what language", "which language", "what language is active", "switch language", "speak Amharic", "only English",
  "do not switch from English", "use English and Amharic as these two languages",
  "what voice", "which voice", "change voice", "sound like a woman", "speak like puck", "use charon",
]) {
  assert.equal(policy.isProfileControlTranscript(text), true, text);
}
for (const text of ["summarize this", "mention English", "sound like a robot", "puck is a moon"]) {
  assert.equal(policy.isProfileControlTranscript(text), false, text);
}
assert.equal(policy.shouldRouteLiveTranscriptThroughGateway("summarize this page"), true);
assert.equal(policy.shouldRouteLiveTranscriptThroughGateway("change voice"), true);
assert.equal(policy.shouldRouteLiveTranscriptThroughGateway("hello"), false);

console.log("content voice policy runtime tests passed");
