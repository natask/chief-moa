"use strict";

const crypto = require("node:crypto");

const EVENT_PREFIX = "development_request.";
const CREATED = `${EVENT_PREFIX}created`;
const RENAMED = `${EVENT_PREFIX}renamed`;
const PROGRESS_UPDATED = `${EVENT_PREFIX}progress_updated`;
const PROVENANCE_KINDS = new Set(["text", "voice"]);
const PROGRESS_STATES = new Set([
  "captured", "researching", "planned", "running", "integrating",
  "verifying", "feature_ready", "blocked", "canceled", "rejected",
]);
const MAX_RECENT_PROGRESS = 12;
const MAX_LIST_LIMIT = 50;

function text(value, max, label) {
  const result = String(value ?? "").trim();
  if (!result) throw requestError(`${label} is required`, "invalid_request", 400);
  if (result.length > max) throw requestError(`${label} exceeds ${max} characters`, "invalid_request", 400);
  return result;
}

function optionalText(value, max, label) {
  const result = String(value ?? "").trim();
  if (result.length > max) throw requestError(`${label} exceeds ${max} characters`, "invalid_request", 400);
  return result;
}

function principalContext(principal = {}) {
  return Object.freeze({
    tenant_id: text(principal.tenant_id || principal.tenantId, 160, "principal.tenant_id"),
    user_id: text(principal.user_id || principal.userId || principal.owner_id || principal.ownerId, 160, "principal.user_id"),
  });
}

