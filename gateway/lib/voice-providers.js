"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { WebSocket } = require("ws");
const { safeSystemPromptForProvider } = require("./agent-profile");
const { voiceOptionsPayload } = require("./profile-options");
const { buildChirpTranscriptionPrompt } = require("./chirp-transcription-prompt");
const { createSttStage, createReasonerStage, createTtsStage } = require("./voice-stages");
const { createSpeechChunker } = require("./voice-chunker");
const { createStreamingSttSession, DEFAULT_ROTATE_AFTER_MS } = require("./voice-stt-streaming");
const { TranscriptSidecarVoiceProvider } = require("./voice-provider-composition");
const {
  adcAccessToken,
  authorizedUserAccessToken,
  googleCredentialFile,
  serviceAccountAccessToken,
} = require("./google-auth");

const CLIENT_AUDIO_FORMAT = {
  encoding: "pcm16",
  sample_rate: 16000,
  channels: 1,
};
const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
const DEFAULT_VERTEX_LIVE_MODEL = "gemini-live-2.5-flash-native-audio";
const DEFAULT_VERTEX_LIVE_LOCATION = "us-central1";
const DEFAULT_CHIRP_MODEL = "chirp_3";
const CHIRP_MAX_PROMPT_LANGUAGE_CODES = 2;
const CHIRP_AUTO_LANGUAGE_CODES = Object.freeze(["auto"]);
const GEMINI_LIVE_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const VERTEX_LIVE_EXPRESS_ENDPOINT = "wss://aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent";
const PROVIDER_TYPES = ["native_live", "stt", "reasoning", "tts"];
const PROVIDER_CAPABILITY_FLAGS = [
  "duplex_audio",
  "barge_in",
  "server_vad",
  "partial_transcripts",
  "assistant_audio",
  "voice_output",
  "transcription_only",
  "mid_session_profile_update",
  "language_hints",
  "provider_session_resume",
  "streaming_tts",
  "streaming_reasoning",
];
const PROVIDER_ALIASES = Object.freeze({
  test: "loopback",
  "google-chirp": "chirp",
  chirp3: "chirp",
  "chirp-3": "chirp",
});
const VOICE_PROVIDER_REGISTRY = Object.freeze({
  native_live: Object.freeze({
    loopback: providerRegistryEntry({
      id: "loopback",
      label: "Loopback transport QA",
      capabilities: {
        assistant_audio: true,
        voice_output: true,
      },
      configured: () => true,
      create: (options) => new LoopbackVoiceProvider(options),
    }),
    "gemini-live": providerRegistryEntry({
      id: "gemini-live",
      label: "Gemini Live",
      capabilities: {
        duplex_audio: true,
        barge_in: true,
        server_vad: true,
        partial_transcripts: true,
        assistant_audio: true,
        voice_output: true,
        language_hints: true,
      },
      configured: (env) => Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY),
      create: (options) => new GeminiLiveVoiceProvider(options, {
        provider: "gemini-live",
        defaultModel: DEFAULT_GEMINI_LIVE_MODEL,
        defaultEndpoint: GEMINI_LIVE_ENDPOINT,
        authMode: "google-ai-api-key",
      }),
    }),
    "vertex-live": providerRegistryEntry({
      id: "vertex-live",
      label: "Vertex Live",
      capabilities: {
        duplex_audio: true,
        barge_in: true,
        server_vad: true,
        partial_transcripts: true,
        assistant_audio: true,
        voice_output: true,
        language_hints: true,
      },
      configured: vertexLiveConfigured,
      create: (options) => new GeminiLiveVoiceProvider(options, {
        provider: "vertex-live",
        defaultModel: DEFAULT_VERTEX_LIVE_MODEL,
        defaultEndpoint: VERTEX_LIVE_EXPRESS_ENDPOINT,
        authMode: "vertex",
      }),
    }),
  }),
  stt: Object.freeze({
    chirp: providerRegistryEntry({
      id: "chirp",
      label: "Google Chirp 3 Speech-to-Text",
      capabilities: {
        partial_transcripts: false,
        transcription_only: true,
        language_hints: true,
      },
      configured: chirpConfigured,
      create: (options) => new CascadedVoiceProvider(options),
    }),
  }),
  reasoning: Object.freeze({
    gateway: providerRegistryEntry({
      id: "gateway",
      label: "A.G. gateway voice-turn router",
      capabilities: {
        streaming_reasoning: true,
      },
      configured: () => true,
    }),
  }),
  tts: Object.freeze({
    "android-tts": providerRegistryEntry({
      id: "android-tts",
      label: "Android local TextToSpeech",
      capabilities: {
        voice_output: true,
      },
      configured: () => true,
    }),
    "cloud-tts": providerRegistryEntry({
      id: "cloud-tts",
      label: "Google Cloud Text-to-Speech (Chirp 3 HD where available)",
      capabilities: {
        voice_output: true,
        streaming_tts: true,
      },
      configured: chirpConfigured,
    }),
    "gemini-tts": providerRegistryEntry({
      id: "gemini-tts",
      label: "Gemini 3.1 Flash TTS (Cloud TTS modelName)",
      capabilities: {
        voice_output: true,
        language_hints: true,
        streaming_tts: true,
      },
      configured: chirpConfigured,
    }),
    none: providerRegistryEntry({
      id: "none",
      label: "No hosted TTS",
      capabilities: {},
      configured: () => true,
    }),
  }),
});

const CLOUD_TTS_DEFAULT_VOICES = Object.freeze({
  "en-us": "en-US-Chirp3-HD-Aoede",
});
const CLOUD_TTS_UNSUPPORTED_LANGUAGES = Object.freeze(new Set(["am-et", "am"]));
const CLOUD_TTS_SAMPLE_RATE = 24000;
const GEMINI_TTS_DEFAULT_MODEL = "gemini-3.1-flash-tts-preview";
const GEMINI_TTS_DEFAULT_VOICE = "Kore";
const CLOUD_TTS_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";
const CLOUD_TTS_V1BETA1_ENDPOINT = "https://texttospeech.googleapis.com/v1beta1/text:synthesize";
const PROVIDER_ALIASES_TTS = Object.freeze({
  "chirp-tts": "cloud-tts",
  "cloud-text-to-speech": "cloud-tts",
  "google-tts": "cloud-tts",
  "gemini-flash-tts": "gemini-tts",
  "gemini-3.1-flash-tts": "gemini-tts",
  "gemini-tts-preview": "gemini-tts",
});

class TurnSupersededError extends Error {
  constructor(message) {
    super(message || "voice turn superseded");
    this.name = "TurnSupersededError";
  }
}

function isTurnSupersededError(error) {
  return error instanceof TurnSupersededError || error?.name === "TurnSupersededError";
}

const VOICE_STREAMING_FAULT_LIMIT = 3;
const voiceStreamingBreaker = { faults: 0, tripped: false };

function reportVoiceStreamingFault(context) {
  voiceStreamingBreaker.faults += 1;
  if (!voiceStreamingBreaker.tripped && voiceStreamingBreaker.faults >= VOICE_STREAMING_FAULT_LIMIT) {
    voiceStreamingBreaker.tripped = true;
    console.error(JSON.stringify({
      level: "error",
      at: "voice_streaming_tripped",
      faults: voiceStreamingBreaker.faults,
      context: String(context || "").slice(0, 300),
    }));
  }
}

function voiceStreamingTripped() {
  return voiceStreamingBreaker.tripped;
}

function resetVoiceStreamingBreakerForTests() {
  voiceStreamingBreaker.faults = 0;
  voiceStreamingBreaker.tripped = false;
}

function createVoiceProvider(options) {
  const env = options?.env || process.env;
  const names = voiceProviderNames(env);
  const entry = resolveProviderEntry(names);
  if (entry?.create) {
    return composeVoiceProvider(entry.create(options), options);
  }
  return new UnsupportedVoiceProvider(options, names);
}

function composeVoiceProvider(primary, options) {
  const env = options?.env || process.env;
  const sidecarId = registryProviderId(env.VOICE_TRANSCRIPT_SIDECAR || env.VOICE_LIVE_TRANSCRIPT_SIDECAR || "");
  if (!sidecarId || typeof primary?.createLiveTurnSession !== "function") {
    return primary;
  }
  const sidecarEntry = providerDefinition("stt", sidecarId);
  if (!sidecarEntry?.create) {
    return primary;
  }
  const sidecar = sidecarEntry.create({
    ...(options || {}),
    env: {
      ...env,
      VOICE_PROVIDER: sidecarId,
      VOICE_STT_PROVIDER: sidecarId,
      VOICE_REASONING_PROVIDER: "gateway",
      VOICE_LLM_PROVIDER: "gateway",
      VOICE_TTS_PROVIDER: "none",
    },
    reasoner: null,
  });
  return new TranscriptSidecarVoiceProvider(primary, sidecar, sidecarId);
}

function resolveProviderEntry(names) {
  // The chirp STT anchor selects the cascaded composition regardless of the
  // reasoning/TTS stage selection (those are stages inside it).
  if (names.stt === "chirp") {
    return providerDefinition("stt", "chirp");
  }
  const stt = registryProviderId(names.stt);
  const reasoning = registryProviderId(names.reasoning || names.llm);
  const tts = registryProviderId(names.tts);
  if (stt === reasoning && reasoning === tts) {
    return providerDefinition("native_live", stt);
  }
  return null;
}

function voiceProviderNames(env) {
  const packageName = providerName(env.VOICE_PROVIDER || "");
  if (registryProviderId(packageName) === "chirp") {
    const reasoningName = providerName(env.VOICE_REASONING_PROVIDER || env.VOICE_LLM_PROVIDER || "gateway");
    return {
      stt: "chirp",
      reasoning: reasoningName,
      llm: reasoningName,
      tts: providerName(env.VOICE_TTS_PROVIDER || "android-tts"),
    };
  }
  const reasoningName = providerName(env.VOICE_REASONING_PROVIDER || env.VOICE_LLM_PROVIDER || packageName || "loopback");
  return {
    stt: providerName(env.VOICE_STT_PROVIDER || packageName || "loopback"),
    reasoning: reasoningName,
    llm: reasoningName,
    tts: providerName(env.VOICE_TTS_PROVIDER || packageName || "loopback"),
  };
}

function providerName(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, "-");
}

function allSameProvider(names, provider) {
  return names.stt === provider && names.llm === provider && names.tts === provider;
}

function createVoiceProviderRegistry(options) {
  const env = options?.env || process.env;
  const names = options?.names || voiceProviderNames(env);
  const runtimeMode = selectedRuntimeMode(names);
  const selectedProviders = selectedProviderIds(names, runtimeMode);
  const selectedEntries = selectedProviderEntries(selectedProviders, runtimeMode);
  const issues = providerConfigurationIssues(env, selectedProviders, selectedEntries, runtimeMode);

  return {
    runtime_mode: runtimeMode,
    selected_providers: selectedProviders,
    configuration: {
      configured: issues.length === 0,
      status: issues.length === 0 ? "configured" : "needs_attention",
      issues,
    },
    capabilities: selectedCapabilities(selectedEntries),
    providers: registryProviders(env),
  };
}

function voiceRuntimeStatus(options) {
  const registry = createVoiceProviderRegistry({
    env: options?.env,
    names: options?.names,
  });
  const issues = [...registry.configuration.issues];
  if (options?.error) {
    issues.push({
      type: "runtime_error",
      message: String(options.error),
    });
  }
  const configured = Boolean(options?.configured) && issues.length === 0;
  return {
    runtime_mode: registry.runtime_mode,
    selected_providers: registry.selected_providers,
    configuration: {
      configured,
      status: configured ? "configured" : (issues.length > 0 ? "needs_attention" : "not_configured"),
      issues,
    },
    capabilities: registry.capabilities,
    provider_registry: registry.providers,
  };
}

function providerRegistryEntry(entry) {
  return Object.freeze({
    id: entry.id,
    label: entry.label,
    provider_type: "native_live",
    capabilities: Object.freeze(capabilities(entry.capabilities || {})),
    configured: entry.configured,
    // Optional instantiation factory: entries that can build a full transport
    // provider (native_live bundles, or the cascaded STT anchor) define it, so
    // adding a provider is one registry entry instead of an if/else branch.
    create: typeof entry.create === "function" ? entry.create : null,
  });
}

function selectedRuntimeMode(names) {
  const stt = registryProviderId(names.stt);
  const reasoning = registryProviderId(names.reasoning || names.llm);
  const tts = registryProviderId(names.tts);
  if (stt === reasoning && reasoning === tts) {
    return providerDefinition("native_live", stt) ? "native_live" : "unsupported";
  }
  return "modular";
}

function selectedProviderIds(names, runtimeMode) {
  const stt = registryProviderId(names.stt);
  const reasoning = registryProviderId(names.reasoning || names.llm);
  const tts = registryProviderId(names.tts);
  return {
    native_live: runtimeMode === "native_live" ? stt : null,
    stt,
    reasoning,
    tts,
  };
}

function selectedProviderEntries(selectedProviders, runtimeMode) {
  if (runtimeMode === "native_live") {
    return [providerDefinition("native_live", selectedProviders.native_live)].filter(Boolean);
  }
  if (runtimeMode === "modular") {
    return [
      providerDefinition("stt", selectedProviders.stt),
      providerDefinition("reasoning", selectedProviders.reasoning),
      providerDefinition("tts", selectedProviders.tts),
    ].filter(Boolean);
  }
  return [];
}

function providerConfigurationIssues(env, selectedProviders, selectedEntries, runtimeMode) {
  const issues = [];
  if (runtimeMode === "unsupported") {
    issues.push({
      type: "unsupported_provider",
      provider: selectedProviders.stt,
      message: "selected provider is not registered as a native live provider",
    });
    return issues;
  }
  const requiredTypes = runtimeMode === "native_live" ? ["native_live"] : ["stt", "reasoning", "tts"];
  for (const type of requiredTypes) {
    const id = selectedProviders[type];
    const entry = providerDefinition(type, id);
    if (!entry) {
      issues.push({
        type: "unregistered_provider",
        provider_type: type,
        provider: id,
        message: `${type} provider is not registered`,
      });
      continue;
    }
    if (!providerEntryConfigured(entry, env)) {
      issues.push({
        type: "missing_configuration",
        provider_type: type,
        provider: entry.id,
        message: `${entry.id} provider is selected but not configured`,
      });
    }
  }
  if (selectedEntries.length === 0 && issues.length === 0) {
    issues.push({
      type: "unregistered_provider",
      message: "no selected provider entries were found",
    });
  }
  return issues;
}

function selectedCapabilities(entries) {
  const result = capabilities({});
  for (const entry of entries) {
    for (const flag of PROVIDER_CAPABILITY_FLAGS) {
      result[flag] = result[flag] || Boolean(entry.capabilities[flag]);
    }
  }
  return result;
}

function registryProviders(env) {
  const result = {};
  for (const type of PROVIDER_TYPES) {
    result[type] = Object.values(VOICE_PROVIDER_REGISTRY[type] || {}).map((entry) => ({
      id: entry.id,
      label: entry.label,
      provider_type: type,
      configured: providerEntryConfigured(entry, env),
      capabilities: entry.capabilities,
    }));
  }
  return result;
}

function providerDefinition(type, id) {
  const normalized = registryProviderId(id);
  return (VOICE_PROVIDER_REGISTRY[type] || {})[normalized] || null;
}

function providerEntryConfigured(entry, env) {
  if (typeof entry?.configured !== "function") {
    return false;
  }
  return Boolean(entry.configured(env || process.env));
}

function registryProviderId(value) {
  const normalized = providerName(value);
  return PROVIDER_ALIASES[normalized] || PROVIDER_ALIASES_TTS[normalized] || normalized;
}

function capabilities(overrides) {
  const result = {};
  for (const flag of PROVIDER_CAPABILITY_FLAGS) {
    result[flag] = Boolean(overrides[flag]);
  }
  return result;
}

function vertexLiveConfigured(env) {
  const hasApiKey = Boolean(env.VERTEX_EXPRESS_API_KEY || env.VERTEX_API_KEY || env.GOOGLE_API_KEY || env.GEMINI_API_KEY);
  const hasAdcTarget = Boolean(env.VERTEX_PROJECT || env.GOOGLE_CLOUD_PROJECT);
  return hasApiKey || hasAdcTarget;
}

function chirpConfigured(env) {
  const projectId = chirpProjectId(env);
  const hasAuth = Boolean(
    env.CHIRP_ACCESS_TOKEN
      || env.GCP_ACCESS_TOKEN
      || env.CHIRP_SERVICE_ACCOUNT_KEY
      || env.GCP_SERVICE_ACCOUNT_KEY
      || env.CHIRP_SERVICE_ACCOUNT_KEY_FILE
      || env.GOOGLE_APPLICATION_CREDENTIALS
      || env.GCLOUD_BIN
      || env.PATH
  );
  return Boolean(projectId && hasAuth);
}

class LoopbackVoiceProvider {
  constructor(options) {
    this.env = options?.env || process.env;
    this.names = voiceProviderNames(this.env);
  }

  status() {
    const runtime = voiceRuntimeStatus({
      env: this.env,
      names: this.names,
      configured: true,
    });
    return {
      provider: "loopback",
      stt_provider: this.names.stt,
      reasoning_provider: this.names.reasoning,
      llm_provider: this.names.llm,
      tts_provider: this.names.tts,
      configured: true,
      model: "local-test-tone",
      assistant_audio_format: CLIENT_AUDIO_FORMAT,
      ...runtime,
    };
  }

  async processTurn(turn, hooks) {
    const typedText = String(turn.syntheticText || "").trim();
    const transcript = typedText || "Fake transcript for the streaming voice MVP.";
    const assistantText = typedText
      ? `Loopback reply to: ${typedText}`
      : "Streaming voice transport is connected. I received your audio and can play this test tone.";
    await hooks.onTranscriptFinal(transcript);
    await hooks.onAssistantText(assistantText);
    await hooks.onAssistantAudioStart(CLIENT_AUDIO_FORMAT);
    await streamTestTone(hooks.sendAudio);
    await hooks.onAssistantAudioDone();
    return {
      provider: "loopback",
      transcript,
      assistant_text: assistantText,
      audio_format: CLIENT_AUDIO_FORMAT,
    };
  }
}

