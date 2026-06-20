#!/usr/bin/env node
"use strict";

// Unit smoke for the voice-intent classifier (lib/voice-intent.js). Pure
// functions, no server, no network. Asserts the classification table that
// routing depends on so a future edit to the keyword lists can't silently
// reroute turns.

const assert = require("node:assert");
const {
  normalizeSpeech,
  isStopLike,
  wantsMultipleAgents,
  shouldRunAgentFromVoice,
  explicitAgentPromptFrom,
  parseProfileControlIntent,
  classifyVoiceTurn,
} = require("../lib/voice-intent");

// normalizeSpeech: lowercase, strip punctuation, collapse whitespace.
assert.strictEqual(normalizeSpeech("  Stop, please! "), "stop please");
assert.strictEqual(normalizeSpeech(null), "");

// isStopLike: exact control phrases only, punctuation-insensitive.
for (const t of ["stop", "Stop.", "shut up", "never mind", "nevermind", "cancel"]) {
  assert.ok(isStopLike(t), `expected stop-like: ${t}`);
}
for (const t of ["stop the build", "cancel my order tomorrow", ""]) {
  assert.ok(!isStopLike(t), `expected NOT stop-like: ${t}`);
}

// wantsMultipleAgents: explicit multi-agent phrasings.
assert.ok(wantsMultipleAgents("run gemini and claude on this"));
assert.ok(wantsMultipleAgents("use multiple agents"));
assert.ok(!wantsMultipleAgents("ask claude"));

// shouldRunAgentFromVoice: action-shaped utterances.
assert.ok(shouldRunAgentFromVoice("fix the login bug"));
assert.ok(shouldRunAgentFromVoice("make progress on the overlay"));
assert.ok(shouldRunAgentFromVoice("push code to the home machine"));
assert.ok(shouldRunAgentFromVoice("what are all the projects I have ongoing"));
assert.ok(shouldRunAgentFromVoice("look at the Chrome extension Android app and mobile gateway"));
assert.ok(!shouldRunAgentFromVoice("what is the weather"));
assert.ok(!shouldRunAgentFromVoice(""));

// explicitAgentPromptFrom: returns the prompt after a run prefix, else "".
assert.strictEqual(explicitAgentPromptFrom("/agent build the panel"), "build the panel");
assert.strictEqual(explicitAgentPromptFrom("moa run the tests"), "the tests");
assert.strictEqual(explicitAgentPromptFrom("just chatting"), "");

// classifyVoiceTurn: the routing table.
assert.strictEqual(classifyVoiceTurn({}, "stop"), "control");
assert.strictEqual(classifyVoiceTurn({}, "run gemini and claude"), "multi_agent");
assert.strictEqual(classifyVoiceTurn({}, "/agent ship it"), "agent_run");
assert.strictEqual(classifyVoiceTurn({}, "fix the bug"), "agent_run");
assert.strictEqual(classifyVoiceTurn({}, "what is going on with the operational systems"), "agent_run");
assert.strictEqual(classifyVoiceTurn({}, "only speak English and Amharic; don't switch up"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "what time is it"), "chat");

const inputLanguageLock = parseProfileControlIntent("I'm only going to speak to you in English and Amharic, don't switch up");
assert.deepStrictEqual(inputLanguageLock.patch, {
  input_languages: "en-US,am-ET",
  input_language_primary: "en-US",
});
const outputLanguageLock = parseProfileControlIntent("you only speak English and Amharic, don't switch up");
assert.deepStrictEqual(outputLanguageLock.patch, {
  language: "en-US,am-ET",
  language_primary: "en-US",
  language_mode: "explicit",
  language_output: "primary_only",
  language_auto_switch: false,
});

// One utterance sets both sides: the user's input language and the agent's reply.
const bothSides = parseProfileControlIntent("I only speak Amharic and you only speak English");
assert.deepStrictEqual(bothSides.patch, {
  language: "en-US",
  language_primary: "en-US",
  language_mode: "explicit",
  language_output: "primary_only",
  language_auto_switch: false,
  input_languages: "am-ET",
  input_language_primary: "am-ET",
});

// Arbitrary languages beyond the original six resolve to their BCP-47 codes.
assert.deepStrictEqual(parseProfileControlIntent("respond in Swahili").patch, {
  language: "sw-KE",
  language_primary: "sw-KE",
  language_mode: "explicit",
  language_output: "primary_only",
  language_auto_switch: false,
});
assert.deepStrictEqual(parseProfileControlIntent("I speak Japanese and Korean").patch, {
  input_languages: "ja-JP,ko-KR",
  input_language_primary: "ja-JP",
});

// forced/hint fields override the heuristics.
assert.strictEqual(classifyVoiceTurn({ forced_action: "control" }, "anything"), "control");
assert.strictEqual(classifyVoiceTurn({ intent_hint: "agent_run" }, "what time is it"), "agent_run");
assert.strictEqual(classifyVoiceTurn({ client: { intent_hint: "multi_agent" } }, "hello"), "multi_agent");

// null/undefined body must not throw.
assert.strictEqual(classifyVoiceTurn(undefined, "hello there"), "chat");

console.log("smoke-voice-intent: ok");
