"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { matchMemoryStatement } = require("../lib/memory-matcher");

test("identity patterns normalize names and trailing conversation", () => {
  const cases = [
    ["call me Bob", "The user wants to be called Bob."],
    ["you can call me Alice!", "The user wants to be called Alice."],
    ["call me Jean   Luc and use French", "The user wants to be called Jean Luc."],
    ["call me Ana, please", "The user wants to be called Ana."],
    ["my name is Chidi", "The user's name is Chidi."],
    ["my name's Zoë.", "The user's name is Zoë."],
    ["my name is Sam but keep it private", "The user's name is Sam."],
    ["I'm Dana", "The user's name is Dana."],
    ["I am René", "The user's name is René."],
  ];
  for (const [input, fact] of cases) assert.deepEqual(matchMemoryStatement(input), { kind: "identity", fact });
});

test("I-am matching rejects feelings, states, and lowercase non-names", () => {
  for (const word of [
    "tired", "happy", "sad", "busy", "done", "ready", "good", "fine", "ok", "okay",
    "here", "sure", "back", "sorry", "confused", "lost", "hungry", "late", "early",
  ]) assert.equal(matchMemoryStatement(`I am ${word}`), null);
  assert.equal(matchMemoryStatement("I am engineer"), null);
  assert.equal(matchMemoryStatement("call me and"), null);
  assert.deepEqual(matchMemoryStatement("I am Bob and ready"), {
    kind: "identity", fact: "The user's name is Bob.",
  });
});

test("every persona pattern preserves lightly normalized user phrasing", () => {
  const inputs = [
    "talk to me like a baller",
    "speak to me like a professor!",
    "talk like a pirate.",
    "be more concise",
    "be less formal?",
    "sound more reassuring!!!",
    "please talk to me like an old friend.",
  ];
  for (const input of inputs) {
    const result = matchMemoryStatement(input);
    assert.equal(result.kind, "persona");
    assert.match(result.fact, /^Persona preference: the user wants the assistant to /);
    assert.equal(/[?!]{1,}\.$/.test(result.fact), false);
  }
});

test("want and preference aliases become bounded canonical preferences", () => {
  const cases = [
    ["I want you to use short answers.", "The user wants the assistant to use short answers."],
    ["I'd like you to explain tradeoffs!", "The user wants the assistant to explain tradeoffs."],
    ["I would like you to ask first?", "The user wants the assistant to ask first."],
    ["I prefer dark mode.", "The user prefers dark mode."],
    ["I like concise summaries!", "The user prefers concise summaries."],
    ["I would prefer fewer headings?", "The user prefers fewer headings."],
    ["I'd prefer   direct   language.", "The user prefers direct language."],
  ];
  for (const [input, fact] of cases) assert.deepEqual(matchMemoryStatement(input), { kind: "preference", fact });
  assert.equal(matchMemoryStatement("I want you to ..."), null);
  assert.equal(matchMemoryStatement("I prefer ..."), null);
  const long = matchMemoryStatement(`I prefer ${"x".repeat(300)}`);
  assert.equal(long.fact, `The user prefers ${"x".repeat(240)}.`);
});

test("remember requests capitalize facts and preserve existing punctuation", () => {
  assert.deepEqual(matchMemoryStatement("remember that my passport expires in June"), {
    kind: "note", fact: "My passport expires in June.",
  });
  assert.deepEqual(matchMemoryStatement("please remember the backup is complete!"), {
    kind: "note", fact: "The backup is complete.",
  });
  assert.deepEqual(matchMemoryStatement("remember that This already ends?"), {
    kind: "note", fact: "This already ends.",
  });
  assert.equal(matchMemoryStatement("remember that ..."), null);
});

test("blank, non-string, and ordinary operational turns do not create memory", () => {
  for (const value of [null, undefined, "", "   ", 0, false, {}, []]) assert.equal(matchMemoryStatement(value), null);
  for (const input of ["open settings", "what time is it", "I am working on a task today", "please continue"]) {
    assert.equal(matchMemoryStatement(input), null);
  }
});
