#!/usr/bin/env node
"use strict";

// Unit smoke for the voice work-history control plane:
// 1) the deterministic intent parser maps the contract's spoken operations and
//    refuses everything else, and
// 2) the event-sourced store keeps queued runs inert until a worker claims
//    them, records before/after evidence, attaches feedback without canceling,
//    gates cancellation behind worker receipts, separates preview from applied
//    deployments, and rebuilds every projection from product events alone.
//
// No server, no network: the store runs on a temp-dir JSONL event substrate.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseWorkHistoryIntent } = require("../lib/work-history-intent");
const { createWorkHistoryStore } = require("../lib/work-history");
const { createEventSubstrateStore } = require("../lib/event-substrate");

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  testParser();
  await testStore();
  console.log(JSON.stringify({
    ok: true,
    checks: [
      "parser maps create/status/feedback/deployment/ui-open spoken operations",
      "parser returns null for chat, control, and legacy dispatch phrasing",
      "queued run stays inert until a worker claims it",
      "before/after snapshots + diff + verification reconstruct the run story",
      "feedback attaches without cancellation; cancel needs a worker receipt",
      "requestless records cannot claim an applied deployment",
      "projections rebuild from the product-event log alone",
    ],
  }, null, 2));
}

function testParser() {
  const cases = [
    ["create a task to fix the gateway check failure and queue a run", { kind: "create_work", wants_run: true }],
    ["queue a run to update the browser extension smoke", { kind: "create_work", wants_run: true }],
    ["have the qa agent verify the voice pipeline", { kind: "create_work", owner_hint: "qa" }],
    ["what is still running", { kind: "status_query", scope: "running" }],
    ["which agents are active", { kind: "status_query", scope: "running" }],
    ["what are my agents doing", { kind: "status_query", scope: "running" }],
    ["how are the agents doing", { kind: "status_query", scope: "running" }],
    ["what's my agent up to", { kind: "status_query", scope: "running" }],
    ["what did wr_abc123 change", { kind: "status_query", scope: "changed", target: "wr_abc123" }],
    ["what changed", { kind: "status_query", scope: "changed" }],
    ["show me the last verification failure", { kind: "status_query", scope: "failed" }],
    ["what failed", { kind: "status_query", scope: "failed" }],
    ["which runs are waiting on me", { kind: "status_query", scope: "waiting" }],
    ["attach this feedback to wr_abc123: keep the old token path", { kind: "feedback", intent: "note", target: "wr_abc123" }],
    ["tell the active run to keep the old token path", { kind: "feedback", intent: "correction" }],
    ["that result is wrong", { kind: "feedback", intent: "correction" }],
    ["cancel the work run wr_abc123", { kind: "feedback", intent: "cancellation", target: "wr_abc123" }],
    ["pause the run wr_abc123", { kind: "feedback", intent: "cancellation", control_action: "pause" }],
    ["what is the latest preview link", { kind: "deployment_link" }],
    ["what link do I use", { kind: "deployment_link" }],
    ["create a deploy request for the gateway branch", { kind: "deployment_request", apply: false }],
    ["open the run page on my phone", { kind: "ui_open", route_kind: "run", surface: "android" }],
    ["have chrome open the diff for wr_abc123", { kind: "ui_open", route_kind: "diff", surface: "browser_extension", target: "wr_abc123" }],
    ["bring up the deployment preview", { kind: "ui_open", route_kind: "deployment" }],
  ];
  for (const [transcript, expected] of cases) {
    const intent = parseWorkHistoryIntent(transcript);
    assert.ok(intent, `expected an intent for: ${transcript}`);
    for (const [key, value] of Object.entries(expected)) {
      assert.strictEqual(intent[key], value, `${transcript}: expected ${key}=${JSON.stringify(value)}, got ${JSON.stringify(intent[key])}`);
    }
  }

  const nonMatches = [
    "hello",
    "stop",
    "what time is it",
    "what is the gateway status",
    "fix the small issue",
    "run gemini and codex on this",
    "tell me about voice capture",
    "what did you hear",
    "Everyone here has fifty tabs open right now. Soon every one of those is an agent.",
    "set your prompt to You are a helper.",
    "respond in Amharic",
  ];
  for (const transcript of nonMatches) {
    assert.strictEqual(parseWorkHistoryIntent(transcript), null, `expected null for: ${transcript}`);
  }
}

