"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createEventSubstrateStore } = require("../lib/event-substrate");
const { createIntentRuntime } = require("../lib/intent-runtime");
const { createIntentWorkflow } = require("../lib/intent-workflow");
const { createWorkHistoryStore } = require("../lib/work-history");

function makeHarness() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-intent-workflow-"));
  const events = createEventSubstrateStore({ dataDir, originId: "intent-workflow-test" });
  const intentRuntime = createIntentRuntime({ events });
  const workHistory = createWorkHistoryStore({ events });
  return {
    dataDir,
    events,
    intentRuntime,
    workHistory,
    workflow: createIntentWorkflow({ intentRuntime, workHistory }),
  };
}

test("one explicit work turn creates one linked intent, task, and inert queued run", async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dataDir, { recursive: true, force: true }));
  const input = {
    statement: "Implement durable product intake and verify it",
    objective: "Implement durable product intake and verify it",
    project_id: "chief-moa",
    session_id: "session_1",
    branch_id: "default",
    turn_id: "turn_1",
    broker_event_id: "broker_1",
    surface: "voice",
    acceptance_contract_ref: "openspec://durable-intent-delivery-pipeline/task-1",
    completion_criteria: ["A retry creates no duplicate records"],
    wants_run: true,
    actor: { kind: "user", id: "phone_1" },
  };

  const first = await harness.workflow.createWork(input);
  const retry = await harness.workflow.createWork(input);

  assert.equal(retry.intent.intent_id, first.intent.intent_id);
  assert.equal(retry.task.task_id, first.task.task_id);
  assert.equal(retry.run.run_id, first.run.run_id);
  assert.equal(first.task.intent_id, first.intent.intent_id);
  assert.equal(first.run.intent_id, first.intent.intent_id);
  assert.equal(first.task.intent_revision, 3);
  assert.equal(first.run.intent_revision, 3);
  assert.equal(first.run.status, "queued");
  assert.equal(first.delivery.execution_started, false);
  assert.equal(first.delivery.promotion_recorded, false);

  const projection = await harness.workflow.delivery(first.intent.intent_id);
  assert.equal(projection.intent_id, first.intent.intent_id);
  assert.deepEqual(projection.task_refs.map((ref) => ref.task_id), [first.task.task_id]);
  assert.deepEqual(projection.run_refs.map((ref) => ref.run_id), [first.run.run_id]);
  assert.equal(projection.acceptance_contract_ref, input.acceptance_contract_ref);

  const all = await harness.events.listEvents({ limit: 100, order: "asc" });
  const count = (type) => all.filter((event) => event.event_type === type).length;
  assert.equal(count("intent.captured"), 1);
  assert.equal(count("work.task.created"), 1);
  assert.equal(count("run.queued"), 1);
  assert.equal(count("run.claimed"), 0);
  assert.equal(count("run.started"), 0);
  assert.equal(count("run.deployment_requested"), 0);
  assert.equal(count("deployment.requested"), 0);
  assert.equal(count("deployment.recorded"), 0);
});

test("task-only delivery keeps the intent traceable without inventing a run", async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dataDir, { recursive: true, force: true }));
  const result = await harness.workflow.createWork({
    objective: "Record the interface direction",
    turn_id: "turn_task_only",
    broker_event_id: "broker_task_only",
    wants_run: false,
  });
  assert.equal(result.run, null);
  assert.equal(result.delivery.task_refs.length, 1);
  assert.equal(result.delivery.run_refs.length, 0);
});

test("workflow validates required stores and source identity", async () => {
  assert.throws(() => createIntentWorkflow({}), /intent runtime/);
  assert.throws(() => createIntentWorkflow({
    intentRuntime: { capture() {}, transition() {}, get() {} },
  }), /work-history store/);

  const harness = makeHarness();
  try {
    await assert.rejects(harness.workflow.createWork({ objective: "missing source" }), /broker_event_id or turn_id/);
    assert.equal(await harness.workflow.delivery("missing_intent"), null);
  } finally {
    fs.rmSync(harness.dataDir, { recursive: true, force: true });
  }
});
