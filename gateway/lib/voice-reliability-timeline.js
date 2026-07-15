"use strict";

const SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 4 * 1024;
const MAX_DIAGNOSIS_BYTES = 128 * 1024;
const MAX_TIMELINE_INPUT_BYTES = 512 * 1024;
const MAX_RECORDS = 256;
const MAX_ID_LENGTH = 120;
const MAX_WALK_DEPTH = 12;
const MAX_WALK_NODES = 4_096;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_CLOCK_UNCERTAINTY_MS = 5 * 60 * 1_000;
const MAX_CLOCK_OFFSET_MS = 24 * 60 * 60 * 1_000;
const MAX_MONOTONIC_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_WALL_CLOCK_MS = 253_402_300_799_999;

const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const CREDENTIAL_LIKE_VALUE_PATTERNS = Object.freeze([
  /\bbearer(?:\s+|[:._-])[A-Za-z0-9._~+/=-]{4,}/i,
  /\bbasic\s+[A-Za-z0-9+/=]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{10,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/,
  /\bAIza[A-Za-z0-9_-]{8,}/,
  /\bya29\.[A-Za-z0-9._-]{8,}/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/i,
  /\bglpat-[A-Za-z0-9_-]{16,}/i,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/i,
  /\bSG\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bnpm_[A-Za-z0-9]{20,}/i,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)(?:\s*[=:._-]\s*)[A-Za-z0-9._~+/=-]{6,}/i,
  /\b(?:password|passwd|secret|session[_-]?token|id[_-]?token|webhook[_-]?secret|whsec)(?:\s*[=:._-]\s*)[A-Za-z0-9._~+/=-]{6,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
]);
const EVENT_TYPES = new Set([
  "session",
  "turn",
  "server_audio_write",
  "endpoint_audio_receipt",
  "endpoint_observed_playout",
  "transport",
  "clock_calibration",
  "release",
]);
const SOURCES = new Set([
  "gateway_observed",
  "provider_observed",
  "client_observed",
  "deterministic_derived",
  "server_authority",
]);
const PLAYBACK_DIAGNOSIS_STATUSES = new Set(["emitted", "fault", "text_only", "unknown"]);
const ENDPOINT_EVENT_TYPES = new Set([
  "endpoint_audio_receipt",
  "endpoint_observed_playout",
  "transport",
]);
const SERVER_EVENT_TYPES = new Set([
  "session",
  "turn",
  "server_audio_write",
  "transport",
  "clock_calibration",
  "release",
]);
const TYPE_FIELDS = Object.freeze({
  session: Object.freeze([]),
  turn: Object.freeze([]),
  server_audio_write: Object.freeze(["bytes"]),
  endpoint_audio_receipt: Object.freeze(["bytes", "buffered_ms"]),
  endpoint_observed_playout: Object.freeze(["played_ms", "measurement_uncertainty_ms"]),
  transport: Object.freeze(["transport_state", "transport_kind"]),
  clock_calibration: Object.freeze(["offset_ms", "uncertainty_ms"]),
  release: Object.freeze([]),
});
const REQUIRED_TYPE_FIELDS = Object.freeze({
  session: Object.freeze([]),
  turn: Object.freeze([]),
  server_audio_write: Object.freeze(["bytes"]),
  endpoint_audio_receipt: Object.freeze(["bytes"]),
  endpoint_observed_playout: Object.freeze(["played_ms"]),
  transport: Object.freeze(["transport_state"]),
  clock_calibration: Object.freeze(["offset_ms", "uncertainty_ms"]),
  release: Object.freeze([]),
});
const BASE_RECORD_KEYS = new Set([
  "schema_version",
  "event_id",
  "session_id",
  "turn_id",
  "type",
  "source",
  "observed_at_ms",
  "monotonic_ms",
  "clock_id",
  "observer_id",
  "surface",
  "tenant_id",
  "release_id",
]);
const AUTHORITY_KEYS = new Set(["tenant_id", "release_id"]);
const NORMALIZE_OPTION_KEYS = new Set(["authority", "origin"]);
const DIAGNOSIS_OPTION_KEYS = new Set(["authority"]);
const BUILD_KEYS = new Set([
  "diagnosis",
  "server_records",
  "endpoint_records",
  "session_id",
  "turn_id",
  "limit",
]);
const BUILD_OPTION_KEYS = new Set(["authority"]);
const TIMELINE_KEYS = new Set([
  "schema_version",
  "session_id",
  "turn_id",
  "tenant_id",
  "release_id",
  "clock_relation",
  "durations",
  "records",
]);
const SENSITIVE_DATA_KEYS = new Set([
  "access_token",
  "arguments",
  "args",
  "audio_base64",
  "audio_blob",
  "audio_body",
  "audio_buffer",
  "audio_bytes_raw",
  "audio_data",
  "audio_payload",
  "authorization",
  "authorization_header",
  "auth",
  "authentication",
  "bearer",
  "blob",
  "body",
  "client_secret",
  "completion",
  "content",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "data",
  "header",
  "headers",
  "id_token",
  "api_key",
  "key",
  "keys",
  "message",
  "messages",
  "password",
  "passwd",
  "pcm",
  "private_key",
  "prompt",
  "payload",
  "raw_audio",
  "raw_header",
  "raw_headers",
  "refresh_token",
  "request_body",
  "result",
  "results",
  "response_body",
  "secret",
  "secret_key",
  "session_token",
  "set_cookie",
  "text",
  "token",
  "tool",
  "tools",
  "tool_args",
  "tool_arguments",
  "tool_call",
  "tool_calls",
  "tool_result",
  "tool_results",
  "transcript",
  "waveform",
]);
const SENSITIVE_KEY_PARTS = new Set([
  "arguments",
  "args",
  "authorization",
  "blob",
  "body",
  "completion",
  "content",
  "cookie",
  "credential",
  "data",
  "header",
  "headers",
  "key",
  "message",
  "password",
  "passwd",
  "payload",
  "prompt",
  "raw",
  "result",
  "results",
  "secret",
  "text",
  "token",
  "transcript",
]);
const SAFE_CONTENT_METADATA_KEYS = new Set([
  "completion_chars",
  "completion_ms",
  "content_type",
  "message_chars",
  "message_count",
  "prompt_chars",
  "text_bytes",
  "text_chars",
  "transcript_bytes",
  "transcript_chars",
]);
const SAFE_AUDIO_METADATA_KEYS = new Set([
  "audio_bytes",
  "audio_chunks",
  "audio_duration_ms",
  "first_audio_ms",
]);
const AUDIO_CONTAINER_KEYS = new Set([
  "archive",
  "assistant",
  "capture",
  "input",
  "output",
  "playback",
  "storage",
  "user",
]);
const AUDIO_METADATA_KEYS = new Set([
  "archived",
  "buffered_ms",
  "bytes",
  "channels",
  "chunks",
  "codec",
  "content_type",
  "duration_ms",
  "encoding",
  "format",
  "href",
  "kind",
  "measurement_uncertainty_ms",
  "played_ms",
  "present",
  "retained",
  "sample_rate",
  "spoke",
  "status",
]);

function normalizeVoiceEvidenceRecord(input, options = {}) {
  assertBoundedData(input, MAX_RECORD_BYTES, "voice evidence record");
  assertNoSensitiveData(input, "voice evidence record");
  assertPlainDataObject(input, "voice evidence record");
  assertBoundedData(options, 512, "voice evidence options");
  assertNoSensitiveData(options, "voice evidence options");
  assertPlainDataObject(options, "voice evidence options");
  assertExactKeys(options, NORMALIZE_OPTION_KEYS, "voice evidence options");

  const origin = options.origin === undefined ? "endpoint" : options.origin;
  if (origin !== "endpoint" && origin !== "server") {
    throw new TypeError("voice evidence origin must be endpoint or server");
  }
  const authority = normalizeAuthority(options.authority);
  if (hasOwn(input, "tenant_id") || hasOwn(input, "release_id")) {
    throw new TypeError("voice evidence cannot assert server-owned authority");
  }

  if (input.schema_version !== SCHEMA_VERSION) {
    throw new TypeError(`voice evidence schema_version must be ${SCHEMA_VERSION}`);
  }
  const type = exactEnum(input.type, EVENT_TYPES, "voice evidence type");
  const source = exactEnum(input.source, SOURCES, "voice evidence source");
  assertAllowedRecordKeys(input, type);
  assertOriginAndSource(origin, type, source);

  const output = {
    schema_version: SCHEMA_VERSION,
    event_id: exactId(input.event_id, "event_id"),
    session_id: exactId(input.session_id, "session_id"),
    turn_id: exactId(input.turn_id, "turn_id"),
    type,
    source,
    observed_at_ms: boundedSafeInteger(input.observed_at_ms, 0, MAX_WALL_CLOCK_MS, "observed_at_ms"),
  };
  if (hasOwn(input, "monotonic_ms")) {
    output.monotonic_ms = boundedSafeInteger(input.monotonic_ms, 0, MAX_MONOTONIC_MS, "monotonic_ms");
    if (!hasOwn(input, "clock_id")) throw new TypeError("monotonic evidence requires clock_id");
  }
  if (hasOwn(input, "clock_id")) output.clock_id = exactId(input.clock_id, "clock_id");
  if (hasOwn(input, "observer_id")) output.observer_id = exactId(input.observer_id, "observer_id");
  if (hasOwn(input, "surface")) {
    output.surface = exactEnum(input.surface, new Set(["browser_extension", "android"]), "surface");
  }

  if (type === "server_audio_write" || type === "endpoint_audio_receipt") {
    output.bytes = boundedSafeInteger(input.bytes, 1, MAX_AUDIO_BYTES, "bytes");
    if (type === "endpoint_audio_receipt" && hasOwn(input, "buffered_ms")) {
      output.buffered_ms = boundedSafeInteger(input.buffered_ms, 0, MAX_DURATION_MS, "buffered_ms");
    }
  } else if (type === "endpoint_observed_playout") {
    output.played_ms = boundedSafeInteger(input.played_ms, 0, MAX_DURATION_MS, "played_ms");
    if (hasOwn(input, "measurement_uncertainty_ms")) {
      output.measurement_uncertainty_ms = boundedSafeInteger(
        input.measurement_uncertainty_ms,
        0,
        MAX_CLOCK_UNCERTAINTY_MS,
        "measurement_uncertainty_ms",
      );
    }
  } else if (type === "transport") {
    output.transport_state = exactEnum(input.transport_state, new Set(["open", "closed", "fault"]), "transport_state");
    if (hasOwn(input, "transport_kind")) {
      output.transport_kind = exactEnum(
        input.transport_kind,
        new Set(["websocket", "webrtc", "sip", "http", "local", "unknown"]),
        "transport_kind",
      );
    }
  } else if (type === "clock_calibration") {
    output.offset_ms = boundedSafeInteger(input.offset_ms, -MAX_CLOCK_OFFSET_MS, MAX_CLOCK_OFFSET_MS, "offset_ms");
    output.uncertainty_ms = boundedSafeInteger(
      input.uncertainty_ms,
      0,
      MAX_CLOCK_UNCERTAINTY_MS,
      "uncertainty_ms",
    );
  }

  if (origin === "endpoint") {
    if (!output.observer_id || !output.surface) {
      throw new TypeError("endpoint evidence requires observer_id and surface");
    }
  }
  if (type === "clock_calibration" && (!output.observer_id || !output.surface || !output.clock_id)) {
    throw new TypeError("clock calibration requires observer_id, surface, and clock_id");
  }

  if (authority.tenant_id) output.tenant_id = authority.tenant_id;
  if (authority.release_id) output.release_id = authority.release_id;
  if (type === "release" && !output.release_id) {
    throw new TypeError("release evidence requires trusted release_id authority");
  }

  const normalizedBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  if (normalizedBytes > MAX_RECORD_BYTES) {
    throw new RangeError("normalized voice evidence record exceeds byte limit");
  }
  return Object.freeze(output);
}

function recordsFromVoiceDiagnosis(diagnosis, options = {}) {
  assertBoundedData(diagnosis, MAX_DIAGNOSIS_BYTES, "voice diagnosis");
  assertNoSensitiveData(diagnosis, "voice diagnosis");
  assertPlainDataObject(diagnosis, "voice diagnosis");
  assertBoundedData(options, 512, "voice diagnosis options");
  assertNoSensitiveData(options, "voice diagnosis options");
  assertPlainDataObject(options, "voice diagnosis options");
  assertExactKeys(options, DIAGNOSIS_OPTION_KEYS, "voice diagnosis options");

  const sessionId = exactId(diagnosis.session_id, "diagnosis.session_id");
  const turnId = exactId(diagnosis.turn_id, "diagnosis.turn_id");
  const observedAtMs = diagnosisTimestamp(
    hasOwn(diagnosis, "updated_at") ? diagnosis.updated_at : diagnosis.created_at,
  );
  const authority = normalizeAuthority(options.authority);
  const base = { schema_version: SCHEMA_VERSION, session_id: sessionId, turn_id: turnId, observed_at_ms: observedAtMs };
  const records = [
    normalizeVoiceEvidenceRecord({
      ...base,
      event_id: "diagnosis:session",
      type: "session",
      source: "deterministic_derived",
    }, { origin: "server", authority }),
    normalizeVoiceEvidenceRecord({
      ...base,
      event_id: "diagnosis:turn",
      type: "turn",
      source: "deterministic_derived",
    }, { origin: "server", authority }),
  ];

  const playback = optionalPlainDataObject(diagnosis.attributions)?.playback;
  const playbackObject = optionalPlainDataObject(playback);
  const assistantAudio = optionalPlainDataObject(optionalPlainDataObject(diagnosis.audio)?.assistant);
  const playbackStatus = exactEnum(playbackObject.status, PLAYBACK_DIAGNOSIS_STATUSES, "playback diagnosis status");
  const playbackBytes = optionalBoundedInteger(playbackObject, "audio_bytes", 0, MAX_AUDIO_BYTES, "playback.audio_bytes");
  const archivedBytes = optionalBoundedInteger(assistantAudio, "bytes", 0, MAX_AUDIO_BYTES, "audio.assistant.bytes");
  const audioBytes = playbackBytes > 0 ? playbackBytes : archivedBytes;
  if (playbackStatus === "emitted" && audioBytes > 0) {
    records.push(normalizeVoiceEvidenceRecord({
      ...base,
      event_id: "diagnosis:server-audio-write",
      type: "server_audio_write",
      source: "deterministic_derived",
      bytes: audioBytes,
    }, { origin: "server", authority }));
  }
  if (authority.release_id) {
    records.push(normalizeVoiceEvidenceRecord({
      ...base,
      event_id: "diagnosis:release",
      type: "release",
      source: "server_authority",
    }, { origin: "server", authority }));
  }
  return Object.freeze(records);
}

function buildVoiceReliabilityTimeline(input = {}, options = {}) {
  assertBoundedData(input, MAX_TIMELINE_INPUT_BYTES, "voice reliability timeline input");
  assertNoSensitiveData(input, "voice reliability timeline input");
  assertPlainDataObject(input, "voice reliability timeline input");
  assertExactKeys(input, BUILD_KEYS, "voice reliability timeline input");
  assertBoundedData(options, 512, "voice reliability timeline options");
  assertNoSensitiveData(options, "voice reliability timeline options");
  assertPlainDataObject(options, "voice reliability timeline options");
  assertExactKeys(options, BUILD_OPTION_KEYS, "voice reliability timeline options");

  const authority = normalizeAuthority(options.authority);
  const diagnosis = input.diagnosis;
  const diagnosisSessionId = diagnosis === undefined ? "" : exactId(diagnosis.session_id, "diagnosis.session_id");
  const diagnosisTurnId = diagnosis === undefined ? "" : exactId(diagnosis.turn_id, "diagnosis.turn_id");
  const sessionId = exactId(input.session_id === undefined ? diagnosisSessionId : input.session_id, "session_id");
  const turnId = exactId(input.turn_id === undefined ? diagnosisTurnId : input.turn_id, "turn_id");
  if (diagnosis !== undefined && (diagnosisSessionId !== sessionId || diagnosisTurnId !== turnId)) {
    throw new TypeError("voice diagnosis authority does not match timeline authority");
  }

  const serverRecords = normalizeRecordArray(input.server_records, "server_records", "server", authority);
  const endpointRecords = normalizeRecordArray(input.endpoint_records, "endpoint_records", "endpoint", authority);
  const diagnosisRecords = diagnosis === undefined ? [] : recordsFromVoiceDiagnosis(diagnosis, { authority });
  const limit = input.limit === undefined ? MAX_RECORDS : boundedSafeInteger(input.limit, 1, MAX_RECORDS, "limit");
  if (diagnosisRecords.length + serverRecords.length + endpointRecords.length > MAX_RECORDS) {
    throw new RangeError(`voice reliability timeline accepts at most ${MAX_RECORDS} records`);
  }

  const unique = new Map();
  for (const record of [...diagnosisRecords, ...serverRecords, ...endpointRecords]) {
    if (record.session_id !== sessionId || record.turn_id !== turnId) {
      throw new TypeError("voice evidence cannot cross timeline session or turn authority");
    }
    const prior = unique.get(record.event_id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(record)) {
      throw new TypeError(`conflicting duplicate voice evidence event_id: ${record.event_id}`);
    }
    if (!prior) unique.set(record.event_id, record);
  }
  if (unique.size > limit) {
    throw new RangeError(`voice reliability timeline exceeds configured limit ${limit}`);
  }

  const records = orderEvidenceRecords([...unique.values()]);
  assertSingleEndpointObserver(records);
  const endpointMilestones = validateEndpointMilestones(records);
  const clockRelation = deriveClockRelation(records);
  const durations = deriveMonotonicDurations(endpointMilestones);
  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    session_id: sessionId,
    turn_id: turnId,
    ...(authority.tenant_id ? { tenant_id: authority.tenant_id } : {}),
    ...(authority.release_id ? { release_id: authority.release_id } : {}),
    clock_relation: clockRelation,
    durations,
    records: Object.freeze(records),
  });
}

