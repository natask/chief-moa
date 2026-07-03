"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { WebSocket } = require("ws");
const { safeSystemPromptForProvider } = require("./agent-profile");
const { voiceOptionsPayload } = require("./profile-options");

const CLIENT_AUDIO_FORMAT = {
  encoding: "pcm16",
  sample_rate: 16000,
  channels: 1,
};
const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
const DEFAULT_VERTEX_LIVE_MODEL = "gemini-live-2.5-flash-native-audio";
const DEFAULT_CHIRP_MODEL = "chirp_3";
// Chirp 3 language-restricted recognition holds a primary language plus at most
// ONE alternative. Passing more codes (or the "auto" sentinel) drops the request
// back to auto language detection, where the codes become hints only. Capping at
// two keeps CHIRP_LANGUAGE_CODES a true allowlist (for example en-US,am-ET).
const CHIRP_MAX_LANGUAGE_CODES = 2;
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
    }),
  }),
  reasoning: Object.freeze({
    gateway: providerRegistryEntry({
      id: "gateway",
      label: "A.G. gateway voice-turn router",
      capabilities: {},
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
    none: providerRegistryEntry({
      id: "none",
      label: "No hosted TTS",
      capabilities: {},
      configured: () => true,
    }),
  }),
});

function createVoiceProvider(options) {
  const env = options?.env || process.env;
  const names = voiceProviderNames(env);
  if (names.stt === "chirp") {
    return new ChirpSttVoiceProvider(options);
  }
  if (allSameProvider(names, "loopback") || allSameProvider(names, "test")) {
    return new LoopbackVoiceProvider(options);
  }
  if (allSameProvider(names, "gemini-live")) {
    return new GeminiLiveVoiceProvider(options, {
      provider: "gemini-live",
      defaultModel: DEFAULT_GEMINI_LIVE_MODEL,
      defaultEndpoint: GEMINI_LIVE_ENDPOINT,
      authMode: "google-ai-api-key",
    });
  }
  if (allSameProvider(names, "vertex-live")) {
    return new GeminiLiveVoiceProvider(options, {
      provider: "vertex-live",
      defaultModel: DEFAULT_VERTEX_LIVE_MODEL,
      defaultEndpoint: VERTEX_LIVE_EXPRESS_ENDPOINT,
      authMode: "vertex",
    });
  }
  return new UnsupportedVoiceProvider(options, names);
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
  return PROVIDER_ALIASES[normalized] || normalized;
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
    const transcript = "Fake transcript for the streaming voice MVP.";
    const assistantText = "Streaming voice transport is connected. I received your audio and can play this test tone.";
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

class ChirpSttVoiceProvider {
  constructor(options) {
    const env = options?.env || process.env;
    this.env = env;
    this.names = voiceProviderNames(env);
    this.projectId = chirpProjectId(env);
    this.location = String(env.CHIRP_LOCATION || env.GCP_LOCATION || env.GOOGLE_CLOUD_LOCATION || "us").trim() || "us";
    this.model = String(env.CHIRP_MODEL || env.VOICE_STT_MODEL || DEFAULT_CHIRP_MODEL).trim() || DEFAULT_CHIRP_MODEL;
    // Restricted recognition: en-US,am-ET stays an allowlist, never a hint set.
    // am-ET is only available on chirp_3, so force chirp_3 whenever any Amharic
    // (am*) code is requested, even if the env asks for an older Chirp model.
    this.languageCodes = restrictedChirpLanguageCodes(env.CHIRP_LANGUAGE_CODES || env.CHIRP_LANGUAGE_CODE || env.GEMINI_LIVE_LANGUAGE_CODE || env.MODEL_LANGUAGE || "en-US");
    if (this.languageCodes.some((code) => /^am(-|$)/i.test(code)) && this.model !== DEFAULT_CHIRP_MODEL) {
      this.model = DEFAULT_CHIRP_MODEL;
    }
    this.timeoutMs = Math.max(5000, numberFrom(env.CHIRP_TIMEOUT_MS || env.VOICE_PROVIDER_TIMEOUT_MS, 30000));
    this.gcloudBin = env.GCLOUD_BIN || "gcloud";
    this.staticAccessToken = env.CHIRP_ACCESS_TOKEN || env.GCP_ACCESS_TOKEN || "";
    this.serviceAccountKeyJson = env.CHIRP_SERVICE_ACCOUNT_KEY || env.GCP_SERVICE_ACCOUNT_KEY || "";
    this.serviceAccountKeyFile = env.CHIRP_SERVICE_ACCOUNT_KEY_FILE || env.GOOGLE_APPLICATION_CREDENTIALS || "";
    this.tokenCache = { value: "", expiresAt: 0 };
  }

  configured() {
    return chirpConfigured(this.env);
  }

  endpoint() {
    return chirpEndpoint(this.projectId, this.location);
  }

  status() {
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
      language_codes: this.languageCodes,
      input_audio_format: CLIENT_AUDIO_FORMAT,
      assistant_audio_format: CLIENT_AUDIO_FORMAT,
      transcription_only: true,
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
    if (!turn.audioBytes || turn.audioBytes <= 0) {
      throw new Error("cannot send an empty audio turn to chirp");
    }

    const transcript = await this.transcribePcmFile(turn);
    if (transcript) {
      await hooks.onTranscriptFinal(transcript);
    }
    return {
      provider: "chirp",
      model: this.model,
      transcript,
      assistant_text: "",
      audio_format: CLIENT_AUDIO_FORMAT,
      transcription_only: true,
    };
  }

  async transcribePcmFile(turn) {
    const audio = fs.readFileSync(turn.pcmPath);
    const sampleRate = Math.max(1, Number(turn.format?.sample_rate || CLIENT_AUDIO_FORMAT.sample_rate));
    const channels = Math.max(1, Number(turn.format?.channels || CLIENT_AUDIO_FORMAT.channels));
    const token = await this.accessToken();
    const response = await fetchWithTimeout(this.endpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        config: {
          // Explicit decoding (not autoDecodingConfig) plus a restricted
          // languageCodes list is what actually pins recognition to the
          // allowlist. Combining auto decoding / an "auto" language code with
          // languageCodes drops Chirp 3 back to auto language detection, so
          // this.languageCodes is already stripped of "auto" and capped at
          // primary + one alternative by restrictedChirpLanguageCodes.
          explicitDecodingConfig: {
            encoding: "LINEAR16",
            sampleRateHertz: sampleRate,
            audioChannelCount: channels,
          },
          languageCodes: this.languageCodes,
          model: this.model,
          features: {
            enableAutomaticPunctuation: true,
          },
        },
        content: audio.toString("base64"),
      }),
    }, this.timeoutMs);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`chirp STT failed (${response.status}): ${cleanError(text)}`);
    }
    return extractSpeechTranscript(await response.json());
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
    this.vertexLocation = env.VERTEX_LOCATION || env.GOOGLE_CLOUD_LOCATION || "global";
    this.gcloudBin = env.GCLOUD_BIN || "gcloud";
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
      throw new Error(`${this.provider} voice provider requires VERTEX_EXPRESS_API_KEY, VERTEX_API_KEY, GOOGLE_API_KEY, or Vertex ADC with VERTEX_PROJECT and VERTEX_LOCATION on the gateway machine`);
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
    if (!hadRealTranscript) {
      state.inputTranscript = "Voice captured.";
    }
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
      transcript: state.inputTranscript.trim(),
      // "stt" when the provider returned a real input transcript; "synthetic"
      // when we fell back to a placeholder because STT produced nothing. Lets
      // the client tell a real echo-back from "Voice captured."
      transcript_source: hadRealTranscript ? "stt" : "synthetic",
      assistant_text: state.outputTranscript.trim(),
      audio_format: CLIENT_AUDIO_FORMAT,
    };
  }

  createLiveTurnSession(turn, hooks) {
    if (!this.configured()) {
      throw new Error(`${this.provider} voice provider requires VERTEX_EXPRESS_API_KEY, VERTEX_API_KEY, GOOGLE_API_KEY, or Vertex ADC with VERTEX_PROJECT and VERTEX_LOCATION on the gateway machine`);
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
    const websocket = new WebSocket(this.websocketUrl(), {
      headers: this.websocketHeaders(),
      maxPayload: 32 * 1024 * 1024,
    });
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
          resolveOnce();
        }
      }, this.audioIdleCompleteMs);
      idleTimer.unref();
    };

    const result = () => {
      const sttTranscript = state.inputTranscript.trim();
      const textTurnText = String(turn.syntheticText || "").trim();
      // Real STT wins; a text_turn's typed text is "text"; otherwise the
      // placeholder is "synthetic". Lets the client and echo-back tell what was
      // actually heard from a fallback.
      const transcriptSource = sttTranscript ? "stt" : (textTurnText ? "text" : "synthetic");
      return {
        provider: this.provider,
        model: this.model,
        transcript: sttTranscript || textTurnText || "Voice captured.",
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
        await this.handleServerMessage(message, hooks, state, resolveOnce, rejectOnce);
        if (state.assistantAudioStarted && !state.generationComplete) {
          scheduleIdleComplete();
        }
      });
    });

    websocket.on("error", rejectOnce);
    websocket.on("close", (code, reason) => {
      closed = true;
      if (!state.completed && !state.rejected) {
        rejectOnce(new Error(`gemini-live websocket closed before turn completion: ${code} ${Buffer.from(reason || "").toString("utf8")}`));
      }
    });

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

  runWebSocketTurn(turn, hooks, state) {
    return new Promise((resolve, reject) => {
      const websocket = new WebSocket(this.websocketUrl(), {
        headers: this.websocketHeaders(),
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
            resolveOnce();
          }
        }, this.audioIdleCompleteMs);
        idleTimer.unref();
      };

      const resolveOnce = () => {
        if (state.resolved || state.rejected) return;
        state.resolved = true;
        state.completed = true;
        clearIdleTimer();
        clearTimeout(timeout);
        websocket.close(1000, "turn completed");
        resolve();
      };
      const rejectOnce = (error) => {
        if (state.resolved || state.rejected) return;
        state.rejected = true;
        clearIdleTimer();
        clearTimeout(timeout);
        reject(error);
      };

      websocket.on("open", () => {
        websocket.send(JSON.stringify({ setup: this.setupMessage(turn) }), (error) => {
          if (error) rejectOnce(error);
        });
      });

      websocket.on("message", (data, isBinary) => {
        chain = chain.then(async () => {
          if (isBinary) {
            const message = parsePossibleJsonMessage(data);
            if (message) {
              if (message.setupComplete) {
                await sendAudioFile(websocket, turn, this.sendChunkBytes);
                return;
              }
              await this.handleServerMessage(message, hooks, state, resolveOnce, rejectOnce);
              if (state.assistantAudioStarted && !state.generationComplete) {
                scheduleIdleComplete();
              }
              return;
            }
            await this.handleBinaryAudio(data, hooks, state);
            scheduleIdleComplete();
            return;
          }
          const message = parseJsonMessage(data);
          if (message.setupComplete) {
            await sendAudioFile(websocket, turn, this.sendChunkBytes);
            return;
          }
          await this.handleServerMessage(message, hooks, state, resolveOnce, rejectOnce);
          if (state.assistantAudioStarted && !state.generationComplete) {
            scheduleIdleComplete();
          }
        }).catch(rejectOnce);
      });

      websocket.on("error", rejectOnce);
      websocket.on("close", (code, reason) => {
        if (!state.completed && !state.rejected) {
          rejectOnce(new Error(`gemini-live websocket closed before turn completion: ${code} ${Buffer.from(reason || "").toString("utf8")}`));
        }
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
            description: "Change your own durable settings. CALL THIS YOURSELF, without being told to, whenever the user states a clear preference about your voice or language. Use get_profile_options when you need the allowed voices/languages. Use scope='device' only when the user says this device/phone/browser; use scope='global' for all devices/everywhere/default. Supported languages are currently English and Amharic only. If the user says what language THEY speak ('I only speak Amharic', 'I can speak English and Amharic'), set input_languages. If they ask what language YOU reply in ('speak Amharic', 'answer in English'), set language. Do not infer unrelated languages. Do not set response_modality='text' for goodbye, bye, stop, hush, or silence requests; those are current-turn controls, not durable profile changes. After calling, confirm briefly in your reply.",
            parameters: {
              type: "OBJECT",
              properties: {
                profile: {
                  type: "OBJECT",
                  description: "Profile fields to persist. IDENTITY: set `assistant_name` when the user says \"your name is X\", \"you are X\", or \"call yourself X\". LANGUAGE: `language` is the comma-separated BCP-47 code list YOU may reply in; `input_languages` is the comma-separated BCP-47 code list the USER may speak. Currently valid language codes are en-US and am-ET only. The gateway derives primary language from the first code, so do not expose primary language as a user-facing setting. Set `language_auto_switch` false to lock. MODALITY: `response_modality` is how non-Live surfaces deliver replies - \"text\" (write), \"speech\" (speak), or \"auto\". Native Live voice still speaks because the provider is audio-only. Do not set \"text\" for goodbye, bye, stop, hush, or silence requests. Other fields: system_prompt, assistant_name, model, temperature, voice_max_chars (max characters spoken per reply, a positive integer), voice (valid ids from get_profile_options, with masculine/feminine aliases mapped by the gateway), language_mode, language_output, voice_provider, stt_provider, reasoning_provider, tts_provider, tool_policy, autonomy_level, memory_policy, recovery_mode.",
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

  websocketHeaders() {
    if (this.authMode === "google-ai-api-key") {
      return { "x-goog-api-key": this.apiKey };
    }
    if (this.authMode === "vertex" && !this.apiKey) {
      return { Authorization: `Bearer ${this.accessToken()}` };
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
    return `wss://${this.vertexLocation}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;
  }

  accessToken() {
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

function languageCodes(value) {
  const codes = String(value || "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return codes.length ? Array.from(new Set(codes)).slice(0, 10) : ["en-US"];
}

// Chirp 3 language-restricted recognition. On Chirp 3, languageCodes=["auto"]
// (or an "auto" value mixed into the list) turns restriction OFF: the model
// detects the spoken language on its own and any listed codes become hints only.
// To truly restrict recognition you must send explicit BCP-47 codes with NO
// "auto" sentinel, and Chirp 3's restricted mode holds a primary plus at most
// ONE alternative. This strips any "auto" sentinel, dedupes, and caps at primary
// + one alternative so a request that lists e.g. "en-US,am-ET" restricts
// recognition to exactly those two languages instead of falling back to
// auto-detection. am-ET requires the chirp_3 model.
function restrictedChirpLanguageCodes(value) {
  const codes = String(value || "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => entry.toLowerCase() !== "auto");
  const deduped = Array.from(new Set(codes));
  return deduped.length ? deduped.slice(0, CHIRP_MAX_LANGUAGE_CODES) : ["en-US"];
}

function profileIdentityInstruction(profile) {
  const name = String(profile?.assistant_name || "A.G.").trim();
  if (!name) {
    return "";
  }
  return [
    "Moa identity profile:",
    "- this identity profile overrides any older name in the base prompt",
    `- current assistant name: ${name}`,
    `- if asked who or what you are, say you are ${name}`,
    "- if your name is an initialism written with periods or capital letters (for example A.G.), pronounce it out loud as its separate letters, not as a single word",
    "- use the user's requested form of address, title, or interaction style when provided",
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

function extractSpeechTranscript(response) {
  const results = Array.isArray(response?.results) ? response.results : [];
  return results
    .map((result) => result?.alternatives?.[0]?.transcript || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
}

async function serviceAccountAccessToken(serviceAccountKeyJson) {
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountKeyJson);
  } catch (error) {
    throw new Error(`invalid GCP service account JSON: ${cleanError(error)}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: serviceAccount.private_key_id,
  };
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    scope: "https://www.googleapis.com/auth/cloud-platform",
  };
  const unsigned = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), serviceAccount.private_key);
  const assertion = `${unsigned}.${base64url(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GCP token exchange failed (${response.status}): ${cleanError(text)}`);
  }
  const token = await response.json();
  return {
    value: String(token.access_token || ""),
    expiresAt: Date.now() + Math.max(1, Number(token.expires_in || 3600)) * 1000,
  };
}

function base64urlJson(value) {
  return base64url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}

module.exports = {
  CLIENT_AUDIO_FORMAT,
  createVoiceProviderRegistry,
  createVoiceProvider,
  generatePcm16Tone,
  resamplePcm16Mono,
  voiceProviderNames,
};
