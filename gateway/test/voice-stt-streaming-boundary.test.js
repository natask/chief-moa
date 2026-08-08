"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createStreamingSttSession } = require("../lib/voice-stt-streaming");

test("reports Chirp final offsets as exact absolute even PCM byte boundaries", async () => {
  const streams = [];
  const boundaries = [];
  const stream = createStreamingSttSession({
    openStream() {
      const value = new EventEmitter();
      value.write = () => true;
      value.end = () => setImmediate(() => value.emit("end"));
      streams.push(value);
      return value;
    },
    configMessage: {},
    parseResults: (data) => data.results,
    bytesPerSecond: 32000,
    onFinalSegment: async (value) => boundaries.push(value),
  });
  stream.push(Buffer.alloc(640));
  streams[0].emit("data", {
    results: [{ transcript: "natural phrase", isFinal: true, resultEndOffset: "0:10000000" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].absolute_audio_byte_offset, 320);
  assert.equal(boundaries[0].result_end_offset_ms, 10);
  assert.equal(stream.snapshot().finalSegments[0].endAudioByteOffset, 320);
  stream.push(Buffer.alloc(640));
  streams[0].emit("data", {
    results: [{ transcript: "natural phrase next words", isFinal: true, resultEndOffset: "0:30000000" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(boundaries[1].transcript, "next words", "cumulative provider finals expose only the new audio span text");
  assert.equal(boundaries[1].absolute_audio_byte_offset, 960);
  assert.equal(stream.snapshot().committedText, "natural phrase next words");
  stream.abort();
});

test("rejects malformed, future, and regressing final offsets", async () => {
  const streams = [];
  const boundaries = [];
  const stream = createStreamingSttSession({
    openStream() {
      const value = new EventEmitter(); value.write = () => true;
      value.end = () => setImmediate(() => value.emit("end")); streams.push(value); return value;
    },
    configMessage: {}, parseResults: (data) => data.results, bytesPerSecond: 32000, frameBytes: 4,
    onFinalSegment: async (value) => boundaries.push(value),
  });
  stream.push(Buffer.alloc(640));
  for (const resultEndOffset of ["bad", "0:30000000"]) {
    streams[0].emit("data", { results: [{ transcript: `ignored ${resultEndOffset}`, isFinal: true, resultEndOffset }] });
  }
  streams[0].emit("data", { results: [{ transcript: "accepted", isFinal: true, resultEndOffset: "0:10000000" }] });
  streams[0].emit("data", { results: [{ transcript: "regression", isFinal: true, resultEndOffset: "0:5000000" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(boundaries.map((value) => value.absolute_audio_byte_offset), [320]);
  assert.equal(boundaries[0].absolute_audio_byte_offset % 4, 0);
  stream.abort();
});

test("finalize waits for an in-flight rotation and includes buffered PCM", async () => {
  const streams = [];
  const stream = createStreamingSttSession({
    openStream() {
      const value = new EventEmitter();
      value.write = (message) => {
        if (streams.length === 2 && message.audio) {
          setImmediate(() => value.emit("data", {
            results: [{ transcript: "world", isFinal: true }],
          }));
        }
        return true;
      };
      value.end = () => setImmediate(() => value.emit("end"));
      streams.push(value);
      return value;
    },
    configMessage: {},
    parseResults: (data) => data.results,
    drainTimeoutMs: 200,
    rotateAfterMs: 60000,
  });
  stream.push(Buffer.alloc(320));
  streams[0].emit("data", { results: [{ transcript: "hello", isFinal: true }] });
  streams[0].emit("error", new Error("transient stream failure"));
  stream.push(Buffer.alloc(320));

  const result = await stream.finalize();

  assert.equal(result.ok, true);
  assert.equal(result.text, "hello world");
  assert.equal(result.rotations, 1);
  assert.equal(stream._state.pendingChunks.length, 0);
  assert.equal(stream._state.streamedAudioBytes, stream._state.totalAudioBytes);
});

test("finalize rejects a streaming candidate when PCM coverage is incomplete", async () => {
  const providerStream = new EventEmitter();
  let writes = 0;
  providerStream.write = () => {
    writes += 1;
    if (writes > 1) throw new Error("audio write failed");
    return true;
  };
  providerStream.end = () => setImmediate(() => providerStream.emit("end"));
  const stream = createStreamingSttSession({
    openStream: () => providerStream,
    configMessage: {},
    parseResults: (data) => data.results,
    drainTimeoutMs: 200,
    rotateAfterMs: 60000,
  });
  stream.push(Buffer.alloc(320));
  providerStream.emit("data", { results: [{ transcript: "partial candidate", isFinal: true }] });

  const result = await stream.finalize();

  assert.equal(result.ok, false, "the provider must choose retained-audio batch fallback");
  assert.match(result.error, /coverage incomplete/);
  assert.equal(stream._state.streamedAudioBytes, 0);
  assert.equal(stream._state.totalAudioBytes, 320);
});
