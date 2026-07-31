#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { buildVoiceReplayCorpus } = require("../lib/voice-replay-corpus");

const dataDir = process.argv[2] ? path.resolve(process.argv[2]) : "";
const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : "";
if (!dataDir) throw new Error("usage: build-voice-replay-corpus.js <data-dir> [output.json]");
const corpus = buildVoiceReplayCorpus({
  dataDir,
  maxSamples: process.env.VOICE_REPLAY_MAX_SAMPLES || 100,
  requireLocalAudio: process.env.VOICE_REPLAY_ALLOW_REMOTE !== "1",
});
const json = `${JSON.stringify(corpus, null, 2)}\n`;
if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, json, { mode: 0o600 });
  console.log(JSON.stringify({
    ok: true,
    output: outputPath,
    selected_turns: corpus.selection.selected_turns,
    private_corpus: true,
  }, null, 2));
} else {
  process.stdout.write(json);
}
