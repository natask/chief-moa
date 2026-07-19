"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildChirpTranscriptionPrompt } = require("../lib/chirp-transcription-prompt");

test("Chirp prompt biases toward a general technical domain without a dictionary", () => {
  const prompt = buildChirpTranscriptionPrompt(["en-US"], {
    speaker_context: "The speaker frequently discusses software engineering, authentication, speech systems, and mathematics.",
  });
  assert.match(prompt, /software engineering, authentication, speech systems, and mathematics/);
  assert.match(prompt, /acronyms, identifiers, protocol names, mathematical language/);
  assert.match(prompt, /do not invent technical terms that are not spoken/);
  assert.doesNotMatch(prompt, /Prefer these exact|user-provided terms/);
});

test("empty user context preserves the baseline language prompt", () => {
  const prompt = buildChirpTranscriptionPrompt(["en-US"], {});
  assert.doesNotMatch(prompt, /Recognition context|technical terms/);
  assert.match(prompt, /Preserve English speech in Latin script/);
});
