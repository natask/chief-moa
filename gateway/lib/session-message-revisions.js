"use strict";

const { SESSION_MESSAGE_TEXT_MAX_CHARS } = require("./session-messages");

const SESSION_MESSAGE_REVISIONS_VERSION = "session_message_revisions.v1";
const MESSAGE_ROLES = new Set(["user", "assistant"]);
const METADATA_MAX_CHARS = 256;
const REASON_MAX_CHARS = 1_024;
const HISTORY_FIELDS = new Set([
  "version", "message_id", "session_id", "turn_id", "role", "incognito",
  "persisted", "deleted_at", "current_revision", "revisions",
]);
const REVISION_FIELDS = new Set([
  "message_id", "session_id", "turn_id", "role", "revision", "text",
  "actor", "source", "reason", "created_at",
]);

function createMessageRevisionHistory(input = {}) {
  assertRetained(input);
  assertOptionalCanonicalPrivacy(input);
  const binding = normalizeBinding(input);
  const revision = createRevision(binding, input, 0);
  return freezeHistory({
    version: SESSION_MESSAGE_REVISIONS_VERSION,
    ...binding,
    incognito: false,
    persisted: true,
    deleted_at: null,
    current_revision: 0,
    revisions: [revision],
  });
}

function appendMessageRevision(history, input = {}) {
  const current = validateHistory(history);
  assertRetained(input);
  assertOptionalCanonicalPrivacy(input);
  assertMatchingBinding(current.binding, input);

  const expectedRevision = normalizeRevisionNumber(
    input.expected_revision ?? input.expectedRevision,
    "expected_revision",
  );
  if (expectedRevision !== current.revision.revision) {
    throw revisionError(
      "message_revision_conflict",
      `expected revision ${expectedRevision}, current revision ${current.revision.revision}`,
    );
  }

  const next = createRevision(current.binding, input, expectedRevision + 1);
  if (next.text === current.revision.text) {
    throw revisionError("message_revision_noop", "message revision does not change the text");
  }
  if (Date.parse(next.created_at) < Date.parse(current.revision.created_at)) {
    throw revisionError("invalid_message_revision", "revision time cannot precede the current revision");
  }

  return freezeHistory({
    version: SESSION_MESSAGE_REVISIONS_VERSION,
    ...current.binding,
    incognito: false,
    persisted: true,
    deleted_at: null,
    current_revision: next.revision,
    revisions: [...current.history.revisions, next],
  });
}

function projectCurrentMessageRevision(history) {
  const current = validateHistory(history);
  return Object.freeze({
    version: SESSION_MESSAGE_REVISIONS_VERSION,
    ...current.binding,
    text: current.revision.text,
    revision: current.revision.revision,
    original_text: current.history.revisions[0].text,
    revised: current.revision.revision > 0,
    revision_metadata: Object.freeze({
      actor: current.revision.actor,
      source: current.revision.source,
      reason: current.revision.reason,
      created_at: current.revision.created_at,
    }),
  });
}

function validateHistory(history) {
  if (!history || typeof history !== "object" || history.version !== SESSION_MESSAGE_REVISIONS_VERSION) {
    throw revisionError("invalid_message_revision", "message revision history is invalid");
  }
  assertKnownFields(history, HISTORY_FIELDS, "history");
  assertCanonicalHistoryPrivacy(history);
  const binding = normalizeBinding(history);
  assertCanonicalBinding(binding, history, "history");
  if (!Array.isArray(history.revisions) || history.revisions.length === 0) {
    throw revisionError("invalid_message_revision", "revision zero is required");
  }
  const currentRevision = normalizeRevisionNumber(history.current_revision, "current_revision");
  if (currentRevision !== history.revisions.length - 1) {
    throw revisionError("invalid_message_revision", "current revision does not match the append-only chain");
  }

  let previousTime = -Infinity;
  const revisions = [];
  for (let index = 0; index < history.revisions.length; index += 1) {
    const revision = history.revisions[index];
    if (!revision || typeof revision !== "object"
        || normalizeRevisionNumber(revision.revision, "revision") !== index) {
      throw revisionError("invalid_message_revision", "message revisions must be contiguous from revision zero");
    }
    assertKnownFields(revision, REVISION_FIELDS, `revision ${index}`);
    assertExactBinding(binding, revision);
    const text = normalizeText(revision.text);
    const metadata = normalizeMetadata(revision);
    const time = Date.parse(metadata.created_at);
    if (time < previousTime) {
      throw revisionError("invalid_message_revision", "message revision times must be monotonic");
    }
    previousTime = time;
    if (text !== revision.text
        || metadata.actor !== revision.actor
        || metadata.source !== revision.source
        || metadata.reason !== revision.reason
        || metadata.created_at !== revision.created_at) {
      throw revisionError("invalid_message_revision", "message revision fields are not canonical");
    }
    if (index > 0 && text === history.revisions[index - 1].text) {
      throw revisionError("invalid_message_revision", "message revision chain contains a no-op");
    }
    revisions.push(Object.freeze({
      ...binding,
      revision: index,
      text,
      ...metadata,
    }));
  }
  const canonicalHistory = freezeHistory({
    version: SESSION_MESSAGE_REVISIONS_VERSION,
    ...binding,
    incognito: false,
    persisted: true,
    deleted_at: null,
    current_revision: currentRevision,
    revisions,
  });
  return { binding, history: canonicalHistory, revision: canonicalHistory.revisions[currentRevision] };
}