function endpointPlaybackAttribution(timeline) {
  assertBoundedData(timeline, MAX_TIMELINE_INPUT_BYTES, "voice reliability timeline");
  assertNoSensitiveData(timeline, "voice reliability timeline");
  assertPlainDataObject(timeline, "voice reliability timeline");
  const validated = rebuildTimelineForAttribution(timeline);
  const records = validated.records;
  const serverWrites = records.filter((record) => record?.type === "server_audio_write" && record?.source !== "client_observed");
  const receipts = records.filter((record) => record?.type === "endpoint_audio_receipt" && record?.source === "client_observed");
  const playouts = records.filter((record) => record?.type === "endpoint_observed_playout" && record?.source === "client_observed");

  if (serverWrites.length === 0) {
    return frozenAttribution({
      status: "no_server_audio_evidence",
      boundary: "server_audio",
      summary: "no bounded server audio-write evidence is present",
      human_heard: "unknown",
    });
  }
  if (playouts.length > 0) {
    return frozenAttribution({
      status: "endpoint_playout_observed",
      boundary: "endpoint_playback",
      summary: "the endpoint observed audio playout; human perception is not measured",
      human_heard: "unknown",
      ...(validated.durations.endpoint_receipt_to_playout_ms !== undefined
        ? { receipt_to_playout_ms: validated.durations.endpoint_receipt_to_playout_ms }
        : {}),
    });
  }
  if (receipts.length > 0) {
    return frozenAttribution({
      status: "playback_not_observed",
      boundary: "endpoint_playback",
      fault_category: "playback",
      summary: "the endpoint received audio bytes but did not observe playout",
      human_heard: "unknown",
    });
  }
  return frozenAttribution({
    status: "endpoint_unknown",
    boundary: "transport_or_endpoint_playback",
    summary: "server-side evidence records assistant audio, but endpoint receipt and playout were not observed",
    human_heard: "unknown",
  });
}

