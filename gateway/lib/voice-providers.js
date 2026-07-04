"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
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
const DEFAULT_VERTEX_LIVE_LOCATION = "us-central1";
const DEFAULT_CHIRP_MODEL = "chirp_3";
// On Chirp, true language-restricted recognition is a primary code plus AT MOST
// one alternate. Passing more codes (or combining codes with auto-decoding)
// demotes them to hints and auto-detection still runs. We cap to two so the
// STT request restricts recognition instead of hinting it.
const CHIRP_MAX_RESTRICTED_LANGUAGE_CODES = 2;
// Languages that only exist on Chirp 3 (Preview). If one of these is configured
// but the model is an older Chirp, recognition would silently fall back. am-ET
// (Amharic) is the concrete case for the {en-US, am-ET} pipeline.
const CHIRP_3_ONLY_LANGUAGE_CODES = ["am-ET"];
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
    "cloud-tts": providerRegistryEntry({
      id: "cloud-tts",
      label: "Google Cloud Text-to-Speech (Chirp 3 HD where available)",
      capabilities: {
        voice_output: true,
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

// Cloud TTS has no Amharic (am-ET) voice under any type; it does have en-US HD
// voices. The cascaded pipeline synthesizes hosted audio for languages that
// have a voice and falls back to device-side (android-tts) playback otherwise.
const CLOUD_TTS_DEFAULT_VOICES = Object.freeze({
  "en-us": "en-US-Chirp3-HD-Aoede",
});
// Languages Cloud TTS cannot speak today, so the cascaded path returns the
// reply as text and lets the device speak it (android-tts).
const CLOUD_TTS_UNSUPPORTED_LANGUAGES = Object.freeze(new Set(["am-et", "am"]));
const CLOUD_TTS_SAMPLE_RATE = 24000;
const PROVIDER_ALIASES_TTS = Object.freeze({
  "chirp-tts": "cloud-tts",
  "cloud-text-to-speech": "cloud-tts",
  "google-tts": "cloud-tts",
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
    this.languageCodes = languageCodes(env.CHIRP_LANGUAGE_CODES || env.CHIRP_LANGUAGE_CODE || env.GEMINI_LIVE_LANGUAGE_CODE || env.MODEL_LANGUAGE || "en-US");
    // Codes that require chirp_3 (e.g. am-ET). If any are configured with an
    // older model, recognition degrades silently, so we surface it and refuse.
    this.chirp3OnlyLanguages = chirp3OnlyLanguages(this.languageCodes);
    this.timeoutMs = Math.max(5000, numberFrom(env.CHIRP_TIMEOUT_MS || env.VOICE_PROVIDER_TIMEOUT_MS, 30000));
    this.gcloudBin = env.GCLOUD_BIN || "gcloud";
    this.staticAccessToken = env.CHIRP_ACCESS_TOKEN || env.GCP_ACCESS_TOKEN || "";
    this.serviceAccountKeyJson = env.CHIRP_SERVICE_ACCOUNT_KEY || env.GCP_SERVICE_ACCOUNT_KEY || "";
    this.serviceAccountKeyFile = env.CHIRP_SERVICE_ACCOUNT_KEY_FILE || env.GOOGLE_APPLICATION_CREDENTIALS || "";
    this.tokenCache = { value: "", expiresAt: 0 };
    // Cascaded pipeline wiring. `reasoner` is injected by the gateway; when set,
    // the provider runs STT -> reasoner (the gateway's durable LLM turn) -> TTS
    // in one turn instead of STT-only. When unset, it stays STT-only so the
    // legacy transcript-then-android-TTS path and the STT smoke keep working.
    this.reasoner = typeof options?.reasoner === "function" ? options.reasoner : null;
    this.agentProfile = options?.agentProfile || null;
    this.ttsProviderId = registryProviderId(this.names.tts);
    this.ttsVoice = String(env.CHIRP_TTS_VOICE || env.CLOUD_TTS_VOICE || "").trim();
    this.ttsModel = String(env.CHIRP_TTS_MODEL || "").trim();
  }

  // The cascaded pipeline is active when a reasoner is wired AND a hosted TTS
  // provider is selected. Otherwise the provider is STT-only (transcript back to
  // the gateway, device speaks the reply).
  cascaded() {
    return Boolean(this.reasoner) && this.ttsProviderId === "cloud-tts";
  }

  configured() {
    return chirpConfigured(this.env);
  }

  // am-ET and other Chirp-3-only languages require model=chirp_3. Fail loudly
  // rather than let recognition silently fall back to an unrestricted result.
  assertModelSupportsLanguages() {
    if (this.chirp3OnlyLanguages.length > 0 && !isChirp3Model(this.model)) {
      throw new Error(`chirp language codes ${this.chirp3OnlyLanguages.join(", ")} require model=chirp_3, but CHIRP_MODEL is ${this.model || "unset"}`);
    }
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
      // "restricted": the request truly limits recognition to language_codes.
      // "auto": language-agnostic (auto-detect) because CHIRP_LANGUAGE_CODES=auto.
      language_recognition: this.languageCodes[0] === "auto" ? "auto" : "restricted",
      requires_chirp_3: this.chirp3OnlyLanguages.length > 0,
      chirp_3_only_languages: this.chirp3OnlyLanguages,
      // "cascaded": STT -> gateway LLM turn -> hosted Cloud TTS reply audio.
      // "stt_only": transcript only; the device speaks the reply.
      pipeline: this.cascaded() ? "cascaded" : "stt_only",
      tts_provider_id: this.ttsProviderId,
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
    this.assertModelSupportsLanguages();
    if (!turn.audioBytes || turn.audioBytes <= 0) {
      throw new Error("cannot send an empty audio turn to chirp");
    }

    // Leg 1 — streaming Chirp 3 STT, restricted to the configured languages.
    const transcript = await this.transcribePcmFile(turn);
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
      };
    }

    // Leg 2 — the gateway's durable, model-agnostic LLM turn. The reasoner reads
    // the effective agent profile (reply language/voice as OUTPUT policy) and
    // returns the spoken reply text plus the reply language. A control/agent-run
    // turn returns no speak text; we then skip TTS.
    let reasoning = { speak: "", display: transcript, language: this.replyLanguage(), model: this.model, classification: "chat" };
    if (!transcript) {
      return this.cascadedResult(transcript, reasoning, false);
    }
    try {
      const result = await this.reasoner({
        transcript,
        session_id: turn.sessionId || turn.session_id || "",
        conversation_id: turn.conversationId || turn.conversation_id || "",
        branch_id: turn.branchId || turn.branch_id || "",
        turn_id: turn.turnId || turn.turn_id || "",
        source: turn.source || "voice-cascaded",
      });
      reasoning = { ...reasoning, ...(result && typeof result === "object" ? result : {}) };
    } catch (error) {
      throw new Error(`cascaded reasoning failed: ${cleanError(error)}`);
    }

    const speak = String(reasoning.speak || "").trim();
    if (speak) {
      await hooks.onAssistantText(speak);
    }

    // Leg 3 — Cloud TTS reply audio. Synthesize only when the reply language has
    // a hosted voice (e.g. en-US). For a language with no hosted voice (am-ET),
    // skip synthesis and let the device speak the reply text (android fallback).
    let spoke = false;
    if (speak && this.canSynthesize(reasoning.language)) {
      try {
        const pcm = await this.synthesizeSpeech(speak, reasoning.language);
        if (pcm && pcm.length) {
          await hooks.onAssistantAudioStart(CLIENT_AUDIO_FORMAT);
          await hooks.sendAudio(pcm);
          await hooks.onAssistantAudioDone();
          spoke = true;
        }
      } catch (error) {
        // TTS is best-effort: a synthesis failure must not drop the reply text.
        // The device can still speak `assistant_text`.
        spoke = false;
      }
    }

    return this.cascadedResult(transcript, reasoning, spoke);
  }

  cascadedResult(transcript, reasoning, spoke) {
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
      classification: reasoning.classification || "chat",
    };
  }

  // The reply (OUTPUT) language from the effective agent profile, falling back to
  // the primary STT language. This is output policy, distinct from the restricted
  // INPUT languages the STT leg recognizes.
  replyLanguage() {
    const profile = this.agentProfile && typeof this.agentProfile.effective === "function"
      ? this.agentProfile.effective()
      : null;
    const fromProfile = String(profile?.language || profile?.language_primary || "").trim();
    return fromProfile || this.languageCodes[0] || "en-US";
  }

  canSynthesize(language) {
    const code = String(language || this.replyLanguage() || "").trim().toLowerCase();
    if (!code || CLOUD_TTS_UNSUPPORTED_LANGUAGES.has(code)) {
      return false;
    }
    return Boolean(this.ttsVoice) || Boolean(cloudTtsVoiceFor(code));
  }

  async synthesizeSpeech(text, language) {
    const token = await this.accessToken();
    return synthesizeCloudTts({
      text,
      language: language || this.replyLanguage(),
      voice: this.ttsVoice,
      token,
      location: this.location,
      projectId: this.projectId,
      timeoutMs: this.timeoutMs,
      targetSampleRate: CLIENT_AUDIO_FORMAT.sample_rate,
    });
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
          // explicitDecodingConfig fixes the audio ENCODING (LINEAR16 PCM). It
          // is deliberately used instead of autoDecodingConfig: pairing
          // auto-decoding with languageCodes demotes the codes to hints and
          // Chirp keeps auto-detecting the language. With explicit decoding plus
          // a capped languageCodes list (primary + at most one alternate),
          // recognition is RESTRICTED to the configured languages.
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

// Synthesize reply audio with Google Cloud Text-to-Speech and return PCM16 mono
// at the client's sample rate. Uses LINEAR16 output so no decoding is needed;
// resamples from the TTS rate to the client rate when they differ.
async function synthesizeCloudTts(options) {
  const language = cloudTtsLanguageCode(options.language);
  const voiceName = String(options.voice || "").trim() || cloudTtsVoiceFor(options.language);
  if (!voiceName) {
    throw new Error(`no Cloud TTS voice for language ${language}`);
  }
  const endpoint = "https://texttospeech.googleapis.com/v1/text:synthesize";
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: { text: String(options.text || "").slice(0, 5000) },
      voice: { languageCode: language, name: voiceName },
      audioConfig: {
        audioEncoding: "LINEAR16",
        sampleRateHertz: CLOUD_TTS_SAMPLE_RATE,
      },
    }),
  }, Math.max(5000, Number(options.timeoutMs) || 30000));

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`cloud TTS failed (${response.status}): ${cleanError(text)}`);
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

