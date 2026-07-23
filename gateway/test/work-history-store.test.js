"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createEventSubstrateStore } = require("../lib/event-substrate");
const { createWorkHistoryStore } = require("../lib/work-history");

function makeStore(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-work-history-store-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return createWorkHistoryStore({ events: createEventSubstrateStore({ dataDir, originId: "work-history-store-test" }) });
}

function makeMutableEventStore(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-work-history-mutating-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const base = createEventSubstrateStore({ dataDir, originId: "work-history-mutating-test" });
  let mutation = null;
  const events = {
    appendEvent: async (input) => {
      const event = await base.appendEvent(input);
      return mutation?.type === input.event_type ? mutation.apply(event) : event;
    },
    listEvents: (query) => base.listEvents(query),
    withStreamLock: (streamId, fn) => base.withStreamLock(streamId, fn),
  };
  return {
    store: createWorkHistoryStore({ events }),
    mutate(type, apply) { mutation = { type, apply }; },
    clear() { mutation = null; },
  };
}

async function taskAndRun(store, suffix = "one") {
  const task = await store.createTask({
    title: ` task ${suffix} `,
    objective: `objective ${suffix}`,
    session_id: "session",
    acceptance_refs: ["artifact://acceptance"],
  });
  const run = await store.queueRun({
    task_id: task.task_id,
    objective: `run ${suffix}`,
    session_id: "session",
  });
  return { task, run };
}

test("task and run lifecycle validates claims and terminal task states", async (t) => {
  const store = makeStore(t);
  const untitled = await store.createTask();
  assert.equal(untitled.title, "untitled task");
  assert.equal(untitled.branch_id, "default");
  await assert.rejects(store.queueRun(), /objective is required/);
  await assert.rejects(store.claimRun(), /worker_id is required/);
  assert.deepEqual(await store.claimRun({ worker_id: "worker", run_id: "missing" }), { run: null, claim: null });

  const { task, run } = await taskAndRun(store);
  const claim = await store.claimRun({ worker_id: "worker" });
  assert.equal(claim.run.run_id, run.run_id);
  assert.equal((await store.taskDetail(task.task_id)).task.status, "active");
  await assert.rejects(store.claimRun({ worker_id: "other", run_id: run.run_id }), /not claimable/);
  await assert.rejects(store.appendRunEvent({ run_id: run.run_id, type: "bad" }), /unsupported run event/);
  await assert.rejects(store.appendRunEvent({ run_id: "missing", type: "run.started" }), /not found/);
  await assert.rejects(store.appendRunEvent({ type: "run.started" }), /run_id is required/);

  await store.appendRunEvent({ run_id: run.run_id, type: "run.started", worker_id: "worker", payload: { phase: 1 } });
  await store.appendRunEvent({ run_id: run.run_id, type: "run.output_proposed", summary: "review me" });
  assert.match((await store.runDetail(run.run_id)).blocking_reason, /waiting on user review/);
  await store.appendRunEvent({ run_id: run.run_id, type: "run.completed", artifact_refs: ["artifact://result"] });
  assert.equal((await store.taskDetail(task.task_id)).task.status, "completed");
  assert.equal((await store.runDetail(run.run_id)).status, "completed");
  assert.equal(await store.runDetail("missing"), null);
  assert.equal(await store.taskDetail("missing"), null);

  const failed = await taskAndRun(store, "failed");
  await store.appendRunEvent({ run_id: failed.run.run_id, type: "run.failed" });
  assert.equal((await store.taskDetail(failed.task.task_id)).task.status, "blocked");
  assert.equal((await store.runDetail(failed.run.run_id)).blocking_reason, "run failed");

  const canceled = await taskAndRun(store, "canceled");
  await store.appendRunEvent({ run_id: canceled.run.run_id, type: "run.canceled" });
  assert.equal((await store.taskDetail(canceled.task.task_id)).task.status, "canceled");
  await store.setTaskStatus(canceled.task.task_id, "invalid", "fallback active");
  assert.equal((await store.taskDetail(canceled.task.task_id)).task.status, "active");
});

