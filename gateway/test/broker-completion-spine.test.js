"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createBrokerCompletionSpine } = require("../lib/broker-completion-spine");
const { createEventSubstrateStore } = require("../lib/event-substrate");
const { createIntentRuntime } = require("../lib/intent-runtime");
const { createIntentWorkflow } = require("../lib/intent-workflow");
const { createWorkHistoryStore } = require("../lib/work-history");

function harness() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-broker-completion-"));
  const events = createEventSubstrateStore({ dataDir, originId: "broker-completion-test" });
  const intentRuntime = createIntentRuntime({ events });
  const workHistory = createWorkHistoryStore({ events });
  const intentWorkflow = createIntentWorkflow({ intentRuntime, workHistory });
  return {
    dataDir,
    events,
    intentRuntime,
    workHistory,
    intentWorkflow,
    spine: createBrokerCompletionSpine({ intentRuntime, workHistory, intentWorkflow }),
  };
}

function admission(id) {
  return {
    event: {
      id: `broker-${id}`,
      source_turn_id: `turn-${id}`,
      source: "android",
      text: `Implement request ${id}`,
      session_id: "session-1",
      conversation_id: "session-1",
      branch_id: `branch-${id}`,
      project_id: "chief-moa",
      profile_version: "profile-1",
    },
    decision: {
      id: `route-${id}`,
      action: "create_new_fork",
      target_type: "workflow",
      target_id: "coding",
    },
    contextPack: {
      id: `context-${id}`,
      launcher_profile_id: "coding",
      principal_role: "coding",
      expected_output: `Verified output ${id}`,
      launcher: { harness: "echo" },
    },
  };
}

function agentRun(linkage, id, extra = {}) {
  return {
    id,
    status: "completed",
    output: `result from ${id}`,
    exit_code: 0,
    output_artifact_refs: [],
    ...linkage,
    ...extra,
  };
}

test("stable retries create one chain while distinct messages remain independently claimable", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));

  const first = await h.spine.prepare(admission("one"));
  const retry = await h.spine.prepare(admission("one"));
  const second = await h.spine.prepare(admission("two"));

  assert.equal(retry.intent_id, first.intent_id);
  assert.equal(retry.task_id, first.task_id);
  assert.equal(retry.work_history_run_id, first.work_history_run_id);
  assert.notEqual(second.intent_id, first.intent_id);
  assert.notEqual(second.task_id, first.task_id);
  assert.notEqual(second.work_history_run_id, first.work_history_run_id);

  const firstClaim = await h.workHistory.claimRun({
    run_id: first.work_history_run_id,
    worker_id: "worker-one",
  });
  const secondClaim = await h.workHistory.claimRun({
    run_id: second.work_history_run_id,
    worker_id: "worker-two",
  });
  assert.equal(firstClaim.claim.worker_id, "worker-one");
  assert.equal(secondClaim.claim.worker_id, "worker-two");

  const all = await h.events.listEvents({ limit: 200, order: "asc" });
  const eventsForFirst = all.filter((event) => event.payload?.intent_id === first.intent_id);
  assert.equal(eventsForFirst.filter((event) => event.event_type === "intent.captured").length, 1);
  assert.equal(all.filter((event) => event.event_type === "work.task.created").length, 2);
  assert.equal(all.filter((event) => event.event_type === "run.queued").length, 2);
});

test("one terminal result updates and notifies only its linked intent without completing delivery", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));

  const first = await h.spine.prepare(admission("first"));
  const second = await h.spine.prepare(admission("second"));
  const firstRun = agentRun(first, "agent-run-first");
  const secondRun = agentRun(second, "agent-run-second", { status: "running" });
  await h.spine.activate(first, firstRun);
  await h.spine.activate(second, secondRun);

  const completion = await h.spine.complete(firstRun);
  const retry = await h.spine.complete(firstRun);
  assert.equal(retry.notification_id, completion.notification_id);

  const firstIntent = await h.intentRuntime.get(first.intent_id);
  const secondIntent = await h.intentRuntime.get(second.intent_id);
  assert.equal(firstIntent.lifecycle_state, "active");
  assert.match(firstIntent.latest_progress, /produced output for review/);
  assert.equal(firstIntent.pending_notifications.length, 1);
  assert.equal(firstIntent.pending_notifications[0].run_id, firstRun.id);
  assert.equal(secondIntent.lifecycle_state, "active");
  assert.equal(secondIntent.latest_progress, "");
  assert.equal(secondIntent.pending_notifications.length, 0);

  const firstWork = await h.workHistory.runDetail(first.work_history_run_id);
  const secondWork = await h.workHistory.runDetail(second.work_history_run_id);
  assert.equal(firstWork.status, "running");
  assert.equal(firstWork.blocking_reason, "output proposed; waiting on user review");
  assert.equal(firstWork.run.execution_run_id, firstRun.id);
  assert.equal(secondWork.status, "queued");
  assert.equal(secondWork.run.execution_run_id, secondRun.id);

  const delivery = await h.intentWorkflow.delivery(first.intent_id);
  assert.equal(delivery.lifecycle_state, "active");
  assert.equal(delivery.pending_notification_count, 1);
  assert.equal(delivery.promotion_recorded, false);

  const all = await h.events.listEvents({ limit: 300, order: "asc" });
  assert.equal(all.filter((event) => event.event_type === "intent.notification_created").length, 1);
  assert.equal(all.filter((event) => event.event_type === "intent.completed").length, 0);
  assert.equal(all.filter((event) => event.event_type === "run.completed").length, 0);
});
