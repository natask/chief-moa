"use strict";

function normalizeSpeechKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const VOICE_OPTIONS = Object.freeze([
  {
    id: "Puck",
    label: "Puck",
    tone_tags: ["bright", "energetic", "androgynous"],
    presentation: "androgynous",
    description: "Bright, quick, and upbeat.",
  },
  {
    id: "Charon",
    label: "Charon",
    tone_tags: ["masculine", "steady", "deep"],
    presentation: "masculine",
    description: "Lower, steady, and direct.",
  },
  {
    id: "Kore",
    label: "Kore",
    tone_tags: ["feminine", "clear", "measured"],
    presentation: "feminine",
    description: "Clear, measured, and composed.",
  },
  {
    id: "Fenrir",
    label: "Fenrir",
    tone_tags: ["masculine", "firm", "low"],
    presentation: "masculine",
    description: "Firm, low, and grounded.",
  },
  {
    id: "Aoede",
    label: "Aoede",
    tone_tags: ["feminine", "warm", "smooth"],
    presentation: "feminine",
    description: "Warm, smooth, and expressive.",
  },
  {
    id: "Leda",
    label: "Leda",
    tone_tags: ["feminine", "light", "calm"],
    presentation: "feminine",
    description: "Light, calm, and soft.",
  },
  {
    id: "Orus",
    label: "Orus",
    tone_tags: ["masculine", "clear", "formal"],
    presentation: "masculine",
    description: "Clear, formal, and controlled.",
  },
  {
    id: "Zephyr",
    label: "Zephyr",
    tone_tags: ["feminine", "airy", "gentle"],
    presentation: "feminine",
    description: "Airy, gentle, and relaxed.",
  },
].map(Object.freeze));

const CORE_VOICES = Object.freeze(VOICE_OPTIONS.map((voice) => voice.id));
const VOICES_BY_LOWER = new Map(VOICE_OPTIONS.map((voice) => [voice.id.toLowerCase(), voice.id]));
const VOICE_ALIAS_TO_ID = Object.freeze({
  female: "Aoede",
  feminine: "Aoede",
  woman: "Aoede",
  "woman voice": "Aoede",
  "female voice": "Aoede",
  lady: "Aoede",
  male: "Charon",
  masculine: "Charon",
  man: "Charon",
  "man voice": "Charon",
  "male voice": "Charon",
  guy: "Charon",
});
const VOICE_ALIASES_BY_KEY = new Map(Object.entries(VOICE_ALIAS_TO_ID).map(([alias, id]) => [normalizeSpeechKey(alias), id]));

