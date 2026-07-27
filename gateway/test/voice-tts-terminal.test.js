"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { sanitizeTtsDelivery, summarizeTtsTerminal } = require("../lib/voice-tts-terminal");

test("TTS terminal summary derives complete and partial delivery bounds", () => {
  const turn = { assistantAudioSegments: [{}, {}] };
  assert.deepEqual(summarizeTtsTerminal(
    { tts_spoke: true }, {}, turn, "complete reply",
  ), {
    complete: true, delivery: "complete", error: "", replyTextChars: 14,
    segments: 2, spokenTextEnd: 14, spoke: true,
  });
  assert.deepEqual(summarizeTtsTerminal(
    { tts_error: "segment failed", tts_spoken_text_end: 4, tts_reply_text_chars: 10 },
    { assistantAudioStarted: true }, turn, "0123456789",
  ), {
    complete: false, delivery: "partial", error: "segment failed", replyTextChars: 10,
    segments: 2, spokenTextEnd: 4, spoke: true,
  });
  assert.equal(sanitizeTtsDelivery("unknown"), "");
});
