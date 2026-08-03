"use strict";

const crypto = require("node:crypto");
const { CAPTURE_CREATED_EVENT, PROCESSING_EVENT } = require("./audio-capture-blocks");

const CAPTURE_EVENT = "capture.block.completed";
const ROUTING_EVENT = "capture.routing.proposed";
const MAX_LITERAL_BYTES = 1024 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const EVENT_PAGE_SIZE = 500;
const MAX_EVENT_SCAN = 10_000;

class CaptureBlockError extends Error {
  constructor(message, code = "validation") {
    super(message);
    this.name = "CaptureBlockError";
    this.code = code;
  }
}

function createCaptureBlockStore({ events } = {}) {
  if (!events || typeof events.appendEvent !== "function" || typeof events.listEvents !== "function") {
    throw new Error("capture block store requires an event substrate");
  }

  async function recordCompletedDictation(record = {}) {
    if (!isCompletedTranscriptionOnly(record)) return null;
    const block = captureBlockFromVoiceTurn(record);
    const proposal = initialRoutingProposal(block);
    await events.appendEvent(captureEvent(block));
    await events.appendEvent(routingEvent(block, proposal));
    return get(block.id);
  }

  async function get(captureBlockId) {
    const id = requireCaptureBlockId(captureBlockId);
    const rows = await events.listEvents({
      stream_id: captureStreamId(id),
      order: "asc",
      limit: MAX_LIMIT,
    });
    return rehydrateCaptureBlock(rows, id);
  }

  async function list(filters = {}) {
    const normalized = normalizeFilters(filters);
    const eventsFound = await listAllCaptureEvents(events);
    const matching = eventsFound
      .map((event) => event.payload)
      .filter((block) => block && block.id)
      .filter((block) => !normalized.sessionId || block.source?.session_id === normalized.sessionId)
      .filter((block) => !normalized.turnId || block.source?.turn_id === normalized.turnId)
      .filter((block) => !normalized.sourceSurface || block.source?.surface === normalized.sourceSurface)
      .filter((block) => matchesQuery(block, normalized.query))
      .sort((a, b) => String(b.completed_at || "").localeCompare(String(a.completed_at || "")));
    const selected = matching.slice(normalized.offset, normalized.offset + normalized.limit);
    const items = [];
    for (const block of selected) {
      const item = await get(block.id);
      if (item) items.push(item);
    }
    return {
      items,
      offset: normalized.offset,
      limit: normalized.limit,
      has_more: normalized.offset + selected.length < matching.length,
    };
  }

  function search(query, filters = {}) {
    return list({ ...filters, query });
  }

  return Object.freeze({ recordCompletedDictation, get, list, search });
}

function isCompletedTranscriptionOnly(record) {
  const voice = voiceSession(record);
  return voice.transcription_only === true
    && voice.status === "completed"
    && record.incomplete !== true
    && voice.incomplete !== true;
}

function captureBlockFromVoiceTurn(record) {
  const sessionId = requireText(record.session_id || record.conversation_id, "session_id", 160);
  const turnId = requireText(record.id || record.turn_id, "turn_id", 160);
  const literal = requireExactLiteral(record.transcript);
  const voice = voiceSession(record);
  const audio = voice.audio && typeof voice.audio === "object" && !Array.isArray(voice.audio)
    ? voice.audio
    : {};
  const audioBytes = finiteNonNegative(audio.bytes);
  if (audioBytes <= 0) throw new CaptureBlockError("completed dictation requires retained voice audio");
  const completedAt = requireIsoDate(record.updated_at || record.completed_at || record.created_at, "completed_at");
  const createdAt = requireIsoDate(record.created_at || completedAt, "created_at");
  const id = captureBlockId(sessionId, turnId);
  const completeness = transcriptCompleteness(record, literal);
  return {
    schema_version: 1,
    id,
    source: {
      session_id: sessionId,
      conversation_id: text(record.conversation_id || sessionId, 160),
      branch_id: text(record.branch_id || "default", 160),
      turn_id: turnId,
      surface: text(record.source, 80),
      device_id: text(record.device_id, 160),
    },
    created_at: createdAt,
    completed_at: completedAt,
    processing_state: "transcribed",
    literal_transcript: literal,
    transcript_completeness: completeness,
    audio: {
      retention_state: "retained",
      storage_ref: `voice-sessions/${sessionId}/${turnId}.pcm`,
      href: `/v1/voice/audio/${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}?kind=user`,
      encoding: text(audio.encoding || "pcm16", 40),
      bytes: audioBytes,
      chunks: finiteNonNegative(audio.chunks),
      format: text(record.audio_format || "pcm16", 80),
    },
    transcript_provenance: {
      transcript_source: text(record.transcript_source || "stt", 80),
      transcript_provider: text(record.transcript_provider || voice.provider, 120),
      voice_provider: text(voice.provider, 120),
      model: text(voice.model, 160),
      input_languages: uniqueText(voice.input_languages, 8, 40),
      language_rejected: voice.transcript_language_rejected === true,
    },
  };
}

