"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createReminderStore } = require("../lib/reminders");
const { createReminderDeliveryCoordinator } = require("../lib/reminder-delivery");

function eventStore() {
  const rows = [];
  return {
    rows,
    appendEvent: async (event) => {
      const existing = rows.find((row) => row.idempotency_key === event.idempotency_key);
      if (existing) return existing;
      const row = { id: `evt_${rows.length + 1}`, stream_version: rows.length + 1, ...event };
      rows.push(row);
      return row;
    },
    listEvents: async (filter = {}) => {
      let result = rows.filter((row) => !filter.event_type || row.event_type === filter.event_type)
        .filter((row) => !filter.stream_id || row.stream_id === filter.stream_id);
      if (filter.order === "desc") result = result.slice().reverse();
      return result.slice(filter.offset || 0, (filter.offset || 0) + (filter.limit || 100));
    },
    withStreamLock: async (_streamId, action) => action(),
  };
}

test("due reminder queues once and projects a bound displayed receipt", async () => {
  let now = Date.parse("2026-08-02T20:00:00.000Z");
  const events = eventStore();
  const reminders = createReminderStore({ events, now: () => now });
  const reminder = await reminders.create({
    user_id: "user_1", message: "Take a break", delay_seconds: 0,
    idempotency_key: "break",
  });
  const requests = [];
  const coordinator = createReminderDeliveryCoordinator({
    reminders,
    deviceClientsForTool: () => [{ device_id: "phone_1" }],
    createToolRequest: (body) => {
      const existing = requests.find((item) => item.idempotency_key === body.idempotency_key);
      if (existing) return existing;
      const request = { id: "treq_1", status: "pending", ...body };
      requests.push(request);
      return request;
    },
    recordToolRequestProductEvent: async () => {},
  });

  assert.equal(reminder.status, "due");
  assert.deepEqual(await coordinator.deliverDue(), { due: 1, queued: 1 });
  assert.deepEqual(await coordinator.deliverDue(), { due: 0, queued: 0 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tool, "notification.reminder");

  await coordinator.recordToolReceipt(
    { ...requests[0], claimed_by: "phone_1" },
    { ok: true, device_id: "phone_1", summary: "Displayed due Ag reminder." },
  );
  const delivered = await reminders.get("user_1", reminder.id);
  assert.equal(delivered.delivery.status, "displayed");
  assert.equal(delivered.delivery.tool_request_id, "treq_1");

  now += 10_000;
  await coordinator.recordToolReceipt(
    { ...requests[0], claimed_by: "phone_1" },
    { ok: true, device_id: "phone_1", summary: "replay" },
  );
  assert.equal(events.rows.filter((row) => row.event_type === "reminder.delivery_receipted").length, 1);
});

test("delivery stays not configured without exactly one opted-in Android target", async () => {
  const events = eventStore();
  const reminders = createReminderStore({
    events, now: () => Date.parse("2026-08-02T20:00:00.000Z"),
  });
  const reminder = await reminders.create({
    user_id: "user_1", message: "Ambiguous", delay_seconds: 0,
  });
  for (const candidates of [[], [{ device_id: "one" }, { device_id: "two" }]]) {
    const coordinator = createReminderDeliveryCoordinator({
      reminders,
      deviceClientsForTool: () => candidates,
      createToolRequest: () => { throw new Error("must not queue"); },
    });
    assert.deepEqual(await coordinator.deliverDue(), { due: 1, queued: 0 });
  }
  assert.equal((await reminders.get("user_1", reminder.id)).delivery.status, "not_configured");
});

test("failed Android receipt is projected without claiming display", async () => {
  const events = eventStore();
  const reminders = createReminderStore({
    events, now: () => Date.parse("2026-08-02T20:00:00.000Z"),
  });
  const reminder = await reminders.create({ user_id: "user_1", message: "Denied", delay_seconds: 0 });
  const coordinator = createReminderDeliveryCoordinator({
    reminders,
    deviceClientsForTool: () => [{ device_id: "phone_1" }],
    createToolRequest: (body) => ({ id: "treq_failed", ...body }),
  });
  await coordinator.deliverDue();
  await coordinator.recordToolReceipt({
    id: "treq_failed", tool: "notification.reminder", target_device_id: "phone_1",
    input: { reminder_id: reminder.id },
  }, { ok: false, device_id: "phone_1", error: "notifications_unavailable" });
  assert.equal((await reminders.get("user_1", reminder.id)).delivery.status, "failed");
});
