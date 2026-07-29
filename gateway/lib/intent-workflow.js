"use strict";

const crypto = require("node:crypto");

function createIntentWorkflow({ intentRuntime, workHistory }) {
  if (!intentRuntime || typeof intentRuntime.capture !== "function"
    || typeof intentRuntime.transition !== "function"
    || typeof intentRuntime.get !== "function") {
    throw new Error("intent workflow requires the intent runtime");
  }
  if (!workHistory || typeof workHistory.createTask !== "function"
    || typeof workHistory.queueRun !== "function"
    || typeof workHistory.statusSummary !== "function") {
    throw new Error("intent workflow requires the work-history store");
  }

  async function createWork(input = {}) {
    const objective = bounded(input.objective || input.statement, 2_000);
    if (!objective) throw new Error("objective is required");
    const source = normalizeSource(input);
    // A broker append may receive a fresh event id on an HTTP retry. The
    // admitted turn id is the stable client identity and therefore takes
    // precedence when both are present.
    const sourceIdentity = source.turn_id || source.broker_event_id;
    if (!sourceIdentity) throw new Error("broker_event_id or turn_id is required");
    const durableSource = source.turn_id ? { ...source, broker_event_id: "" } : source;

    const digest = crypto.createHash("sha256")
      .update(`${sourceIdentity}\n${source.session_id}\n${source.branch_id}`)
      .digest("hex");
    const intentId = bounded(input.intent_id, 160) || `intent_delivery_${digest.slice(0, 32)}`;
    const acceptanceContractRef = bounded(
      input.acceptance_contract_ref || input.acceptanceContractRef,
      400,
    ) || `work-history://turn/${encodeURIComponent(source.turn_id || sourceIdentity)}/acceptance`;
    const completionCriteria = boundedList(
      input.completion_criteria || input.completionCriteria || [objective],
      16,
      2_000,
    );
    const actor = input.actor && typeof input.actor === "object"
      ? input.actor
      : { kind: "user", id: source.surface || "work-history" };
    const idempotencyBase = `delivery-${digest.slice(0, 40)}`;

    let intent = null;
    let task = null;
    let run = null;
    try {
      intent = await intentRuntime.capture({
        intent_id: intentId,
        statement: bounded(input.statement || objective, 2_000),
        normalized_objective: objective,
        project_id: bounded(input.project_id, 160),
        source: durableSource,
        completion_criteria: completionCriteria,
        plan_refs: [acceptanceContractRef],
        next_step: "Create one linked work task and an inert queued run proposal.",
        actor,
        idempotency_key: `${idempotencyBase}-capture`,
      });
      intent = await intentRuntime.transition(intentId, {
        type: "intent.disambiguated",
        decision: "Treat this current user-authored work request as one delivery intent.",
        completion_criteria: completionCriteria,
        plan_refs: [acceptanceContractRef],
        actor,
        idempotency_key: `${idempotencyBase}-clarify`,
      });
      intent = await intentRuntime.transition(intentId, {
        type: "intent.planned",
        next_step: "Await a worker claim after the linked queued proposal is reviewed.",
        completion_criteria: completionCriteria,
        plan_refs: [acceptanceContractRef],
        actor,
        idempotency_key: `${idempotencyBase}-plan`,
      });

      task = await workHistory.createTask({
        title: bounded(input.title || objective.split(/\r?\n/)[0], 200),
        objective,
        owner_hint: bounded(input.owner_hint, 200),
        session_id: durableSource.session_id,
        branch_id: durableSource.branch_id,
        project_id: bounded(input.project_id, 160),
        created_from_broker_event_id: durableSource.broker_event_id,
        created_from_turn_id: durableSource.turn_id,
        intent_id: intentId,
        intent_revision: intent.version,
        acceptance_contract_ref: acceptanceContractRef,
        acceptance_refs: [acceptanceContractRef],
        actor,
        idempotency_key: `${idempotencyBase}-task`,
      });

      if (input.wants_run !== false) {
        run = await workHistory.queueRun({
          task_id: task.task_id,
          objective,
          owner_hint: bounded(input.owner_hint, 200),
          harness_hint: bounded(input.harness_hint || input.harness, 80),
          session_id: durableSource.session_id,
          branch_id: durableSource.branch_id,
          project_id: bounded(input.project_id, 160),
          created_from_broker_event_id: durableSource.broker_event_id,
          created_from_turn_id: durableSource.turn_id,
          route_decision_id: bounded(input.route_decision_id, 160),
          context_pack_ref: bounded(input.context_pack_ref, 400),
          profile_version: bounded(input.profile_version, 160),
          intent_id: intentId,
          intent_revision: intent.version,
          acceptance_contract_ref: acceptanceContractRef,
          actor,
          idempotency_key: `${idempotencyBase}-run`,
        });
      }

      intent = await intentRuntime.transition(intentId, {
        type: "intent.enriched",
        plan_refs: [acceptanceContractRef, `work-task://${task.task_id}`],
        run_refs: run ? [`work-run://${run.run_id}`] : [],
        next_step: run
          ? "Queued proposal awaits an explicit worker claim; no execution has started."
          : "Task is recorded; no run proposal has been queued.",
        actor: { kind: "gateway", id: "intent-workflow" },
        idempotency_key: `${idempotencyBase}-link`,
      });
    } catch (error) {
      error.intent_workflow_partial = compactPartial(intentId, intent, task, run, acceptanceContractRef);
      throw error;
    }

    return {
      intent,
      task,
      run,
      delivery: deliveryProjection(intent, [task], run ? [run] : [], acceptanceContractRef),
    };
  }

  async function delivery(intentId) {
    const intent = await intentRuntime.get(intentId);
    if (!intent || intent.exists === false) return null;
    const summary = await workHistory.statusSummary();
    const tasks = (summary.tasks || []).filter((task) => task.intent_id === intent.intent_id);
    const runs = (summary.runs || []).filter((run) => run.intent_id === intent.intent_id);
    const acceptanceContractRef = tasks[0]?.acceptance_contract_ref
      || runs[0]?.acceptance_contract_ref
      || intent.plan_refs?.find((ref) => String(ref).includes("acceptance"))
      || "";
    return deliveryProjection(intent, tasks, runs, acceptanceContractRef);
  }

  return { createWork, delivery };
}

