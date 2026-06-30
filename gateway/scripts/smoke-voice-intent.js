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
const {
  normalizeLanguageListValue,
  profileOptionsPayload,
} = require("../lib/profile-options");

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
assert.strictEqual(classifyVoiceTurn({}, "respond only in English"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "speak Amharic and English"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "only process English and Amharic"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "change your language to Amharic"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "your name is Moa"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "you are Aggie"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "call yourself The Steward"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "I want you to be a research scout"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "act as my calm writing coach"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "what voice are you using"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "what language settings are active"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "what languages can you speak"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "what voices can you use"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "use the Kore voice on this device"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "change your voice"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "go through all the voices and say something in every voice"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "sample the voices for me one after the other"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "change my voice"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "what time is it"), "chat");

const optionsPayload = profileOptionsPayload();
assert.ok(optionsPayload.voices.some((voice) => voice.id === "Aoede"), "profile options must expose Aoede");
assert.ok(optionsPayload.voices.some((voice) => voice.id === "Charon"), "profile options must expose Charon");
assert.ok(optionsPayload.languages.some((language) => language.code === "am-ET"), "profile options must expose Amharic");
assert.ok(optionsPayload.languages.some((language) => language.code === "ti-ET"), "profile options must expose Tigrinya");
assert.equal(normalizeLanguageListValue("English and Amharic"), "en-US,am-ET");
assert.equal(normalizeLanguageListValue(["Tigrinya", "Amharic"]), "ti-ET,am-ET");

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
assert.deepStrictEqual(parseProfileControlIntent("respond in Tigrinya and Amharic").patch, {
  language: "ti-ET,am-ET",
  language_primary: "ti-ET",
  language_mode: "explicit",
  language_output: "primary_only",
  language_auto_switch: false,
});
assert.deepStrictEqual(parseProfileControlIntent("I speak Japanese and Korean").patch, {
  input_languages: "ja-JP,ko-KR",
  input_language_primary: "ja-JP",
});

assert.deepStrictEqual(parseProfileControlIntent("only process English and Amharic").patch, {
  input_languages: "en-US,am-ET",
  input_language_primary: "en-US",
});

assert.deepStrictEqual(parseProfileControlIntent("speak Amharic and English").patch, {
  language: "am-ET,en-US",
  language_primary: "am-ET",
  language_mode: "explicit",
  language_output: "primary_only",
  language_auto_switch: false,
});

assert.deepStrictEqual(parseProfileControlIntent("what voice are you using"), {
  action: "summary",
  subject: "voice",
  scope: "global",
});
assert.deepStrictEqual(parseProfileControlIntent("what languages can you speak"), {
  action: "summary",
  subject: "language_options",
  scope: "global",
});
assert.deepStrictEqual(parseProfileControlIntent("what voices can you use"), {
  action: "summary",
  subject: "voice_options",
  scope: "global",
});
assert.deepStrictEqual(parseProfileControlIntent("go through all the voices and say something in every voice"), {
  action: "sample",
  subject: "voice_options",
  summary: "voice sampler",
  sample_text: "",
  scope: "global",
});
assert.deepStrictEqual(parseProfileControlIntent("say hello there in every voice"), {
  action: "sample",
  subject: "voice_options",
  summary: "voice sampler",
  sample_text: "hello there",
  scope: "global",
});

const deviceScopedVoice = parseProfileControlIntent("use the Kore voice on this device");
assert.equal(deviceScopedVoice.scope, "device");
assert.deepStrictEqual(deviceScopedVoice.patch, { voice: "Kore" });
assert.deepStrictEqual(parseProfileControlIntent("use a feminine voice").patch, { voice: "Aoede" });

const companionIntent = parseProfileControlIntent("I want you to be a research scout");
assert.equal(companionIntent.action, "companion_create_apply");
assert.equal(companionIntent.subject, "companion");
assert.equal(companionIntent.companion_role, "research scout");
assert.deepStrictEqual(parseProfileControlIntent("use a masculine voice").patch, { voice: "Charon" });
assert.deepStrictEqual(parseProfileControlIntent("change your voice"), {
  action: "clarify",
  subject: "voice",
  summary: "voice",
  scope: "global",
});
assert.deepStrictEqual(parseProfileControlIntent("change voices"), {
  action: "clarify",
  subject: "voice",
  summary: "voice",
  scope: "global",
});

const globalScopedLanguage = parseProfileControlIntent("respond in English on all devices");
assert.equal(globalScopedLanguage.scope, "global");
assert.deepStrictEqual(globalScopedLanguage.patch, {
  language: "en-US",
  language_primary: "en-US",
  language_mode: "explicit",
  language_output: "primary_only",
  language_auto_switch: false,
});

assert.deepStrictEqual(parseProfileControlIntent("your name is Moa").patch, {
  assistant_name: "Moa",
});
assert.strictEqual(parseProfileControlIntent("your name is Moa").confirmation, "Yes. I am now Moa.");
assert.deepStrictEqual(parseProfileControlIntent("you are Aggie").patch, {
  assistant_name: "Aggie",
});
assert.deepStrictEqual(parseProfileControlIntent("call yourself The Steward").patch, {
  assistant_name: "The Steward",
});
assert.deepStrictEqual(parseProfileControlIntent("your name is Captain").patch, {
  assistant_name: "Captain",
});
assert.deepStrictEqual(parseProfileControlIntent("what is your name"), {
  action: "summary",
  subject: "assistant_name",
  scope: "global",
});

// forced/hint fields override the heuristics.
assert.strictEqual(classifyVoiceTurn({ forced_action: "control" }, "anything"), "control");
assert.strictEqual(classifyVoiceTurn({ intent_hint: "agent_run" }, "what time is it"), "agent_run");
assert.strictEqual(classifyVoiceTurn({ client: { intent_hint: "multi_agent" } }, "hello"), "multi_agent");

// null/undefined body must not throw.
assert.strictEqual(classifyVoiceTurn(undefined, "hello there"), "chat");

console.log("smoke-voice-intent: ok");
