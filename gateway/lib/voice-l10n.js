"use strict";

// Reply-language localization for the gateway's canned / deterministic voice
// replies: profile-control confirmations, "already active", rejects,
// missing-access, transcript echoes, the local time reply, and persona / name
// confirmations. The cascaded voice pipeline SPEAKS whatever text the gateway
// returns for these turns (the reasoning model never runs on a profile-control
// turn), so any English string here leaks straight into a non-English reply.
// Each message is rendered in the effective reply language.
//
// Only languages with a hand-written translation table are localized (today:
// Amharic "am"). Every other language falls back to English so a message is
// never blank. Amharic strings are short, natural, and Ge'ez-script so they are
// TTS-safe on the cascaded pipeline.
//
// SPECIAL CASE that matters: a language SWITCH must be confirmed in the NEW
// language. Callers pass the POST-change reply language (e.g. after switching to
// Amharic they pass "am-ET"), so the confirmation is spoken in Amharic. English
// proper nouns that appear as parameters (an assistant name, a persona label, a
// list of supported language names) are passed through unchanged.

// Map a reply-language code ("am-ET", "en-US", …) to a translation locale.
function localeFor(language) {
  const code = String(language || "").trim().toLowerCase();
  if (!code) {
    return "en";
  }
  if (code === "am" || code.startsWith("am-") || code.startsWith("am_")) {
    return "am";
  }
  return "en";
}

// True when the reply language has a DEDICATED translation table (Amharic, or an
// English variant) rather than silently falling back to English. Unknown
// languages (which map to the "en" fallback table) return false.
function isLocalized(language) {
  const code = String(language || "").trim().toLowerCase();
  if (!code) {
    return false;
  }
  if (localeFor(code) === "am") {
    return true;
  }
  return code === "en" || code.startsWith("en-") || code.startsWith("en_");
}

const SCOPE_TEXT = {
  en: { device: "on this device", global: "on all devices" },
  am: { device: "በዚህ መሣሪያ ላይ", global: "በሁሉም መሣሪያዎች ላይ" },
};

const APPLIES_TEXT = {
  en: { immediate: "immediately", next_turn: "next turn" },
  am: { immediate: "ወዲያውኑ ተግባራዊ ይሆናል", next_turn: "በሚቀጥለው ንግግር ተግባራዊ ይሆናል" },
};

function scopeText(locale, scope) {
  const table = SCOPE_TEXT[locale] || SCOPE_TEXT.en;
  return scope === "device" ? table.device : table.global;
}

function appliesText(locale, applies) {
  const table = APPLIES_TEXT[locale] || APPLIES_TEXT.en;
  return applies === "immediate" ? table.immediate : table.next_turn;
}

