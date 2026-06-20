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
        language_primary: language.code,
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
  const languages = [
    { label: "Amharic", code: "am-ET", keys: ["amharic"] },
    { label: "English", code: "en-US", keys: ["english", "back to english"] },
    { label: "Spanish", code: "es-ES", keys: ["spanish"] },
    { label: "French", code: "fr-FR", keys: ["french"] },
    { label: "Arabic", code: "ar", keys: ["arabic"] },
  ];
  const isCommand = lower.startsWith("speak ")
    || lower.startsWith("switch to ")
    || lower.startsWith("answer in ")
    || lower.startsWith("respond in ")
    || lower.includes(" switch to ")
    || lower.includes(" speak ");
  if (!isCommand) {
    return null;
  }
  return languages.find((language) => language.keys.some((key) => lower.includes(key))) || null;
}

function voiceUpdateFrom(text) {
  const match = String(text || "").match(/\b(?:switch|change|set|use)\s+(?:your\s+)?voice\s+(?:to|as)?\s*([a-z]+)\b/i);
  if (!match?.[1]) {
    return "";
  }
  const value = match[1].trim();
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
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
