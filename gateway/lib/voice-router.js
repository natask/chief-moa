"use strict";

const {
  normalizeSpeech,
  isStopLike,
  wantsMultipleAgents,
  shouldRunAgentFromVoice,
  explicitAgentPromptFrom,
  parseProfileControlIntent,
  looksLikeLanguageControl,
} = require("./voice-intent");

const ACTION_TYPES = Object.freeze({
  STOP_SPEECH: "stop_speech",
  CANCEL_RUN: "cancel_run",
  SET_PROFILE: "set_profile",
  QUERY_PROFILE: "query_profile",
  SAMPLE_VOICES: "sample_voices",
  CLARIFY_VOICE: "clarify_voice",
  DISPATCH_AGENT: "dispatch_agent",
  CHAT: "chat",
});

const PROFILE_ACTION_TYPES = new Set([
  ACTION_TYPES.SET_PROFILE,
  ACTION_TYPES.QUERY_PROFILE,
  ACTION_TYPES.SAMPLE_VOICES,
  ACTION_TYPES.CLARIFY_VOICE,
]);

async function routeVoiceTurn(body, transcript, opts = {}) {
  const forced = forcedIntentFromBody(body);
  if (forced) {
    return { actions: forcedActions(forced, transcript), source: "heuristic" };
  }

  const useLlm = opts.useLlm === undefined
    ? process.env.VOICE_ROUTER_LLM === "1"
    : Boolean(opts.useLlm);
  if (useLlm && typeof opts.callModel === "function") {
    try {
      // Bound the classification round-trip. A slow model call must not stack
      // seconds of latency before the turn is answered; if it overruns, fall
      // back to the deterministic heuristic immediately.
      const raw = await withTimeout(
        opts.callModel(routerMessages(transcript)),
        routerLlmTimeoutMs(opts),
      );
      const actions = validActionsFromModel(raw);
      if (actions.length > 0) {
        return { actions, source: "llm" };
      }
    } catch (_error) {
      // Fall through to the faithful heuristic safety net (includes timeout).
    }
  }

  return { actions: heuristicActions(transcript), source: "heuristic" };
}

