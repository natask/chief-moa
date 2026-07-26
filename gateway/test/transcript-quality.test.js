"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildTranscriptRetryPrompt,
  finalizeTranscriptCandidate,
  inspectTranscriptScript,
} = require("../lib/transcript-quality");

test("accepts English, Amharic, and small genuine mixed-script fragments", () => {
  for (const transcript of [
    "hello ሰላም",
    "hello ሰላም नाम",
    "I named the variable Δ and said ሰላም",
  ]) {
    assert.equal(inspectTranscriptScript(transcript, ["en-US", "am-ET"]).accepted, true);
  }
});

test("flags dominant Devanagari under the English-Amharic profile", () => {
  const result = inspectTranscriptScript("यह गलत लिपि में आया", ["en-US", "am-ET"]);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "wrong_script");
  assert.ok(result.script_letters.devanagari >= 4);
});

test("covers Bengali as a safety fixture without restricting configured Bengali", () => {
  assert.equal(inspectTranscriptScript("এটি বাংলা লিপি", ["en-US", "am-ET"]).accepted, false);
  assert.equal(inspectTranscriptScript("এটি বাংলা লিপি", ["bn-BD"]).accepted, true);
});

test("retries exactly once and accepts the corrected retained-audio result", async () => {
  let retries = 0;
  const result = await finalizeTranscriptCandidate({
    text: "यह गलत लिपि में आया",
    languageCodes: ["en-US", "am-ET"],
    retry: async () => {
      retries += 1;
      return { text: "the corrected transcript", source: "retained_audio_batch" };
    },
  });
  assert.equal(retries, 1);
  assert.equal(result.text, "the corrected transcript");
  assert.equal(result.source, "retained_audio_batch");
  assert.equal(result.transcript_quality.status, "accepted_after_retry");
  assert.equal(result.transcript_quality.attempts, 2);
});

test("fails visibly after one retry and never returns the rejected candidate", async () => {
  let retries = 0;
  const result = await finalizeTranscriptCandidate({
    text: "यह गलत लिपि में आया",
    languageCodes: ["en-US", "am-ET"],
    retry: async () => {
      retries += 1;
      return { text: "फिर भी गलत लिपि" };
    },
  });
  assert.equal(retries, 1);
  assert.equal(result.text, "");
  assert.equal(result.languageRejected, true);
  assert.equal(result.transcript_quality.accepted, false);
  assert.equal(result.transcript_quality.status, "rejected_after_retry");
  assert.equal(result.transcript_quality.attempts, 2);
});

test("retry prompt is bounded and derives its script evidence from the profile", () => {
  const quality = inspectTranscriptScript("यह गलत लिपि में आया", ["en-US", "am-ET"]);
  const prompt = buildTranscriptRetryPrompt("Transcribe verbatim.", quality);
  assert.ok(prompt.length <= 4000);
  assert.match(prompt, /expected scripts from that profile: latin, ethiopic/);
  assert.match(prompt, /preserve genuine code-switches/);
  assert.doesNotMatch(prompt, /Bengali/);
});
