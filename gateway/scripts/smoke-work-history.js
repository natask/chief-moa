#!/usr/bin/env node
"use strict";

// End-to-end smoke for the voice work-history control plane
// (reference/openspec/changes/remote-hosted-gateway/voice-work-history-control-plane.md).
//
// It proves, against a real gateway process:
// - a spoken create stores a broker event, task, and queued run without
//   starting execution;
// - a worker claim + before/after snapshots + diff + verification reconstruct
//   the run's evidence by run id;
// - status questions answer from projections and launch no new work;
// - feedback attaches without canceling; explicit cancellation needs a worker
//   claim + receipt;
// - deployment preview and applied records stay distinct and voice queries
//   never apply anything;
// - "open the run page on my phone" queues a ui.open tool request that only a
//   claiming client completes, with a receipt.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "work-history-smoke-token";
const PREVIEW_TOKEN = "work-history-preview-token";
const REVIEWER_TOKEN = "work-history-reviewer-token";
const PROMOTER_TOKEN = "work-history-promoter-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-work-history-e2e-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startGateway({ port, dataDir });
    await step("work-history endpoints require auth", () => assertAuthRequired(baseUrl));
    const created = await step("voice create queues task + run without execution", () =>
      assertVoiceCreate(baseUrl, dataDir));
    await step("worker claim + evidence reconstruct before/after", () =>
      assertWorkerEvidence(baseUrl, created.runId));
    await step("status question answers from projections, launches nothing", () =>
      assertStatusQuery(baseUrl, dataDir, created));
    const feedbackRun = await step("feedback attaches without cancellation", () =>
      assertFeedbackAttach(baseUrl));
    await step("explicit cancel needs worker claim + receipt", () =>
      assertCancellationFlow(baseUrl, feedbackRun));
    await step("deployment links distinguish preview from applied", () =>
      assertDeploymentLinks(baseUrl));
    await step("ui.open is claimed and receipted by a client", () =>
      assertUiOpen(baseUrl, created.runId));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      checks: [
        "voice create stores broker event + task + queued run, no run.claimed/run.started",
        "worker claim records before/after snapshots, diff, and verification, queryable by run id",
        "'what is still running' answers from projections and creates no new run",
        "a spoken correction adds run.feedback_attached without canceling",
        "a spoken cancel creates a control request; the run cancels only after a worker receipt",
        "preview and applied deployment records stay distinct; no apply event from a voice query",
        "'open the run page on my phone' queues ui.open; only the claiming client completes it",
      ],
    }, null, 2));
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function assertAuthRequired(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/work-history/status`);
  assert.equal(response.status, 401);
  const scoped = await getJson(`${baseUrl}/v1/work-history/status`, PREVIEW_TOKEN);
  assert.equal(scoped.status, 403, "preview credential cannot access non-deployment work history");
  const telemetryAnonymous = await fetch(`${baseUrl}/v1/work-history/telemetry`);
  assert.equal(telemetryAnonymous.status, 401);
  const telemetryScoped = await getJson(`${baseUrl}/v1/work-history/telemetry`, PREVIEW_TOKEN);
  assert.equal(telemetryScoped.status, 403, "preview credential cannot read or post semantic telemetry");
  const telemetryUser = await getJson(`${baseUrl}/v1/work-history/telemetry?limit=999`, TOKEN);
  assert.equal(telemetryUser.status, 200);
  assert.deepEqual(telemetryUser.json.events, []);
  for (const eventType of ["telemetry.semantic.v1", "TELEMETRY.SEMANTIC.V1", "telemetry semantic v1", "telemetry///semantic///v1", ".telemetry...semantic...v1."]) {
    const forgedTelemetry = await postJson(`${baseUrl}/v1/events`, {
      event_type: eventType,
      stream_id: "telemetry:semantic",
      actor: { kind: "gateway", id: "semantic-telemetry" },
      payload: { schema: "moa.semantic_telemetry", schema_version: 1 },
    });
    assert.equal(forgedTelemetry.status, 400, `generic event API must reserve semantic telemetry alias ${eventType}`);
    assert.match(forgedTelemetry.json.error, /reserved/);
  }
}

async function assertVoiceCreate(baseUrl, dataDir) {
  const turn = await postJson(`${baseUrl}/v1/voice/turns`, {
    source: "work-history-smoke",
    session_id: "wh_smoke_session",
    transcript: "create a task to fix the gateway check failure and queue a run",
  });
  assert.equal(turn.status, 202, JSON.stringify(turn.json));
  assert.equal(turn.json.classification, "work_history");
  const refs = turn.json.work_history;
  assert.ok(refs.task_id, "expected a task id");
  assert.ok(refs.run_id, "expected a queued run id");
  assert.equal(refs.run_status, "queued");

  // The message is broker-first: a canonical broker event with route decisions.
  const brokerFiles = fs.readdirSync(path.join(dataDir, "broker-events"));
  assert.ok(brokerFiles.length >= 1, "expected a stored broker event");

  // No execution: no claim/start events, and no legacy harness run was started.
  const events = await getJson(`${baseUrl}/v1/events?stream_id=${encodeURIComponent(`work-run:${refs.run_id}`)}`);
  const types = (events.json.events || []).map((event) => event.event_type);
  assert.ok(types.includes("run.queued"), `expected run.queued in ${types}`);
  assert.ok(!types.includes("run.claimed"), "queued run must not be claimed yet");
  assert.ok(!types.includes("run.started"), "queued run must not be started yet");
  const legacyRuns = await getJson(`${baseUrl}/v1/agent/runs`);
  assert.equal((legacyRuns.json.runs || []).length, 0, "voice create must not start a legacy harness run");

  const detail = await getJson(`${baseUrl}/v1/work-history/runs/${refs.run_id}`);
  assert.equal(detail.json.status, "queued");
  assert.match(detail.json.blocking_reason, /waiting for a worker to claim/);
  return { taskId: refs.task_id, runId: refs.run_id };
}

async function assertWorkerEvidence(baseUrl, runId) {
  const claim = await postJson(`${baseUrl}/v1/work-history/runs/claim`, { worker_id: "smoke-worker" });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  assert.equal(claim.json.run.run_id, runId);

  const before = await postJson(`${baseUrl}/v1/work-history/runs/${runId}/snapshots`, {
    role: "before",
    branch: "smoke-branch",
    commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dirty_state: "clean",
    worker_id: "smoke-worker",
  });
  assert.equal(before.status, 201);
  await postJson(`${baseUrl}/v1/work-history/runs/${runId}/events`, {
    type: "run.started",
    worker_id: "smoke-worker",
    summary: "harness started locally",
  });
  const after = await postJson(`${baseUrl}/v1/work-history/runs/${runId}/snapshots`, {
    role: "after",
    branch: "smoke-branch",
    commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    dirty_state: "clean",
    worker_id: "smoke-worker",
  });
  assert.equal(after.status, 201);
  const diff = await postJson(`${baseUrl}/v1/work-history/runs/${runId}/diffs`, {
    changed_paths: ["gateway/server.js"],
    stats: { files: 1, insertions: 10, deletions: 2 },
    worker_id: "smoke-worker",
  });
  assert.equal(diff.status, 201, JSON.stringify(diff.json));
  const verification = await postJson(`${baseUrl}/v1/work-history/runs/${runId}/verifications`, {
    surface: "gateway",
    command: "cd gateway && npm run check",
    exit_code: 0,
    status: "passed",
    worker_id: "smoke-worker",
  });
  assert.equal(verification.status, 201);
  await postJson(`${baseUrl}/v1/work-history/runs/${runId}/events`, {
    type: "run.completed",
    worker_id: "smoke-worker",
    summary: "completed with verification",
  });

  const detail = await getJson(`${baseUrl}/v1/work-history/runs/${runId}`);
  assert.equal(detail.json.status, "completed");
  assert.equal(detail.json.before_snapshot.commit_sha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(detail.json.after_snapshot.commit_sha, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(detail.json.diffs.length, 1);
  assert.equal(detail.json.verifications[0].status, "passed");

  // The spoken "what changed" answer reflects the before/after evidence.
  const changed = await postJson(`${baseUrl}/v1/voice/turns`, {
    source: "work-history-smoke",
    session_id: "wh_smoke_session",
    transcript: `what did ${runId} change`,
  });
  assert.equal(changed.status, 200);
  assert.match(changed.json.display, /aaaaaaaaaa/);
  assert.match(changed.json.display, /bbbbbbbbbb/);
}

async function assertStatusQuery(baseUrl, dataDir, created) {
  // Seed one queued fixture run so the answer covers queued + completed.
  const queued = await postJson(`${baseUrl}/v1/work-history/runs`, {
    objective: "queued fixture run for status smoke",
  });
  assert.equal(queued.status, 202);

  const countRunEvents = async () => {
    const events = await getJson(`${baseUrl}/v1/events?event_type=run.queued&limit=100`);
    return (events.json.events || []).length;
  };
  const beforeCount = await countRunEvents();

  const status = await postJson(`${baseUrl}/v1/voice/turns`, {
    source: "work-history-smoke",
    session_id: "wh_smoke_session",
    transcript: "what is still running",
  });
  assert.equal(status.status, 200, JSON.stringify(status.json));
  assert.equal(status.json.classification, "work_history");
  assert.match(status.json.display, new RegExp(queued.json.run.run_id));
  assert.match(status.json.display, new RegExp(created.runId));

  assert.equal(await countRunEvents(), beforeCount, "a status question must not queue new work");
  const legacyRuns = await getJson(`${baseUrl}/v1/agent/runs`);
  assert.equal((legacyRuns.json.runs || []).length, 0, "a status question must not launch a harness run");
}

async function assertFeedbackAttach(baseUrl) {
  // Stand up an active run to talk to.
  const run = await postJson(`${baseUrl}/v1/work-history/runs`, { objective: "active run for feedback smoke" });
  const runId = run.json.run.run_id;
  await postJson(`${baseUrl}/v1/work-history/runs/claim`, { worker_id: "smoke-worker", run_id: runId });
  await postJson(`${baseUrl}/v1/work-history/runs/${runId}/events`, { type: "run.started", worker_id: "smoke-worker" });

  const feedback = await postJson(`${baseUrl}/v1/voice/turns`, {
    source: "work-history-smoke",
    session_id: "wh_smoke_session",
    transcript: "tell the active run to keep the old token path",
  });
  assert.equal(feedback.status, 200, JSON.stringify(feedback.json));
  assert.equal(feedback.json.classification, "work_history");
  assert.ok(feedback.json.work_history.feedback_id, "expected a feedback id");

  const detail = await getJson(`${baseUrl}/v1/work-history/runs/${runId}`);
  assert.equal(detail.json.status, "running", "feedback must not cancel the run");
  assert.ok(detail.json.events.some((event) => event.event_type === "run.feedback_attached"));
  assert.ok(!detail.json.events.some((event) => event.event_type === "run.canceled"));
  assert.equal(detail.json.feedback.length, 1);
  return runId;
}

async function assertCancellationFlow(baseUrl, runId) {
  const cancel = await postJson(`${baseUrl}/v1/work-history/turns`, {
    source: "work-history-smoke",
    session_id: "wh_smoke_session",
    transcript: `cancel the work run ${runId}`,
  });
  assert.equal(cancel.status, 202, JSON.stringify(cancel.json));
  const controlId = cancel.json.refs.control_request_ids[0];
  assert.ok(controlId, "expected a control request id");

  let detail = await getJson(`${baseUrl}/v1/work-history/runs/${runId}`);
  assert.equal(detail.json.status, "running", "the run stays running until the worker receipts the cancel");
  assert.equal(detail.json.control_requests[0].status, "queued");

  const claim = await postJson(`${baseUrl}/v1/work-history/controls/claim`, {
    control_id: controlId,
    worker_id: "smoke-worker",
  });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  const receipt = await postJson(`${baseUrl}/v1/work-history/controls/${controlId}/receipt`, {
    worker_id: "smoke-worker",
    decision: "applied",
    reason: "checkpointed and stopped",
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.json));

  detail = await getJson(`${baseUrl}/v1/work-history/runs/${runId}`);
  assert.equal(detail.json.status, "canceled");
}

async function assertDeploymentLinks(baseUrl) {
  const request = await postJson(`${baseUrl}/v1/work-history/deployments/requests`, {
    target: "gateway", reason: "scoped authority smoke", source_turn_id: "turn_scoped_authority_smoke",
  });
  assert.equal(request.status, 202, JSON.stringify(request.json));
  const requestId = request.json.request.request_id;
  const forgedReview = await postJson(`${baseUrl}/v1/work-history/deployments/requests/${requestId}/review`, {
    decision: "approved", reviewed_by_actor: "forged-reviewer", actor: { kind: "reviewer", id: "forged-reviewer" },
  });
  assert.equal(forgedReview.status, 400, "the general gateway token cannot review deployments");
  const review = await postJson(`${baseUrl}/v1/work-history/deployments/requests/${requestId}/review`, {
    decision: "approved", reviewed_by_actor: "forged-reviewer", actor: { kind: "reviewer", id: "forged-reviewer" },
  }, REVIEWER_TOKEN);
  assert.equal(review.status, 200, JSON.stringify(review.json));
  assert.equal(review.json.review.reviewed_by_actor, "deployment-reviewer");
  const broadList = await getJson(`${baseUrl}/v1/work-history/deployments/requests`, TOKEN);
  assert.equal(broadList.status, 400, "the general gateway token cannot list preview work");
  const reviewerList = await getJson(`${baseUrl}/v1/work-history/deployments/requests`, REVIEWER_TOKEN);
  assert.equal(reviewerList.status, 400, "the reviewer credential cannot list preview work");
  const previewList = await getJson(`${baseUrl}/v1/work-history/deployments/requests`, PREVIEW_TOKEN);
  assert.equal(previewList.status, 200, JSON.stringify(previewList.json));
  assert.deepEqual(previewList.json.requests.map((item) => item.request_id), [requestId]);
  const unassignedDetail = await getJson(`${baseUrl}/v1/work-history/deployments/requests/${requestId}`, PREVIEW_TOKEN);
  assert.equal(unassignedDetail.status, 400, "preview credential cannot read an unassigned request detail");
  const guessedDetail = await getJson(`${baseUrl}/v1/work-history/deployments/requests/not-a-real-request`, PREVIEW_TOKEN);
  assert.equal(guessedDetail.status, 404, "preview credential cannot discover guessed request details");
  const previewBroadHistory = await getJson(`${baseUrl}/v1/work-history/deployments`, PREVIEW_TOKEN);
  assert.equal(previewBroadHistory.status, 400, "preview credential cannot list broad deployment history");
  const forgedClaim = await postJson(`${baseUrl}/v1/work-history/deployments/requests/${requestId}/claim`, {
    operation: "preview", worker_id: "forged-worker", claim_id: "scoped-smoke-claim",
  });
  assert.equal(forgedClaim.status, 400, "the general gateway token cannot claim deployment work");
  const claim = await postJson(`${baseUrl}/v1/work-history/deployments/requests/${requestId}/claim`, {
    operation: "preview", worker_id: "forged-worker", claim_id: "scoped-smoke-claim",
  }, PREVIEW_TOKEN);
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  assert.equal(claim.json.worker_id, "preview-deployer");
  const assignedDetail = await getJson(`${baseUrl}/v1/work-history/deployments/requests/${requestId}`, PREVIEW_TOKEN);
  assert.equal(assignedDetail.status, 200, JSON.stringify(assignedDetail.json));
  assert.equal(assignedDetail.json.preview_claim.worker_id, "preview-deployer");
  assert.equal(Object.hasOwn(assignedDetail.json, "latest_applied"), false, "preview detail must redact apply state");
  assert.equal(Object.hasOwn(assignedDetail.json, "receipts"), false, "preview detail must redact receipts");

  for (const status of ["requested", "building", "superseded", "available", "failed"]) {
    const intermediate = await postJson(`${baseUrl}/v1/work-history/deployments`, {
      target: "gateway", mode: "preview", status,
      preview_url: status === "available" ? `https://preview.example.test/unbound-${status}` : "",
    }, PREVIEW_TOKEN);
    assert.equal(intermediate.status, 201, JSON.stringify(intermediate.json));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const afterUnbound = await getJson(`${baseUrl}/v1/work-history/telemetry?limit=10`, TOKEN);
  assert.deepEqual(afterUnbound.json.events.map((event) => event.name), ["preview.claimed"], "unbound and intermediate preview records emit no lifecycle telemetry");

  const preview = await postJson(`${baseUrl}/v1/work-history/deployments`, {
    request_id: requestId,
    claim_id: claim.json.claim_id,
    target: "gateway",
    mode: "preview",
    status: "available",
    preview_url: "https://preview.example.test/build-7",
    commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }, PREVIEW_TOKEN);
  assert.equal(preview.status, 201, JSON.stringify(preview.json));
  assert.equal(preview.json.deployment.worker_id, "preview-deployer", "request-body identity must be ignored");
  const verification = await postJson(`${baseUrl}/v1/work-history/deployments/requests/${requestId}/verification`, {
    operation: "preview",
    claim_id: claim.json.claim_id,
    deployment_id: preview.json.deployment.deployment_id,
    status: "passed",
    surface: "deploy",
    summary: "isolated smoke passed",
  }, PREVIEW_TOKEN);
  assert.equal(verification.status, 201, JSON.stringify(verification.json));
  let semantic;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    semantic = await getJson(`${baseUrl}/v1/work-history/telemetry?limit=10`, TOKEN);
    if ((semantic.json.events || []).length >= 3) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(new Set(semantic.json.events.map((event) => event.name)), new Set(["preview.claimed", "preview.available", "preview.verification.completed"]));
  assert.equal(JSON.stringify(semantic.json).includes(requestId), false, "telemetry must not expose raw deployment request identity");
  const broadPreview = await postJson(`${baseUrl}/v1/work-history/deployments`, {
    target: "gateway", mode: "preview", status: "available", preview_url: "https://preview.example.test/forged",
    worker_id: "forged-worker",
  });
  assert.equal(broadPreview.status, 400, "the general gateway token cannot act as a preview deployer");
  const previewApply = await postJson(`${baseUrl}/v1/work-history/deployments`, {
    target: "gateway", mode: "applied", status: "applied", active_url: "https://app.example.test/forged",
  }, PREVIEW_TOKEN);
  assert.equal(previewApply.status, 400, "the preview credential cannot promote production");
  const badApplied = await postJson(`${baseUrl}/v1/work-history/deployments`, {
    target: "gateway",
    mode: "applied",
    status: "applied",
    active_url: "https://app.example.test",
  });
  assert.equal(badApplied.status, 400, "requestless applied state must be rejected");
  const forgedApplied = await postJson(`${baseUrl}/v1/work-history/deployments`, {
    target: "gateway",
    mode: "applied",
    status: "applied",
    active_url: "https://app.example.test",
    explicit_promotion: true,
    backup_record_ref: "backup://smoke",
    restore_check_ref: "restore://smoke",
    applied_by_actor: "user",
  });
  assert.equal(forgedApplied.status, 400, "promotion flags cannot bypass the guarded request state machine");

  const countDeploymentRecords = async () => {
    const events = await getJson(`${baseUrl}/v1/events?event_type=deployment.recorded&limit=100`);
    return (events.json.events || []).length;
  };
  const beforeCount = await countDeploymentRecords();

  const links = await postJson(`${baseUrl}/v1/voice/turns`, {
    source: "work-history-smoke",
    session_id: "wh_smoke_session",
    transcript: "what is the latest preview link",
  });
  assert.equal(links.status, 200, JSON.stringify(links.json));
  assert.equal(links.json.classification, "work_history");
  assert.match(links.json.display, /preview\.example\.test\/build-7/);
  assert.doesNotMatch(links.json.display, /app\.example\.test/);
  assert.equal(links.json.work_history.latest_applied_id, "");
  assert.equal(await countDeploymentRecords(), beforeCount, "a link question must not create deployment records");

  // Crash-after-effect recovery is an apply-only authority. The server binds
  // the adopting worker to the scoped promoter credential, never request JSON.
  const applyClaim = await postJson(`${baseUrl}/v1/work-history/deployments/requests/${requestId}/claim`, {
    operation: "apply", claim_id: "smoke-apply-original",
    // Keep enough headroom for instrumented coverage runs while still proving
    // the crash-recovery path only after the original claim has expired.
    lease_expires_at: new Date(Date.now() + 2000).toISOString(),
  }, PROMOTER_TOKEN);
  assert.equal(applyClaim.status, 200, JSON.stringify(applyClaim.json));
  const effect = await postJson(`${baseUrl}/v1/work-history/deployments/requests/${requestId}/effect`, {
    operation: "apply", claim_id: applyClaim.json.claim_id, effect_id: "smoke-apply-effect",
    deployment_id: "smoke-active-deployment", target: "gateway",
    active_url: "https://app.example.test", artifact_refs: ["artifact://smoke"],
    backup_record_ref: "backup://smoke", restore_check_ref: "restore://smoke",
    smoke_artifact_ref: "smoke://post-apply", rollback_ref: "rollback://smoke",
    drain_status: "drained", compatibility_status: "compatible",
  }, PROMOTER_TOKEN);
  assert.equal(effect.status, 201, JSON.stringify(effect.json));
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const adoptionBody = {
    operation: "apply", effect_id: "smoke-apply-effect", claim_id: "smoke-apply-recovery",
    worker_id: "forged-worker", lease_expires_at: new Date(Date.now() + 60000).toISOString(),
    reason: "smoke crash recovery",
  };
  assert.equal((await postJson(`${baseUrl}/v1/work-history/deployments/requests/${requestId}/adopt`, adoptionBody)).status, 400,
    "general user credential cannot adopt an apply effect");
  assert.equal((await postJson(`${baseUrl}/v1/work-history/deployments/requests/${requestId}/adopt`, adoptionBody, PREVIEW_TOKEN)).status, 400,
    "preview credential cannot adopt an apply effect");
  const adopted = await postJson(`${baseUrl}/v1/work-history/deployments/requests/${requestId}/adopt`, adoptionBody, PROMOTER_TOKEN);
  assert.equal(adopted.status, 200, JSON.stringify(adopted.json));
  assert.equal(adopted.json.effect_adoptions.at(-1).adopted_by_worker_id, "production-promoter",
    "adoption identity must come from the scoped credential");
  const recoveredReceipt = await postJson(`${baseUrl}/v1/work-history/deployments/requests/${requestId}/receipt`, {
    operation: "apply", effect_id: "smoke-apply-effect", claim_id: "smoke-apply-recovery",
  }, PROMOTER_TOKEN);
  assert.equal(recoveredReceipt.status, 200, JSON.stringify(recoveredReceipt.json));
  assert.equal(recoveredReceipt.json.status, "applied");
}

