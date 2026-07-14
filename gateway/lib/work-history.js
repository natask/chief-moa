"use strict";

// Voice work-history control plane store.
//
// Implements the durable evidence model from
// reference/openspec/changes/remote-hosted-gateway/voice-work-history-control-plane.md:
// work_task, queued agent runs, run lifecycle events, repo_snapshot_ref,
// diff_ref, verification_artifact, user_feedback, run_control_request, and
// deployment request/record state.
//
// Every record is stored as a canonical append-only product event through the
// injected event substrate (JSONL locally, Postgres when DATABASE_URL is set).
// All reads are projections folded from those events, so status, run-detail,
// and deployment-link views can always be rebuilt from the event log alone.
//
// The store creates and answers; it never executes. Queued runs stay inert
// until a worker claims them; control requests stay proposals until the owning
// worker receipts them; deployment records never flip to applied without an
// explicit promotion marker plus backup/restore evidence refs.

const crypto = require("node:crypto");

const TASK_STATUSES = Object.freeze(["proposed", "queued", "active", "blocked", "completed", "canceled", "failed"]);

const RUN_EVENT_TYPES = Object.freeze([
  "run.proposed",
  "run.queued",
  "run.claimed",
  "run.started",
  "run.context_pack_created",
  "run.feedback_attached",
  "run.control_requested",
  "run.control_claimed",
  "run.control_receipted",
  "run.checkpointed",
  "run.output_proposed",
  "run.verification_started",
  "run.verification_completed",
  "run.deployment_requested",
  "run.completed",
  "run.failed",
  "run.canceled",
]);

// Lifecycle events a worker may post directly through the run-event endpoint.
// Claim, control, snapshot, diff, verification, and feedback records travel
// through their dedicated operations so their evidence shape stays enforced.
const WORKER_POSTABLE_RUN_EVENTS = Object.freeze([
  "run.started",
  "run.context_pack_created",
  "run.checkpointed",
  "run.output_proposed",
  "run.completed",
  "run.failed",
  "run.canceled",
]);

const SNAPSHOT_ROLES = Object.freeze(["before", "after", "checkpoint"]);
const DIRTY_STATES = Object.freeze(["clean", "dirty", "unknown"]);
const VERIFICATION_STATUSES = Object.freeze(["passed", "failed", "skipped", "blocked"]);
const VERIFICATION_SURFACES = Object.freeze(["gateway", "android", "browser_extension", "workflow_docs", "deploy", "other"]);
const FEEDBACK_INTENTS = Object.freeze(["note", "correction", "requirement", "cancellation", "approval", "rejection", "question"]);
const FEEDBACK_STATUSES = Object.freeze(["attached", "queued_for_claim", "applied", "rejected"]);
const CONTROL_ACTIONS = Object.freeze(["cancel", "pause", "redirect"]);
const DEPLOYMENT_TARGETS = Object.freeze(["gateway", "android", "browser_extension", "website", "all", "other"]);
const DEPLOYMENT_MODES = Object.freeze(["preview", "applied", "artifact_only"]);
const DEPLOYMENT_STATUSES = Object.freeze(["requested", "building", "available", "applied", "failed", "superseded"]);
const DEPLOYMENT_REVIEW_DECISIONS = Object.freeze(["approved", "rejected"]);
const DEPLOYMENT_OPERATIONS = Object.freeze(["preview", "apply", "rollback"]);
const DEPLOYMENT_GUARD_STATUSES = Object.freeze(["pending", "ready", "blocked"]);
const UI_ROUTE_KINDS = Object.freeze(["task", "run", "diff", "verification", "deployment", "feedback"]);

const EVENT_LIST_LIMIT = 500;
const EVENT_REBUILD_LIMIT = 100_000;

