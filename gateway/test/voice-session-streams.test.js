"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  abortSttStream,
  commitLiveTextSession,
} = require("../lib/voice-session-streams");

test("abortSttStream clears ownership even when provider cleanup fails", () => {
  const failure = new Error("provider abort failed");
  const stream = {
    abort() {
      throw failure;
    },
  };
  const turn = { sttStream: stream };

  assert.doesNotThrow(() => abortSttStream(turn));
  assert.equal(turn.sttStream, null);
  assert.doesNotThrow(() => abortSttStream(null));
  assert.doesNotThrow(() => abortSttStream({ sttStream: null }));
});

test("commitLiveTextSession forwards exact text and returns provider completion", async () => {
  const completion = Promise.resolve({ transcript: "typed", assistant_text: "done" });
  const sent = [];
  const turn = {
    liveSession: {
      done: completion,
      sendText(text) {
        sent.push(text);
      },
    },
  };

  assert.deepEqual(
    await commitLiveTextSession(turn, "typed exactly"),
    { transcript: "typed", assistant_text: "done" },
  );
  assert.deepEqual(sent, ["typed exactly"]);
});

test("commitLiveTextSession propagates synchronous provider failures", async () => {
  const failure = new Error("text transport closed");
  const turn = {
    liveSession: {
      done: Promise.resolve(),
      sendText() {
        throw failure;
      },
    },
  };

  await assert.rejects(commitLiveTextSession(turn, "typed"), failure);
});
