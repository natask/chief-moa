"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventSubstrateStore } = require("../lib/event-substrate");
const { MAX_RECENT_PROGRESS, createDevelopmentRequestStore } = require("../lib/development-requests");

const owner = { tenant_id: "tenant_one", user_id: "user_one" };
const otherUser = { tenant_id: "tenant_one", user_id: "user_two" };
const otherTenant = { tenant_id: "tenant_two", user_id: "user_one" };

function harness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "development-requests-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let sequence = 0;
  let clock = 0;
  const events = createEventSubstrateStore({ dataDir, originId: "test" });
  const store = createDevelopmentRequestStore({
    events,
    idFactory: () => `devreq_${++sequence}`,
    now: () => new Date(Date.UTC(2026, 7, 14, 0, 0, ++clock)).toISOString(),
  });
  return { events, store };
}

function request(overrides = {}) {
  return {
    idempotency_key: "phone-submit-1",
    display_name: "Repair mobile voice",
    source_text: "The voice pipeline starts and then stops.",
    project_id: "chief-moa",
    project_binding_evidence_ref: "repo://chief-moa/master",
    provenance: {
      kind: "voice",
      surface: "android",
      session_id: "session_1",
      turn_id: "turn_1",
      capture_ref: "capture://voice/1",
    },
    ...overrides,
  };
}

test("create is tenant/user idempotent and preserves immutable source and project binding", async (t) => {
  const { store } = harness(t);
  const first = await store.create(owner, request());
  const replay = await store.create(owner, request());
  assert.equal(first.request_id, replay.request_id);
  assert.equal(replay.source_text, request().source_text);
  assert.deepEqual(replay.project, { project_id: "chief-moa", binding_evidence_ref: "repo://chief-moa/master" });
  assert.deepEqual(replay.provenance, {
    kind: "voice", surface: "android", session_id: "session_1", turn_id: "turn_1", capture_ref: "capture://voice/1",
  });

  await assert.rejects(store.create(owner, request({ source_text: "different" })), (error) => error.code === "idempotency_collision");
  const [raceOne, raceTwo] = await Promise.all([
    store.create(owner, request({ idempotency_key: "simultaneous-submit" })),
    store.create(owner, request({ idempotency_key: "simultaneous-submit" })),
  ]);
  assert.equal(raceOne.request_id, raceTwo.request_id);
  const separateOwner = await store.create(otherUser, request());
  assert.notEqual(first.request_id, separateOwner.request_id);
});

test("only display name is editable and reads fail closed across owner boundaries", async (t) => {
  const { store } = harness(t);
  const created = await store.create(owner, request());
  const renamed = await store.rename(owner, created.request_id, { display_name: "Restore voice and release rescue", idempotency_key: "rename-1" });
  assert.equal(renamed.display_name, "Restore voice and release rescue");
  assert.equal(renamed.source_text, created.source_text);
  assert.deepEqual(renamed.project, created.project);
  assert.deepEqual(renamed.provenance, created.provenance);

  for (const stranger of [otherUser, otherTenant]) {
    await assert.rejects(store.get(stranger, created.request_id), (error) => error.statusCode === 404);
    await assert.rejects(store.rename(stranger, created.request_id, { display_name: "stolen", idempotency_key: "x" }), (error) => error.statusCode === 404);
    assert.deepEqual((await store.list(stranger)).items, []);
  }
});

test("mobile list is bounded, omits full source, and detail retains it", async (t) => {
  const { store } = harness(t);
  for (let index = 0; index < 4; index += 1) {
    await store.create(owner, request({
      idempotency_key: `create-${index}`,
      display_name: `Request ${index}`,
      source_text: `${index}-${"x".repeat(400)}`,
      provenance: { kind: "text", surface: "android" },
    }));
  }
  await store.create(otherUser, request({ idempotency_key: "foreign" }));

  const firstPage = await store.list(owner, { limit: 2 });
  assert.equal(firstPage.items.length, 2);
  assert.ok(firstPage.next_cursor);
  assert.equal(Object.hasOwn(firstPage.items[0], "source_text"), false);
  assert.equal(firstPage.items[0].source_preview.length, 160);
  const secondPage = await store.list(owner, { limit: 2, cursor: firstPage.next_cursor });
  assert.equal(secondPage.items.length, 2);
  assert.equal(new Set([...firstPage.items, ...secondPage.items].map((item) => item.request_id)).size, 4);
  assert.match((await store.get(owner, firstPage.items[0].request_id)).source_text, /x{100}/);
});

test("progress is validated, idempotent, and keeps only a mobile-safe recent window", async (t) => {
  const { store, events } = harness(t);
  const created = await store.create(owner, request());
  for (let index = 0; index < MAX_RECENT_PROGRESS + 5; index += 1) {
    await store.updateProgress(owner, created.request_id, {
      idempotency_key: `progress-${index}`,
      state: index ? "running" : "planned",
      phase: "implementation",
      summary: `Completed checkpoint ${index}`,
      current_step: `task-${index}`,
      percent: Math.min(index * 5, 100),
      active_agents: 2,
      waiting_tasks: 3,
      total_tasks: 6,
    });
  }
  const detail = await store.get(owner, created.request_id);
  assert.equal(detail.recent_progress.length, MAX_RECENT_PROGRESS);
  assert.equal(detail.recent_progress[0].summary, "Completed checkpoint 5");
  assert.equal(detail.progress.summary, `Completed checkpoint ${MAX_RECENT_PROGRESS + 4}`);
  assert.equal(detail.progress.active_agents, 2);
  assert.equal(detail.progress.waiting_tasks, 3);

  await store.updateProgress(owner, created.request_id, {
    idempotency_key: "equivalent-new-key",
    ...detail.progress,
  });
  const rows = await events.listEvents({ stream_id: `development-request:${created.request_id}`, event_type: "development_request.progress_updated", limit: 500 });
  assert.equal(rows.length, MAX_RECENT_PROGRESS + 5);
  await assert.rejects(store.updateProgress(owner, created.request_id, {
    idempotency_key: "bad-progress", state: "running", summary: "bad", percent: 101,
  }), /percent/);
});

test("required fields, provenance, counts, and update idempotency collisions are rejected", async (t) => {
  const { store } = harness(t);
  await assert.rejects(store.create(owner, request({ provenance: { kind: "screen", surface: "android" } })), /voice or text/);
  await assert.rejects(store.create(owner, request({ project_id: "" })), /project_id is required/);
  const created = await store.create(owner, request());
  await store.rename(owner, created.request_id, { display_name: "First", idempotency_key: "rename-key" });
  await assert.rejects(store.rename(owner, created.request_id, { display_name: "Second", idempotency_key: "rename-key" }), (error) => error.code === "idempotency_collision");
  await assert.rejects(store.updateProgress(owner, created.request_id, {
    idempotency_key: "counts", state: "running", summary: "too many", active_agents: 20, waiting_tasks: 20, total_tasks: 32,
  }), /cannot exceed/);
});
