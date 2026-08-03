"use strict";

const crypto = require("node:crypto");

const STREAM_ID = "development:integration-queue";
const PREFIX = "development.integration.";

function text(value, label, max = 160) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${label} is required`);
  if (result.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return result;
}

function entryId(intentId, taskId) {
  return `integration_${crypto.createHash("sha256").update(`${intentId}\n${taskId}`).digest("hex").slice(0, 24)}`;
}

function project(events, nowMs) {
  const entries = new Map();
  let version = 0;
  for (const event of events) {
    const payload = event.payload || {};
    let entry = entries.get(payload.entry_id);
    if (event.event_type === "development.integration.queued") {
      entry = { entry_id: payload.entry_id, intent_id: payload.intent_id, task_id: payload.task_id, state: "queued", queued_at: event.occurred_at, lease_id: "", lease_expires_at: "", run_id: "", outcome: "" };
      entries.set(entry.entry_id, entry);
    } else if (entry && event.event_type === "development.integration.claimed") {
      Object.assign(entry, { state: "claimed", lease_id: payload.lease_id, lease_expires_at: payload.lease_expires_at, run_id: payload.run_id || "" });
    } else if (entry && event.event_type === "development.integration.released") {
      Object.assign(entry, { state: payload.outcome === "dispatch-failed" ? "queued" : "released", outcome: payload.outcome, lease_id: "", lease_expires_at: "", run_id: "" });
    }
    version = Number(event.stream_version || version);
  }
  const rows = [...entries.values()].sort((a, b) => a.queued_at.localeCompare(b.queued_at));
  for (const entry of rows) {
    if (entry.state === "claimed" && Date.parse(entry.lease_expires_at) <= nowMs) {
      Object.assign(entry, { state: "queued", lease_id: "", lease_expires_at: "", run_id: "" });
    }
  }
  return { version, entries: rows, active: rows.find((entry) => entry.state === "claimed") || null };
}

function createDevelopmentIntegrationQueue({ events, now = () => new Date(), leaseMs = 30 * 60_000 } = {}) {
  if (!events?.appendEvent || !events?.listEvents || !events?.withStreamLock) throw new Error("integration queue requires an event substrate");
  const safeLeaseMs = Math.max(60_000, Math.min(Number(leaseMs) || 30 * 60_000, 24 * 60 * 60_000));

  async function read() {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const page = await events.listEvents({ stream_id: STREAM_ID, order: "asc", offset, limit: 500 });
      rows.push(...page.filter((event) => event.event_type.startsWith(PREFIX)));
      if (page.length < 500) return project(rows, now().getTime());
    }
  }

  async function append(type, payload, key, expectedVersion) {
    return events.appendEvent({
      stream_id: STREAM_ID,
      event_type: type,
      occurred_at: now().toISOString(),
      actor: { kind: "gateway", id: "development-integration-queue" },
      authority: { boundary: "master-integration", execution: "single-lease" },
      correlation_id: payload.intent_id,
      idempotency_key: `development-integration:${key}`,
      expected_stream_version: expectedVersion,
      payload,
    });
  }

  async function enqueue(intentInput, taskInput) {
    const intentId = text(intentInput, "intent_id");
    const taskId = text(taskInput, "task_id");
    const id = entryId(intentId, taskId);
    return events.withStreamLock(STREAM_ID, async () => {
      const state = await read();
      const existing = state.entries.find((entry) => entry.entry_id === id);
      if (existing) return existing;
      await append("development.integration.queued", { entry_id: id, intent_id: intentId, task_id: taskId }, `queue:${id}`, state.version);
      return (await read()).entries.find((entry) => entry.entry_id === id);
    });
  }

  async function claim(intentInput, taskInput) {
    const intentId = text(intentInput, "intent_id");
    const taskId = text(taskInput, "task_id");
    const id = entryId(intentId, taskId);
    return events.withStreamLock(STREAM_ID, async () => {
      const state = await read();
      const entry = state.entries.find((item) => item.entry_id === id);
      if (!entry) throw new Error("integration task is not queued");
      if (entry.state === "claimed") return { acquired: true, entry };
      if (entry.state === "released") return { acquired: false, entry };
      const first = state.entries.find((item) => item.state === "queued");
      if (state.active || first?.entry_id !== id) return { acquired: false, entry };
      const leaseId = `lease_${crypto.randomUUID()}`;
      const leaseExpiresAt = new Date(now().getTime() + safeLeaseMs).toISOString();
      await append("development.integration.claimed", { entry_id: id, intent_id: intentId, task_id: taskId, lease_id: leaseId, lease_expires_at: leaseExpiresAt }, `claim:${id}:${leaseId}`, state.version);
      return { acquired: true, entry: (await read()).entries.find((item) => item.entry_id === id) };
    });
  }

  async function bindRun(intentInput, taskInput, runInput) {
    const intentId = text(intentInput, "intent_id");
    const taskId = text(taskInput, "task_id");
    const runId = text(runInput, "run_id");
    const id = entryId(intentId, taskId);
    return events.withStreamLock(STREAM_ID, async () => {
      const state = await read();
      const entry = state.entries.find((item) => item.entry_id === id);
      if (!entry || entry.state !== "claimed") throw new Error("integration lease is not active");
      if (entry.run_id === runId) return entry;
      if (entry.run_id) throw new Error("integration lease already has a different run");
      await append("development.integration.claimed", { entry_id: id, intent_id: intentId, task_id: taskId, lease_id: entry.lease_id, lease_expires_at: entry.lease_expires_at, run_id: runId }, `bind:${id}:${runId}`, state.version);
      return (await read()).entries.find((item) => item.entry_id === id);
    });
  }

  async function release(intentInput, taskInput, outcomeInput) {
    const intentId = text(intentInput, "intent_id");
    const taskId = text(taskInput, "task_id");
    const outcome = text(outcomeInput, "outcome", 40);
    const id = entryId(intentId, taskId);
    return events.withStreamLock(STREAM_ID, async () => {
      const state = await read();
      const entry = state.entries.find((item) => item.entry_id === id);
      if (!entry) throw new Error("integration task is not queued");
      if (entry.state === "released") return entry;
      if (entry.state !== "claimed") throw new Error("integration lease is not active");
      await append("development.integration.released", { entry_id: id, intent_id: intentId, task_id: taskId, outcome }, `release:${id}:${outcome}`, state.version);
      return (await read()).entries.find((item) => item.entry_id === id);
    });
  }

  return { read, enqueue, claim, bindRun, release };
}

module.exports = { createDevelopmentIntegrationQueue, entryId, project, STREAM_ID };
