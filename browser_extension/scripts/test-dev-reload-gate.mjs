import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPOSE_STALE_MS,
  devReloadDecision,
  interruptionReason,
} from "../extension/dev-reload-gate.js";

const idle = { now: 1_000_000 };

test("an idle extension reloads on a new version", () => {
  const decision = devReloadDecision({ nextVersion: 2, previousVersion: 1, state: idle });
  assert.equal(decision.action, "reload");
});

test("the first sighting only records a baseline", () => {
  assert.equal(devReloadDecision({ nextVersion: 7, previousVersion: null }).action, "record");
  assert.equal(devReloadDecision({ nextVersion: 7, previousVersion: 7 }).action, "none");
  assert.equal(devReloadDecision({ nextVersion: 0, previousVersion: 7 }).action, "none");
});

test("a live turn defers the reload instead of eating it", () => {
  const cases = [
    [{ voiceCaptureActive: true }, "a voice capture is open"],
    [{ recordSessionActive: true }, "an audio note is recording"],
    [{ videoNoteActive: true }, "a video note is recording"],
    [{ turnStatus: "responding" }, "a turn is still streaming"],
    [{ turnStatus: "Running" }, "a turn is still streaming"],
    [{ agentTaskCount: 1 }, "an agent run is in flight"],
    [{ agentLoopActive: true }, "an agent run is in flight"],
  ];
  for (const [state, reason] of cases) {
    const decision = devReloadDecision({ nextVersion: 2, previousVersion: 1, state: { ...idle, ...state } });
    assert.equal(decision.action, "defer", JSON.stringify(state));
    assert.equal(decision.reason, reason);
    // A deferral must never claim the version, or the deploy is dropped when
    // the turn ends rather than applied late.
    assert.equal(decision.version, 2);
  }
});

test("a finished turn no longer blocks a waiting reload", () => {
  for (const status of ["done", "error", "", "idle"]) {
    const decision = devReloadDecision({ nextVersion: 2, previousVersion: 1, state: { ...idle, turnStatus: status } });
    assert.equal(decision.action, "reload", status);
  }
});

test("an unsent typed line blocks, but an abandoned caret does not", () => {
  const fresh = { ...idle, composingAt: idle.now - 1000 };
  assert.equal(interruptionReason(fresh), "there is an unsent line in the typing box");
  const stale = { ...idle, composingAt: idle.now - COMPOSE_STALE_MS - 1 };
  assert.equal(interruptionReason(stale), "");
  assert.equal(interruptionReason({ ...idle, composingAt: 0 }), "");
});

test("speech outranks the other reasons in the report", () => {
  assert.equal(
    interruptionReason({ ...idle, voiceCaptureActive: true, turnStatus: "responding", agentTaskCount: 3 }),
    "a voice capture is open",
  );
});