function createWorkHistoryStore({ events }) {
  if (!events || typeof events.appendEvent !== "function" || typeof events.listEvents !== "function") {
    throw new Error("work-history store requires an event substrate with appendEvent/listEvents");
  }
  if (typeof events.withStreamLock !== "function") {
    throw new Error("work-history store requires atomic stream transition support");
  }

  async function deploymentTransition(requestId, transition) {
    return events.withStreamLock(`deployment:${requestId}`, async () => {
      const state = await collectState();
      const entry = state.deploymentRequests.get(requestId);
      if (!entry) throw new Error(`deployment request not found: ${requestId}`);
      return transition(entry);
    });
  }

  // --- write side: every mutation is one or more product events ------------

  async function createTask(input = {}) {
    const now = new Date().toISOString();
    const task = {
      task_id: id("wt"),
      title: text(input.title, 200) || text(input.objective, 200) || "untitled task",
      objective: text(input.objective, 4000) || text(input.title, 4000) || "untitled task",
      status: "queued",
      session_id: text(input.session_id, 160),
      branch_id: text(input.branch_id, 160) || "default",
      project_id: text(input.project_id, 160),
      subproject_id: text(input.subproject_id, 160),
      created_from_broker_event_id: text(input.created_from_broker_event_id, 160),
      created_from_turn_id: text(input.created_from_turn_id, 160),
      owner_hint: text(input.owner_hint, 200),
      linked_run_ids: [],
      acceptance_refs: refs(input.acceptance_refs),
      created_at: now,
    };
    const event = await append({
      event_type: "work.task.created",
      stream_id: taskStream(task.task_id),
      occurred_at: now,
      actor: actor(input.actor, "user"),
      correlation_id: task.created_from_turn_id || task.task_id,
      causation_id: task.created_from_broker_event_id,
      idempotency_key: idem(input.idempotency_key, input.created_from_turn_id, "task.created"),
      payload: task,
    });
    // Idempotent retry: the substrate returns the FIRST stored event for this
    // turn/operation, so a repeated voice turn yields the original task.
    return event.payload || task;
  }

  async function queueRun(input = {}) {
    const now = new Date().toISOString();
    const run = {
      run_id: id("wr"),
      task_id: text(input.task_id, 160),
      status: "queued",
      objective: text(input.objective || input.prompt, 8000),
      owner_hint: text(input.owner_hint, 200),
      harness_hint: text(input.harness_hint || input.harness, 80),
      session_id: text(input.session_id, 160),
      branch_id: text(input.branch_id, 160) || "default",
      project_id: text(input.project_id, 160),
      created_from_broker_event_id: text(input.created_from_broker_event_id, 160),
      created_from_turn_id: text(input.created_from_turn_id, 160),
      route_decision_id: text(input.route_decision_id, 160),
      context_pack_ref: text(input.context_pack_ref, 400),
      profile_version: text(input.profile_version, 160),
      created_at: now,
    };
    if (!run.objective) {
      throw new Error("objective is required to queue a run");
    }
    const queuedEvent = await append({
      event_type: "run.queued",
      stream_id: runStream(run.run_id),
      occurred_at: now,
      actor: actor(input.actor, "user"),
      correlation_id: run.created_from_turn_id || run.run_id,
      causation_id: run.created_from_broker_event_id,
      idempotency_key: idem(input.idempotency_key, input.created_from_turn_id, "run.queued"),
      payload: run,
    });
    const stored = queuedEvent.payload || run;
    if (stored.task_id) {
      await append({
        event_type: "work.task.run_linked",
        stream_id: taskStream(stored.task_id),
        occurred_at: now,
        actor: actor(input.actor, "gateway"),
        correlation_id: stored.created_from_turn_id || stored.run_id,
        idempotency_key: idem("", stored.run_id, "task.run_linked"),
        payload: { task_id: stored.task_id, run_id: stored.run_id },
      });
    }
    return stored;
  }

  // A worker claims the oldest queued run (or a named run). The claim is the
  // gate between durable intent and execution: nothing runs before it exists.
  async function claimRun({ worker_id: workerId, run_id: runId } = {}) {
    const worker = text(workerId, 160);
    if (!worker) {
      throw new Error("worker_id is required");
    }
    const state = await collectState();
    const target = runId
      ? state.runs.get(text(runId, 160))
      : [...state.runs.values()]
        .filter((run) => run.status === "queued")
        .sort((a, b) => String(a.record.created_at).localeCompare(String(b.record.created_at)))[0];
    if (!target) {
      return { run: null, claim: null };
    }
    if (target.status !== "queued") {
      throw new Error(`run ${target.record.run_id} is not claimable (status: ${target.status})`);
    }
    const now = new Date().toISOString();
    const claim = {
      run_id: target.record.run_id,
      worker_id: worker,
      claimed_at: now,
    };
    // The idempotency key is the run id + operation, so a retried or racing
    // claim returns the FIRST stored claim instead of double-claiming.
    const event = await append({
      event_type: "run.claimed",
      stream_id: runStream(target.record.run_id),
      occurred_at: now,
      actor: { kind: "worker", id: worker },
      correlation_id: target.record.run_id,
      idempotency_key: idem("", target.record.run_id, "run.claimed"),
      payload: claim,
    });
    if (event.payload?.worker_id && event.payload.worker_id !== worker) {
      throw new Error(`run ${target.record.run_id} was already claimed by ${event.payload.worker_id}`);
    }
    if (target.record.task_id) {
      await setTaskStatus(target.record.task_id, "active", `run ${target.record.run_id} claimed by ${worker}`);
    }
    return { run: target.record, claim: event.payload };
  }

  async function appendRunEvent(input = {}) {
    const runId = requireText(input.run_id, "run_id");
    const type = text(input.type || input.event_type, 80);
    if (!WORKER_POSTABLE_RUN_EVENTS.includes(type)) {
      throw new Error(`unsupported run event type: ${type || "(empty)"}; allowed: ${WORKER_POSTABLE_RUN_EVENTS.join(", ")}`);
    }
    const state = await collectState();
    const run = state.runs.get(runId);
    if (!run) {
      throw new Error(`work run not found: ${runId}`);
    }
    const now = new Date().toISOString();
    const event = await append({
      event_type: type,
      stream_id: runStream(runId),
      occurred_at: now,
      actor: actor(input.actor, input.worker_id ? "worker" : "gateway", input.worker_id),
      correlation_id: runId,
      idempotency_key: idem(input.idempotency_key, "", ""),
      payload: {
        run_id: runId,
        task_id: run.record.task_id || "",
        worker_id: text(input.worker_id, 160),
        summary: text(input.summary, 2000),
        artifact_refs: refs(input.artifact_refs),
        detail: plain(input.payload || input.detail),
      },
    });
    if (run.record.task_id) {
      if (type === "run.completed") {
        await setTaskStatus(run.record.task_id, "completed", `run ${runId} completed`);
      } else if (type === "run.failed") {
        await setTaskStatus(run.record.task_id, "blocked", `run ${runId} failed`);
      } else if (type === "run.canceled") {
        await setTaskStatus(run.record.task_id, "canceled", `run ${runId} canceled`);
      }
    }
    return event;
  }

  async function setTaskStatus(taskId, status, reason) {
    const safeStatus = TASK_STATUSES.includes(status) ? status : "active";
    return append({
      event_type: "work.task.status_changed",
      stream_id: taskStream(taskId),
      actor: { kind: "gateway", id: "work-history" },
      correlation_id: text(taskId, 160),
      payload: { task_id: text(taskId, 160), status: safeStatus, reason: text(reason, 400) },
    });
  }

  // Before/after codebase evidence. The before snapshot lands after claim and
  // before edits; the after snapshot lands after edits + verification. Dirty
  // state is a label; the payload never carries secrets or .env contents.
  async function recordSnapshot(input = {}) {
    const runId = requireText(input.run_id, "run_id");
    const role = SNAPSHOT_ROLES.includes(input.role) ? input.role : "checkpoint";
    const now = new Date().toISOString();
    const snapshot = {
      snapshot_id: id("snap"),
      run_id: runId,
      role,
      repo_id: text(input.repo_id, 200),
      repo_path_hint: text(input.repo_path_hint, 400),
      remote_url_hash: text(input.remote_url_hash, 200),
      branch: text(input.branch, 200),
      commit_sha: text(input.commit_sha, 80),
      head_ref: text(input.head_ref, 200),
      worktree_id: text(input.worktree_id, 200),
      dirty_state: DIRTY_STATES.includes(input.dirty_state) ? input.dirty_state : "unknown",
      tracked_change_summary: text(input.tracked_change_summary, 2000),
      submodule_refs: refs(input.submodule_refs),
      created_by_worker_id: text(input.created_by_worker_id || input.worker_id, 160),
      created_at: now,
      artifact_ref: text(input.artifact_ref, 400),
    };
    if (!snapshot.commit_sha) {
      throw new Error("commit_sha is required for a repo snapshot");
    }
    await append({
      event_type: "repo.snapshot.recorded",
      stream_id: runStream(runId),
      occurred_at: now,
      actor: { kind: "worker", id: snapshot.created_by_worker_id || "worker" },
      correlation_id: runId,
      idempotency_key: idem(input.idempotency_key, "", ""),
      payload: snapshot,
    });
    return snapshot;
  }

  async function recordDiff(input = {}) {
    const runId = requireText(input.run_id, "run_id");
    const state = await collectState();
    const run = state.runs.get(runId);
    if (!run) {
      throw new Error(`work run not found: ${runId}`);
    }
    const before = run.snapshots.filter((snap) => snap.role === "before").slice(-1)[0] || null;
    const after = run.snapshots.filter((snap) => snap.role === "after").slice(-1)[0] || null;
    const now = new Date().toISOString();
    const diff = {
      diff_id: id("diff"),
      run_id: runId,
      base_snapshot_id: text(input.base_snapshot_id, 160) || before?.snapshot_id || "",
      head_snapshot_id: text(input.head_snapshot_id, 160) || after?.snapshot_id || "",
      patch_artifact_ref: text(input.patch_artifact_ref, 400),
      changed_paths: Array.isArray(input.changed_paths) ? input.changed_paths.map((p) => text(p, 400)).filter(Boolean).slice(0, 500) : [],
      stats: {
        files: integer(input.stats?.files),
        insertions: integer(input.stats?.insertions),
        deletions: integer(input.stats?.deletions),
      },
      patch_id: text(input.patch_id || input.content_hash, 200),
      redaction_status: text(input.redaction_status, 80) || "unreviewed",
      created_by_worker_id: text(input.created_by_worker_id || input.worker_id, 160),
      created_at: now,
    };
    if (!diff.base_snapshot_id || !diff.head_snapshot_id) {
      throw new Error("a diff needs base and head snapshots (record before/after snapshots first)");
    }
    await append({
      event_type: "repo.diff.recorded",
      stream_id: runStream(runId),
      occurred_at: now,
      actor: { kind: "worker", id: diff.created_by_worker_id || "worker" },
      correlation_id: runId,
      idempotency_key: idem(input.idempotency_key, "", ""),
      payload: diff,
    });
    return diff;
  }

  async function recordVerification(input = {}) {
    const runId = requireText(input.run_id, "run_id");
    const now = new Date().toISOString();
    const verification = {
      verification_id: id("ver"),
      run_id: runId,
      task_id: text(input.task_id, 160),
      surface: VERIFICATION_SURFACES.includes(input.surface) ? input.surface : "other",
      command: text(input.command || input.check_name, 800),
      started_at: text(input.started_at, 40) || now,
      finished_at: text(input.finished_at, 40) || now,
      exit_code: Number.isInteger(input.exit_code) ? input.exit_code : null,
      status: VERIFICATION_STATUSES.includes(input.status) ? input.status : (input.exit_code === 0 ? "passed" : "failed"),
      summary: text(input.summary, 2000),
      stdout_ref: text(input.stdout_ref, 400),
      stderr_ref: text(input.stderr_ref, 400),
      extra_refs: refs(input.extra_refs),
      snapshot_id: text(input.snapshot_id, 160),
      diff_id: text(input.diff_id, 160),
      environment_ref: text(input.environment_ref, 400),
      created_by_worker_id: text(input.created_by_worker_id || input.worker_id, 160),
    };
    await append({
      event_type: "run.verification_completed",
      stream_id: runStream(runId),
      occurred_at: verification.finished_at,
      actor: { kind: "worker", id: verification.created_by_worker_id || "worker" },
      correlation_id: runId,
      idempotency_key: idem(input.idempotency_key, "", ""),
      payload: verification,
    });
    return verification;
  }

  // Feedback is evidence, not control. It attaches without canceling; only an
  // explicit cancellation/pause intent creates a claimable run_control_request.
  async function attachFeedback(input = {}) {
    const now = new Date().toISOString();
    const intent = FEEDBACK_INTENTS.includes(input.intent) ? input.intent : "note";
    const targets = normalizeFeedbackTargets(input.targets || input.target_refs);
    const state = await collectState();
    if (targets.length === 0) {
      // Default to the most recently active run so "that result is wrong" lands
      // on the work the user is talking about.
      const active = [...state.runs.values()]
        .filter((run) => !isTerminalRunStatus(run.status))
        .sort((a, b) => String(b.latest_event_at).localeCompare(String(a.latest_event_at)))[0];
      if (active) {
        targets.push({ type: "run", id: active.record.run_id });
      }
    }
    if (targets.length === 0) {
      throw new Error("no feedback target: name a run/task id or have active work");
    }

    const feedback = {
      feedback_id: id("fb"),
      source_turn_id: text(input.source_turn_id, 160),
      source_broker_event_id: text(input.source_broker_event_id, 160),
      target_refs: targets,
      intent,
      urgency: text(input.urgency, 40) || "normal",
      transcript: text(input.transcript || input.text, 8000),
      summary: text(input.summary, 2000) || text(input.transcript || input.text, 2000),
      routing_decision_ids: Array.isArray(input.routing_decision_ids)
        ? input.routing_decision_ids.map((v) => text(v, 160)).filter(Boolean).slice(0, 20)
        : [],
      status: intent === "cancellation" ? "queued_for_claim" : "attached",
      created_at: now,
    };

    const primary = targets[0];
    const feedbackEvent = await append({
      event_type: "user_feedback.recorded",
      stream_id: streamForTarget(primary),
      occurred_at: now,
      actor: actor(input.actor, "user"),
      correlation_id: feedback.source_turn_id || feedback.feedback_id,
      causation_id: feedback.source_broker_event_id,
      idempotency_key: idem(input.idempotency_key, feedback.source_turn_id, "feedback.recorded"),
      payload: feedback,
    });
    const storedFeedback = feedbackEvent.payload || feedback;

    const controls = [];
    for (const target of targets) {
      if (target.type !== "run") continue;
      await append({
        event_type: "run.feedback_attached",
        stream_id: runStream(target.id),
        occurred_at: now,
        actor: actor(input.actor, "user"),
        correlation_id: storedFeedback.source_turn_id || storedFeedback.feedback_id,
        idempotency_key: idem("", `${storedFeedback.feedback_id}:${target.id}`, "run.feedback_attached"),
        payload: {
          run_id: target.id,
          feedback_id: storedFeedback.feedback_id,
          intent,
          summary: storedFeedback.summary,
        },
      });
      if (intent === "cancellation") {
        controls.push(await createControlRequest({
          run_id: target.id,
          action: CONTROL_ACTIONS.includes(input.control_action) ? input.control_action : "cancel",
          reason: storedFeedback.summary,
          feedback_id: storedFeedback.feedback_id,
          source_turn_id: storedFeedback.source_turn_id,
          actor: input.actor,
        }));
      }
    }
    return { feedback: storedFeedback, control_requests: controls };
  }

  // Pause/cancel/redirect is a proposal the owning worker claims and receipts.
  // The gateway never flips a run to canceled on its own here.
  async function createControlRequest(input = {}) {
    const runId = requireText(input.run_id, "run_id");
    const now = new Date().toISOString();
    const control = {
      control_id: id("ctl"),
      run_id: runId,
      action: CONTROL_ACTIONS.includes(input.action) ? input.action : "cancel",
      reason: text(input.reason, 2000),
      feedback_id: text(input.feedback_id, 160),
      source_turn_id: text(input.source_turn_id, 160),
      status: "queued",
      created_at: now,
    };
    const controlEvent = await append({
      event_type: "run.control_requested",
      stream_id: runStream(runId),
      occurred_at: now,
      actor: actor(input.actor, "user"),
      correlation_id: control.source_turn_id || control.control_id,
      idempotency_key: idem(input.idempotency_key, control.source_turn_id, `run.control_requested:${control.action}`),
      payload: control,
    });
    return controlEvent.payload || control;
  }

  async function claimControlRequest({ control_id: controlId, worker_id: workerId } = {}) {
    const worker = requireText(workerId, "worker_id");
    const safeId = requireText(controlId, "control_id");
    const state = await collectState();
    const found = findControl(state, safeId);
    if (!found) {
      throw new Error(`control request not found: ${safeId}`);
    }
    if (found.control.status !== "queued") {
      throw new Error(`control request ${safeId} is not claimable (status: ${found.control.status})`);
    }
    const now = new Date().toISOString();
    const event = await append({
      event_type: "run.control_claimed",
      stream_id: runStream(found.runId),
      occurred_at: now,
      actor: { kind: "worker", id: worker },
      correlation_id: safeId,
      idempotency_key: idem("", safeId, "run.control_claimed"),
      payload: { control_id: safeId, run_id: found.runId, worker_id: worker, claimed_at: now },
    });
    if (event.payload?.worker_id && event.payload.worker_id !== worker) {
      throw new Error(`control request ${safeId} was already claimed by ${event.payload.worker_id}`);
    }
    return { control_id: safeId, run_id: found.runId, worker_id: worker, status: "claimed" };
  }

  async function receiptControlRequest({ control_id: controlId, worker_id: workerId, decision, reason } = {}) {
    const worker = requireText(workerId, "worker_id");
    const safeId = requireText(controlId, "control_id");
    const state = await collectState();
    const found = findControl(state, safeId);
    if (!found) {
      throw new Error(`control request not found: ${safeId}`);
    }
    const safeDecision = decision === "rejected" ? "rejected" : "applied";
    const now = new Date().toISOString();
    await append({
      event_type: "run.control_receipted",
      stream_id: runStream(found.runId),
      occurred_at: now,
      actor: { kind: "worker", id: worker },
      correlation_id: safeId,
      idempotency_key: idem("", safeId, "run.control_receipted"),
      payload: {
        control_id: safeId,
        run_id: found.runId,
        worker_id: worker,
        decision: safeDecision,
        reason: text(reason, 2000),
        receipted_at: now,
      },
    });
    if (safeDecision === "applied" && found.control.action === "cancel") {
      await appendRunEvent({
        run_id: found.runId,
        type: "run.canceled",
        worker_id: worker,
        summary: `canceled via control request ${safeId}`,
      });
    }
    return { control_id: safeId, run_id: found.runId, decision: safeDecision };
  }

  async function requestDeployment(input = {}) {
    const now = new Date().toISOString();
    const request = {
      request_id: id("dreq"),
      target: DEPLOYMENT_TARGETS.includes(input.target) ? input.target : "other",
      mode: input.mode === "artifact_only" ? "artifact_only" : "preview",
      run_id: text(input.run_id, 160),
      task_id: text(input.task_id, 160),
      branch: deploymentString(input.branch, "branch", 200),
      commit_sha: deploymentString(input.commit_sha, "commit_sha", 80),
      reason: text(input.reason, 2000),
      adapter_kind: text(input.adapter_kind, 80) || "deterministic_fake",
      candidate_refs: deploymentCandidateRefs(input.candidate_refs || input.candidates),
      artifact_refs: deploymentRefs(input.artifact_refs, "artifact_refs"),
      provenance_ref: deploymentRef(input.provenance_ref, "provenance_ref"),
      source_turn_id: text(input.source_turn_id, 160),
      review_status: "pending",
      status: "requested",
      created_at: now,
    };
    request.request_fingerprint = deploymentPayloadDigest("request", {
      target: request.target,
      mode: request.mode,
      run_id: request.run_id,
      task_id: request.task_id,
      branch: request.branch,
      commit_sha: request.commit_sha,
      reason: request.reason,
      adapter_kind: request.adapter_kind,
      candidate_refs: request.candidate_refs,
      artifact_refs: request.artifact_refs,
      provenance_ref: request.provenance_ref,
      source_turn_id: request.source_turn_id,
    });
    const requestEvent = await append({
      event_type: "deployment.requested",
      stream_id: `deployment:${request.request_id}`,
      occurred_at: now,
      actor: actor(input.actor, "user"),
      correlation_id: request.source_turn_id || request.request_id,
      idempotency_key: deploymentIdem("requested", request.source_turn_id || request.request_id),
      payload: request,
    });
    const storedRequest = requestEvent.payload || request;
    assertDeploymentReturnedEvent(requestEvent, "deployment.requested", {
      source_turn_id: request.source_turn_id,
      target: request.target,
      request_fingerprint: request.request_fingerprint,
    });
    if (storedRequest.run_id) {
      await append({
        event_type: "run.deployment_requested",
        stream_id: runStream(storedRequest.run_id),
        occurred_at: now,
        actor: actor(input.actor, "user"),
        correlation_id: storedRequest.request_id,
        payload: { run_id: storedRequest.run_id, request_id: storedRequest.request_id, target: storedRequest.target, mode: storedRequest.mode },
      });
    }
    return storedRequest;
  }

  async function reviewDeploymentRequest(input = {}) {
    const requestId = requireText(input.request_id, "request_id");
    const decision = DEPLOYMENT_REVIEW_DECISIONS.includes(input.decision) ? input.decision : "rejected";
    const state = await collectState();
    const entry = state.deploymentRequests.get(requestId);
    if (!entry) {
      throw new Error(`deployment request not found: ${requestId}`);
    }
    const existing = entry.review;
    if (existing && existing.decision && existing.decision !== decision) {
      throw new Error(`deployment request ${requestId} already reviewed as ${existing.decision}`);
    }
    const now = new Date().toISOString();
    const event = await append({
      event_type: "deployment.reviewed",
      stream_id: `deployment:${requestId}`,
      occurred_at: now,
      actor: actor(input.actor, "user"),
      correlation_id: requestId,
      idempotency_key: deploymentIdem("reviewed", requestId),
      payload: {
        request_id: requestId,
        decision,
        reason: text(input.reason, 2000),
        reviewed_by_actor: text(input.reviewed_by_actor || input.actor?.id, 200),
        reviewed_at: now,
      },
    });
    if (event.payload?.decision && event.payload.decision !== decision) {
      throw new Error(`deployment request ${requestId} was already reviewed as ${event.payload.decision}`);
    }
    assertDeploymentReturnedEvent(event, "deployment.reviewed", { request_id: requestId, decision });
    return deploymentRequestDetail(requestId);
  }

  async function claimDeploymentRequest(input = {}) {
    const requestId = requireText(input.request_id, "request_id");
    const worker = requireText(input.worker_id, "worker_id");
    const operation = DEPLOYMENT_OPERATIONS.includes(input.operation) ? input.operation : "preview";
    return deploymentTransition(requestId, async (entry) => {
      assertDeploymentOperationClaimable(entry, operation);
      const now = new Date().toISOString();
      const claimId = text(input.claim_id, 160) || id("dclm");
      const event = await append({
      event_type: "deployment.claimed",
      stream_id: `deployment:${requestId}`,
      occurred_at: now,
      actor: { kind: "worker", id: worker },
      correlation_id: requestId,
      idempotency_key: deploymentIdem("claimed", requestId, operation, claimId),
      payload: {
        request_id: requestId,
        operation,
        worker_id: worker,
        claim_id: claimId,
        claimed_at: now,
        lease_expires_at: iso(input.lease_expires_at || input.leaseExpiresAt, ""),
      },
      });
      if (event.payload?.worker_id && event.payload.worker_id !== worker) {
        throw new Error(`deployment request ${requestId} ${operation} already claimed by ${event.payload.worker_id}`);
      }
      assertDeploymentReturnedEvent(event, "deployment.claimed", { request_id: requestId, operation, claim_id: claimId, worker_id: worker });
      return event.payload;
    });
  }

  async function adoptDeploymentOperationEffect(input = {}) {
    const requestId = requireText(input.request_id, "request_id");
    const operation = DEPLOYMENT_OPERATIONS.includes(input.operation) ? input.operation : "apply";
    const worker = requireText(input.worker_id, "worker_id");
    const effectId = requireText(input.effect_id, "effect_id");
    const claimId = requireText(input.claim_id, "claim_id");
    return deploymentTransition(requestId, async (entry) => {
    const observed = currentDeploymentEffect(entry, operation, effectId);
    if (!observed) {
      throw new Error(`deployment ${operation} effect ${effectId} not observed for request ${requestId}`);
    }
    if (entry.receipts.get(operation)) {
      throw new Error(`deployment request ${requestId} ${operation} already has an immutable receipt`);
    }
    let claim = currentDeploymentClaim(entry, operation);
    if (claim && !isClaimExpired(claim) && (claim.worker_id !== worker || claim.claim_id !== claimId)) {
      throw new Error(`deployment request ${requestId} ${operation} original effect claim is still active`);
    }
    if (!claim || claim.worker_id !== worker || claim.claim_id !== claimId) {
      const claimedAt = new Date().toISOString();
      const claimEvent = await append({
        event_type: "deployment.claimed",
        stream_id: `deployment:${requestId}`,
        occurred_at: claimedAt,
        actor: { kind: "worker", id: worker },
        correlation_id: requestId,
        idempotency_key: deploymentIdem("claimed.recovery", requestId, operation, effectId, claimId),
        payload: {
          request_id: requestId,
          operation,
          worker_id: worker,
          claim_id: claimId,
          claimed_at: claimedAt,
          lease_expires_at: iso(input.lease_expires_at || input.leaseExpiresAt, ""),
        },
      });
      assertDeploymentReturnedEvent(claimEvent, "deployment.claimed", {
        request_id: requestId,
        operation,
        worker_id: worker,
        claim_id: claimId,
      });
      claim = claimEvent.payload || claimEvent;
    }
    assertDeploymentOperationClaim(entry, { operation, worker, claim_id: claimId, claim, require_fresh: true });
    if (observed.worker_id === worker && observed.claim_id === claimId) {
      throw new Error(`deployment ${operation} effect ${effectId} already belongs to the active claim`);
    }
    const now = new Date().toISOString();
    const event = await append({
      event_type: "deployment.effect_adopted",
      stream_id: `deployment:${requestId}`,
      occurred_at: now,
      actor: { kind: "worker", id: worker },
      correlation_id: requestId,
      idempotency_key: deploymentIdem("effect_adopted", requestId, operation, effectId, claimId),
      payload: {
        request_id: requestId,
        operation,
        effect_id: effectId,
        observed_worker_id: observed.worker_id,
        observed_claim_id: observed.claim_id,
        adopted_by_worker_id: worker,
        adopted_claim_id: claimId,
        reason: text(input.reason, 2000),
        adopted_at: now,
      },
    });
    assertDeploymentReturnedEvent(event, "deployment.effect_adopted", {
      request_id: requestId,
      operation,
      effect_id: effectId,
      adopted_by_worker_id: worker,
      adopted_claim_id: claimId,
    });
      return deploymentRequestDetail(requestId);
    });
  }

  // Intentionally not wrapped in deploymentTransition: this is an
  // idempotency-keyed append-only observation, not a read-modify-write of the
  // request's lifecycle state, so it does not need the per-stream lock.
  async function recordDeploymentVerification(input = {}) {
    const requestId = requireText(input.request_id, "request_id");
    const state = await collectState();
    const entry = state.deploymentRequests.get(requestId);
    if (!entry) {
      throw new Error(`deployment request not found: ${requestId}`);
    }
    const operation = DEPLOYMENT_OPERATIONS.includes(input.operation) ? input.operation : "preview";
    const worker = deploymentString(input.created_by_worker_id || input.worker_id, "worker_id", 160, true);
    const claimId = deploymentString(input.claim_id, "claim_id", 160, true);
    const claim = currentDeploymentClaim(entry, operation);
    assertDeploymentOperationClaim(entry, { operation, worker, claim_id: claimId, claim, require_fresh: true });
    const deploymentId = deploymentString(input.deployment_id, "deployment_id", 160, true);
    if (operation === "preview") {
      const preview = latestPreviewRecord(entry);
      if (!preview || preview.deployment_id !== deploymentId) {
        throw new Error(`deployment verification must target the current preview deployment ${preview?.deployment_id || "(missing)"}`);
      }
      if (preview.claim_id !== claimId || preview.worker_id !== worker) {
        throw new Error(`deployment verification must match the current preview claim and worker`);
      }
    }
    const now = new Date().toISOString();
    const verificationId = deploymentString(input.verification_id, "verification_id", 160) || id("dver");
    const verification = {
      verification_id: verificationId,
      request_id: requestId,
      deployment_id: deploymentId,
      operation,
      surface: VERIFICATION_SURFACES.includes(input.surface) ? input.surface : "deploy",
      command: text(input.command || input.check_name, 800),
      started_at: iso(input.started_at || input.startedAt, now) || now,
      finished_at: iso(input.finished_at || input.finishedAt, now) || now,
      exit_code: Number.isInteger(input.exit_code) ? input.exit_code : null,
      status: VERIFICATION_STATUSES.includes(input.status) ? input.status : (input.exit_code === 0 ? "passed" : "failed"),
      summary: text(input.summary, 2000),
      stdout_ref: deploymentRef(input.stdout_ref, "stdout_ref"),
      stderr_ref: deploymentRef(input.stderr_ref, "stderr_ref"),
      extra_refs: deploymentRefs(input.extra_refs, "extra_refs"),
      created_by_worker_id: worker,
      claim_id: claimId,
    };
    const event = await append({
      event_type: "deployment.verification_recorded",
      stream_id: `deployment:${requestId}`,
      occurred_at: verification.finished_at,
      actor: { kind: "worker", id: verification.created_by_worker_id || "worker" },
      correlation_id: requestId,
      idempotency_key: deploymentIdem("verification", requestId, operation, deploymentId, claimId, verificationId),
      payload: verification,
    });
    assertDeploymentReturnedEvent(event, "deployment.verification_recorded", { request_id: requestId, operation, deployment_id: deploymentId, claim_id: claimId, created_by_worker_id: worker, status: verification.status });
    return event.payload || verification;
  }

  async function observeDeploymentOperationEffect(input = {}) {
    const requestId = requireText(input.request_id, "request_id");
    const operation = DEPLOYMENT_OPERATIONS.includes(input.operation) ? input.operation : "apply";
    const worker = requireText(input.worker_id, "worker_id");
    const effectId = requireText(input.effect_id, "effect_id");
    const claimId = requireText(input.claim_id, "claim_id");
    return deploymentTransition(requestId, async (entry) => {
      const claim = currentDeploymentClaim(entry, operation);
      assertDeploymentOperationClaim(entry, { operation, worker, claim_id: claimId, claim, require_fresh: true });
      assertDeploymentEffectAllowed(entry, operation);
      const now = new Date().toISOString();
      const latestApplied = latestAppliedRecord(entry);
      const observed = {
      effect_id: effectId,
      request_id: requestId,
      operation,
      worker_id: worker,
      claim_id: claimId,
      deployment_id: text(input.deployment_id, 160) || latestApplied?.deployment_id || id("dep"),
      target: DEPLOYMENT_TARGETS.includes(input.target) ? input.target : entry.request.target || "other",
      candidate_id: text(input.candidate_id, 160),
      preview_url: deploymentUrl(input.preview_url, "preview_url"),
      active_url: deploymentUrl(input.active_url, "active_url"),
      artifact_refs: deploymentRefs(input.artifact_refs, "artifact_refs"),
      backup_record_ref: deploymentRef(input.backup_record_ref, "backup_record_ref"),
      restore_check_ref: deploymentRef(input.restore_check_ref, "restore_check_ref"),
      smoke_artifact_ref: deploymentRef(input.smoke_artifact_ref, "smoke_artifact_ref"),
      rollback_ref: deploymentRef(input.rollback_ref || input.rollback_to_ref, "rollback_ref"),
      drain_status: text(input.drain_status, 80),
      compatibility_status: text(input.compatibility_status, 80),
      summary: text(input.summary, 2000),
      observed_at: now,
      };
      assertDeploymentObservedEffect(entry, observed);
      const event = await append({
      event_type: "deployment.effect_observed",
      stream_id: `deployment:${requestId}`,
      occurred_at: now,
      actor: { kind: "worker", id: worker },
      correlation_id: requestId,
      idempotency_key: deploymentIdem("effect", requestId, operation, effectId),
      payload: observed,
      });
      assertDeploymentReturnedEvent(event, "deployment.effect_observed", { request_id: requestId, operation, effect_id: effectId, claim_id: claimId, worker_id: worker });
      return event.payload || observed;
    });
  }

  async function receiptDeploymentOperation(input = {}) {
    const requestId = requireText(input.request_id, "request_id");
    const operation = DEPLOYMENT_OPERATIONS.includes(input.operation) ? input.operation : "apply";
    const worker = requireText(input.worker_id, "worker_id");
    const claimId = requireText(input.claim_id, "claim_id");
    const effectId = requireText(input.effect_id, "effect_id");
    return deploymentTransition(requestId, async (entry) => {
    const observed = currentDeploymentEffect(entry, operation, effectId);
    if (!observed) {
      throw new Error(`deployment ${operation} effect ${effectId} not observed for request ${requestId}`);
    }
    const claim = currentDeploymentClaim(entry, operation);
    assertDeploymentReceiptAuthority(entry, { operation, worker, claimId, claim, observed });
    const now = new Date().toISOString();
    const decision = operation === "rollback" ? "rolled_back" : "applied";
    const receiptEvent = await append({
      event_type: "deployment.receipted",
      stream_id: `deployment:${requestId}`,
      occurred_at: now,
      actor: { kind: "worker", id: worker },
      correlation_id: requestId,
      idempotency_key: deploymentIdem("receipt", requestId, operation),
      payload: {
        receipt_id: text(input.receipt_id, 160) || id("drct"),
        request_id: requestId,
        operation,
        worker_id: worker,
        claim_id: claimId,
        effect_id: effectId,
        decision,
        deployment_id: observed.deployment_id,
        reason: text(input.reason, 2000),
        receipted_at: now,
      },
    });
    if (receiptEvent.payload?.effect_id && receiptEvent.payload.effect_id !== effectId) {
      throw new Error(`deployment request ${requestId} ${operation} already receipted for a different effect`);
    }
    assertDeploymentReturnedEvent(receiptEvent, "deployment.receipted", { request_id: requestId, operation, effect_id: effectId });
    if (operation === "apply") {
      await recordDeployment({
        deployment_id: observed.deployment_id,
        request_id: requestId,
        target: observed.target || entry.request.target,
        mode: "applied",
        status: "applied",
        commit_sha: entry.request.commit_sha || "",
        artifact_refs: observed.artifact_refs,
        active_url: observed.active_url,
        deployment_control_plane: entry.request.adapter_kind || "deterministic_fake",
        backup_record_ref: observed.backup_record_ref,
        restore_check_ref: observed.restore_check_ref,
        smoke_artifact_ref: observed.smoke_artifact_ref,
        smoke_status: observed.smoke_artifact_ref ? "passed" : "",
        applied_by_actor: worker,
        worker_id: worker,
        claim_id: claimId,
        applied_at: now,
        explicit_promotion: true,
        from_receipt: true,
        receipt_id: receiptEvent.payload.receipt_id,
        actor: { kind: "worker", id: worker },
        idempotency_key: deploymentIdem("recorded", requestId, operation),
      });
    } else if (operation === "rollback") {
      await recordDeployment({
        deployment_id: observed.deployment_id,
        request_id: requestId,
        target: observed.target || entry.request.target,
        mode: "applied",
        status: "superseded",
        commit_sha: entry.request.commit_sha || "",
        artifact_refs: observed.artifact_refs,
        active_url: observed.active_url,
        deployment_control_plane: entry.request.adapter_kind || "deterministic_fake",
        smoke_artifact_ref: observed.smoke_artifact_ref,
        smoke_status: observed.smoke_artifact_ref ? "passed" : "",
        applied_by_actor: worker,
        worker_id: worker,
        claim_id: claimId,
        applied_at: latestAppliedRecord(entry)?.applied_at || "",
        actor: { kind: "worker", id: worker },
        receipt_id: receiptEvent.payload.receipt_id,
        idempotency_key: deploymentIdem("recorded", requestId, operation),
      });
    }
      return deploymentRequestDetail(requestId);
    });
  }

  // Deployment state is a record posted by the owning deploy worker/control
  // plane. Preview availability is not promotion: an applied record demands the
  // explicit promotion marker plus backup + restore-check evidence refs.
  async function recordDeployment(input = {}) {
    const now = new Date().toISOString();
    const mode = DEPLOYMENT_MODES.includes(input.mode) ? input.mode : "preview";
    const status = DEPLOYMENT_STATUSES.includes(input.status) ? input.status : "available";
    const requestId = text(input.request_id, 160);
    if ((mode === "applied" || status === "applied") && !requestId) {
      throw new Error("applied deployment records require a guarded request_id");
    }
    if (requestId) {
      const state = await collectState();
      const entry = state.deploymentRequests.get(requestId);
      if (!entry) {
        throw new Error(`deployment request not found: ${requestId}`);
      }
      if (mode === "preview") {
        const worker = deploymentString(input.worker_id || input.applied_by_actor, "worker_id", 160, true);
        const claimId = deploymentString(input.claim_id, "claim_id", 160, true);
        assertDeploymentOperationClaim(entry, { operation: "preview", worker, claim_id: claimId, claim: currentDeploymentClaim(entry, "preview"), require_fresh: true });
      }
      if (status === "applied" && input.from_receipt !== true) {
        throw new Error(`deployment request ${requestId} applied state must be recorded through an immutable receipt`);
      }
    }
    const record = {
      deployment_id: text(input.deployment_id, 160) || id("dep"),
      request_id: requestId,
      target: DEPLOYMENT_TARGETS.includes(input.target) ? input.target : "other",
      mode,
      status,
      run_id: text(input.run_id, 160),
      commit_sha: text(input.commit_sha, 80),
      artifact_refs: deploymentRefs(input.artifact_refs, "artifact_refs"),
      preview_url: deploymentUrl(input.preview_url, "preview_url"),
      active_url: deploymentUrl(input.active_url, "active_url"),
      build_id: text(input.build_id, 200),
      deployment_control_plane: text(input.deployment_control_plane, 80) || "script",
      backup_record_ref: deploymentRef(input.backup_record_ref, "backup_record_ref"),
      restore_check_ref: deploymentRef(input.restore_check_ref, "restore_check_ref"),
      smoke_artifact_ref: deploymentRef(input.smoke_artifact_ref, "smoke_artifact_ref"),
      smoke_status: text(input.smoke_status, 80),
      candidate_id: text(input.candidate_id, 160),
      provenance_ref: deploymentRef(input.provenance_ref, "provenance_ref"),
      rollback_ref: deploymentRef(input.rollback_ref, "rollback_ref"),
      receipt_id: text(input.receipt_id, 160),
      claim_id: deploymentString(input.claim_id, "claim_id", 160),
      worker_id: deploymentString(input.worker_id || input.applied_by_actor, "worker_id", 160),
      applied_by_actor: text(input.applied_by_actor, 200),
      applied_at: text(input.applied_at, 40),
      recorded_at: now,
    };
    if (status === "applied") {
      if (input.explicit_promotion !== true) {
        throw new Error("an applied deployment record requires explicit_promotion: true from a current-turn user promotion");
      }
      if (!record.backup_record_ref || !record.restore_check_ref) {
        throw new Error("an applied deployment record requires backup_record_ref and restore_check_ref evidence");
      }
    }
    const event = await append({
      event_type: "deployment.recorded",
      stream_id: `deployment:${record.deployment_id}`,
      occurred_at: now,
      actor: actor(input.actor, "worker"),
      correlation_id: record.request_id || record.deployment_id,
      idempotency_key: deploymentIdem(
        "recorded",
        record.request_id || "standalone",
        record.mode,
        record.status,
        record.deployment_id,
        record.receipt_id || "none",
        record.claim_id || "none",
        record.worker_id || "none",
      ),
      payload: record,
    });
    assertDeploymentReturnedEvent(event, "deployment.recorded", {
      deployment_id: record.deployment_id,
      request_id: record.request_id,
      status: record.status,
      receipt_id: record.receipt_id,
      claim_id: record.claim_id,
      worker_id: record.worker_id,
    });
    return event.payload || record;
  }

  // --- read side: projections folded from the event log --------------------

  async function collectState() {
    const all = await listAllEvents();
    const tasks = new Map();
    const runs = new Map();
    const deployments = new Map();
    const deploymentRequests = new Map();
    const feedback = [];

    const ensureRun = (runId) => {
      if (!runs.has(runId)) {
        runs.set(runId, {
          record: { run_id: runId },
          status: "queued",
          claim: null,
          events: [],
          snapshots: [],
          diffs: [],
          verifications: [],
          feedback: [],
          controls: new Map(),
          deployment_request_ids: [],
          latest_event_at: "",
          latest_summary: "",
        });
      }
      return runs.get(runId);
    };

    const ensureDeploymentRequest = (requestId) => {
      if (!deploymentRequests.has(requestId)) {
        deploymentRequests.set(requestId, {
          request: { request_id: requestId },
          review: null,
          claims: new Map(),
          verifications: [],
          effects: new Map(),
          effect_adoptions: [],
          receipts: new Map(),
          records: [],
          latest_event_at: "",
        });
      }
      return deploymentRequests.get(requestId);
    };

    for (const event of all) {
      const type = event.event_type;
      const payload = event.payload || {};
      if (type === "work.task.created") {
        tasks.set(payload.task_id, {
          record: payload,
          status: payload.status || "queued",
          status_reason: "",
          linked_run_ids: [],
          latest_event_at: event.recorded_at,
        });
        continue;
      }
      if (type === "work.task.status_changed") {
        const task = tasks.get(payload.task_id);
        if (task) {
          task.status = payload.status || task.status;
          task.status_reason = payload.reason || "";
          task.latest_event_at = event.recorded_at;
        }
        continue;
      }
      if (type === "work.task.run_linked") {
        const task = tasks.get(payload.task_id);
        if (task && payload.run_id && !task.linked_run_ids.includes(payload.run_id)) {
          task.linked_run_ids.push(payload.run_id);
          task.latest_event_at = event.recorded_at;
        }
        continue;
      }
      if (type === "run.queued") {
        const run = ensureRun(payload.run_id);
        run.record = payload;
        run.status = "queued";
        run.events.push(eventSummary(event));
        run.latest_event_at = event.recorded_at;
        continue;
      }
      if (type.startsWith("run.") || type.startsWith("repo.") || type === "user_feedback.recorded") {
        const runId = payload.run_id
          || (type === "user_feedback.recorded" && event.stream_id.startsWith("work-run:") ? event.stream_id.slice("work-run:".length) : "");
        if (type === "user_feedback.recorded") {
          feedback.push(payload);
          if (runId) {
            ensureRun(runId).feedback.push(payload);
          }
          continue;
        }
        if (!runId) continue;
        const run = ensureRun(runId);
        run.events.push(eventSummary(event));
        run.latest_event_at = event.recorded_at;
        if (payload.summary) run.latest_summary = payload.summary;
        if (type === "run.claimed") {
          run.claim = payload;
          run.status = "claimed";
        } else if (type === "run.started") {
          run.status = "running";
        } else if (type === "run.completed") {
          run.status = "completed";
        } else if (type === "run.failed") {
          run.status = "failed";
        } else if (type === "run.canceled") {
          run.status = "canceled";
        } else if (type === "repo.snapshot.recorded") {
          run.snapshots.push(payload);
        } else if (type === "repo.diff.recorded") {
          run.diffs.push(payload);
        } else if (type === "run.verification_completed") {
          run.verifications.push(payload);
        } else if (type === "run.control_requested") {
          run.controls.set(payload.control_id, { ...payload, status: "queued" });
        } else if (type === "run.control_claimed") {
          const control = run.controls.get(payload.control_id);
          if (control) {
            control.status = "claimed";
            control.worker_id = payload.worker_id;
          }
        } else if (type === "run.control_receipted") {
          const control = run.controls.get(payload.control_id);
          if (control) {
            control.status = payload.decision === "rejected" ? "rejected" : "applied";
            control.decision = payload.decision;
            control.receipt_reason = payload.reason || "";
          }
        } else if (type === "run.deployment_requested") {
          run.deployment_request_ids.push(payload.request_id);
        }
        continue;
      }
      if (type === "deployment.requested") {
        const entry = ensureDeploymentRequest(payload.request_id);
        entry.request = payload;
        entry.latest_event_at = event.recorded_at;
        continue;
      }
      if (type === "deployment.reviewed") {
        const entry = ensureDeploymentRequest(payload.request_id);
        entry.review = payload;
        entry.latest_event_at = event.recorded_at;
        continue;
      }
      if (type === "deployment.claimed") {
        const entry = ensureDeploymentRequest(payload.request_id);
        entry.claims.set(payload.operation || "preview", payload);
        entry.latest_event_at = event.recorded_at;
        continue;
      }
      if (type === "deployment.verification_recorded") {
        const entry = ensureDeploymentRequest(payload.request_id);
        entry.verifications.push(payload);
        entry.latest_event_at = event.recorded_at;
        continue;
      }
      if (type === "deployment.effect_observed") {
        const entry = ensureDeploymentRequest(payload.request_id);
        entry.effects.set(payload.operation || "apply", payload);
        entry.latest_event_at = event.recorded_at;
        continue;
      }
      if (type === "deployment.effect_adopted") {
        const entry = ensureDeploymentRequest(payload.request_id);
        entry.effect_adoptions.push(payload);
        entry.latest_event_at = event.recorded_at;
        continue;
      }
      if (type === "deployment.receipted") {
        const entry = ensureDeploymentRequest(payload.request_id);
        entry.receipts.set(payload.operation || "apply", payload);
        entry.latest_event_at = event.recorded_at;
        continue;
      }
      if (type === "deployment.recorded") {
        deployments.set(payload.deployment_id, payload);
        if (payload.request_id) {
          const entry = ensureDeploymentRequest(payload.request_id);
          entry.records.push(payload);
          entry.latest_event_at = event.recorded_at;
        }
        continue;
      }
    }

    return { tasks, runs, deployments, deploymentRequests, feedback };
  }

  async function listAllEvents() {
    const prefixes = ["work.task.", "run.", "repo.", "user_feedback.", "deployment."];
    const merged = [];
    for (const prefix of prefixes) {
      let offset = 0;
      while (offset < EVENT_REBUILD_LIMIT) {
        const chunk = await events.listEvents({
          event_type_prefix: prefix,
          order: "asc",
          limit: EVENT_LIST_LIMIT,
          offset,
        });
        merged.push(...chunk);
        if (chunk.length < EVENT_LIST_LIMIT) break;
        offset += chunk.length;
      }
      if (offset >= EVENT_REBUILD_LIMIT) {
        throw new Error(`work-history rebuild exceeded ${EVENT_REBUILD_LIMIT} ${prefix} events`);
      }
    }
    return merged.sort((a, b) =>
      String(a.recorded_at).localeCompare(String(b.recorded_at))
      || Number(a.stream_version || 0) - Number(b.stream_version || 0)
      || String(a.event_id || "").localeCompare(String(b.event_id || "")));
  }

  function runBlockingReason(run) {
    const pendingControl = [...run.controls.values()].find((control) => control.status === "queued" || control.status === "claimed");
    if (pendingControl) {
      return `control request ${pendingControl.control_id} (${pendingControl.action}) awaiting worker receipt`;
    }
    if (run.status === "queued") {
      return "waiting for a worker to claim this run";
    }
    if (run.status === "failed") {
      const failedVerification = run.verifications.filter((v) => v.status === "failed").slice(-1)[0];
      return failedVerification
        ? `verification failed: ${failedVerification.command || failedVerification.summary || failedVerification.verification_id}`
        : "run failed";
    }
    const lastEvent = run.events.slice(-1)[0];
    if (lastEvent?.event_type === "run.output_proposed") {
      return "output proposed; waiting on user review";
    }
    return "";
  }

  async function statusSummary() {
    const state = await collectState();
    const runs = [...state.runs.values()].map((run) => ({
      run_id: run.record.run_id,
      task_id: run.record.task_id || "",
      status: run.status,
      objective: text(run.record.objective, 200),
      worker_id: run.claim?.worker_id || "",
      latest_event_at: run.latest_event_at,
      latest_summary: run.latest_summary,
      blocking_reason: runBlockingReason(run),
      verification_count: run.verifications.length,
      failed_verifications: run.verifications.filter((v) => v.status === "failed").length,
      diff_count: run.diffs.length,
      feedback_count: run.feedback.length,
    }));
    const tasks = [...state.tasks.values()].map((task) => ({
      task_id: task.record.task_id,
      title: task.record.title,
      status: task.status,
      status_reason: task.status_reason,
      linked_run_ids: task.linked_run_ids,
      latest_event_at: task.latest_event_at,
    }));
    const byStatus = (statuses) => runs.filter((run) => statuses.includes(run.status));
    return {
      generated_at: new Date().toISOString(),
      source: "work-history projections (product events)",
      tasks,
      runs,
      queued: byStatus(["queued"]),
      active: byStatus(["claimed", "running"]),
      blocked: runs.filter((run) => run.blocking_reason && !isTerminalRunStatus(run.status) && run.status !== "queued"),
      completed: byStatus(["completed"]),
      failed: byStatus(["failed", "canceled"]),
      waiting_on_user: runs.filter((run) => run.blocking_reason.includes("waiting on user")),
    };
  }

  async function runDetail(runId) {
    const state = await collectState();
    const run = state.runs.get(text(runId, 160));
    if (!run) return null;
    const before = run.snapshots.filter((snap) => snap.role === "before").slice(-1)[0] || null;
    const after = run.snapshots.filter((snap) => snap.role === "after").slice(-1)[0] || null;
    const task = run.record.task_id ? state.tasks.get(run.record.task_id) || null : null;
    return {
      run: run.record,
      status: run.status,
      claim: run.claim,
      task: task ? { ...task.record, status: task.status } : null,
      events: run.events,
      before_snapshot: before,
      after_snapshot: after,
      snapshots: run.snapshots,
      diffs: run.diffs,
      verifications: run.verifications,
      feedback: run.feedback,
      control_requests: [...run.controls.values()],
      deployment_request_ids: run.deployment_request_ids,
      blocking_reason: runBlockingReason(run),
    };
  }

  async function taskDetail(taskId) {
    const state = await collectState();
    const task = state.tasks.get(text(taskId, 160));
    if (!task) return null;
    return {
      task: { ...task.record, status: task.status, status_reason: task.status_reason },
      linked_run_ids: task.linked_run_ids,
      runs: task.linked_run_ids
        .map((runId) => state.runs.get(runId))
        .filter(Boolean)
        .map((run) => ({ run_id: run.record.run_id, status: run.status, latest_event_at: run.latest_event_at })),
    };
  }

  async function deploymentRequestDetail(requestId) {
    const state = await collectState();
    const entry = state.deploymentRequests.get(text(requestId, 160));
    if (!entry) return null;
    const latestPreview = latestPreviewRecord(entry);
    const latestApplied = latestAppliedRecord(entry);
    const latestVerification = latestDeploymentVerification(entry);
    const latestPreviewVerification = matchingPreviewVerification(entry, latestPreview);
    const applyGuard = deploymentApplyGuard(entry);
    return {
      request: entry.request,
      review: entry.review,
      claims: [...entry.claims.values()],
      verifications: entry.verifications,
      latest_verification: latestVerification,
      latest_preview_verification: latestPreviewVerification,
      preview_records: entry.records.filter((record) => record.mode === "preview"),
      latest_preview: latestPreview,
      latest_applied: latestApplied,
      effects: [...entry.effects.values()],
      effect_adoptions: entry.effect_adoptions,
      receipts: [...entry.receipts.values()],
      apply_guard: applyGuard,
      status: deploymentRequestStatus(entry),
      blocking_reason: deploymentRequestBlockingReason(entry),
    };
  }

  async function deploymentLinks({ target } = {}) {
    const state = await collectState();
    const wanted = text(target, 80);
    const records = [...state.deployments.values()]
      .filter((record) => !wanted || record.target === wanted)
      .sort((a, b) => String(b.recorded_at).localeCompare(String(a.recorded_at)));
    const previews = records.filter((record) => record.mode === "preview" && ["available", "building", "requested"].includes(record.status));
    const applied = records.filter((record) => {
      if (record.status !== "applied") return false;
      const request = record.request_id ? state.deploymentRequests.get(record.request_id) : null;
      return !request?.receipts.get("rollback");
    });
    const requests = [...state.deploymentRequests.values()]
      .filter((entry) => !wanted || entry.request.target === wanted)
      .sort((a, b) => String(b.request.created_at || "").localeCompare(String(a.request.created_at || "")))
      .map((entry) => ({
        ...entry.request,
        derived_status: deploymentRequestStatus(entry),
        review_decision: entry.review?.decision || "",
        latest_preview_url: latestPreviewRecord(entry)?.preview_url || "",
        latest_verification_status: matchingPreviewVerification(entry, latestPreviewRecord(entry))?.status || "",
        apply_allowed: deploymentApplyGuard(entry).status === "ready",
        blocking_reason: deploymentRequestBlockingReason(entry),
        latest_feedback_summary: entry.request.run_id
          ? text(state.runs.get(entry.request.run_id)?.feedback.slice(-1)[0]?.summary, 2000)
          : "",
      }));
    return {
      latest_preview: previews[0] || null,
      latest_applied: applied[0] || null,
      records,
      open_requests: requests,
    };
  }

  // Narrow worker feed: only reviewed preview requests that have not produced
  // a verified available preview. It intentionally excludes apply/rollback
  // readiness so a preview credential cannot discover production work.
  async function pendingApprovedPreviewRequests({ limit = 25 } = {}) {
    const state = await collectState();
    const bounded = Math.max(1, Math.min(Number(limit) || 25, 100));
    return [...state.deploymentRequests.values()]
      .filter((entry) => entry.request.mode === "preview" && entry.review?.decision === "approved")
      .filter((entry) => {
        const preview = latestPreviewRecord(entry);
        return !(preview?.status === "available" && matchingPreviewVerification(entry, preview)?.status === "passed");
      })
      .filter((entry) => {
        const claim = currentDeploymentClaim(entry, "preview");
        return !claim || isClaimExpired(claim);
      })
      .sort((a, b) => String(a.request.created_at || "").localeCompare(String(b.request.created_at || "")))
      .slice(0, bounded)
      .map((entry) => ({
        request_id: entry.request.request_id,
        target: entry.request.target,
        commit_sha: entry.request.commit_sha,
        adapter_kind: entry.request.adapter_kind,
        created_at: entry.request.created_at,
        preview_claim: currentDeploymentClaim(entry, "preview") || null,
      }));
  }

  // Resolve a spoken UI-open target into a safe gateway-relative route. The
  // gateway returns the route; only a claiming client may actually open it.
  async function resolveUiRoute({ route_kind: routeKind, target } = {}) {
    const kind = UI_ROUTE_KINDS.includes(routeKind) ? routeKind : "run";
    const state = await collectState();
    const ref = text(target, 200);

    if (kind === "deployment") {
      const links = await deploymentLinks({});
      const record = ref
        ? state.deployments.get(ref) || null
        : links.latest_preview || links.latest_applied;
      if (!record) return null;
      return {
        route_kind: "deployment",
        route_ref: record.deployment_id,
        safe_url: record.preview_url || record.active_url || `/ui#deployment=${record.deployment_id}`,
      };
    }
    if (kind === "task") {
      const task = ref
        ? state.tasks.get(ref)
        : [...state.tasks.values()].sort((a, b) => String(b.latest_event_at).localeCompare(String(a.latest_event_at)))[0];
      if (!task) return null;
      return { route_kind: "task", route_ref: task.record.task_id, safe_url: `/ui#work-task=${task.record.task_id}` };
    }
    // run / diff / verification / feedback all resolve through a run.
    const run = ref && state.runs.has(ref)
      ? state.runs.get(ref)
      : [...state.runs.values()].sort((a, b) => String(b.latest_event_at).localeCompare(String(a.latest_event_at)))[0];
    if (!run) return null;
    const runId = run.record.run_id;
    if (kind === "diff") {
      const diff = run.diffs.slice(-1)[0];
      if (!diff) return { route_kind: "run", route_ref: runId, safe_url: `/ui#work-run=${runId}` };
      return { route_kind: "diff", route_ref: diff.diff_id, safe_url: `/ui#work-run=${runId}&diff=${diff.diff_id}` };
    }
    if (kind === "verification") {
      const verification = run.verifications.slice(-1)[0];
      if (!verification) return { route_kind: "run", route_ref: runId, safe_url: `/ui#work-run=${runId}` };
      return {
        route_kind: "verification",
        route_ref: verification.verification_id,
        safe_url: `/ui#work-run=${runId}&verification=${verification.verification_id}`,
      };
    }
    if (kind === "feedback") {
      const item = run.feedback.slice(-1)[0];
      if (!item) return { route_kind: "run", route_ref: runId, safe_url: `/ui#work-run=${runId}` };
      return { route_kind: "feedback", route_ref: item.feedback_id, safe_url: `/ui#work-run=${runId}&feedback=${item.feedback_id}` };
    }
    return { route_kind: "run", route_ref: runId, safe_url: `/ui#work-run=${runId}` };
  }

  return {
    createTask,
    queueRun,
    claimRun,
    appendRunEvent,
    setTaskStatus,
    recordSnapshot,
    recordDiff,
    recordVerification,
    attachFeedback,
    createControlRequest,
    claimControlRequest,
    receiptControlRequest,
    requestDeployment,
    reviewDeploymentRequest,
    claimDeploymentRequest,
    adoptDeploymentOperationEffect,
    recordDeploymentVerification,
    observeDeploymentOperationEffect,
    receiptDeploymentOperation,
    recordDeployment,
    collectState,
    statusSummary,
    runDetail,
    taskDetail,
    deploymentRequestDetail,
    deploymentLinks,
    pendingApprovedPreviewRequests,
    resolveUiRoute,
  };

  // --- internals ------------------------------------------------------------

  function append(input) {
    return events.appendEvent({
      ...input,
      authority: input.authority || { boundary: "work-history-control-plane", execution: "proposal_claim_receipt" },
    });
  }

  function findControl(state, controlId) {
    for (const run of state.runs.values()) {
      const control = run.controls.get(controlId);
      if (control) {
        return { runId: run.record.run_id, control };
      }
    }
    return null;
  }
}

