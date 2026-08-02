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
  stream.abort();
});
