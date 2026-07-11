"use strict";

const {
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
  ALLOWED_TRANSITIONS,
  TERMINAL_LIFECYCLES,
  intentStreamId,
  integer,
  clampRange,
  clampOffset,
  requireBoundedText,
  text,
  normalizeRefs,
  normalizeNotes,
} = require("./intent-runtime-router");

const MAX_CROSS_STREAM_TARGETS = 128;

function createInitialState(intentId = "") {
  return {
    exists: false,
    intent_id: text(intentId, 160),
    statement: "",
    normalized_objective: "",
    project_id: "",
    source: {
      session_id: "",
      branch_id: "",
      turn_id: "",
      broker_event_id: "",
      surface: "",
      audio_ref: "",
      transcript_ref: "",
    },
    lifecycle_state: "missing",
    focus_state: "unfocused",
    focus_session_id: "",
    focus_child_intent_id: "",
    restored_intent_id: "",
    parent_intent_id: "",
    return_to_intent_id: "",
    relations: [],
    decisions: [],
    blockers: [],
    lessons: [],
    completion_criteria: [],
    active_priorities: [],
    plan_refs: [],
    run_refs: [],
    artifact_refs: [],
    action_refs: [],
    approval_refs: [],
    receipt_refs: [],
    source_receipts: [],
    next_step: "",
    outcome: "",
    created_at: "",
    updated_at: "",
    version: 0,
    last_event_id: "",
    event_count: 0,
    diagnostics: [],
    uncertainty: "",
  };
}

function appendUnique(items, nextItems, maxItems) {
  const out = Array.isArray(items) ? items.slice(0, maxItems) : [];
  const seen = new Set(out.map((item) => JSON.stringify(item)));
  for (const item of Array.isArray(nextItems) ? nextItems : []) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out.slice(0, maxItems);
}

function appendTextNotes(items, nextItems, maxItems, fallbackSummary, event) {
  const out = Array.isArray(items) ? items.slice(0, maxItems) : [];
  for (const item of nextItems) {
    if (!item || !item.summary) continue;
    if (out.some((existing) => existing.summary === item.summary)) continue;
    out.push({
      summary: item.summary,
      at: event.occurred_at,
      event_id: event.event_id,
      source_ref: item.source_ref || "",
    });
    if (out.length >= maxItems) return out.slice(0, maxItems);
  }
  if (fallbackSummary && !out.some((existing) => existing.summary === fallbackSummary)) {
    out.push({
      summary: fallbackSummary,
      at: event.occurred_at,
      event_id: event.event_id,
      source_ref: "",
    });
  }
  return out.slice(0, maxItems);
}

function mergeRefs(current, payload, key) {
  return appendUnique(current, normalizeRefs(payload[key]), MAX_ITEMS.refs);
}

function addDiagnostic(state, code, detail, event) {
  state.updated_at = event?.occurred_at || state.updated_at;
  state.version = Math.max(state.version, Number(event?.stream_version || 0));
  state.last_event_id = event?.event_id || state.last_event_id;
  state.event_count += 1;
  if (state.diagnostics.length < MAX_ITEMS.diagnostics) {
    state.diagnostics.push({
      code: text(code, 80),
      detail: text(detail, 400),
      event_id: text(event?.event_id, 160),
      event_type: text(event?.event_type, 160),
    });
  }
  return state;
}