async function testStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-work-history-smoke-"));
  try {
    const events = createEventSubstrateStore({ dataDir: tempDir, originId: "smoke-origin" });
    const store = createWorkHistoryStore({ events });

    // Create durable intent: a task plus a queued run, claimed by nobody.
    const task = await store.createTask({
      title: "fix the gateway check failure",
      objective: "fix the gateway check failure",
      session_id: "sess_smoke",
      created_from_turn_id: "turn_create_1",
      created_from_broker_event_id: "broker_evt_1",
    });
    const run = await store.queueRun({
      task_id: task.task_id,
      objective: "fix the gateway check failure",
      created_from_turn_id: "turn_create_1",
      created_from_broker_event_id: "broker_evt_1",
    });
    assert.strictEqual(run.status, "queued");

    // Idempotent voice retry: the same turn creates NO duplicate task/run.
    const retryTask = await store.createTask({ objective: "retry duplicate", created_from_turn_id: "turn_create_1" });
    assert.strictEqual(retryTask.task_id, task.task_id, "retried turn must return the original task");
    const retryRun = await store.queueRun({ objective: "retry duplicate", created_from_turn_id: "turn_create_1" });
    assert.strictEqual(retryRun.run_id, run.run_id, "retried turn must return the original run");

    let summary = await store.statusSummary();
    assert.strictEqual(summary.queued.length, 1);
    assert.match(summary.queued[0].blocking_reason, /waiting for a worker to claim/);
    const queuedEvents = await events.listEvents({ stream_id: `work-run:${run.run_id}` });
    assert.ok(!queuedEvents.some((event) => ["run.claimed", "run.started"].includes(event.event_type)),
      "a queued run must have no claim/start event until a worker claims it");

    // Worker claims and records before/after evidence.
    const claim = await store.claimRun({ worker_id: "worker-smoke" });
    assert.strictEqual(claim.run.run_id, run.run_id);
    await assert.rejects(store.claimRun({ worker_id: "worker-other", run_id: run.run_id }), /not claimable/);

    const before = await store.recordSnapshot({
      run_id: run.run_id,
      role: "before",
      branch: "smoke-branch",
      commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      dirty_state: "clean",
      worker_id: "worker-smoke",
    });
    await store.appendRunEvent({ run_id: run.run_id, type: "run.started", worker_id: "worker-smoke", summary: "harness started" });
    const after = await store.recordSnapshot({
      run_id: run.run_id,
      role: "after",
      branch: "smoke-branch",
      commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      dirty_state: "clean",
      worker_id: "worker-smoke",
    });
    const diff = await store.recordDiff({
      run_id: run.run_id,
      changed_paths: ["gateway/server.js"],
      stats: { files: 1, insertions: 12, deletions: 3 },
      worker_id: "worker-smoke",
    });
    assert.strictEqual(diff.base_snapshot_id, before.snapshot_id);
    assert.strictEqual(diff.head_snapshot_id, after.snapshot_id);
    const verification = await store.recordVerification({
      run_id: run.run_id,
      surface: "gateway",
      command: "cd gateway && npm run check",
      exit_code: 0,
      status: "passed",
      worker_id: "worker-smoke",
    });
    await store.appendRunEvent({ run_id: run.run_id, type: "run.completed", worker_id: "worker-smoke", summary: "done" });

    const detail = await store.runDetail(run.run_id);
    assert.strictEqual(detail.status, "completed");
    assert.strictEqual(detail.before_snapshot.snapshot_id, before.snapshot_id);
    assert.strictEqual(detail.after_snapshot.snapshot_id, after.snapshot_id);
    assert.strictEqual(detail.diffs[0].diff_id, diff.diff_id);
    assert.strictEqual(detail.verifications[0].verification_id, verification.verification_id);
    const taskDetail = await store.taskDetail(task.task_id);
    assert.strictEqual(taskDetail.task.status, "completed");

    // Feedback on an active run attaches without canceling.
    const activeRun = await store.queueRun({ objective: "second unit of work", created_from_turn_id: "turn_create_2" });
    await store.claimRun({ worker_id: "worker-smoke", run_id: activeRun.run_id });
    await store.appendRunEvent({ run_id: activeRun.run_id, type: "run.started", worker_id: "worker-smoke" });
    const correction = await store.attachFeedback({
      targets: [activeRun.run_id],
      transcript: "keep the old token path",
      intent: "correction",
      source_turn_id: "turn_feedback_1",
    });
    assert.strictEqual(correction.feedback.status, "attached");
    assert.strictEqual(correction.control_requests.length, 0);
    let activeDetail = await store.runDetail(activeRun.run_id);
    assert.strictEqual(activeDetail.status, "running", "a correction must not cancel the run");
    assert.ok(activeDetail.events.some((event) => event.event_type === "run.feedback_attached"));

    // Explicit cancellation is a claimable proposal, not an immediate cancel.
    const cancellation = await store.attachFeedback({
      targets: [activeRun.run_id],
      transcript: "cancel the work run after it saves its current evidence",
      intent: "cancellation",
      source_turn_id: "turn_feedback_2",
    });
    assert.strictEqual(cancellation.control_requests.length, 1);
    activeDetail = await store.runDetail(activeRun.run_id);
    assert.strictEqual(activeDetail.status, "running", "the run stays running until the worker receipts the cancel");
    const controlId = cancellation.control_requests[0].control_id;
    await store.claimControlRequest({ control_id: controlId, worker_id: "worker-smoke" });
    await store.receiptControlRequest({ control_id: controlId, worker_id: "worker-smoke", decision: "applied", reason: "checkpointed" });
    activeDetail = await store.runDetail(activeRun.run_id);
    assert.strictEqual(activeDetail.status, "canceled");

    // Requestless records may describe inert previews, but can never assert an
    // applied effect. Applied state only comes from the guarded request flow.
    await store.recordDeployment({
      target: "gateway",
      mode: "preview",
      status: "available",
      preview_url: "https://preview.example.test/build-1",
      commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    await assert.rejects(
      store.recordDeployment({ target: "gateway", mode: "applied", status: "applied", active_url: "https://app.example.test" }),
      /guarded request_id/,
    );
    const links = await store.deploymentLinks({ target: "gateway" });
    assert.strictEqual(links.latest_preview.preview_url, "https://preview.example.test/build-1");
    assert.strictEqual(links.latest_applied, null);

    // UI routes resolve from durable records only.
    const route = await store.resolveUiRoute({ route_kind: "diff", target: run.run_id });
    assert.strictEqual(route.route_ref, diff.diff_id);
    assert.match(route.safe_url, /work-run=/);

    // Projection rebuild: a brand-new store over the same event log answers the
    // same questions — nothing above lives outside product events.
    const rebuilt = createWorkHistoryStore({
      events: createEventSubstrateStore({ dataDir: tempDir, originId: "smoke-origin" }),
    });
    const rebuiltSummary = await rebuilt.statusSummary();
    summary = await store.statusSummary();
    assert.deepStrictEqual(rebuiltSummary.runs, summary.runs);
    assert.deepStrictEqual(rebuiltSummary.tasks, summary.tasks);
    const rebuiltDetail = await rebuilt.runDetail(run.run_id);
    assert.strictEqual(rebuiltDetail.before_snapshot.commit_sha, before.commit_sha);
    assert.strictEqual(rebuiltDetail.after_snapshot.commit_sha, after.commit_sha);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
