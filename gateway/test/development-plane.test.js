"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventSubstrateStore } = require("../lib/event-substrate");
const { createDevelopmentPlane, pathsOverlap, validateTasks } = require("../lib/development-plane");

function harness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "development-plane-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const events = createEventSubstrateStore({ dataDir, originId: "test" });
  return { dataDir, plane: createDevelopmentPlane({ events, idFactory: (prefix) => `${prefix}_fixed` }) };
}

const plan = [
  { task_id: "android", title: "Build Android", kind: "implementation", path_claims: ["android_app"], acceptance_check: "Android tests pass", estimated_memory_mb: 1_024 },
  { task_id: "browser", title: "Build browser", kind: "implementation", path_claims: ["browser_extension"], acceptance_check: "Browser smoke passes", estimated_memory_mb: 512 },
  { task_id: "qa_android", title: "QA Android", kind: "qa", depends_on: ["android"], path_claims: ["qa/android"], acceptance_check: "Device QA passes", estimated_memory_mb: 256 },
  { task_id: "integrate", title: "Integrate", kind: "integration", depends_on: ["browser", "qa_android"], path_claims: ["master"], acceptance_check: "Combined checks pass", parallel_safe: false },
];

test("a riff, plan, progress, candidate, and user decision survive restart", async (t) => {
  const { dataDir, plane } = harness(t);
  await plane.capture({ intent_id: "intent_one", riff: "Build the app I described", evidence_refs: ["video://one"], acceptance_criteria: ["I can use it"] });
  await plane.capture({ intent_id: "intent_one", riff: "Build the app I described", evidence_refs: ["video://one"], acceptance_criteria: ["I can use it"] });
  await assert.rejects(() => plane.capture({ intent_id: "intent_one", riff: "replace it" }), /collision/);
  await plane.definePlan("intent_one", { plan_id: "plan_one", tasks: plan });
  await plane.definePlan("intent_one", { plan_id: "plan_one", tasks: plan });
  assert.deepEqual((await plane.runnable("intent_one")).map((task) => task.task_id), ["android", "browser"]);

  await plane.claimTask("intent_one", "android", { worker_id: "worker_a", run_id: "run_a" });
  await plane.claimTask("intent_one", "android", { worker_id: "worker_a", run_id: "run_a" });
  await assert.rejects(() => plane.claimTask("intent_one", "android", { worker_id: "other", run_id: "other" }), /already claimed/);
  await plane.claimTask("intent_one", "browser", { worker_id: "worker_b", run_id: "run_b" });
  await plane.finishTask("intent_one", "android", { passed: true, output_refs: ["commit://a"], verification_refs: ["test://a"] });
  await plane.finishTask("intent_one", "android", { passed: true, output_refs: ["commit://a"], verification_refs: ["test://a"] });
  await plane.finishTask("intent_one", "browser", { passed: true, output_refs: ["commit://b"], verification_refs: ["test://b"] });
  assert.deepEqual((await plane.runnable("intent_one")).map((task) => task.task_id), ["qa_android"]);
  await plane.claimTask("intent_one", "qa_android", { worker_id: "qa", run_id: "run_qa" });
  await plane.finishTask("intent_one", "qa_android", { passed: true, verification_refs: ["device://receipt"] });
  await plane.claimTask("intent_one", "integrate", { worker_id: "integrator", run_id: "run_integrate" });
  await plane.finishTask("intent_one", "integrate", { passed: true, output_refs: ["git://candidate"], verification_refs: ["check://combined"] });
  await plane.freezeCandidate("intent_one", { candidate_ref: "git://candidate", candidate_digest: "abc123", summary: "Ready for Nat", verification_refs: ["device://receipt", "check://combined"] });
  await plane.decide("intent_one", { decision: "accepted", candidate_digest: "abc123", reviewer: "nat" });

  const restarted = createDevelopmentPlane({ events: createEventSubstrateStore({ dataDir, originId: "test" }) });
  const state = await restarted.get("intent_one");
  assert.equal(state.riff, "Build the app I described");
  assert.equal(state.status, "accepted");
  assert.equal(state.tasks.every((task) => task.state === "completed"), true);
  assert.equal(state.user_decision.reviewer, "nat");
});

test("dependency, path, parallel, and memory rules choose safe work", async (t) => {
  const { plane } = harness(t);
  await plane.capture({ intent_id: "intent_schedule", riff: "schedule safely" });
  await plane.definePlan("intent_schedule", { tasks: [
    { task_id: "a", title: "A", path_claims: ["shared"], acceptance_check: "a", estimated_memory_mb: 800 },
    { task_id: "b", title: "B", path_claims: ["shared/file"], acceptance_check: "b", estimated_memory_mb: 100 },
    { task_id: "c", title: "C", path_claims: ["other"], acceptance_check: "c", estimated_memory_mb: 300 },
  ] });
  assert.deepEqual((await plane.runnable("intent_schedule", { max_parallel: 3, memory_budget_mb: 1_000 })).map((task) => task.task_id), ["a"]);
  await plane.claimTask("intent_schedule", "a", { worker_id: "w", run_id: "r" });
  assert.deepEqual((await plane.runnable("intent_schedule", { max_parallel: 3, memory_budget_mb: 1_200 })).map((task) => task.task_id), ["c"]);
});

test("invalid graphs, premature candidates, failed QA, and wrong decisions fail closed", async (t) => {
  const { plane } = harness(t);
  assert.equal(pathsOverlap("a/b", "a"), true);
  assert.throws(() => validateTasks([{ task_id: "a", title: "A", acceptance_check: "x", depends_on: ["b"] }]), /missing task/);
  assert.throws(() => validateTasks([
    { task_id: "a", title: "A", acceptance_check: "x", depends_on: ["b"] },
    { task_id: "b", title: "B", acceptance_check: "x", depends_on: ["a"] },
  ]), /cycle/);
  await plane.capture({ intent_id: "intent_fail", riff: "fail safely" });
  await plane.definePlan("intent_fail", { tasks: [{ task_id: "qa", title: "QA", kind: "qa", acceptance_check: "pass" }] });
  await assert.rejects(() => plane.freezeCandidate("intent_fail", { candidate_ref: "x", candidate_digest: "d", summary: "x" }), /all planned tasks/);
  await plane.claimTask("intent_fail", "qa", { worker_id: "qa", run_id: "run" });
  await plane.finishTask("intent_fail", "qa", { passed: false, failure: "broken" });
  assert.equal((await plane.get("intent_fail")).status, "blocked");
  await assert.rejects(() => plane.decide("intent_fail", { decision: "accepted", candidate_digest: "wrong" }), /not ready/);
});