const MESSAGES = {
  en: {
    // `summary` (e.g. "voice Charon", "reply in Amharic") names WHAT changed;
    // English keeps it, Amharic omits it because the summary itself is English.
    profileUpdated: ({ summary, scope, version, applies }) =>
      `Updated ${summary || "profile"} ${scopeText("en", scope)}. Profile version is ${version}; applies ${appliesText("en", applies)}.`,
    profileAlreadyActive: ({ scope, version }) =>
      `That profile setting is already active ${scopeText("en", scope)}. Profile version is still ${version}.`,
    companionApplied: ({ name, scope, version, applies }) =>
      `Created and switched to ${name} ${scopeText("en", scope)}. Profile version is ${version}; applies ${appliesText("en", applies)}.`,
    rejectLanguage: ({ languages }) =>
      `I only speak ${languages} for now, so I kept the current language.`,
    rejectGeneric: () =>
      "I can't change that setting, so I kept the current one.",
    missingAccess: ({ access }) =>
      `Hey, I would like to do that, but I need you to give me access to ${access}.`,
    needProfileTarget: () =>
      "Hey, I would like to do that, but I need you to say which voice, input language, or reply language to change.",
    needDeviceId: () =>
      "Hey, I would like to do that, but I need you to give me access to this device's Moa device id.",
    echoTranscript: ({ transcript }) => `You said: ${transcript}`,
    noPreviousTurn: () => "I don't have a previous turn to repeat yet.",
    timeReply: ({ formatted }) => `It's ${formatted}.`,
    assistantNameSet: ({ name }) => `Yes. I am now ${name}.`,
    personaKnownSet: ({ label }) => `Done. I am now your ${label}.`,
    personaCustomSet: ({ label }) => `Done. I am now ${label}.`,
    profileSummaryLead: ({ version, scope }) => `Profile ${version} ${scopeText("en", scope)}.`,
    voiceClarifyLead: ({ scope }) => `I can change my voice ${scopeText("en", scope)}.`,
    tellMeSetting: () => "Tell me which profile setting to change.",
  },
  am: {
    profileUpdated: ({ scope, version, applies }) =>
      `${scopeText("am", scope)} ተስተካክሏል። የመገለጫ ስሪት ${version} ነው፤ ${appliesText("am", applies)}።`,
    profileAlreadyActive: ({ scope, version }) =>
      `ይህ ቅንብር ${scopeText("am", scope)} አስቀድሞ ተግባራዊ ነው። የመገለጫ ስሪት አሁንም ${version} ነው።`,
    companionApplied: ({ name, scope, version, applies }) =>
      `${name} ተፈጥሮ ${scopeText("am", scope)} ተቀይሯል። የመገለጫ ስሪት ${version} ነው፤ ${appliesText("am", applies)}።`,
    rejectLanguage: ({ languages }) =>
      `ለአሁኑ ${languages} ብቻ ነው የምናገረው፣ ስለዚህ አሁን ያለውን ቋንቋ አቆይቻለሁ።`,
    rejectGeneric: () =>
      "ያንን ቅንብር መቀየር አልችልም፣ ስለዚህ አሁን ያለውን አቆይቻለሁ።",
    missingAccess: ({ access }) =>
      `ይህን ማድረግ እፈልጋለሁ፣ ግን ${access} እንዲሰጡኝ ያስፈልጋል።`,
    needProfileTarget: () =>
      "ይህን ማድረግ እፈልጋለሁ፣ ግን የትኛውን — ድምፅ፣ የግቤት ቋንቋ ወይም የመልስ ቋንቋ — እንድቀይር ይንገሩኝ።",
    needDeviceId: () =>
      "ይህን ማድረግ እፈልጋለሁ፣ ግን የዚህን መሣሪያ የሞአ መለያ እንዲሰጡኝ ያስፈልጋል።",
    echoTranscript: ({ transcript }) => `ያሉት፦ ${transcript}`,
    noPreviousTurn: () => "እስካሁን የምደግመው ቀዳሚ ንግግር የለም።",
    timeReply: ({ formatted }) => `ሰዓቱ ${formatted} ነው።`,
    assistantNameSet: ({ name }) => `እሺ። ከአሁን ጀምሮ ${name} ነኝ።`,
    personaKnownSet: ({ label }) => `ተከናውኗል። ከአሁን ጀምሮ የእርስዎ ${label} ነኝ።`,
    personaCustomSet: ({ label }) => `ተከናውኗል። ከአሁን ጀምሮ ${label} ነኝ።`,
    profileSummaryLead: ({ version, scope }) => `መገለጫ ${version} ${scopeText("am", scope)}።`,
    voiceClarifyLead: ({ scope }) => `ድምፄን ${scopeText("am", scope)} መቀየር እችላለሁ።`,
    tellMeSetting: () => "የትኛውን የመገለጫ ቅንብር እንድቀይር ይንገሩኝ።",
  },
};

// Render a canned reply `key` in the effective reply `language`. Unknown keys
// return "" (the caller then keeps its own literal); unknown languages fall back
// to the English table so nothing is left blank.
function t(language, key, params = {}) {
  const locale = localeFor(language);
  const table = MESSAGES[locale] || MESSAGES.en;
  const fn = table[key] || MESSAGES.en[key];
  return fn ? fn(params) : "";
}

// Intl locale for a reply language, so Intl.DateTimeFormat / NumberFormat render
// in-language (Amharic month/weekday names for the time reply) instead of
// hardcoded en-US.
function intlLocaleFor(language) {
  return localeFor(language) === "am" ? "am-ET" : "en-US";
}

module.exports = {
  localeFor,
  intlLocaleFor,
  isLocalized,
  t,
};