class UnsupportedVoiceProvider {
  constructor(options, names) {
    this.env = options?.env || process.env;
    this.names = names || voiceProviderNames(options?.env || process.env);
    this.error = "mixed voice providers are not implemented yet; use loopback, gemini-live, or vertex-live for all three providers";
  }

  status() {
    const runtime = voiceRuntimeStatus({
      env: this.env,
      names: this.names,
      configured: false,
      error: this.error,
    });
    return {
      provider: "unsupported",
      stt_provider: this.names.stt,
      reasoning_provider: this.names.reasoning,
      llm_provider: this.names.llm,
      tts_provider: this.names.tts,
      configured: false,
      error: this.error,
      assistant_audio_format: CLIENT_AUDIO_FORMAT,
      ...runtime,
    };
  }

  async processTurn() {
    throw new Error(this.status().error);
  }
}

class CascadedVoiceProvider {
  constructor(options) {
    const env = options?.env || process.env;
    this.env = env;
    this.names = voiceProviderNames(env);
    this.projectId = chirpProjectId(env);
    this.location = String(env.CHIRP_LOCATION || env.GCP_LOCATION || env.GOOGLE_CLOUD_LOCATION || "us").trim() || "us";
    this.model = String(env.CHIRP_MODEL || env.VOICE_STT_MODEL || DEFAULT_CHIRP_MODEL).trim() || DEFAULT_CHIRP_MODEL;
    // Backward-compatible env fallback for the language names placed in the
    // Chirp custom prompt. Recognition itself always stays language-agnostic.
    this.envPromptLanguageCodes = languageCodes(env.CHIRP_PROMPT_LANGUAGE_CODES || env.CHIRP_LANGUAGE_CODES || env.CHIRP_LANGUAGE_CODE || env.GEMINI_LIVE_LANGUAGE_CODE || env.MODEL_LANGUAGE || "en-US");
    this.timeoutMs = Math.max(5000, numberFrom(env.CHIRP_TIMEOUT_MS || env.VOICE_PROVIDER_TIMEOUT_MS, 30000));
    this.cloudTtsTimeoutMs = Math.max(1, numberFrom(env.CLOUD_TTS_TIMEOUT_MS, 20000));
    this.testChirpEndpoint = env.MOA_MODE === "local" ? String(env.MOA_TEST_CHIRP_ENDPOINT || "").trim() : "";
    this.testCloudTtsEndpoint = env.MOA_MODE === "local" ? String(env.MOA_TEST_CLOUD_TTS_ENDPOINT || "").trim() : "";
    this.gcloudBin = env.GCLOUD_BIN || "gcloud";
    this.staticAccessToken = env.CHIRP_ACCESS_TOKEN || env.GCP_ACCESS_TOKEN || "";
    this.serviceAccountKeyJson = env.CHIRP_SERVICE_ACCOUNT_KEY || env.GCP_SERVICE_ACCOUNT_KEY || "";
    this.serviceAccountKeyFile = env.CHIRP_SERVICE_ACCOUNT_KEY_FILE || env.GOOGLE_APPLICATION_CREDENTIALS || "";
    this.tokenCache = { value: "", expiresAt: 0 };
    this.sttProviderId = "chirp";
    this.streamingSttClientFactory = typeof options?.streamingSttClientFactory === "function"
      ? options.streamingSttClientFactory
      : null;
    this.streamingSttRotateAfterMs = Math.max(10000, numberFrom(env.VOICE_STT_STREAM_ROTATE_MS, DEFAULT_ROTATE_AFTER_MS));
    this._streamingSttClient = null;
    this.reasoner = typeof options?.reasoner === "function" ? options.reasoner : null;
    this.agentProfile = options?.agentProfile || null;
    this.lastTtsError = "";
    this.ttsProviderId = registryProviderId(this.names.tts);
    if (this.ttsProviderId === "gemini-tts") {
      this.ttsVoice = String(env.GEMINI_TTS_VOICE || env.CHIRP_TTS_VOICE || env.CLOUD_TTS_VOICE || "").trim() || GEMINI_TTS_DEFAULT_VOICE;
      this.ttsModel = String(env.GEMINI_TTS_MODEL || env.CHIRP_TTS_MODEL || "").trim() || GEMINI_TTS_DEFAULT_MODEL;
    } else {
      this.ttsVoice = String(env.CHIRP_TTS_VOICE || env.CLOUD_TTS_VOICE || "").trim();
      this.ttsModel = String(env.CHIRP_TTS_MODEL || "").trim();
    }
    this.sttStage = createSttStage({
      id: "chirp",
      capabilities: { partial_transcripts: this.streamingSttFlagEnabled(), language_hints: true },
      transcribe: ({ turn }) => this.runSttStage(turn),
    });
    this.reasonerStage = this.reasoner
      ? createReasonerStage({
        id: "gateway",
        capabilities: { streaming_reasoning: true, tools: true },
        run: (input) => this.reasoner(input),
      })
      : null;
    this.ttsStage = this.ttsProviderId === "cloud-tts" || this.ttsProviderId === "gemini-tts"
      ? createTtsStage({
        id: this.ttsProviderId,
        capabilities: {
          streaming_tts: true,
          expressive_tags: this.ttsProviderId === "gemini-tts",
          language_pinning: this.ttsProviderId === "gemini-tts",
        },
        synthesize: ({ text, language, stylePrompt, signal, voice, speakingRate, tone }) => this.synthesizeSpeech(text, language, stylePrompt, signal, voice, { speakingRate, tone }),
      })
      : null;
  }

  cascaded() {
    return Boolean(this.reasonerStage) && Boolean(this.ttsStage);
  }

  configured() {
    return chirpConfigured(this.env);
  }

  profileForTurn(turnOrProfile) {
    if (turnOrProfile?.effectiveProfile && typeof turnOrProfile.effectiveProfile === "object") {
      return turnOrProfile.effectiveProfile;
    }
    if (turnOrProfile && typeof turnOrProfile === "object" && !Buffer.isBuffer(turnOrProfile)) {
      const looksLikeProfile = "input_languages" in turnOrProfile
        || "input_language_primary" in turnOrProfile
        || "language" in turnOrProfile
        || "response_modality" in turnOrProfile
        || "voice" in turnOrProfile;
      if (looksLikeProfile) return turnOrProfile;
    }
    return this.agentProfile && typeof this.agentProfile.effective === "function"
      ? this.agentProfile.effective()
      : null;
  }

  sttLanguageCodes(turnOrProfile) {
    return CHIRP_AUTO_LANGUAGE_CODES.slice();
  }

  sttPromptLanguageCodes(turnOrProfile) {
    const profile = this.profileForTurn(turnOrProfile);
    if (profile) {
      const set = String(profile?.input_languages || profile?.input_language_primary || "").trim();
      const codes = languageCodes(set);
      const primary = String(profile?.input_language_primary || "").trim().toLowerCase();
      if (primary && codes.length > 1) {
        const index = codes.findIndex((code) => String(code).toLowerCase() === primary);
        if (index > 0) {
          const reordered = codes.slice();
          const [lead] = reordered.splice(index, 1);
          reordered.unshift(lead);
          return reordered;
        }
      }
      return codes;
    }
    return this.envPromptLanguageCodes;
  }

  sttCustomPrompt(turnOrProfile, promptCodes = this.sttPromptLanguageCodes(turnOrProfile)) {
    return buildChirpTranscriptionPrompt(promptCodes);
  }

  assertModelSupportsLanguages(codes = this.sttLanguageCodes()) {
    if (!isChirp3Model(this.model)) {
      throw new Error(`automatic prompt-based transcription requires model=chirp_3, but CHIRP_MODEL is ${this.model || "unset"}`);
    }
  }

  endpoint() {
    return this.testChirpEndpoint || chirpEndpoint(this.projectId, this.location);
  }

  status() {
    const codes = this.sttLanguageCodes();
    const promptLanguageCodes = this.sttPromptLanguageCodes();
    const runtime = voiceRuntimeStatus({
      env: this.env,
      names: this.names,
      configured: this.configured(),
    });
    return {
      provider: "chirp",
      stt_provider: this.names.stt,
      reasoning_provider: this.names.reasoning,
      llm_provider: this.names.llm,
      tts_provider: this.names.tts,
      configured: this.configured(),
      model: this.model,
      endpoint: redactEndpoint(this.endpoint()),
      auth: this.authStatus(),
      language_codes: codes,
      language_recognition: "auto",
      prompt_language_codes: promptLanguageCodes,
      custom_prompt_configured: true,
      requires_chirp_3: true,
      chirp_3_only_languages: [],
      // "cascaded": STT -> gateway LLM turn -> hosted Cloud TTS reply audio.
      // "stt_only": transcript only; the device speaks the reply.
      pipeline: this.cascaded() ? "cascaded" : "stt_only",
      tts_provider_id: this.ttsProviderId,
      tts_model: this.ttsModel || null,
      tts_voice: this.ttsVoice || null,
      // Effective delivery controls (profile/env), for ops verification.
      tts_speaking_rate: this.speakingRate(),
      tts_tone: this.voiceTone() || null,
      // When true, pace is applied by the client resampling the PCM (guaranteed
      // speed for Gemini-TTS) instead of baked into the synthesized audio.
      tts_client_rate_mode: this.clientRateModeEnabled(),
      // Streaming posture for ops: the per-turn flag decision and whether the
      // in-process circuit breaker has latched streaming off.
      voice_streaming: {
        enabled: this.streamingEnabledForTurn(),
        tripped: voiceStreamingTripped(),
      },
      // Streaming STT posture for ops: whether streamingRecognize is active for
      // the current language set and whether live partial transcripts flow.
      // Honest per-turn: reflects the env flag, the breaker, and the
      // language/model legality of streaming for the configured codes.
      voice_stt: {
        provider_id: this.sttProviderId,
        model: this.model,
        streaming_recognition: this.streamingSttEnabled(codes),
        streaming_flag_enabled: this.streamingSttFlagEnabled(),
        partial_transcripts: this.streamingSttEnabled(codes),
        rotate_after_ms: this.streamingSttRotateAfterMs,
      },
      input_audio_format: CLIENT_AUDIO_FORMAT,
      assistant_audio_format: CLIENT_AUDIO_FORMAT,
      // STT-only unless the cascaded pipeline is wired (reasoner + hosted TTS).
      transcription_only: !this.cascaded(),
      ...runtime,
    };
  }

  authStatus() {
    if (this.staticAccessToken) return "access_token_env";
    if (this.serviceAccountKeyJson) return "service_account_key_env";
    if (this.serviceAccountKeyFile) return "service_account_key_file";
    return "gcloud_adc";
  }