async function assertUiOpen(baseUrl, runId) {
  // A phone client heartbeats with a ui.open capability.
  const heartbeat = await postJson(`${baseUrl}/v1/device-clients/heartbeat`, {
    device_id: "phone-smoke",
    surface_type: "android",
    local_tool_manifest: [{ tool: "ui.open", risk: "navigation", approval: "implicit_user_command" }],
  });
  assert.equal(heartbeat.status, 200);

  const open = await postJson(`${baseUrl}/v1/voice/turns`, {
    source: "work-history-smoke",
    session_id: "wh_smoke_session",
    transcript: `open the run ${runId} page on my phone`,
  });
  assert.equal(open.status, 202, JSON.stringify(open.json));
  const requestId = open.json.work_history.tool_request_id;
  assert.ok(requestId, `expected a ui.open tool request: ${JSON.stringify(open.json.work_history)}`);
  assert.equal(open.json.work_history.route_ref, runId, "the spoken run id must resolve to that run");
  assert.match(open.json.work_history.safe_url, /work-run=/);

  // Only the claiming client completes the request; the gateway just records.
  const claim = await postJson(`${baseUrl}/v1/tool/requests/claim`, { device_id: "phone-smoke" });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  assert.equal(claim.json.request.id, requestId);
  assert.equal(claim.json.request.tool, "ui.open");
  assert.equal(claim.json.request.input.route_ref, runId);

  const receipt = await postJson(`${baseUrl}/v1/tool/requests/${requestId}/receipts`, {
    device_id: "phone-smoke",
    claim_id: claim.json.request.claim_id,
    receipt_id: `work_${requestId}`,
    ok: true,
    summary: "opened the run page locally",
    local_receipt: { tool: "ui.open", opened_route: claim.json.request.input.safe_url },
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.json));
  assert.equal(receipt.json.request.status, "completed");
}

