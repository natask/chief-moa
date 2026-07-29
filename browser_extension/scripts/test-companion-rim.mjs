import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const context = vm.createContext({});
vm.runInContext(readFileSync("extension/companion-level.js", "utf8"), context);
vm.runInContext(readFileSync("extension/companion-rim.js", "utf8"), context);
const { createCompanionRim } = context.AgeeCompanionRim;

function harness() {
  const written = [];
  const frames = [];
  let clock = 0;
  const root = {
    style: {
      setProperty(name, value) {
        written.push([name, value]);
      },
    },
  };
  const rim = createCompanionRim(root, {
    maths: context.AgeeCompanionLevel,
    requestAnimationFrame: (callback) => frames.push(callback) && frames.length,
    cancelAnimationFrame: () => frames.splice(0, frames.length),
    now: () => clock,
  });
  return {
    rim,
    written,
    advance(ms) {
      clock += ms;
    },
    runFrame() {
      const pending = frames.splice(0, frames.length);
      for (const callback of pending) callback();
      return pending.length;
    },
  };
}

test("listening writes --agee-level and nothing else", () => {
  const h = harness();
  h.rim.setState("listening");
  h.rim.pushMicLevel(0.05);
  h.runFrame();
  assert.equal(h.written.length, 1);
  assert.equal(h.written[0][0], "--agee-level");
  assert.ok(Number(h.written[0][1]) > 0);
});

test("an idle companion writes zero and stops asking for frames", () => {
  const h = harness();
  h.rim.setState("listening");
  h.rim.pushMicLevel(0.4);
  h.runFrame();
  h.rim.setState("idle");
  assert.deepEqual(h.written.at(-1), ["--agee-level", "0.000"]);
  assert.equal(h.runFrame(), 0, "idle must not keep a frame loop alive");
});

test("levels arriving while not listening are ignored", () => {
  const h = harness();
  h.rim.pushMicLevel(0.9);
  assert.equal(h.runFrame(), 0);
  assert.equal(h.written.length, 0);
  assert.equal(h.rim.level, 0);
});

test("a stalled microphone releases the rim instead of freezing it", () => {
  const h = harness();
  h.rim.setState("listening");
  h.rim.pushMicLevel(0.4);
  h.runFrame();
  const peak = h.rim.level;
  h.advance(500);
  h.runFrame();
  assert.ok(h.rim.level < peak, "a stale sample must decay");
  assert.ok(h.rim.level > 0, "one stale frame must not blank the rim");
});

test("speaking runs on the synthetic level with no mic samples at all", () => {
  const h = harness();
  h.rim.setState("speaking");
  h.runFrame();
  assert.equal(h.written.at(-1)[1], "0.350");
  h.advance(1000 / 2.4 / 4);
  h.runFrame();
  assert.equal(h.written.at(-1)[1], "0.600");
});

test("repeating the same level does not repeat the style write", () => {
  const h = harness();
  h.rim.setState("listening");
  h.rim.pushMicLevel(0);
  h.runFrame();
  const afterFirst = h.written.length;
  h.rim.pushMicLevel(0);
  h.runFrame();
  assert.equal(h.written.length, afterFirst);
});