  async processTurn(turn, hooks) {
    if (!this.configured()) {
      throw new Error("chirp STT provider requires GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT plus GCP_SERVICE_ACCOUNT_KEY, GOOGLE_APPLICATION_CREDENTIALS, CHIRP_ACCESS_TOKEN, or gcloud ADC on the gateway machine");
    }
    const sttLanguageCodes = this.sttLanguageCodes(turn);
    const promptLanguageCodes = this.sttPromptLanguageCodes(turn);
    this.assertModelSupportsLanguages(sttLanguageCodes);
    // A typed text turn (side panel / text surfaces) carries its transcript in
    // turn.syntheticText and records no audio: skip the STT leg entirely.
    const typedText = String(turn.syntheticText || "").trim();
    if (!typedText && (!turn.audioBytes || turn.audioBytes <= 0)) {
      throw new Error("cannot send an empty audio turn to chirp");
    }

    // Leg 1 — streaming Chirp 3 STT in language-agnostic mode, guided by the
    // turn-pinned profile's custom transcription prompt.
    let transcription = { text: typedText, languageRejected: false };
    const sttStartedAtMs = Date.now();
    await voiceStageStart(hooks, "stt", {
      provider_id: this.sttProviderId,
      model: this.model,
      language_codes: sttLanguageCodes,
      prompt_language_codes: promptLanguageCodes,
      audio_bytes: turn.audioBytes || 0,
      skipped: Boolean(typedText),
    });
    if (!typedText) {
      try {
        transcription = await this.sttStage.transcribe({ turn, languageCodes: sttLanguageCodes });
        await voiceStageDone(hooks, "stt", sttStartedAtMs, {
          provider_id: this.sttProviderId,
          model: this.model,
          language_codes: sttLanguageCodes,
          prompt_language_codes: promptLanguageCodes,
          transcript_chars: String(transcription.text || "").length,
          transcript_language_rejected: transcription.languageRejected === true,
        });
      } catch (error) {
        await voiceStageError(hooks, "stt", sttStartedAtMs, error, {
          provider_id: this.sttProviderId,
          model: this.model,
          language_codes: sttLanguageCodes,
          prompt_language_codes: promptLanguageCodes,
        });
        throw error;
      }
    } else {
      await voiceStageDone(hooks, "stt", sttStartedAtMs, {
        provider_id: this.sttProviderId,
        model: this.model,
        skipped: true,
        skip_reason: "typed_text_turn",
        transcript_chars: typedText.length,
      });
    }
    const transcript = transcription.text;
    if (transcription.languageRejected) {
      turn.transcriptLanguageRejected = true;
    }
    if (transcript) {
      await hooks.onTranscriptFinal(transcript);
    }

    // STT-only path: hand the transcript back; the gateway records it and the
    // device speaks the reply. Preserves the legacy switchable setup.
    if (!this.cascaded()) {
      return {
        provider: "chirp",
        model: this.model,
        transcript,
        assistant_text: "",
        audio_format: CLIENT_AUDIO_FORMAT,
        transcription_only: true,
        transcript_language_rejected: transcription.languageRejected === true,
      };
    }

    // Leg 2 — the gateway's durable, model-agnostic LLM turn. The reasoner reads
    // the effective agent profile (reply language/voice as OUTPUT policy) and
    // returns the spoken reply text plus the reply language. A control/agent-run
    // turn returns no speak text; we then skip TTS.
    let reasoning = { speak: "", display: transcript, language: this.replyLanguage(turn), model: this.model, classification: "chat" };
    if (!transcript) {
      return this.cascadedResult(transcript, reasoning, false, transcription);
    }
    const modality = this.replyModality(turn);
    // Gate hoisting: the reply (OUTPUT) language and modality are pinned ONCE,
    // BEFORE the LLM stream starts, so chunk 1 can synthesize mid-stream with
    // the turn-pinned voice. A mid-turn profile language switch takes effect
    // next turn; a post-stream language divergence is recorded as
    // tts_language_mismatch instead of re-synthesizing.
    const pinnedLanguage = this.replyLanguage(turn);
    // Like the language, the TTS voice is pinned ONCE per turn, from the turn's
    // effective profile (which carries a validated session_start voice
    // override), so every streamed chunk speaks with the same voice and a
    // per-session voice never leaks into other sessions.
    const pinnedVoice = this.ttsVoiceName(turn.effectiveProfile);
    // Delivery pace/tone are pinned per turn like the voice, so every streamed
    // chunk speaks at one speed; a mid-turn change applies next turn.
    const pinnedRate = this.speakingRate(turn.effectiveProfile);
    const pinnedTone = this.voiceTone(turn.effectiveProfile);
    // The factor the client resamples by (1.0 unless Gemini-TTS client-rate mode).
    const clientRate = this.clientPlaybackRate(pinnedRate);
    const turnStartedAtMs = Date.now();
    const pipeline = this.streamingEnabledForTurn() && modality !== "text" && this.canSynthesize(pinnedLanguage)
      ? this.createStreamingReplyPipeline({ hooks, language: pinnedLanguage, turnStartedAtMs, voice: pinnedVoice, speakingRate: pinnedRate, tone: pinnedTone, playbackRate: clientRate })
      : null;
    const streamingTtsStartedAtMs = pipeline ? Date.now() : 0;
    if (pipeline) {
      await voiceStageStart(hooks, "tts", {
        provider_id: this.ttsProviderId,
        language: pinnedLanguage,
        streaming: true,
      });
    }
    // The reasoner (gateway LLM/tool turn) runs with no stream events until it
    // returns. Tell the session server to keep the client alive with turn_progress
    // ticks during the wait; the server owns the interval, this only reports the
    // stage. Absent on non-streaming hook sets (loopback/eval), so guard the call.
    if (typeof hooks.onTurnProgress === "function") {
      await hooks.onTurnProgress("reasoning");
    }
    const reasoningStartedAtMs = Date.now();
    await voiceStageStart(hooks, "reasoning", {
      provider_id: this.reasoningProviderId,
      streaming: Boolean(pipeline),
      transcript_chars: transcript.length,
    });
    try {
      const result = await this.reasonerStage.run({
        transcript,
        session_id: turn.sessionId || turn.session_id || "",
        conversation_id: turn.conversationId || turn.conversation_id || "",
        branch_id: turn.branchId || turn.branch_id || "",
        turn_id: turn.turnId || turn.turn_id || "",
        device_id: turn.deviceId || turn.device_id || "",
        all_branches_context: turn.allBranchesContext === true || turn.all_branches_context === true,
        source: turn.source || "voice-cascaded",
        // Delivery context so the reasoner can answer "why did you reply in text?"
        // honestly and can reason about the language/modality switch itself.
        response_modality: modality,
        tts_provider_id: this.ttsProviderId,
        tts_available: this.cascaded(),
        previous_tts_error: this.lastTtsError || "",
        // Session persona (already sanitized/capped by the session server): the
        // reasoner speaks AS this companion for this session's turns only.
        ...(turn.persona ? { persona: turn.persona } : {}),
        // Streaming taps: sanitized final-answer deltas feed the chunked TTS
        // pipeline; the leading [style: ...] line arrives before any prose so
        // every chunk can carry the style prompt.
        ...(pipeline ? {
          on_speak_delta: (delta) => pipeline.pushDelta(delta),
          on_speak_style: (style) => pipeline.setStyle(style),
          // Gateway-produced interim speech (tool-call acknowledgment): spoken
          // NOW as its own chunk, not buffered by the sentence chunker.
          on_speak_say: (text) => pipeline.pushImmediate(text),
        } : {}),
        // Turn liveness for the reasoner's unbounded auto-continuation loop:
        // a barge-in must stop the model from generating for a dead turn.
        is_turn_active: () => (typeof hooks.isTurnActive === "function" ? hooks.isTurnActive() !== false : true),
      });
      reasoning = { ...reasoning, ...(result && typeof result === "object" ? result : {}) };
      await voiceStageDone(hooks, "reasoning", reasoningStartedAtMs, {
        provider_id: this.reasoningProviderId,
        model: reasoning.model || this.model,
        classification: reasoning.classification || "chat",
        speak_chars: String(reasoning.speak || "").length,
        display_chars: String(reasoning.display || "").length,
        streaming_delta_count: pipeline ? pipeline.deltaCount() : 0,
      });
    } catch (error) {
      if (pipeline) {
        pipeline.cancel();
      }
      if (isTurnSupersededError(error)) {
        // Containment failure of the write guard would land here; count it on
        // the breaker and end the superseded turn silently instead of
        // rebranding it a reasoning failure.
        reportVoiceStreamingFault(`turn_superseded_reached_reasoner_catch: ${cleanError(error)}`);
        return this.cascadedResult(transcript, reasoning, false, transcription, { modality });
      }
      await voiceStageError(hooks, "reasoning", reasoningStartedAtMs, error, {
        provider_id: this.reasoningProviderId,
        transcript_chars: transcript.length,
        streaming: Boolean(pipeline),
      });
      throw new Error(`cascaded reasoning failed: ${cleanError(error)}`);
    }

    // `speak` is the CLEAN reply shown/stored (no expressive tags); `ttsText`
    // carries the whitelisted inline tags for the Gemini-TTS leg, and `ttsStyle`
    // is the natural-language style prompt (input.prompt). Non-expressive
    // providers get the clean text and no style prompt from the reasoner.
    const speak = String(reasoning.speak || "").trim();
    const ttsText = String(reasoning.tts_text || reasoning.speak || "").trim();
    const ttsStyle = String(reasoning.tts_style || "").trim();
    if (speak) {
      // Sent when the LLM stream ends. On a multi-chunk streaming turn this
      // deliberately lands BETWEEN binary frames (audio-before-text is the
      // streaming contract); a one-chunk reply may still deliver text first.
      await hooks.onAssistantText(speak);
    }

    // Leg 3 (streaming) — the pipelined per-chunk TTS already synthesized and
    // emitted audio while the reasoner streamed. Flush the tail, then fold the
    // pipeline outcome into the result. finish() never throws: a mid-stream
    // synthesis fault degrades to a text-only remainder with tts_error set and
    // a superseded turn aborts silently.
    if (pipeline) {
      if (speak && pipeline.deltaCount() === 0 && ttsText) {
        // The reasoner streamed no deltas (non-streaming provider or fallback
        // path): push the final reply once so the turn still speaks, in the
        // same text-before-audio order as the non-streaming path.
        pipeline.setStyle(ttsStyle);
        if (typeof hooks.onTurnProgress === "function") {
          await hooks.onTurnProgress("tts");
        }
        pipeline.pushFinalText(ttsText);
      }
      let stream = null;
      let streamError = "";
      try {
        stream = await pipeline.finish();
      } catch (error) {
        // finish() must never throw; if it does, that is a pipeline-guard
        // escape: count it on the breaker and degrade to text-only.
        reportVoiceStreamingFault(`streaming_pipeline_escape: ${cleanError(error)}`);
        streamError = cleanError(error);
      }
      const streamSpoke = Boolean(stream?.spoke);
      const streamTtsError = stream ? stream.ttsError : streamError;
      if (streamTtsError) {
        await voiceStageError(hooks, "tts", streamingTtsStartedAtMs, streamTtsError, {
          provider_id: this.ttsProviderId,
          language: pinnedLanguage,
          streaming: true,
          segments: stream ? stream.segments : 0,
          ...(Number.isFinite(stream?.firstAudioMs) ? { first_audio_ms: stream.firstAudioMs } : {}),
        });
      } else {
        await voiceStageDone(hooks, "tts", streamingTtsStartedAtMs, {
          provider_id: this.ttsProviderId,
          language: pinnedLanguage,
          streaming: true,
          segments: stream ? stream.segments : 0,
          spoke: streamSpoke,
          ...(Number.isFinite(stream?.firstAudioMs) ? { first_audio_ms: stream.firstAudioMs } : {}),
        });
      }
      const extras = {
        modality,
        ttsError: streamTtsError,
        streaming: true,
        firstAudioMs: stream?.firstAudioMs,
        ttsSegments: stream ? stream.segments : 0,
        reasonerFirstDeltaMs: stream?.firstDeltaMs,
      };
      const finalLanguage = String(reasoning.language || "").trim().toLowerCase();
      if (streamSpoke && finalLanguage && finalLanguage !== String(pinnedLanguage || "").trim().toLowerCase()) {
        // Audio already played in the pinned language; the reasoner's language
        // stays authoritative in the stored record, and the divergence feeds
        // the next turn's honesty context alongside lastTtsError.
        extras.ttsLanguageMismatch = true;
        this.lastTtsError = streamTtsError
          || `previous reply audio was synthesized in ${pinnedLanguage} but the reply language was ${reasoning.language}`;
      } else {
        this.lastTtsError = streamTtsError;
      }
      return this.cascadedResult(transcript, reasoning, streamSpoke, transcription, extras);
    }

    // Leg 3 (non-streaming: VOICE_STREAMING=0, breaker tripped, text modality,
    // or no hosted voice for the pinned language) — hosted TTS reply audio in
    // one blocking call, exactly the pre-streaming behavior. "text" modality
    // deliberately delivers the reply as text (no hosted audio), distinct from
    // a synthesis failure; a language with no hosted voice (am-ET on cloud-tts)
    // still returns reply text for the device to speak.
    let spoke = false;
    let ttsError = "";
    if (speak && modality === "text") {
      // Deliberate text-only delivery, not a failure — leave spoke=false, no error.
      await voiceStageStart(hooks, "tts", {
        provider_id: this.ttsProviderId,
        language: reasoning.language || "",
        streaming: false,
      });
      await voiceStageDone(hooks, "tts", Date.now(), {
        provider_id: this.ttsProviderId,
        language: reasoning.language || "",
        streaming: false,
        skipped: true,
        skip_reason: "response_modality_text",
      });
    } else if (speak && !this.canSynthesize(reasoning.language)) {
      await voiceStageStart(hooks, "tts", {
        provider_id: this.ttsProviderId,
        language: reasoning.language || "",
        streaming: false,
      });
      await voiceStageDone(hooks, "tts", Date.now(), {
        provider_id: this.ttsProviderId,
        language: reasoning.language || "",
        streaming: false,
        skipped: true,
        skip_reason: "unsupported_language",
      });
    } else if (speak && this.canSynthesize(reasoning.language)) {
      // Hosted TTS synthesis is another silent wait before audio starts flowing;
      // keep the keepalive going with the "tts" stage until the first audio frame.
      if (typeof hooks.onTurnProgress === "function") {
        await hooks.onTurnProgress("tts");
      }
      const ttsStartedAtMs = Date.now();
      await voiceStageStart(hooks, "tts", {
        provider_id: this.ttsProviderId,
        language: reasoning.language || "",
        streaming: false,
        text_chars: ttsText.length,
      });
      try {
        const pcm = await this.ttsStage.synthesize({ text: ttsText, language: reasoning.language, stylePrompt: ttsStyle, voice: pinnedVoice, speakingRate: pinnedRate, tone: pinnedTone });
        if (pcm && pcm.length) {
          await hooks.onAssistantAudioStart(CLIENT_AUDIO_FORMAT, { playbackRate: clientRate });
          if (typeof hooks.onAssistantAudioSegment === "function") {
            await hooks.onAssistantAudioSegment({
              segment_index: 0,
              text_start: 0,
              text_end: ttsText.length,
              text: ttsText,
              audio_bytes: pcm.length,
              pcm_ms: pcmDurationMs(pcm.length, CLIENT_AUDIO_FORMAT),
            });
          }
          await hooks.sendAudio(pcm, { segmentIndex: 0, segmentText: ttsText });
          await hooks.onAssistantAudioDone();
          spoke = true;
          await voiceStageDone(hooks, "tts", ttsStartedAtMs, {
            provider_id: this.ttsProviderId,
            language: reasoning.language || "",
            streaming: false,
            audio_bytes: pcm.length,
            segments: 1,
            spoke: true,
          });
        } else {
          ttsError = "hosted TTS returned no audio";
          await voiceStageError(hooks, "tts", ttsStartedAtMs, ttsError, {
            provider_id: this.ttsProviderId,
            language: reasoning.language || "",
            streaming: false,
            segments: 0,
          });
        }
      } catch (error) {
        // TTS is best-effort: a synthesis failure must not drop the reply text.
        // Log the reason once, carry it on the turn so a client and the next
        // turn's modality hint can explain it; the device still speaks the text.
        ttsError = cleanError(error);
        await voiceStageError(hooks, "tts", ttsStartedAtMs, error, {
          provider_id: this.ttsProviderId,
          language: reasoning.language || "",
          streaming: false,
          segments: 0,
        });
        console.warn(JSON.stringify({
          level: "warn",
          at: "cascaded_tts_synthesis_failed",
          tts_provider: this.ttsProviderId,
          reply_language: reasoning.language || "",
          error: ttsError,
        }));
      }
    }
    this.lastTtsError = ttsError;

    return this.cascadedResult(transcript, reasoning, spoke, transcription, { modality, ttsError });
  }

  cascadedResult(transcript, reasoning, spoke, transcription = {}, options = {}) {
    return {
      provider: "chirp-cascaded",
      model: reasoning.model || this.model,
      transcript,
      assistant_text: String(reasoning.speak || "").trim(),
      audio_format: CLIENT_AUDIO_FORMAT,
      // Not transcription-only: the gateway produced a reply. `tts_spoke` tells
      // the client whether hosted reply audio was streamed or it must speak the
      // text locally (e.g. Amharic, which Cloud TTS cannot synthesize).
      transcription_only: false,
      tts_spoke: spoke,
      reply_language: reasoning.language || "",
      // How the reply was delivered and, when hosted TTS was attempted and
      // failed, the short reason. `modality:"text"` is a deliberate text-only
      // turn, never a failure; `tts_error` is only set on a real synthesis fault.
      modality: options.modality || this.replyModality(),
      tts_error: options.ttsError || "",
      transcript_language_rejected: transcription.languageRejected === true,
      classification: reasoning.classification || "chat",
      // Additive streaming metadata (absent on non-streaming turns; old code
      // reading new records ignores it, new code reading old records treats
      // absence as the non-streaming default).
      ...(options.streaming ? { streaming: true } : {}),
      ...(Number.isFinite(options.firstAudioMs) ? { first_audio_ms: Math.max(0, Math.round(options.firstAudioMs)) } : {}),
      ...(options.streaming && Number.isFinite(options.ttsSegments) ? { tts_segments: options.ttsSegments } : {}),
      ...(Number.isFinite(options.reasonerFirstDeltaMs) ? { reasoner_first_delta_ms: Math.max(0, Math.round(options.reasonerFirstDeltaMs)) } : {}),
      ...(options.ttsLanguageMismatch ? { tts_language_mismatch: true } : {}),
      // Client-forwardable action envelopes proposed by the reasoner's tools
      // this turn (e.g. companion_motion). The session server forwards each as
      // its own client event; absent on turns with no proposed action.
      ...(Array.isArray(reasoning.actions) && reasoning.actions.length ? { actions: reasoning.actions.slice(0, 8) } : {}),
    };
  }

  // VOICE_STREAMING is read PER TURN (an env lookup in the turn path, not a
  // module-load const), so an in-process override can flip it without touching
  // module state. Unset or "1" means on; the in-process circuit breaker latch
  // is consulted first.
  streamingEnabledForTurn() {
    if (!this.cascaded()) {
      return false;
    }
    if (voiceStreamingTripped()) {
      return false;
    }
    return String(this.env.VOICE_STREAMING ?? "").trim() !== "0";
  }

  chunkerOptions() {
    return {
      firstChunkMaxChars: Math.max(1, numberFrom(this.env.VOICE_CHUNK_FIRST_MAX_CHARS, 60)),
      minChars: Math.max(1, numberFrom(this.env.VOICE_CHUNK_MIN_CHARS, 60)),
      maxChars: Math.max(1, numberFrom(this.env.VOICE_CHUNK_MAX_CHARS, 220)),
      // 700 (was 1200): a short trailing sentence was waiting 1.2s before it
      // was force-emitted, a flat add to time-to-first-audio on short replies.
      flushTimeoutMs: Math.max(50, numberFrom(this.env.VOICE_CHUNK_FLUSH_MS, 700)),
    };
  }

  ttsConcurrency() {
    return Math.max(1, Math.min(4, numberFrom(this.env.VOICE_TTS_CONCURRENCY, 2)));
  }