function requestError(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function notFound() {
  return requestError("development request not found", "development_request_not_found", 404);
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function streamId(requestId) {
  return `development-request:${text(requestId, 160, "request_id")}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createPayload(input, owner) {
  const kind = text(input.provenance?.kind || input.source_kind || input.sourceKind, 20, "provenance.kind").toLowerCase();
  if (!PROVENANCE_KINDS.has(kind)) throw requestError("provenance.kind must be voice or text", "invalid_request", 400);
  return {
    tenant_id: owner.tenant_id,
    owner_user_id: owner.user_id,
    display_name: text(input.display_name || input.displayName, 120, "display_name"),
    source_text: text(input.source_text || input.sourceText, 100_000, "source_text"),
    project: {
      project_id: text(input.project_id || input.projectId, 160, "project_id"),
      binding_evidence_ref: optionalText(input.project_binding_evidence_ref || input.projectBindingEvidenceRef, 1_000, "project_binding_evidence_ref"),
    },
    provenance: {
      kind,
      surface: text(input.provenance?.surface || input.surface, 80, "provenance.surface"),
      session_id: optionalText(input.provenance?.session_id || input.provenance?.sessionId, 160, "provenance.session_id"),
      turn_id: optionalText(input.provenance?.turn_id || input.provenance?.turnId, 160, "provenance.turn_id"),
      capture_ref: optionalText(input.provenance?.capture_ref || input.provenance?.captureRef, 1_000, "provenance.capture_ref"),
    },
  };
}

function initialState(requestId) {
  return {
    schema: "moa.development-request.v1",
    request_id: requestId,
    exists: false,
    version: 0,
    tenant_id: "",
    owner_user_id: "",
    display_name: "",
    source_text: "",
    project: null,
    provenance: null,
    status: "missing",
    progress: null,
    recent_progress: [],
    created_at: "",
    updated_at: "",
  };
}

function reduce(requestId, events) {
  const state = initialState(requestId);
  for (const event of events) {
    const payload = event.payload || {};
    if (event.event_type === CREATED) {
      Object.assign(state, payload, { exists: true, status: "captured", created_at: event.occurred_at });
    } else if (event.event_type === RENAMED) {
      state.display_name = payload.display_name;
    } else if (event.event_type === PROGRESS_UPDATED) {
      state.status = payload.state;
      const {
        request_id: ignoredRequest,
        tenant_id: ignoredTenant,
        owner_user_id: ignoredOwner,
        ...progress
      } = payload;
      state.progress = { ...progress, occurred_at: event.occurred_at };
      state.recent_progress.push(state.progress);
      state.recent_progress = state.recent_progress.slice(-MAX_RECENT_PROGRESS);
    }
    state.version = Number(event.stream_version || state.version);
    state.updated_at = event.occurred_at || state.updated_at;
  }
  return state;
}

function listProjection(state) {
  return {
    schema: state.schema,
    request_id: state.request_id,
    display_name: state.display_name,
    project_id: state.project.project_id,
    provenance_kind: state.provenance.kind,
    source_preview: state.source_text.slice(0, 160),
    status: state.status,
    progress: state.progress,
    created_at: state.created_at,
    updated_at: state.updated_at,
  };
}

function progressPayload(input = {}) {
  const state = text(input.state, 40, "state");
  if (!PROGRESS_STATES.has(state)) throw requestError("unsupported development request state", "invalid_request", 400);
  const percent = Number(input.percent ?? 0);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw requestError("percent must be an integer from 0 to 100", "invalid_request", 400);
  }
  const activeAgents = boundedCount(input.active_agents ?? input.activeAgents ?? 0, "active_agents");
  const waitingTasks = boundedCount(input.waiting_tasks ?? input.waitingTasks ?? 0, "waiting_tasks");
  const totalTasks = boundedCount(input.total_tasks ?? input.totalTasks ?? 0, "total_tasks");
  if (activeAgents + waitingTasks > totalTasks && totalTasks !== 0) {
    throw requestError("active_agents plus waiting_tasks cannot exceed total_tasks", "invalid_request", 400);
  }
  return {
    state,
    phase: optionalText(input.phase, 80, "phase"),
    summary: text(input.summary, 240, "summary"),
    current_step: optionalText(input.current_step || input.currentStep, 160, "current_step"),
    percent,
    active_agents: activeAgents,
    waiting_tasks: waitingTasks,
    total_tasks: totalTasks,
  };
}

function boundedCount(value, label) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > 32) {
    throw requestError(`${label} must be an integer from 0 to 32`, "invalid_request", 400);
  }
  return count;
}

function createDevelopmentRequestStore({ events, now = () => new Date().toISOString(), idFactory = () => `devreq_${crypto.randomUUID()}` } = {}) {
  if (!events?.appendEvent || !events?.listEvents || !events?.withStreamLock) {
    throw new Error("development requests require an event substrate with stream locking");
  }

  async function eventsFor(requestId) {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const page = await events.listEvents({ stream_id: streamId(requestId), event_type_prefix: EVENT_PREFIX, order: "asc", offset, limit: 500 });
      rows.push(...page);
      if (page.length < 500) return rows;
    }
  }

  async function readOwned(principal, requestId) {
    const owner = principalContext(principal);
    const safeId = text(requestId, 160, "request_id");
    const state = reduce(safeId, await eventsFor(safeId));
    if (!state.exists || state.tenant_id !== owner.tenant_id || state.owner_user_id !== owner.user_id) throw notFound();
    return state;
  }

  async function append(requestId, type, payload, rawKey, expectedVersion) {
    const key = text(rawKey, 200, "idempotency_key");
    const expected = {
      stream_id: streamId(requestId),
      event_type: type,
      idempotency_key: `development-request:${digest([payload.tenant_id, payload.owner_user_id, requestId, type, key])}`,
      payload: { request_id: requestId, ...payload },
    };
    const event = await events.appendEvent({
      ...expected,
      occurred_at: now(),
      actor: { kind: "gateway", id: "development-request-domain" },
      authority: { boundary: "development-requests", execution: "request_state_only" },
      correlation_id: requestId,
      expected_stream_version: expectedVersion,
    });
    if (event.stream_id !== expected.stream_id || event.event_type !== type || !same(event.payload, expected.payload)) {
      throw requestError("development request idempotency collision", "idempotency_collision");
    }
    return event;
  }

  async function create(principal, input = {}) {
    const owner = principalContext(principal);
    const rawKey = text(input.idempotency_key || input.idempotencyKey, 200, "idempotency_key");
    const payload = createPayload(input, owner);
    const createKey = `development-request:create:${digest([owner.tenant_id, owner.user_id, rawKey])}`;
    const replay = await events.listEvents({ idempotency_key: createKey, limit: 1 });
    if (replay.length) {
      if (replay[0].event_type !== CREATED || !same(replay[0].payload && stripRequestId(replay[0].payload), payload)) {
        throw requestError("development request idempotency collision", "idempotency_collision");
      }
      return readOwned(owner, replay[0].payload.request_id);
    }
    const requestId = text(idFactory("devreq"), 160, "generated request_id");
    const expected = {
      stream_id: streamId(requestId), event_type: CREATED, idempotency_key: createKey,
      payload: { request_id: requestId, ...payload },
    };
    const event = await events.appendEvent({
      ...expected, occurred_at: now(), actor: { kind: "user", id: owner.user_id },
      authority: { boundary: "development-requests", execution: "capture_only" },
      correlation_id: requestId, expected_stream_version: 0,
    });
    if (event.event_type !== CREATED || !same(stripRequestId(event.payload || {}), payload)) {
      throw requestError("development request idempotency collision", "idempotency_collision");
    }
    return readOwned(owner, event.payload.request_id);
  }

  async function rename(principal, requestId, input = {}) {
    const owner = principalContext(principal);
    const safeId = text(requestId, 160, "request_id");
    return events.withStreamLock(streamId(safeId), async () => {
      const state = await readOwned(owner, safeId);
      const displayName = text(input.display_name || input.displayName, 120, "display_name");
      if (state.display_name === displayName) return state;
      await append(safeId, RENAMED, { tenant_id: owner.tenant_id, owner_user_id: owner.user_id, display_name: displayName }, input.idempotency_key || input.idempotencyKey, state.version);
      return readOwned(owner, safeId);
    });
  }

  async function updateProgress(principal, requestId, input = {}) {
    const owner = principalContext(principal);
    const safeId = text(requestId, 160, "request_id");
    return events.withStreamLock(streamId(safeId), async () => {
      const state = await readOwned(owner, safeId);
      const progress = progressPayload(input);
      if (state.progress && same(stripOccurredAt(state.progress), progress)) return state;
      await append(safeId, PROGRESS_UPDATED, { tenant_id: owner.tenant_id, owner_user_id: owner.user_id, ...progress }, input.idempotency_key || input.idempotencyKey, state.version);
      return readOwned(owner, safeId);
    });
  }

  async function list(principal, options = {}) {
    const owner = principalContext(principal);
    const limit = Math.max(1, Math.min(Number(options.limit) || 20, MAX_LIST_LIMIT));
    let offset = Math.max(0, Number.parseInt(options.cursor || "0", 10) || 0);
    const items = [];
    let exhausted = false;
    while (items.length < limit && !exhausted) {
      const page = await events.listEvents({ event_type: CREATED, order: "desc", offset, limit: 100 });
      exhausted = page.length < 100;
      let consumed = 0;
      for (const event of page) {
        consumed += 1;
        offset += 1;
        if (event.payload?.tenant_id !== owner.tenant_id || event.payload?.owner_user_id !== owner.user_id) continue;
        items.push(listProjection(await readOwned(owner, event.payload.request_id)));
        if (items.length === limit) break;
      }
      if (items.length === limit && consumed < page.length) exhausted = false;
    }
    items.sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.request_id.localeCompare(left.request_id));
    return { schema: "moa.development-request-list.v1", items, next_cursor: exhausted ? "" : String(offset) };
  }

  return { create, rename, updateProgress, get: readOwned, list };
}

function stripRequestId(payload) {
  const { request_id: ignored, ...rest } = payload;
  return rest;
}

function stripOccurredAt(progress) {
  const { occurred_at: ignored, ...rest } = progress;
  return rest;
}

module.exports = {
  MAX_RECENT_PROGRESS,
  PROGRESS_STATES,
  createDevelopmentRequestStore,
};
