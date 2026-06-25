"use strict";

// Voice-turn intent classification. Pure functions over a transcript (and the
// request body's forced/hint fields). Extracted from server.js so the brittle
// keyword/regex logic can be unit-tested in isolation — this is the part most
// likely to drift as new phrasings appear.
//
// classifyVoiceTurn returns one of:
// "control" | "profile_control" | "multi_agent" | "agent_run" | "chat".

const {
  LANGUAGE_OPTIONS: LANGUAGE_DEFINITIONS,
  canonicalVoice,
} = require("./profile-options");

// Lowercase, strip punctuation, collapse whitespace. The matchers below assume
// this normalized form for exact-equality and substring checks.
function normalizeSpeech(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FEMALE_VOICE = "Aoede";
const MALE_VOICE = "Charon";

// "stop / shut up / be quiet / don't speak" — a control utterance that just
// silences the agent. It is NOT a request and gets NO spoken reply. Matched on
// the normalized (punctuation-stripped) form, e.g. "don't speak" -> "don t
// speak". Exact-set membership, not substring, so "stop the build" stays a real
// request. "respond in text" is a modality change, not a stop — handled below.
const STOP_PHRASES = new Set([
  "stop", "stop it", "stop it now", "stop talking", "stop speaking", "stop responding",
  "cancel", "never mind", "nevermind",
  "shut up", "shut it", "shut the fuck up", "shut the hell up",
  "be quiet", "quiet", "silence", "hush", "enough", "zip it",
  "dont speak", "don t speak", "do not speak", "dont talk", "don t talk",
]);
function isStopLike(text) {
  return STOP_PHRASES.has(normalizeSpeech(text));
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
  const scope = profileScopeFromText(lower);
  const asksForOptions = /\b(?:what|which|list|show|tell me|available|different)\b/.test(lower)
    || /\bcan\s+(?:you|i)\b/.test(lower);

  if (asksForOptions
    && /\blanguages?\b/.test(lower)
    && /\b(?:available|different|support|supported|speak|reply|respond|understand|make you speak|can you speak|can i make you speak)\b/.test(lower)) {
    return { action: "summary", subject: "language_options", scope };
  }
  if (asksForOptions
    && /\bvoices?\b/.test(lower)
    && /\b(?:available|different|support|supported|use|choose|select|sound|speak)\b/.test(lower)) {
    return { action: "summary", subject: "voice_options", scope };
  }

  if (lower.includes("what prompt") || lower.includes("which prompt") || lower.includes("current prompt")) {
    return { action: "summary", subject: "system_prompt", scope };
  }
  if (lower.includes("what language") || lower.includes("which language") || lower.includes("language is active")) {
    return { action: "summary", subject: "language", scope };
  }
  if (lower.includes("what voice") || lower.includes("which voice") || lower.includes("voice is active")) {
    return { action: "summary", subject: "voice", scope };
  }
  if (lower.includes("what is your name") || lower.includes("what s your name") || lower.includes("who are you")) {
    return { action: "summary", subject: "assistant_name", scope };
  }
  if (lower.includes("what provider") || lower.includes("which provider") || lower.includes("provider is active")) {
    return { action: "summary", subject: "providers", scope };
  }
  if (lower.includes("what tool mode") || lower.includes("which tool mode") || lower.includes("autonomy mode")) {
    return { action: "summary", subject: "tool_policy", scope };
  }

  const prompt = promptUpdateFrom(raw);
  if (prompt) {
    return {
      action: "update",
      patch: { system_prompt: prompt },
      summary: "system prompt",
      scope,
    };
  }

  const assistantName = assistantNameUpdateFrom(raw);
  if (assistantName) {
    return {
      action: "update",
      patch: { assistant_name: assistantName },
      summary: "assistant name",
      confirmation: `Yes. I am now ${assistantName}.`,
      scope,
    };
  }

  const languageIntent = parseLanguageIntent(raw);
  if (languageIntent) {
    return { action: "update", patch: languageIntent.patch, summary: languageIntent.summary, scope };
  }

  const modality = modalityUpdateFrom(lower);
  if (modality) {
    return {
      action: "update",
      patch: { response_modality: modality },
      summary: modality === "text" ? "reply in text" : "reply out loud",
      scope,
    };
  }

  const voice = voiceUpdateFrom(raw);
  if (voice) {
    return {
      action: "update",
      patch: { voice },
      summary: `voice ${voice}`,
      scope,
    };
  }

  if (needsVoiceChoice(lower)) {
    return {
      action: "clarify",
      subject: "voice",
      summary: "voice",
      scope,
    };
  }

  return null;
}

function profileScopeFromText(lower) {
  if (/\b(?:all|every)\s+(?:device|devices|surface|surfaces|client|clients)\b/.test(lower)
    || /\b(?:globally|global|everywhere|for everyone|all sessions)\b/.test(lower)) {
    return "global";
  }
  if (/\b(?:this|current|only this|just this)\s+(?:device|phone|browser|surface|client)\b/.test(lower)
    || /\b(?:on|for)\s+(?:this|my)\s+(?:device|phone|browser)\b/.test(lower)
    || /\b(?:here only|just here|only here)\b/.test(lower)) {
    return "device";
  }
  return "global";
}

function assistantNameUpdateFrom(text) {
  const raw = String(text || "").trim();
  const patterns = [
    /\b(?:your\s+name)\s+(?:is|should\s+be|will\s+be|=|:)\s+(.+)$/i,
    /\b(?:call|name)\s+yourself\s+(.+)$/i,
    /\b(?:you\s+are|you're|youre)\s+(?:now\s+)?(?:called\s+|named\s+)?(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const name = normalizeAssistantNameCandidate(match?.[1] || "");
    if (name) {
      return name;
    }
  }
  return "";
}

function normalizeAssistantNameCandidate(value) {
  let candidate = String(value || "")
    .trim()
    .replace(/\s+(?:from\s+now\s+on|going\s+forward|now|please)$/i, "")
    .replace(/^["'`]+|["'`.!,?;:]+$/g, "")
    .replace(/\s+/g, " ");
  if (!candidate) {
    return "";
  }
  candidate = candidate.replace(/^(?:a|an)\s+/i, "");
  const lower = normalizeSpeech(candidate);
  if (!lower) {
    return "";
  }
  if (candidate.length > 80 || candidate.split(/\s+/).length > 4) {
    return "";
  }
  if (!/[A-Za-z0-9]/.test(candidate)) {
    return "";
  }
  return candidate;
}

// How the agent should deliver replies: "text" (write, don't speak) or "speech"
// (speak out loud). Returns null when the utterance is not about output modality.
// Operates on normalized text ("don't" -> "don t"). Runs after the language
// parser, so "respond in French" is language and "respond in text" is modality.
function modalityUpdateFrom(lower) {
  if (/\b(?:respond|reply|answer|write|type|put it|send it)\b[^.]*\b(?:in|with|as|via|using)?\s*(?:text|writing|chat)\b/.test(lower)
    || /\btext\s*(?:only|mode)\b/.test(lower)
    || /\b(?:just|only)\s+text\b/.test(lower)
    || /\b(?:don t|do not|dont|stop)\s+(?:speak|speaking|talk|talking)\s+(?:out loud|aloud)\b/.test(lower)
    || /\b(?:no|without|mute)\s+(?:voice|audio|sound|speech)\b/.test(lower)) {
    return "text";
  }
  if ((/\b(?:out loud|aloud|verbally)\b/.test(lower) && /\b(?:speak|talk|respond|reply|say)\b/.test(lower))
    || /\b(?:voice|speech|audio)\s*mode\b/.test(lower)
    || /\b(?:use|with|using)\s+your\s+voice\b/.test(lower)
    || /\b(?:speak|talk)\s+to\s+me\b/.test(lower)
    || /\b(?:respond|reply|answer|speak|talk)\b[^.]*\b(?:in|with|via|using)\s*(?:voice|speech|audio)\b/.test(lower)) {
    return "speech";
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

// Find every known language named in a phrase, in spoken order.
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

// Which side of the conversation a clause is about:
//   "input"  -> the language the USER speaks (drives speech recognition)
//   "output" -> the language the AGENT replies in (drives the reply)
// The subject decides it: "I/my" + a speaking verb is the user (input); "you" or
// a bare command verb ("speak X", "respond in X", "switch to X") is the agent
// (output). "talk to me in X" is output — "me" is the object, not the subject.
function languageSideOf(clause) {
  const isInput = /\b(?:i|i'm|im|i am)\b[^.]*\b(?:speak|talk|understand|know|say|use)\b/.test(clause)
    || /\bmy\s+(?:language|languages|native\s+language|mother\s+tongue)\b/.test(clause)
    || /^\s*(?:can you\s+|please\s+|only\s+|just\s+)*(?:process|understand|listen|recognize)\b/.test(clause)
    || /\b(?:input|process|understand|listen|recognize)\s+(?:only\s+)?(?:these\s+)?languages?\b/.test(clause);
  if (isInput) return "input";
  const isOutput = /\b(?:you|your)\b/.test(clause)
    || /^\s*(?:can you\s+|please\s+|only\s+|just\s+)*(?:speak|talk|respond|reply|answer|say)\b/.test(clause)
    || /\b(?:respond|reply|answer|talk|speak)\s+(?:to me\s+)?in\b/.test(clause)
    || /\bswitch\s+to\b/.test(clause);
  return isOutput ? "output" : null;
}

// Parse a language request into input (user) and/or output (agent) sides. One
// utterance can set both: "I only speak Amharic and you only speak English".
// Returns { patch, summary } or null when no language is requested.
function parseLanguageIntent(text) {
  const raw = String(text || "");
  const lower = normalizeSpeech(raw);
  if (!lower) return null;
  if (!/\blanguages?\b/.test(lower) && matchedLanguages(lower).length === 0) {
    return null;
  }

  const input = [];
  const output = [];
  let lastSide = null;
  for (const clause of lower.split(/\s*(?:\band\b|,|;|\bbut\b|\bwhile\b)\s*/)) {
    if (!clause.trim()) continue;
    const langs = matchedLanguages(clause);
    let side = languageSideOf(clause) || lastSide || (langs.length ? "output" : null);
    if (!side) continue;
    (side === "input" ? input : output).push(...langs);
    if (langs.length || languageSideOf(clause)) lastSide = side;
  }

  const dedupe = (list) => {
    const seen = new Set();
    return list.filter((l) => (seen.has(l.code) ? false : seen.add(l.code)));
  };
  const inLangs = dedupe(input);
  const outLangs = dedupe(output);
  if (inLangs.length === 0 && outLangs.length === 0) return null;

  // "only"/"just"/"don't switch" locks the set; switching is off unless the user
  // explicitly allows it ("you can switch between ...").
  const canSwitch = /\b(?:can|may|feel free to|allowed to)\s+switch\b/.test(lower);
  const locked = /\bonly\b|\bjust\b|don'?t\s+switch|do not switch|these languages|these two languages/.test(lower);

  const patch = {};
  const parts = [];
  if (outLangs.length) {
    patch.language = outLangs.map((l) => l.code).join(",");
    patch.language_primary = outLangs[0].code;
    patch.language_mode = "explicit";
    patch.language_output = "primary_only";
    patch.language_auto_switch = canSwitch && !locked;
    parts.push(`reply in ${outLangs.map((l) => l.label).join(" + ")}`);
  }
  if (inLangs.length) {
    patch.input_languages = inLangs.map((l) => l.code).join(",");
    patch.input_language_primary = inLangs[0].code;
    parts.push(`understand ${inLangs.map((l) => l.label).join(" + ")}`);
  }
  return { patch, summary: parts.join("; ") };
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

function needsVoiceChoice(lower) {
  return /\b(?:change|switch|set|choose|pick|select|use|make)\b[^.]*\b(?:your\s+|the\s+|my\s+)?voice\b/.test(lower)
    || /\b(?:different|another|new)\s+voice\b/.test(lower)
    || /\bvoice\b[^.]*\b(?:different|another|new)\b/.test(lower);
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