const LANGUAGE_OPTIONS = Object.freeze([
  { label: "English", code: "en-US", keys: ["english"] },
  { label: "Spanish", code: "es-ES", keys: ["spanish", "espanol", "castellano"] },
  { label: "French", code: "fr-FR", keys: ["french", "francais"] },
  { label: "German", code: "de-DE", keys: ["german", "deutsch"] },
  { label: "Italian", code: "it-IT", keys: ["italian", "italiano"] },
  { label: "Portuguese", code: "pt-BR", keys: ["portuguese", "portugues"] },
  { label: "Dutch", code: "nl-NL", keys: ["dutch", "nederlands"] },
  { label: "Russian", code: "ru-RU", keys: ["russian"] },
  { label: "Polish", code: "pl-PL", keys: ["polish"] },
  { label: "Ukrainian", code: "uk-UA", keys: ["ukrainian"] },
  { label: "Turkish", code: "tr-TR", keys: ["turkish"] },
  { label: "Arabic", code: "ar-XA", keys: ["arabic"] },
  { label: "Hebrew", code: "he-IL", keys: ["hebrew"] },
  { label: "Hindi", code: "hi-IN", keys: ["hindi"] },
  { label: "Bengali", code: "bn-IN", keys: ["bengali", "bangla"] },
  { label: "Urdu", code: "ur-PK", keys: ["urdu"] },
  { label: "Tamil", code: "ta-IN", keys: ["tamil"] },
  { label: "Telugu", code: "te-IN", keys: ["telugu"] },
  { label: "Marathi", code: "mr-IN", keys: ["marathi"] },
  { label: "Gujarati", code: "gu-IN", keys: ["gujarati"] },
  { label: "Kannada", code: "kn-IN", keys: ["kannada"] },
  { label: "Malayalam", code: "ml-IN", keys: ["malayalam"] },
  { label: "Punjabi", code: "pa-IN", keys: ["punjabi"] },
  { label: "Mandarin", code: "cmn-CN", keys: ["mandarin", "chinese", "putonghua"] },
  { label: "Cantonese", code: "yue-HK", keys: ["cantonese"] },
  { label: "Japanese", code: "ja-JP", keys: ["japanese", "nihongo"] },
  { label: "Korean", code: "ko-KR", keys: ["korean"] },
  { label: "Vietnamese", code: "vi-VN", keys: ["vietnamese"] },
  { label: "Thai", code: "th-TH", keys: ["thai"] },
  { label: "Indonesian", code: "id-ID", keys: ["indonesian", "bahasa indonesia"] },
  { label: "Malay", code: "ms-MY", keys: ["malay", "bahasa melayu"] },
  { label: "Filipino", code: "fil-PH", keys: ["filipino", "tagalog"] },
  { label: "Swahili", code: "sw-KE", keys: ["swahili", "kiswahili"] },
  { label: "Amharic", code: "am-ET", keys: ["amharic"] },
  { label: "Tigrinya", code: "ti-ET", keys: ["tigrinya", "tigrigna"] },
  { label: "Somali", code: "so-SO", keys: ["somali"] },
  { label: "Hausa", code: "ha-NG", keys: ["hausa"] },
  { label: "Yoruba", code: "yo-NG", keys: ["yoruba"] },
  { label: "Igbo", code: "ig-NG", keys: ["igbo"] },
  { label: "Zulu", code: "zu-ZA", keys: ["zulu"] },
  { label: "Afrikaans", code: "af-ZA", keys: ["afrikaans"] },
  { label: "Greek", code: "el-GR", keys: ["greek"] },
  { label: "Czech", code: "cs-CZ", keys: ["czech"] },
  { label: "Romanian", code: "ro-RO", keys: ["romanian"] },
  { label: "Hungarian", code: "hu-HU", keys: ["hungarian"] },
  { label: "Swedish", code: "sv-SE", keys: ["swedish"] },
  { label: "Norwegian", code: "nb-NO", keys: ["norwegian"] },
  { label: "Danish", code: "da-DK", keys: ["danish"] },
  { label: "Finnish", code: "fi-FI", keys: ["finnish"] },
  { label: "Persian", code: "fa-IR", keys: ["persian", "farsi"] },
].map((language) => Object.freeze({
  ...language,
  keys: Object.freeze(language.keys.slice()),
})));

const LANGUAGE_BY_CODE = new Map(LANGUAGE_OPTIONS.map((language) => [language.code.toLowerCase(), language]));
const LANGUAGE_BY_KEY = new Map();
for (const language of LANGUAGE_OPTIONS) {
  LANGUAGE_BY_KEY.set(normalizeSpeechKey(language.label), language);
  for (const key of language.keys) {
    LANGUAGE_BY_KEY.set(normalizeSpeechKey(key), language);
  }
}

function canonicalVoice(value) {
  if (typeof value !== "string") {
    return null;
  }
  const raw = value.trim();
  if (!raw) {
    return null;
  }
  const named = VOICES_BY_LOWER.get(raw.toLowerCase());
  if (named) {
    return named;
  }
  return VOICE_ALIASES_BY_KEY.get(normalizeSpeechKey(raw)) || null;
}

function normalizeVoiceChoice(value) {
  return canonicalVoice(value);
}