function isTerminalRunStatus(status) {
  return ["completed", "failed", "canceled"].includes(status);
}

function taskStream(taskId) {
  return `work-task:${text(taskId, 160) || "unknown"}`;
}

function runStream(runId) {
  return `work-run:${text(runId, 160) || "unknown"}`;
}

function streamForTarget(target) {
  if (!target) return "work-history:feedback";
  if (target.type === "run") return runStream(target.id);
  if (target.type === "task") return taskStream(target.id);
  if (target.type === "deployment") return `deployment:${text(target.id, 160)}`;
  return "work-history:feedback";
}

function normalizeFeedbackTargets(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  const targets = [];
  for (const item of list.slice(0, 10)) {
    if (typeof item === "string") {
      const inferred = inferTargetType(item);
      if (inferred) targets.push(inferred);
      continue;
    }
    if (item && typeof item === "object") {
      const type = ["run", "task", "deployment", "verification"].includes(item.type) ? item.type : inferTargetType(item.id || "")?.type;
      const idValue = text(item.id, 200);
      if (type && idValue) targets.push({ type, id: idValue });
    }
  }
  return targets;
}

function inferTargetType(idValue) {
  const safe = text(idValue, 200);
  if (!safe) return null;
  if (safe.startsWith("wr_") || safe.startsWith("run_")) return { type: "run", id: safe };
  if (safe.startsWith("wt_") || safe.startsWith("wg_")) return { type: "task", id: safe };
  if (safe.startsWith("dep_")) return { type: "deployment", id: safe };
  return { type: "run", id: safe };
}

