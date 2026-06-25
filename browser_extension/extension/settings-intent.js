// agee — settings-intent parser.
//
// Turns a spoken/typed request ("be terser", "set the system prompt to …",
// "use model gpt-4o-mini") into a concrete patch for the gateway runtime agent
// profile. This is the "change settings by talking to the agent" path: the
// extension is the agent surface, so the mapping from natural language to a
// profile patch lives here, deterministically, and the patch is applied via the
// gateway's existing PUT /v1/agent/profile contract (field names unchanged).
//
// parseSettingsIntent(text, current) -> { patch, summary } | null
//   text    : the user's plain-language request
//   current : the current effective profile (used for relative changes like
//             "be terser", which shrink the existing voice_max_chars)
// Returns null when the text is not a settings change (so callers fall back to
// the normal conversational path).
//
// An ES module, imported by both background.js (module service worker) and
// options.js (module script in the options page), so it stays the single
// source of truth and dependency-free.

// Profile fields the gateway accepts. Kept aligned with moa_gateway's
// lib/agent-profile.js PROFILE_FIELDS; we never invent field names.
const PROFILE_FIELDS = [
  "system_prompt",
  "model",
  "temperature",
  "voice_max_chars",
  "language",
  "voice",
  "language_mode",
  "language_primary",
  "language_output",
  "language_auto_switch",
  "input_languages",
  "input_language_primary",
  "response_modality",
];

// The Gemini Live core-8 voices the gateway accepts for the agent's OWN spoken
// voice. Kept aligned with moa_gateway's lib/agent-profile.js CORE_VOICES. Google
// labels these by style, not gender, so WE define the gender aliases below.
const CORE_VOICES = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];
const CORE_VOICES_BY_LOWER = new Map(CORE_VOICES.map((name) => [name.toLowerCase(), name]));
// Gender aliases we define (the gateway has no gender concept): a woman's voice
// maps to Aoede, a man's voice to Charon.
const FEMALE_VOICE = "Aoede";
const MALE_VOICE = "Charon";

const LANGUAGE_DEFINITIONS = [
  { label: "Amharic", code: "am-ET", keys: ["amharic"] },
  { label: "English", code: "en-US", keys: ["english"] },
  { label: "Spanish", code: "es-ES", keys: ["spanish"] },
  { label: "French", code: "fr-FR", keys: ["french"] },
  { label: "Arabic", code: "ar", keys: ["arabic"] },
  { label: "Tigrinya", code: "ti", keys: ["tigrinya"] },
];
const GATEWAY_PROFILE_LANGUAGE_NAMES = [
  "english",
  "spanish",
  "french",
  "german",
  "italian",
  "portuguese",
  "dutch",
  "russian",
  "polish",
  "ukrainian",
  "turkish",
  "arabic",
  "hebrew",
  "hindi",
  "bengali",
  "bangla",
  "urdu",
  "tamil",
  "telugu",
  "mandarin",
  "chinese",
  "cantonese",
  "japanese",
  "korean",
  "vietnamese",
  "thai",
  "indonesian",
  "malay",
  "filipino",
  "tagalog",
  "swahili",
  "amharic",
  "tigrinya",
  "tigrigna",
  "somali",
  "hausa",
  "yoruba",
  "igbo",
  "zulu",
  "afrikaans",
  "greek",
  "czech",
  "romanian",
  "hungarian",
  "swedish",
  "norwegian",
  "danish",
  "finnish",
  "persian",
  "farsi",
];

const DEFAULT_VOICE_MAX_CHARS = 280;
const TERSE_MAX_CHARS = 140;
const VERBOSE_MAX_CHARS = 600;

function clampVoiceMaxChars(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(20, Math.min(4000, Math.round(value)));
}

