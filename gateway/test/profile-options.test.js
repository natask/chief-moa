"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const options = require("../lib/profile-options");

test("normalizes voice and persona aliases without mutating catalogs", () => {
  assert.equal(options.normalizeSpeechKey("  Français—VOICE!! "), "francais voice");
  assert.equal(options.normalizeSpeechKey(null), "");
  assert.equal(options.canonicalVoice(null), null);
  assert.equal(options.canonicalVoice(""), null);
  assert.equal(options.canonicalVoice("kore"), "Kore");
  assert.equal(options.canonicalVoice(" Female Voice "), "Aoede");
  assert.equal(options.normalizeVoiceChoice("GUY"), "Charon");
  assert.equal(options.canonicalVoice("unknown"), null);
  assert.equal(options.canonicalPersona(null), null);
  assert.equal(options.canonicalPersona(""), null);
  assert.equal(options.canonicalPersona("A BUTLER")?.id, "butler");
  assert.equal(options.canonicalPersona("unknown"), null);
  const personas = options.personaOptionsPayload();
  assert.equal(personas.length, options.PERSONA_OPTIONS.length);
  personas[0].aliases.push("changed");
  assert.equal(options.PERSONA_OPTIONS[0].keys.includes("changed"), false);
  const voices = options.voiceOptionsPayload();
  assert.deepEqual(voices.map((voice) => voice.id), options.CORE_VOICES);
  voices[0].tone_tags.push("changed");
  assert.equal(options.VOICE_OPTIONS[0].tone_tags.includes("changed"), false);
});

test("normalizes codes, names, native script, embedded codes, and lists", () => {
  assert.equal(options.normalizeLanguageCode(null), "");
  assert.equal(options.normalizeLanguageCode(""), "");
  assert.equal(options.normalizeLanguageCode("EN-us"), "en-US");
  assert.equal(options.normalizeLanguageCode("Amharic"), "am-ET");
  assert.equal(options.normalizeLanguageCode("አማርኛ"), "am-ET");
  assert.equal(options.normalizeLanguageCode("please use fr-CA now"), "fr-CA");
  assert.equal(options.normalizeLanguageCode("please use xx-ZZ now"), "");
  assert.equal(options.normalizeLanguageCode("unsupported"), "");

  assert.deepEqual(options.normalizeLanguageList(null), { codes: [], invalid: [] });
  assert.deepEqual(options.normalizeLanguageList(["English", null, "am-ET", "English", "bad"]), {
    codes: ["en-US", "am-ET"], invalid: ["bad"],
  });
  assert.deepEqual(options.normalizeLanguageList("English and Amharic; fr-FR|bad"), {
    codes: ["en-US", "am-ET", "fr-FR"], invalid: ["bad"],
  });
  assert.equal(options.normalizeLanguageListValue("English,Amharic"), "en-US,am-ET");
  assert.equal(options.normalizeLanguageListValue("English,bad"), "");
  assert.equal(options.normalizeLanguageListValue("bad"), "");
  const payload = options.languageOptionsPayload();
  assert.equal(payload.length, options.LANGUAGE_OPTIONS.length);
  payload[0].aliases.push("changed");
  assert.equal(options.LANGUAGE_OPTIONS[0].keys.includes("changed"), false);
});

test("detects supported language mentions with token boundaries", () => {
  assert.equal(options.mentionsSupportedLanguage(null), false);
  assert.equal(options.mentionsSupportedLanguage("   "), false);
  assert.equal(options.mentionsSupportedLanguage("Switch to en-US, please"), true);
  assert.equal(options.mentionsSupportedLanguage("Speak British English"), true);
  assert.equal(options.mentionsSupportedLanguage("አማርኛ ተናገር"), true);
  assert.equal(options.mentionsSupportedLanguage("Use français"), true);
  assert.equal(options.mentionsSupportedLanguage("This is a catalog, not Lao"), true);
  assert.equal(options.mentionsSupportedLanguage("This is a catalogue"), false);
  assert.equal(options.mentionsSupportedLanguage("xx-ZZ only"), false);
  assert.match(options.supportedLanguagesSentence(), /^\d+ languages including/);
  assert.equal(options.SUPPORTED_LANGUAGE_LABELS.length, options.LANGUAGE_OPTIONS.length);
});

test("reports only invalid requested language fields", () => {
  assert.deepEqual(options.rejectedLanguageFields(null), []);
  assert.deepEqual(options.rejectedLanguageFields("bad"), []);
  assert.deepEqual(options.rejectedLanguageFields({ language: "", input_languages: 3 }), []);
  assert.deepEqual(options.rejectedLanguageFields({
    language: "English,bad",
    input_languages: "bad",
    language_output: "primary_only",
    language_primary: "xx-ZZ",
    input_language_primary: "am-ET",
  }), ["language", "input_languages", "language_primary"]);
  assert.deepEqual(options.rejectedLanguageFields({ language_output: "bad" }), ["language_output"]);
  for (const mode of ["same_as_input", "primary_only", "configured_value"]) {
    assert.deepEqual(options.rejectedLanguageFields({ language_output: mode }), []);
  }
});

test("deduplicates model options and builds independent profile payloads", () => {
  assert.deepEqual(options.modelOptionsPayload(), []);
  assert.deepEqual(options.modelOptionsPayload({ models: "bad" }), []);
  assert.deepEqual(options.modelOptionsPayload({ models: [
    " model-a ", "", null, 3,
    { model: "model-b", provider: "provider", current: true },
    { id: "model-b", label: "duplicate" },
    { id: "", label: "bad" },
  ] }), [
    { id: "model-a", label: "model-a" },
    { id: "model-b", label: "model-b", provider: "provider", current: true },
  ]);
  const empty = options.profileOptionsPayload();
  assert.equal(empty.fields.model.type, "text");
  const populated = options.profileOptionsPayload({ models: [{ id: "model-a", label: "A" }] });
  assert.equal(populated.fields.model.type, "enum_or_text");
  assert.deepEqual(populated.fields.model.values, ["model-a"]);
  populated.fields.voice.values.push("changed");
  assert.equal(options.CORE_VOICES.includes("changed"), false);
});

test("maps every language-control alias and switching policy", () => {
  assert.deepEqual(options.languageControlPatch(null), {});
  assert.deepEqual(options.languageControlPatch([]), {});
  assert.deepEqual(options.languageControlPatch({
    understand: ["English", null, "Amharic"],
    understand_primary: ["am-ET", "en-US"],
    reply: ["en-US", "am-ET"],
    reply_primary: "am-ET,en-US",
    lock: true,
  }), {
    input_languages: "English,Amharic",
    input_language_primary: "am-ET",
    language: "en-US,am-ET",
    language_mode: "explicit",
    language_output: "primary_only",
    language_primary: "am-ET",
    language_auto_switch: false,
  });
  assert.deepEqual(options.languageControlPatch({
    heard_languages: "English",
    speaking_now: "en-US",
    output_languages: "French",
    primary_reply: "fr-FR",
    auto_switch: true,
  }).language_auto_switch, true);
  assert.equal(options.languageControlPatch({ language: "English" }).language_auto_switch, false);
  assert.deepEqual(options.languageControlPatch({ understand_languages: 4, reply_languages: null }), {});
  assert.equal(options.languageControlPatch({ input_languages: "English", input_language_primary: "en-US" }).input_language_primary, "en-US");
  assert.equal(options.languageControlPatch({ heard: "English", primary_input: "en-US", speak: "French", language_primary: "fr-FR" }).language, "French");
});
