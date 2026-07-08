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
  hasOperationalWorkContext,
  isOperationalStatusQuestion,
  shouldRunAgentFromVoice,
  explicitAgentPromptFrom,
  parseProfileControlIntent,
  parseProfileRevertIntent,
  parsePersonaIntent,
  classifyVoiceTurn,
} = require("../lib/voice-intent");
const {
  normalizeLanguageListValue,
  normalizeLanguageList,
  languageControlPatch,
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
assert.ok(!shouldRunAgentFromVoice("what is going on with the operational systems"));
assert.ok(hasOperationalWorkContext("what is going on with the operational systems"));
assert.ok(isOperationalStatusQuestion("what is going on with the operational systems"));
assert.ok(!shouldRunAgentFromVoice("what is going on here on this trading page"));
assert.ok(!shouldRunAgentFromVoice("what is the weather"));
assert.ok(!shouldRunAgentFromVoice("what is going on in this world"));
assert.ok(!hasOperationalWorkContext("what is going on in this world"));
assert.ok(!isOperationalStatusQuestion("what is going on in this world"));
assert.ok(!shouldRunAgentFromVoice("what is going on"));
assert.ok(!shouldRunAgentFromVoice(""));
assert.ok(isOperationalStatusQuestion("what is going on with the operational systems"));
assert.ok(isOperationalStatusQuestion("what active runs are there"));
assert.ok(!isOperationalStatusQuestion("fix the operational systems"));

// explicitAgentPromptFrom: returns the prompt after a run prefix, else "".
assert.strictEqual(explicitAgentPromptFrom("/agent build the panel"), "build the panel");
assert.strictEqual(explicitAgentPromptFrom("moa run the tests"), "the tests");
assert.strictEqual(explicitAgentPromptFrom("just chatting"), "");

// classifyVoiceTurn: the routing table.
assert.strictEqual(classifyVoiceTurn({}, "stop"), "control");
assert.strictEqual(classifyVoiceTurn({}, "run gemini and claude"), "multi_agent");
assert.strictEqual(classifyVoiceTurn({}, "/agent ship it"), "agent_run");
assert.strictEqual(classifyVoiceTurn({}, "fix the bug"), "agent_run");
assert.strictEqual(classifyVoiceTurn({}, "what is going on with the operational systems"), "chat");
assert.strictEqual(classifyVoiceTurn({}, "what is going on in this world"), "chat");
assert.strictEqual(classifyVoiceTurn({}, "what's going on in this world"), "chat");
assert.strictEqual(classifyVoiceTurn({}, "what is going on here, what does closing orders only mean?"), "chat");
assert.strictEqual(classifyVoiceTurn({}, "what is going on?"), "chat");
// Explicit language configuration is profile_control. It writes through the
// gateway profile sanitizer and catalog, not through client-side state.
assert.strictEqual(classifyVoiceTurn({}, "only speak English and Amharic; don't switch up"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "respond only in English"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "speak Amharic and English"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "only process English and Amharic"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "change your language to Amharic"), "profile_control");
assert.strictEqual(classifyVoiceTurn({}, "right now I want to speak Amharic"), "profile_control");
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
// The catalog is now the full Chirp 3 language set, not just English + Amharic.
assert.ok(optionsPayload.languages.length > 2, "language catalog must be broadened beyond two languages");
assert.ok(optionsPayload.languages.some((language) => language.code === "en-US"), "profile options must expose English");
assert.ok(optionsPayload.languages.some((language) => language.code === "am-ET"), "profile options must expose Amharic");
assert.ok(optionsPayload.languages.some((language) => language.code === "es-ES"), "profile options must expose Spanish");
assert.ok(optionsPayload.languages.some((language) => language.code === "ja-JP"), "profile options must expose Japanese");
// Tool-ARGUMENT normalization stays: a language name/code the model passes still
// resolves to a canonical BCP-47 code; a code outside the catalog is dropped.
assert.equal(normalizeLanguageListValue("English and Amharic"), "en-US,am-ET");
assert.equal(normalizeLanguageListValue(["Spanish", "Amharic"]), "es-ES,am-ET");
assert.equal(normalizeLanguageListValue(["Klingon", "Amharic"]), "");
assert.equal(normalizeLanguageListValue("A-M-H-A-R-I-C"), "am-ET");

const replyLanguageIntent = parseProfileControlIntent("speak Amharic and English");
assert.equal(replyLanguageIntent.action, "update");
assert.equal(replyLanguageIntent.subject, "language");
assert.deepStrictEqual(replyLanguageIntent.patch, {
  language: "am-ET,en-US",
  language_primary: "am-ET",
  language_mode: "explicit",
  language_output: "primary_only",
  language_auto_switch: false,
});
assert.match(replyLanguageIntent.summary, /reply in Amharic \+ English/);

const inputLanguageIntent = parseProfileControlIntent("only process English and Amharic");
assert.equal(inputLanguageIntent.action, "update");
assert.deepStrictEqual(inputLanguageIntent.patch, {
  input_languages: "en-US,am-ET",
  input_language_primary: "en-US",
});
assert.match(inputLanguageIntent.summary, /understand English \+ Amharic/);

const directReplyIntent = parseProfileControlIntent("respond in Swahili");
assert.deepStrictEqual(directReplyIntent.patch, {
  language: "sw",
  language_primary: "sw",
  language_mode: "explicit",
  language_output: "primary_only",
  language_auto_switch: false,
});

const inputSpeechIntent = parseProfileControlIntent("I speak Japanese and Korean");
assert.deepStrictEqual(inputSpeechIntent.patch, {
  input_languages: "ja-JP,ko-KR",
  input_language_primary: "ja-JP",
});

// The tool ARGUMENT mapper (languageControlPatch) is the single path both the
// classic update_agent_profile tool and the set_languages code-mode skill use to
// turn a model-chosen language request into profile fields. It maps friendly keys
// to profile fields; the sanitizer then normalizes codes.
const understandPatch = languageControlPatch({ understand: ["English", "Amharic"], lock: true });
assert.equal(normalizeLanguageList(understandPatch.input_languages).codes.join(","), "en-US,am-ET");
const switchPatch = languageControlPatch({ understand_primary: "Amharic" });
assert.deepStrictEqual(switchPatch, { input_language_primary: "Amharic" });
const replyPatch = languageControlPatch({ reply: "English" });
assert.equal(replyPatch.language, "English");
assert.equal(replyPatch.language_mode, "explicit");
assert.equal(replyPatch.language_output, "primary_only");
assert.equal(replyPatch.language_auto_switch, false);

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

const scopedLanguage = parseProfileControlIntent("respond in English on all devices");
assert.equal(scopedLanguage.scope, "global");
assert.deepStrictEqual(scopedLanguage.patch, {
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

// Reversibility by voice. "undo" / "revert" -> previous; "reset your settings"
// / "start over" -> reset. Checked before persona/name matching so a reset
// utterance is an undo, not a persona rename.
for (const phrase of [
  "undo that",
  "undo the last change",
  "revert that",
  "take that back",
  "change it back",
]) {
  const revert = parseProfileControlIntent(phrase);
  assert.equal(revert?.action, "revert", `'${phrase}' must be a revert intent`);
  assert.equal(revert?.mode, "previous", `'${phrase}' must revert to previous`);
  assert.equal(classifyVoiceTurn({}, phrase), "profile_control", `'${phrase}' must route as profile_control`);
}
for (const phrase of [
  "reset your settings",
  "reset your profile",
  "start over with the defaults",
  "restore the default settings",
]) {
  const reset = parseProfileControlIntent(phrase);
  assert.equal(reset?.action, "revert", `'${phrase}' must be a revert intent`);
  assert.equal(reset?.mode, "reset", `'${phrase}' must reset to defaults`);
}
// A reset utterance must NOT be captured as a persona/name change.
assert.equal(parseProfileControlIntent("reset your settings").patch, undefined, "reset must carry no profile patch");
// Ordinary navigation must not be swept into a profile revert.
assert.equal(parseProfileRevertIntent("go back to the previous page"), null, "page navigation is not a profile revert");
assert.equal(parseProfileRevertIntent("what time is it"), null);

// forced/hint fields override the heuristics.
assert.strictEqual(classifyVoiceTurn({ forced_action: "control" }, "anything"), "control");
assert.strictEqual(classifyVoiceTurn({ intent_hint: "agent_run" }, "what time is it"), "agent_run");
assert.strictEqual(classifyVoiceTurn({ client: { intent_hint: "multi_agent" } }, "hello"), "multi_agent");

// null/undefined body must not throw.
assert.strictEqual(classifyVoiceTurn(undefined, "hello there"), "chat");

console.log("smoke-voice-intent: ok");
