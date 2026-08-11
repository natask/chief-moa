(function initAgeeCaptureOnlyPolicy(global) {
  "use strict";

  const ASSISTANT_EVENT_TYPES = new Set([
    "assistant_text_delta",
    "assistant_text",
    "assistant_audio_segment",
    "assistant_audio_start",
    "assistant_audio_done",
    "assistant_media",
    "media_action",
    "page_tweak",
    "tool_call",
    "tool_request",
    "action",
  ]);

  const CAPTURE_EVENT_TYPES = new Set([
    "session_ready",
    "transcript_partial",
    "transcript_final",
    "transcript_prefix_revision",
    "transcript_finalized",
    "turn_progress",
    "turn_done",
    "voice_draft_state",
    "error",
    "revoked",
    "connection_closed",
  ]);

  const TERMINAL_EVENT_TYPES = new Set([
    "transcript_finalized",
    "turn_done",
    "error",
    "revoked",
    "connection_closed",
  ]);

  function isCaptureOnly(state) {
    return state?.dictation === true
      || state?.finalizeTranscriptOnly === true
      || state?.transcriptFinalizing === true
      || state?.transcriptionOnly === true;
  }

  function acceptsAssistantEvent(state, type) {
    const eventType = String(type || "");
    return !isCaptureOnly(state) || (!eventType.startsWith("assistant_") && !ASSISTANT_EVENT_TYPES.has(eventType));
  }

  function acceptsWorkerPayload(state, payload) {
    if (!isCaptureOnly(state)) return true;
    return !(payload instanceof ArrayBuffer || payload instanceof Blob);
  }

  function filterGatewayEvent(state, event) {
    if (!isCaptureOnly(state)) return event;
    const type = String(event?.type || "");
    if (!CAPTURE_EVENT_TYPES.has(type) || !acceptsAssistantEvent(state, type)) return null;
    if (!event || typeof event !== "object") return null;
    const filtered = { ...event };
    for (const key of [
      "action", "actions", "assistant_audio", "assistant_media", "assistant_text",
      "display", "media", "response", "speak", "tool_call", "tool_request",
    ]) delete filtered[key];
    if (TERMINAL_EVENT_TYPES.has(type)) delete filtered.text;
    return filtered;
  }

  global.AgeeCaptureOnlyPolicy = Object.freeze({
    ASSISTANT_EVENT_TYPES,
    CAPTURE_EVENT_TYPES,
    TERMINAL_EVENT_TYPES,
    acceptsAssistantEvent,
    acceptsWorkerPayload,
    filterGatewayEvent,
    isCaptureOnly,
  });
})(globalThis);