function transcriptCompleteness(record, literal) {
  const supplied = record?.transcript_completeness;
  const retainedBytes = Buffer.byteLength(literal, "utf8");
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    return {
      state: "complete",
      exact: true,
      truncated: false,
      utf8_bytes: retainedBytes,
    };
  }
  const truncated = supplied.truncated === true;
  const sourceBytes = finiteNonNegative(supplied.source_utf8_bytes);
  return {
    state: truncated ? "truncated" : "complete",
    exact: !truncated && supplied.exact !== false,
    truncated,
    utf8_bytes: retainedBytes,
    source_utf8_bytes: Math.max(retainedBytes, sourceBytes),
    retained_utf8_bytes: retainedBytes,
  };
}

function initialRoutingProposal(block) {
  return {
    schema_version: 1,
    id: routingProposalId(block.id),
    capture_block_id: block.id,
    classification: "unclassified",
    route: "file_only",
    executable: false,
    status: "proposed",
    reason: "No explicit dispatch or approved routing policy was provided.",
    provenance: {
      kind: "deterministic_policy",
      policy: "completed_dictation_file_only_v1",
      model_used: false,
    },
    created_at: block.completed_at,
  };
}

function captureEvent(block) {
  return {
    event_type: CAPTURE_EVENT,
    event_schema_version: 1,
    stream_id: captureStreamId(block.id),
    occurred_at: block.completed_at,
    actor: { kind: "gateway", id: "dictation-capture" },
    authority: { boundary: "capture-block", execution: "none" },
    correlation_id: block.source.turn_id,
    idempotency_key: `capture:${block.id}:completed`,
    payload: block,
  };
}

function routingEvent(block, proposal) {
  return {
    event_type: ROUTING_EVENT,
    event_schema_version: 1,
    stream_id: captureStreamId(block.id),
    occurred_at: proposal.created_at,
    actor: { kind: "gateway", id: "capture-router" },
    authority: { boundary: "capture-block", execution: "proposal_only" },
    causation_id: block.source.turn_id,
    correlation_id: block.source.turn_id,
    idempotency_key: `capture:${block.id}:routing:initial`,
    payload: proposal,
  };
}

function rehydrateCaptureBlock(rows, expectedId) {
  const source = rows.find((event) =>
    [CAPTURE_EVENT, CAPTURE_CREATED_EVENT].includes(event.event_type)
      && event.payload?.id === expectedId);
  if (!source) return null;
  const proposals = rows
    .filter((event) =>
      event.event_type === ROUTING_EVENT
      && event.payload?.capture_block_id === expectedId)
    .map((event) => ({ ...event.payload, event_id: event.event_id }))
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  const processingEvents = rows
    .filter((event) => event.event_type === PROCESSING_EVENT && event.payload?.capture_block_id === expectedId)
    .map((event) => ({ ...event.payload, event_id: event.event_id }));
  const block = { ...source.payload, routing_proposals: proposals };
  if (source.event_type === CAPTURE_CREATED_EVENT) {
    block.processing_events = processingEvents;
    applyAudioProcessingProjection(block, processingEvents);
  }
  return block;
}

