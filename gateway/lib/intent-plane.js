"use strict";

const crypto = require("node:crypto");

const EVENT_TYPES = Object.freeze([
  "intent_plane.intent.created",
  "intent_plane.intent.updated",
  "intent_plane.agent.registered",
  "intent_plane.agent.progressed",
  "intent_plane.notification.created",
  "intent_plane.notification.received",
]);
const INTENT_STATUSES = new Set(["admitted", "active", "blocked", "needs_user", "completed", "cancelled"]);
const AGENT_STATUSES = new Set(["registered", "running", "blocked", "completed", "failed", "cancelled"]);
const SENSITIVITIES = new Set(["normal", "sensitive", "restricted"]);

function clean(value, max = 2_000) {
  const result = String(value || "").trim();
  if (result.length > max) throw new Error(`value exceeds ${max} characters`);
  return result;
}

function required(value, label, max = 2_000) {
  const result = clean(value, max);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeMetadata(value, label) {
  const object = plainObject(value);
  const serialized = JSON.stringify(object);
  if (serialized.length > 4_000) throw new Error(`${label} exceeds 4000 characters`);
  const forbidden = /password|passwd|secret|token|credential|cookie|authorization|api[_-]?key/i;
  const visit = (item) => {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.test(key)) throw new Error(`${label} must not contain credentials`);
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(object);
  return JSON.parse(serialized);
}

function texts(value, maxItems = 40) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, 400)).filter(Boolean))].slice(0, maxItems);
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function streamId(kind, id) {
  return `intent-plane:${kind}:${id}`;
}

function reduce(events) {
  const intents = new Map();
  const agents = new Map();
  const notifications = new Map();
  for (const event of events) {
    const payload = plainObject(event.payload);
    if (event.event_type === "intent_plane.intent.created") {
      intents.set(payload.intent_id, { ...payload, version: event.stream_version, created_at: event.occurred_at, updated_at: event.occurred_at });
    } else if (event.event_type === "intent_plane.intent.updated") {
      const current = intents.get(payload.intent_id);
      if (current) intents.set(payload.intent_id, { ...current, ...payload, version: event.stream_version, updated_at: event.occurred_at });
    } else if (event.event_type === "intent_plane.agent.registered") {
      agents.set(payload.agent_id, { ...payload, version: event.stream_version, created_at: event.occurred_at, updated_at: event.occurred_at });
    } else if (event.event_type === "intent_plane.agent.progressed") {
      const current = agents.get(payload.agent_id);
      if (current) agents.set(payload.agent_id, { ...current, ...payload, version: event.stream_version, updated_at: event.occurred_at });
    } else if (event.event_type === "intent_plane.notification.created") {
      notifications.set(payload.notification_id, { ...payload, version: event.stream_version, created_at: event.occurred_at, updated_at: event.occurred_at });
    } else if (event.event_type === "intent_plane.notification.received") {
      const current = notifications.get(payload.notification_id);
      if (current) notifications.set(payload.notification_id, { ...current, receipt_state: "received", receipt: payload.receipt, version: event.stream_version, updated_at: event.occurred_at });
    }
  }
  return { intents, agents, notifications };
}

