"use strict";

const crypto = require("node:crypto");

const CURRENT_VERSION = 2;
const PREVIOUS_VERSION = 1;
const SUPPORTED_VERSIONS = Object.freeze([CURRENT_VERSION, PREVIOUS_VERSION]);
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_CONTEXT_BYTES = 32 * 1024;
const MAX_REPLAY_EVENTS = 256;
const MAX_REPLAY_BYTES = 1024 * 1024;
const MAX_PENDING_EVENTS = 128;
const MAX_PENDING_BYTES = 512 * 1024;
const MAX_ECHO_RUNS = 256;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

const TYPES = new Set([
  "hello", "hello.accepted", "resume", "turn.text", "turn.voice.started",
  "turn.voice.completed", "route.selected", "run.queued", "run.running",
  "run.needs_approval", "run.completed", "run.failed", "artifact.created",
  "message.created", "action.proposed", "action.approved", "action.receipted",
  "session.snapshot_required",
]);
const SURFACE_KINDS = new Set(["browser", "android", "macos", "ios", "windows", "cli", "messaging", "test"]);
const MODES = new Set(["text", "voice", "live_voice", "event"]);
const ACTION_KINDS = new Set(["open_url", "open_app", "dial", "browser_task", "page_tweak", "file_export"]);
const APPROVAL_CLASSES = new Set(["none", "confirm", "sensitive"]);
const RECEIPT_OUTCOMES = new Set(["executed", "rejected", "expired", "stale", "failed", "canceled"]);
const RUN_STATUSES = new Set(["queued", "running", "needs_approval", "completed", "failed"]);
const EXECUTABLE_KEYS = new Set(["script", "javascript", "shell", "command", "css", "code"]);
const SECRET_KEYS = new Set(["api_key", "apikey", "access_token", "refresh_token", "client_secret", "provider_key", "authorization"]);
const SERVER_REPLAY_TYPES = new Set([
  "hello.accepted", "route.selected", "run.queued", "run.running",
  "run.needs_approval", "run.completed", "run.failed", "artifact.created",
  "message.created", "action.proposed", "session.snapshot_required",
]);
const CREDENTIAL_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i,
  /\b(?:sk|github_pat|ghp|AIza|ya29)[-_A-Za-z0-9.]{12,}\b/,
  /[?&](?:code|access_token|refresh_token|api_key)=[^&#\s]{8,}/i,
];

function negotiateVersion(hello = {}) {
  const offered = Array.isArray(hello.supported_versions) ? hello.supported_versions : [];
  const normalized = [...new Set(offered.filter(Number.isSafeInteger))].sort((a, b) => b - a);
  const selected = normalized.find((version) => SUPPORTED_VERSIONS.includes(version));
  if (!selected) throw protocolError("unsupported_version", "no supported protocol version overlap");
  return selected;
}

function validateEnvelope(input, options = {}) {
  if (!isRecord(input)) throw protocolError("invalid_envelope", "envelope must be an object");
  assertBoundedJson(input, MAX_ENVELOPE_BYTES, "envelope");
  assertNoDangerousData(input, "envelope");
  const version = requireVersion(input.version);
  const type = requireEnum(input.type, TYPES, "type");
  const envelope = {
    version,
    type,
    message_id: requireId(input.message_id, "message_id"),
    session_id: requireId(input.session_id, "session_id"),
    surface: validateSurface(input.surface),
    timestamp: requireTimestamp(input.timestamp),
  };
  if (input.sequence !== undefined) envelope.sequence = requirePositiveInteger(input.sequence, "sequence");
  if (input.reply_to !== undefined) envelope.reply_to = requireId(input.reply_to, "reply_to");
  if (type === "hello") envelope.payload = validateHello(input.payload);
  else if (type === "hello.accepted") envelope.payload = validateHelloAccepted(input.payload);
  else if (type === "resume") envelope.payload = validateResume(input.payload);
  else if (type === "turn.text") envelope.payload = validateTextTurn(input.payload);
  else if (type === "turn.voice.started" || type === "turn.voice.completed") envelope.payload = validateVoiceEvent(input.payload, type);
  else if (type === "route.selected") envelope.payload = validateRoute(input.payload);
  else if (type.startsWith("run.")) envelope.payload = validateRunEvent(input.payload, type);
  else if (type === "action.proposed") envelope.payload = validateProposal(input.payload, envelope);
  else if (type === "action.approved") envelope.payload = validateApproval(input.payload, envelope);
  else if (type === "action.receipted") envelope.payload = validateReceipt(input.payload, envelope);
  else if (type === "artifact.created") envelope.payload = validateArtifact(input.payload);
  else if (type === "message.created") envelope.payload = validateMessage(input.payload);
  else if (type === "session.snapshot_required") envelope.payload = validateSnapshotRequired(input.payload);
  if (options.require_sequence && envelope.sequence === undefined) {
    throw protocolError("missing_sequence", "server event requires sequence");
  }
  return deepFreeze(envelope);
}