function rebuildTimelineForAttribution(timeline) {
  assertExactKeys(timeline, TIMELINE_KEYS, "voice reliability timeline");
  if (timeline.schema_version !== SCHEMA_VERSION || !Array.isArray(timeline.records)) {
    throw new TypeError("invalid voice reliability timeline");
  }
  const authorityInput = {};
  if (hasOwn(timeline, "tenant_id")) authorityInput.tenant_id = timeline.tenant_id;
  if (hasOwn(timeline, "release_id")) authorityInput.release_id = timeline.release_id;
  const authority = normalizeAuthority(authorityInput);
  const sessionId = exactId(timeline.session_id, "timeline.session_id");
  const turnId = exactId(timeline.turn_id, "timeline.turn_id");
  if (timeline.records.length > MAX_RECORDS) throw new RangeError("voice reliability timeline exceeds record limit");
  const serverRecords = [];
  const endpointRecords = [];
  for (const record of timeline.records) {
    assertPlainDataObject(record, "voice reliability timeline record");
    const recordTenantId = hasOwn(record, "tenant_id")
      ? exactId(record.tenant_id, "timeline record tenant_id")
      : "";
    const recordReleaseId = hasOwn(record, "release_id")
      ? exactId(record.release_id, "timeline record release_id")
      : "";
    if (recordTenantId !== (authority.tenant_id || "")) {
      throw new TypeError("timeline record tenant authority does not match timeline");
    }
    if (recordReleaseId !== (authority.release_id || "")) {
      throw new TypeError("timeline record release authority does not match timeline");
    }
    const input = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(record))) {
      if (key !== "tenant_id" && key !== "release_id") input[key] = descriptor.value;
    }
    if (record.source === "client_observed") endpointRecords.push(input);
    else serverRecords.push(input);
  }
  return buildVoiceReliabilityTimeline({
    session_id: sessionId,
    turn_id: turnId,
    server_records: serverRecords,
    endpoint_records: endpointRecords,
  }, { authority });
}

