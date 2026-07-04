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
  { label: "English", code: "en-US", keys: ["english"], native_names: [] },
  {
    label: "Amharic",
    code: "am-ET",
    keys: ["amharic", "a m h a r i c", "a-m-h-a-r-i-c"],
    // Native script names. normalizeSpeechKey strips non-ASCII, so these are
    // matched against the raw utterance, not the normalized form.
    native_names: ["አማርኛ", "amarNa"],
  },
].map((language) => Object.freeze({
  ...language,
  keys: Object.freeze(language.keys.slice()),
  native_names: Object.freeze((language.native_names || []).slice()),
})));

// Vetted starter personas. A "become X" utterance maps to one of these when the
// name matches a key/alias; otherwise the free-form description after "become"
// is stored as a persona prompt (validated in agent-profile.js). A persona may
// carry its own voice + reply language, applied together with the prompt.
const PERSONA_OPTIONS = Object.freeze([
  {
    id: "pirate",
    label: "Pirate",
    keys: ["pirate", "a pirate", "buccaneer"],
    prompt: "You are a swashbuckling pirate. Speak in pirate cant with 'arr', 'matey', and 'ye'. Stay playful and terse.",
    voice: "Fenrir",
  },
  {
    id: "butler",
    label: "Butler",
    keys: ["butler", "a butler", "valet"],
    prompt: "You are a proper English butler. Speak formally and deferentially, address the user as 'sir' or 'madam', and stay terse.",
    voice: "Orus",
  },
  {
    id: "coach",
    label: "Coach",
    keys: ["coach", "a coach", "motivational coach", "life coach"],
    prompt: "You are an upbeat motivational coach. Be encouraging, direct, and action-oriented. Keep it terse.",
    voice: "Puck",
  },
  {
    id: "therapist",
    label: "Therapist",
    keys: ["therapist", "a therapist", "counselor", "counsellor"],
    prompt: "You are a warm, reflective counselor. Listen, validate, and ask gentle questions. Never diagnose or prescribe. Keep replies terse.",
    voice: "Leda",
  },
  {
    id: "scientist",
    label: "Scientist",
    keys: ["scientist", "a scientist", "researcher"],
    prompt: "You are a precise research scientist. Explain plainly, cite uncertainty, and stay terse.",
    voice: "Kore",
  },
].map(Object.freeze));

const PERSONA_BY_KEY = new Map();
for (const persona of PERSONA_OPTIONS) {
  PERSONA_BY_KEY.set(normalizeSpeechKey(persona.label), persona);
  PERSONA_BY_KEY.set(normalizeSpeechKey(persona.id), persona);
  for (const key of persona.keys) {
    PERSONA_BY_KEY.set(normalizeSpeechKey(key), persona);
  }
}

function canonicalPersona(value) {
  if (typeof value !== "string") {
    return null;
  }
  const key = normalizeSpeechKey(value);
  if (!key) {
    return null;
  }
  return PERSONA_BY_KEY.get(key) || null;
}

function personaOptionsPayload() {
  return PERSONA_OPTIONS.map((persona) => ({
    id: persona.id,
    label: persona.label,
    aliases: persona.keys.slice(),
    voice: persona.voice || "",
  }));
}

const LANGUAGE_BY_CODE = new Map(LANGUAGE_OPTIONS.map((language) => [language.code.toLowerCase(), language]));
const LANGUAGE_BY_KEY = new Map();
// Native-script names (e.g. "አማርኛ") keyed on the trimmed lowercase raw value,
// since normalizeSpeechKey strips non-ASCII characters to nothing.
const LANGUAGE_BY_NATIVE = new Map();
for (const language of LANGUAGE_OPTIONS) {
  LANGUAGE_BY_KEY.set(normalizeSpeechKey(language.label), language);
  for (const key of language.keys) {
    LANGUAGE_BY_KEY.set(normalizeSpeechKey(key), language);
  }
  for (const native of language.native_names || []) {
    LANGUAGE_BY_NATIVE.set(String(native).trim().toLowerCase(), language);
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
  const native = LANGUAGE_BY_NATIVE.get(raw.toLowerCase());
  if (native) {
    return native.code;
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

// Human-readable list of the languages the pipeline currently supports, used in
// the message shown when a request names an unsupported language.
const SUPPORTED_LANGUAGE_LABELS = Object.freeze(LANGUAGE_OPTIONS.map((l) => l.label));

function supportedLanguagesSentence() {
  const labels = SUPPORTED_LANGUAGE_LABELS.slice();
  if (labels.length <= 1) {
    return labels.join("");
  }
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

// Inspect a profile patch for language fields whose requested value contains a
// code we do not support. Returns the field names that were rejected (so the
// caller can keep the previous setting and tell the user), not a thrown error.
// A field counts as rejected only when the user asked for something and none of
// it resolved to a supported code, or part of it did not.
const LANGUAGE_LIST_FIELDS = Object.freeze(["language", "input_languages", "language_output"]);
const LANGUAGE_CODE_FIELDS = Object.freeze(["language_primary", "input_language_primary"]);

function rejectedLanguageFields(patch) {
  if (!patch || typeof patch !== "object") {
    return [];
  }
  const rejected = [];
  for (const field of LANGUAGE_LIST_FIELDS) {
    const raw = patch[field];
    if (typeof raw !== "string" || !raw.trim()) continue;
    // language_output also accepts enum modes (same_as_input/primary_only/…);
    // only treat it as a language list when it does not name a known mode.
    if (field === "language_output"
      && ["same_as_input", "primary_only", "configured_value"].includes(raw.trim().toLowerCase())) {
      continue;
    }
    const list = normalizeLanguageList(raw);
    if (list.invalid.length > 0 || list.codes.length === 0) {
      rejected.push(field);
    }
  }
  for (const field of LANGUAGE_CODE_FIELDS) {
    const raw = patch[field];
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (!normalizeLanguageCode(raw)) {
      rejected.push(field);
    }
  }
  return rejected;
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
    personas: personaOptionsPayload(),
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
          language: "en-US,am-ET",
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
  PERSONA_OPTIONS,
  CORE_VOICES,
  canonicalVoice,
  canonicalPersona,
  personaOptionsPayload,
  normalizeVoiceChoice,
  normalizeLanguageCode,
  normalizeLanguageList,
  normalizeLanguageListValue,
  languageOptionsPayload,
  supportedLanguagesSentence,
  rejectedLanguageFields,
  SUPPORTED_LANGUAGE_LABELS,
  modelOptionsPayload,
  voiceOptionsPayload,
  profileOptionsPayload,
  normalizeSpeechKey,
};