function createRevision(binding, input, revision) {
  return Object.freeze({
    ...binding,
    revision,
    text: normalizeText(input.text),
    ...normalizeMetadata(input),
  });
}

function normalizeBinding(input) {
  const messageId = requiredField(input.message_id ?? input.messageId, "message_id");
  const sessionId = requiredField(input.session_id ?? input.sessionId, "session_id");
  const turnId = requiredField(input.turn_id ?? input.turnId, "turn_id");
  const role = requiredField(input.role ?? input.speaker, "role").toLowerCase();
  if (!MESSAGE_ROLES.has(role)) {
    throw revisionError("invalid_message_revision", "role must be user or assistant");
  }
  return Object.freeze({ message_id: messageId, session_id: sessionId, turn_id: turnId, role });
}

function assertMatchingBinding(binding, input) {
  const supplied = normalizeBinding(input);
  for (const field of ["message_id", "session_id", "turn_id", "role"]) {
    if (binding[field] !== supplied[field]) {
      throw revisionError("message_revision_binding_mismatch", `${field} does not match the retained message`);
    }
  }
}

function assertExactBinding(binding, revision) {
  for (const field of ["message_id", "session_id", "turn_id", "role"]) {
    if (revision[field] !== binding[field]) {
      throw revisionError("invalid_message_revision", `revision ${field} does not match its history`);
    }
  }
}

function assertCanonicalBinding(binding, input, label) {
  for (const field of ["message_id", "session_id", "turn_id", "role"]) {
    if (input[field] !== binding[field]) {
      throw revisionError("invalid_message_revision", `${label} ${field} is not canonical`);
    }
  }
}

function assertRetained(input) {
  if (input?.incognito === true || input?.persisted === false) {
    throw revisionError("message_revision_private", "incognito messages cannot be revised");
  }
  if (input?.deleted === true || input?.deleted_at || input?.deletedAt) {
    throw revisionError("message_revision_deleted", "deleted messages cannot be revised");
  }
}

function assertOptionalCanonicalPrivacy(input) {
  for (const [field, expected] of [["incognito", false], ["persisted", true], ["deleted_at", null]]) {
    if (Object.prototype.hasOwnProperty.call(input, field) && input[field] !== expected) {
      throw revisionError("invalid_message_revision", `${field} has a malformed privacy value`);
    }
  }
}

function assertCanonicalHistoryPrivacy(history) {
  if (history.incognito !== false || history.persisted !== true || history.deleted_at !== null) {
    throw revisionError(
      "invalid_message_revision",
      "message revision history must be retained with canonical privacy flags",
    );
  }
}

function assertKnownFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw revisionError("invalid_message_revision", `${label} contains unknown field ${unknown[0]}`);
  }
}

function normalizeText(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw revisionError("invalid_message_revision", "text must be a non-empty string");
  }
  if (value.length > SESSION_MESSAGE_TEXT_MAX_CHARS) {
    throw revisionError(
      "message_revision_too_large",
      `text exceeds ${SESSION_MESSAGE_TEXT_MAX_CHARS} characters`,
    );
  }
  return value;
}

function normalizeMetadata(input) {
  const actor = boundedField(input.actor ?? input.actor_id ?? input.actorId, "actor", METADATA_MAX_CHARS);
  const source = boundedField(input.source, "source", METADATA_MAX_CHARS);
  const reason = boundedField(input.reason, "reason", REASON_MAX_CHARS);
  const rawTime = requiredField(input.created_at ?? input.createdAt ?? input.time, "created_at");
  const milliseconds = Date.parse(rawTime);
  if (!Number.isFinite(milliseconds)) {
    throw revisionError("invalid_message_revision", "created_at must be an ISO-8601 time");
  }
  return Object.freeze({ actor, source, reason, created_at: new Date(milliseconds).toISOString() });
}

function normalizeRevisionNumber(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw revisionError("invalid_message_revision", `${field} must be a non-negative integer`);
  }
  return value;
}

function boundedField(value, field, maxChars) {
  const result = requiredField(value, field);
  if (result.length > maxChars) {
    throw revisionError("invalid_message_revision", `${field} exceeds ${maxChars} characters`);
  }
  return result;
}

function requiredField(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw revisionError("invalid_message_revision", `${field} is required`);
  }
  return value.trim();
}

function freezeHistory(history) {
  const revisions = history.revisions.map((revision) => Object.freeze({ ...revision }));
  return Object.freeze({
    ...history,
    revisions: Object.freeze(revisions),
  });
}

function revisionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  SESSION_MESSAGE_REVISIONS_VERSION,
  SESSION_MESSAGE_REVISION_TEXT_MAX_CHARS: SESSION_MESSAGE_TEXT_MAX_CHARS,
  appendMessageRevision,
  createMessageRevisionHistory,
  projectCurrentMessageRevision,
};
