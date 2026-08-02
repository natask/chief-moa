"use strict";

const crypto = require("node:crypto");

const REMINDER_CREATED = "reminder.created";
const REMINDER_DUE = "reminder.due";
const REMINDER_CANCELED = "reminder.canceled";
const PAGE_SIZE = 500;
const MAX_EVENT_SCAN = 10_000;
const MAX_LIST_LIMIT = 100;

class ReminderError extends Error {
  constructor(message, code = "validation") {
    super(message);
    this.name = "ReminderError";
    this.code = code;
  }
}

function createReminderStore({ events, now = () => Date.now() } = {}) {
  if (!events || typeof events.appendEvent !== "function" || typeof events.listEvents !== "function") {
    throw new Error("reminder store requires an event substrate");
  }

  async function create(input = {}) {
    assertInternalReminder(input);
    const userId = requiredText(input.user_id || input.userId, "user_id", 160);
    const message = requiredText(input.message || input.text || input.title, "message", 2000);
    const dueAt = normalizeDueAt(input, now());
    const scheduleRequest = normalizedScheduleRequest(input, dueAt);
    const requestKey = optionalText(input.idempotency_key || input.idempotencyKey, 240);
    const id = requestKey
      ? deterministicReminderId(userId, requestKey)
      : `rem_${crypto.randomBytes(16).toString("hex")}`;
    const createdAt = new Date(now()).toISOString();
    const reminder = {
      schema_version: 1,
      id,
      user_id: userId,
      message,
      due_at: dueAt,
      schedule_request: scheduleRequest,
      status: "scheduled",
      delivery: {
        status: "not_configured",
        reason: "No reminder notification capability is registered on a client surface.",
      },
      source: normalizeSource(input.source),
      created_at: createdAt,
      updated_at: createdAt,
    };
    const event = await events.appendEvent({
      event_type: REMINDER_CREATED,
      event_schema_version: 1,
      stream_id: reminderStreamId(id),
      occurred_at: createdAt,
      actor: { kind: "user", id: userId },
      authority: { boundary: "gateway-reminder", execution: "none", delivery: "not_configured" },
      correlation_id: optionalText(input.correlation_id || input.correlationId, 240),
      idempotency_key: requestKey ? `reminder:create:${userId}:${requestKey}` : `reminder:create:${id}`,
      payload: reminder,
    });
    if (!sameCreation(event.payload, reminder)) {
      throw new ReminderError("idempotency_key is already bound to a different reminder", "conflict");
    }
    return get(userId, event.payload.id, { advanceDue: true });
  }

  async function get(userIdInput, reminderIdInput, options = {}) {
    const userId = requiredText(userIdInput, "user_id", 160);
    const reminderId = normalizeReminderId(reminderIdInput);
    let reminder = await readReminder(reminderId);
    if (!reminder || reminder.user_id !== userId) return null;
    if (options.advanceDue !== false && shouldBecomeDue(reminder, now())) {
      reminder = await markDue(userId, reminderId);
    }
    return reminder;
  }

  async function list(userIdInput, filters = {}) {
    const userId = requiredText(userIdInput, "user_id", 160);
    const status = optionalText(filters.status, 40).toLowerCase();
    if (status && !["scheduled", "due", "canceled"].includes(status)) {
      throw new ReminderError("status must be scheduled, due, or canceled");
    }
    await sweepDue(userId);
    const createdEvents = await listEventsByType(REMINDER_CREATED);
    const limit = integerInRange(filters.limit, 50, 1, MAX_LIST_LIMIT);
    const offset = integerInRange(filters.offset, 0, 0, MAX_EVENT_SCAN);
    const reminders = [];
    for (const event of createdEvents) {
      if (event.payload?.user_id !== userId || !event.payload?.id) continue;
      const reminder = await readReminder(event.payload.id);
      if (reminder && (!status || reminder.status === status)) reminders.push(reminder);
    }
    reminders.sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)) || String(a.id).localeCompare(String(b.id)));
    return {
      items: reminders.slice(offset, offset + limit),
      offset,
      limit,
      has_more: offset + limit < reminders.length,
    };
  }

  async function cancel(userIdInput, reminderIdInput) {
    const userId = requiredText(userIdInput, "user_id", 160);
    const reminderId = normalizeReminderId(reminderIdInput);
    return events.withStreamLock(reminderStreamId(reminderId), async () => {
      const current = await readReminder(reminderId);
      if (!current || current.user_id !== userId) return null;
      if (current.status === "canceled") return current;
      const timestamp = new Date(now()).toISOString();
      await events.appendEvent({
        event_type: REMINDER_CANCELED,
        event_schema_version: 1,
        stream_id: reminderStreamId(reminderId),
        occurred_at: timestamp,
        actor: { kind: "user", id: userId },
        authority: { boundary: "gateway-reminder", execution: "none" },
        idempotency_key: `reminder:cancel:${reminderId}`,
        payload: { reminder_id: reminderId, user_id: userId, canceled_at: timestamp },
      });
      return readReminder(reminderId);
    });
  }

  async function sweepDue(userIdInput = "") {
    const userId = optionalText(userIdInput, 160);
    const createdEvents = await listEventsByType(REMINDER_CREATED);
    let markedDue = 0;
    for (const event of createdEvents) {
      const reminder = event.payload;
      if (!reminder?.id || (userId && reminder.user_id !== userId)) continue;
      const current = await readReminder(reminder.id);
      if (!shouldBecomeDue(current, now())) continue;
      const updated = await markDue(current.user_id, current.id);
      if (updated?.status === "due") markedDue += 1;
    }
    return { marked_due: markedDue };
  }

  async function markDue(userId, reminderId) {
    return events.withStreamLock(reminderStreamId(reminderId), async () => {
      const current = await readReminder(reminderId);
      if (!current || current.user_id !== userId || !shouldBecomeDue(current, now())) return current;
      const timestamp = new Date(now()).toISOString();
      await events.appendEvent({
        event_type: REMINDER_DUE,
        event_schema_version: 1,
        stream_id: reminderStreamId(reminderId),
        occurred_at: timestamp,
        actor: { kind: "gateway", id: "reminder-scheduler" },
        authority: { boundary: "gateway-reminder", execution: "none", delivery: "not_configured" },
        idempotency_key: `reminder:due:${reminderId}`,
        payload: {
          reminder_id: reminderId,
          user_id: userId,
          due_at: current.due_at,
          became_due_at: timestamp,
          delivery: current.delivery,
        },
      });
      return readReminder(reminderId);
    });
  }

  async function readReminder(reminderId) {
    const rows = await events.listEvents({
      stream_id: reminderStreamId(reminderId),
      order: "asc",
      limit: 100,
    });
    const created = rows.find((event) => event.event_type === REMINDER_CREATED);
    if (!created?.payload) return null;
    const reminder = { ...created.payload };
    for (const event of rows) {
      if (event.event_type === REMINDER_DUE) {
        reminder.status = "due";
        reminder.became_due_at = event.payload?.became_due_at || event.occurred_at;
        reminder.updated_at = event.occurred_at;
      } else if (event.event_type === REMINDER_CANCELED) {
        reminder.status = "canceled";
        reminder.canceled_at = event.payload?.canceled_at || event.occurred_at;
        reminder.updated_at = event.occurred_at;
      }
    }
    return reminder;
  }

  async function listEventsByType(eventType) {
    const output = [];
    for (let offset = 0; offset < MAX_EVENT_SCAN; offset += PAGE_SIZE) {
      const page = await events.listEvents({ event_type: eventType, order: "desc", offset, limit: PAGE_SIZE });
      output.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return output;
  }

  return Object.freeze({ create, get, list, cancel, sweepDue });
}

