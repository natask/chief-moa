import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const context = vm.createContext({});
vm.runInContext(readFileSync("extension/companion-level.js", "utf8"), context);
const maths = context.AgeeCompanionLevel;

test("silence, noise and nonsense all map to zero", () => {
  assert.equal(maths.levelFromRms(0), 0);
  assert.equal(maths.levelFromRms(-1), 0);
  assert.equal(maths.levelFromRms(NaN), 0);
  assert.equal(maths.levelFromRms(undefined), 0);
  // -55 dBFS is the floor: exactly at it, the rim has not moved yet.
  assert.equal(maths.levelFromRms(10 ** (-55 / 20)), 0);
});

test("the 40 dB window above the floor spans the whole rim", () => {
  // Quiet speech near -45 dBFS must still visibly move the rim.
  assert.ok(maths.levelFromRms(10 ** (-45 / 20)) > 0.2);
  assert.equal(maths.levelFromRms(10 ** (-35 / 20)).toFixed(3), "0.500");
  assert.equal(maths.levelFromRms(10 ** (-15 / 20)), 1);
  // Full scale cannot overshoot the top of the range.
  assert.equal(maths.levelFromRms(1), 1);
});

test("the envelope attacks fast and releases slowly", () => {
  assert.equal(maths.envelopeStep(0, 1).toFixed(3), "0.600");
  assert.equal(maths.envelopeStep(1, 0).toFixed(3), "0.880");
  // Rising is more than four times faster than falling, which is what stops the
  // rim strobing between syllables.
  const rise = maths.envelopeStep(0.2, 0.8) - 0.2;
  const fall = 0.8 - maths.envelopeStep(0.8, 0.2);
  assert.ok(rise > fall * 4);
});

test("a live envelope reaches a loud sample in one step and decays over many", () => {
  const envelope = maths.createLevelEnvelope();
  assert.equal(envelope.value, 0);
  envelope.push(1);
  assert.equal(envelope.value.toFixed(3), "0.600");
  envelope.push(1);
  assert.ok(envelope.value > 0.83);
  const afterOneDecay = (envelope.decay(), envelope.value);
  assert.ok(afterOneDecay > 0.7, "one quiet frame must not blank the rim");
  for (let i = 0; i < 60; i += 1) envelope.decay();
  assert.ok(envelope.value < 0.01, "sustained silence must settle the rim");
  envelope.reset();
  assert.equal(envelope.value, 0);
});

test("the synthetic speaking level stays inside a visible band", () => {
  for (let ms = 0; ms < 2000; ms += 7) {
    const level = maths.speakingLevel(ms);
    assert.ok(level >= 0.1 && level <= 0.6, `speaking level out of band at ${ms}ms: ${level}`);
  }
  assert.equal(maths.speakingLevel(0).toFixed(3), "0.350");
  // 2.4Hz: a quarter period is ~104ms and lands on the peak.
  assert.equal(maths.speakingLevel(1000 / 2.4 / 4).toFixed(3), "0.600");
  assert.equal(maths.speakingLevel(NaN).toFixed(3), "0.350");
});

test("the CSS var write is a short bounded string", () => {
  assert.equal(maths.formatLevel(0), "0.000");
  assert.equal(maths.formatLevel(1), "1.000");
  assert.equal(maths.formatLevel(2), "1.000");
  assert.equal(maths.formatLevel(-3), "0.000");
  assert.equal(maths.formatLevel("0.5"), "0.500");
  assert.equal(maths.formatLevel(NaN), "0.000");
});