function sourceReceiptFromEvent(event) {
  const payload = event && event.payload && typeof event.payload === "object" ? event.payload : {};
  const source = payload.source && typeof payload.source === "object" ? payload.source : {};
  const receiptRefs = normalizeRefs(payload.source_receipt_refs);
  const sourceRef = source.turn_id || source.broker_event_id || source.audio_ref || source.transcript_ref || "";
  if (!receiptRefs.length && !sourceRef) return null;
  return {
    event_id: event.event_id,
    event_type: event.event_type,
    occurred_at: event.occurred_at,
    source_ref: text(sourceRef, 400),
    receipt_refs: receiptRefs,
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function validateEventForStream(event, state) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const rawStreamId = String(event.stream_id || "");
  if (!rawStreamId.startsWith("intent:")) return "intent event stream_id must start with intent:";
  let streamIntentId;
  let payloadIntentId;
  try {
    streamIntentId = requireBoundedText(rawStreamId.slice("intent:".length), MAX_TEXT.id, "stream intent_id");
    payloadIntentId = requireBoundedText(payload.intent_id, MAX_TEXT.id, "payload intent_id");
  } catch (error) {
    return String(error?.message || error);
  }
  if (payloadIntentId !== streamIntentId) {
    return `payload intent_id ${payloadIntentId} does not match stream ${streamIntentId}`;
  }
  const streamVersion = Number(event.stream_version || 0);
  if (!Number.isSafeInteger(streamVersion) || streamVersion <= 0) return "stream_version must be a positive safe integer";
  if (streamVersion !== state.version + 1) {
    return `out-of-order stream_version: expected ${state.version + 1}, received ${streamVersion}`;
  }
  if (event.event_type === "intent.captured" && state.exists) {
    return "duplicate capture in intent stream";
  }
  if (!state.exists && event.event_type !== "intent.captured") {
    return "intent stream must begin with intent.captured";
  }
  if (event.event_type === "intent.captured") {
    if (!text(payload.statement, MAX_TEXT.statement)) return "captured intent requires statement";
    if (!text(payload.normalized_objective, MAX_TEXT.objective)) return "captured intent requires normalized_objective";
  }
  if (state.exists && TRANSITION_EVENT_TYPES.includes(event.event_type)) {
    const allowed = ALLOWED_TRANSITIONS[state.lifecycle_state];
    if (!allowed || !allowed.has(event.event_type)) {
      return `illegal lifecycle transition: ${state.lifecycle_state} -> ${event.event_type}`;
    }
  }
  if (event.event_type === "intent.connected") {
    if (TERMINAL_LIFECYCLES.has(state.lifecycle_state)) return `terminal intent cannot add relations: ${state.lifecycle_state}`;
    if (!RELATION_TYPES.includes(String(payload.relation_type || ""))) return "connected event requires a supported relation_type";
    let targetIntentId;
    try {
      targetIntentId = requireBoundedText(payload.target_intent_id, MAX_TEXT.id, "target_intent_id");
    } catch (error) {
      return String(error?.message || error);
    }
    if (targetIntentId === streamIntentId) return "self-relations are not allowed";
    if (state.relations.some((item) => item.relation_type === payload.relation_type && item.target_intent_id === targetIntentId)) {
      return `relation already exists: ${payload.relation_type} -> ${targetIntentId}`;
    }
  }
  const role = String(payload.focus_role || "").trim();
  if (event.event_type === "intent.focus_pushed") {
    if (role !== "child" && role !== "suspended") return `unsupported focus push role: ${role || "(empty)"}`;
    let sessionId;
    let returnToIntentId;
    try {
      sessionId = requireBoundedText(payload.session_id, MAX_TEXT.id, "session_id");
      returnToIntentId = requireBoundedText(payload.return_to_intent_id, MAX_TEXT.id, "return_to_intent_id");
      requireBoundedText(payload.parent_intent_id, MAX_TEXT.id, "parent_intent_id");
      requireBoundedText(payload.child_intent_id, MAX_TEXT.id, "child_intent_id");
    } catch (error) {
      return String(error?.message || error);
    }
    if (state.lifecycle_state !== "active") return `focus push requires active lifecycle: ${state.lifecycle_state}`;
    if (role === "child") {
      if (state.focus_state === "focused") return "child intent is already focused";
      if (payload.child_intent_id !== streamIntentId) return "child focus payload must identify its stream intent";
      if (state.parent_intent_id && state.parent_intent_id !== payload.parent_intent_id) return "child focus parent does not match captured parent";
      if (state.return_to_intent_id && state.return_to_intent_id !== returnToIntentId) return "child focus return target does not match captured target";
    } else {
      if (state.focus_state === "suspended") return "return target is already suspended";
      if (returnToIntentId !== streamIntentId) return "suspended focus event must be stored on its return target";
    }
    if (state.focus_session_id && state.focus_session_id !== sessionId) return "focus push session mismatch";
  }
  if (event.event_type === "intent.focus_popped") {
    if (role !== "child" && role !== "restored") return `unsupported focus pop role: ${role || "(empty)"}`;
    let sessionId;
    try {
      sessionId = requireBoundedText(payload.session_id, MAX_TEXT.id, "session_id");
      requireBoundedText(payload.return_to_intent_id, MAX_TEXT.id, "return_to_intent_id");
    } catch (error) {
      return String(error?.message || error);
    }
    if (state.focus_session_id && state.focus_session_id !== sessionId) return "focus pop session mismatch";
    if (role === "child") {
      if (state.focus_state !== "focused") return "child pop requires active focus";
      if (state.lifecycle_state !== "completed") return "child pop requires completed lifecycle";
      if (!payload.restored_intent_id || payload.restored_intent_id !== payload.return_to_intent_id) {
        return "child pop must restore its return target";
      }
      if (state.parent_intent_id && payload.parent_intent_id !== state.parent_intent_id) return "child pop parent mismatch";
      if (state.return_to_intent_id && payload.return_to_intent_id !== state.return_to_intent_id) return "child pop return target mismatch";
    } else {
      if (state.focus_state !== "suspended") return "restoration pop requires suspended target";
      if (!payload.restored_from_intent_id || payload.restored_from_intent_id !== state.focus_child_intent_id) {
        return "restoration pop must match suspended child intent";
      }
    }
  }
  return "";
}

function applyIntentEvent(state, event) {
  const current = cloneState(state || createInitialState());
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const sourceReceipt = sourceReceiptFromEvent(event);

  if (event.event_type === "intent.captured") {
    current.exists = true;
    current.intent_id = current.intent_id || text(payload.intent_id, 160) || text(String(event.stream_id || "").replace(/^intent:/, ""), 160);
    current.created_at = payload.created_at || event.occurred_at || current.created_at;
  }

  current.updated_at = event.occurred_at || current.updated_at;
  current.version = Math.max(current.version, Number(event.stream_version || 0));
  current.last_event_id = event.event_id || current.last_event_id;
  current.event_count += 1;

  if (sourceReceipt) {
    current.source_receipts = appendUnique(current.source_receipts, [sourceReceipt], MAX_ITEMS.sourceReceipts);
  }

  if (payload.statement) current.statement = text(payload.statement, 2_000);
  if (payload.normalized_objective) current.normalized_objective = text(payload.normalized_objective, 2_000);
  if (payload.project_id) current.project_id = text(payload.project_id, 160);
  if (payload.source && typeof payload.source === "object") {
    current.source = {
      session_id: current.source.session_id || text(payload.source.session_id, 160),
      branch_id: current.source.branch_id || text(payload.source.branch_id, 160),
      turn_id: current.source.turn_id || text(payload.source.turn_id, 160),
      broker_event_id: current.source.broker_event_id || text(payload.source.broker_event_id, 160),
      surface: current.source.surface || text(payload.source.surface, 80),
      audio_ref: current.source.audio_ref || text(payload.source.audio_ref, 400),
      transcript_ref: current.source.transcript_ref || text(payload.source.transcript_ref, 400),
    };
  }
  if (payload.parent_intent_id) current.parent_intent_id = text(payload.parent_intent_id, 160);
  if (payload.return_to_intent_id) current.return_to_intent_id = text(payload.return_to_intent_id, 160);
  if (Array.isArray(payload.completion_criteria) && payload.completion_criteria.length) {
    current.completion_criteria = appendUnique(current.completion_criteria, payload.completion_criteria.map((item) => text(item, 2_000)).filter(Boolean), MAX_ITEMS.notes);
  }
  if (Array.isArray(payload.active_priorities) && payload.active_priorities.length) {
    current.active_priorities = appendUnique(current.active_priorities, payload.active_priorities.map((item) => text(item, 2_000)).filter(Boolean), MAX_ITEMS.priorities);
  }
  if (payload.next_step) current.next_step = text(payload.next_step, 2_000);
  if (payload.outcome) current.outcome = text(payload.outcome, 2_000);

  current.plan_refs = mergeRefs(current.plan_refs, payload, "plan_refs");
  current.run_refs = mergeRefs(current.run_refs, payload, "run_refs");
  current.artifact_refs = mergeRefs(current.artifact_refs, payload, "artifact_refs");
  current.action_refs = mergeRefs(current.action_refs, payload, "action_refs");
  current.approval_refs = mergeRefs(current.approval_refs, payload, "approval_refs");
  current.receipt_refs = mergeRefs(current.receipt_refs, payload, "receipt_refs");

  current.decisions = appendTextNotes(current.decisions, normalizeNotes(payload.decisions), MAX_ITEMS.decisions, text(payload.decision, 2_000), event);
  current.blockers = appendTextNotes(current.blockers, normalizeNotes(payload.blockers), MAX_ITEMS.blockers, text(payload.blocker, 2_000), event);
  current.lessons = appendTextNotes(current.lessons, normalizeNotes(payload.lessons), MAX_ITEMS.notes, text(payload.lesson, 2_000), event);

  switch (event.event_type) {
    case "intent.connected":
      if (payload.relation_type && payload.target_intent_id) {
        current.relations = appendUnique(current.relations, [{
          relation_type: text(payload.relation_type, 80),
          target_intent_id: text(payload.target_intent_id, 160),
          reason: text(payload.reason, 400),
          event_id: event.event_id,
          at: event.occurred_at,
        }], MAX_ITEMS.relations);
      }
      break;
    case "intent.focus_pushed":
      if (text(payload.focus_role, 40) === "suspended") {
        current.focus_state = "suspended";
        current.focus_session_id = text(payload.session_id, 160);
        current.focus_child_intent_id = text(payload.child_intent_id, 160);
      } else {
        current.focus_state = "focused";
        current.focus_session_id = text(payload.session_id, 160);
      }
      break;
    case "intent.focus_popped":
      if (text(payload.focus_role, 40) === "restored") {
        current.focus_state = "focused";
        current.focus_session_id = text(payload.session_id, 160);
        current.focus_child_intent_id = "";
        current.restored_intent_id = text(payload.restored_from_intent_id, 160);
      } else {
        current.focus_state = "popped";
        current.focus_session_id = text(payload.session_id, 160);
        current.restored_intent_id = text(payload.restored_intent_id, 160);
      }
      break;
    default:
      break;
  }

  const nextLifecycle = LIFECYCLE_BY_EVENT[event.event_type];
  if (nextLifecycle) current.lifecycle_state = nextLifecycle;
  if (!current.lifecycle_state || current.lifecycle_state === "missing") current.lifecycle_state = "captured";
  return current;
}

function reduceIntentEvent(state, event, options = {}) {
  const current = state || createInitialState(event?.payload?.intent_id || "");
  if (!event || !event.event_type) return current;
  if (!INTENT_EVENT_TYPES.includes(event.event_type)) {
    const rawStreamId = String(event.stream_id || "");
    const streamIntentId = rawStreamId.startsWith("intent:") ? rawStreamId.slice("intent:".length) : "";
    const payloadIntentId = String(event?.payload?.intent_id || "").trim();
    const streamVersion = Number(event.stream_version || 0);
    const invalidUnknown = !current.exists
      ? `intent stream must begin with intent.captured; ignored forward-compatible event ${event.event_type}`
      : (!streamIntentId || !payloadIntentId || streamIntentId !== payloadIntentId
        ? "unknown intent event identity does not match stream"
        : (!Number.isSafeInteger(streamVersion) || streamVersion !== current.version + 1
          ? `out-of-order stream_version: expected ${current.version + 1}, received ${streamVersion}`
          : ""));
    if (invalidUnknown) {
      if (options.strict) throw new Error(invalidUnknown);
      return addDiagnostic(current, "invalid_event", invalidUnknown, event);
    }
    return addDiagnostic(current, "ignored_event_type", `ignored forward-compatible event ${event.event_type}`, event);
  }
  const validationError = validateEventForStream(event, current);
  if (validationError) {
    if (options.strict) throw new Error(validationError);
    return addDiagnostic(current, "invalid_event", validationError, event);
  }
  return applyIntentEvent(current, event);
}

async function readIntentStream(events, intentId, limits = {}, options = {}) {
  const safeIntentId = requireBoundedText(intentId, MAX_TEXT.id, "intent_id");
  const maxEvents = clampRange(limits.max_events || limits.maxEvents, DEFAULT_REHYDRATE_EVENT_LIMIT, options.maxCap || DEFAULT_REHYDRATE_EVENT_LIMIT);
  const streamId = intentStreamId(safeIntentId);
  const rows = [];
  let offset = 0;
  let truncated = false;
  while (rows.length < maxEvents) {
    const remaining = Math.min(PAGE_SIZE, maxEvents - rows.length);
    const page = await events.listEvents({ stream_id: streamId, order: "asc", offset, limit: remaining });
    if (!page.length) break;
    rows.push(...page);
    offset += page.length;
    if (page.length < remaining) break;
    if (rows.length >= maxEvents) {
      const probe = await events.listEvents({ stream_id: streamId, order: "asc", offset, limit: 1 });
      truncated = probe.length > 0;
      break;
    }
  }
  rows.sort((a, b) => Number(a.stream_version || 0) - Number(b.stream_version || 0)
    || String(a.recorded_at || "").localeCompare(String(b.recorded_at || ""))
    || String(a.event_id || "").localeCompare(String(b.event_id || "")));
  return {
    events: rows,
    limits: { page_size: PAGE_SIZE, max_events: maxEvents },
    truncation: {
      truncated,
      omitted_event_count_lower_bound: truncated ? 1 : 0,
    },
  };
}

async function scanIntentEvents(events, limits = {}, options = {}) {
  const maxEvents = clampRange(limits.max_events || limits.maxEvents, DEFAULT_LIST_EVENT_LIMIT, options.maxCap || DEFAULT_LIST_EVENT_LIMIT);
  const rows = [];
  let offset = 0;
  let truncated = false;
  while (rows.length < maxEvents) {
    const remaining = Math.min(PAGE_SIZE, maxEvents - rows.length);
    const page = await events.listEvents({ event_type_prefix: "intent.", order: "asc", offset, limit: remaining });
    if (!page.length) break;
    rows.push(...page);
    offset += page.length;
    if (page.length < remaining) break;
    if (rows.length >= maxEvents) {
      const probe = await events.listEvents({ event_type_prefix: "intent.", order: "asc", offset, limit: 1 });
      truncated = probe.length > 0;
      break;
    }
  }
  return {
    events: rows,
    limits: { page_size: PAGE_SIZE, max_events: maxEvents },
    truncation: {
      truncated,
      omitted_event_count_lower_bound: truncated ? 1 : 0,
    },
  };
}

function foldIntentEvents(rows, options = {}) {
  return rows.reduce((state, event) => reduceIntentEvent(state, event, options), createInitialState());
}

async function crossStreamTargetErrors(events, rows) {
  const errors = new Map();
  const existence = new Map();
  async function targetExists(rawIntentId) {
    if (!rawIntentId) return true;
    let intentId;
    try {
      intentId = requireBoundedText(rawIntentId, MAX_TEXT.id, "target intent_id");
    } catch {
      return false;
    }
    if (!existence.has(intentId)) {
      if (existence.size >= MAX_CROSS_STREAM_TARGETS) return null;
      existence.set(intentId, (async () => {
        const page = await events.listEvents({ stream_id: intentStreamId(intentId), order: "asc", offset: 0, limit: PAGE_SIZE });
        page.sort((a, b) => Number(a.stream_version || 0) - Number(b.stream_version || 0));
        const capture = page[0];
        return Boolean(capture)
          && Number(capture.stream_version || 0) === 1
          && capture.event_type === "intent.captured"
          && String(capture?.payload?.intent_id || "").trim() === intentId;
      })());
    }
    return existence.get(intentId);
  }

  for (const event of rows) {
    const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
    const targets = [];
    if (event.event_type === "intent.connected") {
      targets.push([payload.target_intent_id, "relation target"]);
    } else if (event.event_type === "intent.focus_pushed") {
      targets.push([payload.parent_intent_id, "focus parent"]);
      targets.push([payload.return_to_intent_id, "focus return target"]);
      targets.push([payload.child_intent_id, "focus child"]);
    } else if (event.event_type === "intent.focus_popped") {
      targets.push([payload.parent_intent_id, "focus parent"]);
      targets.push([payload.return_to_intent_id, "focus return target"]);
      targets.push([payload.restored_from_intent_id, "restored child"]);
      targets.push([payload.restored_intent_id, "restored target"]);
    }
    for (const [targetIntentId, label] of targets) {
      if (!targetIntentId) continue;
      const exists = await targetExists(targetIntentId);
      if (exists !== true) {
        errors.set(event, exists === null
          ? `cross-stream target validation exceeds bound ${MAX_CROSS_STREAM_TARGETS}`
          : `${label} intent not found: ${String(targetIntentId).trim()}`);
        break;
      }
    }
  }
  return errors;
}

async function rehydrateIntent(events, intentId, limits = {}, options = {}) {
  const result = await readIntentStream(events, intentId, limits, options);
  if (options.requireFull && result.truncation.truncated) {
    throw new Error(`intent history exceeds mutation bound for ${text(intentId, 160)}`);
  }
  const targetErrors = await crossStreamTargetErrors(events, result.events);
  const state = result.events.reduce((acc, event) => {
    const targetError = targetErrors.get(event);
    if (!targetError) return reduceIntentEvent(acc, event, options);
    if (options.strict) throw new Error(targetError);
    return addDiagnostic(acc, "invalid_event", targetError, event);
  }, createInitialState(intentId));
  if (result.truncation.truncated) state.uncertainty = "history_truncated";
  return {
    ...state,
    limits: result.limits,
    truncation: result.truncation,
  };
}

async function listIntents(events, filter = {}) {
  const scan = await scanIntentEvents(events, filter.limits || filter);
  const targetErrors = await crossStreamTargetErrors(events, scan.events);
  const groupedEvents = new Map();
  for (const event of scan.events) {
    const streamId = text(event.stream_id, 240);
    if (!streamId.startsWith("intent:")) continue;
    const intentId = streamId.slice("intent:".length);
    const rows = groupedEvents.get(intentId) || [];
    rows.push(event);
    groupedEvents.set(intentId, rows);
  }
  const grouped = new Map();
  for (const [intentId, rows] of groupedEvents) {
    rows.sort((a, b) => Number(a.stream_version || 0) - Number(b.stream_version || 0)
      || String(a.recorded_at || "").localeCompare(String(b.recorded_at || ""))
      || String(a.event_id || "").localeCompare(String(b.event_id || "")));
    grouped.set(intentId, rows.reduce((state, event) => {
      const targetError = targetErrors.get(event);
      return targetError
        ? addDiagnostic(state, "invalid_event", targetError, event)
        : reduceIntentEvent(state, event, { strict: false });
    }, createInitialState(intentId)));
  }

  let items = [...grouped.values()].filter((item) => item.exists);
  const rawProjectId = filter.project_id || filter.projectId;
  const projectId = rawProjectId ? requireBoundedText(rawProjectId, MAX_TEXT.id, "project_id") : "";
  const lifecycleState = text(filter.lifecycle_state || filter.lifecycleState, 80);
  const rawSessionId = filter.session_id || filter.sessionId;
  const sessionId = rawSessionId ? requireBoundedText(rawSessionId, MAX_TEXT.id, "session_id") : "";
  if (projectId) items = items.filter((item) => item.project_id === projectId);
  if (lifecycleState) items = items.filter((item) => item.lifecycle_state === lifecycleState);
  if (sessionId) items = items.filter((item) => item.source.session_id === sessionId || item.focus_session_id === sessionId);
  items.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")) || String(a.intent_id).localeCompare(String(b.intent_id)));

  const offset = clampOffset(filter.offset);
  const limit = clampRange(filter.limit, 20, PAGE_SIZE);
  const paged = items.slice(offset, offset + limit);

  return {
    items: paged,
    total_count: scan.truncation.truncated ? null : items.length,
    total_count_lower_bound: paged.length,
    limits: {
      page_size: PAGE_SIZE,
      scan_event_limit: scan.limits.max_events,
      offset,
      limit,
    },
    truncation: scan.truncation,
  };
}

async function rehydrateProject(events, projectId, limits = {}) {
  const safeProjectId = requireBoundedText(projectId, MAX_TEXT.id, "project_id");
  const list = await listIntents(events, {
    project_id: safeProjectId,
    limit: integer(limits.limit, 50),
    offset: integer(limits.offset, 0),
    limits,
  });
  return {
    project_id: safeProjectId,
    intents: list.items,
    limits: list.limits,
    truncation: list.truncation,
    total_count: list.total_count,
    total_count_lower_bound: list.total_count_lower_bound,
    uncertainty: list.truncation.truncated ? "scan_truncated" : "",
  };
}

async function rehydrateIntentForMutation(events, intentId) {
  return rehydrateIntent(
    events,
    intentId,
    { max_events: MAX_MUTATION_EVENT_LIMIT },
    { strict: true, requireFull: true, maxCap: MAX_MUTATION_EVENT_LIMIT },
  );
}

module.exports = {
  createInitialState,
  appendUnique,
  reduceIntentEvent,
  readIntentStream,
  scanIntentEvents,
  foldIntentEvents,
  rehydrateIntent,
  listIntents,
  rehydrateProject,
  rehydrateIntentForMutation,
  crossStreamTargetErrors,
};