function validateSurface(input) {
  if (!isRecord(input)) throw protocolError("invalid_surface", "surface must be an object");
  return {
    id: requireId(input.id, "surface.id"),
    kind: requireEnum(input.kind, SURFACE_KINDS, "surface.kind"),
    mode: requireEnum(input.mode, MODES, "surface.mode"),
    device_id: input.device_id === undefined ? undefined : requireId(input.device_id, "surface.device_id"),
  };
}

function validateHello(input) {
  if (!isRecord(input)) throw protocolError("invalid_hello", "hello payload must be an object");
  return {
    supported_versions: validateVersionList(input.supported_versions),
    capabilities: validateStringList(input.capabilities, "payload.capabilities", 32, 80),
  };
}

function validateHelloAccepted(input) {
  if (!isRecord(input)) throw protocolError("invalid_hello", "hello.accepted payload must be an object");
  return {
    selected_version: requireVersion(input.selected_version),
    heartbeat_ms: requireBoundedInteger(input.heartbeat_ms, 1000, 120000, "payload.heartbeat_ms"),
    max_envelope_bytes: requireBoundedInteger(input.max_envelope_bytes, 1024, MAX_ENVELOPE_BYTES, "payload.max_envelope_bytes"),
  };
}

function validateResume(input) {
  if (!isRecord(input)) throw protocolError("invalid_resume", "resume payload must be an object");
  return {
    after_sequence: requireNonNegativeInteger(input.after_sequence, "payload.after_sequence"),
    last_message_id: input.last_message_id === undefined ? undefined : requireId(input.last_message_id, "payload.last_message_id"),
  };
}

function validateTextTurn(input) {
  if (!isRecord(input)) throw protocolError("invalid_payload", "text turn payload must be an object");
  const text = requireBoundedString(input.text, MAX_TEXT_BYTES, "payload.text");
  const result = { text };
  if (input.context !== undefined) {
    assertSafeData(input.context, "payload.context");
    assertBoundedJson(input.context, MAX_CONTEXT_BYTES, "payload.context");
    result.context = cloneData(input.context);
  }
  return result;
}

function validateVoiceEvent(input, type) {
  if (!isRecord(input)) throw protocolError("invalid_voice_event", `${type} payload must be an object`);
  const result = { turn_id: requireId(input.turn_id, "payload.turn_id") };
  if (type === "turn.voice.started") {
    result.encoding = requireEnum(input.encoding, new Set(["pcm_s16le"]), "payload.encoding");
    result.sample_rate_hz = requireBoundedInteger(input.sample_rate_hz, 8000, 48000, "payload.sample_rate_hz");
    result.channels = requireBoundedInteger(input.channels, 1, 2, "payload.channels");
  } else {
    result.outcome = requireEnum(input.outcome, new Set(["completed", "interrupted", "canceled", "failed"]), "payload.outcome");
    if (input.transcript !== undefined) result.transcript = requireBoundedString(input.transcript, MAX_TEXT_BYTES, "payload.transcript");
  }
  return result;
}

function validateRoute(input) {
  if (!isRecord(input)) throw protocolError("invalid_route", "route payload must be an object");
  return { turn_id: requireId(input.turn_id, "payload.turn_id"), backend: requireId(input.backend, "payload.backend"), workflow: requireId(input.workflow, "payload.workflow") };
}

function validateRunEvent(input, type) {
  if (!isRecord(input)) throw protocolError("invalid_run_event", `${type} payload must be an object`);
  const status = requireEnum(input.status, RUN_STATUSES, "payload.status");
  if (status !== type.slice("run.".length)) throw protocolError("run_status_mismatch", "run event type and status must agree");
  return { run_id: requireId(input.run_id, "payload.run_id"), turn_id: input.turn_id === undefined ? undefined : requireId(input.turn_id, "payload.turn_id"), status };
}

function validateMessage(input) {
  if (!isRecord(input)) throw protocolError("invalid_message", "message payload must be an object");
  return { role: requireEnum(input.role, new Set(["assistant", "system"]), "payload.role"), text: requireBoundedString(input.text, MAX_TEXT_BYTES, "payload.text") };
}