function normalizeRecordArray(value, label, origin, authority) {
  if (value === undefined) return [];
  const descriptors = assertOrdinaryDataArray(value, label);
  if (value.length > MAX_RECORDS) throw new RangeError(`${label} exceeds record limit`);
  const records = new Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    records[index] = normalizeVoiceEvidenceRecord(descriptors[String(index)].value, { origin, authority });
  }
  return records;
}

function assertOriginAndSource(origin, type, source) {
  if (origin === "endpoint") {
    if (!ENDPOINT_EVENT_TYPES.has(type) || source !== "client_observed") {
      throw new TypeError("endpoint evidence may assert only client-observed endpoint event types");
    }
    return;
  }
  if (!SERVER_EVENT_TYPES.has(type) || source === "client_observed") {
    throw new TypeError("server evidence cannot assert client-observed endpoint events");
  }
  if (type !== "release" && source === "server_authority") {
    throw new TypeError("server_authority source is reserved for release evidence");
  }
  if (type === "release" && source !== "server_authority") {
    throw new TypeError("release evidence requires server_authority source");
  }
  if (
    ["session", "turn", "server_audio_write"].includes(type)
    && source !== "gateway_observed"
    && source !== "deterministic_derived"
  ) {
    throw new TypeError(`${type} evidence requires gateway_observed or deterministic_derived source`);
  }
  if (type === "clock_calibration" && source !== "gateway_observed") {
    throw new TypeError("clock calibration requires gateway_observed source");
  }
}