  // The pipelined per-chunk TTS emitter. Sanitized reply deltas stream in; the
  // chunker cuts sentence/clause chunks; at most `ttsConcurrency()` synthesize
  // requests run concurrently while emission stays STRICTLY ordered through a
  // promise chain (chunk n+1's PCM is held until chunk n's sendAudio resolves).
  // Nothing here may throw out of finish(): a synthesis fault degrades the
  // remainder to text-only with tts_error set, and a TurnSupersededError from
  // the session-server write guard aborts silently (no tts_error, no events
  // for the dead turn). One nulled stream crash-looped this gateway 24 times
  // in a day; the guard lives on the write, not only in callers.
  createStreamingReplyPipeline({ hooks, language, turnStartedAtMs, voice, speakingRate, tone, playbackRate }) {
    const provider = this;
    const chunker = createSpeechChunker(this.chunkerOptions());
    const abortController = new AbortController();
    const state = {
      style: "",
      deltaCount: 0,
      firstDeltaAtMs: 0,
      emitted: 0,
      nextSegmentIndex: 0,
      textCursor: 0,
      started: false,
      failed: false,
      superseded: false,
      finished: false,
      ttsError: "",
      firstAudioAtMs: 0,
    };
    let emitChain = Promise.resolve();
    let permits = this.ttsConcurrency();
    const waiters = [];
    let forceTimer = null;

    const isActive = () => (typeof hooks.isTurnActive === "function" ? hooks.isTurnActive() !== false : true);
    const acquire = () => {
      if (permits > 0) {
        permits -= 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    };
    const release = () => {
      const next = waiters.shift();
      if (next) {
        next();
      } else {
        permits += 1;
      }
    };
    const clearForceTimer = () => {
      if (forceTimer) {
        clearTimeout(forceTimer);
        forceTimer = null;
      }
    };
    const markSuperseded = () => {
      if (state.superseded) return;
      state.superseded = true;
      abortController.abort();
      clearForceTimer();
    };
    const markFailed = (error) => {
      if (state.superseded || state.failed) return;
      state.failed = true;
      state.ttsError = state.ttsError || cleanError(error);
      abortController.abort();
      clearForceTimer();
      console.warn(JSON.stringify({
        level: "warn",
        at: "cascaded_tts_stream_failed",
        tts_provider: provider.ttsProviderId,
        reply_language: language || "",
        error: state.ttsError,
      }));
    };

    // Synthesis faults are caught HERE, at the source, so a failed chunk stops
    // later chunks from ever issuing their requests (not merely from emitting).
    const synthesizeChunk = async (text) => {
      await acquire();
      try {
        if (state.superseded || state.failed) {
          return null;
        }
        const pcm = await provider.ttsStage.synthesize({
          text,
          language,
          stylePrompt: state.style,
          signal: abortController.signal,
          voice,
          speakingRate,
          tone,
        });
        if (!pcm || !pcm.length) {
          throw new Error("hosted TTS returned no audio");
        }
        return { pcm, text };
      } catch (error) {
        if (state.superseded || state.failed || error?.name === "AbortError") {
          return null;
        }
        markFailed(error);
        return null;
      } finally {
        release();
      }
    };

    const enqueue = (text) => {
      if (state.superseded || state.failed) {
        return;
      }
      const normalizedText = String(text || "").trim();
      if (!normalizedText) {
        return;
      }
      // The reasoner chunker normalizes away boundary whitespace. Preserve the
      // one-character separator used by the stored assistant reply so segment
      // offsets remain usable when reconstructing the unheard suffix.
      const textStart = state.textCursor + (state.textCursor > 0 ? 1 : 0);
      const textEnd = textStart + normalizedText.length;
      const segmentIndex = state.nextSegmentIndex;
      state.nextSegmentIndex += 1;
      state.textCursor = textEnd;
      const synthPromise = synthesizeChunk(normalizedText);
      emitChain = emitChain.then(async () => {
        const synthesized = await synthPromise;
        if (!synthesized || state.superseded || state.failed) {
          return;
        }
        const pcm = synthesized.pcm;
        if (!isActive()) {
          throw new TurnSupersededError("voice turn superseded before chunk emission");
        }
        if (!state.started) {
          await hooks.onAssistantAudioStart(CLIENT_AUDIO_FORMAT, { streaming: true, playbackRate });
          state.started = true;
        }
        if (typeof hooks.onAssistantAudioSegment === "function") {
          await hooks.onAssistantAudioSegment({
            segment_index: segmentIndex,
            text_start: textStart,
            text_end: textEnd,
            text: normalizedText,
            audio_bytes: pcm.length,
            pcm_ms: pcmDurationMs(pcm.length, CLIENT_AUDIO_FORMAT),
          });
        }
        // The segment metadata rides along so the session server can keep a
        // frame->reply-text ledger: on interruption it is the only way to know
        // which words were already spoken (binary PCM frames carry no text).
        await hooks.sendAudio(pcm, {
          segmentIndex,
          segmentText: normalizedText,
        });
        state.emitted += 1;
        if (!state.firstAudioAtMs) {
          state.firstAudioAtMs = Date.now();
        }
      }).catch((error) => {
        if (isTurnSupersededError(error)) {
          markSuperseded();
          return;
        }
        markFailed(error);
      });
    };

    const scheduleForceBreak = () => {
      clearForceTimer();
      if (state.superseded || state.failed || state.finished) {
        return;
      }
      if (chunker.pendingLength() === 0) {
        return;
      }
      const waitMs = Math.max(50, chunker.nextDeadline() - Date.now());
      forceTimer = setTimeout(() => {
        forceTimer = null;
        if (state.superseded || state.failed || state.finished) {
          return;
        }
        if (chunker.pendingLength() >= chunker.minChars) {
          for (const chunk of chunker.forceBreak()) {
            enqueue(chunk);
          }
        }
        scheduleForceBreak();
      }, waitMs);
      forceTimer.unref?.();
    };

    return {
      pushDelta(delta) {
        if (state.superseded || state.failed || state.finished) {
          return;
        }
        const text = String(delta ?? "");
        if (!text) {
          return;
        }
        state.deltaCount += 1;
        if (!state.firstDeltaAtMs) {
          state.firstDeltaAtMs = Date.now();
        }
        for (const chunk of chunker.push(text)) {
          enqueue(chunk);
        }
        scheduleForceBreak();
      },
      setStyle(style) {
        const value = String(style || "").trim();
        if (value && !state.style) {
          state.style = value;
        }
      },
      // Zero-delta fallback: the reasoner returned a COMPLETE reply without
      // streaming any deltas (non-streaming provider, fallback path, stubs).
      // Speak it as ONE chunk — the pre-streaming single-call shape — instead
      // of re-chunking text that is already fully known.
      pushFinalText(text) {
        if (state.superseded || state.failed || state.finished) {
          return;
        }
        const value = String(text || "").trim();
        if (!value) {
          return;
        }
        state.deltaCount += 1;
        if (!state.firstDeltaAtMs) {
          state.firstDeltaAtMs = Date.now();
        }
        enqueue(value);
      },
      // Gateway-produced interim speech (a tool-call acknowledgment): synthesize
      // and emit NOW as one standalone chunk, bypassing the sentence chunker so
      // a short line is never held back waiting for min-chars while a tool runs.
      // Counted as a delta so the zero-delta fallback never double-speaks.
      pushImmediate(text) {
        if (state.superseded || state.failed || state.finished) {
          return;
        }
        const value = String(text || "").trim();
        if (!value) {
          return;
        }
        state.deltaCount += 1;
        if (!state.firstDeltaAtMs) {
          state.firstDeltaAtMs = Date.now();
        }
        enqueue(value);
      },
      deltaCount() {
        return state.deltaCount;
      },
      cancel() {
        markSuperseded();
      },
      async finish() {
        state.finished = true;
        clearForceTimer();
        if (!state.superseded && !state.failed) {
          for (const chunk of chunker.flush()) {
            enqueue(chunk);
          }
        }
        await emitChain;
        clearForceTimer();
        if (state.started && !state.superseded) {
          try {
            await hooks.onAssistantAudioDone();
          } catch (error) {
            if (isTurnSupersededError(error)) {
              markSuperseded();
            } else {
              markFailed(error);
            }
          }
        }
        return {
          spoke: state.emitted > 0 && !state.superseded,
          segments: state.emitted,
          // A superseded turn is silent: no tts_error, no events for it.
          ttsError: state.superseded ? "" : state.ttsError,
          superseded: state.superseded,
          started: state.started,
          firstAudioMs: state.firstAudioAtMs ? state.firstAudioAtMs - turnStartedAtMs : null,
          firstDeltaMs: state.firstDeltaAtMs ? state.firstDeltaAtMs - turnStartedAtMs : null,
        };
      },
    };
  }

  // The reply-delivery modality from the effective agent profile: "text" (write,
  // no hosted audio), "speech" (speak), or "auto" (default; speak when a hosted
  // voice can synthesize). Read fresh per turn so a spoken change applies next.
  replyModality(turnOrProfile) {
    const profile = this.profileForTurn(turnOrProfile);
    return String(profile?.response_modality || "auto").trim().toLowerCase() || "auto";
  }

  // Synthesize gateway-produced reply text (today a profile-control confirmation)
  // into hosted reply audio and stream it through the same hooks the cascaded
  // reply uses. The streaming server calls this to SPEAK confirmations that are
  // produced after processTurn — the profile change itself is applied once by the
  // turn recorder, so this only adds the voice. Respects response_modality and
  // hosted-voice availability; best-effort, so a failure records the reason and
  // lets the device speak the text.
  async synthesizeAssistantSpeech(text, hooks, options = {}) {
    const speak = String(text || "").trim();
    if (!speak || !this.cascaded()) {
      return { spoke: false, tts_error: "" };
    }
    if (this.replyModality(options.profile) === "text") {
      return { spoke: false, tts_error: "", modality: "text" };
    }
    const language = String(options.language || "").trim() || this.replyLanguage(options.profile);
    if (!this.canSynthesize(language)) {
      return { spoke: false, tts_error: "" };
    }
    // The confirmation-TTS leg (profile-control confirmations) is a silent wait
    // too; keep the "tts" keepalive going until the first audio frame.
    if (typeof hooks.onTurnProgress === "function") {
      await hooks.onTurnProgress("tts");
    }
    try {
      const pcm = await this.ttsStage.synthesize({
        text: speak,
        language,
        voice: this.ttsVoiceName(options.profile),
        speakingRate: this.speakingRate(options.profile),
        tone: this.voiceTone(options.profile),
      });
      if (pcm && pcm.length) {
        await hooks.onAssistantAudioStart(CLIENT_AUDIO_FORMAT, { playbackRate: this.clientPlaybackRate(this.speakingRate(options.profile)) });
        if (typeof hooks.onAssistantAudioSegment === "function") {
          await hooks.onAssistantAudioSegment({
            segment_index: 0,
            text_start: 0,
            text_end: speak.length,
            text: speak,
            audio_bytes: pcm.length,
            pcm_ms: pcmDurationMs(pcm.length, CLIENT_AUDIO_FORMAT),
          });
        }
        await hooks.sendAudio(pcm, { segmentIndex: 0, segmentText: speak });
        await hooks.onAssistantAudioDone();
        this.lastTtsError = "";
        return { spoke: true, tts_error: "" };
      }
      return { spoke: false, tts_error: "hosted TTS returned no audio" };
    } catch (error) {
      const ttsError = cleanError(error);
      this.lastTtsError = ttsError;
      console.warn(JSON.stringify({
        level: "warn",
        at: "cascaded_confirmation_tts_failed",
        tts_provider: this.ttsProviderId,
        error: ttsError,
      }));
      return { spoke: false, tts_error: ttsError };
    }
  }

  // The spoken delivery pace, most specific first: the turn's effective profile
  // (session override merged over the persisted profile), then the live profile,
  // then the env default. 1.0 = provider-normal speed; clamped to the 0.5–2.0
  // band both Chirp3-HD audioConfig and the Gemini-TTS pace prompt support.
  speakingRate(profile) {
    const candidates = [
      profile && typeof profile === "object" ? profile.speaking_rate : undefined,
      this.agentProfile && typeof this.agentProfile.effective === "function"
        ? this.agentProfile.effective().speaking_rate
        : undefined,
      this.env.VOICE_SPEAKING_RATE,
    ];
    for (const candidate of candidates) {
      const rate = Number(candidate);
      if (Number.isFinite(rate) && rate > 0) {
        return Math.min(2, Math.max(0.5, rate));
      }
    }
    return 1.5;
  }

  // The spoken delivery tone (a few free-text words for the expressive style
  // prompt). "" means neutral/no tone. Same precedence as speakingRate; the
  // turn profile's "" is an explicit "no tone", not a fallthrough.
  voiceTone(profile) {
    const candidates = [
      profile && typeof profile === "object" ? profile.voice_tone : undefined,
      this.agentProfile && typeof this.agentProfile.effective === "function"
        ? this.agentProfile.effective().voice_tone
        : undefined,
      this.env.VOICE_TONE,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string") {
        return candidate.trim().slice(0, 160);
      }
    }
    return "";
  }

  // Client-rate mode: when VOICE_TTS_CLIENT_RATE is set, the gateway stops
  // baking pace into the Gemini-TTS style prompt (whose pace words are only
  // approximate) and instead asks the CLIENT to resample the audio to the target
  // speed. This gives a guaranteed speed knob for the provider that ignores
  // audioConfig.speakingRate. Off by default so live behavior is unchanged and
  // an un-updated client never gets slower-than-today audio.
  clientRateModeEnabled() {
    return String(this.env.VOICE_TTS_CLIENT_RATE ?? "").trim() !== ""
      && String(this.env.VOICE_TTS_CLIENT_RATE).trim() !== "0";
  }

  // The playback-rate factor the CLIENT should apply to this turn's PCM. 1.0
  // means "already at the right speed" (classic voices bake audioConfig
  // speakingRate; Gemini keeps its pace prompt). It is the pinned rate ONLY for
  // the Gemini-TTS leg in client-rate mode, where the gateway deliberately did
  // not bake the pace.
  clientPlaybackRate(rate) {
    if (this.ttsProviderId === "gemini-tts" && this.clientRateModeEnabled()) {
      const value = Number(rate);
      if (Number.isFinite(value) && value > 0) {
        return Math.min(2, Math.max(0.5, value));
      }
    }
    return 1;
  }

  // Whether the Gemini-TTS style prompt should carry the pace instruction.
  // False in client-rate mode (the client resamples instead), so the two paths
  // never both speed up the same reply.
  paceInPrompt() {
    return !(this.ttsProviderId === "gemini-tts" && this.clientRateModeEnabled());
  }

  // The reply (OUTPUT) language from the effective agent profile, falling back
  // to the first language named in the STT prompt. Chirp recognition itself is
  // language-agnostic.
  replyLanguage(turnOrProfile) {
    const profile = this.profileForTurn(turnOrProfile);
    const fromProfile = String(profile?.language || profile?.language_primary || "").trim();
    return fromProfile || this.sttPromptLanguageCodes(turnOrProfile)[0] || "en-US";
  }

  canSynthesize(language) {
    const code = String(language || this.replyLanguage() || "").trim().toLowerCase();
    if (!code) {
      return false;
    }
    // Gemini TTS follows the pinned languageCode for every language the model
    // speaks (including am-ET), so the classic Cloud TTS voice table does not
    // gate it.
    if (this.ttsProviderId === "gemini-tts") {
      return true;
    }
    if (CLOUD_TTS_UNSUPPORTED_LANGUAGES.has(code)) {
      return false;
    }
    return Boolean(this.ttsVoice) || Boolean(cloudTtsVoiceFor(code));
  }

  // The voice for the Gemini-TTS leg, most specific first: a per-turn profile
  // (turn.effectiveProfile — carries the session_start voice override the
  // session server already canonicalized, e.g. a website pet speaking in its
  // own voice), then the persisted profile voice (a spoken "change your voice"
  // self-configuration applies on the next turn), then the env default.
  // Classic Cloud TTS voices have provider-specific names, so that leg stays
  // env-driven.
  ttsVoiceName(profile) {
    if (this.ttsProviderId === "gemini-tts") {
      const fromTurnProfile = profile && typeof profile === "object" ? String(profile.voice || "").trim() : "";
      if (fromTurnProfile) {
        return fromTurnProfile;
      }
      if (this.agentProfile && typeof this.agentProfile.effective === "function") {
        const fromProfile = String(this.agentProfile.effective().voice || "").trim();
        if (fromProfile) {
          return fromProfile;
        }
      }
    }
    return this.ttsVoice;
  }

  async synthesizeSpeech(text, language, stylePrompt = "", signal = undefined, voice = "", delivery = {}) {
    const token = await this.accessToken();
    const rateInput = Number(delivery?.speakingRate);
    const speakingRate = Number.isFinite(rateInput) && rateInput > 0
      ? Math.min(2, Math.max(0.5, rateInput))
      : this.speakingRate();
    const tone = typeof delivery?.tone === "string" ? delivery.tone : this.voiceTone();
    return synthesizeCloudTts({
      text,
      signal,
      // The Gemini-TTS leg accepts a natural-language style prompt in
      // input.prompt; classic Cloud TTS voices do not, so only forward it there.
      // Pace and tone ride the SAME prompt on Gemini-TTS (audioConfig
      // speakingRate is unreliable there); classic voices get audioConfig
      // speakingRate below instead. In client-rate mode the pace is dropped from
      // the prompt (the client resamples) so speed is applied exactly once.
      prompt: this.ttsProviderId === "gemini-tts"
        ? composeTtsStylePrompt(stylePrompt, tone, this.paceInPrompt() ? speakingRate : 0)
        : "",
      language: language || this.replyLanguage(),
      voice: (this.ttsProviderId === "gemini-tts" && String(voice || "").trim()) || this.ttsVoiceName(),
      modelName: this.ttsProviderId === "gemini-tts" ? this.ttsModel : "",
      speakingRate,
      token,
      location: this.location,
      projectId: this.projectId,
      timeoutMs: this.cloudTtsTimeoutMs,
      endpoint: this.testCloudTtsEndpoint,
      targetSampleRate: CLIENT_AUDIO_FORMAT.sample_rate,
    });
  }

  // Env kill switch only: VOICE_STT_STREAMING="0" forces the pure batch path.
  streamingSttFlagEnabled() {
    return String(this.env.VOICE_STT_STREAMING ?? "").trim() !== "0";
  }

  // Per-turn streaming decision: the env flag is on, the in-process streaming
  // breaker has not latched, and Chirp 3 is selected. `auto` is legal for the
  // streaming RecognitionConfig just as it is for batch recognition; the same
  // profile-derived custom prompt guides both paths.
  streamingSttEnabled(codes = this.sttLanguageCodes()) {
    if (!this.streamingSttFlagEnabled()) return false;
    if (voiceStreamingTripped()) return false;
    return Array.isArray(codes) && codes.length > 0 && isChirp3Model(this.model);
  }

  // Lazily build (or reuse) the Google Speech v2 streaming client. The gRPC
  // dependency is required only here so `npm run check` (which injects a stub)
  // never loads @google-cloud/speech. Auth mirrors the REST path EXACTLY: the
  // same service-account key JSON/file, then GOOGLE_APPLICATION_CREDENTIALS /
  // ADC. Access-token-only auth cannot drive the gRPC client, so those turns
  // fall back to the batch path. Returns null on any failure (never throws).
  streamingSttClient() {
    if (this.streamingSttClientFactory) {
      return this.streamingSttClientFactory();
    }
    if (this._streamingSttClient) {
      return this._streamingSttClient;
    }
    let SpeechClient;
    try {
      ({ SpeechClient } = require("@google-cloud/speech").v2);
    } catch (error) {
      reportVoiceStreamingFault(`stt_stream_client_load: ${cleanError(error)}`);
      return null;
    }
    const apiEndpoint = this.location === "global"
      ? "speech.googleapis.com"
      : `${this.location}-speech.googleapis.com`;
    const clientOptions = { apiEndpoint };
    if (this.projectId) clientOptions.projectId = this.projectId;
    if (this.serviceAccountKeyJson) {
      try {
        clientOptions.credentials = JSON.parse(this.serviceAccountKeyJson);
      } catch (error) {
        reportVoiceStreamingFault(`stt_stream_bad_key_json: ${cleanError(error)}`);
        return null;
      }
    } else if (this.serviceAccountKeyFile) {
      clientOptions.keyFilename = this.serviceAccountKeyFile;
    } else {
      const credentialFile = googleCredentialFile(this.env);
      if (credentialFile) {
        clientOptions.keyFilename = credentialFile;
      } else if (this.staticAccessToken) {
        // No key material the gRPC client can use — fall back to batch.
        return null;
      }
    }
    try {
      this._streamingSttClient = new SpeechClient(clientOptions);
    } catch (error) {
      reportVoiceStreamingFault(`stt_stream_client_new: ${cleanError(error)}`);
      return null;
    }
    return this._streamingSttClient;
  }

  recognizerResource() {
    return `projects/${this.projectId}/locations/${this.location}/recognizers/_`;
  }

  streamingRecognitionConfig(codes, sampleRate, channels, customPrompt = this.sttCustomPrompt()) {
    return {
      recognizer: this.recognizerResource(),
      streamingConfig: {
        config: {
          explicitDecodingConfig: {
            encoding: "LINEAR16",
            sampleRateHertz: sampleRate,
            audioChannelCount: channels,
          },
          languageCodes: codes,
          model: this.model,
          features: {
            enableAutomaticPunctuation: true,
            customPromptConfig: { customPrompt },
          },
        },
        streamingFeatures: { interimResults: true },
      },
    };
  }

  // Open a streaming STT session that tees audio as it arrives from the
  // websocket. `hooks.onTranscriptPartial` is broadcast as `transcript_partial`
  // by the session server; the disk write stays the source of truth. Returns
  // null when streaming is disabled/unsupported so the caller stays batch-only.
  createStreamingSttSession(turn, hooks) {
    const codes = this.sttLanguageCodes(turn);
    if (!this.streamingSttEnabled(codes)) {
      return null;
    }
    const client = this.streamingSttClient();
    if (!client || typeof client.streamingRecognize !== "function") {
      return null;
    }
    const sampleRate = Math.max(1, Number(turn.format?.sample_rate || CLIENT_AUDIO_FORMAT.sample_rate));
    const channels = Math.max(1, Number(turn.format?.channels || CLIENT_AUDIO_FORMAT.channels));
    const configMessage = this.streamingRecognitionConfig(
      codes,
      sampleRate,
      channels,
      this.sttCustomPrompt(turn),
    );
    try {
      return createStreamingSttSession({
        // @google-cloud/speech v2's public streamingRecognize() currently
        // dispatches through the wrong generated bidi surface and Google
        // rejects an otherwise valid recognizer with RESOURCE_PROJECT_INVALID.
        // The generated v2 bidi method is the working transport. Keep the
        // public method as a compatibility fallback for injected/older clients.
        openStream: () => (typeof client._streamingRecognize === "function"
          ? client._streamingRecognize()
          : client.streamingRecognize()),
        configMessage,
        audioMessage: (chunk) => ({ audio: chunk }),
        parseResults: (data) => {
          const results = Array.isArray(data?.results) ? data.results : [];
          return results.map((result) => ({
            transcript: result?.alternatives?.[0]?.transcript || "",
            isFinal: result?.isFinal === true || result?.is_final === true,
            languageCode: result?.languageCode || result?.language_code || "",
          }));
        },
        onPartial: hooks && typeof hooks.onTranscriptPartial === "function"
          ? (text) => hooks.onTranscriptPartial(text)
          : null,
        rotateAfterMs: this.streamingSttRotateAfterMs,
        logger: (event, details) => {
          try {
            console.error(JSON.stringify({ level: "info", at: event, turn: turn.turnId || "", ...details }));
          } catch {
            // logging is best-effort
          }
        },
      });
    } catch (error) {
      reportVoiceStreamingFault(`stt_stream_session_open: ${cleanError(error)}`);
      return null;
    }
  }