test("snapshot, diff, and verification evidence covers defaults and failures", async (t) => {
  const store = makeStore(t);
  const { task, run } = await taskAndRun(store, "evidence");
  await assert.rejects(store.recordSnapshot({ run_id: run.run_id }), /commit_sha is required/);
  await assert.rejects(store.recordDiff({ run_id: "missing" }), /not found/);
  await assert.rejects(store.recordDiff({ run_id: run.run_id }), /base and head snapshots/);

  const before = await store.recordSnapshot({ run_id: run.run_id, role: "bad", commit_sha: "a", dirty_state: "bad" });
  assert.equal(before.role, "checkpoint");
  assert.equal(before.dirty_state, "unknown");
  const realBefore = await store.recordSnapshot({ run_id: run.run_id, role: "before", commit_sha: "b", dirty_state: "clean", submodule_refs: [] });
  const after = await store.recordSnapshot({ run_id: run.run_id, role: "after", commit_sha: "c", dirty_state: "dirty" });
  const diff = await store.recordDiff({
    run_id: run.run_id,
    changed_paths: ["file.js", "", null],
    stats: { files: 1, insertions: -1, deletions: 2.5 },
  });
  assert.equal(diff.base_snapshot_id, realBefore.snapshot_id);
  assert.equal(diff.head_snapshot_id, after.snapshot_id);
  assert.deepEqual(diff.stats, { files: 1, insertions: 0, deletions: 0 });
  const explicit = await store.recordDiff({ run_id: run.run_id, base_snapshot_id: "base", head_snapshot_id: "head", changed_paths: "bad" });
  assert.deepEqual(explicit.changed_paths, []);

  let verification = await store.recordVerification({ run_id: run.run_id, task_id: task.task_id, exit_code: 0, surface: "bad" });
  assert.equal(verification.status, "passed");
  assert.equal(verification.surface, "other");
  verification = await store.recordVerification({ run_id: run.run_id, exit_code: 1, status: "bad" });
  assert.equal(verification.status, "failed");
  await store.appendRunEvent({ run_id: run.run_id, type: "run.failed" });
  const detail = await store.runDetail(run.run_id);
  assert.equal(detail.before_snapshot.snapshot_id, realBefore.snapshot_id);
  assert.equal(detail.after_snapshot.snapshot_id, after.snapshot_id);
  assert.match(detail.blocking_reason, /verification failed/);
});

test("feedback defaults to active work and cancellation requires claim receipt", async (t) => {
  const store = makeStore(t);
  await assert.rejects(store.attachFeedback({ text: "nothing active" }), /no feedback target/);
  const { run } = await taskAndRun(store, "feedback");
  const note = await store.attachFeedback({ text: " keep this ", routing_decision_ids: ["r1", "", null] });
  assert.equal(note.feedback.target_refs[0].id, run.run_id);
  assert.equal(note.control_requests.length, 0);

  const cancel = await store.attachFeedback({
    intent: "cancellation",
    targets: [{ type: "run", id: run.run_id }, { type: "task", id: "wt_other" }],
    transcript: "cancel it",
    control_action: "bad",
  });
  const control = cancel.control_requests[0];
  assert.equal(control.action, "cancel");
  assert.match((await store.runDetail(run.run_id)).blocking_reason, /awaiting worker receipt/);
  await assert.rejects(store.claimControlRequest(), /worker_id is required/);
  await assert.rejects(store.claimControlRequest({ worker_id: "w", control_id: "missing" }), /not found/);
  const claimed = await store.claimControlRequest({ worker_id: "w", control_id: control.control_id });
  assert.equal(claimed.status, "claimed");
  await assert.rejects(store.claimControlRequest({ worker_id: "w", control_id: control.control_id }), /not claimable/);
  await assert.rejects(store.receiptControlRequest({ worker_id: "w", control_id: "missing" }), /not found/);
  const receipt = await store.receiptControlRequest({ worker_id: "w", control_id: control.control_id, decision: "applied" });
  assert.equal(receipt.decision, "applied");
  assert.equal((await store.runDetail(run.run_id)).status, "canceled");

  const rejectedControl = await store.createControlRequest({ run_id: run.run_id, action: "pause" });
  const rejected = await store.receiptControlRequest({ worker_id: "w", control_id: rejectedControl.control_id, decision: "rejected" });
  assert.equal(rejected.decision, "rejected");
});

