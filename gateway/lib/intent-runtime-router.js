"use strict";

const crypto = require("node:crypto");

const PAGE_SIZE = 500;
const DEFAULT_REHYDRATE_EVENT_LIMIT = 2_000;
const DEFAULT_LIST_EVENT_LIMIT = 2_000;
const MAX_MUTATION_EVENT_LIMIT = 2_000;
const MAX_TEXT = Object.freeze({
  id: 160,
  statement: 2_000,
  objective: 2_000,
  detail: 800,
  note: 2_000,
  ref: 400,
  relationReason: 400,
  sourceSurface: 80,
  eventType: 160,
  idempotency: 240,
  focusRole: 40,
});
const MAX_ITEMS = Object.freeze({
  refs: 24,
  notes: 16,
  priorities: 8,
  decisions: 16,
  blockers: 16,
  sourceReceipts: 20,
  relations: 24,
  diagnostics: 16,
  notifications: 24,
});

const INTENT_EVENT_TYPES = Object.freeze([
  "intent.captured",
  "intent.source_recorded",
  "intent.run_claimed",
  "intent.progress_recorded",
  "intent.notification_created",
  "intent.disambiguated",
  "intent.connected",
  "intent.enriched",
  "intent.planned",
  "intent.execution_started",
  "intent.waiting",
  "intent.blocked",
  "intent.completed",
  "intent.abandoned",
  "intent.superseded",
  "intent.lesson_recorded",
  "intent.focus_pushed",
  "intent.focus_popped",
]);

const TRANSITION_EVENT_TYPES = Object.freeze([
  "intent.disambiguated",
  "intent.enriched",
  "intent.planned",
  "intent.execution_started",
  "intent.waiting",
  "intent.blocked",
  "intent.completed",
  "intent.abandoned",
  "intent.superseded",
  "intent.lesson_recorded",
]);

const RELATION_TYPES = Object.freeze([
  "related_to",
  "depends_on",
  "blocks",
  "corrects",
  "supersedes",
  "evidence_for",
]);

const LIFECYCLE_BY_EVENT = Object.freeze({
  "intent.captured": "captured",
  "intent.disambiguated": "clarified",
  "intent.planned": "planned",
  "intent.execution_started": "active",
  "intent.waiting": "waiting",
  "intent.blocked": "blocked",
  "intent.completed": "completed",
  "intent.abandoned": "abandoned",
  "intent.superseded": "superseded",
});

const TERMINAL_LIFECYCLES = new Set(["completed", "abandoned", "superseded"]);

const ALLOWED_TRANSITIONS = Object.freeze({
  captured: new Set(["intent.disambiguated", "intent.enriched"]),
  clarified: new Set(["intent.planned", "intent.enriched"]),
  planned: new Set(["intent.execution_started", "intent.enriched"]),
  active: new Set(["intent.waiting", "intent.blocked", "intent.completed", "intent.abandoned", "intent.superseded", "intent.enriched", "intent.lesson_recorded"]),
  waiting: new Set(["intent.execution_started", "intent.completed", "intent.abandoned", "intent.superseded", "intent.enriched", "intent.lesson_recorded"]),
  blocked: new Set(["intent.execution_started", "intent.completed", "intent.abandoned", "intent.superseded", "intent.enriched", "intent.lesson_recorded"]),
  completed: new Set(["intent.lesson_recorded"]),
  abandoned: new Set(["intent.lesson_recorded"]),
  superseded: new Set(["intent.lesson_recorded"]),
});

function createDefaultIdFactory() {
  return (prefix) => `${String(prefix || "id").trim() || "id"}_${crypto.randomUUID()}`;
}

function isoNow(now) {
  const raw = typeof now === "function" ? now() : new Date().toISOString();
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function text(value, max) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, max) : "";
}

function requireBoundedText(value, max, label, options = {}) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    if (options.allowEmpty) return "";
    throw new Error(`${label} is required`);
  }
  if (normalized.length > max) {
    throw new Error(`${label} exceeds max length ${max}`);
  }
  return normalized;
}

