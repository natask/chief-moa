"use strict";

class TranscriptSidecarVoiceProvider {
  constructor(primary, sidecar, sidecarId) {
    this.primary = primary;
    this.sidecar = sidecar;
    this.sidecarId = sidecarId;
    this.sidecarTurns = new WeakSet();
    if (typeof primary.synthesizeAssistantSpeech === "function") {
      this.synthesizeAssistantSpeech = (...args) => primary.synthesizeAssistantSpeech(...args);
    }
  }

  status() {
    const primary = this.primary.status();
    const sidecar = this.sidecar.status();
    return {
      ...primary,
      selected_providers: { ...(primary.selected_providers || {}), transcript_sidecar: this.sidecarId },
      transcript_sidecar: {
        enabled: true,
        provider: sidecar.provider || this.sidecarId,
        configured: sidecar.configured === true,
        model: sidecar.model || null,
        language_codes: Array.isArray(sidecar.language_codes) ? sidecar.language_codes : [],
        prompt_language_codes: Array.isArray(sidecar.prompt_language_codes) ? sidecar.prompt_language_codes : [],
        streaming: sidecar.voice_stt?.streaming_recognition === true,
      },
    };
  }

  processTurn(turn, hooks) {
    return this.primary.processTurn(turn, hooks);
  }

  createLiveTurnSession(turn, hooks) {
    return this.primary.createLiveTurnSession(turn, {
      ...hooks,
      onTranscriptPartial: async (text) => {
        if (!this.sidecarTurns.has(turn)) await hooks.onTranscriptPartial(text);
      },
    });
  }

  createStreamingSttSession(turn, hooks) {
    const stream = this.sidecar.createStreamingSttSession?.(turn, hooks) || null;
    if (stream) this.sidecarTurns.add(turn);
    return stream;
  }

  finalizeStreamingSttSession(turn) {
    return this.sidecar.runSttStage?.(turn, this.sidecar.sttLanguageCodes()) || null;
  }
}

async function mergeTranscriptSidecar({ turn, providerResult, provider, finalize, record, cleanError }) {
  if (turn?.sttStreamRole !== "transcript_sidecar" || !turn.sttStream) return providerResult;
  try {
    const result = await finalize();
    turn.sttStream = null;
    const transcript = String(result?.text || "").trim();
    if (!transcript) {
      await record("transcript_sidecar_fallback", { provider, reason: "empty_transcript" });
      return providerResult;
    }
    const nativeTranscript = String(providerResult?.transcript || "").trim();
    await record("transcript_sidecar_final", {
      provider,
      transcript_chars: transcript.length,
      native_transcript_chars: nativeTranscript.length,
    });
    return {
      ...(providerResult || {}),
      transcript,
      transcript_source: "stt_sidecar",
      transcript_provider: provider,
      native_input_transcript: nativeTranscript,
    };
  } catch (error) {
    turn.sttStream = null;
    await record("transcript_sidecar_fallback", {
      provider,
      reason: "sidecar_error",
      error_summary: cleanError(error),
    });
    return providerResult;
  }
}

module.exports = { TranscriptSidecarVoiceProvider, mergeTranscriptSidecar };