test("interaction feedback preserves raw evidence and binds the exact deployment candidate", async (t) => {
  const store = makeStore(t);
  const digest = "a".repeat(64);
  const request = await store.requestDeployment({
    target: "gateway",
    candidate_refs: [{
      candidate_id: "cand_feedback",
      target: "gateway",
      release_id: "release_feedback",
      artifact_sha256: digest,
      artifact_ref: "artifact://feedback",
    }],
  });
  const rawComment = "  the button moved after this click  \n";
  const result = await store.attachFeedback({
    targets: [{ type: "deployment", id: request.request_id }],
    raw_comment: rawComment,
    interaction_feedback: {
      schema: "interaction_feedback.v1",
      evidence_refs: ["video-note://vnote_feedback"],
      anchors: [
        { kind: "time_range", start_ms: 1200, end_ms: 1800 },
        {
          kind: "browser_snapshot",
          snapshot_id: "snap_feedback",
          captured_at: "2026-07-22T12:00:00Z",
          page_ref: "https://preview.example.test/page",
          element_index: 7,
          label: "Save",
        },
      ],
      release_binding: {
        surface: "gateway",
        release_id: "release_feedback",
        candidate_id: "cand_feedback",
        artifact_sha256: digest,
        channel: "preview",
      },
    },
  });

  assert.equal(result.feedback.raw_comment, rawComment);
  assert.equal(result.feedback.transcript, rawComment);
  assert.equal(result.feedback.interaction_feedback.release_binding.artifact_sha256, digest);
  assert.deepEqual(result.feedback.interaction_feedback.evidence_refs, ["video-note://vnote_feedback"]);
  assert.equal(result.feedback.interaction_feedback.context_proposal.status, "unreviewed");
  assert.equal(result.feedback.interaction_feedback.context_proposal.derivation, "deterministic_v1");
  assert.match(result.feedback.interaction_feedback.context_proposal.text, /1200-1800ms/);
  assert.equal((await store.deploymentRequestDetail(request.request_id)).feedback[0].feedback_id, result.feedback.feedback_id);

  await assert.rejects(
    store.attachFeedback({
      targets: [{ type: "deployment", id: request.request_id }],
      raw_comment: "wrong bytes",
      interaction_feedback: {
        evidence_refs: [],
        anchors: [],
        release_binding: {
          surface: "gateway",
          release_id: "release_feedback",
          candidate_id: "cand_feedback",
          artifact_sha256: "b".repeat(64),
        },
      },
    }),
    /does not match the targeted candidate/,
  );
});

