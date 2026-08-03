"use strict";

const crypto = require("node:crypto");

const EVENT_PREFIX = "development.";
const TASK_KINDS = new Set(["implementation", "qa", "integration"]);
const TASK_STATES = new Set(["pending", "running", "completed", "failed"]);
const DECISIONS = new Set(["accepted", "rejected"]);

function clean(value, max = 2_000) {
  const result = String(value || "").trim();
  if (result.length > max) throw new Error(`value exceeds ${max} characters`);
  return result;
}

function required(value, label, max = 2_000) {
  const result = clean(value, max);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function uniqueTexts(value, maxItems = 64, maxLength = 400) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => clean(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function streamId(intentId) {
  return `development:${required(intentId, "intent_id", 160)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deterministicId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)}`;
}

function normalizeTask(input, index) {
  const taskId = required(input?.task_id || input?.taskId, `tasks[${index}].task_id`, 160);
  const kind = clean(input?.kind, 40) || "implementation";
  if (!TASK_KINDS.has(kind)) throw new Error(`tasks[${index}].kind is unsupported`);
  const estimatedMemoryMb = Number(input?.estimated_memory_mb ?? input?.estimatedMemoryMb ?? 512);
  if (!Number.isSafeInteger(estimatedMemoryMb) || estimatedMemoryMb < 1 || estimatedMemoryMb > 1_048_576) {
    throw new Error(`tasks[${index}].estimated_memory_mb is invalid`);
  }
  return {
    task_id: taskId,
    title: required(input?.title, `tasks[${index}].title`, 240),
    kind,
    depends_on: uniqueTexts(input?.depends_on || input?.dependsOn, 64, 160),
    path_claims: uniqueTexts(input?.path_claims || input?.pathClaims, 128, 500),
    acceptance_check: required(input?.acceptance_check || input?.acceptanceCheck, `tasks[${index}].acceptance_check`, 1_000),
    estimated_memory_mb: estimatedMemoryMb,
    parallel_safe: input?.parallel_safe !== false && input?.parallelSafe !== false,
  };
}

function validateTasks(rawTasks) {
  if (!Array.isArray(rawTasks) || rawTasks.length === 0 || rawTasks.length > 256) {
    throw new Error("tasks must contain 1-256 items");
  }
  const tasks = rawTasks.map(normalizeTask);
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.task_id)) throw new Error(`duplicate task_id: ${task.task_id}`);
    ids.add(task.task_id);
  }
  for (const task of tasks) {
    for (const dependency of task.depends_on) {
      if (!ids.has(dependency)) throw new Error(`task ${task.task_id} depends on missing task ${dependency}`);
      if (dependency === task.task_id) throw new Error(`task ${task.task_id} depends on itself`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  function visit(taskId) {
    if (visiting.has(taskId)) throw new Error(`task dependency cycle includes ${taskId}`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId).depends_on) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  for (const task of tasks) visit(task.task_id);
  return tasks;
}

function initialState(intentId) {
  return {
    schema: "moa.development-plane.v1",
    intent_id: intentId,
    exists: false,
    version: 0,
    status: "missing",
    riff: "",
    objective: "",
    evidence_refs: [],
    acceptance_criteria: [],
    plan_id: "",
    tasks: [],
    candidate: null,
    user_decision: null,
    release_handoff: null,
    created_at: "",
    updated_at: "",
  };
}

function reduce(intentId, events) {
  const state = initialState(intentId);
  const taskState = new Map();
  for (const event of events) {
    const payload = event.payload || {};
    if (event.event_type === "development.intent.captured") {
      state.exists = true;
      state.status = "captured";
      state.riff = payload.riff;
      state.objective = payload.objective;
      state.evidence_refs = payload.evidence_refs;
      state.acceptance_criteria = payload.acceptance_criteria;
      state.created_at = event.occurred_at;
    } else if (event.event_type === "development.plan.defined") {
      state.status = "planned";
      state.plan_id = payload.plan_id;
      state.tasks = payload.tasks.map((task) => ({ ...task, state: "pending", worker_id: "", run_id: "", output_refs: [], verification_refs: [], failure: "" }));
      taskState.clear();
      for (const task of state.tasks) taskState.set(task.task_id, task);
    } else if (event.event_type === "development.task.claimed") {
      const task = taskState.get(payload.task_id);
      if (task) Object.assign(task, { state: "running", worker_id: payload.worker_id, run_id: payload.run_id });
      state.status = "active";
    } else if (event.event_type === "development.task.completed") {
      const task = taskState.get(payload.task_id);
      if (task) Object.assign(task, { state: "completed", output_refs: payload.output_refs, verification_refs: payload.verification_refs, failure: "" });
    } else if (event.event_type === "development.task.failed") {
      const task = taskState.get(payload.task_id);
      if (task) Object.assign(task, { state: "failed", failure: payload.failure, verification_refs: payload.verification_refs });
      state.status = "blocked";
    } else if (event.event_type === "development.candidate.ready") {
      state.candidate = payload;
      state.status = "needs_user";
    } else if (event.event_type === "development.user.accepted" || event.event_type === "development.user.rejected") {
      state.user_decision = {
        intent_id: payload.intent_id,
        decision: payload.decision,
        candidate_digest: payload.candidate_digest,
        note: payload.note,
        reviewer: payload.reviewer,
      };
      state.release_handoff = payload.release_handoff ? { ...payload.release_handoff, requested_at: event.occurred_at } : null;
      state.status = payload.decision;
    }
    state.version = Number(event.stream_version || state.version);
    state.updated_at = event.occurred_at;
  }
  return state;
}

function pathsOverlap(left, right) {
  const a = String(left || "").replace(/\/+$/, "");
  const b = String(right || "").replace(/\/+$/, "");
  return Boolean(a && b) && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`));
}

function tasksOverlap(left, right) {
  return left.path_claims.some((a) => right.path_claims.some((b) => pathsOverlap(a, b)));
}

function runnableTasks(state, limits = {}) {
  if (!state.exists || !state.plan_id || state.candidate || state.user_decision) return [];
  const maxParallel = Math.max(1, Math.min(Number(limits.max_parallel || limits.maxParallel) || 8, 128));
  const memoryBudgetMb = Math.max(1, Math.min(Number(limits.memory_budget_mb || limits.memoryBudgetMb) || 8_192, 1_048_576));
  const completed = new Set(state.tasks.filter((task) => task.state === "completed").map((task) => task.task_id));
  const running = state.tasks.filter((task) => task.state === "running");
  if (running.some((task) => !task.parallel_safe)) return [];
  const selected = [];
  let memoryUsed = running.reduce((sum, task) => sum + task.estimated_memory_mb, 0);
  for (const task of state.tasks) {
    if (selected.length + running.length >= maxParallel) break;
    if (task.state !== "pending" || !task.depends_on.every((dependency) => completed.has(dependency))) continue;
    if (selected.some((other) => !other.parallel_safe)) break;
    if (!task.parallel_safe && (running.length || selected.length)) continue;
    if (running.some((other) => tasksOverlap(task, other)) || selected.some((other) => tasksOverlap(task, other))) continue;
    if (memoryUsed + task.estimated_memory_mb > memoryBudgetMb) continue;
    selected.push(task);
    memoryUsed += task.estimated_memory_mb;
  }
  return clone(selected);
}

function createDevelopmentPlane({ events, now = () => new Date().toISOString(), idFactory = makeId } = {}) {
  if (!events?.appendEvent || !events?.listEvents || !events?.withStreamLock) {
    throw new Error("development plane requires an event substrate with stream locking");
  }

  async function listEvents(intentId) {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const page = await events.listEvents({ stream_id: streamId(intentId), order: "asc", offset, limit: 500 });
      rows.push(...page.filter((event) => event.event_type.startsWith(EVENT_PREFIX)));
      if (page.length < 500) return rows;
    }
  }

  async function get(intentId) {
    const safeId = required(intentId, "intent_id", 160);
    return reduce(safeId, await listEvents(safeId));
  }

  async function append(intentId, type, payload, key, expectedVersion) {
    const event = await events.appendEvent({
      stream_id: streamId(intentId),
      event_type: type,
      occurred_at: now(),
      actor: { kind: "gateway", id: "development-plane" },
      authority: { boundary: "development-plane", execution: "proposal_and_receipt_only" },
      correlation_id: intentId,
      idempotency_key: `development:${intentId}:${required(key, "idempotency_key", 200)}`,
      expected_stream_version: expectedVersion,
      payload: { intent_id: intentId, ...payload },
    });
    return event;
  }

  async function mutate(intentId, operation) {
    const safeId = required(intentId, "intent_id", 160);
    return events.withStreamLock(streamId(safeId), async () => operation(await get(safeId), safeId));
  }

  async function capture(input = {}) {
    const intentId = clean(input.intent_id || input.intentId, 160) || idFactory("dev_intent");
    return mutate(intentId, async (state) => {
      const payload = {
        riff: required(input.riff, "riff", 100_000),
        objective: clean(input.objective, 4_000),
        evidence_refs: uniqueTexts(input.evidence_refs || input.evidenceRefs, 128, 1_000),
        acceptance_criteria: uniqueTexts(input.acceptance_criteria || input.acceptanceCriteria, 64, 1_000),
      };
      if (state.exists) {
        if (!same(payload, { riff: state.riff, objective: state.objective, evidence_refs: state.evidence_refs, acceptance_criteria: state.acceptance_criteria })) {
          throw new Error("intent capture collision");
        }
        return state;
      }
      await append(intentId, "development.intent.captured", payload, input.idempotency_key || input.idempotencyKey || "capture", 0);
      return get(intentId);
    });
  }

  async function definePlan(intentId, input = {}) {
    return mutate(intentId, async (state, safeId) => {
      if (!state.exists) throw new Error("intent not found");
      const tasks = validateTasks(input.tasks);
      const planId = clean(input.plan_id || input.planId, 160) || deterministicId("plan", tasks);
      if (state.plan_id) {
        const existingTasks = state.tasks.map(({ state: taskState, worker_id, run_id, output_refs, verification_refs, failure, ...task }) => task);
        if (state.plan_id !== planId || !same(existingTasks, tasks)) throw new Error("plan already defined with different work");
        return state;
      }
      await append(safeId, "development.plan.defined", {
        plan_id: planId,
        tasks,
      }, input.idempotency_key || input.idempotencyKey || "plan", state.version);
      return get(safeId);
    });
  }

  async function claimTask(intentId, taskId, input = {}) {
    return mutate(intentId, async (state, safeId) => {
      const task = state.tasks.find((item) => item.task_id === taskId);
      if (!task) throw new Error("task not found");
      const workerId = required(input.worker_id || input.workerId, "worker_id", 160);
      const runId = required(input.run_id || input.runId, "run_id", 160);
      if (task.state === "running") {
        if (task.worker_id !== workerId || task.run_id !== runId) throw new Error("task is already claimed");
        return state;
      }
      const ready = runnableTasks(state, { max_parallel: state.tasks.length, memory_budget_mb: 1_048_576 });
      if (!ready.some((item) => item.task_id === taskId)) throw new Error("task is not runnable");
      await append(safeId, "development.task.claimed", {
        task_id: taskId,
        worker_id: workerId,
        run_id: runId,
      }, input.idempotency_key || input.idempotencyKey || `claim:${taskId}`, state.version);
      return get(safeId);
    });
  }

  async function finishTask(intentId, taskId, input = {}) {
    return mutate(intentId, async (state, safeId) => {
      const task = state.tasks.find((item) => item.task_id === taskId);
      if (!task) throw new Error("task not found");
      const passed = input.passed === true;
      const outputRefs = uniqueTexts(input.output_refs || input.outputRefs, 64, 1_000);
      const verificationRefs = uniqueTexts(input.verification_refs || input.verificationRefs, 64, 1_000);
      const failure = passed ? "" : required(input.failure, "failure", 2_000);
      if (task.state === "completed" && passed && same(task.output_refs, outputRefs) && same(task.verification_refs, verificationRefs)) return state;
      if (task.state === "failed" && !passed && task.failure === failure && same(task.verification_refs, verificationRefs)) return state;
      if (task.state !== "running") throw new Error("task is not running");
      const type = passed ? "development.task.completed" : "development.task.failed";
      await append(safeId, type, {
        task_id: taskId,
        output_refs: outputRefs,
        verification_refs: verificationRefs,
        failure,
      }, input.idempotency_key || input.idempotencyKey || `finish:${taskId}`, state.version);
      return get(safeId);
    });
  }

  async function freezeCandidate(intentId, input = {}) {
    return mutate(intentId, async (state, safeId) => {
      if (!state.plan_id || state.tasks.some((task) => task.state !== "completed")) {
        throw new Error("all planned tasks must complete before candidate review");
      }
      if (!state.tasks.some((task) => task.kind === "qa")) throw new Error("candidate requires a completed QA task");
      const payload = {
        candidate_ref: required(input.candidate_ref || input.candidateRef, "candidate_ref", 1_000),
        candidate_digest: required(input.candidate_digest || input.candidateDigest, "candidate_digest", 160),
        summary: required(input.summary, "summary", 4_000),
        verification_refs: uniqueTexts(input.verification_refs || input.verificationRefs, 128, 1_000),
      };
      if (state.candidate) {
        const { intent_id: ignoredIntentId, ...existing } = state.candidate;
        if (!same(existing, payload)) throw new Error("candidate already frozen with different evidence");
        return state;
      }
      await append(safeId, "development.candidate.ready", payload, input.idempotency_key || input.idempotencyKey || "candidate", state.version);
      return get(safeId);
    });
  }

  async function decide(intentId, input = {}) {
    return mutate(intentId, async (state, safeId) => {
      if (!state.candidate) throw new Error("candidate is not ready");
      const decision = required(input.decision, "decision", 40);
      if (!DECISIONS.has(decision)) throw new Error("decision must be accepted or rejected");
      const digest = required(input.candidate_digest || input.candidateDigest, "candidate_digest", 160);
      if (digest !== state.candidate.candidate_digest) throw new Error("decision does not match the candidate digest");
      const payload = {
        decision,
        candidate_digest: digest,
        note: clean(input.note, 4_000),
        reviewer: clean(input.reviewer, 160) || "user",
      };
      if (state.user_decision) {
        const { intent_id: ignoredIntentId, ...existing } = state.user_decision;
        if (!same(existing, payload)) throw new Error("candidate already has a different user decision");
        return state;
      }
      const releaseHandoff = decision === "accepted" ? {
        handoff_id: deterministicId("release", { intent_id: safeId, candidate_digest: digest }),
        state: "requested",
        policy: "active-promotion",
        candidate_ref: state.candidate.candidate_ref,
        candidate_digest: digest,
        verification_refs: state.candidate.verification_refs,
      } : null;
      await append(safeId, `development.user.${decision}`, {
        ...payload,
        release_handoff: releaseHandoff,
      }, input.idempotency_key || input.idempotencyKey || `decision:${decision}`, state.version);
      return get(safeId);
    });
  }

  return { capture, definePlan, get, runnable: async (id, limits) => runnableTasks(await get(id), limits), claimTask, finishTask, freezeCandidate, decide };
}

module.exports = { createDevelopmentPlane, runnableTasks, validateTasks, pathsOverlap, TASK_STATES };
