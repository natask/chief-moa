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
  parsePersonaIntent,
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
assert.deepStrictEqual(optionsPayload.languages.map((language) => language.code), ["en-US", "am-ET"]);
assert.ok(optionsPayload.languages.some((language) => language.code === "en-US"), "profile options must expose English");
assert.ok(optionsPayload.languages.some((language) => language.code === "am-ET"), "profile options must expose Amharic");
assert.equal(normalizeLanguageListValue("English and Amharic"), "en-US,am-ET");
assert.equal(normalizeLanguageListValue(["Spanish", "Amharic"]), "");
assert.equal(normalizeLanguageListValue("A-M-H-A-R-I-C"), "am-ET");

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

// An unsupported language is rejected with a spoken reason, not silently
// dropped: the current setting stays and the user is told only English and
// Amharic are supported. It must never persist an unsupported language.
for (const utterance of [
  "respond in Swahili",
  "respond in Tigrinya",
  "I speak Japanese and Korean",
]) {
  const rejected = parseProfileControlIntent(utterance);
  assert.ok(rejected && rejected.action === "reject", `expected a language rejection for "${utterance}"`);
  assert.strictEqual(rejected.subject, "language");
  assert.ok(!rejected.patch, "a language rejection must carry no profile patch");
}

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
assert.deepStrictEqual(parseProfileControlIntent("speak A-M-H-A-R-I-C").patch, {
  language: "am-ET",
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

// Persona control: "become X" / "act as X" / "you are now <known persona>".
// A known catalog persona carries a vetted prompt (+ optional voice); a
// free-form persona is stored as a "You are X." prompt. Both route as
// profile_control and set system_prompt.
const pirate = parseProfileControlIntent("become a pirate");
assert.equal(pirate.action, "update", "become a pirate must be an update intent");
assert.equal(pirate.persona, "pirate", "become a pirate must resolve the pirate persona");
assert.equal(pirate.patch.voice, "Fenrir", "pirate persona must carry its voice");
assert.ok(/pirate/i.test(pirate.patch.system_prompt), "pirate persona must set a pirate system prompt");
assert.equal(pirate.confirmation, "Done. I am now your pirate.", "pirate persona must confirm tersely");

const therapist = parseProfileControlIntent("act like a therapist");
assert.equal(therapist.persona, "therapist", "act like a therapist must resolve the therapist persona");

// A KNOWN persona via "you are now X" wins over the name matcher.
const butler = parseProfileControlIntent("you are now a butler");
assert.equal(butler.persona, "butler", "'you are now a butler' must switch persona, not rename");
assert.equal(butler.patch.assistant_name, undefined, "known persona must not be treated as a name");

// A free-form persona is stored as a custom prompt.
const chef = parseProfileControlIntent("pretend to be a grumpy chef who hates onions");
assert.equal(chef.persona, "custom", "free-form persona must be marked custom");
assert.ok(/grumpy chef who hates onions/i.test(chef.patch.system_prompt), "custom persona prompt must carry the description");

// "you are now Moa" still renames (free-form persona must not swallow names).
const rename = parseProfileControlIntent("you are now Moa");
assert.equal(rename.patch.assistant_name, "Moa", "'you are now Moa' must set the assistant name");
assert.ok(!rename.persona, "'you are now Moa' must not be a persona");

// A voice-only utterance must not be captured as a persona.
assert.deepStrictEqual(parseProfileControlIntent("use the Charon voice").patch, { voice: "Charon" });

// Exact-transcript echo-back: "what did you hear" / "what did I say" / "repeat
// what I said" route as an echo_transcript control action.
for (const phrase of [
  "what did you hear",
  "what did I say",
  "repeat what I said exactly",
  "read that back",
  "what were my exact words",
]) {
  const echo = parseProfileControlIntent(phrase);
  assert.equal(echo?.action, "echo_transcript", `'${phrase}' must be an echo_transcript intent`);
  assert.equal(classifyVoiceTurn({}, phrase), "profile_control", `'${phrase}' must route as profile_control`);
}
// A plain question must not be an echo.
assert.notEqual(parseProfileControlIntent("what time is it")?.action, "echo_transcript");

// parsePersonaIntent knownOnly gate: a free-form subject is skipped when knownOnly.
assert.equal(parsePersonaIntent("become a wizard", { knownOnly: true }), null, "knownOnly must skip unknown personas");
assert.ok(parsePersonaIntent("become a wizard"), "free-form persona must resolve without knownOnly");

// forced/hint fields override the heuristics.
assert.strictEqual(classifyVoiceTurn({ forced_action: "control" }, "anything"), "control");
assert.strictEqual(classifyVoiceTurn({ intent_hint: "agent_run" }, "what time is it"), "agent_run");
assert.strictEqual(classifyVoiceTurn({ client: { intent_hint: "multi_agent" } }, "hello"), "multi_agent");

// null/undefined body must not throw.
assert.strictEqual(classifyVoiceTurn(undefined, "hello there"), "chat");

console.log("smoke-voice-intent: ok");