test("interaction feedback rejects unbounded anchors and unproven release identity", async (t) => {
  const store = makeStore(t);
  const digest = "c".repeat(64);
  const request = await store.requestDeployment({
    target: "browser_extension",
    candidate_refs: [{
      candidate_id: "cand_bounds",
      target: "browser_extension",
      release_id: "release_bounds",
      artifact_sha256: digest,
    }],
  });
  const base = {
    targets: [{ type: "deployment", id: request.request_id }],
    interaction_feedback: {
      evidence_refs: [],
      release_binding: {
        surface: "browser_extension",
        release_id: "release_bounds",
        candidate_id: "cand_bounds",
        artifact_sha256: digest,
      },
    },
  };
  await assert.rejects(
    store.attachFeedback({
      ...base,
      interaction_feedback: {
        ...base.interaction_feedback,
        anchors: [{ kind: "time_range", start_ms: 20, end_ms: 10 }],
      },
    }),
    /cannot precede/,
  );
  await assert.rejects(
    store.attachFeedback({
      ...base,
      interaction_feedback: {
        ...base.interaction_feedback,
        anchors: [{ kind: "browser_snapshot", snapshot_id: "snap", captured_at: "not-a-date" }],
      },
    }),
    /RFC3339/,
  );
  await assert.rejects(
    store.attachFeedback({
      targets: [{ type: "run", id: "run_unbound" }],
      interaction_feedback: { ...base.interaction_feedback, anchors: [] },
    }),
    /exactly one deployment target/,
  );
  await assert.rejects(store.attachFeedback({
    ...base,
    interaction_feedback: "invalid",
  }), /must be an object/);
  await assert.rejects(store.attachFeedback({
    ...base,
    interaction_feedback: { ...base.interaction_feedback, schema: "interaction_feedback.v2" },
  }), /schema/);
  await assert.rejects(store.attachFeedback({
    ...base,
    interaction_feedback: { ...base.interaction_feedback, anchors: "invalid" },
  }), /anchors must be an array/);
  await assert.rejects(store.attachFeedback({
    ...base,
    interaction_feedback: { ...base.interaction_feedback, anchors: Array(51).fill({ kind: "time_range", start_ms: 0 }) },
  }), /exceeds 50/);
  await assert.rejects(store.attachFeedback({
    ...base,
    interaction_feedback: { ...base.interaction_feedback, anchors: [null] },
  }), /must be an object/);
  await assert.rejects(store.attachFeedback({
    ...base,
    interaction_feedback: { ...base.interaction_feedback, anchors: [{ kind: "other" }] },
  }), /kind is unsupported/);
  await assert.rejects(store.attachFeedback({
    ...base,
    interaction_feedback: { ...base.interaction_feedback, anchors: [{ kind: "time_range", start_ms: -1 }] },
  }), /bounded integer/);
  await assert.rejects(store.attachFeedback({
    ...base,
    interaction_feedback: {
      ...base.interaction_feedback,
      anchors: [{
        kind: "browser_snapshot",
        snapshot_id: "snap",
        captured_at: "2026-07-22T12:00:00Z",
        element_index: -1,
      }],
    },
  }), /bounded integer/);
  await assert.rejects(store.attachFeedback({
    ...base,
    interaction_feedback: { ...base.interaction_feedback, release_binding: null },
  }), /release_binding is required/);
  await assert.rejects(store.attachFeedback({
    targets: [{ type: "deployment", id: "dep_missing" }],
    interaction_feedback: base.interaction_feedback,
  }), /target was not found/);
});

test("status and UI routes resolve latest task, run evidence, and safe fallbacks", async (t) => {
  const store = makeStore(t);
  assert.equal(await store.resolveUiRoute({ route_kind: "task" }), null);
  assert.equal(await store.resolveUiRoute({ route_kind: "deployment" }), null);
  assert.equal(await store.resolveUiRoute({ route_kind: "run" }), null);

  const { task, run } = await taskAndRun(store, "routes");
  assert.equal((await store.resolveUiRoute({ route_kind: "task", target: task.task_id })).route_kind, "task");
  assert.equal((await store.resolveUiRoute({ route_kind: "task" })).route_ref, task.task_id);
  assert.equal((await store.resolveUiRoute({ route_kind: "bad", target: run.run_id })).route_kind, "run");
  assert.equal((await store.resolveUiRoute({ route_kind: "diff", target: run.run_id })).route_kind, "run");
  assert.equal((await store.resolveUiRoute({ route_kind: "verification", target: run.run_id })).route_kind, "run");
  assert.equal((await store.resolveUiRoute({ route_kind: "feedback", target: run.run_id })).route_kind, "run");

  await store.recordSnapshot({ run_id: run.run_id, role: "before", commit_sha: "a" });
  await store.recordSnapshot({ run_id: run.run_id, role: "after", commit_sha: "b" });
  const diff = await store.recordDiff({ run_id: run.run_id });
  const verification = await store.recordVerification({ run_id: run.run_id, status: "passed" });
  const feedback = await store.attachFeedback({ targets: [run.run_id], text: "note" });
  assert.equal((await store.resolveUiRoute({ route_kind: "diff", target: run.run_id })).route_ref, diff.diff_id);
  assert.equal((await store.resolveUiRoute({ route_kind: "verification", target: run.run_id })).route_ref, verification.verification_id);
  assert.equal((await store.resolveUiRoute({ route_kind: "feedback", target: run.run_id })).route_ref, feedback.feedback.feedback_id);

  const summary = await store.statusSummary();
  assert.equal(summary.queued.length, 1);
  assert.equal(summary.blocked.length, 0);
  assert.equal((await store.taskDetail(task.task_id)).runs.length, 1);
  assert.equal(await store.deploymentRequestDetail("missing"), null);
});

