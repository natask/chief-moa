import assert from "node:assert/strict";
import test from "node:test";
import { pcm16VoiceActivity } from "../extension/browser-voice-activity.js";
import { createPcm16Resampler } from "../extension/offscreen-audio-resampler.js";

function pcmBuffer(value, samples = 160) {
  const pcm = new Int16Array(samples);
  pcm.fill(value);
  return pcm.buffer;
}

test("area resampling preserves duration and attenuates aliased detail", () => {
  const resampler = createPcm16Resampler(48000, 16000);
  const input = new Float32Array(480);
  for (let index = 0; index < input.length; index += 3) {
    input[index] = 1;
    input[index + 1] = -1;
    input[index + 2] = 1;
  }
  const output = new Int16Array(resampler.process(input));
  assert.equal(output.length, 160);
  assert.ok(Math.max(...output.map(Math.abs)) < 12000, "three source samples should be averaged instead of point-decimated");
});

test("continuation VAD retains quiet technical-phrase tails without triggering initial speech", () => {
  const quietTail = pcmBuffer(180);
  assert.equal(pcm16VoiceActivity(quietTail).speech, false);
  assert.equal(pcm16VoiceActivity(quietTail, { continuing: true }).speech, true);
  assert.equal(pcm16VoiceActivity(pcmBuffer(0), { continuing: true }).speech, false);
});
