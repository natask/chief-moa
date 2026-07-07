#!/usr/bin/env node
"use strict";

// Unit tests for gateway/lib/voice-chunker.js: the streaming sentence/clause
// chunker and the incremental speak-text sanitizer. Pure, no network, no
// timers — wired into `npm run check` via the smoke manifest.

const assert = require("node:assert");
const path = require("node:path");

const { createSpeechChunker, createSpeakStreamSanitizer } = require(path.join(__dirname, "..", "lib", "voice-chunker"));

main();

function main() {
  firstChunkFastest();
  ethiopicBoundaries();
  latinAbbreviationGuards();
  decimalAndVersionGuards();
  ellipsisGuard();
  lowercaseContinuationGuard();
  clauseEndersPastMinChars();
  mixedEnglishAmharic();
  minMaxAndForceBreak();
  tagAtomicity();
  emptyAndWhitespaceStreams();
  sanitizerBasics();
  sanitizerStyleAndTags();
  sanitizerCapIsPrefix();
  console.log("test-voice-chunker: ok");
}

function chunker(overrides = {}) {
  return createSpeechChunker({ firstChunkMaxChars: 60, minChars: 60, maxChars: 220, ...overrides });
}

function firstChunkFastest() {
  // A short first sentence leaves as soon as the ender arrives.
  let c = chunker();
  assert.deepEqual(c.push("Sure."), ["Sure."], "a short first sentence must emit immediately");

  c = chunker();
  assert.deepEqual(c.push("ሰላም።"), ["ሰላም።"], "an Ethiopic first sentence must emit immediately");

  // Clause enders are accepted immediately on the first chunk.
  c = chunker();
  assert.deepEqual(c.push("Right, "), ["Right,"], "first-chunk clause ender must emit immediately");

  // The first-chunk hard cap is tighter than maxChars.
  c = chunker();
  const long = "word ".repeat(30); // 150 chars, no sentence ender
  const first = c.push(long);
  assert.ok(first.length >= 1, "a long enderless first delta must hard-split");
  assert.ok(first[0].length <= 60, `first chunk must respect firstChunkMaxChars (got ${first[0].length})`);
}

function ethiopicBoundaries() {
  const c = chunker({ minChars: 10 });
  const chunks = [];
  chunks.push(...c.push("ጤና ይስጥልኝ ውድ ጓደኛዬ።"));
  assert.equal(chunks.length, 1, "የ። ender must produce a chunk");
  assert.ok(chunks[0].endsWith("።"));

  // ፧ (question) and clause enders ፣ ፤ past minChars.
  const q = chunker({ minChars: 5 });
  const qs = q.push("እንዴት ነህ፧ ደህና ነኝ፣ አንተስ እንዴት ነህ ዛሬ፤ ");
  assert.ok(qs.length >= 2, `Ethiopic ፧ and ፣/፤ boundaries must split (got ${JSON.stringify(qs)})`);
  assert.ok(qs[0].endsWith("፧"), "the first chunk must end at the Ethiopic question mark");
}

function latinAbbreviationGuards() {
  const c = chunker();
  const out = [];
  out.push(...c.push("Dr. Smith met Mr. Jones at St. Marys e.g. on Tuesday. "));
  out.push(...c.flush());
  assert.equal(out.length, 1, `abbreviation periods must not split (got ${JSON.stringify(out)})`);
  assert.match(out[0], /^Dr\. Smith/);

  // Initials: J. R. R. Tolkien stays whole.
  const i = chunker();
  const initials = [];
  initials.push(...i.push("J. R. R. Tolkien wrote very long books indeed. "));
  initials.push(...i.flush());
  assert.equal(initials.length, 1, `single-letter initials must not split (got ${JSON.stringify(initials)})`);
}

function decimalAndVersionGuards() {
  const c = chunker();
  const out = [];
  out.push(...c.push("Pi is 3.14159 and the build is v2.5 as expected. "));
  out.push(...c.flush());
  assert.equal(out.length, 1, `decimal/version periods must not split (got ${JSON.stringify(out)})`);
}

