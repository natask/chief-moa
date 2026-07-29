"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAndroidFeedbackFixCoordinator } = require("../lib/android-feedback-fix-coordinator");
const { createEventSubstrateStore } = require("../lib/event-substrate");
const { createIntentRuntime } = require("../lib/intent-runtime");
const { createIntentWorkflow } = require("../lib/intent-workflow");
const { createWorkHistoryStore } = require("../lib/work-history");
const { workerBaseDrift } = require("../lib/worker-base-binding");

const COMMIT = "a".repeat(40);
const APK = "b".repeat(64);
const CLOCK = "2026-07-28T18:00:00.000Z";

function harness(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-feedback-fix-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const events = createEventSubstrateStore({ dataDir, originId: "feedback-fix-test" });
  const intentRuntime = createIntentRuntime({ events, now: () => CLOCK });
  const workHistory = createWorkHistoryStore({ events });
  const feedback = {
    feedback_id: "feedback_1", tenant_id: "tenant_1", application_id: "chief-moa",
    device_id: "phone_1", assignment_event_id: "assignment_1", bundle_id: "bundle_1",
    surface_id: "android", release_id: "release_1", artifact_sha256: APK,
  };
  const releaseControlService = { feedbackDetail: async () => feedback };
  const intentWorkflow = createIntentWorkflow({ intentRuntime, workHistory });
  return {
    events, workHistory, feedback,
    coordinator: createAndroidFeedbackFixCoordinator({ events, intentWorkflow, releaseControlService,
      resolveBaseCommit: async () => COMMIT, now: () => new Date(CLOCK), ...overrides }),
  };
}

function request(overrides = {}) {
  return {
    feedback_id: "feedback_1", assignment_id: "assignment_1", bundle_id: "bundle_1",
    surface_id: "android", release_id: "release_1", artifact_sha256: APK,
    objective: "Keep the transcript ribbon compact while it streams",
    authorization: { kind: "implementation_authorized", authorized: true, authorized_at: CLOCK },
    idempotency_key: "create-fix-1", device_id: "phone_1", application_id: "chief-moa",
    tenant_id: "tenant_1", actor_id: "device-principal-1", ...overrides,
  };
}

test("Create fix idempotently creates one request, intent, task, run, and active owner lease", async (t) => {
  const h = harness(t);
  const first = await h.coordinator.create(request());
  const retry = await h.coordinator.create(request());
  assert.deepEqual(retry.identities, first.identities);
  assert.equal(first.state, "queued");
  assert.equal(first.blocking_reason, "");
  assert.equal(first.request.base_ref, "origin/master");
  assert.equal(first.request.base_commit, COMMIT);
  assert.equal(first.request.feedback_id, h.feedback.feedback_id);
  assert.equal(first.owner_lease.status, "active");
  assert.equal(first.owner_lease.run_id, first.identities.run_id);
  const run = await h.workHistory.runDetail(first.identities.run_id);
  assert.equal(run.run.workspace_base.ref, "origin/master");
  assert.equal(run.run.workspace_base.commit, COMMIT);
  assert.equal(run.run.workspace_base.modification_request_id, first.identities.request_id);

  const all = await h.events.listEvents({ limit: 100, order: "asc" });
  for (const type of ["modification.request.created", "intent.captured", "work.task.created", "run.queued", "modification.owner_leased", "modification.request.queued"]) {
    assert.equal(all.filter((event) => event.event_type === type).length, 1, type);
  }
  assert.equal(all.filter((event) => event.event_type === "run.claimed").length, 0);
});

test("conflicting retry and an exact-release mismatch fail closed", async (t) => {
  const h = harness(t);
  await h.coordinator.create(request());
  await assert.rejects(h.coordinator.create(request({ objective: "a different fix" })), (error) => error.code === "modification_request_conflict" && error.reason === "idempotency_key_reused");

  const other = harness(t);
  await assert.rejects(other.coordinator.create(request({ artifact_sha256: "c".repeat(64) })), (error) => error.code === "modification_request_conflict" && error.reason === "artifact_mismatch");
  assert.equal((await other.events.listEvents({ limit: 100 })).length, 0);
});

test("feedback evidence alone cannot create work and Create fix must be explicit and current", async (t) => {
  const h = harness(t);
  assert.equal((await h.events.listEvents({ limit: 100 })).length, 0);
  await assert.rejects(h.coordinator.create(request({ authorization: null })), (error) => error.reason === "implementation_not_authorized");
  await assert.rejects(h.coordinator.create(request({ authorization: { kind: "implementation_authorized", authorized: true, authorized_at: "2026-07-28T17:00:00Z" } })), (error) => error.reason === "authorization_not_current");
  assert.equal((await h.events.listEvents({ limit: 100 })).length, 0);
});

test("joined status exposes lease expiry as reclaimable, not ownerless queued", async (t) => {
  let clock = new Date(CLOCK);
  const h = harness(t, { now: () => clock });
  const created = await h.coordinator.create(request());
  clock = new Date("2026-07-28T18:16:00.000Z");
  const status = await h.coordinator.status(created.identities.request_id);
  assert.equal(status.state, "reclaimable");
  assert.equal(status.owner_lease.status, "expired");
  assert.match(status.blocking_reason, /reclaimable/);
});

test("unresolved master blocks before implementation records exist", async (t) => {
  const h = harness(t, { resolveBaseCommit: async () => "not-a-commit" });
  await assert.rejects(h.coordinator.create(request()), (error) => error.reason === "base_ref_unresolved");
  assert.equal((await h.events.listEvents({ limit: 100 })).length, 0);
});

test("worker base verification detects drift before a claim", async (t) => {
  const h = harness(t);
  const created = await h.coordinator.create(request());
  const run = await h.workHistory.runDetail(created.identities.run_id);
  assert.match(workerBaseDrift(run.run, { base_ref: "origin/master", resolved_base_commit: "c".repeat(40) }), /base drift/);
  assert.equal(workerBaseDrift(run.run, { base_ref: "origin/master", resolved_base_commit: COMMIT }), "");
});
