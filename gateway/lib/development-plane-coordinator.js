"use strict";

const TERMINAL = new Set(["completed", "failed", "timed-out", "canceled"]);

function numberLimit(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function excerpt(value, max) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, max - 14)}\n[truncated]`;
}

function taskPrompt(intent, task) {
  const criteria = (intent.acceptance_criteria || []).slice(0, 20).map((item) => `- ${excerpt(item, 400)}`);
  const evidence = (intent.evidence_refs || []).slice(0, 20);
  return [
    "Complete one bounded task from a durable development intent.",
    "Do not broaden the task. Preserve unrelated work. Return exact output and verification references.",
    "",
    `Intent: ${intent.intent_id}`,
    `Objective: ${excerpt(intent.objective || intent.riff, 4_000)}`,
    `Task: ${task.title}`,
    `Kind: ${task.kind}`,
    `Acceptance check: ${task.acceptance_check}`,
    `Allowed path claims: ${task.path_claims.join(", ") || "none declared"}`,
    `Depends on: ${task.depends_on.join(", ") || "nothing"}`,
    "",
    "Original user riff:",
    excerpt(intent.riff, 40_000),
    "",
    "Intent acceptance criteria:",
    ...(criteria.length ? criteria : ["- Use the task acceptance check."]),
    "",
    "Attached evidence:",
    ...(evidence.length ? evidence.map((item) => `- ${item}`) : ["- None"]),
    "",
    "Finish with one line beginning DEVELOPMENT_RECEIPT followed by JSON:",
    '{"passed":true,"output_refs":["git://..."],"verification_refs":["test://..."]}',
    "Use passed=false and include failure when the acceptance check did not pass. QA and integration require verification_refs. Implementation and integration require output_refs.",
  ].join("\n");
}

function structuredReceipt(run) {
  const output = String(run.output || run.stdout || "");
  const marker = "DEVELOPMENT_RECEIPT";
  const index = output.lastIndexOf(marker);
  if (index < 0) return null;
  const tail = output.slice(index + marker.length).trim();
  const start = tail.indexOf("{");
  const end = tail.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const value = JSON.parse(tail.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function receiptRefs(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 64) : [];
}

function runReceipt(run, task) {
  const runRef = `agent-run://${run.id}`;
  if (run.status === "completed") {
    const receipt = structuredReceipt(run);
    if (!receipt) return { passed: false, output_refs: [], verification_refs: [runRef], failure: "worker completed without a DEVELOPMENT_RECEIPT", idempotency_key: `agent-run-result:${run.id}:missing-receipt` };
    const outputRefs = receiptRefs(receipt.output_refs || receipt.outputRefs);
    const verificationRefs = receiptRefs(receipt.verification_refs || receipt.verificationRefs);
    const missingOutput = ["implementation", "integration"].includes(task.kind) && !outputRefs.length;
    const missingVerification = ["qa", "integration"].includes(task.kind) && !verificationRefs.length;
    if (receipt.passed !== true || missingOutput || missingVerification) {
      const reason = String(receipt.failure || (missingOutput ? `${task.kind} receipt needs output_refs` : missingVerification ? `${task.kind} receipt needs verification_refs` : "worker reported that acceptance failed")).slice(0, 2_000);
      return { passed: false, output_refs: outputRefs, verification_refs: [runRef, ...verificationRefs], failure: reason, idempotency_key: `agent-run-result:${run.id}:rejected-receipt` };
    }
    return { passed: true, output_refs: [runRef, ...outputRefs], verification_refs: [runRef, ...verificationRefs], failure: "", idempotency_key: `agent-run-result:${run.id}:completed` };
  }
  return {
    passed: false,
    output_refs: [],
    verification_refs: [runRef],
    failure: String(run.error || run.output || `agent run ${run.status}`).slice(0, 2_000),
    idempotency_key: `agent-run-result:${run.id}:${run.status}`,
  };
}