function normalizeLanguageCode(value) {
  if (typeof value !== "string") {
    return "";
  }
  const raw = value.trim();
  if (!raw) {
    return "";
  }
  const exact = LANGUAGE_BY_CODE.get(raw.toLowerCase());
  if (exact) {
    return exact.code;
  }
  const codeMatch = raw.match(/\b[a-z]{2,3}(?:-[a-z0-9]{2,8})+\b/i);
  if (codeMatch) {
    const matched = LANGUAGE_BY_CODE.get(codeMatch[0].toLowerCase());
    if (matched) {
      return matched.code;
    }
  }
  return LANGUAGE_BY_KEY.get(normalizeSpeechKey(raw))?.code || "";
}

function splitLanguageList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/[,;|]+|\s+\band\b\s+/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeLanguageList(value) {
  const codes = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of splitLanguageList(value)) {
    const code = normalizeLanguageCode(raw);
    if (!code) {
      invalid.push(raw);
      continue;
    }
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  return { codes, invalid };
}

function normalizeLanguageListValue(value) {
  const list = normalizeLanguageList(value);
  return list.codes.length > 0 && list.invalid.length === 0 ? list.codes.join(",") : "";
}

function languageOptionsPayload() {
  return LANGUAGE_OPTIONS.map((language) => ({
    label: language.label,
    code: language.code,
    aliases: language.keys.slice(),
  }));
}

function voiceOptionsPayload() {
  return VOICE_OPTIONS.map((voice) => ({
    id: voice.id,
    label: voice.label,
    tone_tags: voice.tone_tags.slice(),
    presentation: voice.presentation,
    description: voice.description,
  }));
}

function normalizeModelOption(option) {
  if (typeof option === "string") {
    const id = option.trim();
    return id ? { id, label: id } : null;
  }
  if (!option || typeof option !== "object") {
    return null;
  }
  const id = String(option.id || option.model || "").trim();
  if (!id) {
    return null;
  }
  return {
    id,
    label: String(option.label || id),
    provider: String(option.provider || ""),
    current: option.current === true,
  };
}

function modelOptionsPayload(options = {}) {
  const seen = new Set();
  const models = [];
  for (const raw of Array.isArray(options.models) ? options.models : []) {
    const model = normalizeModelOption(raw);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function profileOptionsPayload(options = {}) {
  const models = modelOptionsPayload(options);
  return {
    version: "profile-options/v1",
    endpoints: {
      profile: "/v1/agent/profile",
      options: "/v1/agent/profile/options",
    },
    voices: voiceOptionsPayload(),
    languages: languageOptionsPayload(),
    models,
    fields: {
      model: {
        type: models.length > 0 ? "enum_or_text" : "text",
        values: models.map((model) => model.id),
      },
      voice: {
        type: "enum",
        values: CORE_VOICES.slice(),
        aliases: { ...VOICE_ALIAS_TO_ID },
      },
      language: {
        type: "language_list",
        description: "Comma-separated BCP-47 codes for the languages the agent may reply in.",
      },
      input_languages: {
        type: "language_list",
        description: "Comma-separated BCP-47 codes for the languages the user may speak.",
      },
      response_modality: {
        type: "enum",
        values: ["auto", "speech", "text"],
      },
    },
    examples: {
      set_two_input_languages: {
        profile: {
          input_languages: "en-US,am-ET",
        },
      },
      set_reply_languages: {
        profile: {
          language: "en-US,es-ES",
          language_auto_switch: false,
        },
      },
      set_feminine_voice: {
        profile: {
          voice: "Aoede",
        },
      },
    },
  };
}

module.exports = {
  LANGUAGE_OPTIONS,
  VOICE_OPTIONS,
  CORE_VOICES,
  canonicalVoice,
  normalizeVoiceChoice,
  normalizeLanguageCode,
  normalizeLanguageList,
  normalizeLanguageListValue,
  languageOptionsPayload,
  modelOptionsPayload,
  voiceOptionsPayload,
  profileOptionsPayload,
  normalizeSpeechKey,
};