function createIntentPlane({ events, now = () => new Date().toISOString(), idFactory = makeId } = {}) {
  if (!events?.appendEvent || !events?.listEvents) throw new Error("intent plane requires the event substrate");

  async function allEvents() {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const page = await events.listEvents({ event_type_prefix: "intent_plane.", order: "asc", limit: 500, offset });
      rows.push(...page.filter((event) => EVENT_TYPES.includes(event.event_type)));
      if (page.length < 500) return rows;
    }
  }

  async function state() {
    return reduce(await allEvents());
  }

  async function append(kind, id, type, payload, key, expectedVersion) {
    return events.appendEvent({
      stream_id: streamId(kind, id),
      event_type: type,
      occurred_at: now(),
      actor: { kind: "gateway", id: "intent-plane" },
      authority: { boundary: "intent-plane", execution: "none" },
      correlation_id: payload.intent_id || id,
      idempotency_key: required(key, "idempotency_key", 240),
      expected_stream_version: expectedVersion,
      payload,
    });
  }

  async function createIntent(input = {}) {
    if (input.user_confirmed !== true) throw new Error("user_confirmed must be true; inferred intentions require confirmation");
    const intentId = clean(input.intent_id, 160) || idFactory("intent");
    const current = await state();
    if (current.intents.has(intentId)) return current.intents.get(intentId);
    const status = clean(input.status, 40) || "admitted";
    const sensitivity = clean(input.sensitivity, 40) || "normal";
    if (!INTENT_STATUSES.has(status)) throw new Error("unsupported intent status");
    if (!SENSITIVITIES.has(sensitivity)) throw new Error("unsupported sensitivity");
    const payload = {
      intent_id: intentId,
      title: required(input.title, "title", 240),
      objective: required(input.objective, "objective"),
      status,
      source: safeMetadata(input.source, "source"),
      provenance: safeMetadata(input.provenance, "provenance"),
      sensitivity,
      owner_agent_id: clean(input.owner_agent_id, 160),
      next_action: clean(input.next_action),
      artifact_refs: texts(input.artifact_refs),
      user_confirmed: true,
    };
    await append("intent", intentId, EVENT_TYPES[0], payload, input.idempotency_key || `intent-plane:create:${intentId}`, 0);
    return (await state()).intents.get(intentId);
  }

  async function updateIntent(intentId, input = {}) {
    const current = (await state()).intents.get(intentId);
    if (!current) throw new Error("intent not found");
    const status = clean(input.status, 40) || current.status;
    if (!INTENT_STATUSES.has(status)) throw new Error("unsupported intent status");
    const payload = {
      intent_id: intentId,
      status,
      title: clean(input.title, 240) || current.title,
      objective: clean(input.objective) || current.objective,
      owner_agent_id: input.owner_agent_id === undefined ? current.owner_agent_id : clean(input.owner_agent_id, 160),
      next_action: input.next_action === undefined ? current.next_action : clean(input.next_action),
      artifact_refs: input.artifact_refs === undefined ? current.artifact_refs : texts(input.artifact_refs),
    };
    await append("intent", intentId, EVENT_TYPES[1], payload, input.idempotency_key || `intent-plane:update:${intentId}:${current.version + 1}`, current.version);
    if ((status === "completed" || status === "needs_user") && current.status !== status) {
      await createNotification({
        intent_id: intentId,
        kind: status,
        title: status === "completed" ? `Completed: ${payload.title}` : `Needs you: ${payload.title}`,
        message: payload.next_action || payload.objective,
        idempotency_key: `intent-plane:notification:${intentId}:${status}`,
      });
    }
    return (await state()).intents.get(intentId);
  }

  async function registerAgent(input = {}) {
    const currentState = await state();
    const intentId = required(input.intent_id, "intent_id", 160);
    if (!currentState.intents.has(intentId)) throw new Error("intent not found");
    const agentId = clean(input.agent_id, 160) || idFactory("agent");
    if (currentState.agents.has(agentId)) return currentState.agents.get(agentId);
    const payload = {
      agent_id: agentId,
      intent_id: intentId,
      launch_reason: required(input.launch_reason, "launch_reason", 800),
      launcher_provenance: safeMetadata(input.launcher_provenance, "launcher_provenance"),
      capabilities: texts(input.capabilities),
      authority_summary: clean(input.authority_summary, 800),
      status: "registered",
      last_progress: "",
      current_run_id: clean(input.current_run_id, 160),
      latest_recap: clean(input.latest_recap),
      registration_mode: clean(input.registration_mode, 40) || "manual",
    };
    await append("agent", agentId, EVENT_TYPES[2], payload, input.idempotency_key || `intent-plane:register:${agentId}`, 0);
    return (await state()).agents.get(agentId);
  }

  async function progressAgent(agentId, input = {}) {
    const current = (await state()).agents.get(agentId);
    if (!current) throw new Error("agent not found");
    const status = clean(input.status, 40) || current.status;
    if (!AGENT_STATUSES.has(status)) throw new Error("unsupported agent status");
    const payload = {
      agent_id: agentId,
      intent_id: current.intent_id,
      status,
      last_progress: required(input.progress || input.last_progress, "progress"),
      current_run_id: input.current_run_id === undefined ? current.current_run_id : clean(input.current_run_id, 160),
      latest_recap: input.latest_recap === undefined ? current.latest_recap : clean(input.latest_recap),
      artifact_refs: texts(input.artifact_refs),
    };
    await append("agent", agentId, EVENT_TYPES[3], payload, input.idempotency_key || `intent-plane:progress:${agentId}:${current.version + 1}`, current.version);
    return (await state()).agents.get(agentId);
  }

  async function createNotification(input = {}) {
    const currentState = await state();
    const notificationId = clean(input.notification_id, 160) || idFactory("notification");
    const existing = [...currentState.notifications.values()].find((item) => item.idempotency_key === input.idempotency_key);
    if (existing) return existing;
    const payload = {
      notification_id: notificationId,
      intent_id: required(input.intent_id, "intent_id", 160),
      kind: required(input.kind, "kind", 40),
      title: required(input.title, "title", 240),
      message: clean(input.message),
      receipt_state: "pending",
      receipt: null,
      idempotency_key: required(input.idempotency_key || `intent-plane:notification:${notificationId}`, "idempotency_key", 240),
    };
    await append("notification", notificationId, EVENT_TYPES[4], payload, payload.idempotency_key, 0);
    return (await state()).notifications.get(notificationId);
  }

  async function receiveNotification(notificationId, input = {}) {
    const current = (await state()).notifications.get(notificationId);
    if (!current) throw new Error("notification not found");
    if (current.receipt_state === "received") return current;
    await append("notification", notificationId, EVENT_TYPES[5], {
      notification_id: notificationId,
      intent_id: current.intent_id,
      receipt: { actor: clean(input.actor, 160) || "user", note: clean(input.note, 800), at: now() },
    }, input.idempotency_key || `intent-plane:receipt:${notificationId}`, current.version);
    return (await state()).notifications.get(notificationId);
  }

  async function projection(filters = {}) {
    const current = await state();
    const intents = [...current.intents.values()].filter((item) => !filters.status || item.status === filters.status);
    const intentIds = new Set(intents.map((item) => item.intent_id));
    return {
      schema: "moa.intent-plane.v1",
      intents,
      agents: [...current.agents.values()].filter((item) => intentIds.has(item.intent_id)),
      notifications: [...current.notifications.values()].filter((item) => intentIds.has(item.intent_id)),
      authority: { inferred_intents_require_user_confirmation: true, external_actions: "none" },
    };
  }

  async function explain(intentId) {
    const view = await projection();
    const intent = view.intents.find((item) => item.intent_id === intentId);
    if (!intent) return null;
    const agents = view.agents.filter((item) => item.intent_id === intentId);
    return {
      schema: view.schema,
      intent,
      agents,
      runs: agents.filter((item) => item.current_run_id).map((item) => ({ agent_id: item.agent_id, run_id: item.current_run_id })),
      artifacts: [...new Set([...(intent.artifact_refs || []), ...agents.flatMap((item) => item.artifact_refs || [])])],
      notifications: view.notifications.filter((item) => item.intent_id === intentId),
      explanation: "Intent owns registered agents; agent progress names the current run; intent and progress events carry artifact references.",
    };
  }

  return { createIntent, updateIntent, registerAgent, progressAgent, createNotification, receiveNotification, projection, explain };
}

module.exports = { createIntentPlane, intentPlaneEventTypes: EVENT_TYPES };