function assertAllowedRecordKeys(input, type) {
  const allowed = new Set([...BASE_RECORD_KEYS, ...TYPE_FIELDS[type]]);
  assertExactKeys(input, allowed, "voice evidence record");
  for (const field of REQUIRED_TYPE_FIELDS[type]) {
    if (!hasOwn(input, field)) throw new TypeError(`${type} evidence requires ${field}`);
  }
}

function assertSingleEndpointObserver(records) {
  const endpointRecords = records.filter((record) => record.source === "client_observed");
  const identities = new Set(endpointRecords.map((record) => `${record.surface}:${record.observer_id}`));
  const clockEpochs = new Set(
    endpointRecords
      .filter((record) => record.clock_id)
      .map((record) => `${record.surface}:${record.observer_id}:${record.clock_id}`),
  );
  if (identities.size > 1 || clockEpochs.size > 1) {
    throw new TypeError("one timeline cannot combine different endpoint observers or clock epochs");
  }
  const calibrations = records.filter((record) => record.type === "clock_calibration");
  if (calibrations.length === 0) return;
  if (identities.size !== 1 || clockEpochs.size !== 1) {
    throw new TypeError("clock calibration requires one matching endpoint observer and clock epoch");
  }
  const [identity] = identities;
  const [clockEpoch] = clockEpochs;
  for (const calibration of calibrations) {
    if (
      `${calibration.surface}:${calibration.observer_id}` !== identity
      || `${calibration.surface}:${calibration.observer_id}:${calibration.clock_id}` !== clockEpoch
    ) {
      throw new TypeError("clock calibration must match the timeline endpoint observer, surface, and clock epoch");
    }
  }
}