function validateSnapshotRequired(input) {
  if (!isRecord(input)) throw protocolError("invalid_snapshot", "snapshot-required payload must be an object");
  return { first_available_sequence: requirePositiveInteger(input.first_available_sequence, "payload.first_available_sequence"), reason: requireEnum(input.reason, new Set(["cursor_evicted", "state_reset"]), "payload.reason") };
}

function validateProposal(input, envelope) {
  if (!isRecord(input)) throw protocolError("invalid_proposal", "proposal payload must be an object");
  assertNoExecutableKeys(input, "proposal");
  const expiresAt = requireTimestamp(input.expires_at, "payload.expires_at");
  const preconditions = input.preconditions;
  if (!isRecord(preconditions) || Object.keys(preconditions).length === 0) {
    throw protocolError("missing_preconditions", "proposal requires state preconditions");
  }
  assertSafeData(preconditions, "payload.preconditions");
  const params = input.params === undefined ? {} : input.params;
  assertSafeData(params, "payload.params");
  return {
    proposal_id: requireId(input.proposal_id, "payload.proposal_id"),
    kind: requireEnum(input.kind, ACTION_KINDS, "payload.kind"),
    approval_class: requireEnum(input.approval_class, APPROVAL_CLASSES, "payload.approval_class"),
    expires_at: expiresAt,
    preconditions: cloneData(preconditions),
    params: cloneData(params),
    proposed_by: input.proposed_by === undefined ? "gateway" : requireId(input.proposed_by, "payload.proposed_by"),
    session_id: envelope.session_id,
  };
}

function validateApproval(input, envelope) {
  if (!isRecord(input)) throw protocolError("invalid_approval", "approval payload must be an object");
  const proposalMessageId = requireId(input.proposal_message_id, "payload.proposal_message_id");
  if (envelope.reply_to !== proposalMessageId) {
    throw protocolError("approval_proposal_mismatch", "approval reply_to must identify its proposal message");
  }
  return {
    proposal_id: requireId(input.proposal_id, "payload.proposal_id"),
    proposal_message_id: proposalMessageId,
    proposal_digest: requireDigest(input.proposal_digest, "payload.proposal_digest"),
    decision: requireEnum(input.decision, new Set(["approved", "rejected"]), "payload.decision"),
    actor_id: requireId(input.actor_id, "payload.actor_id"),
    decided_at: requireTimestamp(input.decided_at, "payload.decided_at"),
  };
}

function validateReceipt(input, envelope) {
  if (!isRecord(input)) throw protocolError("invalid_receipt", "receipt payload must be an object");
  assertNoExecutableKeys(input, "receipt");
  const proposalMessageId = requireId(input.proposal_message_id, "payload.proposal_message_id");
  if (envelope.reply_to !== proposalMessageId) {
    throw protocolError("receipt_proposal_mismatch", "receipt reply_to must identify its proposal message");
  }
  return {
    receipt_id: requireId(input.receipt_id, "payload.receipt_id"),
    proposal_id: requireId(input.proposal_id, "payload.proposal_id"),
    proposal_message_id: proposalMessageId,
    approval_message_id: input.approval_message_id === undefined ? undefined : requireId(input.approval_message_id, "payload.approval_message_id"),
    outcome: requireEnum(input.outcome, RECEIPT_OUTCOMES, "payload.outcome"),
    observed_at: requireTimestamp(input.observed_at, "payload.observed_at"),
    state_hash: input.state_hash === undefined ? undefined : requireDigest(input.state_hash, "payload.state_hash"),
    session_id: envelope.session_id,
    surface_id: envelope.surface.id,
  };
}

function validateArtifact(input) {
  if (!isRecord(input)) throw protocolError("invalid_artifact", "artifact payload must be an object");
  return {
    artifact_id: requireId(input.artifact_id, "payload.artifact_id"),
    run_id: requireId(input.run_id, "payload.run_id"),
    kind: requireEnum(input.kind, new Set(["text", "markdown", "json", "file_ref"]), "payload.kind"),
    title: requireBoundedString(input.title, 512, "payload.title"),
    digest: requireDigest(input.digest, "payload.digest"),
  };
}

function canExecuteProposal(proposalEnvelope, context = {}) {
  let envelope;
  try { envelope = validateEnvelope(proposalEnvelope); }
  catch (error) { return decision(false, error.code || "invalid_proposal"); }
  const contextFailure = proposalContextFailure(envelope, context);
  if (contextFailure) return decision(false, contextFailure);
  if (envelope.payload.approval_class === "none") return decision(true, "eligible");
  return validateApprovalForProposal(envelope, context);
}