function integer(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function clampRange(value, fallback, max) {
  const parsed = integer(value, fallback);
  return Math.max(1, Math.min(parsed, max));
}

function clampOffset(value) {
  const parsed = integer(value, 0);
  return Math.min(parsed, 10_000_000);
}

function arrayOfText(values, maxItems, maxText) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const item = text(value, maxText);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeRelationType(value) {
  const safe = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  return RELATION_TYPES.includes(safe) ? safe : "";
}

function normalizeEventType(value) {
  const safe = String(value || "").trim().toLowerCase();
  return INTENT_EVENT_TYPES.includes(safe) ? safe : "";
}

function normalizeTransitionType(value) {
  const safe = normalizeEventType(value);
  return TRANSITION_EVENT_TYPES.includes(safe) ? safe : "";
}

function intentStreamId(intentId) {
  return `intent:${requireBoundedText(intentId, MAX_TEXT.id, "intent_id")}`;
}

function normalizeSource(input = {}) {
  return {
    session_id: requireBoundedText(input.session_id || input.sessionId, MAX_TEXT.id, "session_id", { allowEmpty: true }),
    branch_id: requireBoundedText(input.branch_id || input.branchId, MAX_TEXT.id, "branch_id", { allowEmpty: true }),
    turn_id: requireBoundedText(input.turn_id || input.turnId, MAX_TEXT.id, "turn_id", { allowEmpty: true }),
    broker_event_id: requireBoundedText(input.broker_event_id || input.brokerEventId, MAX_TEXT.id, "broker_event_id", { allowEmpty: true }),
    surface: text(input.surface, MAX_TEXT.sourceSurface),
    audio_ref: text(input.audio_ref || input.audioRef, MAX_TEXT.ref),
    transcript_ref: text(input.transcript_ref || input.transcriptRef, MAX_TEXT.ref),
  };
}

function normalizeRefs(values) {
  return arrayOfText(values, MAX_ITEMS.refs, MAX_TEXT.ref);
}

function normalizeNotes(values, maxItems = MAX_ITEMS.notes) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const summary = text(value.summary || value.note || value.text || value.reason, MAX_TEXT.note);
      if (!summary) return null;
      return {
        summary,
        source_event_id: requireBoundedText(value.source_event_id || value.sourceEventId, MAX_TEXT.id, "source_event_id", { allowEmpty: true }),
        source_ref: text(value.source_ref || value.sourceRef, MAX_TEXT.ref),
      };
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeCapturePayload(input = {}, intentId, now) {
  return {
    intent_id: requireBoundedText(intentId, MAX_TEXT.id, "intent_id"),
    statement: text(input.statement, MAX_TEXT.statement),
    normalized_objective: text(input.normalized_objective || input.normalizedObjective || input.statement, MAX_TEXT.objective),
    project_id: requireBoundedText(input.project_id || input.projectId, MAX_TEXT.id, "project_id", { allowEmpty: true }),
    source: normalizeSource(input.source || input),
    parent_intent_id: requireBoundedText(input.parent_intent_id || input.parentIntentId, MAX_TEXT.id, "parent_intent_id", { allowEmpty: true }),
    return_to_intent_id: requireBoundedText(input.return_to_intent_id || input.returnToIntentId || input.parent_intent_id || input.parentIntentId, MAX_TEXT.id, "return_to_intent_id", { allowEmpty: true }),
    completion_criteria: arrayOfText(input.completion_criteria || input.completionCriteria, MAX_ITEMS.notes, MAX_TEXT.note),
    constraints: normalizeNotes(input.constraints),
    next_step: text(input.next_step || input.nextStep, MAX_TEXT.note),
    active_priorities: arrayOfText(input.active_priorities || input.activePriorities, MAX_ITEMS.priorities, MAX_TEXT.note),
    plan_refs: normalizeRefs(input.plan_refs || input.planRefs),
    run_refs: normalizeRefs(input.run_refs || input.runRefs),
    artifact_refs: normalizeRefs(input.artifact_refs || input.artifactRefs),
    action_refs: normalizeRefs(input.action_refs || input.actionRefs),
    approval_refs: normalizeRefs(input.approval_refs || input.approvalRefs),
    receipt_refs: normalizeRefs(input.receipt_refs || input.receiptRefs),
    source_receipt_refs: normalizeRefs(input.source_receipt_refs || input.sourceReceiptRefs),
    created_at: now,
  };
}

function normalizeMutationPayload(input = {}) {
  return {
    statement: text(input.statement, MAX_TEXT.statement),
    normalized_objective: text(input.normalized_objective || input.normalizedObjective, MAX_TEXT.objective),
    next_step: text(input.next_step || input.nextStep, MAX_TEXT.note),
    blocker: text(input.blocker, MAX_TEXT.note),
    blockers: normalizeNotes(input.blockers),
    decision: text(input.decision, MAX_TEXT.note),
    decisions: normalizeNotes(input.decisions),
    lesson: text(input.lesson, MAX_TEXT.note),
    lessons: normalizeNotes(input.lessons),
    outcome: text(input.outcome, MAX_TEXT.note),
    completion_criteria: arrayOfText(input.completion_criteria || input.completionCriteria, MAX_ITEMS.notes, MAX_TEXT.note),
    constraints: normalizeNotes(input.constraints),
    active_priorities: arrayOfText(input.active_priorities || input.activePriorities, MAX_ITEMS.priorities, MAX_TEXT.note),
    plan_refs: normalizeRefs(input.plan_refs || input.planRefs),
    run_refs: normalizeRefs(input.run_refs || input.runRefs),
    artifact_refs: normalizeRefs(input.artifact_refs || input.artifactRefs),
    action_refs: normalizeRefs(input.action_refs || input.actionRefs),
    approval_refs: normalizeRefs(input.approval_refs || input.approvalRefs),
    receipt_refs: normalizeRefs(input.receipt_refs || input.receiptRefs),
    source_receipt_refs: normalizeRefs(input.source_receipt_refs || input.sourceReceiptRefs),
  };
}

function namespaceIdempotencyKey(intentId, operation, rawKey) {
  const safeIntentId = requireBoundedText(intentId, MAX_TEXT.id, "intent_id");
  const safeOperation = requireBoundedText(operation, 80, "operation");
  const suffix = requireBoundedText(rawKey || safeOperation, 180, "idempotency_key");
  const namespaced = `intent:${safeIntentId}:${safeOperation}:${suffix}`;
  if (namespaced.length > MAX_TEXT.idempotency) {
    throw new Error(`idempotency_key exceeds max length ${MAX_TEXT.idempotency}`);
  }
  return namespaced;
}

function createIntentEvent({ eventType, intentId, idempotencyKey, now, actor, correlationId, causationId, payload }) {
  return {
    event_type: requireBoundedText(eventType, MAX_TEXT.eventType, "event_type"),
    stream_id: intentStreamId(intentId),
    occurred_at: now,
    actor: actor && typeof actor === "object" ? actor : { kind: "gateway", id: "intent-runtime" },
    authority: { boundary: "intent-runtime", execution: "proposal_event_log" },
    correlation_id: requireBoundedText(correlationId || intentId, MAX_TEXT.id, "correlation_id", { allowEmpty: true }),
    causation_id: requireBoundedText(causationId, MAX_TEXT.id, "causation_id", { allowEmpty: true }),
    idempotency_key: requireBoundedText(idempotencyKey, MAX_TEXT.idempotency, "idempotency_key"),
    payload,
  };
}

function ensureIntentExists(state, intentId) {
  if (!state || !state.exists) {
    throw new Error(`intent not found: ${requireBoundedText(intentId, MAX_TEXT.id, "intent_id")}`);
  }
}

function ensureLifecycleAllows(state, eventType) {
  const lifecycle = state.lifecycle_state || "captured";
  const allowed = ALLOWED_TRANSITIONS[lifecycle];
  if (!allowed || !allowed.has(eventType)) {
    throw new Error(`illegal lifecycle transition: ${lifecycle} -> ${eventType}`);
  }
}

function ensureNotTerminal(state) {
  if (TERMINAL_LIFECYCLES.has(state.lifecycle_state)) {
    throw new Error(`intent is terminal: ${state.lifecycle_state}`);
  }
}

function buildCaptureEvent(input = {}, options = {}) {
  const idFactory = options.idFactory || createDefaultIdFactory();
  const now = isoNow(options.now);
  const proposedIntentId = input.intent_id || input.intentId || idFactory("intent");
  const intentId = requireBoundedText(proposedIntentId, MAX_TEXT.id, "intent_id");
  const payload = normalizeCapturePayload(input, intentId, now);
  if (!payload.statement) throw new Error("statement is required");
  if (!payload.normalized_objective) throw new Error("normalized_objective is required");
  return createIntentEvent({
    eventType: "intent.captured",
    intentId,
    idempotencyKey: namespaceIdempotencyKey(intentId, "capture", input.idempotency_key || input.idempotencyKey || "capture"),
    now,
    actor: input.actor,
    correlationId: input.correlation_id || input.correlationId || payload.source.turn_id || intentId,
    causationId: input.causation_id || input.causationId || payload.source.broker_event_id,
    payload,
  });
}

function buildTransitionEvent(state, intentId, command = {}, options = {}) {
  const safeIntentId = requireBoundedText(intentId, MAX_TEXT.id, "intent_id");
  ensureIntentExists(state, safeIntentId);
  const eventType = normalizeTransitionType(command.type || command.event_type || command.eventType);
  if (!eventType) {
    throw new Error(`unsupported transition type: ${text(command.type || command.event_type || command.eventType, MAX_TEXT.eventType) || "(empty)"}`);
  }
  ensureLifecycleAllows(state, eventType);
  const now = isoNow(options.now);
  const payload = {
    intent_id: safeIntentId,
    ...normalizeMutationPayload(command),
  };
  if (eventType === "intent.completed" && !payload.outcome) {
    throw new Error("completed transition requires outcome");
  }
  return createIntentEvent({
    eventType,
    intentId: safeIntentId,
    idempotencyKey: namespaceIdempotencyKey(safeIntentId, "transition", command.idempotency_key || command.idempotencyKey || eventType),
    now,
    actor: command.actor,
    correlationId: command.correlation_id || command.correlationId || state.source.turn_id || safeIntentId,
    causationId: command.causation_id || command.causationId || state.source.broker_event_id,
    payload,
  });
}

function buildConnectEvent(state, intentId, relation = {}, options = {}) {
  const safeIntentId = requireBoundedText(intentId, MAX_TEXT.id, "intent_id");
  ensureIntentExists(state, safeIntentId);
  ensureNotTerminal(state);
  const relationType = normalizeRelationType(relation.relation_type || relation.relationType || relation.type);
  if (!relationType) {
    throw new Error(`unsupported relation type: ${text(relation.relation_type || relation.relationType || relation.type, MAX_TEXT.eventType) || "(empty)"}`);
  }
  const targetIntentId = requireBoundedText(relation.target_intent_id || relation.targetIntentId, MAX_TEXT.id, "target_intent_id");
  if (targetIntentId === safeIntentId) {
    throw new Error("self-relations are not allowed");
  }
  if (state.relations.some((item) => item.relation_type === relationType && item.target_intent_id === targetIntentId)) {
    throw new Error(`relation already exists: ${relationType} -> ${targetIntentId}`);
  }
  const now = isoNow(options.now);
  return createIntentEvent({
    eventType: "intent.connected",
    intentId: safeIntentId,
    idempotencyKey: namespaceIdempotencyKey(safeIntentId, "connect", relation.idempotency_key || relation.idempotencyKey || `${relationType}:${targetIntentId}`),
    now,
    actor: relation.actor,
    correlationId: relation.correlation_id || relation.correlationId || safeIntentId,
    causationId: relation.causation_id || relation.causationId || state.source.broker_event_id,
    payload: {
      intent_id: safeIntentId,
      relation_type: relationType,
      target_intent_id: targetIntentId,
      reason: text(relation.reason, MAX_TEXT.relationReason),
      source_receipt_refs: normalizeRefs(relation.source_receipt_refs || relation.sourceReceiptRefs),
    },
  });
}

function buildFocusPushEvent(state, input = {}, options = {}) {
  const streamIntentId = requireBoundedText(input.stream_intent_id || input.streamIntentId || input.intent_id || input.intentId, MAX_TEXT.id, "intent_id");
  ensureIntentExists(state, streamIntentId);
  ensureNotTerminal(state);
  const focusRole = requireBoundedText(input.focus_role || input.focusRole || (streamIntentId === (input.parent_intent_id || input.parentIntentId) ? "suspended" : "child"), MAX_TEXT.focusRole, "focus_role");
  const sessionId = requireBoundedText(input.session_id || input.sessionId, MAX_TEXT.id, "session_id");
  const parentIntentId = requireBoundedText(input.parent_intent_id || input.parentIntentId || state.parent_intent_id, MAX_TEXT.id, "parent_intent_id", { allowEmpty: focusRole === "suspended" });
  const returnToIntentId = requireBoundedText(input.return_to_intent_id || input.returnToIntentId || state.return_to_intent_id || parentIntentId, MAX_TEXT.id, "return_to_intent_id", { allowEmpty: false });
  const childIntentId = requireBoundedText(input.child_intent_id || input.childIntentId || (focusRole === "child" ? streamIntentId : ""), MAX_TEXT.id, "child_intent_id", { allowEmpty: focusRole !== "suspended" });

  if (focusRole === "child" && state.focus_state === "focused") {
    throw new Error(`intent already focused: ${streamIntentId}`);
  }
  if (focusRole === "suspended" && state.focus_state === "suspended") {
    throw new Error(`intent already suspended: ${streamIntentId}`);
  }
  if (focusRole === "child") {
    if (state.lifecycle_state !== "active") {
      throw new Error(`transactional child must be active before focus push: ${state.lifecycle_state}`);
    }
    if (!parentIntentId || !returnToIntentId) {
      throw new Error("transactional focus requires parent_intent_id and return_to_intent_id");
    }
    if (state.parent_intent_id && state.parent_intent_id !== parentIntentId) {
      throw new Error(`parent_intent_id mismatch: ${state.parent_intent_id} != ${parentIntentId}`);
    }
    if (state.return_to_intent_id && state.return_to_intent_id !== returnToIntentId) {
      throw new Error(`return_to_intent_id mismatch: ${state.return_to_intent_id} != ${returnToIntentId}`);
    }
  }
  if (focusRole === "suspended" && state.lifecycle_state !== "active") {
    throw new Error(`return target must be active before suspension: ${state.lifecycle_state}`);
  }

  const now = isoNow(options.now);
  const safeIntentId = streamIntentId;
  return createIntentEvent({
    eventType: "intent.focus_pushed",
    intentId: safeIntentId,
    idempotencyKey: namespaceIdempotencyKey(safeIntentId, "focus-push", input.idempotency_key || input.idempotencyKey || `${sessionId}:${focusRole}`),
    now,
    actor: input.actor,
    correlationId: input.correlation_id || input.correlationId || sessionId,
    causationId: input.causation_id || input.causationId || state.source.broker_event_id,
    payload: {
      intent_id: safeIntentId,
      session_id: sessionId,
      parent_intent_id: parentIntentId,
      return_to_intent_id: returnToIntentId,
      child_intent_id: childIntentId,
      focus_role: focusRole,
      source_receipt_refs: normalizeRefs(input.source_receipt_refs || input.sourceReceiptRefs),
    },
  });
}

function buildFocusPopEvent(state, input = {}, options = {}) {
  const streamIntentId = requireBoundedText(input.stream_intent_id || input.streamIntentId || input.intent_id || input.intentId || state.intent_id, MAX_TEXT.id, "intent_id");
  ensureIntentExists(state, streamIntentId);
  const focusRole = requireBoundedText(input.focus_role || input.focusRole || "child", MAX_TEXT.focusRole, "focus_role");
  const sessionId = requireBoundedText(input.session_id || input.sessionId || state.focus_session_id, MAX_TEXT.id, "session_id");
  const now = isoNow(options.now);
  const parentIntentId = requireBoundedText(input.parent_intent_id || input.parentIntentId || state.parent_intent_id, MAX_TEXT.id, "parent_intent_id", { allowEmpty: true });
  const returnToIntentId = requireBoundedText(input.return_to_intent_id || input.returnToIntentId || state.return_to_intent_id || parentIntentId, MAX_TEXT.id, "return_to_intent_id", { allowEmpty: false });
  const restoredFromIntentId = requireBoundedText(input.restored_from_intent_id || input.restoredFromIntentId || (focusRole === "restored" ? state.focus_child_intent_id : ""), MAX_TEXT.id, "restored_from_intent_id", { allowEmpty: focusRole !== "restored" });

  if (focusRole === "child") {
    if (state.focus_state !== "focused") {
      throw new Error(`intent is not focused: ${streamIntentId}`);
    }
    if (state.lifecycle_state !== "completed") {
      throw new Error(`focused intent must be completed before pop: ${state.lifecycle_state}`);
    }
  }
  if (focusRole === "restored" && state.focus_state !== "suspended") {
    throw new Error(`return target is not suspended: ${streamIntentId}`);
  }

  return createIntentEvent({
    eventType: "intent.focus_popped",
    intentId: streamIntentId,
    idempotencyKey: namespaceIdempotencyKey(streamIntentId, "focus-pop", input.idempotency_key || input.idempotencyKey || `${sessionId}:${focusRole}`),
    now,
    actor: input.actor,
    correlationId: input.correlation_id || input.correlationId || sessionId,
    causationId: input.causation_id || input.causationId || state.source.broker_event_id,
    payload: {
      intent_id: streamIntentId,
      session_id: sessionId,
      parent_intent_id: parentIntentId,
      return_to_intent_id: returnToIntentId,
      restored_from_intent_id: restoredFromIntentId,
      restored_intent_id: requireBoundedText(input.restored_intent_id || input.restoredIntentId || (focusRole === "child" ? returnToIntentId : ""), MAX_TEXT.id, "restored_intent_id", { allowEmpty: focusRole !== "child" }),
      focus_role: focusRole,
      source_receipt_refs: normalizeRefs(input.source_receipt_refs || input.sourceReceiptRefs),
    },
  });
}

module.exports = {
  PAGE_SIZE,
  DEFAULT_REHYDRATE_EVENT_LIMIT,
  DEFAULT_LIST_EVENT_LIMIT,
  MAX_MUTATION_EVENT_LIMIT,
  MAX_ITEMS,
  MAX_TEXT,
  INTENT_EVENT_TYPES,
  TRANSITION_EVENT_TYPES,
  RELATION_TYPES,
  LIFECYCLE_BY_EVENT,
  TERMINAL_LIFECYCLES,
  ALLOWED_TRANSITIONS,
  createDefaultIdFactory,
  intentStreamId,
  isoNow,
  text,
  requireBoundedText,
  integer,
  clampRange,
  clampOffset,
  arrayOfText,
  normalizeRefs,
  normalizeNotes,
  normalizeRelationType,
  normalizeEventType,
  normalizeTransitionType,
  normalizeSource,
  normalizeCapturePayload,
  normalizeMutationPayload,
  namespaceIdempotencyKey,
  buildCaptureEvent,
  buildTransitionEvent,
  buildConnectEvent,
  buildFocusPushEvent,
  buildFocusPopEvent,
};
