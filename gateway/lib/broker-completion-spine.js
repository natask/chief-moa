"use strict";

const crypto = require("node:crypto");

function createBrokerCompletionSpine({ intentWorkflow, intentRuntime, workHistory, notificationInbox } = {}) {
  if (!intentWorkflow || typeof intentWorkflow.createWork !== "function") {
    throw new Error("broker completion spine requires the intent workflow");
  }
  if (!intentRuntime || typeof intentRuntime.transition !== "function"
    || typeof intentRuntime.claim !== "function"
    || typeof intentRuntime.recordProgress !== "function"
    || typeof intentRuntime.notify !== "function") {
    throw new Error("broker completion spine requires the intent runtime");
  }
  if (!workHistory || typeof workHistory.linkExecutionRun !== "function"
    || typeof workHistory.recordExecutionResult !== "function") {
    throw new Error("broker completion spine requires the work-history store");
  }
  // Optional. When present, a terminal agent result also posts a ping into the
  // shared cross-surface notification inbox (gateway/lib/intent-plane.js),
  // dependency-inverted the same way credential-autopilot bridges into the
  // device-tool hub: the spine stays correct with or without it, and a
  // notification-inbox failure never fails the completion it is reporting on.
  if (notificationInbox && typeof notificationInbox.createNotification !== "function") {
    throw new Error("notificationInbox must expose createNotification when supplied");
  }

  async function prepare({ event, decision, contextPack, body = {} } = {}) {
    requireRecord(event, "broker event");
    requireRecord(decision, "route decision");
    requireRecord(contextPack, "context pack");
    const sourceIdentity = bounded(event.source_turn_id || event.id, 160);
    if (!sourceIdentity) throw new Error("broker event needs a stable source identity");
    const contextPackRef = `broker-context-packs/${contextPack.id}.json`;
    const acceptanceContractRef = bounded(
      body.acceptance_contract_ref || body.acceptanceContractRef,
      400,
    ) || `broker://${event.id}/route/${decision.id}/acceptance`;
    const created = await intentWorkflow.createWork({
      objective: bounded(event.text, 2_000),
      title: bounded(event.text, 200),
      owner_hint: bounded(contextPack.principal_role || contextPack.launcher_profile_id, 200),
      session_id: bounded(event.session_id || event.conversation_id, 160),
      branch_id: bounded(event.branch_id, 160) || "default",
      turn_id: sourceIdentity,
      broker_event_id: bounded(event.id, 160),
      surface: bounded(event.source, 80) || "broker",
      project_id: bounded(event.project_id, 160),
      route_decision_id: bounded(decision.id, 160),
      context_pack_ref: contextPackRef,
      profile_version: bounded(event.profile_version, 160),
      harness_hint: bounded(contextPack.launcher?.harness, 80),
      acceptance_contract_ref: acceptanceContractRef,
      completion_criteria: [bounded(contextPack.expected_output || event.text, 2_000)],
      wants_run: true,
      actor: { kind: "user", id: bounded(event.source, 80) || "broker" },
    });
    if (!created.run) throw new Error("broker completion spine did not create a work run");
    return {
      intent_id: created.intent.intent_id,
      intent_revision: created.intent.version,
      intent_agent_id: deterministicId("agent", event.id),
      task_id: created.task.task_id,
      work_history_run_id: created.run.run_id,
      acceptance_contract_ref: acceptanceContractRef,
      branch_id: bounded(event.branch_id, 160) || "default",
      turn_id: sourceIdentity,
      broker_event_id: bounded(event.id, 160),
      route_decision_id: bounded(decision.id, 160),
      context_pack_ref: contextPackRef,
    };
  }

  async function activate(linkage, agentRun) {
    requireLinkage(linkage);
    requireRecord(agentRun, "agent run");
    await workHistory.linkExecutionRun({
      run_id: linkage.work_history_run_id,
      agent_run_id: agentRun.id,
      intent_id: linkage.intent_id,
      broker_event_id: linkage.broker_event_id,
      route_decision_id: linkage.route_decision_id,
      context_pack_ref: linkage.context_pack_ref,
      idempotency_key: `broker-spine:${linkage.broker_event_id}:execution-link`,
      actor: { kind: "gateway", id: "broker-completion-spine" },
    });
    await intentRuntime.transition(linkage.intent_id, {
      type: "intent.execution_started",
      next_step: "Review the linked agent result when it arrives.",
      run_refs: [
        `work-run://${linkage.work_history_run_id}`,
        `agent-run://${agentRun.id}`,
      ],
      idempotency_key: `broker-spine:${linkage.broker_event_id}:execution-started`,
      actor: { kind: "gateway", id: "broker-completion-spine" },
    });
    await intentRuntime.claim(linkage.intent_id, {
      agent_id: linkage.intent_agent_id,
      run_id: agentRun.id,
      lease_seconds: 86_400,
      idempotency_key: `broker-spine:${linkage.broker_event_id}:claim`,
      actor: { kind: "gateway", id: "broker-completion-spine" },
    });
    return { ...linkage, agent_run_id: agentRun.id };
  }

  async function complete(agentRun) {
    if (!agentRun || !agentRun.broker_event_id || !agentRun.intent_id
      || !agentRun.work_history_run_id || !agentRun.intent_agent_id) {
      return null;
    }
    const terminal = String(agentRun.status || "");
    if (!["completed", "failed", "timed-out", "canceled"].includes(terminal)) return null;
    const succeeded = terminal === "completed";
    const summary = resultSummary(agentRun, succeeded);
    const baseKey = `broker-spine:${agentRun.broker_event_id}:${agentRun.id}`;
    await workHistory.recordExecutionResult({
      run_id: agentRun.work_history_run_id,
      agent_run_id: agentRun.id,
      status: terminal,
      summary,
      exit_code: agentRun.exit_code,
      artifact_refs: agentRun.output_artifact_refs || [],
      idempotency_key: `${baseKey}:work-result`,
    });
    await intentRuntime.recordProgress(agentRun.intent_id, {
      agent_id: agentRun.intent_agent_id,
      run_id: agentRun.id,
      progress: succeeded
        ? "The linked agent produced output for review."
        : `The linked agent stopped with status ${terminal}.`,
      next_step: succeeded
        ? "Review the proposed output before marking the delivery intent complete."
        : "Inspect the failure and decide whether to retry or revise the intent.",
      blockers: succeeded ? [] : [{ summary }],
      artifact_refs: agentRun.output_artifact_refs || [],
      evidence_refs: [`agent-run://${agentRun.id}`, `work-run://${agentRun.work_history_run_id}`],
      idempotency_key: `${baseKey}:progress`,
      actor: { kind: "agent", id: agentRun.intent_agent_id },
    });
    const notificationId = deterministicId("notification", `${agentRun.intent_id}:${agentRun.id}:terminal`);
    const kind = succeeded ? "agent_output_ready" : "agent_run_stopped";
    const intent = await intentRuntime.notify(agentRun.intent_id, {
      notification_id: notificationId,
      run_id: agentRun.id,
      kind,
      summary,
      idempotency_key: `${baseKey}:notification`,
      actor: { kind: "gateway", id: "broker-completion-spine" },
    });
    if (notificationInbox) {
      try {
        // Priority tier for the delivery arbiter (voice-spine lane): this is a
        // background completion ping. It must never take the floor from an
        // in-flight reply or the user speaking; it only becomes visible once
        // the arbiter finds a safe gap, or lands silently in the inbox per the
        // user's own OS notification settings.
        await notificationInbox.createNotification({
          notification_id: notificationId,
          intent_id: agentRun.intent_id,
          kind,
          title: succeeded ? "Agent finished" : "Agent stopped",
          message: summary,
          // A stopped/failed run is the higher-urgency case; a completed run
          // producing output for review is the routine background case.
          silent: succeeded,
          idempotency_key: `${baseKey}:inbox`,
        });
      } catch {
        // Best-effort. The intent-runtime notification above is the durable
        // source of truth; the inbox entry can be repaired by an idempotent
        // retry of this same completion event.
      }
    }
    return {
      intent_id: agentRun.intent_id,
      work_history_run_id: agentRun.work_history_run_id,
      notification_id: notificationId,
      lifecycle_state: intent.lifecycle_state,
      pending_notification_count: intent.pending_notifications.length,
    };
  }

  return { prepare, activate, complete };
}

function resultSummary(run, succeeded) {
  const detail = bounded(succeeded ? run.output || run.stdout : run.error || run.stderr, 1_600);
  const prefix = succeeded
    ? `Agent run ${run.id} produced output for review.`
    : `Agent run ${run.id} ${String(run.status || "failed")}.`;
  return detail ? `${prefix} ${detail}` : prefix;
}

function deterministicId(prefix, source) {
  return `${prefix}_${crypto.createHash("sha256").update(String(source || "")).digest("hex").slice(0, 32)}`;
}

function bounded(value, max) {
  const result = String(value || "").trim();
  return result ? result.slice(0, max) : "";
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is required`);
  }
}

function requireLinkage(linkage) {
  requireRecord(linkage, "broker launch linkage");
  for (const key of ["intent_id", "intent_agent_id", "task_id", "work_history_run_id", "broker_event_id"]) {
    if (!linkage[key]) throw new Error(`broker launch linkage requires ${key}`);
  }
}

module.exports = { createBrokerCompletionSpine, deterministicId };
