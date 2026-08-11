(function initAgeeCaptureOnlyPolicy(global) {
  "use strict";

  const ASSISTANT_EVENT_TYPES = new Set([
    "assistant_text_delta",
    "assistant_text",
    "assistant_audio_segment",
    "assistant_audio_start",
    "assistant_audio_done",
  ]);

  function isCaptureOnly(state) {
    return state?.dictation === true
      || state?.finalizeTranscriptOnly === true
      || state?.transcriptionOnly === true;
  }

  function acceptsAssistantEvent(state, type) {
    return !isCaptureOnly(state) || !ASSISTANT_EVENT_TYPES.has(String(type || ""));
  }

  global.AgeeCaptureOnlyPolicy = Object.freeze({ ASSISTANT_EVENT_TYPES, acceptsAssistantEvent, isCaptureOnly });
})(globalThis);