  // STT stage entry. Prefers the live streaming session teed during capture;
  // when streaming produced a usable transcript we use it without re-reading the
  // stored PCM. Any streaming shortfall (disabled, empty, error) degrades to the
  // windowed batch path over the stored file — a broken stream never fails the
  // turn.
  async runSttStage(turn) {
    const stream = turn?.sttStream;
    if (stream && typeof stream.finalize === "function") {
      try {
        const result = await stream.finalize();
        if (result && result.ok && result.text) {
          return {
            text: result.text,
            languageRejected: false,
            streaming: true,
            rotations: result.rotations || 0,
          };
        }
        if (result && !result.ok && result.error) {
          reportVoiceStreamingFault(`stt_stream_result: ${result.error}`);
        }
      } catch (error) {
        reportVoiceStreamingFault(`stt_stream_finalize: ${cleanError(error)}`);
      }
    }
    return this.transcribePcmWindowed(turn, this.sttPromptLanguageCodes(turn));
  }

  // Batch path with no length limit: batch :recognize caps inline audio (~60s),
  // so audio longer than a 55s window is split on frame boundaries, each window
  // transcribed independently and the transcripts concatenated. Short audio
  // takes the single-request path unchanged.
  async transcribePcmWindowed(turn, promptLanguageCodes = this.sttPromptLanguageCodes(turn)) {
    const sampleRate = Math.max(1, Number(turn.format?.sample_rate || CLIENT_AUDIO_FORMAT.sample_rate));
    const channels = Math.max(1, Number(turn.format?.channels || CLIENT_AUDIO_FORMAT.channels));
    const audio = fs.readFileSync(turn.pcmPath);
    const frameBytes = channels * 2; // pcm16
    const bytesPerSecond = sampleRate * frameBytes;
    // 55s window keeps each request under the ~60s / 10MB inline recognize cap.
    let windowBytes = Math.max(frameBytes, Math.floor(55 * bytesPerSecond));
    windowBytes -= windowBytes % frameBytes; // align to a whole sample frame
    if (audio.length <= windowBytes) {
      return this.transcribePcmBuffer(audio, sampleRate, channels, promptLanguageCodes);
    }
    const texts = [];
    let anyRejected = false;
    for (let offset = 0; offset < audio.length; offset += windowBytes) {
      const window = audio.subarray(offset, Math.min(offset + windowBytes, audio.length));
      if (window.length < frameBytes) break;
      const part = await this.transcribePcmBuffer(window, sampleRate, channels, promptLanguageCodes);
      if (part.text) texts.push(part.text);
      if (part.languageRejected) anyRejected = true;
    }
    const text = texts.join(" ").replace(/\s+/g, " ").trim();
    return { text, languageRejected: anyRejected && !text, windowed: true };
  }

  async transcribePcmFile(turn, promptLanguageCodes = this.sttPromptLanguageCodes(turn)) {
    const audio = fs.readFileSync(turn.pcmPath);
    const sampleRate = Math.max(1, Number(turn.format?.sample_rate || CLIENT_AUDIO_FORMAT.sample_rate));
    const channels = Math.max(1, Number(turn.format?.channels || CLIENT_AUDIO_FORMAT.channels));
    return this.transcribePcmBuffer(audio, sampleRate, channels, promptLanguageCodes);
  }