// "set the system prompt to X" / "system prompt: X" / "your prompt is X".
function matchSystemPrompt(raw) {
  const m =
    raw.match(/(?:set|change|make|update)?\s*(?:your\s+|the\s+)?system\s*prompt\s*(?:to|=|:|should be|is)\s+([\s\S]+)/i) ||
    raw.match(/(?:set|change|make|update)\s+(?:your\s+|the\s+)?prompt\s+(?:to|=|:)\s+([\s\S]+)/i);
  if (!m) return null;
  const value = stripQuotes(m[1].trim());
  if (!value) return null;
  return { patch: { system_prompt: value }, summary: `system prompt set (${value.length} chars)` };
}

// "set the model to X" / "use model X" / "use the gateway model X".
function matchModel(raw) {
  const m =
    raw.match(/(?:set|change|switch|use)\s+(?:the\s+)?(?:gateway\s+)?model\s+(?:to|=|:)?\s*([^\s,.;]+)/i) ||
    raw.match(/(?:use|switch to)\s+(?:the\s+)?model\s+([^\s,.;]+)/i);
  if (!m) return null;
  const value = stripQuotes(m[1].trim());
  if (!value) return null;
  return { patch: { model: value }, summary: `model set to ${value}` };
}

// "set temperature to 0.2" / "temperature 0.7".
function matchTemperature(raw) {
  const m = raw.match(/temperature\s*(?:to|=|:)?\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0 || value > 2) return null;
  return { patch: { temperature: value }, summary: `temperature set to ${value}` };
}

// Explicit length: "set voice max chars to 200", "limit replies to 120 characters",
// "keep replies under 90 chars".
function matchVoiceMaxChars(raw) {
  const m =
    raw.match(/(?:voice\s*max\s*chars?|max\s*chars?|character\s*limit)\s*(?:to|=|:)?\s*(\d+)/i) ||
    raw.match(/(?:limit|keep|cap)\s+(?:the\s+)?(?:spoken\s+)?repl(?:y|ies)\s+(?:to|under|at|below)\s+(\d+)\s*(?:char|character)/i);
  if (!m) return null;
  const value = clampVoiceMaxChars(Number(m[1]));
  if (value == null) return null;
  return { patch: { voice_max_chars: value }, summary: `spoken reply limit set to ${value} chars` };
}

// "set language to French" / "reply in Spanish" / "speak English".
function matchLanguage(raw) {
  const lower = normalizeSpeech(raw);
  const command =
    /\b(?:set\s+)?language\s*(?:to|=|:)/i.test(raw) ||
    /\b(?:reply|respond|answer|speak|talk)\s+(?:to me\s+)?in\b/i.test(raw) ||
    /\bonly\s+(?:speak|talk|respond|answer)\b/i.test(raw) ||
    /\b(?:only\s+)?(?:going to|gonna)\s+(?:speak|talk)\b/i.test(raw) ||
    /\bthese\s+(?:two\s+)?languages\b/i.test(raw) ||
    /\bdo\s+not\s+switch\b/i.test(raw) ||
    /\bdon'?t\s+switch\b/i.test(raw);
  if (!command) return null;
  const matched = matchedLanguages(lower);
  if (matched.length === 0) return null;
  const locked = matched.length > 1 ||
    /\bonly\b/i.test(raw) ||
    /\bthese\s+(?:two\s+)?languages\b/i.test(raw) ||
    /\bdo\s+not\s+switch\b/i.test(raw) ||
    /\bdon'?t\s+switch\b/i.test(raw);
  const primary = matched[0];
  const names = matched.map((language) => language.label).join(" + ");
  return {
    patch: {
      language: matched.map((language) => language.code).join(","),
      language_primary: primary.code,
      language_mode: "explicit",
      language_output: "primary_only",
      language_auto_switch: false,
    },
    summary: locked ? `language locked to ${names}` : `language set to ${names}`,
  };
}