async function step(name, fn) {
  try {
    const result = await fn();
    console.log(`ok - ${name}`);
    return result;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

async function startGateway({ port, dataDir }) {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      MOA_GATEWAY_TOKEN: TOKEN,
      MOA_DEPLOY_REVIEWER_TOKEN: REVIEWER_TOKEN,
      MOA_PREVIEW_DEPLOYER_TOKEN: PREVIEW_TOKEN,
      MOA_PRODUCTION_PROMOTER_TOKEN: PROMOTER_TOKEN,
      MODEL_PROVIDER: "openai-compatible",
      MODEL_API_KEY: "",
      VOICE_PROVIDER: "loopback",
      VOICE_STT_PROVIDER: "loopback",
      VOICE_LLM_PROVIDER: "loopback",
      VOICE_TTS_PROVIDER: "loopback",
      ALLOW_AGENT_WITHOUT_TOKEN: "0",
      DATABASE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const baseUrl = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (server.exitCode != null) {
      throw new Error(`gateway exited with ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return server;
    } catch {
      // Keep waiting.
    }
    await delay(100);
  }
  throw new Error("gateway did not start");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function postJson(url, body, token = TOKEN) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text.trim() ? JSON.parse(text) : {},
  };
}

async function getJson(url, token = TOKEN) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text.trim() ? JSON.parse(text) : {},
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