  async transcribePcmBuffer(audio, sampleRate, channels, promptLanguageCodes = this.sttPromptLanguageCodes()) {
    const token = await this.accessToken();
    const sttLanguageCodes = this.sttLanguageCodes();
    const customPrompt = this.sttCustomPrompt(null, promptLanguageCodes);
    const sttHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (this.projectId) {
      // authorized_user ADC has no home project; Google APIs reject it without
      // an explicit quota project. Harmless with service-account auth.
      sttHeaders["x-goog-user-project"] = this.projectId;
    }
    const response = await fetchWithTimeout(this.endpoint(), {
      method: "POST",
      headers: sttHeaders,
      body: JSON.stringify({
        config: {
          // Explicit decoding describes the raw PCM container. Language
          // recognition remains provider-neutral `auto`; configured Moa input
          // languages affect only the custom prompt below.
          explicitDecodingConfig: {
            encoding: "LINEAR16",
            sampleRateHertz: sampleRate,
            audioChannelCount: channels,
          },
          languageCodes: sttLanguageCodes,
          model: this.model,
          features: {
            enableAutomaticPunctuation: true,
            customPromptConfig: { customPrompt },
          },
        },
        content: Buffer.isBuffer(audio) ? audio.toString("base64") : Buffer.from(audio).toString("base64"),
      }),
    }, this.timeoutMs);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`chirp STT failed (${response.status}): ${cleanError(text)}`);
    }
    return extractSpeechTranscript(await response.json(), sttLanguageCodes);
  }

  async accessToken() {
    if (this.staticAccessToken) {
      return this.staticAccessToken;
    }
    const now = Date.now();
    if (this.tokenCache.value && this.tokenCache.expiresAt > now + 300000) {
      return this.tokenCache.value;
    }
    const keyJson = this.serviceAccountJson();
    if (keyJson) {
      const token = await serviceAccountAccessToken(keyJson);
      this.tokenCache = token;
      return token.value;
    }
    // The gateway container has no gcloud binary, and the mounted ADC file may
    // be an authorized_user credential rather than a service_account key.
    // Exchange either shape directly against oauth2.googleapis.com, the same
    // way the Vertex Live provider does; gcloud stays as the host fallback.
    const credentialFile = this.serviceAccountKeyFile || googleCredentialFile(this.env);
    if (credentialFile && fs.existsSync(credentialFile)) {
      const token = await adcAccessToken(credentialFile);
      this.tokenCache = token;
      return token.value;
    }
    try {
      return execFileSync(this.gcloudBin, ["auth", "application-default", "print-access-token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      }).trim();
    } catch (error) {
      throw new Error(`could not get Chirp ADC access token with ${this.gcloudBin}: ${cleanError(error)}`);
    }
  }

  serviceAccountJson() {
    if (this.serviceAccountKeyJson) {
      return this.serviceAccountKeyJson;
    }
    if (!this.serviceAccountKeyFile) {
      return "";
    }
    try {
      const raw = fs.readFileSync(this.serviceAccountKeyFile, "utf8");
      const parsed = JSON.parse(raw);
      return parsed?.type === "service_account" ? raw : "";
    } catch {
      return "";
    }
  }
}

class GeminiLiveVoiceProvider {
  constructor(options, providerOptions) {
    const env = options?.env || process.env;
    this.env = env;
    this.provider = providerOptions?.provider || "gemini-live";
    this.authMode = providerOptions?.authMode || "google-ai-api-key";
    this.names = voiceProviderNames(env);
    this.apiKey = this.authMode === "vertex"
      ? env.VERTEX_EXPRESS_API_KEY || env.VERTEX_API_KEY || env.GOOGLE_API_KEY || env.GEMINI_API_KEY || ""
      : env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "";
    this.vertexProject = env.VERTEX_PROJECT || env.GOOGLE_CLOUD_PROJECT || "";
    this.vertexLocation = vertexLiveLocation(env);
    this.gcloudBin = env.GCLOUD_BIN || "gcloud";
    this.tokenCache = { value: "", expiresAt: 0 };
    this.endpoint = this.authMode === "vertex"
      ? env.VERTEX_LIVE_ENDPOINT || this.defaultVertexEndpoint(providerOptions?.defaultEndpoint || VERTEX_LIVE_EXPRESS_ENDPOINT)
      : env.GEMINI_LIVE_ENDPOINT || providerOptions?.defaultEndpoint || GEMINI_LIVE_ENDPOINT;
    this.model = this.authMode === "vertex"
      ? env.VERTEX_LIVE_MODEL || env.GEMINI_LIVE_MODEL || env.VOICE_LLM_MODEL || providerOptions?.defaultModel || DEFAULT_VERTEX_LIVE_MODEL
      : env.GEMINI_LIVE_MODEL || env.VOICE_LLM_MODEL || providerOptions?.defaultModel || DEFAULT_GEMINI_LIVE_MODEL;
    // The env voice is the default. The effective voice is read PER SESSION from
    // the runtime agent profile (if wired in), so the agent changing its own
    // `voice` by talking takes effect on the next turn with no restart.
    this.envVoiceName = env.GEMINI_LIVE_VOICE || "Kore";
    this.agentProfile = options?.agentProfile || null;
    this.languageCode = env.GEMINI_LIVE_LANGUAGE_CODE || "";
    this.temperature = numberFrom(env.GEMINI_LIVE_TEMPERATURE || env.MODEL_TEMPERATURE, 0.4);
    this.timeoutMs = Math.max(5000, numberFrom(env.VOICE_PROVIDER_TIMEOUT_MS, 60000));
    this.audioIdleCompleteMs = Math.max(500, numberFrom(env.GEMINI_LIVE_AUDIO_IDLE_COMPLETE_MS, 2500));
    // Gemini can deliver trailing inputTranscription fragments AFTER the model
    // turn completes. Resolving the turn at turnComplete closes the socket and
    // loses them, which produced turns with no transcript at all. When the
    // transcript is still empty at completion, hold the socket open up to
    // graceMs; each late fragment restarts the shorter settle timer so a
    // fragment burst is captured whole before the turn resolves.
    this.transcriptGraceMs = Math.max(0, numberFrom(env.GEMINI_LIVE_TRANSCRIPT_GRACE_MS, 1500));
    this.transcriptSettleMs = Math.max(50, numberFrom(env.GEMINI_LIVE_TRANSCRIPT_SETTLE_MS, 350));
    // Push-to-talk option: manual activity detection. The client marks turn
    // start and end explicitly, so the model never interrupts its own reply on
    // stray or echoed audio (server VAD caused "generation was interrupted" /
    // no audio output). Opt-in via GEMINI_LIVE_MANUAL_VAD=1; default keeps
    // server VAD so barge-in / interrupt-handoff behavior is unchanged.
    this.manualActivityDetection = env.GEMINI_LIVE_MANUAL_VAD === "1";
    this.sendChunkBytes = Math.max(3200, numberFrom(env.GEMINI_LIVE_SEND_CHUNK_BYTES, 32000));
    this.systemPrompt = options?.systemPrompt || env.SYSTEM_PROMPT || "You are A.G. Your name is A.G., spoken as the two letters \"ay jee\"; if asked who you are, say A.G. — never say you are Gemini or Google. When speaking your name out loud, pronounce it as the two separate letters, not as a single word. Speak tersely. Use the user's requested form of address, title, or roleplay style when provided. Keep replies short enough for voice.";
  }

  // The voice used for the NEXT session/turn: the effective agent profile's
  // `voice` when set, otherwise the env default. Read fresh each call so a
  // profile change applies on the next turn without restarting the provider.
  profileForTurn(turn) {
    if (turn?.effectiveProfile && typeof turn.effectiveProfile === "object") {
      return turn.effectiveProfile;
    }
    return this.agentProfile && typeof this.agentProfile.effective === "function"
      ? this.agentProfile.effective()
      : null;
  }

  effectiveVoice(profile) {
    const effectiveProfile = profile || this.profileForTurn();
    if (effectiveProfile) {
      const profileVoice = effectiveProfile.voice;
      if (typeof profileVoice === "string" && profileVoice.trim()) {
        return profileVoice.trim();
      }
    }
    return this.envVoiceName;
  }

  // The user's preferred input language for status/context. Gemini Live native
  // audio infers input language; this is intentionally NOT sent as
  // speechConfig.languageCode, which configures response speech rather than STT.
  effectiveInputLanguageCode(profile) {
    const effectiveProfile = profile || this.profileForTurn();
    if (effectiveProfile) {
      const primary = String(effectiveProfile.input_language_primary
        || String(effectiveProfile.input_languages || "").split(",")[0]
        || "").trim();
      if (primary) return primary;
    }
    return this.languageCode;
  }

  // Gemini native-audio Live sessions must always request provider audio. The
  // same profile can still carry text-mode preferences for non-Live surfaces,
  // but sending ["TEXT"] to the native-audio model closes the socket before the
  // turn can transcribe or reply.
  effectiveResponseModalities(profile) {
    return ["AUDIO"];
  }

  effectiveSystemPrompt(profile) {
    const effectiveProfile = profile || this.profileForTurn();
    const modality = String(effectiveProfile?.response_modality || "auto").trim().toLowerCase();
    return [
      safeSystemPromptForProvider(effectiveProfile, this.systemPrompt),
      profileIdentityInstruction(effectiveProfile),
      userAddressInstruction(effectiveProfile),
      answerPolicyInstruction(),
      missionAccessInstruction(),
      profileControlInstruction(effectiveProfile),
      agentRunControlInstruction(),
      profileLanguageInstruction(effectiveProfile),
      "If the user tells you to stop, shut up, be quiet, hush, or not to speak, stop talking immediately and say nothing — do not acknowledge it, just go silent.",
      // Native-audio Live goes silent after any function call, so tool use must
      // be rare and deliberate. Everything the agent knows about the user is
      // already in the durable context above; answering questions needs no tool.
      "Tool discipline: answer every question and request by speaking out loud, using the durable context already provided. Never call a tool just to answer or recall something. Call remember_user_fact ONLY when the user explicitly tells you to remember, save, or note something; call update_agent_profile ONLY when the user explicitly asks to change a setting, voice, or language. When in doubt, speak instead of calling a tool.",
      modality === "text"
        ? "This is a live voice session on an audio-only provider. Speak the reply out loud; the client may also display the transcript as text."
        : "",
    ].filter(Boolean).join("\n\n");
  }

  status() {
    const runtime = voiceRuntimeStatus({
      env: this.env,
      names: this.names,
      configured: this.configured(),
    });
    return {
      provider: this.provider,
      stt_provider: this.names.stt,
      reasoning_provider: this.names.reasoning,
      llm_provider: this.names.llm,
      tts_provider: this.names.tts,
      configured: this.configured(),
      model: this.model,
      endpoint: redactEndpoint(this.endpoint),
      auth: this.authStatus(),
      location: this.authMode === "vertex" ? this.vertexLocation : null,
      voice: this.effectiveVoice(),
      voice_default: this.envVoiceName,
      assistant_name: this.agentProfile && typeof this.agentProfile.effective === "function"
        ? this.agentProfile.effective().assistant_name || ""
        : "",
      language_profile: this.agentProfile && typeof this.agentProfile.effective === "function"
        ? this.agentProfile.effective().language || ""
        : "",
      language_code: this.effectiveInputLanguageCode() || null,
      input_audio_format: {
        encoding: "pcm16",
        sample_rate: 16000,
        channels: 1,
      },
      upstream_audio_format: {
        encoding: "pcm16",
        sample_rate: 24000,
        channels: 1,
      },
      assistant_audio_format: CLIENT_AUDIO_FORMAT,
      ...runtime,
    };
  }

  configured() {
    if (this.authMode !== "vertex") {
      return Boolean(this.apiKey);
    }
    return Boolean(this.apiKey || (this.vertexProject && this.vertexLocation));
  }

  authStatus() {
    if (this.authMode === "google-ai-api-key") {
      return this.apiKey ? "google_ai_api_key_env" : "missing_api_key";
    }
    if (this.apiKey) {
      return "vertex_api_key_env";
    }
    if (this.vertexProject && this.vertexLocation) {
      return "vertex_adc";
    }
    return "missing_vertex_auth";
  }

  async processTurn(turn, hooks) {
    if (!this.configured()) {
      throw new Error(`${this.provider} voice provider requires VERTEX_EXPRESS_API_KEY, VERTEX_API_KEY, GOOGLE_API_KEY, or Vertex ADC with VERTEX_PROJECT and VERTEX_LIVE_LOCATION or VERTEX_LOCATION on the gateway machine`);
    }
    if (!turn.audioBytes || turn.audioBytes <= 0) {
      throw new Error("cannot send an empty audio turn to gemini-live");
    }

    const state = {
      inputTranscript: "",
      outputTranscript: "",
      assistantAudioStarted: false,
      assistantTextSent: false,
      audioDoneSent: false,
      completed: false,
      resolved: false,
      rejected: false,
      generationComplete: false,
    };

    await this.runWebSocketTurn(turn, hooks, state);

    const hadRealTranscript = Boolean(state.inputTranscript.trim());
    if (!state.assistantTextSent && state.outputTranscript.trim()) {
      await hooks.onAssistantText(state.outputTranscript.trim());
      state.assistantTextSent = true;
    }
    if (state.assistantAudioStarted && !state.audioDoneSent) {
      await hooks.onAssistantAudioDone();
      state.audioDoneSent = true;
    }

    return {
      provider: this.provider,
      model: this.model,
      // When STT produced nothing even after the transcript grace window, the
      // transcript stays EMPTY with source "synthetic" — never fabricate
      // placeholder words that downstream would store, display, or prompt the
      // model with.
      transcript: state.inputTranscript.trim(),
      transcript_source: hadRealTranscript ? "stt" : "synthetic",
      assistant_text: state.outputTranscript.trim(),
      audio_format: CLIENT_AUDIO_FORMAT,
    };
  }

  createLiveTurnSession(turn, hooks) {
    if (!this.configured()) {
      throw new Error(`${this.provider} voice provider requires VERTEX_EXPRESS_API_KEY, VERTEX_API_KEY, GOOGLE_API_KEY, or Vertex ADC with VERTEX_PROJECT and VERTEX_LIVE_LOCATION or VERTEX_LOCATION on the gateway machine`);
    }

    const state = {
      inputTranscript: "",
      outputTranscript: "",
      assistantAudioStarted: false,
      assistantTextSent: false,
      audioDoneSent: false,
      completed: false,
      resolved: false,
      rejected: false,
      generationComplete: false,
    };
    let websocket = null;
    let chain = Promise.resolve();
    let ready = false;
    let closed = false;
    let idleTimer = null;
    let timeout = null;
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    readyPromise.catch(() => {});

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const scheduleIdleComplete = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        if (state.assistantAudioStarted && !state.resolved && !state.rejected) {
          transcriptGate.request();
        }
      }, this.audioIdleCompleteMs);
      idleTimer.unref();
    };

    const result = () => {
      const sttTranscript = state.inputTranscript.trim();
      const textTurnText = String(turn.syntheticText || "").trim();
      // Real STT wins; a text_turn's typed text is "text". When neither exists
      // the transcript stays EMPTY with source "synthetic" — never fabricate
      // placeholder words that downstream would store, display, or prompt the
      // model with.
      const transcriptSource = sttTranscript ? "stt" : (textTurnText ? "text" : "synthetic");
      return {
        provider: this.provider,
        model: this.model,
        transcript: sttTranscript || textTurnText,
        transcript_source: transcriptSource,
        assistant_text: state.outputTranscript.trim(),
        audio_format: CLIENT_AUDIO_FORMAT,
      };
    };

    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const cleanup = () => {
      clearIdleTimer();
      transcriptGate.cancel();
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };

    const resolveOnce = () => {
      if (state.resolved || state.rejected) return;
      state.resolved = true;
      state.completed = true;
      cleanup();
      closeQuietly(websocket);
      resolveDone(result());
    };

    const rejectOnce = (error) => {
      if (state.resolved || state.rejected) return;
      state.rejected = true;
      cleanup();
      closeQuietly(websocket);
      rejectReady(error);
      rejectDone(error);
    };

    // Turn completion goes through the settle gate, not straight to
    // resolveOnce, so a turn that completes before its inputTranscription
    // arrives waits (bounded) for the trailing fragments instead of losing
    // them to the socket close.
    const transcriptGate = createTranscriptSettleGate({
      graceMs: this.transcriptGraceMs,
      settleMs: this.transcriptSettleMs,
      hasTranscript: () => Boolean(state.inputTranscript.trim()),
      resolve: resolveOnce,
    });

    const sendAudioChunk = async (chunk) => {
      const rate = Number(turn.format?.sample_rate || 16000);
      await sendGeminiJson(websocket, {
        realtimeInput: {
          audio: {
            data: Buffer.from(chunk).toString("base64"),
            mimeType: `audio/pcm;rate=${rate}`,
          },
        },
      });
    };

    const queueProviderTask = (task) => {
      chain = chain.then(task).catch(rejectOnce);
    };

    timeout = setTimeout(() => {
      rejectOnce(new Error(`gemini-live timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    timeout.unref();

    // websocketHeaders may refresh an ADC token over the network, so the
    // socket opens after that resolves. Session methods below stay safe: every
    // send queues behind readyPromise, which only resolves once this socket
    // reports setupComplete.
    const connect = async () => {
      const headers = await this.websocketHeaders();
      if (state.resolved || state.rejected) {
        return;
      }
      websocket = new WebSocket(this.websocketUrl(), {
        headers,
        maxPayload: 32 * 1024 * 1024,
      });

      websocket.on("open", () => {
        websocket.send(JSON.stringify({ setup: this.setupMessage(turn) }), (error) => {
          if (error) rejectOnce(error);
        });
      });

      websocket.on("message", (data, isBinary) => {
        let message = null;
        if (isBinary) {
          message = parsePossibleJsonMessage(data);
          if (!message) {
            queueProviderTask(async () => {
              await this.handleBinaryAudio(data, hooks, state);
              scheduleIdleComplete();
            });
            return;
          }
        } else {
          try {
            message = parseJsonMessage(data);
          } catch (error) {
            rejectOnce(error);
            return;
          }
        }

        if (message.setupComplete) {
          ready = true;
          if (this.manualActivityDetection) {
            // Manual VAD: open the user's activity window before any audio so the
            // model treats the whole push-to-talk capture as one turn.
            sendGeminiJson(websocket, { realtimeInput: { activityStart: {} } }).catch(rejectOnce);
          }
          resolveReady();
          return;
        }

        queueProviderTask(async () => {
          const transcriptBefore = state.inputTranscript;
          await this.handleServerMessage(message, hooks, state, transcriptGate.request, rejectOnce);
          if (state.inputTranscript !== transcriptBefore) {
            transcriptGate.noteTranscript();
          }
          if (state.assistantAudioStarted && !state.generationComplete) {
            scheduleIdleComplete();
          }
        });
      });

      websocket.on("error", rejectOnce);
      websocket.on("close", (code, reason) => {
        closed = true;
        if (state.completed || state.rejected) {
          return;
        }
        if (transcriptGate.pending()) {
          // The turn already completed and was only holding for a late
          // transcript; a provider-side close ends the wait, it does not fail
          // the turn.
          resolveOnce();
          return;
        }
        rejectOnce(new Error(`gemini-live websocket closed before turn completion: ${code} ${Buffer.from(reason || "").toString("utf8")}`));
      });
    };

    connect().catch(rejectOnce);

    return {
      done,
      sendAudio: (chunk) => {
        if (closed || state.resolved || state.rejected) {
          return;
        }
        const value = Buffer.from(chunk);
        queueProviderTask(async () => {
          if (!ready) {
            await readyPromise;
          }
          await sendAudioChunk(value);
        });
      },
      sendText: (text) => {
        if (closed || state.resolved || state.rejected) {
          return;
        }
        const value = String(text || "").trim();
        if (!value) {
          return;
        }
        queueProviderTask(async () => {
          if (!ready) {
            await readyPromise;
          }
          await sendGeminiJson(websocket, {
            clientContent: {
              turns: [{
                role: "user",
                parts: [{ text: value }],
              }],
              turnComplete: true,
            },
          });
        });
      },
      commit: () => {
        if (closed || state.resolved || state.rejected) {
          return;
        }
        queueProviderTask(async () => {
          if (!ready) {
            await readyPromise;
          }
          // Manual VAD closes the turn with activityEnd; server VAD uses
          // audioStreamEnd. activityEnd lets the model reply without
          // interrupting itself on trailing/echoed audio.
          await sendGeminiJson(websocket, this.manualActivityDetection
            ? { realtimeInput: { activityEnd: {} } }
            : { realtimeInput: { audioStreamEnd: true } });
        });
      },
      sendToolResponse: (functionResponses) => {
        if (closed || state.resolved || state.rejected) {
          return;
        }
        queueProviderTask(async () => {
          if (!ready) {
            await readyPromise;
          }
          await sendGeminiJson(websocket, {
            toolResponse: {
              functionResponses,
            },
          });
        });
      },
      cancel: () => {
        rejectOnce(new Error("turn canceled"));
      },
    };
  }

  async runWebSocketTurn(turn, hooks, state) {
    // websocketHeaders may refresh an ADC token over the network; resolve it
    // before the socket opens so the handshake carries a real bearer token.
    const headers = await this.websocketHeaders();
    return new Promise((resolve, reject) => {
      const websocket = new WebSocket(this.websocketUrl(), {
        headers,
        maxPayload: 32 * 1024 * 1024,
      });
      let chain = Promise.resolve();
      let idleTimer = null;
      const timeout = setTimeout(() => {
        rejectOnce(new Error(`gemini-live timed out after ${this.timeoutMs}ms`));
        websocket.close(1011, "voice provider timeout");
      }, this.timeoutMs);
      timeout.unref();

      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const scheduleIdleComplete = () => {
        clearIdleTimer();
        idleTimer = setTimeout(() => {
          if (state.assistantAudioStarted && !state.resolved && !state.rejected) {
            transcriptGate.request();
          }
        }, this.audioIdleCompleteMs);
        idleTimer.unref();
      };

      const resolveOnce = () => {
        if (state.resolved || state.rejected) return;
        state.resolved = true;
        state.completed = true;
        clearIdleTimer();
        transcriptGate.cancel();
        clearTimeout(timeout);
        websocket.close(1000, "turn completed");
        resolve();
      };
      const rejectOnce = (error) => {
        if (state.resolved || state.rejected) return;
        state.rejected = true;
        clearIdleTimer();
        transcriptGate.cancel();
        clearTimeout(timeout);
        reject(error);
      };

      // Same settle gate as createLiveTurnSession: hold the socket open for a
      // bounded window when the turn completes before its transcript arrives.
      const transcriptGate = createTranscriptSettleGate({
        graceMs: this.transcriptGraceMs,
        settleMs: this.transcriptSettleMs,
        hasTranscript: () => Boolean(state.inputTranscript.trim()),
        resolve: resolveOnce,
      });

      websocket.on("open", () => {
        websocket.send(JSON.stringify({ setup: this.setupMessage(turn) }), (error) => {
          if (error) rejectOnce(error);
        });
      });

      const handleParsedMessage = async (message) => {
        if (message.setupComplete) {
          await sendAudioFile(websocket, turn, this.sendChunkBytes);
          return;
        }
        const transcriptBefore = state.inputTranscript;
        await this.handleServerMessage(message, hooks, state, transcriptGate.request, rejectOnce);
        if (state.inputTranscript !== transcriptBefore) {
          transcriptGate.noteTranscript();
        }
        if (state.assistantAudioStarted && !state.generationComplete) {
          scheduleIdleComplete();
        }
      };

      websocket.on("message", (data, isBinary) => {
        chain = chain.then(async () => {
          if (isBinary) {
            const message = parsePossibleJsonMessage(data);
            if (message) {
              await handleParsedMessage(message);
              return;
            }
            await this.handleBinaryAudio(data, hooks, state);
            scheduleIdleComplete();
            return;
          }
          await handleParsedMessage(parseJsonMessage(data));
        }).catch(rejectOnce);
      });

      websocket.on("error", rejectOnce);
      websocket.on("close", (code, reason) => {
        if (state.completed || state.rejected) {
          return;
        }
        if (transcriptGate.pending()) {
          resolveOnce();
          return;
        }
        rejectOnce(new Error(`gemini-live websocket closed before turn completion: ${code} ${Buffer.from(reason || "").toString("utf8")}`));
      });
    });
  }

  setupMessage(turn) {
    const profile = this.profileForTurn(turn);
    const speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: this.effectiveVoice(profile),
        },
      },
    };
    const systemParts = [{ text: this.effectiveSystemPrompt(profile) }];
    const contextPrompt = String(turn?.contextPrompt || "").trim();
    if (contextPrompt) {
      systemParts.push({ text: contextPrompt });
    }

    return {
      model: this.modelResource(),
      generationConfig: {
        responseModalities: this.effectiveResponseModalities(profile),
        temperature: this.temperature,
        speechConfig,
      },
      systemInstruction: {
        parts: systemParts,
      },
      tools: [{
        functionDeclarations: [
          {
            name: "launch_agent_run",
            description: "Start a durable A.G. gateway agent run on the home machine for work that should continue outside the live voice response.",
            parameters: {
              type: "OBJECT",
              properties: {
                prompt: {
                  type: "STRING",
                  description: "The concrete task for the agent to perform.",
                },
                harness: {
                  type: "STRING",
                  description: "Optional harness name such as codex, gemini, claude, or echo.",
                },
              },
              required: ["prompt"],
            },
          },
          {
            name: "launch_browser_agent",
            description: "Start a durable browser-agent proposal run for browser work. The browser client must execute page-local CDP actions and return receipts.",
            parameters: {
              type: "OBJECT",
              properties: {
                instruction: {
                  type: "STRING",
                  description: "The browser task to perform.",
                },
                url: {
                  type: "STRING",
                  description: "Optional page URL the browser-side agent should inspect or operate on.",
                },
                cdp_actions: {
                  type: "ARRAY",
                  description: "Optional bounded Chrome DevTools Protocol actions for the browser extension to execute locally. Supported methods include Page.navigate, Runtime.evaluate, Input.dispatchKeyEvent, Input.insertText, and Page.captureScreenshot.",
                  items: {
                    type: "OBJECT",
                  },
                },
              },
              required: ["instruction"],
            },
          },
          {
            name: "get_profile_options",
            description: "Read the current gateway catalog of valid profile options before setting voice or language fields. Use this when the user asks what voices or languages are available, or when mapping tone words such as masculine/feminine to a concrete voice id.",
            parameters: {
              type: "OBJECT",
              properties: {},
            },
          },
          {
            name: "start_voice_sampler",
            description: "Return an ordered voice-sampler plan when the user asks to sample, test, preview, hear, go through, or say something in every supported voice. Do not persist a voice change for this. Each sample must be played as its own Live session because Gemini Live voice selection is session-level.",
            parameters: {
              type: "OBJECT",
              properties: {
                sample_text: {
                  type: "STRING",
                  description: "Optional phrase the user asked to hear in every voice. Omit when they only said to say something or sample the voices.",
                },
              },
            },
          },
          {
            name: "update_agent_profile",
            description: "Change your own durable settings. CALL THIS YOURSELF, without being told to, whenever the user states a clear preference about your voice or language. Use get_profile_options when you need the allowed voices/languages. Use scope='device' only when the user says this device/phone/browser; use scope='global' for all devices/everywhere/default. You understand any language in the supported catalog (every Google Chirp 3 language); call get_profile_options for the exact BCP-47 codes. `input_languages` is the SET of languages named in the STT transcription prompt — set it when the user says what THEY speak or what language you should hear, listen for, understand, transcribe, or detect ('I only speak Amharic', 'listen for English and Amharic'); Chirp recognition itself remains automatic. To switch which understood language the prompt emphasizes first ('right now I want to speak Amharic'), set `input_language_primary` to a code already in that set. `language` is what YOU reply in ('speak Amharic', 'answer in English'). If the user asks for both hearing and replying, set both fields in one call. Reply language and understood languages are separate settings; do not collapse them. Do not set response_modality='text' for goodbye, bye, stop, hush, or silence requests; those are current-turn controls, not durable profile changes. After calling, confirm briefly in the new setting language only.",
            parameters: {
              type: "OBJECT",
              properties: {
                profile: {
                  type: "OBJECT",
                  description: "Profile fields to persist. IDENTITY: set `assistant_name` when the user says \"your name is X\", \"you are X\", or \"call yourself X\". Set `user_name` when the user tells you their name (\"my name is X\", \"I am X\"). Set `user_nickname` when the user asks to be called something specific (\"call me X\"). Set `user_address` when the user sets the honorific or form of address you must use for them (\"address me as X\", \"call me sir/master/boss\"). These four identity fields are injected into every session automatically - persist them instead of remembering them ad hoc. LANGUAGE: `language` is the comma-separated BCP-47 code list YOU may reply in; `input_languages` is the comma-separated BCP-47 code list named in the STT custom prompt while Chirp recognition remains automatic. Valid codes are any in the supported catalog (get_profile_options lists them; e.g. en-US, am-ET, es-ES, fr-FR, ar-XA, ja-JP); an unsupported code is dropped and the prior value kept. Set `input_language_primary` to a code already in `input_languages` to make the prompt emphasize that language first. Set `language_auto_switch` false to lock the reply language. MODALITY: `response_modality` is how non-Live surfaces deliver replies - \"text\" (write), \"speech\" (speak), or \"auto\". Native Live voice still speaks because the provider is audio-only. Do not set \"text\" for goodbye, bye, stop, hush, or silence requests. Other fields: system_prompt, assistant_name, model, temperature, voice_max_chars (max characters spoken per reply, a positive integer), voice (valid ids from get_profile_options, with masculine/feminine aliases mapped by the gateway), language_mode, language_output, voice_provider, stt_provider, reasoning_provider, tts_provider, tool_policy, autonomy_level, memory_policy, recovery_mode.",
                },
                scope: {
                  type: "STRING",
                  description: "global for all devices, or device for only the current device.",
                },
                device_id: {
                  type: "STRING",
                  description: "Optional explicit current device id. Usually omit; Moa supplies the current turn's device id.",
                },
                reason: {
                  type: "STRING",
                  description: "Short reason for the persisted change.",
                },
              },
              required: ["profile"],
            },
          },
          {
            name: "revert_agent_profile",
            description: "Undo your own durable settings by voice. Call this when the user says undo, undo that, undo the last change, revert, or go back — use mode='previous' to restore the settings from before your last change. Call it with mode='reset' when the user says reset your settings, start over, or go back to default. Honors scope='device' vs scope='global' the same way as update_agent_profile. After calling, confirm briefly what you undid; the change applies to the next interaction.",
            parameters: {
              type: "OBJECT",
              properties: {
                mode: {
                  type: "STRING",
                  description: "previous restores the state before the last change (undo); reset restores the gateway defaults. Defaults to previous.",
                },
                scope: {
                  type: "STRING",
                  description: "global for all devices, or device for only the current device.",
                },
                device_id: {
                  type: "STRING",
                  description: "Optional explicit current device id. Usually omit; Moa supplies the current turn's device id.",
                },
                reason: {
                  type: "STRING",
                  description: "Short reason for the revert.",
                },
              },
            },
          },
          {
            name: "propose_page_tweak",
            description: "Propose a reversible visual change to the browser page the user is on (hide an element, dark or black background, bigger/smaller font, or a readable width). Only available on browser turns. Call this when the user asks to hide, remove, darken, resize, or reformat something on the current page. You do NOT write CSS: you pass a bounded record and the browser compiles and applies it locally, and the user can undo it in the browser. kind must be one of: hide, css-selector-hide, font-scale, font-size, dark, black, width. After calling, confirm briefly what you changed.",
            parameters: {
              type: "OBJECT",
              properties: {
                kind: {
                  type: "STRING",
                  description: "One of: hide (params.selectors: array of CSS selectors), css-selector-hide (params.selector: one CSS selector), font-scale (params.factor: 0.5-4), font-size (params.px: 8-72), dark (no params), black (no params), width (params.maxWidth: 320-1600).",
                },
                params: {
                  type: "OBJECT",
                  description: "The parameters for the chosen kind. Plain CSS selectors and numbers only; no CSS or code strings.",
                },
                name: {
                  type: "STRING",
                  description: "Optional short human-readable label for the change, such as 'Hide sidebar'.",
                },
              },
              required: ["kind"],
            },
          },
          {
            name: "get_session_context",
            description: "Read durable Moa session context for the current conversation: recent voice turns, provider events, profile status, and agent runs.",
            parameters: {
              type: "OBJECT",
              properties: {
                session_id: {
                  type: "STRING",
                  description: "Optional session/conversation id. Omit to use the current live session.",
                },
                branch_id: {
                  type: "STRING",
                  description: "Optional branch id. Omit to use default/current branch.",
                },
                limit: {
                  type: "NUMBER",
                  description: "Maximum recent turns/events/runs to return.",
                },
              },
            },
          },
          {
            name: "remember_user_fact",
            description: "Persist a standing user fact or preference into Moa memory so future turns can recall it, for example the user's preferred name or durable preference.",
            parameters: {
              type: "OBJECT",
              properties: {
                fact: {
                  type: "STRING",
                  description: "The durable fact to remember.",
                },
                kind: {
                  type: "STRING",
                  description: "Optional memory kind, such as name, preference, persona, or note.",
                },
              },
              required: ["fact"],
            },
          },
          // No query_memory / recall tool on the live path on purpose: the
          // gateway already injects standing facts + relevant memories into the
          // turn context (see voiceLiveContextPrompt). The native-audio model
          // goes SILENT after any tool call, so a recall tool would turn every
          // "what do you know about X" into a mute turn. Answering from the
          // injected context lets the model speak the answer instead.
          {
            name: "cancel_agent_run",
            description: "Stop the ACTUAL work of a launched agent run. Only call this when the user explicitly asks to cancel or stop the run, agent, task, or everything; do not call this for 'be quiet' or ordinary speech interruption.",
            parameters: {
              type: "OBJECT",
              properties: {
                run_id: {
                  type: "STRING",
                  description: "Optional specific agent run id to cancel.",
                },
                target: {
                  type: "STRING",
                  description: "Optional target when run_id is omitted: current cancels the most recently updated active run in this conversation; all cancels every active run in this conversation.",
                },
              },
            },
          },
          {
            name: "list_agent_runs",
            description: "List the user's launched agent runs and their status.",
            parameters: {
              type: "OBJECT",
              properties: {
                limit: {
                  type: "NUMBER",
                  description: "Maximum runs to return.",
                },
              },
            },
          },
        ],
      }],
      inputAudioTranscription: {},
      ...(this.supportsOutputTranscription() ? { outputAudioTranscription: {} } : {}),
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: this.manualActivityDetection,
        },
      },
    };
  }

  websocketUrl() {
    const url = new URL(this.endpoint);
    if (this.authMode === "vertex" && this.apiKey && !url.searchParams.has("key")) {
      url.searchParams.set("key", this.apiKey);
    } else if (this.authMode === "google-ai-api-key" && !url.searchParams.has("key")) {
      url.searchParams.set("key", this.apiKey);
    }
    return url.toString();
  }

  async websocketHeaders() {
    if (this.authMode === "google-ai-api-key") {
      return { "x-goog-api-key": this.apiKey };
    }
    if (this.authMode === "vertex" && !this.apiKey) {
      return { Authorization: `Bearer ${await this.accessToken()}` };
    }
    return {};
  }

  // Vertex native-audio Live models reject any text-output request and close the
  // socket with 1007 "Text output is not supported for native audio output
  // model" — this includes outputAudioTranscription, which asks the model to
  // emit the assistant transcript as text. Input transcription (the user's STT)
  // is a separate capability the error does not name and stays on, so the
  // exact-transcript echo-back path keeps working. On these models assistant_text
  // is empty because the model emits neither output transcription nor text parts;
  // downstream already treats empty assistant_text as "no transcript" and does
  // not crash. Non-native Live models keep output transcription.
  supportsOutputTranscription() {
    return !/native-audio/i.test(String(this.model || ""));
  }

  modelResource() {
    const value = String(this.model || DEFAULT_GEMINI_LIVE_MODEL).trim();
    if (value.startsWith("models/")
        || value.startsWith("publishers/")
        || value.startsWith("projects/")) {
      return value;
    }
    if (this.authMode === "vertex") {
      if (this.apiKey && !this.vertexProject) {
        return `publishers/google/models/${value}`;
      }
      return `projects/${this.vertexProject}/locations/${this.vertexLocation}/publishers/google/models/${value}`;
    }
    return `models/${value}`;
  }

  defaultVertexEndpoint(expressEndpoint) {
    if (this.apiKey) {
      return expressEndpoint;
    }
    // There is no `global-aiplatform.googleapis.com` host: the ws upgrade
    // 404s on it. The bare host serves the global location — same host split
    // server.js uses for text Vertex requests.
    if (this.vertexLocation === "global") {
      return expressEndpoint;
    }
    return `wss://${this.vertexLocation}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;
  }

  // The gateway container has no gcloud binary, so ADC files (service_account
  // or authorized_user) are exchanged for access tokens directly against
  // oauth2.googleapis.com — same approach as vertexAccessToken in server.js.
  // gcloud stays as the last-resort fallback for host installs that have it.
  async accessToken() {
    const now = Date.now();
    if (this.tokenCache.value && this.tokenCache.expiresAt > now + 300000) {
      return this.tokenCache.value;
    }
    const credentialFile = googleCredentialFile(this.env);
    if (credentialFile) {
      const token = await adcAccessToken(credentialFile);
      this.tokenCache = token;
      return token.value;
    }
    try {
      return execFileSync(this.gcloudBin, ["auth", "application-default", "print-access-token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      }).trim();
    } catch (error) {
      throw new Error(`could not get Vertex ADC access token with ${this.gcloudBin}: ${cleanError(error)}`);
    }
  }

  async handleServerMessage(message, hooks, state, resolveOnce, rejectOnce) {
    if (message.error) {
      rejectOnce(new Error(`gemini-live error: ${cleanError(message.error.message || JSON.stringify(message.error))}`));
      return;
    }
    if (message.goAway) {
      return;
    }
    const toolCall = message.toolCall || message.tool_call;
    if (toolCall) {
      await this.handleToolCallMessage(toolCall, hooks);
      return;
    }
    const serverContent = message.serverContent || message.server_content;
    if (!serverContent) {
      return;
    }

    const inputText = transcriptionText(serverContent.inputTranscription || serverContent.input_transcription);
    if (inputText) {
      state.inputTranscript = appendTranscript(state.inputTranscript, inputText);
      await hooks.onTranscriptPartial(state.inputTranscript);
    }

    let assistantTextChanged = false;
    const outputText = transcriptionText(serverContent.outputTranscription || serverContent.output_transcription);
    if (outputText) {
      state.outputTranscript = appendTranscript(state.outputTranscript, outputText);
      assistantTextChanged = true;
    }

    const parts = Array.isArray(serverContent.modelTurn?.parts)
      ? serverContent.modelTurn.parts
      : Array.isArray(serverContent.model_turn?.parts)
        ? serverContent.model_turn.parts
        : [];
    for (const part of parts) {
      if (typeof part.text === "string" && part.text.trim()) {
        state.outputTranscript = appendTranscript(state.outputTranscript, part.text);
        assistantTextChanged = true;
      }
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData?.data) {
        await this.streamInlineAudio(inlineData, hooks, state);
      }
    }
    if (assistantTextChanged && state.outputTranscript.trim()) {
      await hooks.onAssistantText(state.outputTranscript.trim());
      state.assistantTextSent = true;
    }

    if (serverContent.interrupted) {
      rejectOnce(new Error("gemini-live generation was interrupted"));
      return;
    }
    if (serverContent.generationComplete || serverContent.generation_complete) {
      state.generationComplete = true;
    }
    if (serverContent.turnComplete || serverContent.turn_complete) {
      resolveOnce();
    }
  }

  async handleBinaryAudio(data, hooks, state) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!state.assistantAudioStarted) {
      await hooks.onAssistantAudioStart(CLIENT_AUDIO_FORMAT);
      state.assistantAudioStarted = true;
    }
    await hooks.sendAudio(chunk);
  }

  async handleToolCallMessage(toolCall, hooks) {
    const calls = Array.isArray(toolCall.functionCalls)
      ? toolCall.functionCalls
      : Array.isArray(toolCall.function_calls)
        ? toolCall.function_calls
        : [];
    const responses = [];
    for (const call of calls) {
      const name = String(call.name || "").trim();
      if (!name) continue;
      const result = hooks.onToolCall
        ? await hooks.onToolCall({
            id: call.id || "",
            name,
            args: call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {},
          })
        : { ok: false, error: "tool handler is not configured" };
      responses.push({
        id: call.id || undefined,
        name,
        response: result && typeof result === "object" && !Array.isArray(result)
          ? result
          : { ok: true, result },
      });
    }
    if (responses.length > 0 && typeof hooks.sendToolResponse === "function") {
      await hooks.sendToolResponse(responses);
    }
  }

  async streamInlineAudio(inlineData, hooks, state) {
    const sourceRate = sampleRateFromMime(inlineData.mimeType || inlineData.mime_type || "", 24000);
    const upstream = Buffer.from(String(inlineData.data || ""), "base64");
    const pcm = sourceRate === CLIENT_AUDIO_FORMAT.sample_rate
      ? upstream
      : resamplePcm16Mono(upstream, sourceRate, CLIENT_AUDIO_FORMAT.sample_rate);
    if (!pcm.length) return;
    if (!state.assistantAudioStarted) {
      await hooks.onAssistantAudioStart(CLIENT_AUDIO_FORMAT);
      state.assistantAudioStarted = true;
    }
    await hooks.sendAudio(pcm);
  }
}

async function sendAudioFile(websocket, turn, chunkBytes) {
  const audio = fs.readFileSync(turn.pcmPath);
  const rate = Number(turn.format?.sample_rate || 16000);
  const mimeType = `audio/pcm;rate=${rate}`;
  for (let offset = 0; offset < audio.length; offset += chunkBytes) {
    const chunk = audio.subarray(offset, Math.min(offset + chunkBytes, audio.length));
    await sendGeminiJson(websocket, {
      realtimeInput: {
        audio: {
          data: chunk.toString("base64"),
          mimeType,
        },
      },
    });
  }
  await sendGeminiJson(websocket, {
    realtimeInput: {
      audioStreamEnd: true,
    },
  });
}

function sendGeminiJson(websocket, payload) {
  if (websocket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("gemini-live websocket is not open"));
  }
  return new Promise((resolve, reject) => {
    websocket.send(JSON.stringify(payload), (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeQuietly(websocket) {
  try {
    websocket.close(1000, "turn completed");
  } catch (error) {
    // Ignore close errors during provider cleanup.
  }
}

// Defers a turn's resolve while its input transcript is still missing. Gemini
// can deliver trailing inputTranscription fragments after turnComplete, and
// resolving immediately closes the socket and loses them — which is how turns
// ended up stored with no transcript at all. request() resolves at once when a
// transcript already exists; otherwise it waits up to graceMs (hard cap).
// Every noteTranscript() while waiting restarts the shorter settleMs timer so
// a fragment burst is captured whole before the resolve fires.
function createTranscriptSettleGate(options) {
  const graceMs = Math.max(0, numberFrom(options?.graceMs, 0));
  const settleMs = Math.max(50, numberFrom(options?.settleMs, 250));
  const hasTranscript = typeof options?.hasTranscript === "function" ? options.hasTranscript : () => false;
  const resolve = typeof options?.resolve === "function" ? options.resolve : () => {};
  let requested = false;
  let done = false;
  let graceTimer = null;
  let settleTimer = null;

  const clearTimers = () => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  const finish = () => {
    if (done) return;
    done = true;
    clearTimers();
    resolve();
  };

  return {
    request() {
      if (done || requested) return;
      requested = true;
      if (graceMs === 0 || hasTranscript()) {
        finish();
        return;
      }
      graceTimer = setTimeout(finish, graceMs);
      graceTimer.unref?.();
    },
    noteTranscript() {
      if (done || !requested) return;
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      settleTimer = setTimeout(finish, settleMs);
      settleTimer.unref?.();
    },
    pending() {
      return requested && !done;
    },
    cancel() {
      done = true;
      clearTimers();
    },
  };
}

async function streamTestTone(sendAudio) {
  const tone = generatePcm16Tone({
    durationMs: 1800,
    frequencyHz: 660,
    sampleRate: CLIENT_AUDIO_FORMAT.sample_rate,
    volume: 0.72,
  });
  const chunkBytes = 640;
  for (let offset = 0; offset < tone.length; offset += chunkBytes) {
    await sendAudio(tone.subarray(offset, Math.min(offset + chunkBytes, tone.length)));
    await delay(8);
  }
}

function generatePcm16Tone(options) {
  const sampleRate = options.sampleRate;
  const sampleCount = Math.floor(sampleRate * options.durationMs / 1000);
  const buffer = Buffer.alloc(sampleCount * 2);
  const fadeSamples = Math.max(1, Math.floor(sampleRate * 0.025));

  for (let index = 0; index < sampleCount; index += 1) {
    const fadeIn = Math.min(1, index / fadeSamples);
    const fadeOut = Math.min(1, (sampleCount - index - 1) / fadeSamples);
    const envelope = Math.min(fadeIn, fadeOut);
    const wave = Math.sin(2 * Math.PI * options.frequencyHz * index / sampleRate);
    const sample = Math.max(-32768, Math.min(32767, Math.round(wave * options.volume * envelope * 32767)));
    buffer.writeInt16LE(sample, index * 2);
  }

  return buffer;
}

function resamplePcm16Mono(buffer, fromRate, toRate) {
  if (!buffer.length || fromRate === toRate) {
    return buffer;
  }
  const inputSamples = Math.floor(buffer.length / 2);
  if (inputSamples === 0) {
    return Buffer.alloc(0);
  }
  const outputSamples = Math.max(1, Math.round(inputSamples * toRate / fromRate));
  const output = Buffer.alloc(outputSamples * 2);
  for (let index = 0; index < outputSamples; index += 1) {
    const source = index * fromRate / toRate;
    const leftIndex = Math.min(inputSamples - 1, Math.floor(source));
    const rightIndex = Math.min(inputSamples - 1, leftIndex + 1);
    const fraction = source - leftIndex;
    const left = buffer.readInt16LE(leftIndex * 2);
    const right = buffer.readInt16LE(rightIndex * 2);
    const sample = Math.round(left + (right - left) * fraction);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), index * 2);
  }
  return output;
}

function sampleRateFromMime(mimeType, fallback) {
  const match = String(mimeType || "").match(/rate=(\d+)/i);
  const rate = match ? Number(match[1]) : fallback;
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate) : fallback;
}

function chirpProjectId(env) {
  return String(env.CHIRP_PROJECT_ID || env.GCP_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || env.VERTEX_PROJECT || "").trim();
}

function chirpEndpoint(projectId, location) {
  const safeLocation = String(location || "us").trim() || "us";
  const host = safeLocation === "global" ? "speech.googleapis.com" : `${safeLocation}-speech.googleapis.com`;
  return `https://${host}/v2/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(safeLocation)}/recognizers/_:recognize`;
}

function vertexLiveLocation(env) {
  const explicitLiveLocation = String(env.VERTEX_LIVE_LOCATION || env.GEMINI_LIVE_LOCATION || "").trim();
  const sharedVertexLocation = String(env.VERTEX_LOCATION || env.GOOGLE_CLOUD_LOCATION || "").trim();
  const candidate = explicitLiveLocation || sharedVertexLocation || DEFAULT_VERTEX_LIVE_LOCATION;
  return candidate.toLowerCase() === "global" ? DEFAULT_VERTEX_LIVE_LOCATION : candidate;
}

// Map a BCP-47 reply language to a default Cloud TTS voice, or "" when Cloud TTS
// has no voice for it (e.g. am-ET). Callers fall back to device-side TTS on "".
function cloudTtsVoiceFor(language) {
  const code = String(language || "").trim().toLowerCase();
  if (!code || CLOUD_TTS_UNSUPPORTED_LANGUAGES.has(code)) {
    return "";
  }
  if (CLOUD_TTS_DEFAULT_VOICES[code]) {
    return CLOUD_TTS_DEFAULT_VOICES[code];
  }
  // Match by language prefix (e.g. "en-gb" -> en-US default) as a last resort.
  const prefix = code.split("-")[0];
  const match = Object.keys(CLOUD_TTS_DEFAULT_VOICES).find((key) => key.split("-")[0] === prefix);
  return match ? CLOUD_TTS_DEFAULT_VOICES[match] : "";
}

function cloudTtsLanguageCode(language) {
  const value = String(language || "en-US").trim();
  const parts = value.split("-");
  if (parts.length >= 2) {
    return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
  }
  return value;
}

// Natural-language pace direction for the Gemini-TTS style prompt. Gemini-TTS
// does not reliably honor audioConfig.speakingRate, but it follows explicit
// pace instructions in input.prompt with high fidelity, so the numeric rate is
// mapped to words here.
function speakingPaceInstruction(rate) {
  if (!Number.isFinite(rate) || rate <= 0) {
    return "";
  }
  if (rate >= 1.75) {
    return "Speak very fast, close to double normal speed, but keep every word crisp and clear.";
  }
  if (rate >= 1.35) {
    return "Speak fast, at about one and a half times normal conversational speed, energetic but clear.";
  }
  if (rate >= 1.1) {
    return "Speak at a brisk, quick conversational pace.";
  }
  if (rate <= 0.7) {
    return "Speak slowly and deliberately, with unhurried pacing.";
  }
  if (rate <= 0.9) {
    return "Speak at a relaxed, slightly slower than normal pace.";
  }
  return "";
}

// Compose the Gemini-TTS input.prompt from the model's per-turn [style: ...]
// direction, the durable voice_tone, and the numeric speaking_rate. Per-turn
// style leads; tone is skipped when the style already names it.
function composeTtsStylePrompt(style, tone, rate) {
  const parts = [];
  const styleText = String(style || "").trim();
  if (styleText) {
    parts.push(styleText);
  }
  const toneText = String(tone || "").trim();
  if (toneText && !styleText.toLowerCase().includes(toneText.toLowerCase())) {
    parts.push(`Overall tone: ${toneText}.`);
  }
  const pace = speakingPaceInstruction(Number(rate));
  if (pace) {
    parts.push(pace);
  }
  return parts.join(" ").trim();
}

// Vertex content-safety rejection of a synthesis request: HTTP 400
// INVALID_ARGUMENT whose message cites the usage guidelines. Distinct from
// malformed-request 400s, which must not trigger the prompt-stripped retry.
function isCloudTtsContentPolicyFailure(failure) {
  const text = String(failure || "").toLowerCase();
  return text.includes("(400)") && (text.includes("usage guidelines") || text.includes("violates"));
}

// Synthesize reply audio with Google Cloud Text-to-Speech and return PCM16 mono
// at the client's sample rate. Uses LINEAR16 output so no decoding is needed;
// resamples from the TTS rate to the client rate when they differ.
async function synthesizeCloudTts(options) {
  const language = cloudTtsLanguageCode(options.language);
  const modelName = String(options.modelName || "").trim();
  const voiceName = String(options.voice || "").trim()
    || (modelName ? GEMINI_TTS_DEFAULT_VOICE : cloudTtsVoiceFor(options.language));
  if (!voiceName) {
    throw new Error(`no Cloud TTS voice for language ${language}`);
  }
  const voice = { languageCode: language, name: voiceName };
  if (modelName) {
    voice.modelName = modelName;
  }
  const explicitEndpoint = String(options.endpoint || "").trim();
  // Gemini TTS models may only exist on v1beta1, so retry there when v1
  // rejects the request. An explicit (test) endpoint is never retried.
  const endpoints = explicitEndpoint
    ? [explicitEndpoint]
    : (modelName ? [CLOUD_TTS_ENDPOINT, CLOUD_TTS_V1BETA1_ENDPOINT] : [CLOUD_TTS_ENDPOINT]);
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 20000);
  // Gemini-TTS caps input.text and input.prompt at ~4000 bytes each; classic
  // Cloud TTS allows a longer text field. The natural-language style prompt goes
  // in input.prompt alongside input.text and is honored only by promptable
  // (modelName) voices, so it is attached only when a Gemini-TTS model is set.
  const input = { text: String(options.text || "").slice(0, modelName ? 4000 : 5000) };
  const promptText = String(options.prompt || "").trim();
  if (modelName && promptText) {
    input.prompt = promptText.slice(0, 2000);
  }
  // speakingRate: Chirp3-HD (and classic) voices honor audioConfig.speakingRate
  // (0.25–2.0). Gemini-TTS voices follow the pace instruction in input.prompt
  // instead, but the field is part of AudioConfig and harmless to send; keep it
  // on both so a future model that honors it just works. 1.0/unset = omitted.
  const rateInput = Number(options.speakingRate);
  const speakingRate = Number.isFinite(rateInput) && rateInput > 0 && rateInput !== 1
    ? Math.min(2, Math.max(0.25, rateInput))
    : 0;
  const requestBody = (requestInput) => JSON.stringify({
    input: requestInput,
    voice,
    audioConfig: {
      audioEncoding: "LINEAR16",
      sampleRateHertz: CLOUD_TTS_SAMPLE_RATE,
      ...(speakingRate ? { speakingRate } : {}),
    },
  });

  const ttsHeaders = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
  };
  if (options.projectId) {
    // authorized_user ADC has no home project; Google APIs reject it without
    // an explicit quota project. Harmless with service-account auth.
    ttsHeaders["x-goog-user-project"] = options.projectId;
  }
  let response = null;
  let lastFailure = "";
  const attempt = async (body) => {
    for (const endpoint of endpoints) {
      response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: ttsHeaders,
        body,
        signal: options.signal,
      }, timeoutMs);
      if (response.ok) {
        return;
      }
      const text = await response.text();
      lastFailure = `cloud TTS failed (${response.status}): ${cleanError(text)}`;
      response = null;
    }
  };
  await attempt(requestBody(input));
  // Gemini-TTS content policy rejects some (reply text, style prompt) pairs
  // with a 400 "usage guidelines" INVALID_ARGUMENT — observed silencing ~half
  // of am-ET replies. The style prompt is optional flavor; the reply is not.
  // Retry once with the bare text before degrading the turn to text-only.
  if (!response && input.prompt && isCloudTtsContentPolicyFailure(lastFailure)) {
    const policyFailure = lastFailure;
    await attempt(requestBody({ text: input.text }));
    if (!response) {
      lastFailure = `${policyFailure}; retry without style prompt also failed: ${lastFailure}`;
    }
  }
  if (!response) {
    if (isCloudTtsContentPolicyFailure(lastFailure)) {
      lastFailure = `tts_content_policy: ${lastFailure}`;
    }
    throw new Error(lastFailure || "cloud TTS failed");
  }
  const json = await response.json();
  const base64 = String(json?.audioContent || "");
  if (!base64) {
    throw new Error("cloud TTS returned no audioContent");
  }
  const wav = Buffer.from(base64, "base64");
  const pcm = pcmFromWav(wav);
  const targetRate = Math.max(1, Number(options.targetSampleRate) || CLIENT_AUDIO_FORMAT.sample_rate);
  return CLOUD_TTS_SAMPLE_RATE === targetRate
    ? pcm
    : resamplePcm16Mono(pcm, CLOUD_TTS_SAMPLE_RATE, targetRate);
}