function runStatus(task, readRun) {
  if (!task.run_id) return null;
  try {
    const run = readRun(task.run_id);
    return {
      task_id: task.task_id,
      run_id: run.id,
      status: run.status,
      worker_id: run.claimed_by_worker_id || run.worker_id || task.worker_id || "",
      last_heartbeat_at: run.last_heartbeat_at || "",
      lease_expires_at: run.lease_expires_at || "",
      progress: run.progress || {},
      updated_at: run.updated_at || "",
    };
  } catch {
    return { task_id: task.task_id, run_id: task.run_id, status: "missing", worker_id: task.worker_id || "", last_heartbeat_at: "", lease_expires_at: "", progress: {}, updated_at: "" };
  }
}

function createDevelopmentPlaneCoordinator({ plane, integrationQueue = null, planIntent = null, createRun, readRun, startRun = () => {} } = {}) {
  if (!plane?.get || !plane?.runnable || !plane?.claimTask || !plane?.finishTask) {
    throw new Error("development coordinator requires a development plane");
  }
  if (typeof createRun !== "function" || typeof readRun !== "function") {
    throw new Error("development coordinator requires an agent run store");
  }

  async function reconcile(intentId) {
    let intent = await plane.get(intentId);
    for (const task of intent.tasks.filter((item) => item.state === "running" && item.run_id)) {
      let run;
      try { run = readRun(task.run_id); } catch { continue; }
      if (!TERMINAL.has(run.status)) continue;
      intent = await plane.finishTask(intentId, task.task_id, runReceipt(run, task));
      if (task.kind === "integration" && integrationQueue) {
        await integrationQueue.release(intentId, task.task_id, run.status);
      }
    }
    return intent;
  }

  async function dispatch(intentId, options = {}) {
    let intent = await reconcile(intentId);
    if (!intent.exists) throw new Error("intent not found");
    if (!intent.plan_id) {
      if (typeof planIntent !== "function") throw new Error("development planner is not configured");
      const tasks = await planIntent(intent);
      intent = await plane.definePlan(intentId, { tasks, idempotency_key: "automatic-plan" });
    }
    const limits = {
      max_parallel: numberLimit(options.max_parallel || options.maxParallel, 4, 128),
      memory_budget_mb: numberLimit(options.memory_budget_mb || options.memoryBudgetMb, 8_192, 1_048_576),
    };
    const runnable = await plane.runnable(intentId, limits);
    const launched = [];
    for (const task of runnable) {
      let integrationLease = null;
      if (task.kind === "integration" && integrationQueue) {
        await integrationQueue.enqueue(intentId, task.task_id);
        integrationLease = await integrationQueue.claim(intentId, task.task_id);
        if (!integrationLease.acquired) continue;
      }
      try {
        const run = createRun({
          prompt: taskPrompt(intent, task),
          harness: options.harness,
          working_dir: options.working_dir || options.workingDir,
          project_id: options.project_id || options.projectId,
          source: "development-plane",
          intent_id: intent.intent_id,
          stable_launch_key: `development:${intent.intent_id}:${intent.plan_id}:${task.task_id}`,
        });
        if (integrationLease) await integrationQueue.bindRun(intentId, task.task_id, run.id);
        intent = await plane.claimTask(intentId, task.task_id, {
          worker_id: `agent-run:${run.id}`,
          run_id: run.id,
          idempotency_key: `dispatch:${intent.plan_id}:${task.task_id}`,
        });
        startRun(run.id);
        launched.push({ task_id: task.task_id, run_id: run.id, status: readRun(run.id).status });
      } catch (error) {
        if (integrationLease) await integrationQueue.release(intentId, task.task_id, "dispatch-failed");
        throw error;
      }
    }
    return { intent, limits, launched, workers: intent.tasks.map((task) => runStatus(task, readRun)).filter(Boolean), integration_queue: integrationQueue ? await integrationQueue.read() : null };
  }

  async function status(intentId, { reconcile_runs = true } = {}) {
    const intent = reconcile_runs ? await reconcile(intentId) : await plane.get(intentId);
    if (!intent.exists) throw new Error("intent not found");
    return { intent, workers: intent.tasks.map((task) => runStatus(task, readRun)).filter(Boolean), integration_queue: integrationQueue ? await integrationQueue.read() : null };
  }

  return { dispatch, reconcile, status };
}

module.exports = { createDevelopmentPlaneCoordinator, taskPrompt, structuredReceipt, runReceipt, TERMINAL };