function eventSummary(event) {
  return {
    event_id: event.event_id,
    event_type: event.event_type,
    recorded_at: event.recorded_at,
    occurred_at: event.occurred_at,
    actor: event.actor,
    summary: text(event.payload?.summary, 400),
  };
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function idem(explicit, scope, operation) {
  const provided = text(explicit, 240);
  if (provided) return provided;
  const safeScope = text(scope, 160);
  if (!safeScope || !operation) return "";
  return `wh:${safeScope}:${operation}`;
}

function deploymentIdem(domain, ...parts) {
  const safeDomain = deploymentString(domain, "idempotency domain", 80, true);
  const body = parts.map((part) => deploymentString(part, "idempotency component", 200, true)).join("\u001f");
  const digest = crypto.createHash("sha256").update(`moa.deployment.v1\u001f${safeDomain}\u001f${body}`).digest("hex");
  return `wh:deployment:${safeDomain}:${digest}`;
}

function deploymentPayloadDigest(domain, value) {
  return crypto.createHash("sha256")
    .update(`moa.deployment.payload.v1\u001f${domain}\u001f${canonicalJson(value)}`)
    .digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function assertDeploymentReturnedEvent(event, eventType, expected = {}) {
  if (!event || event.event_type !== eventType || !event.payload || typeof event.payload !== "object") {
    throw new Error(`idempotency collision returned an invalid ${eventType} event`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (event.payload[key] !== value) {
      throw new Error(`idempotency collision returned mismatched ${eventType} ${key}`);
    }
  }
}

function actor(value, fallbackKind, fallbackId) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { kind: text(value.kind, 80) || fallbackKind || "user", id: text(value.id, 160) || fallbackId || fallbackKind || "user" };
  }
  return { kind: fallbackKind || "user", id: text(fallbackId, 160) || fallbackKind || "user" };
}

function requireText(value, name) {
  const safe = text(value, 200);
  if (!safe) {
    throw new Error(`${name} is required`);
  }
  return safe;
}

function text(value, max) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.slice(0, max) : "";
}