function assertInternalReminder(input) {
  const kind = optionalText(input.kind, 40).toLowerCase();
  if (kind && kind !== "internal") {
    throw new ReminderError("external timer or reminder apps require a separate explicit device-local action");
  }
  if (input.timer_app || input.external_app || input.app_name) {
    throw new ReminderError("named timer or reminder apps require a separate explicit device-local action");
  }
}

function normalizeDueAt(input, nowMs) {
  const hasDueAt = input.due_at !== undefined || input.dueAt !== undefined;
  const hasDelay = input.delay_seconds !== undefined || input.delaySeconds !== undefined;
  if (hasDueAt === hasDelay) throw new ReminderError("provide exactly one of due_at or delay_seconds");
  if (hasDelay) {
    const seconds = Number(input.delay_seconds ?? input.delaySeconds);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 31_536_000) {
      throw new ReminderError("delay_seconds must be between 0 and 31536000");
    }
    return new Date(nowMs + Math.round(seconds * 1000)).toISOString();
  }
  const raw = String(input.due_at ?? input.dueAt).trim();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || !/(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new ReminderError("due_at must be an ISO 8601 timestamp with an explicit timezone");
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw new ReminderError("due_at is invalid");
  return new Date(timestamp).toISOString();
}

function normalizedScheduleRequest(input, dueAt) {
  if (input.delay_seconds !== undefined || input.delaySeconds !== undefined) {
    return { kind: "delay_seconds", value: Number(input.delay_seconds ?? input.delaySeconds) };
  }
  return { kind: "due_at", value: dueAt };
}

function sameCreation(actual, expected) {
  return actual?.id === expected.id
    && actual.user_id === expected.user_id
    && actual.message === expected.message
    && actual.schedule_request?.kind === expected.schedule_request.kind
    && actual.schedule_request?.value === expected.schedule_request.value;
}

function normalizeSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    surface: optionalText(value.surface || value.source_surface, 80),
    session_id: optionalText(value.session_id || value.conversation_id, 160),
    branch_id: optionalText(value.branch_id, 160),
    turn_id: optionalText(value.turn_id, 160),
  };
}

function shouldBecomeDue(reminder, nowMs) {
  return reminder?.status === "scheduled" && Date.parse(reminder.due_at || "") <= nowMs;
}

function reminderStreamId(id) {
  return `reminder:${normalizeReminderId(id)}`;
}

function normalizeReminderId(value) {
  const id = String(value || "").trim();
  if (!/^rem_[a-f0-9]{32}$/.test(id)) throw new ReminderError("invalid reminder id");
  return id;
}

function deterministicReminderId(userId, key) {
  return `rem_${crypto.createHash("sha256").update(`${userId}\0${key}`).digest("hex").slice(0, 32)}`;
}

function requiredText(value, label, maxLength) {
  const result = optionalText(value, maxLength);
  if (!result) throw new ReminderError(`${label} is required`);
  return result;
}

function optionalText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function integerInRange(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ReminderError(`value must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

module.exports = {
  REMINDER_CANCELED,
  REMINDER_CREATED,
  REMINDER_DUE,
  ReminderError,
  createReminderStore,
  assertInternalReminder,
  normalizeDueAt,
  normalizeReminderId,
};