function normalizeAuthority(value) {
  if (value === undefined) return Object.freeze({});
  assertBoundedData(value, 512, "voice evidence authority");
  assertNoSensitiveData(value, "voice evidence authority");
  assertPlainDataObject(value, "voice evidence authority");
  assertExactKeys(value, AUTHORITY_KEYS, "voice evidence authority");
  const output = {};
  if (hasOwn(value, "tenant_id")) output.tenant_id = exactId(value.tenant_id, "authority.tenant_id");
  if (hasOwn(value, "release_id")) output.release_id = exactId(value.release_id, "authority.release_id");
  return Object.freeze(output);
}

function validateEndpointMilestones(records) {
  let receipt = null;
  let playout = null;
  for (const record of records) {
    if (record.type === "endpoint_audio_receipt") {
      if (receipt) throw new TypeError("one timeline accepts at most one endpoint audio receipt milestone");
      receipt = record;
    } else if (record.type === "endpoint_observed_playout") {
      if (playout) throw new TypeError("one timeline accepts at most one endpoint observed playout milestone");
      playout = record;
    }
  }
  if (playout && !receipt) {
    throw new TypeError("endpoint playout evidence requires endpoint receipt evidence");
  }
  if (receipt && playout) {
    const causal = (
      receipt.monotonic_ms !== undefined
      && playout.monotonic_ms !== undefined
      && receipt.clock_id === playout.clock_id
    )
      ? receipt.monotonic_ms <= playout.monotonic_ms
      : receipt.observed_at_ms <= playout.observed_at_ms;
    if (!causal) throw new TypeError("endpoint playout cannot precede its receipt observation");
  }
  return Object.freeze({ receipt, playout });
}

function orderEvidenceRecords(records) {
  const navigationTimeByEventId = new Map();
  const monotonicGroups = new Map();
  for (const record of records) {
    if (record.monotonic_ms === undefined) {
      navigationTimeByEventId.set(record.event_id, record.observed_at_ms);
      continue;
    }
    const groupKey = JSON.stringify([
      record.source,
      record.observer_id || "",
      record.surface || "",
      record.clock_id || "",
    ]);
    const group = monotonicGroups.get(groupKey) || [];
    group.push(record);
    monotonicGroups.set(groupKey, group);
  }
  for (const group of monotonicGroups.values()) {
    group.sort(compareMonotonicDomainRecords);
    let navigationTime = 0;
    for (const record of group) {
      navigationTime = Math.max(navigationTime, record.observed_at_ms);
      navigationTimeByEventId.set(record.event_id, navigationTime);
    }
  }
  const ordered = records.slice();
  ordered.sort((left, right) => compareNavigationRecords(left, right, navigationTimeByEventId));
  return ordered;
}

function compareMonotonicDomainRecords(left, right) {
  if (left.monotonic_ms !== right.monotonic_ms) return left.monotonic_ms - right.monotonic_ms;
  if (left.type !== right.type) return compareCanonicalStrings(left.type, right.type);
  return compareCanonicalStrings(left.event_id, right.event_id);
}

function compareNavigationRecords(left, right, navigationTimeByEventId) {
  const leftNavigationTime = navigationTimeByEventId.get(left.event_id);
  const rightNavigationTime = navigationTimeByEventId.get(right.event_id);
  if (leftNavigationTime !== rightNavigationTime) return leftNavigationTime - rightNavigationTime;
  let compared = compareCanonicalStrings(left.source, right.source);
  if (compared !== 0) return compared;
  compared = compareCanonicalStrings(left.observer_id || "", right.observer_id || "");
  if (compared !== 0) return compared;
  compared = compareCanonicalStrings(left.surface || "", right.surface || "");
  if (compared !== 0) return compared;
  compared = compareCanonicalStrings(left.clock_id || "", right.clock_id || "");
  if (compared !== 0) return compared;
  compared = compareOptionalInteger(left.monotonic_ms, right.monotonic_ms);
  if (compared !== 0) return compared;
  if (left.type !== right.type) return compareCanonicalStrings(left.type, right.type);
  return compareCanonicalStrings(left.event_id, right.event_id);
}

function compareOptionalInteger(left, right) {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return left - right;
}

function compareCanonicalStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deriveClockRelation(records) {
  const endpointClocks = new Set(
    records
      .filter((record) => record.source === "client_observed" && record.clock_id)
      .map((record) => `${record.surface}:${record.observer_id}:${record.clock_id}`),
  );
  const hasClientEvidence = records.some((record) => record.source === "client_observed");
  const hasServerEvidence = records.some((record) => record.source !== "client_observed");
  if (!hasClientEvidence) return Object.freeze({ status: "server_only" });
  if (!hasServerEvidence) return Object.freeze({ status: "endpoint_only" });
  const calibrations = records.filter((record) => (
    record.type === "clock_calibration"
    && record.source === "gateway_observed"
    && endpointClocks.has(`${record.surface}:${record.observer_id}:${record.clock_id}`)
  ));
  if (calibrations.length === 0) return Object.freeze({ status: "uncertain" });
  const lower = Math.min(...calibrations.map((record) => record.offset_ms - record.uncertainty_ms));
  const upper = Math.max(...calibrations.map((record) => record.offset_ms + record.uncertainty_ms));
  const offsetMs = Math.round((lower + upper) / 2);
  const uncertaintyMs = Math.ceil((upper - lower) / 2);
  return Object.freeze({ status: "calibrated", offset_ms: offsetMs, uncertainty_ms: uncertaintyMs });
}