function integer(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function refs(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("refs must be an array of typed string references");
  if (value.length > 50) throw new Error("refs exceeds 50 references");
  return value.map((item, index) => workHistoryRef(item, `refs[${index}]`)).filter(Boolean);
}

function deploymentString(value, name, max, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${name} is required`);
    return "";
  }
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const output = value.trim();
  if (!output && required) throw new Error(`${name} is required`);
  if (output.length > max) throw new Error(`${name} exceeds ${max} characters`);
  if (/\r|\n|\0|`|\|\||&&|[$;&|<>\\]/.test(output)) {
    throw new Error(`${name} contains shell or control syntax`);
  }
  if (/(?:bearer\s+|api[_-]?key\s*[:=]|token\s*[:=]|password\s*[:=]|secret\s*[:=]|(?:^|[:/])(sk|pk|rk|ghp|github_pat|xox[baprs])-?[_A-Za-z0-9-]{8,})/i.test(output)) {
    throw new Error(`${name} contains secret-like material`);
  }
  return output;
}

function workHistoryRef(value, name) {
  const ref = deploymentString(value, name, 400, false);
  if (!ref) return "";
  if (!/^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9][A-Za-z0-9._~:/?#[\]@!$'()*+,=%-]*|[A-Za-z0-9][A-Za-z0-9._~:/?#[\]@!$'()*+,=%-]*)$/.test(ref)) {
    throw new Error(`${name} must be a typed bounded string reference`);
  }
  return ref;
}