function ellipsisGuard() {
  // ".." at the end of the buffer waits for more input rather than splitting.
  const c = chunker({ minChars: 5 });
  assert.deepEqual(c.push("Well.."), [], "a dot run still building must hold");
  const out = c.push(". Then it happened aloud. ");
  assert.ok(out.length >= 1, "the finished ellipsis must eventually split");
  assert.ok(out[0].endsWith("..."), `the ellipsis rides the chunk end (got ${JSON.stringify(out)})`);
}

function lowercaseContinuationGuard() {
  const c = chunker({ minChars: 5 });
  const out = [];
  out.push(...c.push("Open example.com now and tell me what loads. "));
  out.push(...c.flush());
  assert.equal(out.length, 1, `a period before lowercase must not split (got ${JSON.stringify(out)})`);
}

function clauseEndersPastMinChars() {
  // After the first chunk, a comma splits only once pending passes minChars.
  const c = chunker({ minChars: 30 });
  assert.deepEqual(c.push("Hi."), ["Hi."], "first chunk leaves fast");
  assert.deepEqual(c.push("one, two, "), [], "a comma under minChars must not split");
  const out = c.push("three four five six seven eight nine ten eleven, and more");
  assert.ok(out.length >= 1, "a clause ender past minChars must split");
  assert.ok(out[0].endsWith(","), `the clause chunk ends at the comma (got ${JSON.stringify(out)})`);
}

function mixedEnglishAmharic() {
  const c = chunker({ minChars: 10 });
  const out = [];
  out.push(...c.push("Good morning. እንዴት አደርክ። Let's begin now. "));
  out.push(...c.flush());
  assert.ok(out.length >= 3, `mixed-script sentences must split at both rule sets (got ${JSON.stringify(out)})`);
  assert.equal(out[0], "Good morning.");
  assert.equal(out[1], "እንዴት አደርክ።");
}

function minMaxAndForceBreak() {
  // maxChars hard split at the last whitespace.
  const c = chunker({ firstChunkMaxChars: 40, minChars: 20, maxChars: 80 });
  const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
  const out = c.push(words);
  assert.ok(out.length >= 1, "a buffer past maxChars must hard-split");
  for (const chunk of out) {
    assert.ok(chunk.length <= 80, `no chunk may exceed maxChars (got ${chunk.length})`);
    assert.ok(!/^\s|\s$/.test(chunk), "chunks are trimmed");
  }

  // Unspaced input splits at the cap exactly.
  const u = chunker({ firstChunkMaxChars: 10, minChars: 5, maxChars: 20 });
  const unspaced = u.push("abcdefghijklmnopqrstuvwxyz");
  assert.ok(unspaced.length >= 1, "unspaced input must still split");
  assert.equal(unspaced[0].length, 10, "unspaced first chunk splits at firstChunkMaxChars exactly");

  // forceBreak splits at the last whitespace once minChars is pending.
  const f = chunker({ minChars: 10 });
  f.push("Hello there friend");
  assert.ok(f.pendingLength() >= 10);
  const forced = f.forceBreak();
  assert.deepEqual(forced, ["Hello there"], `forceBreak splits at the last whitespace (got ${JSON.stringify(forced)})`);
  assert.deepEqual(f.flush(), ["friend"], "the remainder flushes at stream end");

  // nextDeadline is 0 with nothing pending and a timestamp once text arrives.
  const d = chunker();
  assert.equal(d.nextDeadline(), 0, "no deadline with an empty buffer");
  d.push("waiting");
  assert.ok(d.nextDeadline() > Date.now() - 1, "a pending buffer exposes a force-break deadline");
}

