"use strict";

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
} = require("./intent-runtime-rehydration");

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

  async function streamOccupancy(intentId) {
    return events.listEvents({ stream_id: intentStreamId(intentId), order: "asc", offset: 0, limit: 1 });
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