test("deployment request feed, review conflicts, records, and routes fail closed", async (t) => {
  const store = makeStore(t);
  await assert.rejects(store.reviewDeploymentRequest({ request_id: "missing", decision: "approved" }), /not found/);
  await assert.rejects(store.recordDeployment({ mode: "applied", status: "applied" }), /guarded request_id/);
  await assert.rejects(store.recordDeployment({ request_id: "missing" }), /not found/);

  const { run } = await taskAndRun(store, "deployment");
  const rejectedRequest = await store.requestDeployment({ run_id: run.run_id, target: "bad", mode: "bad" });
  assert.equal(rejectedRequest.target, "other");
  assert.equal(rejectedRequest.mode, "preview");
  await store.reviewDeploymentRequest({ request_id: rejectedRequest.request_id, decision: "bad" });
  await assert.rejects(
    store.reviewDeploymentRequest({ request_id: rejectedRequest.request_id, decision: "approved" }),
    /already reviewed as rejected/,
  );

  const request = await store.requestDeployment({
    target: "gateway",
    branch: "agent/test",
    commit_sha: "a".repeat(40),
    source_turn_id: "turn-pending",
  });
  assert.deepEqual(await store.pendingApprovedPreviewRequests(), []);
  await store.reviewDeploymentRequest({ request_id: request.request_id, decision: "approved" });
  let pending = await store.pendingApprovedPreviewRequests({ limit: 0 });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request_id, request.request_id);

  const claim = await store.claimDeploymentRequest({
    request_id: request.request_id,
    worker_id: "preview-worker",
    operation: "preview",
    claim_id: "claim-active",
    lease_expires_at: "2099-01-01T00:00:00Z",
  });
  assert.deepEqual(await store.pendingApprovedPreviewRequests({ limit: 999 }), []);
  const expiredRequest = await store.requestDeployment({ target: "gateway", source_turn_id: "turn-expired" });
  await store.reviewDeploymentRequest({ request_id: expiredRequest.request_id, decision: "approved" });
  await store.claimDeploymentRequest({
    request_id: expiredRequest.request_id,
    worker_id: "expired-worker",
    claim_id: "claim-expired",
    lease_expires_at: "2000-01-01T00:00:00Z",
  });
  pending = await store.pendingApprovedPreviewRequests({ limit: 1 });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request_id, expiredRequest.request_id);
  assert.equal(pending[0].preview_claim.claim_id, "claim-expired");

  const record = await store.recordDeployment({
    request_id: request.request_id,
    deployment_id: "dep_preview_route",
    target: "gateway",
    mode: "preview",
    status: "available",
    preview_url: "https://preview.example.test",
    worker_id: claim.worker_id,
    claim_id: claim.claim_id,
  });
  await store.recordDeploymentVerification({
    request_id: request.request_id,
    deployment_id: record.deployment_id,
    operation: "preview",
    worker_id: claim.worker_id,
    claim_id: claim.claim_id,
    status: "passed",
  });
  assert.equal((await store.pendingApprovedPreviewRequests()).some((item) => item.request_id === request.request_id), false);
  assert.equal((await store.resolveUiRoute({ route_kind: "deployment", target: record.deployment_id })).safe_url, "https://preview.example.test");
  assert.equal((await store.resolveUiRoute({ route_kind: "deployment" })).route_ref, record.deployment_id);
  assert.equal((await store.deploymentLinks({ target: "gateway" })).latest_preview.deployment_id, record.deployment_id);

  const previewEffect = await store.observeDeploymentOperationEffect({
    request_id: request.request_id,
    operation: "preview",
    worker_id: claim.worker_id,
    claim_id: claim.claim_id,
    effect_id: "effect-preview-route",
    deployment_id: record.deployment_id,
  });
  await assert.rejects(store.adoptDeploymentOperationEffect({
    request_id: request.request_id,
    operation: "preview",
    worker_id: claim.worker_id,
    claim_id: claim.claim_id,
    effect_id: previewEffect.effect_id,
  }), /already belongs to the active claim/);
  await store.receiptDeploymentOperation({
    request_id: request.request_id,
    operation: "preview",
    worker_id: claim.worker_id,
    claim_id: claim.claim_id,
    effect_id: previewEffect.effect_id,
  });
  await assert.rejects(store.adoptDeploymentOperationEffect({
    request_id: request.request_id,
    operation: "preview",
    worker_id: claim.worker_id,
    claim_id: claim.claim_id,
    effect_id: previewEffect.effect_id,
  }), /already has an immutable receipt/);

  await assert.rejects(store.recordDeployment({
    request_id: request.request_id,
    mode: "applied",
    status: "applied",
    from_receipt: false,
  }), /immutable receipt/);
  await assert.rejects(store.recordDeployment({
    request_id: request.request_id,
    mode: "applied",
    status: "applied",
    from_receipt: true,
  }), /explicit_promotion/);
  await assert.rejects(store.recordDeployment({
    request_id: request.request_id,
    mode: "applied",
    status: "applied",
    from_receipt: true,
    explicit_promotion: true,
  }), /backup_record_ref/);

  await assert.rejects(store.adoptDeploymentOperationEffect({
    request_id: request.request_id,
    operation: "apply",
    worker_id: "worker",
    effect_id: "missing-effect",
    claim_id: "claim",
  }), /not observed/);
  await assert.rejects(store.recordDeploymentVerification({
    request_id: "missing",
    deployment_id: "dep",
    worker_id: "worker",
    claim_id: "claim",
  }), /not found/);
  await assert.rejects(store.receiptDeploymentOperation({
    request_id: request.request_id,
    operation: "apply",
    worker_id: "worker",
    claim_id: "claim",
    effect_id: "missing-effect",
  }), /not observed/);
});