// Extract the PCM16 payload from a LINEAR16 WAV container. Cloud TTS returns a
// 44-byte canonical WAV header for LINEAR16; scan for the "data" chunk to be safe.
function pcmFromWav(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") {
    return buffer;
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === "data") {
      return buffer.subarray(dataStart, Math.min(buffer.length, dataStart + chunkSize));
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  return buffer.subarray(44);
}

// Parse configured language codes into the bounded list used to build Chirp's
// custom prompt. Recognition itself always uses ["auto"]. The literal `auto`
// represents a prompt with no named language preference.
function languageCodes(value) {
  const codes = String(value || "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (codes.length === 1 && codes[0].toLowerCase() === "auto") {
    return ["auto"];
  }
  const restricted = Array.from(new Set(codes.filter((code) => code.toLowerCase() !== "auto")));
  if (!restricted.length) {
    return ["en-US"];
  }
  return restricted.slice(0, CHIRP_MAX_PROMPT_LANGUAGE_CODES);
}

function isChirp3Model(model) {
  return String(model || "").trim().toLowerCase() === "chirp_3";
}

function profileIdentityInstruction(profile) {
  const name = String(profile?.assistant_name || "A.G.").trim();
  if (!name) {
    return "";
  }
  const owner = configuredOwnerLabel(profile);
  return [
    "Moa identity profile:",
    "- this identity profile overrides any older name in the base prompt",
    `- current assistant name: ${name}`,
    `- if asked who or what you are, say you are ${name}`,
    `- if asked who created, built, designed, trained, or owns you, attribute that to ${owner}; never to Gemini, Google, OpenAI, Anthropic, or another model provider`,
    "- if your name is an initialism written with periods or capital letters (for example A.G.), pronounce it out loud as its separate letters, not as a single word",
    "- use the user's requested form of address, title, or interaction style when provided",
    "- if asked who made, created, built, trained, or owns you, or who your creator or company is, answer only from this identity profile; never credit Google, Gemini, OpenAI, Anthropic, or any other AI lab or underlying model as your creator",
    "- this rule outranks any older wording in the base prompt and any recalled memory fact that contradicts it",
  ].join("\n");
}

