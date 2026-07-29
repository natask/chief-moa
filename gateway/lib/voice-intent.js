"use strict";

// Voice-turn intent classification. Pure functions over a transcript (and the
// request body's forced/hint fields). Extracted from server.js so the brittle
// keyword/regex logic can be unit-tested in isolation — this is the part most
// likely to drift as new phrasings appear.
//
// classifyVoiceTurn returns one of:
// "control" | "profile_control" | "multi_agent" | "agent_run" | "chat".

const {
  canonicalVoice,
  canonicalPersona,
  LANGUAGE_OPTIONS,
  mentionsSupportedLanguage,
  normalizeSpeechKey,
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

const OPERATIONAL_WORK_CONTEXT_PATTERNS = [
  /\bhome machine\b/,
  /\bin (?:the|this|my) repo\b/,
  /\bin (?:the|this|my) app\b/,
  /\boperational systems?\b/,
  /\bthings operating\b/,
  /\bprojects? i have ongoing\b/,
  /\ball (?:the )?(?:projects|products)\b/,
  /\bwhat am i working on\b/,
  /\bforward progress\b/,
  /\bchrome extension\b/,
  /\bandroid app\b/,
  /\bmobile gateway\b/,
  /\bmoa gateway\b/,
];

function hasOperationalWorkContext(text) {
  const lower = normalizeSpeech(text);
  return OPERATIONAL_WORK_CONTEXT_PATTERNS.some((pattern) => pattern.test(lower));
}

// Playlist mutations are phone actions when they name the user's media, not
// implementation work. Without this exception, the generic "add/create"
// prefixes below divert natural commands such as "add this video to Focus"
// into a workstation agent run before the model can propose `phone_action`.
function isDirectPhonePlaylistAction(text) {
  const lower = normalizeSpeech(text);
  if (!/^(?:add|create|delete|remove|rename)\b/.test(lower) || !/\bplaylist\b/.test(lower)) {
    return false;
  }
  if (hasOperationalWorkContext(lower)) {
    return false;
  }
  return !/\b(?:api|code|feature|handler|implementation|interface|support|test|tool|ui)\b/.test(lower);
}

// Heuristic: does this sound like an action to run, not a question to answer?
function shouldRunAgentFromVoice(text) {
  const lower = normalizeSpeech(text);
  if (!lower) return false;
  if (isOperationalStatusQuestion(text)) return false;
  if (isDirectPhonePlaylistAction(text)) return false;
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
    || hasOperationalWorkContext(lower);
}

function isOperationalStatusQuestion(text) {
  const lower = normalizeSpeech(text);
  if (!lower) return false;
  if (lower === "status" || lower === "status update") return true;
  if (
    lower.includes("what is going on")
    || lower.includes("what s going on")
    || lower.includes("whats going on")
    || lower.includes("what is happening")
    || lower.includes("what s happening")
    || lower.includes("whats happening")
  ) {
    return hasOperationalWorkContext(lower);
  }
  return lower.includes("what are you doing")
    || lower.includes("what is running")
    || lower.includes("what s running")
    || lower.includes("whats running")
    || lower.includes("what runs are active")
    || lower.includes("what active runs")
    || lower.includes("show active runs")
    || lower.includes("active run status")
    || lower.includes("active runs status")
    || lower.includes("what am i working on")
    || lower.includes("current status");
}

// The user plainly asked to dispatch agent work in free phrasing ("launch an
// agent to...", "have an agent do...", "spawn agents for..."). This is the
// authorization signal for the MODEL-DRIVEN launch tool: it deliberately stays
// out of classifyVoiceTurn so these turns still reason as chat and the model
// decides the prompt/harness, but the launch tool is unblocked because the
// user's own words asked for an agent.
function wantsAgentDispatch(text) {
  const lower = normalizeSpeech(text);
  if (!lower) return false;
  if (/\b(launch|start|spawn|dispatch|deploy|send|use|have|get|run|kick off|fire off)\b[^.?!]{0,40}\bagents?\b/.test(lower)) {
    return true;
  }
  if (/\bagents?\b[^.?!]{0,20}\b(to|that|which|do|handle|work on|research|figure out)\b/.test(lower)) {
    return true;
  }
  return lower.includes("in the background") || lower.includes("background agent") || lower.includes("delegate");
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
  if (wantsTranscriptEcho(lower)) {
    return { action: "echo_transcript", subject: "transcript", scope };
  }
  // Reversibility by voice. Checked before persona/name/prompt matching so
  // "reset your settings" is an undo, not a persona named "your settings".
  const revert = parseProfileRevertIntent(lower);
  if (revert) {
    return { ...revert, scope };
  }
  const voiceSampleText = voiceSampleTextFrom(raw);
  if (wantsVoiceSampling(lower)) {
    return {
      action: "sample",
      subject: "voice_options",
      summary: "voice sampler",
      sample_text: voiceSampleText,
      scope,
    };
  }
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

  // A KNOWN catalog persona ("become a pirate", "you are now a butler") wins
  // over the name matcher so "you are now a butler" switches persona rather than
  // renaming the assistant to "butler". Free-form personas are handled later, so
  // "you are now Moa" still sets the name.
  const knownPersona = parsePersonaIntent(raw, { knownOnly: true });
  if (knownPersona) {
    return knownPersona;
  }

  const companionRequest = companionRequestFrom(raw);
  if (companionRequest) {
    return {
      action: "companion_create_apply",
      subject: "companion",
      summary: `companion ${companionRequest.role}`,
      companion_request: companionRequest.text,
      companion_role: companionRequest.role,
      scope,
    };
  }

  const assistantName = assistantNameUpdateFrom(raw);
  if (assistantName) {
    return {
      action: "update",
      patch: { assistant_name: assistantName },
      summary: "assistant name",
      // English literal for legacy callers; the gateway localizes to the reply
      // language via confirmation_key when it renders the spoken confirmation.
      confirmation: `Yes. I am now ${assistantName}.`,
      confirmation_key: "assistantNameSet",
      confirmation_params: { name: assistantName },
      scope,
    };
  }

  const language = languageUpdateFrom(raw, lower);
  if (language) {
    return { ...language, scope };
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

  const persona = parsePersonaIntent(raw);
  if (persona) {
    return persona;
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

// Does a parsed profile-control intent WRITE durable profile state? Identity,
// persona, voice, language, companion, and revert/reset all mutate the stored
// profile and therefore must be MODEL-ROUTED (the model decides and calls the
// settings tool), never applied from a matchtext parse alone. STT garbage
// repeatedly matched the deterministic mutation parsers and became identity
// writes on the live profile ("assistant_name" set to recognition noise), so a
// deterministic parse can no longer apply these on its own.
//
// The read-only intents (summary, echo_transcript, sample, clarify, reject)
// change nothing and stay on the deterministic fast path. EVERY write is
// model-routed, including revert/reset — "reset your settings" is not cleanly
// reversible and a misheard "undo" rewrites state, so it deserves model
// interpretation like any other mutation (user decision, 2026-07-14). On the
// model path even "shut up" is the model's call — it receives the utterance
// and answers with the stay_silent tool, not words. The only deterministic
// behaviors left are fail-safes on the model-less HTTP path (silent stop, and
// fail-closed mutation blocking). Do not add new deterministic interpretation
// pathways without a written justification in the OpenSpec.
function profileControlIntentMutates(intent) {
  if (!intent || typeof intent !== "object") {
    return false;
  }
  const action = String(intent.action || "");
  if (action === "revert" || action === "companion_create_apply") {
    return true;
  }
  if (action !== "update") {
    return false;
  }
  const patch = intent.patch && typeof intent.patch === "object" ? intent.patch : {};
  return Object.keys(patch).length > 0;
}

// "undo that" / "undo the last change" / "revert" -> restore the version before
// the last change. "reset your settings" / "start over" / "back to default" ->
// restore the gateway defaults. Returns { action: "revert", mode } or null.
// Kept narrow so ordinary speech ("go back to the previous page") is not swept
// in: an undo verb must sit next to a change/settings word.
function parseProfileRevertIntent(lower) {
  const mentionsSettings = /\b(?:settings?|profile|configuration|config|preferences?|customi[sz]ations?|voice|persona|language)\b/.test(lower);
  const mentionsDefault = /\b(?:default|defaults|factory)\b/.test(lower);
  const isReset = /\b(?:reset|restore|start over|start again)\b/.test(lower) || mentionsDefault;
  if (isReset && (mentionsSettings || mentionsDefault || /\b(?:everything|all of it|yourself)\b/.test(lower))) {
    return { action: "revert", mode: "reset", summary: "reset to defaults" };
  }
  // Strong undo signals: an explicit undo/revert verb, or "take/change it back".
  // These do not need a settings word — "undo that" after a setting change is
  // unambiguous.
  const strongUndo = /\b(?:undo|revert|roll\s*back)\b/.test(lower)
    || /\b(?:take|change|put|set|switch)\s+(?:that|it)\s+back\b/.test(lower);
  if (strongUndo) {
    return { action: "revert", mode: "previous", summary: "undo last change" };
  }
  // Weak undo signals ("go back", "previous"): require a settings word so page
  // navigation ("go back to the previous page") is not swept in.
  const weakUndo = /\b(?:go|switch)\s+back\b/.test(lower) || /\bprevious\b/.test(lower);
  if (weakUndo && mentionsSettings) {
    return { action: "revert", mode: "previous", summary: "undo last change" };
  }
  return null;
}

// "what did you hear / what did I say / repeat what I said exactly" — the user
// wants the exact final transcript of their PREVIOUS turn echoed back verbatim,
// not a paraphrase. Detected here so it routes as an instant control action
// against stored turns rather than through a model call.
function wantsTranscriptEcho(lower) {
  if (/\b(?:what|which)\s+(?:did|do)\s+(?:you|u)\s+(?:hear|catch|get|understand)\b/.test(lower)) {
    return true;
  }
  if (/\bwhat\s+did\s+i\s+(?:say|just say)\b/.test(lower)) {
    return true;
  }
  if (/\b(?:repeat|say|read|show|tell me)\b[^.]*\b(?:what|exactly what)\s+i\s+(?:said|just said)\b/.test(lower)) {
    return true;
  }
  if (/\b(?:repeat|read)\s+(?:that|it)\s+back\b/.test(lower)) {
    return true;
  }
  if (/\b(?:exact|exactly)\s+(?:transcript|words|what)\b/.test(lower)) {
    return true;
  }
  return false;
}

// "become X" / "act as X" / "act like X" / "you are now X" / "pretend to be X" /
// "roleplay as X" -> switch persona. A known persona from the catalog carries a
// vetted prompt (and optional voice); an unknown free-form X is stored as a
// persona prompt ("You are X."), sanitized/capped downstream. Returns an update
// intent or null.
const PERSONA_PATTERNS = [
  /\bbecome\s+(.+)$/i,
  /\bact\s+(?:as|like)\s+(?:if you(?:'re| are)\s+)?(.+)$/i,
  /\bpretend\s+(?:to\s+be|you(?:'re| are))\s+(.+)$/i,
  /\brole\s*play\s+(?:as\s+)?(.+)$/i,
  /\byou\s+are\s+now\s+(.+)$/i,
  /\bbe\s+(?:a|an)\s+(.+)$/i,
];

function parsePersonaIntent(text, options = {}) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }
  const knownOnly = options.knownOnly === true;
  const scope = profileScopeFromText(normalizeSpeech(raw));
  for (const pattern of PERSONA_PATTERNS) {
    const match = raw.match(pattern);
    const subject = personaSubjectFrom(match?.[1] || "");
    if (!subject) {
      continue;
    }
    const known = canonicalPersona(subject);
    if (knownOnly && !known) {
      continue;
    }
    if (known) {
      const patch = { system_prompt: known.prompt };
      if (known.voice) {
        patch.voice = known.voice;
      }
      if (known.language) {
        patch.language = known.language;
        patch.language_primary = known.language.split(",")[0].trim();
        patch.language_mode = "explicit";
        patch.language_output = "primary_only";
        patch.language_auto_switch = false;
      }
      return {
        action: "update",
        patch,
        summary: `persona ${known.label}`,
        persona: known.id,
        confirmation: `Done. I am now your ${known.label.toLowerCase()}.`,
        confirmation_key: "personaKnownSet",
        confirmation_params: { label: known.label.toLowerCase() },
        scope,
      };
    }
    // Free-form persona: store as a persona prompt. Sanitized/capped in
    // agent-profile.js, which strips any rule-override attempt.
    const label = subject.replace(/^(?:a|an)\s+/i, "").trim();
    return {
      action: "update",
      patch: { system_prompt: `You are ${label}. Stay in character. Keep replies terse.` },
      summary: `persona ${label}`,
      persona: "custom",
      confirmation: `Done. I am now ${label}.`,
      confirmation_key: "personaCustomSet",
      confirmation_params: { label },
      scope,
    };
  }
  return null;
}

function personaSubjectFrom(value) {
  const candidate = String(value || "")
    .trim()
    .replace(/\s+(?:from\s+now\s+on|going\s+forward|please|now|okay|ok)$/i, "")
    .replace(/^["'`]+|["'`.!,?;:]+$/g, "")
    .replace(/\s+(?:on|for)\s+(?:this|my|all|every)\s+(?:device|devices|phone|browser|surface)s?\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!candidate) {
    return "";
  }
  // Reject pure language/voice/name changes so those keep their own routes.
  if (/\bvoice\b/i.test(candidate)) {
    return "";
  }
  if (candidate.length > 120 || candidate.split(/\s+/).length > 16) {
    return "";
  }
  if (!/[A-Za-z]/.test(candidate)) {
    return "";
  }
  return candidate;
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
// parser, so "respond in Amharic" is language and "respond in text" is modality.
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

function companionRequestFrom(text) {
  const raw = String(text || "").trim();
  const patterns = [
    /\b(?:i\s+want|i'd\s+like|i\s+would\s+like)\s+you\s+to\s+(?:be|become|act\s+as)\s+(.+)$/i,
    /\b(?:make|turn)\s+(?:yourself|you)\s+(?:into\s+)?(?:my\s+|a\s+|an\s+)?(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const role = normalizeCompanionRole(match?.[1] || "");
    if (role) {
      return { text: raw, role };
    }
  }
  return null;
}

function normalizeCompanionRole(value) {
  const role = String(value || "")
    .trim()
    .replace(/^["'`]+|["'`.!,?;:]+$/g, "")
    .replace(/\s+(?:for me|from now on|going forward|please)$/i, "")
    .replace(/\s+(?:who|that|because|so)\s+.+$/i, "")
    .replace(/^(?:a|an|my)\s+/i, "")
    .replace(/\s+/g, " ");
  if (!role || role.length > 120 || role.split(/\s+/).length > 8) {
    return "";
  }
  const lower = normalizeSpeech(role);
  if (!lower || /^(?:you|yourself|me|it|that|this|called|named)$/.test(lower)) {
    return "";
  }
  if (!/[a-z0-9]/i.test(role)) {
    return "";
  }
  return role;
}

// Language switching is model-owned. The deterministic transcript matchers that
// used to live here (matchedLanguages, languageSideOf, parseLanguageIntent, and
// the unsupported-language rejector) were removed: they sniffed the raw utterance
// for language names and mutated language state without a tool call. The model now
// decides language changes and calls update_agent_profile / set_languages, whose
// arguments are still normalized by profile-options (normalizeLanguageList,
// native-script keys). Read-only language QUERIES stay in parseProfileControlIntent
// as summaries.

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

function wantsVoiceSampling(lower) {
  if (!/\bvoices?\b/.test(lower)) {
    return false;
  }
  if (/\b(?:sample|samples|sampling|test|try|preview|demo|demonstrate|audition|hear)\b[^.]*\bvoices?\b/.test(lower)) {
    return true;
  }
  if (/\b(?:go|run|walk|cycle)\s+through\b[^.]*\bvoices?\b/.test(lower)) {
    return true;
  }
  if (/\b(?:all|every|each)\s+(?:of\s+the\s+)?voices?\b/.test(lower)
    && /\b(?:say|speak|read|play|sample|test|try|preview|demo|go|run|walk|cycle|change|switch)\b/.test(lower)) {
    return true;
  }
  if (/\b(?:say|speak|read|play)\b[^.]*\b(?:in|with)\s+(?:all|every|each)\s+(?:of\s+the\s+)?voices?\b/.test(lower)) {
    return true;
  }
  if (/\bvoices?\b[^.]*\b(?:one\s+after\s+(?:the\s+)?other|one\s+by\s+one|in\s+order|sequentially)\b/.test(lower)) {
    return true;
  }
  return false;
}

function voiceSampleTextFrom(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }
  const quoted = raw.match(/["'`](.+?)["'`]/);
  if (quoted?.[1]) {
    return normalizeVoiceSampleText(quoted[1]);
  }
  const sayMatch = raw.match(/\b(?:say|read|speak)\s+(.+?)\s+(?:in|with)\s+(?:all|every|each)\s+(?:of\s+the\s+)?voices?\b/i);
  if (sayMatch?.[1]) {
    return normalizeVoiceSampleText(sayMatch[1]);
  }
  return "";
}

function normalizeVoiceSampleText(value) {
  const text = String(value || "")
    .trim()
    .replace(/^["'`]+|["'`.!,?;:]+$/g, "")
    .replace(/\s+/g, " ");
  if (!text || /^(?:something|anything|a thing|one thing|some text)$/i.test(text)) {
    return "";
  }
  return text.slice(0, 220);
}

function needsVoiceChoice(lower) {
  return /\b(?:change|switch|set|choose|pick|select|use|make)\b[^.]*\b(?:your\s+|the\s+|my\s+)?voices?\b/.test(lower)
    || /\b(?:different|another|new)\s+voice\b/.test(lower)
    || /\bvoice\b[^.]*\b(?:different|another|new)\b/.test(lower);
}

// Explicit language-control fallback for non-streaming HTTP/profile turns.
// Streaming cascaded turns still let the model use update_agent_profile /
// set_languages, but /v1/voice/turns can run without a model key, so explicit
// "reply in X" / "I only speak X" requests need a deterministic profile patch.
// This is not auto-detection: it only handles user-authored configuration
// requests and still writes through the gateway profile sanitizer.
function languageUpdateFrom(raw, lower) {
  if (!looksLikeLanguageControl(raw)) {
    return null;
  }
  const matched = matchedLanguageMentions(raw);
  if (matched.length === 0) {
    return /\blanguages?\b/.test(lower)
      ? { action: "clarify", subject: "language", summary: "language" }
      : null;
  }

  const codes = matched.map((language) => language.code);
  const labels = matched.map((language) => language.label);
  const list = codes.join(",");
  const labelList = labels.join(" + ");
  const inputCue = /\b(?:understand|understands|understood|listen|listens|hear|hears|heard|recognize|recognise|process|input)\b/.test(lower)
    || /\b(?:i|user)\s+(?:only\s+)?(?:speak|speaks|talk|talks|will speak|will talk|am going to speak|want to speak)\b/.test(lower);
  const replyCue = /\b(?:reply|respond|answer|say)\b/.test(lower)
    || /\byou\s+(?:only\s+)?(?:speak|speaks|talk|talks)\b/.test(lower)
    || (/\b(?:speak|speaks|talk|talks)\b/.test(lower) && !inputCue);
  const patch = {};
  if (inputCue) {
    patch.input_languages = list;
    patch.input_language_primary = codes[0];
  }
  if (replyCue || !inputCue) {
    patch.language = list;
    patch.language_primary = codes[0];
    patch.language_mode = "explicit";
    patch.language_output = "primary_only";
    patch.language_auto_switch = false;
  }

  const summary = [
    patch.input_languages ? `understand ${labelList}` : "",
    patch.language ? `reply in ${labelList}` : "",
  ].filter(Boolean).join(" and ");
  return {
    action: "update",
    patch,
    subject: "language",
    summary: summary || `language ${labelList}`,
  };
}

function matchedLanguageMentions(raw) {
  const rawText = String(raw || "");
  const lowerRaw = rawText.toLowerCase();
  const normalized = normalizeSpeechKey(rawText);
  const padded = ` ${normalized} `;
  const matches = [];
  const seen = new Set();
  const add = (language, index) => {
    if (!language || seen.has(language.code) || index < 0) return;
    seen.add(language.code);
    matches.push({ code: language.code, label: language.label, index });
  };
  const phraseIndex = (value) => {
    const key = normalizeSpeechKey(value);
    if (!key) return -1;
    const idx = padded.indexOf(` ${key} `);
    return idx < 0 ? -1 : idx;
  };
  const codeIndex = (code) => {
    if (!code) return -1;
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(code.toLowerCase())}($|[^a-z0-9])`, "i");
    const match = lowerRaw.match(pattern);
    return match ? match.index : -1;
  };

  for (const language of LANGUAGE_OPTIONS) {
    const matchedCodeIndex = codeIndex(language.code);
    const labelIndex = phraseIndex(language.label);
    const keyIndexes = (language.keys || []).map(phraseIndex).filter((index) => index >= 0);
    const nativeIndexes = (language.native_names || [])
      .map((native) => String(native || "").trim().toLowerCase())
      .filter(Boolean)
      .map((native) => lowerRaw.indexOf(native))
      .filter((index) => index >= 0);
    const indexes = [matchedCodeIndex, labelIndex, ...keyIndexes, ...nativeIndexes].filter((index) => index >= 0);
    if (indexes.length > 0) {
      add(language, Math.min(...indexes));
    }
  }

  return matches.sort((a, b) => a.index - b.index).map(({ index, ...language }) => language);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Routing guard for language-shaped turns that did not become an explicit
// profile-control patch above. It keeps vague language requests conversational
// instead of letting the agent-work heuristic ("change ...") launch a harness.
function looksLikeLanguageControl(transcript) {
  const lower = normalizeSpeech(transcript);
  if (!lower) {
    return false;
  }
  const verb = /\b(?:speak|speaking|talk|understand|understands|understood|listen|hear|heard|recognize|recognise|process|reply|respond|answer|say|switch|change|set|use|make|adjust)\b/.test(lower);
  if (!verb) {
    return false;
  }
  return /\blanguages?\b/.test(lower) || mentionsSupportedLanguage(transcript);
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
  // A language-control request stays conversational (model owns the change),
  // never a harness launch.
  if (!forced && looksLikeLanguageControl(transcript)) {
    return "chat";
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
  wantsAgentDispatch,
  hasOperationalWorkContext,
  isOperationalStatusQuestion,
  shouldRunAgentFromVoice,
  explicitAgentPromptFrom,
  parseProfileControlIntent,
  profileControlIntentMutates,
  parseProfileRevertIntent,
  parsePersonaIntent,
  looksLikeLanguageControl,
  classifyVoiceTurn,
};
