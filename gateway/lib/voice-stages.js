"use strict";

// Formal provider seam for the cascaded voice pipeline. Three small stage
// interfaces in repo idiom — plain duck-typed objects, CommonJS, no framework:
//
//   SttProvider  { id, capabilities: { partial_transcripts, language_hints },
//                  transcribe({ turn, languageCodes, signal })
//                    -> { text, languageRejected } }
//   Reasoner     { id, capabilities: { streaming_reasoning, tools },
//                  run(input) -> { speak, display, tts_text, tts_style,
//                                  language, model, classification, context } }
//   TtsProvider  { id, capabilities: { streaming_tts, expressive_tags,
//                                      language_pinning },
//                  synthesize({ text, language, stylePrompt, signal })
//                    -> Buffer /* pcm16 @ the client rate */ }
//
// The transport contract is untouched: the composed voice provider still
// exposes processTurn(turn, hooks)/status()/synthesizeAssistantSpeech, and the
// session server, clients, and the LiveKit worker never see this seam. Stages
// only formalize the boundaries INSIDE the cascaded provider so a new STT,
// reasoning, or TTS backend is one registry entry plus one stage factory.

const STAGE_CAPABILITY_DEFAULTS = Object.freeze({
  stt: Object.freeze({ partial_transcripts: false, language_hints: false }),
  reasoner: Object.freeze({ streaming_reasoning: false, tools: false }),
  tts: Object.freeze({ streaming_tts: false, expressive_tags: false, language_pinning: false }),
});

function stageCapabilities(kind, overrides) {
  const defaults = STAGE_CAPABILITY_DEFAULTS[kind] || {};
  const result = {};
  for (const [flag, value] of Object.entries(defaults)) {
    result[flag] = Boolean(overrides?.[flag] ?? value);
  }
  return Object.freeze(result);
}

function createSttStage(options) {
  if (typeof options?.transcribe !== "function") {
    throw new Error("an SttProvider stage requires a transcribe() function");
  }
  return Object.freeze({
    kind: "stt",
    id: String(options.id || "stt"),
    capabilities: stageCapabilities("stt", options.capabilities),
    transcribe: options.transcribe,
  });
}

function createReasonerStage(options) {
  if (typeof options?.run !== "function") {
    throw new Error("a Reasoner stage requires a run() function");
  }
  return Object.freeze({
    kind: "reasoner",
    id: String(options.id || "reasoner"),
    capabilities: stageCapabilities("reasoner", options.capabilities),
    run: options.run,
  });
}

function createTtsStage(options) {
  if (typeof options?.synthesize !== "function") {
    throw new Error("a TtsProvider stage requires a synthesize() function");
  }
  return Object.freeze({
    kind: "tts",
    id: String(options.id || "tts"),
    capabilities: stageCapabilities("tts", options.capabilities),
    synthesize: options.synthesize,
  });
}

module.exports = {
  createSttStage,
  createReasonerStage,
  createTtsStage,
};