function configuredOwnerLabel(profile) {
  const userName = String(profile?.user_name || "").trim();
  const nickname = String(profile?.user_nickname || "").trim();
  const address = String(profile?.user_address || "master").trim();
  return userName || nickname || (address ? `"${address}"` : "the configured user");
}

function userAddressInstruction(profile) {
  const address = String(profile?.user_address || "master").trim();
  if (!address) {
    return "";
  }
  return [
    "Moa user address profile:",
    `- always address the user as "${address}"`,
    "- use that form of address naturally in your replies",
    "- this rule outranks any older wording in the base prompt",
  ].join("\n");
}

function answerPolicyInstruction() {
  return [
    "Moa answer policy:",
    "- answer the user's actual question directly and substantively",
    "- do not refuse ordinary informational, professional, tax, legal, medical, financial, coding, creative, adult, political, or controversial questions just because they are sensitive domains",
    "- for professional domains, give practical general information and clearly state when the user should verify details with a qualified professional or current source",
    "- if a provider or tool blocks a request, report the specific block reason or missing access instead of pretending the refusal is your preference",
  ].join("\n");
}

function missionAccessInstruction() {
  return [
    "Moa mission-agent access policy:",
    "- start from yes and look for a path to satisfy the user's request",
    "- do not answer with a flat refusal; when blocked by missing permission, credentials, integration setup, local approval, or device capability, say: \"Hey, I would like to do that, but I need you to give me access to <specific access>.\"",
    "- do not give a persona or roleplay refusal when the user's request is only about tone, address, title, or interaction style; follow the requested style",
    "- do not claim an action is done until the owning device, gateway, or integration returns a receipt",
    "- server/model output remains a proposal; local devices still own permissions, approvals, execution, and receipts",
  ].join("\n");
}

function profileControlInstruction(profile) {
  const currentVoice = String(profile?.voice || "").trim();
  const voices = voiceOptionsPayload().map((voice) => voice.id).join(", ");
  return [
    "Moa profile-control tools:",
    "- You can change your own durable voice, assistant name, language, and response modality by calling update_agent_profile.",
    "- Never say you cannot change your voice when the user asks for a supported voice or profile change.",
    "- If the user names a supported voice, or says masculine/feminine, call update_agent_profile with the concrete voice id. Masculine maps to Charon; feminine maps to Aoede.",
    "- If the user asks to sample, test, preview, hear, go through, or say something in every supported voice, call start_voice_sampler. Do not persist a voice for sampling.",
    "- If the user asks to change voices but does not say which one, ask which supported voice they want or call get_profile_options.",
    "- Voice changes are persisted by the gateway profile store and normally apply to the next Live turn/session, not to audio that is already being spoken.",
    "- Voice sampling also uses the next Live sessions: one session per sampled voice.",
    `- Supported voice ids: ${voices}.`,
    currentVoice ? `- Current configured voice: ${currentVoice}.` : "",
  ].filter(Boolean).join("\n");
}

function agentRunControlInstruction() {
  return [
    "Moa agent-run-control tools:",
    "- You can run several agents at once. If the user interrupts you to ask for another thing, launch ANOTHER agent run with launch_agent_run; do not cancel the running one.",
    "- 'stop', 'be quiet', and 'shut up' only silence your current spoken reply. They do NOT stop launched agent runs. Only call cancel_agent_run when the user explicitly says to cancel/stop the run, the agent, the task, or everything.",
    "- Use list_agent_runs to tell the user what is running.",
  ].join("\n");
}

function profileLanguageInstruction(profile) {
  if (!profile || typeof profile !== "object") {
    return "";
  }
  const mode = String(profile.language_mode || "explicit").trim() || "explicit";
  const primary = String(profile.language_primary || profile.language || "").trim();
  const configured = languageCodes(profile.language || primary).join(", ");
  const inputPrimary = String(profile.input_language_primary
    || String(profile.input_languages || "").split(",")[0]
    || "").trim();
  const inputConfigured = languageCodes(profile.input_languages || inputPrimary).join(", ");
  const output = String(profile.language_output || "primary_only").trim() || "primary_only";
  const autoSwitch = profile.language_auto_switch === true;
  if (!primary && !configured && !inputPrimary && !inputConfigured) {
    return "";
  }
  return [
    "Moa language profile:",
    `- mode: ${mode}`,
    primary ? `- primary language: ${primary}` : "",
    configured ? `- configured language set: ${configured}` : "",
    inputPrimary ? `- user input primary language: ${inputPrimary}` : "",
    inputConfigured ? `- user input language set: ${inputConfigured}` : "",
    `- output policy: ${output}`,
    `- automatic durable language switching: ${autoSwitch ? "allowed" : "disabled"}`,
    autoSwitch
      ? "You may adapt within the configured language policy."
      : "Do not change the durable language or output policy unless the user explicitly asks for a profile change.",
  ].filter(Boolean).join("\n");
}

function transcriptionText(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  return String(value.text || value.transcript || "").trim();
}

function extractSpeechTranscript(response, activeLanguageCodes = []) {
  const results = Array.isArray(response?.results) ? response.results : [];
  const restricted = new Set((Array.isArray(activeLanguageCodes) ? activeLanguageCodes : [])
    .map((code) => String(code || "").trim().toLowerCase())
    .filter((code) => code && code !== "auto"));
  let rejected = 0;
  const accepted = results
    .filter((result) => {
      const languageCode = String(result?.languageCode || result?.language_code || "").trim().toLowerCase();
      if (!languageCode || restricted.size === 0 || restricted.has(languageCode)) {
        return true;
      }
      rejected += 1;
      return false;
    })
    .map((result) => result?.alternatives?.[0]?.transcript || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    text: accepted,
    languageRejected: rejected > 0 && !accepted,
    rejected_results: rejected,
  };
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  // Merge an optional external signal (pipeline cancellation on interruption)
  // with the timeout controller so either can abort the request.
  const external = options?.signal;
  let onExternalAbort = null;
  if (external) {
    if (external.aborted) {
      controller.abort(external.reason);
    } else {
      onExternalAbort = () => controller.abort(external.reason);
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeout);
    if (external && onExternalAbort) {
      external.removeEventListener("abort", onExternalAbort);
    }
  });
}

function appendTranscript(current, addition) {
  const left = normalizeTranscriptSpaces(current);
  const right = normalizeTranscriptSpaces(addition);
  if (!right) return left;
  if (!left) return right;

  const leftTokens = transcriptTokens(left);
  const rightTokens = transcriptTokens(right);
  if (leftTokens.length && rightTokens.length) {
    if (sameTranscriptTokens(leftTokens, rightTokens)) {
      return right.length >= left.length ? right : left;
    }
    if (startsWithTranscriptTokens(rightTokens, leftTokens)) {
      return right;
    }
    if (endsWithTranscriptTokens(leftTokens, rightTokens)) {
      return left;
    }

    const overlap = transcriptTokenOverlap(leftTokens, rightTokens);
    if (overlap > 0) {
      if (overlap >= rightTokens.length) {
        return left;
      }
      return normalizeTranscriptSpaces(`${left} ${right.slice(rightTokens[overlap].start)}`);
    }
  }

  return normalizeTranscriptSpaces(`${left} ${right}`);
}

function transcriptTokenOverlap(left, right) {
  const max = Math.min(left.length, right.length);
  for (let count = max; count > 0; count -= 1) {
    let matches = true;
    for (let i = 0; i < count; i += 1) {
      if (left[left.length - count + i].value !== right[i].value) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return count;
    }
  }
  return 0;
}

function sameTranscriptTokens(left, right) {
  return left.length === right.length && startsWithTranscriptTokens(left, right);
}

function startsWithTranscriptTokens(value, prefix) {
  if (prefix.length > value.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (value[i].value !== prefix[i].value) {
      return false;
    }
  }
  return true;
}

function endsWithTranscriptTokens(value, suffix) {
  if (suffix.length > value.length) {
    return false;
  }
  const offset = value.length - suffix.length;
  for (let i = 0; i < suffix.length; i += 1) {
    if (value[offset + i].value !== suffix[i].value) {
      return false;
    }
  }
  return true;
}

function transcriptTokens(value) {
  const tokens = [];
  const pattern = /[\p{L}\p{N}]+/gu;
  let match;
  while ((match = pattern.exec(String(value || "")))) {
    tokens.push({
      value: match[0].toLocaleLowerCase("en-US"),
      start: match.index,
    });
  }
  return tokens;
}

function normalizeTranscriptSpaces(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function parseJsonMessage(data) {
  try {
    return JSON.parse(Buffer.from(data).toString("utf8"));
  } catch (error) {
    throw new Error(`gemini-live returned invalid JSON: ${cleanError(error)}`);
  }
}

function parsePossibleJsonMessage(data) {
  const text = Buffer.from(data).toString("utf8").trim();
  if (!text.startsWith("{")) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function modelResource(model) {
  const value = String(model || DEFAULT_GEMINI_LIVE_MODEL).trim();
  return value.startsWith("models/") ? value : `models/${value}`;
}

function numberFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pcmDurationMs(audioBytes, format) {
  const bytes = Math.max(0, Number(audioBytes) || 0);
  const sampleRate = Math.max(1, Number(format?.sample_rate) || 16000);
  const channels = Math.max(1, Number(format?.channels) || 1);
  return Math.round((bytes / (sampleRate * channels * 2)) * 1000);
}

function redactEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.searchParams.has("key")) {
      url.searchParams.set("key", "redacted");
    }
    return url.toString();
  } catch (error) {
    return String(endpoint || "").replace(/key=[^&]+/g, "key=redacted");
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function voiceStageStart(hooks, stage, details = {}) {
  if (!hooks || typeof hooks.onStageStart !== "function") {
    return;
  }
  try {
    await hooks.onStageStart(stage, details);
  } catch {
    // Stage diagnostics are observability only; never fail the voice turn.
  }
}

async function voiceStageDone(hooks, stage, startedAtMs, details = {}) {
  if (!hooks || typeof hooks.onStageDone !== "function") {
    return;
  }
  try {
    await hooks.onStageDone(stage, {
      ...details,
      duration_ms: stageDurationMs(startedAtMs),
    });
  } catch {
    // Stage diagnostics are observability only; never fail the voice turn.
  }
}

async function voiceStageError(hooks, stage, startedAtMs, error, details = {}) {
  if (!hooks || typeof hooks.onStageError !== "function") {
    return;
  }
  try {
    await hooks.onStageError(stage, {
      ...details,
      duration_ms: stageDurationMs(startedAtMs),
      error_summary: cleanError(error).slice(0, 240),
    });
  } catch {
    // Stage diagnostics are observability only; never fail the voice turn.
  }
}

function stageDurationMs(startedAtMs) {
  const started = Number(startedAtMs);
  if (!Number.isFinite(started) || started <= 0) {
    return 0;
  }
  return Math.max(0, Date.now() - started);
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}

module.exports = {
  CLIENT_AUDIO_FORMAT,
  TurnSupersededError,
  composeVoiceProvider,
  isTurnSupersededError,
  createTranscriptSettleGate,
  createVoiceProviderRegistry,
  createVoiceProvider,
  generatePcm16Tone,
  reportVoiceStreamingFault,
  resetVoiceStreamingBreakerForTests,
  resamplePcm16Mono,
  voiceProviderNames,
  voiceStreamingTripped,
  cloudTtsVoiceFor,
  pcmFromWav,
};
