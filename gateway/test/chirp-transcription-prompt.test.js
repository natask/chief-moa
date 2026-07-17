"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildChirpTranscriptionPrompt } = require("../lib/chirp-transcription-prompt");

test("Chirp prompt biases configured technical vocabulary without inventing speech", () => {
  const prompt = buildChirpTranscriptionPrompt(["en-US"], {
    stt_vocabulary: "OAuth, Chirp 3, OpenSpec",
    speaker_context: "I build Android apps and gateway services.",
  });
  assert.match(prompt, /OAuth, Chirp 3, OpenSpec/);
  assert.match(prompt, /Android apps and gateway services/);
  assert.match(prompt, /do not invent words that are not spoken/);
});

test("empty user context preserves the baseline language prompt", () => {
  const prompt = buildChirpTranscriptionPrompt(["en-US"], {});
  assert.doesNotMatch(prompt, /technical terms|speaker's vocabulary/);
  assert.match(prompt, /Preserve English speech in Latin script/);
});
