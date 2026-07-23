import assert from "node:assert/strict";
import test from "node:test";
import { finalizeActiveVideoCapture } from "../extension/video-capture-finalization.js";

test("video capture remains active until the recorder emits its terminal chunk", async () => {
  const chunks = [];
  const capture = { discarded: false };
  let active = capture;

  const finalized = await finalizeActiveVideoCapture({
    capture,
    getActiveCapture: () => active,
    clearActiveCapture: () => { active = null; },
    stopRecorder: async () => {
      if (active === capture && !capture.discarded) chunks.push("terminal");
    },
  });

  assert.equal(finalized, true);
  assert.deepEqual(chunks, ["terminal"]);
  assert.equal(active, null);
});

test("stale capture cannot clear a newer active recording", async () => {
  const stale = {};
  const current = {};
  let active = current;
  let stopped = false;

  const finalized = await finalizeActiveVideoCapture({
    capture: stale,
    getActiveCapture: () => active,
    clearActiveCapture: () => { active = null; },
    stopRecorder: async () => { stopped = true; },
  });

  assert.equal(finalized, false);
  assert.equal(stopped, false);
  assert.equal(active, current);
});