function matchedLanguages(lower) {
  const out = [];
  for (const language of LANGUAGE_DEFINITIONS) {
    const indexes = language.keys
      .map((key) => lower.indexOf(key))
      .filter((index) => index >= 0);
    if (indexes.length > 0 && !out.some((item) => item.code === language.code)) {
      out.push({ ...language, index: Math.min(...indexes) });
    }
  }
  return out.sort((a, b) => a.index - b.index).map(({ index, ...language }) => language);
}

// Change the agent's OWN spoken voice. Three shapes, in priority order:
//   - gender alias:  "female"/"woman"/"sound like a woman" -> Aoede;
//                    "male"/"man"/"sound like a man"        -> Charon.
//   - explicit name: "use the Charon voice", "use voice Leda", "switch to Kore",
//                    "set voice to Aoede" -> that core-8 voice (case-insensitive).
// Anchored on the word "voice" or an explicit "sound like a man/woman" so it
// never swallows ordinary system-prompt text.
function matchVoice(raw) {
  // Explicit core-voice by name wins when a real voice name is present, so
  // "use the Charon voice" picks Charon rather than the male alias.
  const named =
    raw.match(/\b(?:use|set|change|switch(?:\s+to)?|make)\b[^.]*?\bvoice\b\s*(?:to|=|:|should be|is|named|called)?\s*([a-zA-Z]+)/i) ||
    raw.match(/\b(?:use|switch\s+to)\s+(?:the\s+)?([a-zA-Z]+)\s+voice\b/i) ||
    raw.match(/\b(?:use|set|switch\s+to)\s+voice\s+([a-zA-Z]+)/i);
  if (named) {
    const canonical = CORE_VOICES_BY_LOWER.get(stripQuotes(named[1].trim()).toLowerCase());
    if (canonical) {
      return { patch: { voice: canonical }, summary: `voice set to ${canonical}` };
    }
  }

  // "switch to Kore" / "use Aoede" — a bare core-voice name after a switch verb,
  // with no "voice" word. Safe because we only accept the fixed core-8 names.
  const bare = raw.match(/\b(?:switch\s+to|use|set|change\s+to|sound\s+like)\s+(?:the\s+|a\s+|an\s+)?([a-zA-Z]+)\b/i);
  if (bare) {
    const canonical = CORE_VOICES_BY_LOWER.get(stripQuotes(bare[1].trim()).toLowerCase());
    if (canonical) {
      return { patch: { voice: canonical }, summary: `voice set to ${canonical}` };
    }
  }

  // Gender aliases: only fire when the request is clearly about the voice/sound,
  // not any incidental mention of "woman"/"man".
  const aboutVoice = /\bvoice\b/i.test(raw) || /\bsound\s+like\b/i.test(raw) || /\bspeak\s+like\b/i.test(raw);
  if (aboutVoice) {
    if (/\b(female|woman|girl|feminine|lady)\b/i.test(raw)) {
      return { patch: { voice: FEMALE_VOICE }, summary: `voice set to ${FEMALE_VOICE}` };
    }
    if (/\b(male|man|guy|masculine|boy)\b/i.test(raw)) {
      return { patch: { voice: MALE_VOICE }, summary: `voice set to ${MALE_VOICE}` };
    }
  }
  return null;
}

// Relative terseness: "be terser", "be more concise", "shorter replies".
function matchTerser(raw, current) {
  if (!/\b(terser|more\s+terse|be\s+terse|more\s+concise|be\s+concise|shorter|be\s+brief|more\s+brief|less\s+wordy)/i.test(raw)) {
    return null;
  }
  const base = numberOr(current?.voice_max_chars, DEFAULT_VOICE_MAX_CHARS);
  // Halve toward a terse floor so repeated requests keep shrinking.
  const next = clampVoiceMaxChars(Math.min(TERSE_MAX_CHARS, Math.floor(base / 2)));
  return { patch: { voice_max_chars: next }, summary: `terser: spoken reply limit ${base} → ${next} chars` };
}