// Parse configured language codes into a Chirp language-RESTRICTED list: primary
// code plus at most one alternate. This is the difference between "restrict" and
// "hint" on Chirp — more than two codes turns restriction into auto-detection.
// The literal value "auto" (language-agnostic) is passed through untouched.
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
  return restricted.slice(0, CHIRP_MAX_RESTRICTED_LANGUAGE_CODES);
}

// Chirp-3-only languages (e.g. am-ET) require the chirp_3 model. Returns the
// list of configured codes that would silently degrade on an older model, so
// the provider can assert chirp_3 before it issues a recognize call.
function chirp3OnlyLanguages(codes) {
  const only = new Set(CHIRP_3_ONLY_LANGUAGE_CODES.map((code) => code.toLowerCase()));
  return (Array.isArray(codes) ? codes : []).filter((code) => only.has(String(code).toLowerCase()));
}

function isChirp3Model(model) {
  return String(model || "").trim().toLowerCase() === "chirp_3";
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

// Mirrors googleCredentialFile in server.js, but reads from the provider's
// env so tests can inject credentials without touching process.env.
function googleCredentialFile(env) {
  const explicit = env.GOOGLE_APPLICATION_CREDENTIALS || "";
  if (explicit && fs.existsSync(explicit)) return explicit;
  const adc = path.join(env.HOME || "", ".config", "gcloud", "application_default_credentials.json");
  return fs.existsSync(adc) ? adc : "";
}

// ADC files come in two shapes: a service_account key (signed-JWT exchange)
// and an authorized_user refresh token from `gcloud auth application-default
// login`. Both exchange directly against oauth2.googleapis.com — no gcloud
// binary needed in the container.
async function adcAccessToken(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`failed to read Google ADC file: ${cleanError(error)}`);
  }
  let credential;
  try {
    credential = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid Google ADC JSON: ${cleanError(error)}`);
  }
  if (credential.type === "service_account") {
    return serviceAccountAccessToken(raw);
  }
  if (credential.type === "authorized_user") {
    return authorizedUserAccessToken(credential);
  }
  throw new Error(`unsupported Google ADC credential type: ${credential.type || "missing"}`);
}

async function authorizedUserAccessToken(credential) {
  const missing = ["client_id", "client_secret", "refresh_token"].filter((key) => !credential[key]);
  if (missing.length > 0) {
    throw new Error(`authorized-user ADC is missing ${missing.join(", ")}`);
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credential.client_id,
      client_secret: credential.client_secret,
      refresh_token: credential.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`authorized-user token refresh failed (${response.status}): ${cleanError(text)}`);
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
  createTranscriptSettleGate,
  createVoiceProviderRegistry,
  createVoiceProvider,
  generatePcm16Tone,
  resamplePcm16Mono,
  voiceProviderNames,
  cloudTtsVoiceFor,
  pcmFromWav,
};