function deploymentRef(value, name) {
  const ref = deploymentString(value, name, 400, false);
  if (!ref) return "";
  if (!/^(?:artifact|provenance|backup|restore|smoke|rollback|log|verification):\/\/[A-Za-z0-9][A-Za-z0-9._~:/?#[\]@!$&'()*+,=%-]*$/.test(ref)) {
    throw new Error(`${name} must be a typed non-secret reference`);
  }
  return ref;
}

function deploymentUrl(value, name) {
  const url = deploymentString(value, name, 800, false);
  if (!url) return "";
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`${name} must be an https URL`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${name} must be an https URL without credentials`);
  }
  return url;
}

function deploymentRefs(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of typed string references`);
  if (value.length > 50) throw new Error(`${name} exceeds 50 references`);
  return value.map((item, index) => deploymentRef(item, `${name}[${index}]`)).filter(Boolean);
}

function deploymentCandidateRefs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") {
        return { candidate_id: deploymentString(item, "candidate_id", 160, true) };
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const candidate = {
        candidate_id: deploymentString(item.candidate_id || item.candidateId || item.id, "candidate_id", 160),
        target: deploymentString(item.target, "candidate target", 120),
        artifact_ref: deploymentRef(item.artifact_ref || item.artifactRef, "candidate artifact_ref"),
        provenance_ref: deploymentRef(item.provenance_ref || item.provenanceRef, "candidate provenance_ref"),
      };
      return candidate.candidate_id || candidate.target || candidate.artifact_ref ? candidate : null;
    })
    .filter(Boolean)
    .slice(0, 20);
}

