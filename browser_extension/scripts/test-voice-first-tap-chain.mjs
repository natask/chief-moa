import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "..", "extension", "voice-first-tap-chain.js"), "utf8");

// A hand-driven clock: the chain is all timers, and real ones would make these
// tests slow and flaky for no gain in confidence.
function harness() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const sandbox = { globalThis: null };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    api: sandbox.AgeeVoiceFirstTapChain,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    at: () => now,
  };
}

function press(chain, h, { x = 0, y = 0, pointerId = 1 } = {}) {
  return chain.press({ timeStamp: h.at(), clientX: x, clientY: y, pointerId });
}

function tap(chain, h, joined, { x = 0, y = 0 } = {}) {
  chain.tap({ timeStamp: h.at(), clientX: x, clientY: y }, joined);
}

test("a run of clicks resolves once, after the window, with its full count", () => {
  const h = harness();
  const resolved = [];
  const chain = h.api.create({
    windowMs: 280, slopPx: 28, holdMs: 340,
    onResolve: (count) => resolved.push(count),
    setTimer: h.setTimer, clearTimer: h.clearTimer,
  });

  tap(chain, h, press(chain, h));
  h.advance(60);
  tap(chain, h, press(chain, h));
  h.advance(60);
  tap(chain, h, press(chain, h));
  // Nothing has resolved yet: the window is still open for a fourth click.
  assert.deepEqual(resolved, []);
  h.advance(300);
  assert.deepEqual(resolved, [3], "one resolution carrying the whole run");
});

test("a press outside the window starts a fresh run", () => {
  const h = harness();
  const resolved = [];
  const chain = h.api.create({
    windowMs: 280, slopPx: 28, holdMs: 340,
    onResolve: (count) => resolved.push(count),
    setTimer: h.setTimer, clearTimer: h.clearTimer,
  });

  tap(chain, h, press(chain, h));
  h.advance(400);
  assert.deepEqual(resolved, [1]);
  tap(chain, h, press(chain, h));
  h.advance(400);
  assert.deepEqual(resolved, [1, 1]);
});

// A press that lands somewhere else supersedes whatever was pending rather
// than racing it: two actions from one gesture is the worse failure.
test("a press outside the slop supersedes the pending run", () => {
  const h = harness();
  const resolved = [];
  const chain = h.api.create({
    windowMs: 280, slopPx: 28, holdMs: 340,
    onResolve: (count) => resolved.push(count),
    setTimer: h.setTimer, clearTimer: h.clearTimer,
  });

  tap(chain, h, press(chain, h, { x: 0 }));
  h.advance(60);
  tap(chain, h, press(chain, h, { x: 400 }), { x: 400 });
  h.advance(400);
  assert.deepEqual(resolved, [1], "the far press replaced the pending run, it did not extend it");
});

test("a still press becomes a hold and abandons the run", () => {
  const h = harness();
  const holds = [];
  const resolved = [];
  const chain = h.api.create({
    windowMs: 280, slopPx: 28, holdMs: 340,
    onHold: (pointerId) => holds.push(pointerId),
    onResolve: (count) => resolved.push(count),
    setTimer: h.setTimer, clearTimer: h.clearTimer,
  });

  press(chain, h, { pointerId: 7 });
  h.advance(400);
  assert.deepEqual(holds, [7]);
  assert.deepEqual(resolved, [], "a hold is not a click");
});

test("releasing before the hold threshold cancels the hold", () => {
  const h = harness();
  const holds = [];
  const chain = h.api.create({
    windowMs: 280, slopPx: 28, holdMs: 340,
    onHold: (pointerId) => holds.push(pointerId),
    setTimer: h.setTimer, clearTimer: h.clearTimer,
  });

  press(chain, h);
  h.advance(100);
  chain.clearHoldTimer();
  h.advance(500);
  assert.deepEqual(holds, []);
});

test("reset drops a pending run without resolving it", () => {
  const h = harness();
  const resolved = [];
  const chain = h.api.create({
    windowMs: 280, slopPx: 28, holdMs: 340,
    onResolve: (count) => resolved.push(count),
    setTimer: h.setTimer, clearTimer: h.clearTimer,
  });

  tap(chain, h, press(chain, h));
  chain.reset();
  h.advance(500);
  assert.deepEqual(resolved, []);
});