function proposalContextFailure(envelope, context) {
  if (envelope.type !== "action.proposed") return "not_a_proposal";
  const now = Date.parse(context.now || new Date().toISOString());
  if (!Number.isFinite(now)) return "invalid_clock";
  if (Date.parse(envelope.payload.expires_at) <= now) return "expired";
  if (context.session_id !== envelope.session_id) return "session_mismatch";
  if (context.surface_id !== envelope.surface.id) return "surface_mismatch";
  if (!preconditionsMatch(envelope.payload.preconditions, context.state || {})) return "stale_state";
  return null;
}

function validateApprovalForProposal(envelope, context) {
  let approval;
  try { approval = validateEnvelope(context.approval); }
  catch { return decision(false, "approval_required"); }
  const mismatch = approvalMismatch(envelope, approval, context);
  return mismatch ? decision(false, mismatch) : decision(true, "eligible");
}

function approvalMismatch(proposal, approval, context) {
  if (approval.type !== "action.approved") return "approval_required";
  return approvalScopeMismatch(proposal, approval) || approvalBindingMismatch(proposal, approval) || approvalDecisionMismatch(proposal, approval, context);
}

function approvalScopeMismatch(proposal, approval) {
  if (approval.version !== proposal.version) return "approval_version_mismatch";
  if (approval.session_id !== proposal.session_id) return "approval_session_mismatch";
  if (approval.surface.id !== proposal.surface.id) return "approval_surface_mismatch";
  return null;
}

function approvalBindingMismatch(proposal, approval) {
  if (approval.payload.proposal_id !== proposal.payload.proposal_id || approval.payload.proposal_message_id !== proposal.message_id) return "approval_proposal_mismatch";
  if (approval.payload.proposal_digest !== proposalDigest(proposal)) return "approval_proposal_digest_mismatch";
  return null;
}

function approvalDecisionMismatch(proposal, approval, context) {
  const decidedAt = Date.parse(approval.payload.decided_at);
  const now = Date.parse(context.now || new Date().toISOString());
  if (decidedAt < Date.parse(proposal.timestamp) || decidedAt > now) return "approval_time_invalid";
  if (approval.payload.decision !== "approved") return "approval_rejected";
  return null;
}

function createSessionReplay(options = {}) {
  const sessionId = requireId(options.session_id, "session_id");
  const bySequence = new Map();
  const byMessageId = new Map();
  let totalBytes = 0;
  function accept(input) {
    const event = validateEnvelope(input, { require_sequence: true });
    if (!SERVER_REPLAY_TYPES.has(event.type)) throw protocolError("invalid_replay_type", "replay accepts server event types only");
    if (event.session_id !== sessionId) throw protocolError("session_mismatch", "event belongs to another session");
    const bytes = jsonBytes(event);
    const existing = bySequence.get(event.sequence);
    if (existing) {
      if (existing.message_id !== event.message_id || stableJson(existing) !== stableJson(event)) {
        throw protocolError("sequence_conflict", "sequence was reused with different content");
      }
      return { accepted: false, duplicate: true, event: existing };
    }
    const messageDuplicate = byMessageId.get(event.message_id);
    if (messageDuplicate) {
      if (stableJson(messageDuplicate) !== stableJson(event)) {
        throw protocolError("message_conflict", "message_id was reused with different content");
      }
      return { accepted: false, duplicate: true, event: messageDuplicate };
    }
    const lastSequence = Math.max(0, ...bySequence.keys());
    if (lastSequence > 0 && event.sequence !== lastSequence + 1) {
      throw protocolError("sequence_gap", `expected sequence ${lastSequence + 1}`);
    }
    bySequence.set(event.sequence, event);
    byMessageId.set(event.message_id, event);
    totalBytes += bytes;
    trimReplay();
    return { accepted: true, duplicate: false, event };
  }
  function replayAfter(sequence = 0) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw protocolError("invalid_cursor", "cursor must be a non-negative safe integer");
    const events = sortedEvents();
    const first = events[0]?.sequence;
    if (first !== undefined && sequence > 0 && sequence < first - 1) {
      return { snapshot_required: true, events: [], first_available_sequence: first };
    }
    return { snapshot_required: false, events: events.filter((event) => event.sequence > sequence) };
  }
  function trimReplay() {
    for (const event of sortedEvents()) {
      if (bySequence.size <= MAX_REPLAY_EVENTS && totalBytes <= MAX_REPLAY_BYTES) break;
      bySequence.delete(event.sequence);
      byMessageId.delete(event.message_id);
      totalBytes -= jsonBytes(event);
    }
  }
  function sortedEvents() { return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence); }
  return Object.freeze({ accept, replayAfter, stats: () => ({ event_count: bySequence.size, byte_count: totalBytes }) });
}

