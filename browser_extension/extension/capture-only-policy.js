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

  const COMMON_EVENT_FIELDS = ["type", "session_id", "branch_id", "turn_id"];
  const CAPTURE_EVENT_FIELDS = Object.freeze({
    session_ready: Object.freeze([
      ...COMMON_EVENT_FIELDS, "transcript_finalize", "capabilities", "voice_draft",
    ]),
    transcript_partial: Object.freeze([
      ...COMMON_EVENT_FIELDS, "text", "speaker", "transcript_sequence",
    ]),
    transcript_final: Object.freeze([
      ...COMMON_EVENT_FIELDS, "text", "speaker", "transcript_sequence",
    ]),
    transcript_prefix_revision: Object.freeze([
      ...COMMON_EVENT_FIELDS, "message_id", "owner_id", "speaker", "transcript_sequence",
      "revision", "finalized_text", "unsealed_text", "text", "sealed_through_audio_byte",
      "audio_format", "source", "updated_at",
    ]),
    transcript_finalized: Object.freeze([
      ...COMMON_EVENT_FIELDS, "status", "transcript", "transcription_only", "stored",
      "reason", "reply_language", "input_languages", "transcript_quality",
    ]),
    turn_progress: Object.freeze([...COMMON_EVENT_FIELDS, "stage"]),
    turn_done: Object.freeze([
      ...COMMON_EVENT_FIELDS, "status", "transcription_only", "stored", "reason",
      "reply_language", "input_languages", "transcript_quality", "message", "error",
    ]),
    voice_draft_state: Object.freeze([
      ...COMMON_EVENT_FIELDS, "capabilities", "voice_draft",
    ]),
    error: Object.freeze([
      ...COMMON_EVENT_FIELDS, "status", "message", "error", "code", "reason",
      "recoverable", "recovery",
    ]),
    revoked: Object.freeze([...COMMON_EVENT_FIELDS, "reason"]),
    connection_closed: Object.freeze([...COMMON_EVENT_FIELDS, "reason"]),
  });

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
    const filtered = {};
    for (const key of CAPTURE_EVENT_FIELDS[type]) {
      if (Object.hasOwn(event, key)) filtered[key] = event[key];
    }
    return filtered;
  }

  function allowsActionExtraction(state) {
    return !isCaptureOnly(state);
  }

  global.AgeeCaptureOnlyPolicy = Object.freeze({
    ASSISTANT_EVENT_TYPES,
    CAPTURE_EVENT_FIELDS,
    CAPTURE_EVENT_TYPES,
    TERMINAL_EVENT_TYPES,
    acceptsAssistantEvent,
    acceptsWorkerPayload,
    allowsActionExtraction,
    filterGatewayEvent,
    isCaptureOnly,
  });
})(globalThis);