function iso(value, fallback) {
  const safe = text(value, 80);
  if (!safe) return fallback;
  const date = new Date(safe);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function latestPreviewRecord(entry) {
  return entry.records
    .filter((record) => record.mode === "preview")
    .sort((a, b) => String(b.recorded_at || "").localeCompare(String(a.recorded_at || "")))[0] || null;
}

function latestAppliedRecord(entry) {
  if (entry.receipts.get("rollback")) return null;
  return entry.records
    .filter((record) => record.status === "applied")
    .sort((a, b) => String(b.recorded_at || "").localeCompare(String(a.recorded_at || "")))[0] || null;
}

function latestDeploymentVerification(entry) {
  return entry.verifications
    .sort((a, b) => String(a.finished_at || "").localeCompare(String(b.finished_at || "")))
    .slice(-1)[0] || null;
}

function matchingPreviewVerification(entry, preview) {
  if (!preview) return null;
  return entry.verifications
    .filter((item) => item.operation === "preview"
      && item.deployment_id === preview.deployment_id
      && item.claim_id === preview.claim_id
      && item.created_by_worker_id === preview.worker_id)
    .sort((a, b) => String(a.finished_at || "").localeCompare(String(b.finished_at || "")))
    .slice(-1)[0] || null;
}

function currentEffectAdoption(entry, operation, effectId) {
  return entry.effect_adoptions
    .filter((item) => item.operation === operation && item.effect_id === effectId)
    .sort((a, b) => String(a.adopted_at || "").localeCompare(String(b.adopted_at || "")))
    .slice(-1)[0] || null;
}

function currentDeploymentClaim(entry, operation) {
  return entry.claims.get(operation) || null;
}

function currentDeploymentEffect(entry, operation, effectId) {
  const observed = entry.effects.get(operation) || null;
  if (!observed) return null;
  if (effectId && observed.effect_id !== effectId) return null;
  return observed;
}

function isClaimExpired(claim) {
  if (!claim?.lease_expires_at) return false;
  const expiry = new Date(claim.lease_expires_at);
  return Number.isFinite(expiry.getTime()) && expiry.getTime() <= Date.now();
}

function deploymentApplyGuard(entry) {
  if (entry.review?.decision !== "approved") {
    return { status: "blocked", reason: "awaiting review approval" };
  }
  const preview = latestPreviewRecord(entry);
  if (!preview || preview.status !== "available") {
    return { status: "blocked", reason: "preview is not available yet" };
  }
  const verification = matchingPreviewVerification(entry, preview);
  if (!verification || verification.status !== "passed") {
    return { status: "blocked", reason: "preview verification has not passed" };
  }
  if (entry.receipts.get("apply")) {
    return { status: "blocked", reason: "apply already receipted" };
  }
  return { status: "ready", reason: "" };
}

function deploymentRollbackGuard(entry) {
  if (!latestAppliedRecord(entry) || !entry.receipts.get("apply")) {
    return { status: "blocked", reason: "no applied deployment receipt exists yet" };
  }
  if (entry.receipts.get("rollback")) {
    return { status: "blocked", reason: "rollback already receipted" };
  }
  return { status: "ready", reason: "" };
}

function deploymentRequestStatus(entry) {
  if (entry.receipts.get("rollback")) return "rolled_back";
  if (entry.receipts.get("apply")) return "applied";
  const guard = deploymentApplyGuard(entry);
  if (guard.status === "ready") return "verified";
  const previewVerification = matchingPreviewVerification(entry, latestPreviewRecord(entry));
  if (previewVerification?.status === "failed") return "verification_failed";
  if (latestPreviewRecord(entry)?.status === "available") return "preview_available";
  if (entry.claims.get("apply")) return "apply_claimed";
  if (entry.claims.get("preview")) return "preview_claimed";
  if (entry.review?.decision === "rejected") return "rejected";
  if (entry.review?.decision === "approved") return "approved";
  return entry.request.status || "requested";
}

function deploymentRequestBlockingReason(entry) {
  if (entry.receipts.get("rollback")) return "";
  const rollback = deploymentRollbackGuard(entry);
  if (entry.claims.get("rollback") && !entry.receipts.get("rollback")) {
    const effect = entry.effects.get("rollback");
    return effect
      ? "rollback effect observed; waiting for immutable receipt"
      : "rollback claimed; waiting for adapter effect";
  }
  if (entry.claims.get("apply") && !entry.receipts.get("apply")) {
    const effect = entry.effects.get("apply");
    return effect
      ? "apply effect observed; waiting for immutable receipt or audited adoption"
      : "apply claimed; waiting for adapter effect";
  }
  const apply = deploymentApplyGuard(entry);
  if (apply.status === "blocked") return apply.reason;
  if (rollback.status === "blocked" && deploymentRequestStatus(entry) === "applied") return rollback.reason;
  return "";
}

function assertDeploymentOperationClaimable(entry, operation) {
  if (!entry?.request?.request_id) {
    throw new Error("deployment request not found");
  }
  if (entry.effects.get(operation) && !entry.receipts.get(operation)) {
    throw new Error(`deployment request ${entry.request.request_id} ${operation} effect is already observed; use explicit adoption before receipt`);
  }
  const currentClaim = currentDeploymentClaim(entry, operation);
  if (currentClaim && !isClaimExpired(currentClaim) && !entry.receipts.get(operation)) {
    throw new Error(`deployment request ${entry.request.request_id} ${operation} is already claimed by ${currentClaim.worker_id}`);
  }
  if (operation === "preview") {
    if (entry.review?.decision !== "approved") {
      throw new Error(`deployment request ${entry.request.request_id} is awaiting review approval`);
    }
    const preview = latestPreviewRecord(entry);
    if (preview?.status === "available" && matchingPreviewVerification(entry, preview)?.status === "passed") {
      throw new Error(`deployment request ${entry.request.request_id} already has a verified available preview`);
    }
    return;
  }
  if (operation === "apply") {
    const guard = deploymentApplyGuard(entry);
    if (guard.status !== "ready") {
      throw new Error(`deployment request ${entry.request.request_id} cannot apply: ${guard.reason}`);
    }
    return;
  }
  if (operation === "rollback") {
    const guard = deploymentRollbackGuard(entry);
    if (guard.status !== "ready") {
      throw new Error(`deployment request ${entry.request.request_id} cannot roll back: ${guard.reason}`);
    }
  }
}

function assertDeploymentOperationClaim(entry, { operation, worker, claim_id: claimId, claim, require_fresh: requireFresh }) {
  if (!claim) {
    throw new Error(`deployment request ${entry.request.request_id} has no ${operation} claim`);
  }
  if (claim.worker_id !== worker) {
    throw new Error(`deployment request ${entry.request.request_id} ${operation} is claimed by ${claim.worker_id}`);
  }
  if (claim.claim_id !== claimId) {
    throw new Error(`deployment request ${entry.request.request_id} ${operation} claim is stale`);
  }
  if (requireFresh && claim.lease_expires_at) {
    if (isClaimExpired(claim)) {
      throw new Error(`deployment request ${entry.request.request_id} ${operation} claim lease expired`);
    }
  }
}

function assertDeploymentReceiptAuthority(entry, { operation, worker, claimId, claim, observed }) {
  if (observed.worker_id === worker && observed.claim_id === claimId) {
    assertDeploymentOperationClaim(entry, { operation, worker, claim_id: claimId, claim, require_fresh: false });
    return;
  }
  assertDeploymentOperationClaim(entry, { operation, worker, claim_id: claimId, claim, require_fresh: true });
  const adoption = currentEffectAdoption(entry, operation, observed.effect_id);
  if (!adoption) {
    throw new Error(`deployment ${operation} receipt must match the effect claim and worker or a recorded adoption`);
  }
  if (adoption.adopted_by_worker_id !== worker || adoption.adopted_claim_id !== claimId) {
    throw new Error(`deployment ${operation} receipt must use the adopted claim and worker`);
  }
}

function assertDeploymentEffectAllowed(entry, operation) {
  if (entry.effects.get(operation) || entry.receipts.get(operation)) {
    throw new Error(`deployment request ${entry.request.request_id} already has a recorded ${operation} effect`);
  }
  if (operation === "apply") {
    const guard = deploymentApplyGuard(entry);
    if (guard.status !== "ready") {
      throw new Error(`deployment request ${entry.request.request_id} cannot apply: ${guard.reason}`);
    }
    return;
  }
  if (operation === "rollback") {
    const guard = deploymentRollbackGuard(entry);
    if (guard.status !== "ready") {
      throw new Error(`deployment request ${entry.request.request_id} cannot roll back: ${guard.reason}`);
    }
  }
}

function assertDeploymentObservedEffect(entry, observed) {
  if (observed.operation === "apply") {
    if (!observed.backup_record_ref || !observed.restore_check_ref) {
      throw new Error("apply effect requires backup_record_ref and restore_check_ref");
    }
    if (!observed.smoke_artifact_ref) {
      throw new Error("apply effect requires smoke_artifact_ref");
    }
    if (!["drained", "not_needed"].includes(observed.drain_status)) {
      throw new Error("apply effect requires drain_status of drained or not_needed");
    }
    if (observed.compatibility_status !== "compatible") {
      throw new Error("apply effect requires compatibility_status=compatible");
    }
    if (!observed.rollback_ref) {
      throw new Error("apply effect requires rollback_ref");
    }
  } else if (observed.operation === "rollback") {
    if (!observed.rollback_ref) {
      throw new Error("rollback effect requires rollback_ref");
    }
    if (!observed.smoke_artifact_ref) {
      throw new Error("rollback effect requires smoke_artifact_ref");
    }
  }
}

module.exports = {
  createWorkHistoryStore,
  RUN_EVENT_TYPES,
  WORKER_POSTABLE_RUN_EVENTS,
  TASK_STATUSES,
  SNAPSHOT_ROLES,
  VERIFICATION_STATUSES,
  FEEDBACK_INTENTS,
  DEPLOYMENT_MODES,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_REVIEW_DECISIONS,
  DEPLOYMENT_OPERATIONS,
  DEPLOYMENT_GUARD_STATUSES,
  UI_ROUTE_KINDS,
};