function reconnectDelay(attempt, entropy = Math.random()) {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw protocolError("invalid_attempt", "attempt must be a non-negative safe integer");
  if (!Number.isFinite(entropy) || entropy < 0 || entropy > 1) throw protocolError("invalid_entropy", "entropy must be between 0 and 1");
  const cap = Math.min(30000, 250 * (2 ** Math.min(attempt, 16)));
  return Math.floor(entropy * cap);
}

function createEchoAdapter(options = {}) {
  const runs = new Map();
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
  return Object.freeze({
    metadata: () => deepFreeze({ id: "echo", display_name: "Aggie Echo", supports: { text: true, live_voice: false, sessions: true, tools: false, skills: false, artifacts: true, approvals: true } }),
    health: async () => deepFreeze({ ok: true, backend: "echo" }),
    sendTurn: async (envelope) => echoTurn(envelope),
    startRun: async (envelope) => {
      const turn = validateEnvelope(envelope);
      if (turn.type !== "turn.text") throw protocolError("invalid_turn", "echo startRun requires turn.text");
      const runId = `run_echo_${digest(turn.message_id).slice(0, 16)}`;
      const artifactId = `artifact_echo_${digest(`${turn.session_id}:${turn.message_id}`).slice(0, 16)}`;
      const record = deepFreeze({ run_id: runId, session_id: turn.session_id, status: "completed", created_at: now(), artifacts: [{ artifact_id: artifactId, run_id: runId, kind: "text", title: "Echo result", digest: digest(turn.payload.text), text: turn.payload.text }] });
      if (!runs.has(runId) && runs.size >= MAX_ECHO_RUNS) runs.delete(runs.keys().next().value);
      runs.set(runId, record);
      return record;
    },
    resumeRun: async (runId) => runs.get(requireId(runId, "run_id")) || null,
    cancelRun: async (runId) => {
      const record = runs.get(requireId(runId, "run_id"));
      if (!record) return null;
      return record.status === "completed" ? deepFreeze({ ...record, cancel_result: "already_terminal" }) : record;
    },
    listArtifacts: async (runId) => (runs.get(requireId(runId, "run_id"))?.artifacts || []).map((item) => deepFreeze({ ...item })),
  });

  function echoTurn(input) {
    const turn = validateEnvelope(input);
    if (turn.type !== "turn.text") throw protocolError("invalid_turn", "echo sendTurn requires turn.text");
    return deepFreeze({ assistant_text: turn.payload.text, session_id: turn.session_id, reply_to: turn.message_id, backend: "echo" });
  }
}

function createPendingBuffer() {
  const items = [];
  let bytes = 0;
  return Object.freeze({
    push(input) {
      const envelope = validateEnvelope(input);
      const size = jsonBytes(envelope);
      if (items.length >= MAX_PENDING_EVENTS || bytes + size > MAX_PENDING_BYTES) return { accepted: false, reason: "buffer_full" };
      items.push(envelope); bytes += size;
      return { accepted: true };
    },
    shift() { const item = items.shift(); if (item) bytes -= jsonBytes(item); return item; },
    stats: () => ({ event_count: items.length, byte_count: bytes }),
  });
}

