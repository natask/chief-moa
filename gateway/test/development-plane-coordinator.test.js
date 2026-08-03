"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventSubstrateStore } = require("../lib/event-substrate");
const { createDevelopmentPlane } = require("../lib/development-plane");
const { createDevelopmentPlaneCoordinator, taskPrompt } = require("../lib/development-plane-coordinator");

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "development-coordinator-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const plane = createDevelopmentPlane({ events: createEventSubstrateStore({ dataDir, originId: "test" }) });
  const runs = new Map();
  const coordinator = createDevelopmentPlaneCoordinator({
    plane,
    createRun(body) {
      const id = `run_${body.stable_launch_key.split(":").at(-1)}`;
      if (!runs.has(id)) runs.set(id, { id, status: "queued", ...body, updated_at: "2026-08-02T00:00:00Z" });
      return runs.get(id);
    },
    readRun(id) {
      if (!runs.has(id)) throw new Error("missing");
      return runs.get(id);
    },
  });
  return { plane, coordinator, runs };
}

test("bounded dispatch launches only safe runnable tasks and exposes heartbeat state", async (t) => {
  const { plane, coordinator, runs } = setup(t);
  await plane.capture({ intent_id: "intent_dispatch", riff: "Build the durable system", acceptance_criteria: ["QA passes"] });
  await plane.definePlan("intent_dispatch", { plan_id: "plan_dispatch", tasks: [
    { task_id: "one", title: "One", path_claims: ["a"], acceptance_check: "one passes", estimated_memory_mb: 700 },
    { task_id: "two", title: "Two", path_claims: ["b"], acceptance_check: "two passes", estimated_memory_mb: 700 },
    { task_id: "qa", title: "QA", kind: "qa", depends_on: ["one", "two"], acceptance_check: "QA passes" },
  ] });

  const first = await coordinator.dispatch("intent_dispatch", { max_parallel: 2, memory_budget_mb: 1_000, harness: "codex", working_dir: "/repo" });
  assert.deepEqual(first.launched.map((item) => item.task_id), ["one"]);
  assert.match(runs.get("run_one").prompt, /Original user riff:\nBuild the durable system/);
  Object.assign(runs.get("run_one"), { status: "running", claimed_by_worker_id: "worker_1", last_heartbeat_at: "2026-08-02T00:01:00Z", progress: { phase: "test" } });
  const live = await coordinator.status("intent_dispatch");
  assert.deepEqual(live.workers[0], {
    task_id: "one", run_id: "run_one", status: "running", worker_id: "worker_1",
    last_heartbeat_at: "2026-08-02T00:01:00Z", lease_expires_at: "", progress: { phase: "test" }, updated_at: "2026-08-02T00:00:00Z",
  });

  Object.assign(runs.get("run_one"), { status: "completed", artifact_refs: ["commit-one"] });
  const second = await coordinator.dispatch("intent_dispatch", { max_parallel: 2, memory_budget_mb: 1_000 });
  assert.equal(second.intent.tasks.find((item) => item.task_id === "one").state, "completed");
  assert.deepEqual(second.launched.map((item) => item.task_id), ["two"]);
});

test("terminal worker failures block the task graph with the run receipt", async (t) => {
  const { plane, coordinator, runs } = setup(t);
  await plane.capture({ intent_id: "intent_failure", riff: "Fail safely" });
  await plane.definePlan("intent_failure", { tasks: [{ task_id: "build", title: "Build", acceptance_check: "pass" }] });
  await coordinator.dispatch("intent_failure");
  Object.assign(runs.get("run_build"), { status: "failed", error: "tests failed" });
  const state = await coordinator.reconcile("intent_failure");
  assert.equal(state.status, "blocked");
  assert.equal(state.tasks[0].failure, "tests failed");
  assert.deepEqual(state.tasks[0].verification_refs, ["agent-run://run_build"]);
});

test("task prompts preserve scope and acceptance evidence", () => {
  const prompt = taskPrompt({ intent_id: "i", objective: "Ship it", riff: "My exact riff", acceptance_criteria: ["It works"] }, {
    title: "Build UI", kind: "implementation", acceptance_check: "UI smoke passes", path_claims: ["app/ui"], depends_on: [],
  });
  assert.match(prompt, /Do not broaden the task/);
  assert.match(prompt, /Allowed path claims: app\/ui/);
  assert.match(prompt, /- It works/);
  assert.ok(taskPrompt({ intent_id: "i", objective: "", riff: "x".repeat(100_000), acceptance_criteria: [] }, {
    title: "Build", kind: "implementation", acceptance_check: "pass", path_claims: [], depends_on: [],
  }).length < 50_000);
});