// Relative verbosity: "be more verbose", "longer replies", "more detail".
function matchVerbose(raw, current) {
  if (!/\b(more\s+verbose|be\s+verbose|longer\s+repl|more\s+detail|less\s+terse|more\s+wordy)/i.test(raw)) {
    return null;
  }
  const base = numberOr(current?.voice_max_chars, DEFAULT_VOICE_MAX_CHARS);
  const next = clampVoiceMaxChars(Math.max(VERBOSE_MAX_CHARS, base * 2));
  return { patch: { voice_max_chars: next }, summary: `more verbose: spoken reply limit ${base} → ${next} chars` };
}

// Order matters: specific field setters before the relative shorthands, and
// system-prompt last among setters because its value is free text that could
// otherwise swallow a "model"/"temperature" mention inside the prompt body.
const MATCHERS = [
  matchModel,
  matchTemperature,
  // matchVoiceMaxChars before matchVoice so "voice max chars to 200" sets the
  // length limit, not the spoken voice.
  matchVoiceMaxChars,
  matchVoice,
  matchLanguage,
  matchTerser,
  matchVerbose,
  matchSystemPrompt,
];

function parseSettingsIntent(text, current) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const scope = profileScopeFromText(raw);
  const explicitSystemPrompt = matchSystemPrompt(raw);
  if (explicitSystemPrompt && startsWithSystemPromptSetter(raw)) {
    return withScope(explicitSystemPrompt, scope);
  }
  if (looksLikeInstructionalExample(raw)) {
    return null;
  }
  // A leading verb is a strong settings signal but not required for the
  // shorthands ("be terser"). Each matcher is responsible for its own anchor.
  for (const matcher of MATCHERS) {
    const result = matcher(raw, current);
    if (result && hasUsableFields(result.patch)) {
      return withScope(result, scope);
    }
  }
  return null;
}

function withScope(result, scope) {
  return scope ? { ...result, scope } : result;
}

function profileScopeFromText(raw) {
  const lower = normalizeSpeech(raw);
  if (/\b(?:all|every)\s+(?:device|devices|surface|surfaces|client|clients)\b/.test(lower)
    || /\b(?:globally|global|everywhere|for everyone|all sessions)\b/.test(lower)) {
    return "global";
  }
  if (/\b(?:this|current|only this|just this)\s+(?:device|phone|browser|surface|client)\b/.test(lower)
    || /\b(?:on|for)\s+(?:this|my)\s+(?:device|phone|browser)\b/.test(lower)
    || /\b(?:here only|just here|only here)\b/.test(lower)) {
    return "device";
  }
  return "";
}