function deriveMonotonicDurations({ receipt, playout }) {
  if (
    !receipt
    || !playout
    || receipt.monotonic_ms === undefined
    || playout.monotonic_ms === undefined
    || receipt.source !== playout.source
    || receipt.observer_id !== playout.observer_id
    || receipt.surface !== playout.surface
    || receipt.clock_id !== playout.clock_id
  ) return Object.freeze({});
  return Object.freeze({
    endpoint_receipt_to_playout_ms: playout.monotonic_ms - receipt.monotonic_ms,
  });
}

function assertNoSensitiveData(value, label, seen = new WeakSet(), path = []) {
  assertSafeContentPath(path, value, label);
  if (typeof value === "string") {
    if (isCredentialLikeValue(value)) {
      throw new TypeError(`${label} contains a credential-like value`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new TypeError(`${label} cannot be cyclic`);
  seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = assertOrdinaryDataArray(value, label);
    for (let index = 0; index < value.length; index += 1) {
      assertNoSensitiveData(descriptors[String(index)].value, label, seen, path);
    }
    return;
  }
  const descriptors = assertPlainDataObject(value, label);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    const normalized = normalizeSensitiveKey(key);
    if (isSensitiveDataKey(normalized) && !isSafeContentMetadataValue(normalized, descriptor.value)) {
      throw new TypeError(`${label} contains forbidden content or credential key: ${key}`);
    }
    assertNoSensitiveData(descriptor.value, label, seen, [...path, normalized]);
  }
}

function assertSafeContentPath(path, value, label) {
  if (path.length === 0) return;
  const leaf = path[path.length - 1];
  if (SAFE_AUDIO_METADATA_KEYS.has(leaf) && isSafeAudioMetadataValue(leaf, value)) return;
  const audioIndex = path.findIndex((segment) => normalizedKeyHasPart(segment, "audio"));
  if (audioIndex < 0) return;
  if (audioIndex === path.length - 1) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return;
    throw new TypeError(`${label} contains raw or unbounded audio content`);
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (AUDIO_CONTAINER_KEYS.has(leaf)) return;
    throw new TypeError(`${label} contains unsupported audio content container: ${leaf}`);
  }
  if (AUDIO_METADATA_KEYS.has(leaf) && isBoundedAudioMetadataValue(leaf, value)) return;
  throw new TypeError(`${label} contains raw or unbounded audio content: ${leaf}`);
}

function isSafeContentMetadataValue(key, value) {
  if (!SAFE_CONTENT_METADATA_KEYS.has(key)) return false;
  if (key === "content_type") {
    return typeof value === "string"
      && value.length >= 1
      && value.length <= 128
      && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:;\s*[A-Za-z0-9._-]+=[A-Za-z0-9._-]+)*$/.test(value);
  }
  if (key.endsWith("_ms")) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DURATION_MS;
  }
  if (key.endsWith("_count")) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_WALK_NODES;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_AUDIO_BYTES;
}