test("idempotency collision defenses reject conflicting returned authority", async (t) => {
  let harness = makeMutableEventStore(t);
  let pair = await taskAndRun(harness.store, "run-collision");
  harness.mutate("run.claimed", (event) => ({ ...event, payload: { ...event.payload, worker_id: "other-worker" } }));
  await assert.rejects(harness.store.claimRun({ worker_id: "worker", run_id: pair.run.run_id }), /already claimed by other-worker/);

  harness = makeMutableEventStore(t);
  pair = await taskAndRun(harness.store, "control-collision");
  const control = await harness.store.createControlRequest({ run_id: pair.run.run_id });
  harness.mutate("run.control_claimed", (event) => ({ ...event, payload: { ...event.payload, worker_id: "other-worker" } }));
  await assert.rejects(harness.store.claimControlRequest({ worker_id: "worker", control_id: control.control_id }), /already claimed by other-worker/);

  harness = makeMutableEventStore(t);
  const request = await harness.store.requestDeployment({ target: "gateway", source_turn_id: "collision-turn" });
  harness.mutate("deployment.reviewed", (event) => ({ ...event, payload: { ...event.payload, decision: "rejected" } }));
  await assert.rejects(harness.store.reviewDeploymentRequest({ request_id: request.request_id, decision: "approved" }), /already reviewed as rejected/);
  harness.clear();
  harness.mutate("deployment.claimed", (event) => ({ ...event, payload: { ...event.payload, worker_id: "other-worker" } }));
  await assert.rejects(harness.store.claimDeploymentRequest({
    request_id: request.request_id,
    worker_id: "worker",
    claim_id: "claim",
  }), /already claimed by other-worker/);

  harness = makeMutableEventStore(t);
  const receiptRequest = await harness.store.requestDeployment({ target: "gateway", source_turn_id: "receipt-collision" });
  await harness.store.reviewDeploymentRequest({ request_id: receiptRequest.request_id, decision: "approved" });
  const receiptClaim = await harness.store.claimDeploymentRequest({
    request_id: receiptRequest.request_id,
    worker_id: "worker",
    claim_id: "receipt-claim",
  });
  const effect = await harness.store.observeDeploymentOperationEffect({
    request_id: receiptRequest.request_id,
    operation: "preview",
    worker_id: receiptClaim.worker_id,
    claim_id: receiptClaim.claim_id,
    effect_id: "receipt-effect",
  });
  harness.mutate("deployment.receipted", (event) => ({ ...event, payload: { ...event.payload, effect_id: "other-effect" } }));
  await assert.rejects(harness.store.receiptDeploymentOperation({
    request_id: receiptRequest.request_id,
    operation: "preview",
    worker_id: receiptClaim.worker_id,
    claim_id: receiptClaim.claim_id,
    effect_id: effect.effect_id,
  }), /already receipted for a different effect/);
});
