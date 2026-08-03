"use strict";

const crypto = require("node:crypto");

const CAPTURE_CREATED_EVENT = "capture.block.created";
const PROCESSING_EVENT = "capture.processing.changed";
const MAX_IDEMPOTENCY_KEY_CHARS = 200;

class AudioCaptureBlockError extends Error {
  constructor(message, code = "validation", statusCode = 400) {
    super(message);
    this.name = "AudioCaptureBlockError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function createAudioCaptureBlockService({ events, audioNotes, captureBlocks } = {}) {
  if (!events?.appendEvent || !events?.listEvents || !audioNotes?.get || !captureBlocks?.get) {
    throw new Error("audio capture blocks require events, audio notes, and capture blocks");
  }

  async function create(input = {}) {
    const audioNoteId = requireToken(input.audio_note_id, "audio_note_id", 120);
    const idempotencyKey = requireIdempotencyKey(input.idempotency_key);
    const audioNote = audioNotes.get(audioNoteId);
    if (!audioNote) throw new AudioCaptureBlockError("audio note not found", "not_found", 404);

    const block = queuedBlockFromAudioNote({
      audioNote,
      ownerId: input.owner_id,
      source: input.source,
      idempotencyKey,
    });
    const created = createdEvent(block, idempotencyKey);
    const appended = await events.appendEvent(created);
    if (appended.payload?.id !== block.id
      || appended.payload?.audio?.audio_note_id !== audioNoteId
      || appended.payload?.creation?.request_digest !== block.creation.request_digest) {
      throw new AudioCaptureBlockError(
        "idempotency key was already used for a different capture block",
        "conflict",
        409,
      );
    }
    await events.appendEvent(queuedProcessingEvent(block));
    return captureBlocks.get(block.id);
  }

  return Object.freeze({ create });
}

function queuedBlockFromAudioNote({ audioNote, ownerId, source = {}, idempotencyKey } = {}) {
  const noteId = requireToken(audioNote?.id, "audio_note_id", 120);
  const createdAt = requireIsoDate(audioNote.created_at, "audio_note.created_at");
  const requestSource = boundedSource(source);
  assertMatchingSource("surface", audioNote.surface, requestSource.surface);
  assertMatchingSource("session_id", audioNote.session_id, requestSource.session_id);
  const id = audioCaptureBlockId(noteId);
  return {
    schema_version: 2,
    id,
    owner_id: requireToken(ownerId, "owner_id", 160),
    source: {
      kind: "audio_note",
      audio_note_id: noteId,
      surface: cleanText(audioNote.surface || requestSource.surface, 80),
      session_id: cleanText(audioNote.session_id || requestSource.session_id, 160),
      device_id: requestSource.device_id,
      capture_id: requestSource.capture_id,
    },
    created_at: createdAt,
    completed_at: null,
    processing_state: "queued",
    audio: {
      audio_note_id: noteId,
      retention_state: "retained",
      href: cleanText(audioNote.audio?.href || `/v1/audio-notes/${encodeURIComponent(noteId)}/audio`, 500),
      content_type: cleanText(audioNote.content_type, 160),
      encoding: cleanText(audioNote.audio?.encoding, 40),
      bytes: boundedInteger(audioNote.bytes, "audio_note.bytes", 1, 1024 * 1024 * 1024),
      duration_ms: nullableBoundedInteger(audioNote.duration_ms, "audio_note.duration_ms", 0, 24 * 60 * 60 * 1000),
    },
    transcript: {
      state: "queued",
      literal: null,
      language_evidence: [],
      provider: null,
    },
    transcript_revisions: [],
    dispatches: [],
    retention: {
      audio: "retained",
      derived_text: "retain_with_block",
      deletion: "explicit",
    },
    failure: null,
    retry_count: 0,
    creation: {
      idempotency_key: requireIdempotencyKey(idempotencyKey),
      request_digest: requestDigest(noteId, ownerId, requestSource),
    },
  };
}

function createdEvent(block, idempotencyKey) {
  return {
    event_id: `evt_${digest(`${block.id}\0created`)}`,
    event_type: CAPTURE_CREATED_EVENT,
    event_schema_version: 1,
    stream_id: `capture-block:${block.id}`,
    occurred_at: block.created_at,
    actor: { kind: "user", id: block.owner_id },
    authority: { boundary: "capture-block", execution: "none" },
    correlation_id: block.source.audio_note_id,
    idempotency_key: `audio-capture-create:${requireIdempotencyKey(idempotencyKey)}`,
    payload: block,
  };
}

function queuedProcessingEvent(block) {
  return {
    event_type: PROCESSING_EVENT,
    event_schema_version: 1,
    stream_id: `capture-block:${block.id}`,
    occurred_at: block.created_at,
    actor: { kind: "gateway", id: "capture-processing-queue" },
    authority: { boundary: "capture-block", execution: "none" },
    causation_id: block.source.audio_note_id,
    correlation_id: block.source.audio_note_id,
    idempotency_key: `capture:${block.id}:processing:queued:0`,
    payload: {
      schema_version: 1,
      id: `proc_${digest(`${block.id}\0queued\0${0}`)}`,
      capture_block_id: block.id,
      phase: "transcription",
      from_state: null,
      to_state: "queued",
      attempt: 0,
      retryable: true,
      created_at: block.created_at,
    },
  };
}

function audioCaptureBlockId(audioNoteId) {
  return `cap_${digest(`audio-note\0${requireToken(audioNoteId, "audio_note_id", 120)}`)}`;
}

function boundedSource(value) {
  if (value === undefined || value === null) return { surface: "", session_id: "", device_id: "", capture_id: "" };
  if (typeof value !== "object" || Array.isArray(value)) throw new AudioCaptureBlockError("source must be an object");
  return {
    surface: optionalText(value.surface, "source.surface", 80),
    session_id: optionalText(value.session_id, "source.session_id", 160),
    device_id: optionalText(value.device_id, "source.device_id", 160),
    capture_id: optionalText(value.capture_id, "source.capture_id", 160),
  };
}

function assertMatchingSource(field, stored, supplied) {
  if (stored && supplied && String(stored) !== String(supplied)) {
    throw new AudioCaptureBlockError(`source.${field} conflicts with the stored audio note`);
  }
}

function requireIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key) throw new AudioCaptureBlockError("idempotency_key is required");
  if (key.length > MAX_IDEMPOTENCY_KEY_CHARS || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new AudioCaptureBlockError("idempotency_key is invalid");
  }
  return key;
}