function applyAudioProcessingProjection(block, processingEvents) {
  for (const event of processingEvents) {
    block.processing_state = event.to_state;
    block.retry_count = event.attempt;
    if (event.to_state === "transcribing") {
      block.processing_claim = event.claim || block.processing_claim || null;
      block.failure = null;
    } else if (event.to_state === "queued") {
      block.processing_claim = null;
      block.failure = null;
      block.transcript = { ...block.transcript, state: "queued" };
    } else if (event.to_state === "failed") {
      block.last_claim_id = event.claim_id || block.processing_claim?.id || "";
      block.processing_claim = null;
      block.failure = { ...event.failure, retryable: event.retryable === true };
      block.transcript = { ...block.transcript, state: "failed" };
    } else if (event.to_state === "transcribed") {
      block.last_claim_id = event.claim_id || block.processing_claim?.id || "";
      block.processing_claim = null;
      block.failure = null;
      block.completed_at = event.created_at;
      block.transcript = {
        state: "transcribed",
        literal: event.result?.literal ?? block.transcript?.literal ?? null,
        language_evidence: event.result?.language_evidence || [],
        provider: event.result?.provider || null,
        result_id: event.result?.id || "",
      };
    }
  }
}

async function listAllCaptureEvents(events) {
  const output = [];
  for (const eventType of [CAPTURE_EVENT, CAPTURE_CREATED_EVENT]) {
    for (let offset = 0; offset < MAX_EVENT_SCAN; offset += EVENT_PAGE_SIZE) {
      const page = await events.listEvents({
        event_type: eventType,
        order: "desc",
        offset,
        limit: EVENT_PAGE_SIZE,
      });
      output.push(...page);
      if (page.length < EVENT_PAGE_SIZE) break;
    }
  }
  return output;
}

function normalizeFilters(filters) {
  const limit = integerInRange(filters.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = integerInRange(filters.offset, 0, 0, MAX_EVENT_SCAN);
  return {
    limit,
    offset,
    query: text(filters.query || filters.q, 500).toLocaleLowerCase(),
    sessionId: text(filters.session_id || filters.sessionId, 160),
    turnId: text(filters.turn_id || filters.turnId, 160),
    sourceSurface: text(filters.source_surface || filters.sourceSurface, 80),
  };
}

function matchesQuery(block, query) {
  if (!query) return true;
  const haystack = [
    block.literal_transcript,
    block.source?.surface,
    block.source?.session_id,
    block.source?.turn_id,
    ...(block.transcript_provenance?.input_languages || []),
  ].join("\n").toLocaleLowerCase();
  return haystack.includes(query);
}

function captureBlockId(sessionId, turnId) {
  return `cap_${digest(`${sessionId}\0${turnId}`)}`;
}

function routingProposalId(blockId) {
  return `route_${digest(`${blockId}\0file_only\0unclassified`)}`;
}

function captureStreamId(blockId) {
  return `capture-block:${requireCaptureBlockId(blockId)}`;
}

function requireCaptureBlockId(value) {
  const id = String(value || "").trim();
  if (!/^cap_[a-f0-9]{64}$/.test(id)) throw new CaptureBlockError("invalid capture block id");
  return id;
}

function requireExactLiteral(value) {
  const literal = String(value ?? "");
  if (!literal.trim()) throw new CaptureBlockError("literal transcript is required");
  if (Buffer.byteLength(literal, "utf8") > MAX_LITERAL_BYTES) {
    throw new CaptureBlockError(`literal transcript exceeds ${MAX_LITERAL_BYTES} UTF-8 bytes`);
  }
  return literal;
}

function voiceSession(record) {
  const value = record?.references?.voice_session;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requireText(value, field, max) {
  const result = text(value, max);
  if (!result) throw new CaptureBlockError(`${field} is required`);
  return result;
}

function requireIsoDate(value, field) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new CaptureBlockError(`${field} must be an ISO timestamp`);
  return date.toISOString();
}

function text(value, max) {
  return String(value || "").trim().slice(0, max);
}

function uniqueText(values, maxItems, maxChars) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => text(value, maxChars)).filter(Boolean))].slice(0, maxItems);
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function integerInRange(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new CaptureBlockError(`integer must be between ${min} and ${max}`);
  }
  return number;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

module.exports = {
  CAPTURE_EVENT,
  ROUTING_EVENT,
  MAX_LITERAL_BYTES,
  CaptureBlockError,
  createCaptureBlockStore,
  isCompletedTranscriptionOnly,
  captureBlockFromVoiceTurn,
  initialRoutingProposal,
  captureBlockId,
  routingProposalId,
  requireCaptureBlockId,
};