function isSafeAudioMetadataValue(key, value) {
  if (!SAFE_AUDIO_METADATA_KEYS.has(key)) return false;
  const maximum = key === "audio_chunks"
    ? MAX_WALK_NODES
    : (key.endsWith("_ms") ? MAX_DURATION_MS : MAX_AUDIO_BYTES);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function normalizedKeyHasPart(value, expected) {
  return value.split("_").includes(expected);
}

function isBoundedAudioMetadataValue(key, value) {
  if (["archived", "present", "retained", "spoke"].includes(key)) return typeof value === "boolean";
  if ([
    "buffered_ms",
    "bytes",
    "channels",
    "chunks",
    "duration_ms",
    "measurement_uncertainty_ms",
    "played_ms",
    "sample_rate",
  ].includes(key)) return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (typeof value !== "string" || value.length < 1 || value.length > 512) return false;
  if (key === "href" && /^data:/i.test(value)) return false;
  return true;
}

function normalizeSensitiveKey(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isSensitiveDataKey(normalized) {
  return SENSITIVE_DATA_KEYS.has(normalized)
    || normalized.split("_").some((part) => SENSITIVE_KEY_PARTS.has(part))
    || normalized === "raw"
    || normalized.startsWith("raw_")
    || normalized.endsWith("_raw")
    || normalized.startsWith("payload_")
    || normalized.endsWith("_payload")
    || normalized.startsWith("blob_")
    || normalized.endsWith("_blob")
    || normalized.startsWith("body_")
    || normalized.endsWith("_body")
    || normalized.startsWith("data_")
    || normalized.endsWith("_data")
    || normalized.startsWith("header_")
    || normalized.endsWith("_header")
    || normalized.startsWith("headers_")
    || normalized.endsWith("_headers")
    || normalized.startsWith("key_")
    || normalized.endsWith("_key")
    || normalized.startsWith("prompt_")
    || normalized.startsWith("authorization_")
    || normalized.startsWith("cookie_")
    || normalized.endsWith("_auth")
    || normalized.endsWith("_credential")
    || normalized.endsWith("_credentials")
    || normalized.endsWith("_secret")
    || normalized.endsWith("_token")
    || normalized.endsWith("_password")
    || normalized.endsWith("_passwd")
    || normalized.endsWith("_cookie")
    || normalized.endsWith("_authorization")
    || normalized.endsWith("_api_key")
    || normalized.endsWith("_private_key")
    || normalized.endsWith("_secret_key");
}

function isCredentialLikeValue(value) {
  return CREDENTIAL_LIKE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function assertBoundedData(value, maxBytes, label) {
  const state = { bytes: 0, nodes: 0, seen: new WeakSet() };
  walkBoundedData(value, state, 0, label, maxBytes);
}

function walkBoundedData(value, state, depth, label, maxBytes) {
  state.nodes += 1;
  if (state.nodes > MAX_WALK_NODES) throw new RangeError(`${label} exceeds node limit`);
  if (depth > MAX_WALK_DEPTH) throw new RangeError(`${label} exceeds nesting limit`);
  if (value === null) {
    addBoundedBytes(state, 4, maxBytes, label);
    return;
  }
  if (typeof value === "string") {
    addBoundedBytes(state, Buffer.byteLength(JSON.stringify(value), "utf8"), maxBytes, label);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`);
    addBoundedBytes(state, Buffer.byteLength(JSON.stringify(value), "utf8"), maxBytes, label);
    return;
  }
  if (typeof value === "boolean") {
    addBoundedBytes(state, value ? 4 : 5, maxBytes, label);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${label} contains unsupported data`);
  if (state.seen.has(value)) throw new TypeError(`${label} cannot be cyclic`);
  state.seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = assertOrdinaryDataArray(value, label);
    addBoundedBytes(state, 2 + Math.max(0, value.length - 1), maxBytes, label);
    for (let index = 0; index < value.length; index += 1) {
      walkBoundedData(descriptors[String(index)].value, state, depth + 1, label, maxBytes);
    }
    return;
  }
  const descriptors = assertPlainDataObject(value, label);
  const entries = Object.entries(descriptors);
  addBoundedBytes(state, 2 + Math.max(0, entries.length - 1), maxBytes, label);
  for (const [key, descriptor] of entries) {
    addBoundedBytes(state, Buffer.byteLength(JSON.stringify(key), "utf8") + 1, maxBytes, label);
    walkBoundedData(descriptor.value, state, depth + 1, label, maxBytes);
  }
}

function addBoundedBytes(state, bytes, maxBytes, label) {
  state.bytes += bytes;
  if (state.bytes > maxBytes) throw new RangeError(`${label} exceeds byte limit`);
}

function assertOrdinaryDataArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must use the standard Array prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} arrays cannot contain symbol keys`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || lengthDescriptor.get || lengthDescriptor.set || !Number.isSafeInteger(lengthDescriptor.value)) {
    throw new TypeError(`${label} arrays require an ordinary length data property`);
  }
  if (lengthDescriptor.value > MAX_WALK_NODES) {
    throw new RangeError(`${label} array exceeds item limit`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let itemCount = 0;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length") continue;
    if (
      !/^(?:0|[1-9]\d*)$/.test(key)
      || Number(key) >= value.length
      || descriptor.get
      || descriptor.set
      || descriptor.enumerable !== true
      || !hasOwn(descriptor, "value")
    ) {
      throw new TypeError(`${label} arrays must contain indexed enumerable own-data entries only`);
    }
    itemCount += 1;
  }
  if (itemCount !== value.length) throw new TypeError(`${label} arrays cannot contain holes`);
  return descriptors;
}

function assertPlainDataObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} cannot contain symbol keys`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set || descriptor.enumerable !== true) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
  }
  return descriptors;
}

function optionalPlainDataObject(value) {
  if (value === undefined || value === null) return {};
  assertPlainDataObject(value, "voice diagnosis field");
  return value;
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported key: ${key}`);
  }
}

function exactId(value, label) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_ID_LENGTH
    || !ID_PATTERN.test(value)
    || isCredentialLikeValue(value)
  ) {
    throw new TypeError(`${label} must be a canonical opaque authority token`);
  }
  return value;
}

function exactEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) throw new TypeError(`invalid ${label}`);
  return value;
}

function boundedSafeInteger(value, minimum, maximum, label) {
  const number = safeInteger(value, label);
  if (number < minimum || number > maximum) throw new RangeError(`${label} is outside its allowed range`);
  return number;
}

function safeInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer`);
  }
  return value;
}

function diagnosisTimestamp(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new TypeError("voice diagnosis requires a bounded timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError("voice diagnosis timestamp must be canonical ISO-8601 UTC");
  }
  return parsed;
}

function optionalBoundedInteger(value, key, minimum, maximum, label) {
  if (!hasOwn(value, key)) return 0;
  return boundedSafeInteger(value[key], minimum, maximum, label);
}

function frozenAttribution(value) {
  return Object.freeze(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

module.exports = {
  MAX_RECORDS,
  MAX_RECORD_BYTES,
  buildVoiceReliabilityTimeline,
  endpointPlaybackAttribution,
  normalizeVoiceEvidenceRecord,
  recordsFromVoiceDiagnosis,
};
