"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { errorRate, inspectTranscriptScript } = require("../lib/transcript-quality");

test("accepts Latin and Ethiopic in an English-Amharic recognition profile", () => {
  const result = inspectTranscriptScript("hello ሰላም", ["en-US", "am-ET"]);
  assert.equal(result.accepted, true);
  assert.equal(result.foreign_letters, 0);
  assert.equal(result.policy, "latin-ethiopic-only");
});

test("rejects Devanagari and Bengali output before reasoning or rendering", () => {
  for (const transcript of ["नमस्ते", "হ্যালো"]) {
    const result = inspectTranscriptScript(transcript, ["en-US", "am-ET"]);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "wrong_script");
    assert.ok(result.foreign_letters > 0);
    assert.ok(result.foreign_code_points.every((point) => /^U\+[0-9A-F]+$/.test(point)));
  }
});

test("does not apply the bilingual script policy to unrelated configured languages", () => {
  assert.equal(inspectTranscriptScript("नमस्ते", ["hi-IN"]).accepted, true);
});

test("computes deterministic WER and Unicode-aware CER", () => {
  assert.equal(errorRate("hello world", "hello there"), 0.5);
  assert.equal(errorRate("ሰላም", "ሰላ", "character"), 1 / 3);
});