function routerLlmTimeoutMs(opts) {
  const fromOpts = Number(opts?.llmTimeoutMs);
  if (Number.isFinite(fromOpts) && fromOpts > 0) {
    return fromOpts;
  }
  const fromEnv = Number(process.env.VOICE_ROUTER_LLM_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return 800;
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`voice router model call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function classificationFromActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  if (list.some((action) => action?.type === ACTION_TYPES.STOP_SPEECH)) {
    return "control";
  }
  if (list.some((action) => action?.type === ACTION_TYPES.CANCEL_RUN)) {
    return "control";
  }
  if (list.some((action) => PROFILE_ACTION_TYPES.has(action?.type))) {
    return "profile_control";
  }
  const dispatchCount = list.filter((action) => action?.type === ACTION_TYPES.DISPATCH_AGENT).length;
  if (dispatchCount >= 2) {
    return "multi_agent";
  }
  if (dispatchCount === 1) {
    return "agent_run";
  }
  return "chat";
}

function heuristicActions(transcript) {
  // Failure to obtain a model routing decision must be safe and inert. The
  // normal chat reasoner still sees the original transcript and may invoke its
  // registered tools; this router never guesses an intent from words.
  void transcript;
  return [{ type: ACTION_TYPES.CHAT }];
}

function forcedIntentFromBody(body) {
  const b = body || {};
  const forced = String(b.forced_action || b.client?.intent_hint || b.intent_hint || "")
    .toLowerCase()
    .trim();
  return [
    "control",
    "profile_control",
    "multi_agent",
    "agent_run",
    "chat",
  ].includes(forced) ? forced : "";
}

function forcedActions(forced, transcript) {
  if (forced === "control") {
    return [{ type: ACTION_TYPES.STOP_SPEECH }];
  }
  if (forced === "profile_control") {
    const profileIntent = parseProfileControlIntent(transcript);
    return [profileIntent
      ? actionFromProfileIntent(profileIntent)
      : { type: ACTION_TYPES.QUERY_PROFILE, subject: "profile", scope: "global" }];
  }
  if (forced === "multi_agent") {
    return dispatchAgentActions(transcript, 2);
  }
  if (forced === "agent_run") {
    return [{
      type: ACTION_TYPES.DISPATCH_AGENT,
      prompt: explicitAgentPromptFrom(transcript) || String(transcript || "").trim(),
      harness: null,
    }];
  }
  return [{ type: ACTION_TYPES.CHAT }];
}

function actionFromProfileIntent(intent) {
  const scope = normalizeScope(intent.scope);
  if (intent.action === "update") {
    return {
      type: ACTION_TYPES.SET_PROFILE,
      patch: isPlainObject(intent.patch) ? intent.patch : {},
      scope,
      summary: String(intent.summary || "profile"),
    };
  }
  if (intent.action === "summary") {
    return {
      type: ACTION_TYPES.QUERY_PROFILE,
      subject: String(intent.subject || "profile"),
      scope,
    };
  }
  if (intent.action === "sample") {
    return {
      type: ACTION_TYPES.SAMPLE_VOICES,
      sample_text: String(intent.sample_text || ""),
      scope,
    };
  }
  return {
    type: ACTION_TYPES.CLARIFY_VOICE,
    scope,
  };
}

function dispatchAgentActions(transcript, count) {
  return Array.from({ length: count }, () => ({
    type: ACTION_TYPES.DISPATCH_AGENT,
    prompt: String(transcript || "").trim(),
    harness: null,
  }));
}

function cancelRunTargetFrom(transcript) {
  const lower = normalizeSpeech(transcript);
  if (!lower) {
    return "";
  }
  if (/\b(?:stop|cancel|kill)\s+(?:everything|all|all runs|all agents|every agent|the agents)\b/.test(lower)) {
    return "all";
  }
  if (/\b(?:cancel|stop|kill)\s+(?:the\s+)?(?:run|agent|task|job)\b/.test(lower)) {
    return "current";
  }
  return "";
}

function routerMessages(transcript) {
  return [
    {
      role: "system",
      content: [
        "Route one spoken Moa turn into ordered JSON actions.",
        "Return only a JSON object: {\"actions\":[...]}",
        "Allowed action types:",
        "- stop_speech: silence current playback only; do not cancel runs.",
        "- cancel_run: explicit run cancellation only, target current or all.",
        "- set_profile: profile write with patch, scope, and summary.",
        "- query_profile: read-only profile query with subject and scope.",
        "- sample_voices: voice sampler with sample_text and scope.",
        "- clarify_voice: ask which voice/scope is intended.",
        "- dispatch_agent: launch agent work; repeat for multi-agent or stacked agents.",
        "- chat: plain spoken answer.",
        "Bare stop, shut up, or be quiet means stop_speech. Only explicit phrases like cancel the run, stop the run, stop everything, or kill the agent mean cancel_run.",
      ].join("\n"),
    },
    {
      role: "user",
      content: String(transcript || ""),
    },
  ];
}

function validActionsFromModel(raw) {
  const parsed = parseFirstJsonObject(raw);
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  return actions.map(normalizeModelAction).filter(Boolean);
}

function parseFirstJsonObject(raw) {
  const text = String(raw || "").trim();
  const start = text.indexOf("{");
  if (start < 0) {
    throw new Error("voice router model response did not include a JSON object");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(text.slice(start, index + 1));
      }
    }
  }
  throw new Error("voice router model response had unbalanced JSON");
}

function normalizeModelAction(action) {
  if (!isPlainObject(action)) {
    return null;
  }
  if (!Object.values(ACTION_TYPES).includes(action.type)) {
    return null;
  }
  if (action.type === ACTION_TYPES.STOP_SPEECH) {
    return { type: ACTION_TYPES.STOP_SPEECH };
  }
  if (action.type === ACTION_TYPES.CANCEL_RUN) {
    return {
      type: ACTION_TYPES.CANCEL_RUN,
      target: action.target === "all" ? "all" : "current",
    };
  }
  if (action.type === ACTION_TYPES.SET_PROFILE) {
    return {
      type: ACTION_TYPES.SET_PROFILE,
      patch: isPlainObject(action.patch) ? action.patch : {},
      scope: normalizeScope(action.scope),
      summary: String(action.summary || "profile"),
    };
  }
  if (action.type === ACTION_TYPES.QUERY_PROFILE) {
    return {
      type: ACTION_TYPES.QUERY_PROFILE,
      subject: String(action.subject || "profile"),
      scope: normalizeScope(action.scope),
    };
  }
  if (action.type === ACTION_TYPES.SAMPLE_VOICES) {
    return {
      type: ACTION_TYPES.SAMPLE_VOICES,
      sample_text: String(action.sample_text || ""),
      scope: normalizeScope(action.scope),
    };
  }
  if (action.type === ACTION_TYPES.CLARIFY_VOICE) {
    return {
      type: ACTION_TYPES.CLARIFY_VOICE,
      scope: normalizeScope(action.scope),
    };
  }
  if (action.type === ACTION_TYPES.DISPATCH_AGENT) {
    if (typeof action.prompt !== "string") {
      return null;
    }
    return {
      type: ACTION_TYPES.DISPATCH_AGENT,
      prompt: action.prompt,
      harness: typeof action.harness === "string" ? action.harness : null,
    };
  }
  if (typeof action.text === "string") {
    return { type: ACTION_TYPES.CHAT, text: action.text };
  }
  return { type: ACTION_TYPES.CHAT };
}

function normalizeScope(scope) {
  return scope === "device" ? "device" : "global";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  routeVoiceTurn,
  classificationFromActions,
  ACTION_TYPES,
};
