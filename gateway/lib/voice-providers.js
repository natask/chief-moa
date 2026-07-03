"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { WebSocket } = require("ws");

const CLIENT_AUDIO_FORMAT = {
  encoding: "pcm16",
  sample_rate: 16000,
  channels: 1,
};
const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
const DEFAULT_VERTEX_LIVE_MODEL = "gemini-live-2.5-flash-native-audio";
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
      label: "Moa gateway voice-turn router",
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
    this.sendChunkBytes = Math.max(3200, numberFrom(env.GEMINI_LIVE_SEND_CHUNK_BYTES, 32000));
    this.systemPrompt = options?.systemPrompt || env.SYSTEM_PROMPT || "You are Moa. Speak tersely. Address the user by their preferred name when known; otherwise avoid titles and honorifics. Never call the user Master. Keep replies short enough for voice.";
  }

  // The voice used for the NEXT session/turn: the effective agent profile's
  // `voice` when set, otherwise the env default. Read fresh each call so a
  // profile change applies on the next turn without restarting the provider.
  effectiveVoice() {
    if (this.agentProfile && typeof this.agentProfile.effective === "function") {
      const profileVoice = this.agentProfile.effective().voice;
      if (typeof profileVoice === "string" && profileVoice.trim()) {
        return profileVoice.trim();
      }
    }
    return this.envVoiceName;
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
      language_code: this.languageCode || null,
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

    if (!state.inputTranscript.trim()) {
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

    const result = () => ({
      provider: this.provider,
      model: this.model,
      transcript: state.inputTranscript.trim() || "Voice captured.",
      assistant_text: state.outputTranscript.trim(),
      audio_format: CLIENT_AUDIO_FORMAT,
    });

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
      commit: () => {
        if (closed || state.resolved || state.rejected) {
          return;
        }
        queueProviderTask(async () => {
          if (!ready) {
            await readyPromise;
          }
          await sendGeminiJson(websocket, {
            realtimeInput: {
              audioStreamEnd: true,
            },
          });
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
    const speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: this.effectiveVoice(),
        },
      },
    };
    if (this.languageCode) {
      speechConfig.languageCode = this.languageCode;
    }
    const systemParts = [{ text: this.systemPrompt }];
    const contextPrompt = String(turn?.contextPrompt || "").trim();
    if (contextPrompt) {
      systemParts.push({ text: contextPrompt });
    }

    return {
      model: this.modelResource(),
      generationConfig: {
        responseModalities: ["AUDIO"],
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
            description: "Start a durable Moa gateway agent run on the home machine for work that should continue outside the live voice response.",
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
            name: "update_agent_profile",
            description: "Persist a requested change to the live assistant profile, such as voice, model, system prompt, language, autonomy, memory policy, or tool policy. Use this when the user asks to change how this agent behaves.",
            parameters: {
              type: "OBJECT",
              properties: {
                profile: {
                  type: "OBJECT",
                  description: "Profile fields to persist. Supported fields include system_prompt, model, temperature, voice, language, language_mode, language_primary, language_output, language_auto_switch, voice_provider, stt_provider, reasoning_provider, tts_provider, tool_policy, autonomy_level, memory_policy, and recovery_mode.",
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
          {
            name: "query_memory",
            description: "Recall standing and relevant memories from Moa's durable memory store.",
            parameters: {
              type: "OBJECT",
              properties: {
                query: {
                  type: "STRING",
                  description: "The memory query.",
                },
                limit: {
                  type: "NUMBER",
                  description: "Maximum memories to return.",
                },
              },
            },
          },
        ],
      }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
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
  const left = String(current || "").trim();
  const right = String(addition || "").trim();
  if (!right) return left;
  if (!left) return right;
  if (right.startsWith(left)) return right;
  if (left.endsWith(right)) return left;
  return `${left} ${right}`.replace(/\s+/g, " ").trim();
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
  cloudTtsVoiceFor,
  pcmFromWav,
};