function requireToken(value, field, max) {
  const token = optionalText(value, field, max);
  if (!token || !/^[A-Za-z0-9._:-]+$/.test(token)) throw new AudioCaptureBlockError(`${field} is invalid`);
  return token;
}

function optionalText(value, field, max) {
  const text = String(value || "").trim();
  if (text.length > max) throw new AudioCaptureBlockError(`${field} exceeds ${max} characters`);
  return text;
}

function requireIsoDate(value, field) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new AudioCaptureBlockError(`${field} must be an ISO timestamp`);
  return date.toISOString();
}

function boundedInteger(value, field, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new AudioCaptureBlockError(`${field} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function nullableBoundedInteger(value, field, min, max) {
  return value === null || value === undefined ? null : boundedInteger(value, field, min, max);
}

function requestDigest(noteId, ownerId, source) {
  return `sha256:${digest(JSON.stringify({ audio_note_id: noteId, owner_id: ownerId, source }))}`;
}

function cleanText(value, max) {
  return String(value || "").trim().slice(0, max);
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

module.exports = {
  CAPTURE_CREATED_EVENT,
  PROCESSING_EVENT,
  MAX_IDEMPOTENCY_KEY_CHARS,
  AudioCaptureBlockError,
  createAudioCaptureBlockService,
  queuedBlockFromAudioNote,
  queuedProcessingEvent,
  audioCaptureBlockId,
};
