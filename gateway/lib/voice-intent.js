"use strict";

// Voice-turn intent classification. Pure functions over a transcript (and the
// request body's forced/hint fields). Extracted from server.js so the brittle
// keyword/regex logic can be unit-tested in isolation — this is the part most
// likely to drift as new phrasings appear.
//
// classifyVoiceTurn returns one of:
// "control" | "profile_control" | "multi_agent" | "agent_run" | "chat".

// Lowercase, strip punctuation, collapse whitespace. The matchers below assume
// this normalized form for exact-equality and substring checks.
function normalizeSpeech(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The Gemini Live core-8 voices the gateway accepts for the agent's OWN spoken
// voice. Kept aligned with lib/agent-profile.js CORE_VOICES and the browser
// extension's settings-intent.js. Google labels these by style, not gender, so
// WE define the gender aliases: a woman's voice maps to Aoede, a man's to Charon.
const CORE_VOICES = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];
const CORE_VOICES_BY_LOWER = new Map(CORE_VOICES.map((name) => [name.toLowerCase(), name]));
const FEMALE_VOICE = "Aoede";
const MALE_VOICE = "Charon";

function canonicalVoice(value) {
  return CORE_VOICES_BY_LOWER.get(String(value || "").trim().toLowerCase()) || null;
}

const LANGUAGE_DEFINITIONS = [
  { label: "Amharic", code: "am-ET", keys: ["amharic"] },
  { label: "English", code: "en-US", keys: ["english"] },
  { label: "Spanish", code: "es-ES", keys: ["spanish"] },
  { label: "French", code: "fr-FR", keys: ["french"] },
  { label: "Arabic", code: "ar", keys: ["arabic"] },
  { label: "Tigrinya", code: "ti", keys: ["tigrinya"] },
];

// "stop / cancel / shut up" — a control utterance, not a request.
function isStopLike(text) {
  const lower = normalizeSpeech(text);
  return lower === "stop"
    || lower === "cancel"
    || lower === "never mind"
    || lower === "nevermind"
    || lower === "stop talking"
    || lower === "stop speaking"
    || lower === "shut up";
}

// The user explicitly asked for several agents at once.
function wantsMultipleAgents(text) {
  const lower = normalizeSpeech(text);
  return lower.includes("multiple agents")
    || lower.includes("all agents")
    || lower.includes("both agents")
    || lower.includes("parallel agents")
    || lower.includes("gemini and claude")
    || lower.includes("claude and gemini")
    || lower.includes("gemini and codex")
    || lower.includes("codex and gemini");
}

// Heuristic: does this sound like an action to run, not a question to answer?
function shouldRunAgentFromVoice(text) {
  const lower = normalizeSpeech(text);
  if (!lower) return false;
  const actionStarts = [
    "make ",
    "build ",
    "fix ",
    "change ",
    "implement ",
    "add ",
    "update ",
    "refactor ",
    "test ",
    "create ",
    "wire ",
    "hook up ",
    "continue ",
    "make progress ",
  ];
  if (actionStarts.some((start) => lower.startsWith(start))) {
    return true;
  }
  return lower.includes("push code")
    || lower.includes("make it work")
    || lower.includes("run the tests")
    || lower.includes("home machine")
    || lower.includes("in the repo")
    || lower.includes("in the app")
    || lower.includes("operational systems")
    || lower.includes("what s going on")
    || lower.includes("what is going on")
    || lower.includes("things operating")
    || lower.includes("projects i have ongoing")
    || lower.includes("all the projects")
    || lower.includes("what am i working on")
    || lower.includes("forward progress")
    || lower.includes("chrome extension")
    || lower.includes("android app")
    || lower.includes("mobile gateway")
    || lower.includes("moa gateway");
}

// An explicit "run an agent" prefix. Returns the prompt after the prefix, or "".
function explicitAgentPromptFrom(text) {
  const trimmed = String(text || "").trim();
  const lower = trimmed.toLowerCase();
  const prefixes = ["/agent ", "/run ", "agent run ", "moa run ", "run agent ", "ask agent "];
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return "";
}

function parseProfileControlIntent(text) {
  const raw = String(text || "").trim();
  const lower = normalizeSpeech(raw);
  if (!lower) {
    return null;
  }

  if (lower.includes("what prompt") || lower.includes("which prompt") || lower.includes("current prompt")) {
    return { action: "summary", subject: "system_prompt" };
  }
  if (lower.includes("what language") || lower.includes("which language") || lower.includes("language is active")) {
    return { action: "summary", subject: "language" };
  }
  if (lower.includes("what provider") || lower.includes("which provider") || lower.includes("provider is active")) {
    return { action: "summary", subject: "providers" };
  }
  if (lower.includes("what tool mode") || lower.includes("which tool mode") || lower.includes("autonomy mode")) {
    return { action: "summary", subject: "tool_policy" };
  }

  const prompt = promptUpdateFrom(raw);
  if (prompt) {
    return {
      action: "update",
      patch: { system_prompt: prompt },
      summary: "system prompt",
    };
  }

  const language = languageUpdateFrom(lower);
  if (language) {
    return {
      action: "update",
      patch: {
        language: language.code,
        language_primary: language.primary_code || language.code,
        language_mode: "explicit",
        language_output: "primary_only",
        language_auto_switch: false,
      },
      summary: language.label,
    };
  }

  const voice = voiceUpdateFrom(raw);
  if (voice) {
    return {
      action: "update",
      patch: { voice },
      summary: `voice ${voice}`,
    };
  }

  return null;
}

