import assert from "node:assert/strict";
import test from "node:test";

import { createVoiceSamplerRuntime } from "../extension/voice-sampler-runtime.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function terminalMessages(messages) {
  return messages.filter((message) => message.cmd === "done" || message.cmd === "error");
}

function createHarness() {
  const messages = [];
  const closes = [];
  const starts = [];
  const runtime = createVoiceSamplerRuntime({
    send(tabId, msg) {
      messages.push({ tabId, ...msg });
    },
    closeSession(id, reason) {
      closes.push({ id, reason });
    },
    startSample({ sampler, sample, sampleIndex, onSessionCreated }) {
      const setup = deferred();
      starts.push({
        sampler,
        sample,
        sampleIndex,
        onSessionCreated,
        resolve: setup.resolve,
        reject: setup.reject,
      });
      return setup.promise;
    },
  });
  return { runtime, messages, closes, starts };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("cancel during setup closes the in-flight sampler session without a terminal cue", async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const run = harness.runtime.start(7, "cue-cancel", [{ voice: "Kore", text: "one" }], { signal: controller.signal });
  assert.equal(harness.starts.length, 1);
  harness.starts[0].onSessionCreated("session-cancel");
  assert.deepEqual(harness.closes, []);

  controller.abort();
  assert.deepEqual(harness.closes, [{ id: "session-cancel", reason: "cancelled" }]);

  harness.starts[0].resolve({ voiceSessionId: "session-cancel" });
  await run;
  await settle();

  assert.deepEqual(terminalMessages(harness.messages), []);
});

test("superseding a sampler closes the stale setup and only the replacement emits a terminal cue", async () => {
  const harness = createHarness();
  const firstRun = harness.runtime.start(7, "cue-old", [{ voice: "Kore", text: "old" }]);
  harness.starts[0].onSessionCreated("session-old");

  const secondRun = harness.runtime.start(7, "cue-new", [{ voice: "Puck", text: "new" }]);
  assert.equal(harness.starts.length, 2);
  assert.deepEqual(harness.closes, [{ id: "session-old", reason: "superseded" }]);

  harness.starts[0].resolve({ voiceSessionId: "session-old" });
  harness.starts[1].onSessionCreated("session-new");
  harness.starts[1].resolve({ voiceSessionId: "session-new" });
  await Promise.all([firstRun, secondRun]);

  harness.runtime.handleSessionTerminal("session-new", { failed: false, closeReason: "sample complete" });
  await settle();

  assert.deepEqual(terminalMessages(harness.messages), [
    { tabId: 7, cmd: "done", cueId: "cue-new", summary: "Finished 1 voice samples.", speak: "" },
  ]);
});

test("tab close cancels setup without an error cue", async () => {
  const harness = createHarness();
  const run = harness.runtime.start(11, "cue-tab", [{ voice: "Kore", text: "tab" }]);
  harness.starts[0].onSessionCreated("session-tab");

  harness.runtime.cancel(11, "tab closed");
  assert.deepEqual(harness.closes, [{ id: "session-tab", reason: "tab closed" }]);

  harness.starts[0].resolve({ voiceSessionId: "session-tab" });
  await run;
  await settle();

  assert.deepEqual(terminalMessages(harness.messages), []);
});

test("socket error is terminal for the sampler and does not double-report", async () => {
  const harness = createHarness();
  const run = harness.runtime.start(5, "cue-error", [{ voice: "Kore", text: "fail" }]);
  harness.starts[0].onSessionCreated("session-error");
  harness.starts[0].resolve({ voiceSessionId: "session-error" });
  await run;

  assert.equal(harness.runtime.handleSessionTerminal("session-error", {
    failed: true,
    message: "Live voice connection failed.",
    closeReason: "sample failed",
  }), true);
  assert.equal(harness.runtime.handleSessionTerminal("session-error", {
    failed: true,
    message: "Live voice connection closed.",
    closeReason: "sample failed",
  }), false);

  assert.deepEqual(harness.closes, [{ id: "session-error", reason: "sample failed" }]);
  assert.deepEqual(terminalMessages(harness.messages), [
    { tabId: 5, cmd: "error", cueId: "cue-error", text: "Live voice connection failed." },
  ]);
});

test("socket close is terminal for the sampler", async () => {
  const harness = createHarness();
  const run = harness.runtime.start(6, "cue-close", [{ voice: "Kore", text: "close" }]);
  harness.starts[0].onSessionCreated("session-close");
  harness.starts[0].resolve({ voiceSessionId: "session-close" });
  await run;

  assert.equal(harness.runtime.handleSessionTerminal("session-close", {
    failed: true,
    message: "Live voice connection closed.",
    closeReason: "sample failed",
  }), true);

  assert.deepEqual(harness.closes, [{ id: "session-close", reason: "sample failed" }]);
  assert.deepEqual(terminalMessages(harness.messages), [
    { tabId: 6, cmd: "error", cueId: "cue-close", text: "Live voice connection closed." },
  ]);
});

test("sampler starts the next sample only after the prior terminal event and emits one final cue", async () => {
  const harness = createHarness();
  const run = harness.runtime.start(9, "cue-serial", [
    { voice: "Kore", text: "one" },
    { voice: "Puck", text: "two" },
  ]);

  assert.equal(harness.starts.length, 1);
  harness.starts[0].onSessionCreated("session-1");
  harness.starts[0].resolve({ voiceSessionId: "session-1" });
  await run;
  assert.equal(harness.starts.length, 1);

  assert.equal(harness.runtime.handleSessionTerminal("session-1", { failed: false, closeReason: "sample complete" }), true);
  assert.equal(harness.starts.length, 2);

  harness.starts[1].onSessionCreated("session-2");
  harness.starts[1].resolve({ voiceSessionId: "session-2" });
  await settle();
  assert.equal(harness.runtime.handleSessionTerminal("session-2", { failed: false, closeReason: "sample complete" }), true);
  await settle();

  assert.deepEqual(
    harness.messages.filter((message) => message.cmd === "progress").map((message) => message.text),
    [
      "sampling Kore (1 of 2)…",
      "sampling Puck (2 of 2)…",
    ]
  );
  assert.deepEqual(terminalMessages(harness.messages), [
    { tabId: 9, cmd: "done", cueId: "cue-serial", summary: "Finished 2 voice samples.", speak: "" },
  ]);
});
