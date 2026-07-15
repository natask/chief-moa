"use strict";

const { createExaSearchTool } = require("./exa-search");

const SEARCH_ROUTES = Object.freeze({
  CHAT_ANSWER: "chat_answer",
  BROWSER_TURN: "browser_turn",
  BROWSER_EVIDENCE: "browser_evidence",
  CASCADED_REASONING: "cascaded_reasoning",
  BROKER_DIRECT_ANSWER: "broker_direct_answer",
  BROKER_RESEARCH: "broker_research",
  CONTEXT_PREFLIGHT: "context_preflight",
  TRANSCRIPTION: "transcription",
  TTS: "tts",
  PROACTIVE: "privacy_first_proactive",
  PROFILE_CONFIRMATION: "profile_confirmation",
  THREAD_SUMMARY: "thread_summary",
  ROUTER: "router",
  UNCLASSIFIED: "unclassified",
});

const SEARCH_ENABLED_ROUTES = new Set([
  SEARCH_ROUTES.CHAT_ANSWER,
  SEARCH_ROUTES.BROWSER_TURN,
  SEARCH_ROUTES.BROWSER_EVIDENCE,
  SEARCH_ROUTES.CASCADED_REASONING,
  SEARCH_ROUTES.BROKER_DIRECT_ANSWER,
  SEARCH_ROUTES.BROKER_RESEARCH,
]);

function resolveReasoningProvider(profile, defaultProvider = "openai-compatible") {
  const requested = normalizeProvider(profile?.reasoning_provider);
  if (requested === "vertex" || requested === "openai-compatible") return requested;
  const fallback = normalizeProvider(defaultProvider);
  return fallback === "vertex" ? "vertex" : "openai-compatible";
}

function selectReasoningSearch(options = {}) {
  const env = options.env || process.env;
  const route = String(options.route || SEARCH_ROUTES.UNCLASSIFIED);
  const provider = resolveReasoningProvider(options.profile, options.defaultProvider);
  if (!SEARCH_ENABLED_ROUTES.has(route)) {
    return Object.freeze({ provider, route, status: "excluded", nativeTool: null, functionTool: null });
  }

  if (provider === "vertex" && String(env.MODEL_NATIVE_WEB_SEARCH || "1").trim() !== "0") {
    return Object.freeze({
      provider,
      route,
      status: "native",
      nativeTool: Object.freeze({ googleSearch: Object.freeze({}) }),
      functionTool: null,
    });
  }

  const createFallbackTool = options.createFallbackTool || createExaSearchTool;
  const functionTool = createFallbackTool({ env, ...(options.exaOptions || {}) });
  if (functionTool) {
    return Object.freeze({ provider, route, status: "exa_fallback", nativeTool: null, functionTool });
  }
  return Object.freeze({ provider, route, status: "unavailable", nativeTool: null, functionTool: null });
}

function withReasoningSearchTools(toolDefs, plan) {
  const tools = Array.isArray(toolDefs) ? toolDefs.slice() : [];
  if (!plan?.functionTool || tools.some((tool) => tool?.name === plan.functionTool.name)) return tools;
  tools.push(plan.functionTool);
  return tools;
}

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, "-");
}

module.exports = {
  SEARCH_ROUTES,
  resolveReasoningProvider,
  selectReasoningSearch,
  withReasoningSearchTools,
};
