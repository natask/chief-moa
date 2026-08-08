"use strict";

const { createVoiceProviderRegistry, voiceProviderNames } = require("./voice-providers");

const VERSION = "moa.voice-provider-catalog.v1";
const SELECTION_FIELDS = new Set([
  "model", "voice_provider", "stt_provider", "reasoning_provider", "tts_provider",
]);

class ProviderSelectionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProviderSelectionError";
    this.code = details.code || "provider_selection_unavailable";
    this.statusCode = 409;
    this.details = details;
  }
}

function createVoiceProviderCatalog(options = {}) {
  const env = options.env || process.env;
  const profile = options.profile || {};
  const registry = createVoiceProviderRegistry({ env });
  const indexed = indexRegistry(registry.providers);
  const ttsId = cascadedTtsId(profile, env, indexed);
  const choices = [
    nativeChoice("loopback", "Loopback transport QA", indexed, "local-test-tone"),
    nativeChoice("openai-realtime", "ChatGPT / OpenAI Realtime", indexed, env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1"),
    nativeChoice("xai-voice", "Grok Voice", indexed, env.XAI_REALTIME_MODEL || "grok-voice-latest"),
    nativeChoice("gemini-live", "Gemini Live", indexed, env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview"),
    nativeChoice("vertex-live", "Vertex Live", indexed, env.VERTEX_LIVE_MODEL || "gemini-live-2.5-flash-native-audio"),
    cascadedChoice("cascaded-openai", "OpenAI reasoning", "openai-compatible", ttsId, indexed,
      reasoningStatus("openai-compatible", env), modelIds(env, "openai-compatible")),
    cascadedChoice("cascaded-vertex", "Gemini on Vertex reasoning", "vertex", ttsId, indexed,
      reasoningStatus("vertex", env), modelIds(env, "vertex")),
    cascadedChoice("cascaded-claude", "Claude reasoning", "anthropic", ttsId, indexed,
      reasoningStatus("anthropic", env), modelIds(env, "anthropic"),
      "Claude is a text reasoning stage only. The gateway has no production Anthropic reasoner adapter yet; no duplex Claude audio API is represented."),
  ].map(finalizeChoice);
  return {
    version: VERSION,
    credentials_owner: "gateway",
    selection_scope: "profile_effective",
    choices,
    active_selection: { ...identifySelection(profile, choices, env), scope: "profile_effective" },
  };
}

function cascadedTtsId(profile, env, indexed) {
  const profileStt = normalized(profile?.stt_provider) || normalized(profile?.voice_provider);
  const candidates = [];
  const add = (value) => {
    const id = normalized(value);
    // Catalog cascaded choices promise a gateway STT -> reasoner -> hosted-TTS
    // turn. Local Android TTS and `none` are valid lower-tier runtime settings,
    // but selecting either here would silently skip the middle/reply pipeline.
    if (id && !["android-tts", "none"].includes(id) && indexed.tts.has(id) && !candidates.includes(id)) {
      candidates.push(id);
    }
  };
  // A native-live bundle stores its provider id in every stage field. Never
  // reuse that id as the TTS leg of a cascaded choice: it is not a modular TTS
  // adapter and doing so makes switching back from native voice impossible.
  if (profileStt === "chirp") add(profile?.tts_provider);
  add(env.VOICE_CASCADED_TTS_PROVIDER);
  add(voiceProviderNames(env).tts);
  add("gemini-tts");
  add("cloud-tts");
  const configured = candidates.find((id) => indexed.tts.get(id)?.configured);
  return configured || candidates[0] || "none";
}

function resolveProviderSelection(input, options = {}) {
  const currentProfile = options.profile || {};
  const catalog = createVoiceProviderCatalog({ env: options.env, profile: currentProfile });
  const choiceId = normalized(input?.choice_id || input?.choiceId || "");
  const choice = catalog.choices.find((entry) => entry.id === choiceId);
  if (!choice) {
    throw new ProviderSelectionError(`unknown provider choice: ${choiceId || "(empty)"}`, {
      code: "unknown_provider_choice", choice_id: choiceId,
    });
  }
  if (!choice.available || !choice.configured) {
    throw new ProviderSelectionError(`${choice.label} is ${choice.status}`, {
      choice_id: choice.id, status: choice.status, issues: choice.issues,
    });
  }
  const requestedModel = String(input?.model_id || input?.modelId || "").trim();
  const modelId = requestedModel || choice.models.find((model) => model.default)?.id || choice.models[0]?.id || "";
  if (requestedModel && !choice.models.some((model) => model.id === requestedModel)) {
    throw new ProviderSelectionError(`model is not in the configured catalog for ${choice.id}`, {
      code: "unknown_provider_model", choice_id: choice.id, model_id: requestedModel,
    });
  }
  return { catalog, choice, patch: selectionPatch(choice, modelId, currentProfile) };
}

function validateProfileProviderPatch(currentProfile, patch, options = {}) {
  if (!patch || !Object.keys(patch).some((field) => SELECTION_FIELDS.has(field))) return null;
  const candidate = { ...(currentProfile || {}), ...patch };
  const catalog = createVoiceProviderCatalog({ env: options.env, profile: candidate });
  const changesVoiceBundle = ["voice_provider", "stt_provider", "tts_provider"]
    .some((field) => Object.prototype.hasOwnProperty.call(patch, field));
  if (!changesVoiceBundle && Object.prototype.hasOwnProperty.call(patch, "reasoning_provider")) {
    const reasonerId = normalized(candidate.reasoning_provider);
    if (reasonerId === "gateway" || reasonerId === "loopback") return { reasoning_provider: reasonerId };
    const reasoner = reasoningStatus(reasonerId, options.env || process.env);
    if (!reasoner.adapter_available || !reasoner.configured) {
      throw new ProviderSelectionError(`${reasonerId} reasoning is unavailable`, {
        choice_id: `cascaded-${reasonerId}`, status: reasoner.adapter_available ? "not_configured" : "unavailable",
        issues: [reasoner.reason || `${reasonerId} reasoning is not configured`],
      });
    }
    return { reasoning_provider: reasonerId };
  }
  if (!changesVoiceBundle) return null;
  const selection = catalog.active_selection;
  const choice = catalog.choices.find((entry) => entry.id === selection.choice_id);
  if (!choice) {
    throw new ProviderSelectionError("profile does not resolve to a supported provider bundle", {
      code: "unsupported_provider_bundle", selection,
    });
  }
  if (!choice.available || !choice.configured) {
    throw new ProviderSelectionError(`${choice.label} is ${choice.status}`, {
      choice_id: choice.id, status: choice.status, issues: choice.issues,
    });
  }
  if (patch.model && choice.models.length > 0 && !choice.models.some((model) => model.id === candidate.model)) {
    throw new ProviderSelectionError(`model is not in the configured catalog for ${choice.id}`, {
      code: "unknown_provider_model", choice_id: choice.id, model_id: candidate.model,
    });
  }
  return { choice, selection };
}

function voiceProviderEnvForProfile(profile, env = process.env) {
  const voiceId = normalized(profile?.voice_provider);
  const nativeIds = new Set(["openai-realtime", "xai-voice", "gemini-live", "vertex-live", "loopback"]);
  if (nativeIds.has(voiceId)) {
    const selected = { ...env, VOICE_PROVIDER: voiceId, VOICE_STT_PROVIDER: voiceId,
      VOICE_REASONING_PROVIDER: voiceId, VOICE_LLM_PROVIDER: voiceId, VOICE_TTS_PROVIDER: voiceId };
    const model = String(profile?.model || "").trim();
    if (model && voiceId === "openai-realtime") selected.OPENAI_REALTIME_MODEL = model;
    if (model && voiceId === "xai-voice") selected.XAI_REALTIME_MODEL = model;
    if (model && voiceId === "gemini-live") selected.GEMINI_LIVE_MODEL = model;
    if (model && voiceId === "vertex-live") selected.VERTEX_LIVE_MODEL = model;
    return selected;
  }
  const stt = normalized(profile?.stt_provider) || voiceId;
  if (stt === "chirp") {
    return { ...env, VOICE_PROVIDER: "chirp", VOICE_STT_PROVIDER: "chirp",
      VOICE_REASONING_PROVIDER: normalized(profile?.reasoning_provider) || "gateway",
      VOICE_LLM_PROVIDER: normalized(profile?.reasoning_provider) || "gateway",
      VOICE_TTS_PROVIDER: normalized(profile?.tts_provider) || "none" };
  }
  return env;
}

function nativeChoice(id, label, indexed, model) {
  const provider = indexed.native_live.get(id);
  return {
    id, label, runtime_mode: "native_live", stages: { native_live: id },
    configured: Boolean(provider?.configured), adapter_available: Boolean(provider),
    capabilities: provider?.capabilities || {}, models: model ? [{ id: model, default: true }] : [],
    issues: provider ? [] : ["provider adapter is not registered"],
  };
}

function cascadedChoice(id, label, reasonerId, ttsId, indexed, reasoner, models, limitation = "") {
  const stt = indexed.stt.get("chirp");
  const tts = indexed.tts.get(ttsId);
  const adapterAvailable = Boolean(stt && tts && reasoner.adapter_available);
  const configured = Boolean(stt?.configured && tts?.configured && reasoner.configured && adapterAvailable);
  const issues = [];
  if (!stt) issues.push("Chirp STT adapter is not registered"); else if (!stt.configured) issues.push("Chirp STT is not configured");
  if (!tts) issues.push(`${ttsId} TTS adapter is not registered`); else if (!tts.configured) issues.push(`${ttsId} TTS is not configured`);
  if (!reasoner.adapter_available) issues.push(reasoner.reason); else if (!reasoner.configured) issues.push(`${reasonerId} reasoning is not configured`);
  return { id, label, runtime_mode: "cascaded", stages: { stt: "chirp", reasoning: reasonerId, tts: ttsId },
    configured, adapter_available: adapterAvailable, capabilities: mergeCapabilities(stt, tts, reasoner), models, issues,
    ...(limitation ? { limitation } : {}) };
}

function reasoningStatus(id, env) {
  if (id === "anthropic") {
    return { configured: Boolean(env.ANTHROPIC_API_KEY), adapter_available: false,
      reason: "Anthropic credential readiness may be detected, but the production voice reasoner adapter is not implemented" };
  }
  if (id === "vertex") {
    const configured = Boolean(env.VERTEX_PROJECT || env.GOOGLE_CLOUD_PROJECT)
      && Boolean(env.VERTEX_ACCESS_TOKEN || env.GCP_ACCESS_TOKEN || env.GOOGLE_APPLICATION_CREDENTIALS || env.VERTEX_EXPRESS_API_KEY || env.VERTEX_API_KEY);
    return { configured, adapter_available: true, capabilities: { streaming_reasoning: true } };
  }
  if (id !== "openai-compatible") {
    return { configured: false, adapter_available: false, reason: `${id} reasoning adapter is not registered` };
  }
  const baseUrl = String(env.MODEL_BASE_URL || "https://api.openai.com/v1");
  const configured = Boolean(env.MODEL_API_KEY || env.OPENAI_API_KEY) || !baseUrl.includes("api.openai.com");
  return { configured, adapter_available: true, capabilities: { streaming_reasoning: true } };
}

function modelIds(env, provider) {
  const values = [];
  const add = (value, isDefault = false) => {
    const id = String(value || "").trim();
    if (id && !values.some((entry) => entry.id === id)) values.push({ id, default: isDefault });
  };
  if (provider === "anthropic") add(env.VOICE_EXPERIMENT_ANTHROPIC_MODEL || env.ANTHROPIC_MODEL || env.CLAUDE_MODEL || "claude-haiku-4-5", true);
  else if (provider === "vertex") add(env.VERTEX_MODEL || (normalized(env.MODEL_PROVIDER) === "vertex" ? env.MODEL_ID : "") || "gemini-3.5-flash", true);
  else add((normalized(env.MODEL_PROVIDER) === "openai-compatible" ? env.MODEL_ID : "") || env.OPENAI_MODEL || "gpt-4o-mini", true);
  for (const value of String(env.MODEL_OPTIONS || env.MODEL_IDS || "").split(/[,;\n]+/)) add(value);
  return values;
}

function identifySelection(profile, choices, env) {
  const voice = normalized(profile?.voice_provider);
  const native = choices.find((entry) => entry.runtime_mode === "native_live" && entry.stages.native_live === voice);
  if (native) return { choice_id: native.id, model_id: native.models[0]?.id || "" };
  let reasoner = normalized(profile?.reasoning_provider);
  if (!reasoner || reasoner === "gateway") reasoner = normalized(env.MODEL_PROVIDER) || "openai-compatible";
  const choice = choices.find((entry) => entry.runtime_mode === "cascaded" && entry.stages.reasoning === reasoner);
  return { choice_id: choice?.id || "", model_id: String(profile?.model || "") };
}

function selectionPatch(choice, modelId, currentProfile) {
  if (choice.runtime_mode === "native_live") {
    const id = choice.stages.native_live;
    return { voice_provider: id, stt_provider: id, reasoning_provider: id, tts_provider: id,
      ...(modelId ? { model: modelId } : {}) };
  }
  return { voice_provider: "chirp", stt_provider: "chirp", reasoning_provider: choice.stages.reasoning,
    tts_provider: choice.stages.tts || currentProfile.tts_provider || "none", ...(modelId ? { model: modelId } : {}) };
}

function finalizeChoice(choice) {
  const available = Boolean(choice.adapter_available);
  const configured = Boolean(choice.configured);
  return { ...choice, available, configured,
    status: !available ? "unavailable" : configured ? "configured" : "not_configured" };
}

function indexRegistry(providers) {
  const out = {};
  for (const type of ["native_live", "stt", "reasoning", "tts"]) out[type] = new Map((providers?.[type] || []).map((entry) => [entry.id, entry]));
  return out;
}

function mergeCapabilities(...entries) {
  const merged = {};
  for (const entry of entries) for (const [key, value] of Object.entries(entry?.capabilities || {})) merged[key] = merged[key] || Boolean(value);
  return merged;
}

function normalized(value) { return String(value || "").trim().toLowerCase().replace(/_/g, "-"); }

module.exports = {
  ProviderSelectionError,
  createVoiceProviderCatalog,
  resolveProviderSelection,
  validateProfileProviderPatch,
  voiceProviderEnvForProfile,
};