function tagAtomicity() {
  // No boundary lands inside a bracketed span.
  const c = chunker({ minChars: 5 });
  const out = [];
  out.push(...c.push("[short pause] Yes. [whispering] It is done now. "));
  out.push(...c.flush());
  assert.ok(out.length >= 2, `tagged sentences must still split (got ${JSON.stringify(out)})`);
  assert.equal(out[0], "[short pause] Yes.", "a leading tag rides with the prose it modifies");
  assert.ok(out.every((chunk) => balancedBrackets(chunk)), `no chunk may split a [tag] (got ${JSON.stringify(out)})`);

  // A tag alone never ships as its own chunk.
  const t = chunker({ minChars: 5 });
  assert.deepEqual(t.push("[sigh]"), [], "a tag-only buffer must hold");
  assert.deepEqual(t.flush(), [], "a tag-only remainder is dropped at flush");

  // Streaming a tag split across deltas keeps it atomic.
  const s = chunker({ minChars: 5 });
  const parts = [];
  parts.push(...s.push("Sure thing. [whis"));
  parts.push(...s.push("pering] quietly now. "));
  parts.push(...s.flush());
  assert.equal(parts[0], "Sure thing.");
  assert.ok(parts.some((chunk) => chunk.includes("[whispering]")), `the split tag must reassemble (got ${JSON.stringify(parts)})`);
}

function emptyAndWhitespaceStreams() {
  const c = chunker();
  assert.deepEqual(c.push(""), []);
  assert.deepEqual(c.push("   \n \t "), []);
  assert.deepEqual(c.flush(), [], "a whitespace-only stream emits nothing");
  assert.equal(c.pendingLength(), 0);

  const n = chunker();
  assert.deepEqual(n.push(null), []);
  assert.deepEqual(n.flush(), []);
}

function sanitizerBasics() {
  const got = [];
  const s = createSpeakStreamSanitizer({ onDelta: (d) => got.push(d) });
  s.push("  Hello   **world**, ");
  s.push("this is `plain`   text.\n\nBye.");
  s.end();
  assert.equal(got.join(""), "Hello world, this is plain text. Bye.", `markdown must strip and whitespace collapse (got ${JSON.stringify(got.join(""))})`);

  // A code fence stops the stream instead of speaking code.
  const fenced = [];
  const f = createSpeakStreamSanitizer({ onDelta: (d) => fenced.push(d) });
  f.push("Look: ```js\nconsole.log(1)\n``` done");
  f.end();
  assert.equal(fenced.join(""), "Look:", `streaming must stop at a code fence (got ${JSON.stringify(fenced.join(""))})`);
}

function sanitizerStyleAndTags() {
  const got = [];
  let style = "";
  const s = createSpeakStreamSanitizer({
    onDelta: (d) => got.push(d),
    onStyle: (v) => { style = v; },
    keepTags: true,
    isAllowedTag: (inner) => inner.trim().toLowerCase() === "whispering",
  });
  // Style line arrives split across deltas and must never be spoken.
  s.push("[sty");
  s.push("le: warm, amused] Hey there ");
  s.push("[whispering] good to see you [bogustag] friend.");
  s.end();
  assert.equal(style, "warm, amused", "the leading style line must be captured");
  assert.equal(got.join(""), "Hey there [whispering] good to see you friend.", `whitelisted tags pass, others drop (got ${JSON.stringify(got.join(""))})`);

  // Without keepTags every bracketed span drops.
  const plain = [];
  const p = createSpeakStreamSanitizer({ onDelta: (d) => plain.push(d) });
  p.push("[style: calm] One [whispering] two.");
  p.end();
  assert.equal(plain.join(""), "One two.", `non-expressive TTS gets clean prose (got ${JSON.stringify(plain.join(""))})`);
}

function sanitizerCapIsPrefix() {
  const full = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
  const capped = [];
  const s = createSpeakStreamSanitizer({ onDelta: (d) => capped.push(d), maxChars: 30 });
  for (const piece of full.match(/.{1,7}/g)) {
    s.push(piece);
  }
  s.end();
  const streamed = capped.join("");
  assert.ok(streamed.length <= 30, `the cap bounds the stream (got ${streamed.length})`);
  assert.ok(full.startsWith(streamed), `streamed text must be a prefix of the full compacted text (got ${JSON.stringify(streamed)})`);
  assert.ok(s.capped(), "the sanitizer reports it hit the cap");
}

function balancedBrackets(text) {
  let depth = 0;
  for (const ch of text) {
    if (ch === "[") depth += 1;
    if (ch === "]") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}
