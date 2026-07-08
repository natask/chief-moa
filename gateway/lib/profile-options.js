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

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// Supported languages are the ones Google Chirp 3 (Speech-to-Text V2, model
// `chirp_3`) can transcribe. The gateway constrains recognition to the profile's
// `input_languages` (a subset of this catalog), so the model owns which languages
// are understood by picking codes from here. Reply-language (TTS) support may be
// narrower: gemini-tts synthesizes any language the model speaks, classic
// cloud-tts only the ones with a hosted voice; where TTS lacks a language the
// pipeline returns text (never on-device TTS). `keys` are spoken english-name
// matches used only to NORMALIZE a tool argument the model already chose (e.g.
// "Amharic" -> am-ET); `native_names` do the same for native script the model may
// pass. They are not a transcript sniffer — nothing here reads the raw turn to
// switch languages. The bare language name is registered on the primary regional
// variant only, so a name resolves to one canonical code.
function defineLanguage(code, label, keys = [], nativeNames = []) {
  return { code, label, keys, native_names: nativeNames };
}

const LANGUAGE_OPTIONS = Object.freeze([
  // Chirp 3 GA languages.
  defineLanguage("en-US", "English", ["english", "us english", "american english"]),
  defineLanguage("en-GB", "English (UK)", ["british english", "uk english"]),
  defineLanguage("en-AU", "English (Australia)", ["australian english"]),
  defineLanguage("en-IN", "English (India)", ["indian english"]),
  defineLanguage("en-PH", "English (Philippines)", ["philippine english"]),
  defineLanguage("es-ES", "Spanish", ["spanish", "castilian"], ["español"]),
  defineLanguage("es-US", "Spanish (US)", ["us spanish", "american spanish"]),
  defineLanguage("es-MX", "Spanish (Mexico)", ["mexican spanish"]),
  defineLanguage("fr-FR", "French", ["french"], ["français"]),
  defineLanguage("fr-CA", "French (Canada)", ["canadian french", "quebec french"]),
  defineLanguage("de-DE", "German", ["german"], ["deutsch"]),
  defineLanguage("it-IT", "Italian", ["italian"], ["italiano"]),
  defineLanguage("pt-BR", "Portuguese", ["portuguese", "brazilian portuguese"], ["português"]),
  defineLanguage("pt-PT", "Portuguese (Portugal)", ["european portuguese"]),
  defineLanguage("nl-NL", "Dutch", ["dutch"], ["nederlands"]),
  defineLanguage("ca-ES", "Catalan", ["catalan"], ["català"]),
  defineLanguage("hr-HR", "Croatian", ["croatian"], ["hrvatski"]),
  defineLanguage("da-DK", "Danish", ["danish"], ["dansk"]),
  defineLanguage("fi-FI", "Finnish", ["finnish"], ["suomi"]),
  defineLanguage("el-GR", "Greek", ["greek"], ["ελληνικά"]),
  defineLanguage("hi-IN", "Hindi", ["hindi"], ["हिन्दी", "हिंदी"]),
  defineLanguage("ja-JP", "Japanese", ["japanese"], ["日本語"]),
  defineLanguage("ko-KR", "Korean", ["korean"], ["한국어"]),
  defineLanguage("pl-PL", "Polish", ["polish"], ["polski"]),
  defineLanguage("ro-RO", "Romanian", ["romanian"], ["română"]),
  defineLanguage("ru-RU", "Russian", ["russian"], ["русский"]),
  defineLanguage("sv-SE", "Swedish", ["swedish"], ["svenska"]),
  defineLanguage("tr-TR", "Turkish", ["turkish"], ["türkçe"]),
  defineLanguage("uk-UA", "Ukrainian", ["ukrainian"], ["українська"]),
  defineLanguage("vi-VN", "Vietnamese", ["vietnamese"], ["tiếng việt"]),
  defineLanguage("cmn-Hans-CN", "Chinese (Mandarin, Simplified)", ["chinese", "mandarin", "simplified chinese"], ["中文", "普通话"]),
  defineLanguage("cmn-Hant-TW", "Chinese (Mandarin, Traditional)", ["traditional chinese", "taiwanese mandarin"], ["國語"]),
  defineLanguage("yue-Hant-HK", "Cantonese", ["cantonese"], ["粵語", "廣東話"]),
  // Chirp 3 preview languages.
  defineLanguage("af-ZA", "Afrikaans", ["afrikaans"]),
  defineLanguage("sq-AL", "Albanian", ["albanian"], ["shqip"]),
  defineLanguage("am-ET", "Amharic", ["amharic", "a m h a r i c", "a-m-h-a-r-i-c"], ["አማርኛ", "amarNa"]),
  defineLanguage("ar-XA", "Arabic", ["arabic"], ["العربية"]),
  defineLanguage("ar-EG", "Arabic (Egypt)", ["egyptian arabic"]),
  defineLanguage("ar-SA", "Arabic (Saudi Arabia)", ["saudi arabic", "gulf arabic"]),
  defineLanguage("ar-AE", "Arabic (UAE)", ["emirati arabic"]),
  defineLanguage("ar-DZ", "Arabic (Algeria)", ["algerian arabic"]),
  defineLanguage("ar-BH", "Arabic (Bahrain)", ["bahraini arabic"]),
  defineLanguage("ar-IL", "Arabic (Israel)"),
  defineLanguage("ar-IQ", "Arabic (Iraq)", ["iraqi arabic"]),
  defineLanguage("ar-JO", "Arabic (Jordan)", ["jordanian arabic"]),
  defineLanguage("ar-KW", "Arabic (Kuwait)", ["kuwaiti arabic"]),
  defineLanguage("ar-LB", "Arabic (Lebanon)", ["lebanese arabic"]),
  defineLanguage("ar-MA", "Arabic (Morocco)", ["moroccan arabic"]),
  defineLanguage("ar-MR", "Arabic (Mauritania)"),
  defineLanguage("ar-OM", "Arabic (Oman)", ["omani arabic"]),
  defineLanguage("ar-PS", "Arabic (Palestine)", ["palestinian arabic"]),
  defineLanguage("ar-QA", "Arabic (Qatar)", ["qatari arabic"]),
  defineLanguage("ar-SY", "Arabic (Syria)", ["syrian arabic"]),
  defineLanguage("ar-TN", "Arabic (Tunisia)", ["tunisian arabic"]),
  defineLanguage("ar-YE", "Arabic (Yemen)", ["yemeni arabic"]),
  defineLanguage("hy-AM", "Armenian", ["armenian"], ["հայերեն"]),
  defineLanguage("as-IN", "Assamese", ["assamese"]),
  defineLanguage("ast-ES", "Asturian", ["asturian"]),
  defineLanguage("az-AZ", "Azerbaijani", ["azerbaijani", "azeri"]),
  defineLanguage("eu-ES", "Basque", ["basque"], ["euskara"]),
  defineLanguage("bn-BD", "Bengali (Bangladesh)", ["bengali", "bangla"], ["বাংলা"]),
  defineLanguage("bn-IN", "Bengali (India)", ["indian bengali"]),
  defineLanguage("bg-BG", "Bulgarian", ["bulgarian"], ["български"]),
  defineLanguage("my-MM", "Burmese", ["burmese", "myanmar"], ["မြန်မာ"]),
  defineLanguage("cs-CZ", "Czech", ["czech"], ["čeština"]),
  defineLanguage("et-EE", "Estonian", ["estonian"], ["eesti"]),
  defineLanguage("fil-PH", "Filipino", ["filipino", "tagalog"]),
  defineLanguage("gl-ES", "Galician", ["galician"], ["galego"]),
  defineLanguage("ka-GE", "Georgian", ["georgian"], ["ქართული"]),
  defineLanguage("gu-IN", "Gujarati", ["gujarati"], ["ગુજરાતી"]),
  defineLanguage("ha-NG", "Hausa", ["hausa"]),
  defineLanguage("iw-IL", "Hebrew", ["hebrew"], ["עברית"]),
  defineLanguage("hu-HU", "Hungarian", ["hungarian"], ["magyar"]),
  defineLanguage("is-IS", "Icelandic", ["icelandic"], ["íslenska"]),
  defineLanguage("id-ID", "Indonesian", ["indonesian"], ["bahasa indonesia"]),
  defineLanguage("jv-ID", "Javanese", ["javanese"]),
  defineLanguage("kn-IN", "Kannada", ["kannada"], ["ಕನ್ನಡ"]),
  defineLanguage("kk-KZ", "Kazakh", ["kazakh"], ["қазақ"]),
  defineLanguage("km-KH", "Khmer", ["khmer", "cambodian"], ["ខ្មែរ"]),
  defineLanguage("ky-KG", "Kyrgyz", ["kyrgyz"]),
  defineLanguage("lo-LA", "Lao", ["lao"], ["ລາວ"]),
  defineLanguage("lv-LV", "Latvian", ["latvian"], ["latviešu"]),
  defineLanguage("lt-LT", "Lithuanian", ["lithuanian"], ["lietuvių"]),
  defineLanguage("lb-LU", "Luxembourgish", ["luxembourgish"]),
  defineLanguage("mk-MK", "Macedonian", ["macedonian"], ["македонски"]),
  defineLanguage("ms-MY", "Malay", ["malay"], ["bahasa melayu"]),
  defineLanguage("ml-IN", "Malayalam", ["malayalam"], ["മലയാളം"]),
  defineLanguage("mt-MT", "Maltese", ["maltese"], ["malti"]),
  defineLanguage("mi-NZ", "Maori", ["maori"], ["te reo māori"]),
  defineLanguage("mr-IN", "Marathi", ["marathi"], ["मराठी"]),
  defineLanguage("mn-MN", "Mongolian", ["mongolian"], ["монгол"]),
  defineLanguage("ne-NP", "Nepali", ["nepali"], ["नेपाली"]),
  defineLanguage("nso-ZA", "Northern Sotho", ["northern sotho", "sepedi"]),
  defineLanguage("no-NO", "Norwegian", ["norwegian"], ["norsk"]),
  defineLanguage("or-IN", "Odia", ["odia", "oriya"], ["ଓଡ଼ିଆ"]),
  defineLanguage("fa-IR", "Persian", ["persian", "farsi"], ["فارسی"]),
  defineLanguage("pa-Guru-IN", "Punjabi", ["punjabi"], ["ਪੰਜਾਬੀ"]),
  defineLanguage("sr-RS", "Serbian", ["serbian"], ["српски"]),
  defineLanguage("sk-SK", "Slovak", ["slovak"], ["slovenčina"]),
  defineLanguage("sl-SI", "Slovenian", ["slovenian", "slovene"], ["slovenščina"]),
  defineLanguage("sw-KE", "Swahili (Kenya)", ["kenyan swahili"]),
  defineLanguage("sw", "Swahili", ["swahili"], ["kiswahili"]),
  defineLanguage("ta-IN", "Tamil", ["tamil"], ["தமிழ்"]),
  defineLanguage("te-IN", "Telugu", ["telugu"], ["తెలుగు"]),
  defineLanguage("th-TH", "Thai", ["thai"], ["ไทย"]),
  defineLanguage("uz-UZ", "Uzbek", ["uzbek"], ["oʻzbek"]),
  defineLanguage("cy-GB", "Welsh", ["welsh"], ["cymraeg"]),
  defineLanguage("wo-SN", "Wolof", ["wolof"]),
  defineLanguage("xh-ZA", "Xhosa", ["xhosa"], ["isixhosa"]),
  defineLanguage("yo-NG", "Yoruba", ["yoruba"], ["yorùbá"]),
  defineLanguage("zu-ZA", "Zulu", ["zulu"], ["isizulu"]),
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

// Read-only membership test: does the text name a supported language (by english
// name, native script, or BCP-47 code)? Used ONLY for ROUTING — to recognize a
// turn is about language configuration so it reaches the model (which owns the
// change) instead of being misrouted to a harness. It never decides or changes
// which language is active; that stays the model's job through the profile tool.
// Word/token boundaries keep short names (e.g. "lao") from matching inside other
// words.
function mentionsSupportedLanguage(text) {
  const raw = String(text || "");
  if (!raw.trim()) {
    return false;
  }
  const lowerRaw = raw.toLowerCase();
  const normalized = normalizeSpeechKey(raw);
  const tokens = new Set(normalized.split(" ").filter(Boolean));
  const containsKey = (key) => {
    const cleanKey = normalizeSpeechKey(key);
    if (!cleanKey) return false;
    if (cleanKey.includes(" ")) {
      return normalized.includes(cleanKey);
    }
    return tokens.has(cleanKey);
  };
  const containsCode = (code) => {
    if (!code) return false;
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(code.toLowerCase())}($|[^a-z0-9])`, "i");
    return pattern.test(lowerRaw);
  };
  for (const language of LANGUAGE_OPTIONS) {
    if (containsCode(language.code)) {
      return true;
    }
    if (containsKey(language.label)) {
      return true;
    }
    for (const key of language.keys) {
      if (containsKey(key)) {
        return true;
      }
    }
    for (const native of language.native_names || []) {
      if (native && lowerRaw.includes(String(native).toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

// Human-readable list of the languages the pipeline currently supports, used in
// the message shown when a request names an unsupported language.
const SUPPORTED_LANGUAGE_LABELS = Object.freeze(LANGUAGE_OPTIONS.map((l) => l.label));

function supportedLanguagesSentence() {
  const labels = SUPPORTED_LANGUAGE_LABELS.slice();
  if (labels.length <= 1) {
    return labels.join("");
  }
  // The catalog is large (every Chirp 3 language), so enumerating all of it in a
  // spoken/typed message is noise. Above a small threshold, name a few common
  // ones and give the count instead.
  if (labels.length > 8) {
    const sampleCodes = ["en-US", "am-ET", "es-ES", "fr-FR", "ar-XA", "cmn-Hans-CN"];
    const sample = sampleCodes
      .map((code) => LANGUAGE_BY_CODE.get(code)?.label)
      .filter(Boolean);
    return `${labels.length} languages including ${sample.join(", ")}, and more`;
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

// Map a friendly language-control request into a raw agent-profile patch. This is
// the single place the model's language intent (from the classic update_agent_profile
// tool OR the code-mode `set_languages` skill) becomes profile fields, so both
// paths mutate the profile identically. It does NO transcript sniffing: the model
// already decided the languages and passes them as arguments. The returned patch
// still flows through the profile sanitizer (normalizeLanguageList), which drops
// any code not in the catalog and never blanks a field.
//
//   understand / input_languages   -> the constrained set the STT recognizer is
//                                      limited to (the languages the user speaks)
//   understand_primary / speaking  -> reorder which understood language is primary
//                                      right now ("right now I want to speak X")
//   reply / language               -> the language(s) the assistant replies in
//   reply_primary                  -> the primary reply language
//   lock (bool)                    -> true disables automatic reply-language switching
function languageControlPatch(args) {
  const source = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const toList = (value) => {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || "").trim()).filter(Boolean).join(",");
    }
    return typeof value === "string" ? value.trim() : "";
  };
  const patch = {};

  const understand = toList(source.understand ?? source.understand_languages ?? source.input_languages ?? source.heard ?? source.heard_languages);
  if (understand) {
    patch.input_languages = understand;
  }
  const understandPrimary = toList(source.understand_primary ?? source.speaking ?? source.speaking_now ?? source.input_language_primary ?? source.primary_input);
  if (understandPrimary) {
    patch.input_language_primary = understandPrimary.split(",")[0].trim();
  }

  const reply = toList(source.reply ?? source.reply_languages ?? source.language ?? source.speak ?? source.output_languages);
  if (reply) {
    patch.language = reply;
    patch.language_mode = "explicit";
    patch.language_output = "primary_only";
  }
  const replyPrimary = toList(source.reply_primary ?? source.language_primary ?? source.primary_reply);
  if (replyPrimary) {
    patch.language_primary = replyPrimary.split(",")[0].trim();
  }

  if (typeof source.lock === "boolean") {
    patch.language_auto_switch = !source.lock;
  } else if (typeof source.auto_switch === "boolean") {
    patch.language_auto_switch = source.auto_switch;
  } else if (reply) {
    // A caller that pins reply languages without saying otherwise means "only
    // these", so lock switching off by default.
    patch.language_auto_switch = false;
  }
  return patch;
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
  languageControlPatch,
  mentionsSupportedLanguage,
  languageOptionsPayload,
  supportedLanguagesSentence,
  rejectedLanguageFields,
  SUPPORTED_LANGUAGE_LABELS,
  modelOptionsPayload,
  voiceOptionsPayload,
  profileOptionsPayload,
  normalizeSpeechKey,
};