function normalizeSource(input) {
  const source = input.source && typeof input.source === "object" ? input.source : input;
  return {
    session_id: bounded(source.session_id, 160),
    branch_id: bounded(source.branch_id, 160) || "default",
    turn_id: bounded(source.turn_id, 160),
    broker_event_id: bounded(source.broker_event_id, 160),
    surface: bounded(source.surface, 80),
    audio_ref: bounded(source.audio_ref, 400),
    transcript_ref: bounded(source.transcript_ref, 400),
  };
}

function deliveryProjection(intent, tasks, runs, acceptanceContractRef) {
  return {
    schema: "moa.delivery-intent.v1",
    intent_id: intent.intent_id,
    intent_revision: intent.version,
    lifecycle_state: intent.lifecycle_state,
    objective: intent.normalized_objective,
    source: intent.source,
    acceptance_contract_ref: acceptanceContractRef,
    task_refs: tasks.map((task) => ({
      task_id: task.task_id,
      status: task.status,
      intent_revision: task.intent_revision,
    })),
    run_refs: runs.map((run) => ({
      run_id: run.run_id,
      execution_run_id: run.execution_run_id || "",
      status: run.status,
      intent_revision: run.intent_revision,
    })),
    execution_started: runs.some((run) => !["proposed", "queued"].includes(run.status)),
    pending_notification_count: Array.isArray(intent.pending_notifications)
      ? intent.pending_notifications.length
      : 0,
    promotion_recorded: false,
  };
}

function compactPartial(intentId, intent, task, run, acceptanceContractRef) {
  return {
    intent_id: intent?.intent_id || intentId,
    intent_revision: intent?.version || 0,
    task_id: task?.task_id || "",
    run_id: run?.run_id || "",
    acceptance_contract_ref: acceptanceContractRef,
  };
}

function bounded(value, max) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : "";
}

function boundedList(values, maxItems, maxText) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => bounded(value, maxText)).filter(Boolean).slice(0, maxItems);
}

module.exports = {
  createIntentWorkflow,
  deliveryProjection,
};