function normalizeSpeech(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function startsWithSystemPromptSetter(raw) {
  return /^\s*(?:(?:set|change|make|update)\s+)?(?:your\s+|the\s+)?system\s*prompt\b/i.test(raw) ||
    /^\s*(?:set|change|make|update)\s+(?:your\s+|the\s+)?prompt\b/i.test(raw);
}

function looksLikeInstructionalExample(raw) {
  const sentenceCount = raw.split(/[.!?]\s+/).filter((part) => part.trim()).length;
  if (sentenceCount < 2) return false;
  const hasQuotedCommand = /["“][^"”]{0,140}\b(?:use|set|switch|be|change|make|update)\b[^"”]{0,140}["”]/i.test(raw);
  const hasInstructionalFrame = /\b(?:for example|e\.g\.|tell it|type a request|press|open chrome|load unpacked)\b/i.test(raw);
  return hasQuotedCommand && hasInstructionalFrame;
}

function hasUsableFields(patch) {
  return Boolean(patch) && Object.keys(patch).some((key) => PROFILE_FIELDS.includes(key));
}

// Detect a *question about* the agent's prompt history (not a change):
// "what prompts have I set?", "how many system prompts have I asked you?",
// "show my prompt history", "what changes have I made to your prompt?".
// Returns { kind: "prompt_history" } or null. Kept here so the natural-language
// surface for the agent profile stays in one file.
function parseProfileQueryIntent(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const mentionsPrompt = /\bprompts?\b/i.test(raw);
  const asksHistory =
    /\bprompt\s+history\b/i.test(raw) ||
    (mentionsPrompt && /\bhow many\b/i.test(raw)) ||
    (mentionsPrompt && /\b(list|show|what(?:'s| is| are)?)\b/i.test(raw) && /\b(set|asked|made|given|history|so far|have i)\b/i.test(raw)) ||
    (/\bwhat\b/i.test(raw) && /\bchanges?\b/i.test(raw) && /\b(prompt|system|behaviou?r)\b/i.test(raw));
  return asksHistory ? { kind: "prompt_history" } : null;
}

function looksLikeGatewayProfileControlIntent(text) {
  const raw = String(text || "").trim();
  if (looksLikeInstructionalExample(raw)) return false;
  const lower = normalizeSpeech(raw);
  if (!lower) return false;
  return isGatewayPromptControl(lower) || isGatewayIdentityControl(lower) || isGatewayLanguageControl(lower) || isGatewayVoiceControl(lower);
}

function isGatewayPromptControl(lower) {
  return lower.includes("what prompt") ||
    lower.includes("which prompt") ||
    lower.includes("current prompt") ||
    /\b(set|change|update)\b.*\b(system )?prompt\b/.test(lower);
}

function isGatewayIdentityControl(lower) {
  return lower.includes("what is your name") ||
    lower.includes("what s your name") ||
    lower.includes("who are you") ||
    /\byour name\b\s*(is|should be|will be)\b/.test(lower) ||
    /\b(call|name) yourself\b/.test(lower) ||
    /\b(you are|youre)\b\s+(now\s+)?(called\s+|named\s+)?/.test(lower);
}

function isGatewayLanguageControl(lower) {
  if (
    lower.includes("what language") ||
    lower.includes("which language") ||
    lower.includes("language is active") ||
    lower.includes("language settings") ||
    /\b(set|change|update|switch)\b.*\blanguage\b/.test(lower)
  ) {
    return true;
  }
  if (!containsProfileWord(lower, GATEWAY_PROFILE_LANGUAGE_NAMES)) return false;
  return /\b(speak|talk|reply|respond|answer|say|process|understand|listen|recognize|restrict|select|allow)\b/.test(lower) ||
    lower.includes(" only ") ||
    lower.startsWith("only ") ||
    lower.includes("do not switch") ||
    lower.includes("don t switch") ||
    lower.includes("dont switch") ||
    lower.includes("these languages") ||
    lower.includes("these two languages");
}

function isGatewayVoiceControl(lower) {
  if (
    lower.includes("what voice") ||
    lower.includes("which voice") ||
    lower.includes("voice is active") ||
    /\b(set|change|switch|use|make)\b.*\bvoice\b/.test(lower)
  ) {
    return true;
  }
  if (lower.includes("sound like") || lower.includes("speak like")) {
    return /\b(female|woman|girl|feminine|lady|male|man|guy|masculine|boy)\b/.test(lower) ||
      containsProfileWord(lower, CORE_VOICES.map((name) => name.toLowerCase()));
  }
  return containsProfileWord(lower, CORE_VOICES.map((name) => name.toLowerCase())) &&
    /\b(use|switch|set|change)\b/.test(lower);
}

function containsProfileWord(lower, words) {
  return words.some((word) => lower.includes(word));
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function stripQuotes(value) {
  const trimmed = String(value || "").trim();
  const quoted = trimmed.match(/^["'“”'](.*)["'“”']$/s);
  return (quoted ? quoted[1] : trimmed).trim();
}

export { parseSettingsIntent, parseProfileQueryIntent, looksLikeGatewayProfileControlIntent, PROFILE_FIELDS };
