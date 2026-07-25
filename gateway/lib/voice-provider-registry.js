// Voice provider registry data: the catalog of native-live/STT/reasoning/TTS
// providers, their capability flags, and the alias tables that normalize
// user-facing provider names. Pure data + normalizers — the concrete provider
// classes stay in voice-providers.js and arrive here as factories, so adding
// a provider is one registry entry instead of an if/else branch. Extracted
// from voice-providers.js (source-size policy).

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
const PROVIDER_ALIASES_TTS = Object.freeze({
  "chirp-tts": "cloud-tts",
  "cloud-text-to-speech": "cloud-tts",
  "google-tts": "cloud-tts",
  "gemini-flash-tts": "gemini-tts",
  "gemini-3.1-flash-tts": "gemini-tts",
  "gemini-tts-preview": "gemini-tts",
});

function providerName(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, "-");
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

function buildVoiceProviderRegistry(factories) {
  const {
    chirpConfigured,
    vertexLiveConfigured,
    createLoopback,
    createGeminiLive,
    createVertexLive,
    createCascaded,
  } = factories;
  return Object.freeze({
    native_live: Object.freeze({
      loopback: providerRegistryEntry({
        id: "loopback",
        label: "Loopback transport QA",
        capabilities: {
          assistant_audio: true,
          voice_output: true,
        },
        configured: () => true,
        create: createLoopback,
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
        create: createGeminiLive,
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
        create: createVertexLive,
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
        create: createCascaded,
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
}

module.exports = {
  PROVIDER_TYPES,
  PROVIDER_CAPABILITY_FLAGS,
  providerName,
  registryProviderId,
  capabilities,
  buildVoiceProviderRegistry,
};
