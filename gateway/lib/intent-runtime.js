"use strict";

const crypto = require("node:crypto");
const {
  createDefaultIdFactory,
  buildCaptureEvent,
  buildTransitionEvent,
  buildConnectEvent,
  buildFocusPushEvent,
  buildFocusPopEvent,
  requireBoundedText,
  normalizeMutationPayload,
  normalizeRelationType,
  normalizeTransitionType,
  namespaceIdempotencyKey,
  normalizeRefs,
  text,
  intentStreamId,
  MAX_MUTATION_EVENT_LIMIT,
  MAX_TEXT,
} = require("./intent-runtime-router");
const {
  rehydrateIntent,
  listIntents,
  rehydrateProject,
  rehydrateIntentForMutation,
  readIntentStream,
} = require("./intent-runtime-rehydration");
const { buildIntentContextPacket } = require("./intent-context-packet");

const MESSAGE_ROUTE_ACTIONS = new Set([
  "observation",
  "note",
  "update_existing_intent",
  "new_intent",
  "fork_intent",
  "merge_intents",
  "steer_existing_agent",
  "launch_new_agent",
  "request_decision",
  "update_artifact",
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function comparablePayload(event, { ignoreCaptureCreatedAt = true } = {}) {
  const payload = event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? { ...event.payload }
    : {};
  if (ignoreCaptureCreatedAt && event?.event_type === "intent.captured") delete payload.created_at;
  return payload;
}

function sameEventShape(a, b, options = {}) {
  return Boolean(a)
    && Boolean(b)
    && a.stream_id === b.stream_id
    && a.event_type === b.event_type
    && a.idempotency_key === b.idempotency_key
    && stableJson(comparablePayload(a, options)) === stableJson(comparablePayload(b, options));
}

function createIntentRuntime({ events, idFactory, now } = {}) {
  if (!events || typeof events.appendEvent !== "function" || typeof events.listEvents !== "function") {
    throw new Error("intent runtime requires an event substrate with appendEvent/listEvents");
  }
  const makeId = typeof idFactory === "function" ? idFactory : createDefaultIdFactory();
  const intentQueues = new Map();

  async function withIntentSerialization(intentIds, task) {
    const keys = [...new Set(intentIds.map((value) => requireBoundedText(value, MAX_TEXT.id, "intent_id")))].sort();
    const predecessors = keys.map((key) => intentQueues.get(key) || Promise.resolve());
    const predecessor = Promise.all(predecessors);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = predecessor.then(() => gate);
    for (const key of keys) intentQueues.set(key, tail);
    await predecessor;
    try {
      return await task();
    } finally {
      release();
      for (const key of keys) {
        if (intentQueues.get(key) === tail) intentQueues.delete(key);
      }
    }
  }

  async function authoritativeState(intentId) {
    return rehydrateIntentForMutation(events, requireBoundedText(intentId, MAX_TEXT.id, "intent_id"));
  }

  async function readIdempotentEvent(key) {
    const rows = await events.listEvents({
      idempotency_key: requireBoundedText(key, MAX_TEXT.idempotency, "idempotency_key"),
      limit: 2,
      order: "asc",
    });
    if (rows.length > 1) throw new Error(`duplicate global idempotency key: ${key}`);
    return rows[0] || null;
  }

  async function appendVerified(event) {
    if (Object.prototype.hasOwnProperty.call(event, "stream_version")) {
      throw new Error(`intent runtime must not assign stream_version for ${event.idempotency_key}`);
    }
    const expectedVersion = Number(event.expected_stream_version);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error(`invalid expected stream version for ${event.idempotency_key}`);
    }
    const appended = await events.appendEvent(event);
    if (!sameEventShape(appended, event)
      || Number(appended?.stream_version || 0) !== expectedVersion + 1) {
      throw new Error(`append result mismatch for ${event.idempotency_key}`);
    }
    return appended;
  }

  async function existingIdempotentEvent(expectedEvent) {
    const existing = await readIdempotentEvent(expectedEvent.idempotency_key);
    if (!existing) return null;
    if (!sameEventShape(existing, expectedEvent)) {
      throw new Error(`idempotency collision for ${expectedEvent.idempotency_key}`);
    }
    return existing;
  }

  function withExpectedVersion(event, version) {
    if (!Number.isSafeInteger(version) || version < 0) throw new Error("expected stream version must be non-negative");
    return { ...event, expected_stream_version: version };
  }

  function eventDescriptor({ intentId, eventType, idempotencyKey, payload }) {
    return {
      stream_id: intentStreamId(intentId),
      event_type: eventType,
      idempotency_key: idempotencyKey,
      payload,
    };
  }

  function currentIsoTime() {
    const value = typeof now === "function" ? now() : new Date().toISOString();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  }

  function durableEvent({ intentId, eventType, idempotencyKey, payload, actor, correlationId, causationId }) {
    return {
      ...eventDescriptor({ intentId, eventType, idempotencyKey, payload }),
      occurred_at: currentIsoTime(),
      actor: actor && typeof actor === "object" ? actor : { kind: "gateway", id: "intent-runtime" },
      authority: { boundary: "intent-runtime", execution: "proposal_event_log" },
      correlation_id: text(correlationId || intentId, MAX_TEXT.id),
      causation_id: text(causationId, MAX_TEXT.id),
    };
  }

  async function appendIntentEvent(intentId, command, eventType, payload) {
    const safeIntentId = requireBoundedText(intentId, MAX_TEXT.id, "intent_id");
    const descriptor = durableEvent({
      intentId: safeIntentId,
      eventType,
      idempotencyKey: namespaceIdempotencyKey(
        safeIntentId,
        eventType.slice("intent.".length),
        command.idempotency_key || command.idempotencyKey || eventType,
      ),
      payload: { intent_id: safeIntentId, ...payload },
      actor: command.actor,
      correlationId: command.correlation_id || command.correlationId,
      causationId: command.causation_id || command.causationId,
    });
    return withIntentSerialization([safeIntentId], async () => {
      const existing = await existingIdempotentEvent(descriptor);
      const state = await authoritativeState(safeIntentId);
      if (existing) return rehydrateIntent(events, safeIntentId, command.limits || {});
      const expected = command.expected_intent_version ?? command.expectedIntentVersion;
      if (expected !== undefined && Number(expected) !== state.version) {
        throw new Error(`intent version conflict: expected ${expected}, current ${state.version}`);
      }
      await appendVerified(withExpectedVersion(descriptor, state.version));
      return rehydrateIntent(events, safeIntentId, command.limits || {});
    });
  }

  async function streamOccupancy(intentId) {
    return events.listEvents({ stream_id: intentStreamId(intentId), order: "asc", offset: 0, limit: 1 });
  }

  async function appendMessageStreamEvent(streamId, eventType, key, payload) {
    return withIntentSerialization([streamId], async () => {
      const descriptor = {
        stream_id: streamId,
        event_type: eventType,
        idempotency_key: requireBoundedText(key, MAX_TEXT.idempotency, "idempotency_key"),
        occurred_at: currentIsoTime(),
        actor: { kind: "gateway", id: "intent-message-ingress" },
        authority: { boundary: "intent-runtime", execution: "routing_record_only" },
        correlation_id: text(payload.message_id, MAX_TEXT.id),
        causation_id: "",
        payload,
      };
      const existing = await existingIdempotentEvent(descriptor);
      if (existing) return existing;
      const latest = await events.listEvents({ stream_id: streamId, order: "desc", offset: 0, limit: 1 });
      const version = latest.length ? Number(latest[0].stream_version || 0) : 0;
      return appendVerified(withExpectedVersion(descriptor, version));
    });
  }

  async function capture(input = {}) {
    const event = withExpectedVersion(buildCaptureEvent(input, { idFactory: makeId, now }), 0);
    const intentId = event.payload.intent_id;
    return withIntentSerialization([intentId], async () => {
      if (await existingIdempotentEvent(event)) {
        await authoritativeState(intentId);
        return rehydrateIntent(events, intentId, input.limits || {});
      }
      const occupied = await streamOccupancy(intentId);
      if (occupied.length) throw new Error(`intent already exists or stream is occupied: ${intentId}`);
      await appendVerified(event);
      return rehydrateIntent(events, intentId, input.limits || {});
    });
  }

  async function transition(intentId, command = {}) {
    const safeIntentId = requireBoundedText(intentId, MAX_TEXT.id, "intent_id");
    const eventType = normalizeTransitionType(command.type || command.event_type || command.eventType);
    if (!eventType) throw new Error(`unsupported transition type: ${text(command.type || command.event_type || command.eventType, MAX_TEXT.eventType) || "(empty)"}`);
    const payload = { intent_id: safeIntentId, ...normalizeMutationPayload(command) };
    if (eventType === "intent.completed" && !payload.outcome) throw new Error("completed transition requires outcome");
    const descriptor = eventDescriptor({
      intentId: safeIntentId,
      eventType,
      idempotencyKey: namespaceIdempotencyKey(safeIntentId, "transition", command.idempotency_key || command.idempotencyKey || eventType),
      payload,
    });
    return withIntentSerialization([safeIntentId], async () => {
      const existing = await existingIdempotentEvent(descriptor);
      const state = await authoritativeState(safeIntentId);
      if (existing) return rehydrateIntent(events, safeIntentId, command.limits || {});
      const expectedIntentVersion = command.expected_intent_version ?? command.expectedIntentVersion;
      if (expectedIntentVersion !== undefined
        && (!Number.isSafeInteger(Number(expectedIntentVersion))
          || Number(expectedIntentVersion) !== state.version)) {
        throw new Error(`intent version conflict: expected ${expectedIntentVersion}, current ${state.version}`);
      }
      const event = withExpectedVersion(buildTransitionEvent(state, safeIntentId, command, { now }), state.version);
      await appendVerified(event);
      return rehydrateIntent(events, safeIntentId, command.limits || {});
    });
  }

  async function connect(intentId, relation = {}) {
    const safeIntentId = requireBoundedText(intentId, MAX_TEXT.id, "intent_id");
    const targetIntentId = requireBoundedText(relation.target_intent_id || relation.targetIntentId, MAX_TEXT.id, "target_intent_id");
    const relationType = normalizeRelationType(relation.relation_type || relation.relationType || relation.type);
    if (!relationType) throw new Error(`unsupported relation type: ${text(relation.relation_type || relation.relationType || relation.type, MAX_TEXT.eventType) || "(empty)"}`);
    const descriptor = eventDescriptor({
      intentId: safeIntentId,
      eventType: "intent.connected",
      idempotencyKey: namespaceIdempotencyKey(safeIntentId, "connect", relation.idempotency_key || relation.idempotencyKey || `${relationType}:${targetIntentId}`),
      payload: {
        intent_id: safeIntentId,
        relation_type: relationType,
        target_intent_id: targetIntentId,
        reason: text(relation.reason, MAX_TEXT.relationReason),
        source_receipt_refs: normalizeRefs(relation.source_receipt_refs || relation.sourceReceiptRefs),
      },
    });
    return withIntentSerialization([safeIntentId, targetIntentId], async () => {
      const existing = await existingIdempotentEvent(descriptor);
      const state = await authoritativeState(safeIntentId);
      const targetState = await authoritativeState(targetIntentId);
      if (!targetState.exists) throw new Error(`target intent not found: ${targetIntentId}`);
      if (existing) return rehydrateIntent(events, safeIntentId, relation.limits || {});
      const event = withExpectedVersion(buildConnectEvent(state, safeIntentId, relation, { now }), state.version);
      await appendVerified(event);
      return rehydrateIntent(events, safeIntentId, relation.limits || {});
    });
  }

  async function pushFocus(input = {}) {
    const childIntentId = requireBoundedText(input.intent_id || input.intentId, MAX_TEXT.id, "intent_id");
    const parentIntentId = requireBoundedText(input.parent_intent_id || input.parentIntentId, MAX_TEXT.id, "parent_intent_id");
    const returnToIntentId = requireBoundedText(input.return_to_intent_id || input.returnToIntentId || parentIntentId, MAX_TEXT.id, "return_to_intent_id");
    if (childIntentId === parentIntentId || childIntentId === returnToIntentId) {
      throw new Error("transactional child, parent, and return target must be distinct where applicable");
    }
    const sessionId = requireBoundedText(input.session_id || input.sessionId, MAX_TEXT.id, "session_id");
    const baseKey = input.idempotency_key || input.idempotencyKey || "focus";
    const sourceReceiptRefs = normalizeRefs(input.source_receipt_refs || input.sourceReceiptRefs);
    const suspendedDescriptor = eventDescriptor({
      intentId: returnToIntentId,
      eventType: "intent.focus_pushed",
      idempotencyKey: namespaceIdempotencyKey(returnToIntentId, "focus-push", `${baseKey}:return`),
      payload: {
        intent_id: returnToIntentId,
        session_id: sessionId,
        parent_intent_id: parentIntentId,
        return_to_intent_id: returnToIntentId,
        child_intent_id: childIntentId,
        focus_role: "suspended",
        source_receipt_refs: sourceReceiptRefs,
      },
    });
    const childDescriptor = eventDescriptor({
      intentId: childIntentId,
      eventType: "intent.focus_pushed",
      idempotencyKey: namespaceIdempotencyKey(childIntentId, "focus-push", `${baseKey}:child`),
      payload: {
        intent_id: childIntentId,
        session_id: sessionId,
        parent_intent_id: parentIntentId,
        return_to_intent_id: returnToIntentId,
        child_intent_id: childIntentId,
        focus_role: "child",
        source_receipt_refs: sourceReceiptRefs,
      },
    });
    const compensationDescriptor = eventDescriptor({
      intentId: returnToIntentId,
      eventType: "intent.focus_popped",
      idempotencyKey: namespaceIdempotencyKey(returnToIntentId, "focus-push-compensate", `${baseKey}:return`),
      payload: {
        intent_id: returnToIntentId,
        session_id: sessionId,
        parent_intent_id: parentIntentId,
        return_to_intent_id: returnToIntentId,
        restored_from_intent_id: childIntentId,
        restored_intent_id: "",
        focus_role: "restored",
        source_receipt_refs: sourceReceiptRefs,
      },
    });

    return withIntentSerialization([childIntentId, parentIntentId, returnToIntentId], async () => {
      const existingSuspended = await existingIdempotentEvent(suspendedDescriptor);
      const existingChild = await existingIdempotentEvent(childDescriptor);
      const existingCompensation = await existingIdempotentEvent(compensationDescriptor);
      const childState = await authoritativeState(childIntentId);
      const parentState = await authoritativeState(parentIntentId);
      const returnState = returnToIntentId === parentIntentId ? parentState : await authoritativeState(returnToIntentId);
      if (!childState.exists) throw new Error(`child intent not found: ${childIntentId}`);
      if (!parentState.exists) throw new Error(`parent intent not found: ${parentIntentId}`);
      if (!returnState.exists) throw new Error(`return target intent not found: ${returnToIntentId}`);
      if (existingCompensation) {
        if (existingChild) throw new Error("focus push history contains both child admission and compensation");
        throw focusPushCompensatedError(childIntentId);
      }
      if (existingSuspended && existingChild) return rehydrateIntent(events, childIntentId, input.limits || {});

      let suspendedEvent = null;
      if (!existingSuspended) {
        suspendedEvent = withExpectedVersion(buildFocusPushEvent(returnState, {
          ...input,
          stream_intent_id: returnToIntentId,
          parent_intent_id: parentIntentId,
          child_intent_id: childIntentId,
          return_to_intent_id: returnToIntentId,
          focus_role: "suspended",
          idempotency_key: `${baseKey}:return`,
        }, { now }), returnState.version);
      }
      let childEvent = null;
      if (!existingChild) {
        try {
          childEvent = withExpectedVersion(buildFocusPushEvent(childState, {
            ...input,
            stream_intent_id: childIntentId,
            parent_intent_id: parentIntentId,
            return_to_intent_id: returnToIntentId,
            child_intent_id: childIntentId,
            focus_role: "child",
            idempotency_key: `${baseKey}:child`,
          }, { now }), childState.version);
        } catch (error) {
          if (
            existingSuspended
            && returnState.focus_state === "suspended"
            && returnState.focus_child_intent_id === childIntentId
          ) {
            const compensation = withExpectedVersion(buildFocusPopEvent(returnState, {
              ...input,
              stream_intent_id: returnToIntentId,
              parent_intent_id: parentIntentId,
              return_to_intent_id: returnToIntentId,
              restored_from_intent_id: childIntentId,
              restored_intent_id: "",
              focus_role: "restored",
              idempotency_key: `${baseKey}:return`,
            }, { now }), returnState.version);
            compensation.idempotency_key = compensationDescriptor.idempotency_key;
            await appendVerified(compensation);
            const compensated = focusPushCompensatedError(childIntentId);
            compensated.cause = error;
            throw compensated;
          }
          throw error;
        }
      }

      if (suspendedEvent) await appendVerified(suspendedEvent);
      if (childEvent) await appendVerified(childEvent);
      return rehydrateIntent(events, childIntentId, input.limits || {});
    });
  }

  function focusPushCompensatedError(intentId) {
    const error = new Error(`focus push was compensated after a partial failure: ${intentId}`);
    error.code = "INTENT_FOCUS_PUSH_COMPENSATED";
    return error;
  }

  async function completeTransactional(intentId, input = {}) {
    const safeIntentId = requireBoundedText(intentId, MAX_TEXT.id, "intent_id");
    const receiptRefs = normalizeRefs(input.receipt_refs || input.receiptRefs);
    if (!receiptRefs.length) {
      throw new Error("transactional completion requires at least one receipt_ref");
    }
    const command = {
      ...input,
      type: "intent.completed",
      receipt_refs: receiptRefs,
    };
    const payload = { intent_id: safeIntentId, ...normalizeMutationPayload(command) };
    if (!payload.outcome) throw new Error("completed transition requires outcome");
    const descriptor = eventDescriptor({
      intentId: safeIntentId,
      eventType: "intent.completed",
      idempotencyKey: namespaceIdempotencyKey(safeIntentId, "transition", input.idempotency_key || input.idempotencyKey || "intent.completed"),
      payload,
    });
    return withIntentSerialization([safeIntentId], async () => {
      const existing = await existingIdempotentEvent(descriptor);
      const state = await authoritativeState(safeIntentId);
      if (existing) return rehydrateIntent(events, safeIntentId, input.limits || {});
      if (state.focus_state !== "focused") {
        throw new Error(`transactional completion requires focused intent: ${safeIntentId}`);
      }
      const event = withExpectedVersion(buildTransitionEvent(state, safeIntentId, command, { now }), state.version);
      await appendVerified(event);
      return rehydrateIntent(events, safeIntentId, input.limits || {});
    });
  }

  async function popFocus(input = {}) {
    const childIntentId = requireBoundedText(input.intent_id || input.intentId, MAX_TEXT.id, "intent_id");
    const preliminaryChild = await authoritativeState(childIntentId);
    const preliminaryReturnId = requireBoundedText(preliminaryChild.return_to_intent_id || input.return_to_intent_id || input.returnToIntentId, MAX_TEXT.id, "return_to_intent_id");
    const preliminaryParentId = requireBoundedText(preliminaryChild.parent_intent_id || input.parent_intent_id || input.parentIntentId, MAX_TEXT.id, "parent_intent_id");
    return withIntentSerialization([childIntentId, preliminaryParentId, preliminaryReturnId], async () => {
      const childState = await authoritativeState(childIntentId);
      const returnToIntentId = requireBoundedText(childState.return_to_intent_id || input.return_to_intent_id || input.returnToIntentId, MAX_TEXT.id, "return_to_intent_id");
      const parentIntentId = requireBoundedText(childState.parent_intent_id || input.parent_intent_id || input.parentIntentId, MAX_TEXT.id, "parent_intent_id");
      if (returnToIntentId !== preliminaryReturnId || parentIntentId !== preliminaryParentId) {
        throw new Error("focus targets changed while acquiring serialization locks");
      }
      const parentState = await authoritativeState(parentIntentId);
      const returnState = returnToIntentId === parentIntentId ? parentState : await authoritativeState(returnToIntentId);
      if (!parentState.exists) throw new Error(`parent intent not found: ${parentIntentId}`);
      if (!returnState.exists) throw new Error(`return target intent not found: ${returnToIntentId}`);
      const sessionId = requireBoundedText(input.session_id || input.sessionId || childState.focus_session_id, MAX_TEXT.id, "session_id");
      const baseKey = input.idempotency_key || input.idempotencyKey || "focus";
      const sourceReceiptRefs = normalizeRefs(input.source_receipt_refs || input.sourceReceiptRefs);
      const restoredReturnId = returnState.return_to_intent_id || returnToIntentId;
      const childDescriptor = eventDescriptor({
        intentId: childIntentId,
        eventType: "intent.focus_popped",
        idempotencyKey: namespaceIdempotencyKey(childIntentId, "focus-pop", `${baseKey}:child`),
        payload: {
          intent_id: childIntentId,
          session_id: sessionId,
          parent_intent_id: parentIntentId,
          return_to_intent_id: returnToIntentId,
          restored_from_intent_id: "",
          restored_intent_id: returnToIntentId,
          focus_role: "child",
          source_receipt_refs: sourceReceiptRefs,
        },
      });
      const restoredDescriptor = eventDescriptor({
        intentId: returnToIntentId,
        eventType: "intent.focus_popped",
        idempotencyKey: namespaceIdempotencyKey(returnToIntentId, "focus-pop", `${baseKey}:return`),
        payload: {
          intent_id: returnToIntentId,
          session_id: sessionId,
          parent_intent_id: returnState.parent_intent_id || "",
          return_to_intent_id: restoredReturnId,
          restored_from_intent_id: childIntentId,
          restored_intent_id: "",
          focus_role: "restored",
          source_receipt_refs: sourceReceiptRefs,
        },
      });
      const existingChild = await existingIdempotentEvent(childDescriptor);
      const existingRestored = await existingIdempotentEvent(restoredDescriptor);
      if (existingChild && existingRestored) return rehydrateIntent(events, childIntentId, input.limits || {});

      let childEvent = null;
      if (!existingChild) {
        childEvent = withExpectedVersion(buildFocusPopEvent(childState, {
          ...input,
          stream_intent_id: childIntentId,
          parent_intent_id: parentIntentId,
          return_to_intent_id: returnToIntentId,
          restored_intent_id: returnToIntentId,
          restored_from_intent_id: "",
          focus_role: "child",
          idempotency_key: `${baseKey}:child`,
        }, { now }), childState.version);
      }
      let restoredEvent = null;
      if (!existingRestored) {
        restoredEvent = withExpectedVersion(buildFocusPopEvent(returnState, {
          ...input,
          stream_intent_id: returnToIntentId,
          parent_intent_id: returnState.parent_intent_id,
          return_to_intent_id: restoredReturnId,
          restored_from_intent_id: childIntentId,
          restored_intent_id: "",
          focus_role: "restored",
          idempotency_key: `${baseKey}:return`,
        }, { now }), returnState.version);
      }

      if (childEvent) await appendVerified(childEvent);
      if (restoredEvent) await appendVerified(restoredEvent);
      return rehydrateIntent(events, childIntentId, input.limits || {});
    });
  }

  async function get(intentId, limits = {}) {
    return rehydrateIntent(events, requireBoundedText(intentId, MAX_TEXT.id, "intent_id"), limits);
  }

  async function list(filter = {}) {
    return listIntents(events, filter);
  }

  async function rehydrate(input = {}) {
    if (input.intent_id || input.intentId) {
      const safeIntentId = requireBoundedText(input.intent_id || input.intentId, MAX_TEXT.id, "intent_id");
      return rehydrateIntent(events, safeIntentId, input.limits || input);
    }
    if (input.project_id || input.projectId) {
      const safeProjectId = requireBoundedText(input.project_id || input.projectId, MAX_TEXT.id, "project_id");
      return rehydrateProject(events, safeProjectId, input.limits || input);
    }
    throw new Error("rehydrate requires intent_id or project_id");
  }

  async function contextPacket(intentId, options = {}) {
    const safeIntentId = requireBoundedText(intentId, MAX_TEXT.id, "intent_id");
    const state = await rehydrateIntent(events, safeIntentId, options.limits || {});
    if (!state?.exists) return null;
    return buildIntentContextPacket({
      events,
      state,
      generatedAt: typeof now === "function" ? now() : new Date().toISOString(),
      compactionModel: options.compaction_model || options.compactionModel,
      compactionVersion: options.compaction_version || options.compactionVersion,
    });
  }

  async function recordSource(intentId, input = {}) {
    const rawText = String(input.raw_text || input.rawText || "");
    if (!rawText) throw new Error("raw_text is required");
    if (Buffer.byteLength(rawText, "utf8") > 64_000) throw new Error("raw_text exceeds max length 64000 bytes");
    const provenance = input.provenance && typeof input.provenance === "object" && !Array.isArray(input.provenance)
      ? input.provenance
      : {};
    if (JSON.stringify(provenance).length > 4_000) throw new Error("source provenance exceeds max length 4000");
    const revision = Number(input.revision || 1);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("source revision must be a positive integer");
    return appendIntentEvent(intentId, input, "intent.source_recorded", {
      raw_text: rawText,
      source_digest: crypto.createHash("sha256").update(rawText).digest("hex"),
      revision,
      media_type: text(input.media_type || input.mediaType || "text/plain", 80),
      source_ref: text(input.source_ref || input.sourceRef, MAX_TEXT.ref),
      provenance,
    });
  }

  async function history(intentId, limits = {}) {
    const safeIntentId = requireBoundedText(intentId, MAX_TEXT.id, "intent_id");
    const result = await readIntentStream(events, safeIntentId, limits);
    if (!result.events.length) return null;
    return { intent_id: safeIntentId, ...result };
  }

  async function launch(input = {}) {
    const raw = String(input.message || input.command || input.raw_text || input.rawText || "");
    if (!raw.trim()) throw new Error("message is required");
    if (raw.length > 64_000) throw new Error("message exceeds max length 64000");
    const match = raw.match(/^\s*intent\s+launch\s+([\s\S]+?)\s*$/i);
    const thought = requireBoundedText(match ? match[1] : raw, 64_000, "thought");
    const key = requireBoundedText(input.idempotency_key || input.idempotencyKey, 180, "idempotency_key");
    const stableId = `intent_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
    const intentId = requireBoundedText(input.intent_id || input.intentId || stableId, MAX_TEXT.id, "intent_id");
    const objective = text(input.normalized_objective || input.normalizedObjective || thought, MAX_TEXT.objective);
    await capture({
      ...input,
      intent_id: intentId,
      statement: text(input.statement || thought, MAX_TEXT.statement),
      normalized_objective: objective,
      idempotency_key: `${key}:capture`,
    });
    await appendIntentEvent(intentId, {
      ...input,
      idempotency_key: `${key}:source`,
    }, "intent.source_recorded", {
      raw_text: raw,
      source_digest: crypto.createHash("sha256").update(raw).digest("hex"),
      revision: 1,
      media_type: text(input.media_type || input.mediaType || "text/plain", 80),
      source_ref: text(input.source_ref || input.sourceRef || input.transcript_ref || input.transcriptRef, 400),
      provenance: input.provenance && typeof input.provenance === "object" ? input.provenance : {},
    });
    await transition(intentId, {
      type: "intent.disambiguated",
      idempotency_key: `${key}:clarified`,
      constraints: input.constraints,
      completion_criteria: input.completion_criteria || input.completionCriteria,
    });
    await transition(intentId, {
      type: "intent.planned",
      idempotency_key: `${key}:planned`,
      next_step: input.next_step || input.nextStep || "Claim this intent and execute its first bounded next action.",
    });
    const state = await transition(intentId, {
      type: "intent.execution_started",
      idempotency_key: `${key}:active`,
    });
    return {
      intent_id: intentId,
      status: state.lifecycle_state,
      confirmation: `Intent persisted: ${intentId}`,
      context_packet: await contextPacket(intentId),
    };
  }

  async function ingestMessage(input = {}) {
    const raw = String(input.message || input.raw_text || input.rawText || "");
    if (!raw.trim()) throw new Error("message is required");
    if (raw.length > 64_000) throw new Error("message exceeds max length 64000");
    const key = requireBoundedText(input.idempotency_key || input.idempotencyKey, 180, "idempotency_key");
    const workspaceId = text(input.workspace_id || input.workspaceId || "default", 120) || "default";
    const messageId = `message_${crypto.createHash("sha256").update(`${workspaceId}:${key}`).digest("hex").slice(0, 32)}`;
    const streamId = `messages:${workspaceId}`;
    const artifactContext = input.artifact_context || input.artifactContext || {};
    const ingested = await appendMessageStreamEvent(streamId, "message.ingested", `message:${messageId}:ingested`, {
      message_id: messageId,
      workspace_id: workspaceId,
      raw_text: raw,
      source_digest: crypto.createHash("sha256").update(raw).digest("hex"),
      source: input.source && typeof input.source === "object" ? input.source : {},
      artifact_context: {
        artifact_id: text(artifactContext.artifact_id || artifactContext.artifactId, MAX_TEXT.id),
        version: text(artifactContext.version, MAX_TEXT.id),
        ref: text(artifactContext.ref, MAX_TEXT.ref),
      },
    });
    const routing = input.routing && typeof input.routing === "object" ? input.routing : {};
    const action = String(routing.action || input.action || "observation").trim();
    if (!MESSAGE_ROUTE_ACTIONS.has(action)) throw new Error(`unsupported message route action: ${action}`);
    const targetIntentId = text(routing.intent_id || routing.intentId || input.intent_id || input.intentId, MAX_TEXT.id);
    const routed = await appendMessageStreamEvent(streamId, "message.routed", `message:${messageId}:routed`, {
      message_id: messageId,
      ingested_event_id: ingested.event_id,
      action,
      intent_id: targetIntentId,
      agent_id: text(routing.agent_id || routing.agentId, MAX_TEXT.id),
      artifact_context: ingested.payload.artifact_context,
      reason: text(routing.reason, MAX_TEXT.detail),
      confidence: Math.max(0, Math.min(Number(routing.confidence || 0), 1)),
      reversible: true,
      supersedes_routing_event_id: text(routing.supersedes_routing_event_id || routing.supersedesRoutingEventId, MAX_TEXT.id),
    });

    let intent = null;
    let packet = null;
    if (["new_intent", "fork_intent"].includes(action)) {
      const launched = await launch({
        ...input,
        message: raw,
        idempotency_key: `${key}:intent`,
        intent_id: targetIntentId || undefined,
        parent_intent_id: action === "fork_intent" ? routing.parent_intent_id || routing.parentIntentId : undefined,
        source_ref: `event://${ingested.event_id}`,
      });
      intent = await get(launched.intent_id);
      packet = launched.context_packet;
    } else if (action === "update_existing_intent") {
      if (!targetIntentId) throw new Error("existing-intent route requires intent_id");
      intent = await appendIntentEvent(targetIntentId, {
        ...input,
        idempotency_key: `${key}:intent-source`,
      }, "intent.source_recorded", {
        raw_text: raw,
        source_digest: ingested.payload.source_digest,
        revision: Number(input.revision || 1),
        media_type: text(input.media_type || input.mediaType || "text/plain", 80),
        source_ref: `event://${ingested.event_id}`,
        provenance: { message_id: messageId, routing_event_id: routed.event_id },
      });
      packet = await contextPacket(targetIntentId);
    }
    return {
      message_id: messageId,
      ingested_event_id: ingested.event_id,
      routing_event_id: routed.event_id,
      route: action,
      reversible: true,
      intent_id: intent?.intent_id || targetIntentId || "",
      context_packet: packet,
      confirmation: intent ? `Message routed to intent ${intent.intent_id}` : "Message captured",
    };
  }

  async function claim(intentId, input = {}) {
    const safeIntentId = requireBoundedText(intentId, MAX_TEXT.id, "intent_id");
    const rawKey = input.idempotency_key || input.idempotencyKey || "claim";
    const claimKey = namespaceIdempotencyKey(safeIntentId, "run_claimed", rawKey);
    if (await readIdempotentEvent(claimKey)) {
      return rehydrateIntent(events, safeIntentId, input.limits || {});
    }
    const agentId = requireBoundedText(input.agent_id || input.agentId, MAX_TEXT.id, "agent_id");
    const runId = requireBoundedText(input.run_id || input.runId, MAX_TEXT.id, "run_id");
    const leaseSeconds = Math.max(60, Math.min(Number(input.lease_seconds || input.leaseSeconds || 900), 86_400));
    const leaseExpiresAt = new Date(Date.parse(currentIsoTime()) + leaseSeconds * 1_000).toISOString();
    return appendIntentEvent(safeIntentId, input, "intent.run_claimed", {
      agent_id: agentId,
      run_id: runId,
      lease_expires_at: leaseExpiresAt,
    });
  }

  async function recordProgress(intentId, input = {}) {
    const progress = text(input.progress, MAX_TEXT.note);
    const nextStep = text(input.next_step || input.nextStep, MAX_TEXT.note);
    const blockers = Array.isArray(input.blockers) ? input.blockers : [];
    const evidenceRefs = normalizeRefs(input.evidence_refs || input.evidenceRefs);
    const artifactRefs = normalizeRefs(input.artifact_refs || input.artifactRefs);
    if (!progress && !nextStep && !blockers.length && !evidenceRefs.length && !artifactRefs.length) {
      throw new Error("progress update must contain a meaningful change");
    }
    return appendIntentEvent(intentId, input, "intent.progress_recorded", {
      agent_id: requireBoundedText(input.agent_id || input.agentId, MAX_TEXT.id, "agent_id"),
      run_id: requireBoundedText(input.run_id || input.runId, MAX_TEXT.id, "run_id"),
      progress,
      next_step: nextStep,
      blockers,
      evidence_refs: evidenceRefs,
      artifact_refs: artifactRefs,
    });
  }

  async function notify(intentId, input = {}) {
    const notificationId = requireBoundedText(
      input.notification_id || input.notificationId,
      MAX_TEXT.id,
      "notification_id",
    );
    return appendIntentEvent(intentId, input, "intent.notification_created", {
      notification_id: notificationId,
      run_id: requireBoundedText(input.run_id || input.runId, MAX_TEXT.id, "run_id"),
      kind: text(input.kind || "agent_run_result", 80),
      status: "pending",
      summary: requireBoundedText(input.summary, MAX_TEXT.note, "summary"),
    });
  }

  async function neglected(input = {}) {
    const result = await list({
      project_id: input.project_id || input.projectId || "",
      lifecycle_state: input.lifecycle_state || input.lifecycleState || "active",
      limit: input.limit || 100,
    });
    const threshold = Number(input.before_ms || input.beforeMs || Date.now());
    const items = (result.items || []).filter((intent) => {
      const lease = Date.parse(intent.run_lease_expires_at || "");
      return !intent.current_run_id || !Number.isFinite(lease) || lease < threshold;
    });
    return { ...result, items, neglected_count: items.length };
  }

  return {
    capture,
    transition,
    connect,
    pushFocus,
    completeTransactional,
    popFocus,
    get,
    list,
    rehydrate,
    contextPacket,
    recordSource,
    history,
    launch,
    ingestMessage,
    claim,
    recordProgress,
    notify,
    neglected,
    limits: {
      list_page_size: 500,
      default_rehydrate_event_limit: MAX_MUTATION_EVENT_LIMIT,
    },
  };
}

module.exports = {
  createIntentRuntime,
  stableJson,
  sameEventShape,
  intentStreamId,
};
