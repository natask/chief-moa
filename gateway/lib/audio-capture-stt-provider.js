"use strict";

const { createVoiceProvider, createVoiceProviderRegistry } = require("./voice-providers");

const DEFAULT_MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const STT_WINDOW_SECONDS = 55;

function createAudioCaptureSttProvider({
  env = process.env,
  providerId = env.CAPTURE_TRANSCRIPTION_STT_PROVIDER || "",
  providerFactory = createVoiceProvider,
  registryFactory = createVoiceProviderRegistry,
  maxAudioBytes = Number(env.CAPTURE_TRANSCRIPTION_MAX_AUDIO_BYTES || DEFAULT_MAX_AUDIO_BYTES),
} = {}) {
  const registry = registryFactory({ env });
  const selectedId = normalizeProviderId(providerId || registry?.selected_providers?.stt);
  const limit = boundedInteger(maxAudioBytes, "max_audio_bytes", 1, 1024 * 1024 * 1024);
  const entry = (registry?.providers?.stt || []).find((candidate) => candidate.id === selectedId);
  const availability = providerAvailability(selectedId, entry);
  let provider = null;
  let lastRuntimeError = "";
  let runtimeAttempted = false;
  let runtimeSucceeded = false;

  function requireProviderId() {
    if (!availability.available) throw providerUnavailable(availability.reason);
    return selectedId;
  }

  async function transcriberForClaim(claim) {
    requireProviderId();
    if (claim?.provider_id !== selectedId) throw providerUnavailable("claim provider does not match configured capture STT provider");
    if (!provider) {
      provider = providerFactory({
        env: {
          ...env,
          VOICE_PROVIDER: selectedId,
          VOICE_STT_PROVIDER: selectedId,
          VOICE_REASONING_PROVIDER: "gateway",
          VOICE_LLM_PROVIDER: "gateway",
          VOICE_TTS_PROVIDER: "none",
        },
        reasoner: null,
        agentProfile: null,
      });
    }
    if (typeof provider?.transcribePcmBuffer !== "function") {
      throw providerUnavailable("configured capture STT provider has no retained-PCM adapter");
    }
    return {
      async transcribe({ audio }) {
        try {
          const format = parseLinearPcmContentType(audio?.contentType);
          if (!format) throw transcriptionError("unsupported retained audio format; expected PCM16 audio/L16", "unsupported_audio_format", false);
          const bytes = await readBounded(audio, limit);
          if (bytes.length % (format.channels * 2) !== 0) {
            throw transcriptionError("retained PCM ends mid-sample frame", "invalid_audio", false);
          }
          const result = await transcribePcmWindowed(
            provider,
            bytes,
            format.sampleRate,
            format.channels,
            claim.language_profile.languages,
            { input_languages: claim.language_profile.languages.join(",") },
          );
          const text = String(result?.text || "");
          if (!text.trim()) throw transcriptionError("STT provider returned no transcript", "empty_transcript", true);
          runtimeAttempted = true;
          runtimeSucceeded = true;
          lastRuntimeError = "";
          return {
            text,
            provider: { id: selectedId, model: String(provider.model || "").slice(0, 160) },
            language_evidence: result?.languageRejected ? [] : claim.language_profile.languages,
          };
        } catch (error) {
          const safe = safeProviderError(error);
          runtimeAttempted = true;
          runtimeSucceeded = false;
          lastRuntimeError = safe.message;
          throw safe;
        }
      },
    };
  }

  function status() {
    return {
      provider_id: selectedId || null,
      registry_configured: entry?.configured === true,
      available: availability.available,
      reason: availability.available ? null : availability.reason,
      accepted_formats: ["audio/L16; rate=<hz>; channels=<count>"],
      max_audio_bytes: limit,
      runtime_ready: availability.available
        ? (runtimeAttempted ? runtimeSucceeded : null)
        : false,
      last_runtime_error: lastRuntimeError || null,
    };
  }

  return Object.freeze({ requireProviderId, transcriberForClaim, status, registry });
}

async function transcribePcmWindowed(provider, audio, sampleRate, channels, languages, effectiveProfile) {
  const frameBytes = channels * 2;
  const bytesPerSecond = sampleRate * frameBytes;
  let windowBytes = Math.max(frameBytes, Math.floor(STT_WINDOW_SECONDS * bytesPerSecond));
  windowBytes -= windowBytes % frameBytes;
  if (audio.length <= windowBytes) {
    return provider.transcribePcmBuffer(audio, sampleRate, channels, languages, effectiveProfile);
  }
  const texts = [];
  let anyRejected = false;
  for (let offset = 0; offset < audio.length; offset += windowBytes) {
    const window = audio.subarray(offset, Math.min(offset + windowBytes, audio.length));
    if (window.length < frameBytes) break;
    const result = await provider.transcribePcmBuffer(
      window,
      sampleRate,
      channels,
      languages,
      effectiveProfile,
    );
    if (result?.text) texts.push(String(result.text));
    if (result?.languageRejected) anyRejected = true;
  }
  const text = texts.join(" ").replace(/\s+/g, " ").trim();
  return { text, languageRejected: anyRejected && !text, windowed: true };
}

function providerAvailability(providerId, entry) {
  if (!providerId) return { available: false, reason: "no capture STT provider is selected" };
  if (!entry) return { available: false, reason: `${providerId} is not a registered retained-audio STT provider` };
  if (entry.configured !== true) return { available: false, reason: `${providerId} capture STT provider is not configured` };
  return { available: true, reason: "" };
}

function parseLinearPcmContentType(value) {
  const text = String(value || "").trim();
  if (!/^audio\/(?:l16|pcm)(?:;|$)/i.test(text)) return null;
  const rate = Number(text.match(/(?:^|;)\s*rate=(\d+)/i)?.[1] || 16000);
  const channels = Number(text.match(/(?:^|;)\s*channels=(\d+)/i)?.[1] || 1);
  if (!Number.isSafeInteger(rate) || rate < 8000 || rate > 192000) return null;
  if (!Number.isSafeInteger(channels) || channels < 1 || channels > 8) return null;
  return { sampleRate: rate, channels };
}

async function readBounded(audio, maxBytes) {
  const declared = Number(audio?.size);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw transcriptionError(`retained audio exceeds ${maxBytes} bytes`, "audio_too_large", false);
  }
  if (!audio?.stream || typeof audio.stream[Symbol.asyncIterator] !== "function") {
    throw transcriptionError("retained audio stream is unavailable", "audio_unavailable", true);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of audio.stream) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw transcriptionError(`retained audio exceeds ${maxBytes} bytes`, "audio_too_large", false);
    chunks.push(bytes);
  }
  if (!total) throw transcriptionError("retained audio is empty", "invalid_audio", false);
  return Buffer.concat(chunks, total);
}

function providerUnavailable(message) { return transcriptionError(message, "provider_unavailable", false); }
function transcriptionError(message, code, retryable) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}
function safeProviderError(error) {
  const known = new Set(["unsupported_audio_format", "audio_too_large", "audio_unavailable", "invalid_audio", "empty_transcript"]);
  if (known.has(error?.code)) return error;
  return transcriptionError("capture STT provider request failed", "provider_request_failed", true);
}
function normalizeProviderId(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, "-").slice(0, 120);
}
function boundedInteger(value, field, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return number;
}
module.exports = {
  DEFAULT_MAX_AUDIO_BYTES,
  createAudioCaptureSttProvider,
  parseLinearPcmContentType,
  readBounded,
  transcribePcmWindowed,
};