function preconditionsMatch(expected, actual) {
  return Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && stableJson(actual[key]) === stableJson(value));
}
function decision(allowed, reason) { return deepFreeze({ allowed, reason }); }
function requireVersion(value) { if (!SUPPORTED_VERSIONS.includes(value)) throw protocolError("unsupported_version", `unsupported protocol version: ${value}`); return value; }
function requireId(value, field) { if (typeof value !== "string" || !ID_PATTERN.test(value)) throw protocolError("invalid_id", `${field} must match ${ID_PATTERN}`); return value; }
function requireEnum(value, allowed, field) { if (!allowed.has(value)) throw protocolError("invalid_enum", `${field} is unsupported`); return value; }
function requireTimestamp(value, field = "timestamp") { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw protocolError("invalid_timestamp", `${field} must be an ISO timestamp`); return new Date(value).toISOString(); }
function requirePositiveInteger(value, field) { if (!Number.isSafeInteger(value) || value <= 0) throw protocolError("invalid_integer", `${field} must be a positive safe integer`); return value; }
function requireNonNegativeInteger(value, field) { if (!Number.isSafeInteger(value) || value < 0) throw protocolError("invalid_integer", `${field} must be a non-negative safe integer`); return value; }
function requireBoundedInteger(value, minimum, maximum, field) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw protocolError("invalid_integer", `${field} must be between ${minimum} and ${maximum}`); return value; }
function requireBoundedString(value, maxBytes, field) { if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maxBytes) throw protocolError("invalid_string", `${field} exceeds its bound or is empty`); return value; }
function requireDigest(value, field) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw protocolError("invalid_digest", `${field} must be lowercase sha256 hex`); return value; }
function assertBoundedJson(value, maxBytes, field) { let size; try { size = jsonBytes(value); } catch { throw protocolError("invalid_json", `${field} must be JSON serializable`); } if (size > maxBytes) throw protocolError("too_large", `${field} exceeds ${maxBytes} bytes`); }
function assertSafeData(value, field, depth = 0) { if (depth > 8) throw protocolError("too_deep", `${field} exceeds depth 8`); if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return; if (Array.isArray(value)) { if (value.length > 64) throw protocolError("too_many_items", `${field} exceeds 64 items`); value.forEach((item, index) => assertSafeData(item, `${field}[${index}]`, depth + 1)); return; } if (!isRecord(value)) throw protocolError("unsafe_value", `${field} contains a non-data value`); if (Object.keys(value).length > 64) throw protocolError("too_many_fields", `${field} exceeds 64 fields`); assertNoExecutableKeys(value, field); for (const [key, item] of Object.entries(value)) { if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) throw protocolError("invalid_field", `${field} contains invalid field name`); assertSafeData(item, `${field}.${key}`, depth + 1); } }
function assertNoExecutableKeys(value, field) { for (const key of Object.keys(value)) { const normalized = key.toLowerCase(); if (EXECUTABLE_KEYS.has(normalized)) throw protocolError("executable_payload", `${field} contains forbidden executable field ${key}`); if (SECRET_KEYS.has(normalized)) throw protocolError("secret_payload", `${field} contains forbidden credential field ${key}`); } }
function assertNoDangerousData(value, field, depth = 0) {
  if (depth > 12) throw protocolError("too_deep", `${field} exceeds security scan depth 12`);
  if (typeof value === "string") {
    if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) throw protocolError("secret_payload", `${field} contains credential-shaped data`);
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) { value.forEach((item, index) => assertNoDangerousData(item, `${field}[${index}]`, depth + 1)); return; }
  if (!isRecord(value)) return;
  assertNoExecutableKeys(value, field);
  for (const [key, item] of Object.entries(value)) assertNoDangerousData(item, `${field}.${key}`, depth + 1);
}
function validateVersionList(input) { if (!Array.isArray(input) || input.length < 1 || input.length > 8 || !input.every(Number.isSafeInteger)) throw protocolError("invalid_versions", "supported_versions must contain 1-8 integer versions"); return [...new Set(input)]; }
function validateStringList(input, field, maxItems, maxBytes) { if (!Array.isArray(input) || input.length > maxItems) throw protocolError("invalid_list", `${field} must be an array with at most ${maxItems} items`); return input.map((item, index) => requireBoundedString(item, maxBytes, `${field}[${index}]`)); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function cloneData(value) { return JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; }
function jsonBytes(value) { return Buffer.byteLength(JSON.stringify(value)); }
function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function digest(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function proposalDigest(envelope) {
  return digest(stableJson({
    version: envelope.version,
    message_id: envelope.message_id,
    session_id: envelope.session_id,
    surface: envelope.surface,
    timestamp: envelope.timestamp,
    payload: envelope.payload,
  }));
}
function protocolError(code, message) { const error = new Error(message); error.code = code; return error; }

module.exports = {
  CURRENT_VERSION, PREVIOUS_VERSION, SUPPORTED_VERSIONS, MAX_ENVELOPE_BYTES,
  MAX_REPLAY_EVENTS, MAX_REPLAY_BYTES, MAX_PENDING_EVENTS, MAX_PENDING_BYTES, MAX_ECHO_RUNS,
  negotiateVersion, validateEnvelope, canExecuteProposal, createSessionReplay,
  reconnectDelay, createEchoAdapter, createPendingBuffer, proposalDigest,
};
