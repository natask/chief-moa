"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createSpeechChunker, createSpeakStreamSanitizer } = require("../lib/voice-chunker");

function collectSanitizer(options = {}) {
  const deltas = [];
  const sanitizer = createSpeakStreamSanitizer({ ...options, onDelta: (delta) => deltas.push(delta) });
  return { sanitizer, deltas };
}

test("chunker normalizes options and reports progress", () => {
  const chunker = createSpeechChunker({
    firstChunkMaxChars: 0,
    minChars: "bad",
    maxChars: 1,
    flushTimeoutMs: -1,
  });
  assert.equal(chunker.minChars, 60);
  assert.equal(chunker.flushTimeoutMs, 1200);
  assert.equal(chunker.emittedCount(), 0);
  assert.deepEqual(chunker.push(undefined), []);
  assert.deepEqual(chunker.push("Done!"), ["Done!"]);
  assert.equal(chunker.emittedCount(), 1);
});

test("chunker covers punctuation trails, holds, and hard boundaries", () => {
  let chunker = createSpeechChunker({ firstChunkMaxChars: 20, minChars: 5, maxChars: 20 });
  assert.deepEqual(chunker.push("Okay!” Next"), ["Okay!”"]);
  assert.deepEqual(chunker.flush(), ["Next"]);

  chunker = createSpeechChunker({ minChars: 5 });
  assert.deepEqual(chunker.push("Wait!next"), []);
  assert.deepEqual(chunker.flush(), ["Wait!next"]);

  chunker = createSpeechChunker({ minChars: 5 });
  assert.deepEqual(chunker.push("Version 3."), []);
  assert.deepEqual(chunker.flush(), ["Version 3."]);

  chunker = createSpeechChunker({ firstChunkMaxChars: 8, maxChars: 8 });
  assert.deepEqual(chunker.push("[tag]abcdefghijk"), ["[tag]abc"]);
  assert.deepEqual(chunker.flush(), ["defghijk"]);

  chunker = createSpeechChunker();
  assert.deepEqual(chunker.forceBreak(), []);
  chunker.push("unspaced");
  assert.deepEqual(chunker.forceBreak(), ["unspaced"]);
});

test("chunker treats overlong and multiline brackets as prose", () => {
  const long = `[${"x".repeat(70)}] sentence.`;
  const one = createSpeechChunker({ firstChunkMaxChars: 200 });
  assert.deepEqual(one.push(long), [long]);

  const multiline = createSpeechChunker({ firstChunkMaxChars: 200 });
  assert.deepEqual(multiline.push("[not\na tag] Done."), ["[not\na tag] Done."]);

  const streaming = createSpeechChunker({ firstChunkMaxChars: 200 });
  assert.deepEqual(streaming.push("[still streaming"), []);
  assert.deepEqual(streaming.push("] Yes."), ["[still streaming] Yes."]);
});

test("sanitizer releases non-style prefixes and held literal brackets", () => {
  let result = collectSanitizer();
  result.sanitizer.push("Plain text");
  result.sanitizer.end();
  assert.equal(result.deltas.join(""), "Plain text");

  result = collectSanitizer();
  result.sanitizer.push("[ordinary] words");
  result.sanitizer.end();
  assert.equal(result.deltas.join(""), "words");

  result = collectSanitizer();
  result.sanitizer.push("[unfinished");
  result.sanitizer.end();
  assert.equal(result.deltas.join(""), "[unfinished");

  result = collectSanitizer();
  result.sanitizer.push(`[${"x".repeat(70)}] end`);
  result.sanitizer.end();
  assert.equal(result.deltas.join(""), `[${"x".repeat(70)}] end`);

  result = collectSanitizer();
  result.sanitizer.push("[line\nbreak] end");
  result.sanitizer.end();
  assert.equal(result.deltas.join(""), "[line break] end");
});

test("sanitizer style delivery is best effort and resolution is bounded", () => {
  const delivered = collectSanitizer({ onStyle: () => { throw new Error("listener failed"); } });
  delivered.sanitizer.push("[style: calm] Continue.");
  delivered.sanitizer.end();
  assert.equal(delivered.deltas.join(""), "Continue.");

  const tooLong = collectSanitizer();
  tooLong.sanitizer.push("[" + "x".repeat(80));
  tooLong.sanitizer.end();
  assert.equal(tooLong.deltas.join(""), "[" + "x".repeat(80));

  const newline = collectSanitizer();
  newline.sanitizer.push("[style: unfinished\nwords");
  newline.sanitizer.end();
  assert.equal(newline.deltas.join(""), "[style: unfinished words");
});

test("sanitizer enforces dynamic caps around spaces, tags, and literals", () => {
  let cap = 5;
  const prose = collectSanitizer({ maxChars: () => cap });
  prose.sanitizer.push("ab cd");
  cap = 4;
  prose.sanitizer.push(" e");
  prose.sanitizer.end();
  assert.equal(prose.deltas.join(""), "ab cd");
  assert.equal(prose.sanitizer.capped(), true);

  const tag = collectSanitizer({ maxChars: 4, keepTags: true, isAllowedTag: () => true });
  tag.sanitizer.push("a [x]");
  tag.sanitizer.end();
  assert.equal(tag.deltas.join(""), "a");
  assert.equal(tag.sanitizer.capped(), true);

  const literal = collectSanitizer({ maxChars: 2 });
  literal.sanitizer.push("a [" + "x".repeat(70));
  literal.sanitizer.end();
  assert.equal(literal.deltas.join(""), "a ");
  assert.equal(literal.sanitizer.capped(), true);
});

test("sanitizer defaults callbacks and ignores input after a fence", () => {
  const sanitizer = createSpeakStreamSanitizer();
  sanitizer.push(null);
  sanitizer.push("text ``` code");
  const before = sanitizer.emittedLength();
  sanitizer.push("ignored");
  sanitizer.end();
  assert.equal(sanitizer.emittedLength(), before);
});
