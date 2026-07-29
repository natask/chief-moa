"use strict";

function createWorkHistoryCompletionBridge(deps) {
  const { collectState, append, appendRunEvent, setTaskStatus, actor, text, refs,
    runStream, requireText, idem } = deps;

  async function linkExecutionRun(input = {}) {
    const runId = requireText(input.run_id, "run_id");
    const agentRunId = requireText(input.agent_run_id, "agent_run_id");
    const state = await collectState();
    const run = state.runs.get(runId);
    if (!run) throw new Error(`work run not found: ${runId}`);
    const intentId = text(input.intent_id, 160);
    if (intentId && run.record.intent_id && run.record.intent_id !== intentId) {
      throw new Error(`work run ${runId} is linked to a different intent`);
    }
    const now = new Date().toISOString();
    const event = await append({
      event_type: "run.execution_linked",
      stream_id: runStream(runId),
      occurred_at: now,
      actor: actor(input.actor, "gateway"),
      correlation_id: runId,
      causation_id: text(input.broker_event_id, 160),
      idempotency_key: idem(input.idempotency_key, `${runId}:${agentRunId}`, "run.execution_linked"),
      payload: {
        run_id: runId,
        task_id: run.record.task_id || "",
        intent_id: intentId || run.record.intent_id || "",
        agent_run_id: agentRunId,
        broker_event_id: text(input.broker_event_id, 160),
        route_decision_id: text(input.route_decision_id, 160),
        context_pack_ref: text(input.context_pack_ref, 400),
        linked_at: now,
      },
    });
    if (event.payload?.agent_run_id && event.payload.agent_run_id !== agentRunId) {
      throw new Error(`work run ${runId} is already linked to ${event.payload.agent_run_id}`);
    }
    return event.payload;
  }

  async function recordExecutionResult(input = {}) {
    const runId = requireText(input.run_id, "run_id");
    const agentRunId = requireText(input.agent_run_id, "agent_run_id");
    const state = await collectState();
    const run = state.runs.get(runId);
    if (!run) throw new Error(`work run not found: ${runId}`);
    if (!run.record.execution_run_id) throw new Error(`work run ${runId} has no linked agent run`);
    if (run.record.execution_run_id !== agentRunId) {
      throw new Error(`work run ${runId} result came from an unlinked agent run`);
    }
    const terminalStatus = String(input.status || "");
    const baseKey = text(input.idempotency_key, 240) || `execution:${agentRunId}`;
    if (run.record.task_id) {
      await setTaskStatus(run.record.task_id, "active", `agent run ${agentRunId} produced a terminal result`, `${baseKey}:task-active`);
    }
    await appendRunEvent({
      run_id: runId,
      type: "run.started",
      summary: `linked agent run ${agentRunId} executed`,
      idempotency_key: `${baseKey}:started`,
      detail: { agent_run_id: agentRunId },
    });
    const type = terminalStatus === "completed"
      ? "run.output_proposed"
      : terminalStatus === "canceled" ? "run.canceled" : "run.failed";
    return appendRunEvent({
      run_id: runId,
      type,
      summary: text(input.summary, 2000) || `agent run ${agentRunId} ${terminalStatus || "finished"}`,
      artifact_refs: refs(input.artifact_refs),
      idempotency_key: `${baseKey}:result`,
      detail: {
        agent_run_id: agentRunId,
        agent_run_status: terminalStatus,
        exit_code: Number.isInteger(input.exit_code) ? input.exit_code : null,
      },
    });
  }

  return { linkExecutionRun, recordExecutionResult };
}

function runBlockingReason(run) {
  const pending = [...run.controls.values()].find((item) => item.status === "queued" || item.status === "claimed");
  if (pending) return `control request ${pending.control_id} (${pending.action}) awaiting worker receipt`;
  if (run.status === "queued") return "waiting for a worker to claim this run";
  if (run.status === "failed") {
    const verification = run.verifications.filter((item) => item.status === "failed").slice(-1)[0];
    return verification
      ? `verification failed: ${verification.command || verification.summary || verification.verification_id}`
      : "run failed";
  }
  return run.events.slice(-1)[0]?.event_type === "run.output_proposed"
    ? "output proposed; waiting on user review"
    : "";
}

module.exports = { createWorkHistoryCompletionBridge, runBlockingReason };