function promptUpdateFrom(text) {
  const patterns = [
    /\b(?:set|change|update)\s+(?:your\s+)?system\s+prompt\s+(?:to|as)\s+(.+)$/i,
    /\b(?:set|change|update)\s+(?:your\s+)?prompt\s+(?:to|as)\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match?.[1]) {
      return match[1].trim().slice(0, 4000);
    }
  }
  return "";
}

function languageUpdateFrom(lower) {
  const isCommand = lower.startsWith("speak ")
    || lower.startsWith("switch to ")
    || lower.startsWith("answer in ")
    || lower.startsWith("respond in ")
    || lower.startsWith("only speak ")
    || lower.startsWith("only talk ")
    || lower.includes("only going to speak")
    || lower.includes("only gonna speak")
    || lower.includes("these two languages")
    || lower.includes("these languages")
    || lower.includes("do not switch")
    || lower.includes("don t switch")
    || lower.includes("don't switch")
    || lower.includes(" switch to ")
    || lower.includes(" speak ");
  if (!isCommand) {
    return null;
  }
  const matched = matchedLanguages(lower);
  if (matched.length === 0) {
    return null;
  }
  const locked = matched.length > 1
    || lower.includes("only ")
    || lower.includes("do not switch")
    || lower.includes("don t switch")
    || lower.includes("don't switch")
    || lower.includes("these two languages")
    || lower.includes("these languages");
  const primary = matched[0];
  return {
    label: matched.map((language) => language.label).join(" + "),
    code: matched.map((language) => language.code).join(","),
    primary_code: primary.code,
    locked,
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
//   - explicit core-voice name: "set voice to Aoede", "use the Charon voice".
//   - bare core-voice name after a switch verb: "switch to Kore", "use Aoede".
//   - gender alias: "use a female voice"/"sound like a woman" -> Aoede;
//                   "use a male voice"/"sound like a man"      -> Charon.
// Returns a canonical core-8 name, or "" when no voice change is requested.
function voiceUpdateFrom(text) {
  const raw = String(text || "");

  // Explicit core-voice by name wins, so "use the Charon voice" picks Charon
  // rather than the male alias.
  const named =
    raw.match(/\b(?:use|set|change|switch(?:\s+to)?|make)\b[^.]*?\bvoice\b\s*(?:to|=|:|should be|is|named|called)?\s*([a-zA-Z]+)/i) ||
    raw.match(/\b(?:use|switch\s+to)\s+(?:the\s+)?([a-zA-Z]+)\s+voice\b/i) ||
    raw.match(/\b(?:use|set|switch\s+to)\s+voice\s+([a-zA-Z]+)/i);
  if (named) {
    const canonical = canonicalVoice(named[1]);
    if (canonical) return canonical;
  }

  // Bare core-voice name after a switch verb, with no "voice" word. Safe because
  // we only accept the fixed core-8 names.
  const bare = raw.match(/\b(?:switch\s+to|use|set|change\s+to|sound\s+like)\s+(?:the\s+|a\s+|an\s+)?([a-zA-Z]+)\b/i);
  if (bare) {
    const canonical = canonicalVoice(bare[1]);
    if (canonical) return canonical;
  }

  // Gender aliases: only when the request is clearly about the voice/sound, not
  // an incidental mention of "man"/"woman".
  const aboutVoice = /\bvoice\b/i.test(raw) || /\bsound\s+like\b/i.test(raw) || /\bspeak\s+like\b/i.test(raw);
  if (aboutVoice) {
    if (/\b(female|woman|girl|feminine|lady)\b/i.test(raw)) return FEMALE_VOICE;
    if (/\b(male|man|guy|masculine|boy)\b/i.test(raw)) return MALE_VOICE;
  }
  return "";
}

// Route a voice turn. `body` may carry forced_action / intent_hint to override.
function classifyVoiceTurn(body, transcript) {
  const b = body || {};
  const forced = String(b.forced_action || b.client?.intent_hint || b.intent_hint || "").toLowerCase();
  if (forced === "control" || isStopLike(transcript)) {
    return "control";
  }
  if (forced === "profile_control" || parseProfileControlIntent(transcript)) {
    return "profile_control";
  }
  if (forced === "multi_agent" || wantsMultipleAgents(transcript)) {
    return "multi_agent";
  }
  if (forced === "agent_run") {
    return "agent_run";
  }
  if (explicitAgentPromptFrom(transcript)) {
    return "agent_run";
  }
  return shouldRunAgentFromVoice(transcript) ? "agent_run" : "chat";
}

module.exports = {
  normalizeSpeech,
  isStopLike,
  wantsMultipleAgents,
  shouldRunAgentFromVoice,
  explicitAgentPromptFrom,
  parseProfileControlIntent,
  classifyVoiceTurn,
};
