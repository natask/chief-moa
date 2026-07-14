"use strict";

// Reply-language localization for canned/deterministic voice replies. The
// cascaded pipeline speaks whatever text the gateway returns for a
// profile-control turn, so these strings must render in the reply language —
// Amharic when the reply language is Amharic, English otherwise, and English as
// a safe fallback for any language without a translation table.

const assert = require("node:assert");
const test = require("node:test");
const l10n = require("../lib/voice-l10n");

// Any Ge'ez-script (Ethiopic) code point: a cheap "this is Amharic, not English"
// check for the localized strings.
const GEEZ = /[ሀ-፿]/;
// A run of ASCII letters that is NOT part of an interpolated token (version id,
// proper noun). Used to prove an Amharic string has no stray English words.
function hasAsciiWords(text, allowed = []) {
  const stripped = allowed.reduce((acc, token) => acc.split(token).join(" "), text);
  return /[A-Za-z]{2,}/.test(stripped);
}

test("localeFor maps language codes to translation locales", () => {
  assert.equal(l10n.localeFor("am-ET"), "am");
  assert.equal(l10n.localeFor("am"), "am");
  assert.equal(l10n.localeFor("AM-ET"), "am");
  assert.equal(l10n.localeFor("en-US"), "en");
  assert.equal(l10n.localeFor("es-ES"), "en", "unknown language falls back to en");
  assert.equal(l10n.localeFor(""), "en");
  assert.equal(l10n.localeFor(null), "en");
});

test("isLocalized reports which reply languages have a translation table", () => {
  assert.equal(l10n.isLocalized("am-ET"), true);
  assert.equal(l10n.isLocalized("en-US"), true);
  assert.equal(l10n.isLocalized("es-ES"), false);
});

test("English replies render in English", () => {
  const updated = l10n.t("en-US", "profileUpdated", { summary: "voice Charon", scope: "global", version: "profile_v0005", applies: "next_turn" });
  assert.match(updated, /Updated voice Charon on all devices/);
  assert.match(updated, /profile_v0005/);
  assert.equal(l10n.t("en-US", "rejectGeneric"), "I can't change that setting, so I kept the current one.");
  assert.equal(l10n.t("en-US", "echoTranscript", { transcript: "hello" }), "You said: hello");
});

test("Amharic replies render in Ge'ez script with no stray English words", () => {
  const keys = [
    ["profileUpdated", { scope: "global", version: "profile_v0005", applies: "next_turn" }, ["profile_v0005"]],
    ["profileAlreadyActive", { scope: "device", version: "profile_v0007", applies: "immediate" }, ["profile_v0007"]],
    ["rejectGeneric", {}, []],
    ["missingAccess", { access: "device id" }, ["device", "id"]],
    ["needProfileTarget", {}, []],
    ["needDeviceId", {}, []],
    ["noPreviousTurn", {}, []],
    ["assistantNameSet", { name: "A.G." }, ["A.G."]],
    ["tellMeSetting", {}, []],
  ];
  for (const [key, params, allowed] of keys) {
    const text = l10n.t("am-ET", key, params);
    assert.ok(text, `${key} must produce text`);
    assert.match(text, GEEZ, `${key} must be Amharic (Ge'ez script): ${text}`);
    assert.ok(!hasAsciiWords(text, allowed), `${key} must not leak English words: ${text}`);
  }
});

test("unknown reply language falls back to the English table, never blank", () => {
  const updated = l10n.t("fr-FR", "profileUpdated", { scope: "global", version: "v1", applies: "immediate" });
  assert.equal(updated, l10n.t("en-US", "profileUpdated", { scope: "global", version: "v1", applies: "immediate" }));
  assert.ok(updated.length > 0);
});

test("unknown message key returns empty string (caller keeps its own literal)", () => {
  assert.equal(l10n.t("am-ET", "does_not_exist"), "");
});

// The special case that matters: a language SWITCH is confirmed in the NEW
// language. server.js passes the POST-change reply language to t(), so this
// asserts the primitive that makes "switch to Amharic -> confirmed in Amharic /
// switch to English -> confirmed in English" work.
test("language-switch confirmation renders in the NEW reply language", () => {
  const switchedToAmharic = l10n.t("am-ET", "profileUpdated", { scope: "global", version: "v2", applies: "next_turn" });
  assert.match(switchedToAmharic, GEEZ, "switching TO Amharic must confirm in Amharic");
  assert.ok(!hasAsciiWords(switchedToAmharic, ["v2"]), `Amharic switch confirmation must not contain English: ${switchedToAmharic}`);

  const switchedToEnglish = l10n.t("en-US", "profileUpdated", { summary: "reply in English", scope: "global", version: "v2", applies: "next_turn" });
  assert.doesNotMatch(switchedToEnglish, GEEZ, "switching TO English must confirm in English");
  assert.match(switchedToEnglish, /Updated reply in English/);
});

test("intlLocaleFor picks an in-language Intl locale for the time reply", () => {
  assert.equal(l10n.intlLocaleFor("am-ET"), "am-ET");
  assert.equal(l10n.intlLocaleFor("en-US"), "en-US");
  assert.equal(l10n.intlLocaleFor("es-ES"), "en-US");
  // The Amharic time frame wraps a Ge'ez-rendered date.
  const formatted = new Intl.DateTimeFormat(l10n.intlLocaleFor("am-ET"), { weekday: "long", month: "long", day: "numeric" }).format(new Date(0));
  const reply = l10n.t("am-ET", "timeReply", { formatted });
  assert.match(reply, GEEZ);
});
