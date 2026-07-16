#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { evaluateSttTranscript, rejectedTranscriptEvidence } = require(path.resolve(
  __dirname,
  "..",
  "lib",
  "stt-transcript-policy",
));

for (const accepted of [
  "store as geez",
  "ይሄ ገጽ ምንድነው?",
  "Geʽez ግዕዝ — 123 😀",
  "cafe\u0301",
]) {
  assert.equal(evaluateSttTranscript(accepted).accepted, true, `expected allowed transcript: ${accepted}`);
}

const liveFailure = "वायरस सभा አንቺ...";
const rejected = evaluateSttTranscript(liveFailure);
assert.equal(rejected.accepted, false, "the exact live Devanagari/Ethiopic failure must be rejected");
assert.deepEqual(rejected.disallowed_scripts, ["Devanagari"]);
assert.equal(rejectedTranscriptEvidence(rejected, { phase: "streaming_final", providerLanguageCode: "am-ET" }).candidate_text, liveFailure);

for (const [candidate, script] of [
  ["यह गज में दो।", "Devanagari"],
  ["مرحبا", "Arabic"],
  ["привет", "Cyrillic"],
  ["你好", "Han"],
]) {
  const result = evaluateSttTranscript(candidate);
  assert.equal(result.accepted, false, `expected rejected transcript: ${candidate}`);
  assert.ok(result.disallowed_scripts.includes(script), `expected ${script} evidence`);
}

console.log("smoke-stt-transcript-policy: ok");
