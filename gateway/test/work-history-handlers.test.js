"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createWorkHistoryHandlers,
  agentRunStatusSummary,
  mergeRunStatusSummaries,
  workHistoryChangedDetail,
  workHistoryDeploymentTarget,
  workHistoryStatusDisplay,
  workHistoryStatusSpeech,
} = require("../lib/work-history-handlers");

const EMPTY_SUMMARY = Object.freeze({
  tasks: [], runs: [], queued: [], active: [], blocked: [], completed: [], failed: [], waiting_on_user: [],
});

function makeHarness(overrides = {}) {
  const calls = [];
  const workHistory = {
    statusSummary: async () => structuredClone(EMPTY_SUMMARY),
    taskDetail: async (id) => ({ task_id: id }),
    queueRun: async (body) => ({ run_id: body.run_id || "wr_1", status: "queued", ...body }),
    claimRun: async () => ({ run: { run_id: "wr_1" }, claim_id: "claim_1" }),
    appendRunEvent: async (body) => ({ event_id: "evt_1", ...body }),
    setTaskStatus: async (task_id, status, reason) => ({ task_id, status, reason }),
    recordSnapshot: async (body) => ({ snapshot_id: "snap_1", ...body }),
    recordDiff: async (body) => ({ diff_id: "diff_1", ...body }),
    recordVerification: async (body) => ({ verification_id: "ver_1", ...body }),
    runDetail: async (id) => ({ run_id: id }),
    attachFeedback: async () => ({ feedback: { feedback_id: "fb_1", status: "recorded", target_refs: [{ id: "wr_1" }] }, control_requests: [] }),
    claimControlRequest: async () => ({ control_id: "ctl_1" }),
    receiptControlRequest: async (body) => body,
    deploymentLinks: async () => ({ latest_preview: null, latest_applied: null }),
    recordDeployment: async (body) => ({ deployment_id: "dep_1", ...body }),
    requestDeployment: async (body) => ({ request_id: "dreq_1", target: body.target || "gateway", ...body }),
    pendingApprovedPreviewRequests: async () => [],
    deploymentRequestDetail: async () => ({ request: { request_id: "dreq_1" }, claims: [] }),
    reviewDeploymentRequest: async (body) => ({ status: "approved", ...body }),
    claimDeploymentRequest: async (body) => ({ status: "claimed", ...body }),
    recordDeploymentVerification: async (body) => ({ status: "passed", ...body }),
    observeDeploymentOperationEffect: async (body) => ({ effect_id: "eff_1", ...body }),
    adoptDeploymentOperationEffect: async (body) => ({ adopted: true, ...body }),
    receiptDeploymentOperation: async (body) => ({ receipted: true, ...body }),
    createTask: async (body) => ({ task_id: "wt_1", ...body }),
    resolveUiRoute: async () => ({ route_kind: "run", route_ref: "wr_1", safe_url: "https://example.test/run/wr_1" }),
    ...(overrides.workHistory || {}),
  };
  for (const [name, fn] of Object.entries(workHistory)) {
    workHistory[name] = async (...args) => {
      calls.push([name, ...args]);
      return fn(...args);
    };
  }
  const deps = {
    workHistory,
    intentWorkflow: {
      createWork: async (body) => {
        calls.push(["intentWorkflow.createWork", body]);
        const task = await workHistory.createTask(body);
        const run = body.wants_run === false ? null : await workHistory.queueRun({ ...body, task_id: task.task_id });
        const intent = { intent_id: "intent_1", version: 4 };
        return {
          intent,
          task,
          run,
          delivery: {
            intent_id: intent.intent_id,
            acceptance_contract_ref: body.acceptance_contract_ref || "work-history://turn/test/acceptance",
          },
        };
      },
    },
    semanticTelemetry: { query: async (query) => ({ query }) },
    parseWorkHistoryIntent: (text) => text === "unknown" ? null : ({ kind: "create_work", objective: text, wants_run: false }),
    authorized: () => true,
    deploymentPrincipal: (_request, operation) => ({ id: `${operation}-worker`, actor: { kind: operation, id: `${operation}-worker` } }),
    requireDeploymentPrincipal: (_request, operation) => ({ id: `${operation}-worker`, actor: { kind: operation, id: `${operation}-worker` } }),
    accountUserId: () => "usr_test",
    readJsonBody: async (request) => request.body || {},
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    cleanError: (error) => error.message,
    sanitizeOptionalId: (value, fallback) => value || fallback,
    randomId: (prefix) => `${prefix}_random`,
    storeBrokerMessage: async () => ({ stored: { id: "be_1", decisions: [{ id: "rd_1", context_pack_id: "pack_1" }], profile_version: "pv_1" } }),
    truncate: (value, max) => String(value).slice(0, max),
    listAllAgentRuns: () => [],
    createToolRequest: () => ({ id: "tool_1" }),
    recordToolRequestProductEvent: async () => {},
    emitPreviewTelemetry: (...args) => calls.push(["telemetry", ...args]),
    ...overrides,
    workHistory,
  };
  return { ...createWorkHistoryHandlers(deps), calls, deps, workHistory };
}

async function route(harness, method, pathname, body = {}, query = "") {
  const response = {};
  await harness.routeWorkHistory({ method, body, headers: {} }, response, new URL(`https://gateway.test${pathname}${query}`));
  return response;
}

test("general work-history routes preserve status codes and bind path ids", async () => {
  const harness = makeHarness();
  assert.equal((await route(harness, "GET", "/v1/work-history/status")).status, 200);
  assert.deepEqual((await route(harness, "GET", "/v1/work-history/telemetry", {}, "?limit=3&name=x&outcome=ok")).payload.query, { limit: "3", name: "x", outcome: "ok" });
  assert.deepEqual((await route(harness, "GET", "/v1/work-history/tasks")).payload, { tasks: [] });
  assert.equal((await route(harness, "GET", "/v1/work-history/tasks/wt%201")).payload.task_id, "wt 1");
  assert.equal((await route(harness, "POST", "/v1/work-history/runs", { source: "phone" })).status, 202);
  assert.equal((await route(harness, "POST", "/v1/work-history/runs/claim")).status, 200);
  for (const action of ["events", "snapshots", "diffs", "verifications"]) {
    assert.equal((await route(harness, "POST", `/v1/work-history/runs/wr%201/${action}`, { value: action })).status, 201);
  }
  assert.equal((await route(harness, "GET", "/v1/work-history/runs/wr%201")).payload.run_id, "wr 1");
  assert.equal((await route(harness, "POST", "/v1/work-history/feedback")).status, 201);
  assert.equal((await route(harness, "POST", "/v1/work-history/controls/claim")).status, 200);
  assert.equal((await route(harness, "POST", "/v1/work-history/controls/ctl%201/receipt")).payload.control_id, "ctl 1");
  assert.equal((await route(harness, "DELETE", "/v1/work-history/nope")).status, 404);
});

test("general routes cover missing, empty claim, scoped denial, and caught errors", async () => {
  const missing = makeHarness({ workHistory: { taskDetail: async () => null, runDetail: async () => null, claimRun: async () => ({ run: null }) } });
  assert.equal((await route(missing, "GET", "/v1/work-history/tasks/nope")).status, 404);
  assert.equal((await route(missing, "GET", "/v1/work-history/runs/nope")).status, 404);
  assert.equal((await route(missing, "POST", "/v1/work-history/runs/claim")).status, 204);
  const denied = makeHarness({ authorized: () => false });
  assert.equal((await route(denied, "GET", "/v1/work-history/status")).status, 403);
  assert.equal((await route(denied, "GET", "/v1/work-history/deployments")).status, 400);
  const broken = makeHarness({ workHistory: { statusSummary: async () => { throw new Error("broken store"); } } });
  assert.deepEqual((await route(broken, "GET", "/v1/work-history/status")).payload, { error: "broken store" });
  const partial = makeHarness({
    intentWorkflow: {
      createWork: async () => {
        const error = new Error("run queue failed");
        error.intent_workflow_partial = { intent_id: "intent_1", task_id: "wt_1" };
        throw error;
      },
    },
  });
  assert.deepEqual((await route(partial, "POST", "/v1/work-history/turns", { text: "ship it" })).payload, {
    error: "run queue failed",
    intent_workflow_partial: { intent_id: "intent_1", task_id: "wt_1" },
  });
});

test("worker claim records a base-drift blocker before ownership changes", async () => {
  const harness = makeHarness({ workHistory: { runDetail: async () => ({ run: {
    run_id: "wr_fix", task_id: "wt_fix",
    workspace_base: { ref: "origin/master", commit: "a".repeat(40) },
  } }) } });
  const response = await route(harness, "POST", "/v1/work-history/runs/claim", {
    run_id: "wr_fix", worker_id: "worker_1", base_ref: "origin/master",
    resolved_base_commit: "b".repeat(40),
  });
  assert.equal(response.status, 400);
  assert.match(response.payload.error, /base drift/);
  assert.equal(harness.calls.some(([name]) => name === "claimRun"), false);
  assert.equal(harness.calls.some(([name]) => name === "appendRunEvent"), true);
  assert.equal(harness.calls.some(([name]) => name === "setTaskStatus"), true);
});

test("deployment routes keep user, reviewer, preview, and promoter authority separate", async () => {
  const harness = makeHarness();
  assert.equal((await route(harness, "GET", "/v1/work-history/deployments", {}, "?target=gateway")).status, 200);
  assert.equal((await route(harness, "POST", "/v1/work-history/deployments/requests", { target: "gateway" })).status, 202);
  assert.equal((await route(harness, "GET", "/v1/work-history/deployments/requests", {}, "?limit=2")).status, 200);

  for (const body of [
    { mode: "preview", request_id: "dreq_1", status: "available" },
    { mode: "preview", request_id: "dreq_1", status: "failed" },
    { mode: "applied", request_id: "dreq_1", status: "available" },
    { mode: "preview", status: "available" },
  ]) assert.equal((await route(harness, "POST", "/v1/work-history/deployments", body)).status, 201);

  assert.equal((await route(harness, "GET", "/v1/work-history/deployments/requests/dreq_1")).status, 200);
  const missing = makeHarness({ workHistory: { deploymentRequestDetail: async () => null } });
  assert.equal((await route(missing, "GET", "/v1/work-history/deployments/requests/missing")).status, 404);

  assert.equal((await route(harness, "POST", "/v1/work-history/deployments/requests/dreq_1/review", { decision: "approved" })).status, 200);
  assert.equal((await route(harness, "POST", "/v1/work-history/deployments/requests/dreq_1/claim", { operation: "preview" })).status, 200);
  assert.equal((await route(harness, "POST", "/v1/work-history/deployments/requests/dreq_1/claim", { operation: "rollback" })).status, 200);
  assert.equal((await route(harness, "POST", "/v1/work-history/deployments/requests/dreq_1/verification", { operation: "apply" })).status, 201);
  assert.equal((await route(harness, "POST", "/v1/work-history/deployments/requests/dreq_1/effect")).status, 201);
  assert.equal((await route(harness, "POST", "/v1/work-history/deployments/requests/dreq_1/adopt")).status, 200);
  assert.equal((await route(harness, "POST", "/v1/work-history/deployments/requests/dreq_1/receipt")).status, 200);
});

test("preview assignment reads expose only bounded approved assignment state", async () => {
  const detail = {
    request: { request_id: "dreq_1", target: "gateway", mode: "preview", commit_sha: "abc", adapter_kind: "fake", candidate_refs: [], artifact_refs: [], provenance_ref: "p" },
    review: { decision: "approved" }, status: "preview_claimed",
    claims: [{ operation: "preview", worker_id: "preview-worker", lease_expires_at: "2099-01-01T00:00:00Z" }],
    preview_records: [], latest_preview: null, latest_preview_verification: null,
  };
  const preview = makeHarness({
    authorized: () => false,
    deploymentPrincipal: (_request, operation) => operation === "preview" ? { id: "preview-worker", actor: {} } : null,
    workHistory: { deploymentRequestDetail: async () => detail },
  });
  const response = await route(preview, "GET", "/v1/work-history/deployments/requests/dreq_1");
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.payload.request), ["request_id", "target", "mode", "commit_sha", "adapter_kind", "candidate_refs", "artifact_refs", "provenance_ref"]);

  for (const mutate of [
    (copy) => { copy.request.mode = "apply"; },
    (copy) => { copy.review.decision = "rejected"; },
    (copy) => { copy.status = "pending_review"; },
    (copy) => { copy.claims[0].worker_id = "other"; },
    (copy) => { copy.claims[0].lease_expires_at = "2000-01-01T00:00:00Z"; },
  ]) {
    const invalid = structuredClone(detail);
    mutate(invalid);
    const harness = makeHarness({
      authorized: () => false,
      deploymentPrincipal: (_request, operation) => operation === "preview" ? { id: "preview-worker", actor: {} } : null,
      workHistory: { deploymentRequestDetail: async () => invalid },
    });
    assert.match((await route(harness, "GET", "/v1/work-history/deployments/requests/dreq_1")).payload.error, /current approved preview assignment/);
  }
  const noCredential = makeHarness({ authorized: () => false, deploymentPrincipal: () => null });
  assert.match((await route(noCredential, "GET", "/v1/work-history/deployments/requests/dreq_1")).payload.error, /scoped deployment credential/);
});

test("preview mutation telemetry reflects claims and verification outcomes", async () => {
  const passed = makeHarness();
  await route(passed, "POST", "/v1/work-history/deployments/requests/dreq_1/verification", { operation: "preview" });
  assert(passed.calls.some((call) => call[0] === "telemetry" && call[1] === "preview.verification.completed"));
  const failed = makeHarness({ workHistory: { recordDeploymentVerification: async (body) => ({ ...body, status: "failed" }) } });
  await route(failed, "POST", "/v1/work-history/deployments/requests/dreq_1/verification", { operation: "preview" });
  assert(failed.calls.some((call) => call[1] === "preview.failed"));
});

test("turn handler rejects empty and unknown turns and stores recognized broker-first turns", async () => {
  const harness = makeHarness();
  assert.equal((await route(harness, "POST", "/v1/work-history/turns", {})).status, 400);
  assert.equal((await route(harness, "POST", "/v1/work-history/turns", { text: "unknown" })).status, 422);
  const result = await route(harness, "POST", "/v1/work-history/turns", { transcript: "write tests", conversation_id: "session_1" });
  assert.equal(result.status, 202);
  assert.equal(result.payload.broker_event_id, "be_1");
  assert.equal(result.payload.display, result.payload.speak);
});

test("intent execution creates inert tasks and queued runs with broker provenance", async () => {
  const harness = makeHarness();
  const context = { transcript: "build it", turnId: "turn_1", brokerEvent: { id: "be_1", decisions: [{ id: "rd_1", context_pack_id: "pack_1" }], profile_version: "pv_1" }, sessionId: "s", branchId: "b", body: { device_id: "phone", project_id: "p", harness: "codex" } };
  const queued = await harness.executeWorkHistoryIntent({ kind: "create_work", objective: "build it", owner_hint: "gateway", wants_run: true }, context);
  assert.equal(queued.refs.run_status, "queued");
  assert.equal(queued.refs.intent_id, "intent_1");
  assert.equal(queued.actions[0].type, "delivery_intent_recorded");
  const taskOnly = await harness.executeWorkHistoryIntent({ kind: "create_work", objective: "document it", wants_run: false }, { ...context, brokerEvent: null, body: {} });
  assert.equal(taskOnly.refs.run_id, "");
});

test("status intent merges worker-pull runs and answers every projection scope", async () => {
  const summary = {
    ...structuredClone(EMPTY_SUMMARY),
    queued: [{ run_id: "wr_q", status: "queued" }], active: [{ run_id: "wr_a", status: "running", worker_id: "w" }],
    blocked: [{ run_id: "wr_b", status: "blocked", blocking_reason: "approval" }], completed: [{ run_id: "wr_c", status: "completed" }],
    failed: [{ run_id: "wr_f", status: "failed", latest_summary: "boom" }], waiting_on_user: [{ run_id: "wr_w", status: "blocked", blocking_reason: "input" }],
  };
  const harness = makeHarness({
    workHistory: { statusSummary: async () => summary },
    listAllAgentRuns: () => [{ id: "run_q", status: "queued", updated_at: "2026-01-02" }, { id: "run_a", status: "running", claimed_by_worker_id: "worker", updated_at: "2026-01-01" }],
  });
  for (const scope of ["overview", "running", "failed", "waiting"]) {
    const result = await harness.executeWorkHistoryIntent({ kind: "status_query", scope }, { transcript: "status", turnId: "t", brokerEvent: null, sessionId: "s", branchId: "b" });
    assert(result.speak.length > 0);
  }
});

test("feedback, deployment, and UI intents remain proposals", async () => {
  const links = { latest_preview: { deployment_id: "dep_p", preview_url: "https://preview", status: "available" }, latest_applied: { deployment_id: "dep_a", active_url: "https://active", applied_at: "today" } };
  const harness = makeHarness({ workHistory: { deploymentLinks: async () => links } });
  const context = { transcript: "gateway", turnId: "t", brokerEvent: { id: "be" }, sessionId: "s", branchId: "b", body: {} };
  assert.equal((await harness.executeWorkHistoryIntent({ kind: "feedback", intent: "note", target: "wr_1", text: "fix" }, context)).status_code, 200);
  assert.equal((await harness.executeWorkHistoryIntent({ kind: "feedback", intent: "cancellation", control_action: "pause", target: "wr_1" }, context)).status_code, 202);
  assert.match((await harness.executeWorkHistoryIntent({ kind: "deployment_link" }, context)).speak, /Latest preview/);
  assert.equal((await harness.executeWorkHistoryIntent({ kind: "deployment_request", target: "wr_1" }, context)).status_code, 202);
  assert.equal((await harness.executeWorkHistoryIntent({ kind: "ui_open", route_kind: "run", target: "wr_1", surface: "android" }, context)).status_code, 202);

  const noRoute = makeHarness({ workHistory: { resolveUiRoute: async () => null } });
  assert.equal((await noRoute.executeWorkHistoryIntent({ kind: "ui_open", route_kind: "run", surface: "browser_extension" }, context)).status_code, 404);
  const noClient = makeHarness({ createToolRequest: () => { throw new Error("offline"); } });
  const fallback = await noClient.executeWorkHistoryIntent({ kind: "ui_open", route_kind: "run", surface: "browser_extension" }, context);
  assert.equal(fallback.status_code, 200);
  assert.equal(fallback.refs.queue_error, "offline");
  await assert.rejects(harness.executeWorkHistoryIntent({ kind: "mystery" }, context), /unsupported/);
});

test("pure status and changed-detail helpers cover empty and evidence-rich projections", async () => {
  assert.equal(workHistoryDeploymentTarget("deploy gateway"), "gateway");
  assert.equal(workHistoryDeploymentTarget("ship android phone"), "android");
  assert.equal(workHistoryDeploymentTarget("reload extension"), "browser_extension");
  assert.equal(workHistoryDeploymentTarget("publish website"), "website");
  assert.equal(workHistoryDeploymentTarget("deploy it"), "");

  const projected = agentRunStatusSummary([
    { id: "q", status: "queued", prompt_preview: "Compare voice providers", updated_at: "2" },
    { id: "a", status: "claimed", prompt_preview: "Fix the browser gesture", output_preview: "Tests are running", updated_at: "1" },
    { id: "c", status: "completed" }, { id: "f", status: "failed" }, { id: "x", status: "canceled" }, { id: "t", status: "timed-out" },
  ]);
  assert.equal(projected.failed.length, 3);
  assert.equal(mergeRunStatusSummaries(structuredClone(EMPTY_SUMMARY), projected).runs.length, 6);
  assert.equal(workHistoryStatusSpeech({ scope: "failed" }, structuredClone(EMPTY_SUMMARY), ""), "Nothing has failed.");
  assert.equal(workHistoryStatusSpeech({ scope: "waiting" }, structuredClone(EMPTY_SUMMARY), ""), "Nothing is waiting on you.");
  assert.equal(workHistoryStatusSpeech({ scope: "overview" }, structuredClone(EMPTY_SUMMARY), ""), "No work-history tasks or runs recorded yet.");
  assert.equal(workHistoryStatusSpeech({ scope: "changed" }, structuredClone(EMPTY_SUMMARY), "changed"), "changed");
  assert.match(workHistoryStatusSpeech({ scope: "running" }, mergeRunStatusSummaries(structuredClone(EMPTY_SUMMARY), projected), ""), /Fix the browser gesture/);
  assert.doesNotMatch(workHistoryStatusSpeech({ scope: "running" }, mergeRunStatusSummaries(structuredClone(EMPTY_SUMMARY), projected), ""), /Recently completed/);
  const markdown = workHistoryStatusDisplay({ scope: "running" }, mergeRunStatusSummaries(structuredClone(EMPTY_SUMMARY), projected), "");
  assert.match(markdown, /### Active agents/);
  assert.match(markdown, /\*\*a\*\* — Fix the browser gesture `claimed` — Tests are running/);
  assert.match(markdown, /### Queued agents/);
  assert.equal(workHistoryStatusDisplay({ scope: "running" }, structuredClone(EMPTY_SUMMARY), ""), "No agents are running, queued, or blocked.");

  const store = { runDetail: async () => ({
    status: "completed", before_snapshot: { branch: "main", commit_sha: "1234567890abcdef" }, after_snapshot: { commit_sha: "fedcba987654" },
    diffs: [{ diff_id: "diff_1", stats: { files: 0, insertions: 3, deletions: 1 }, changed_paths: ["a", "b"] }],
    verifications: [{ status: "passed", command: "npm test" }],
  }) };
  assert.match(await workHistoryChangedDetail({ scope: "changed", target: "wr_1" }, { runs: [] }, store), /diff_1 touches 2 files/);
  assert.equal(await workHistoryChangedDetail({ scope: "overview" }, { runs: [] }, store), "");
  assert.equal(await workHistoryChangedDetail({ scope: "changed" }, { runs: [] }, store), "No runs with recorded changes yet.");
  assert.match(await workHistoryChangedDetail({ scope: "changed", target: "missing" }, { runs: [] }, { runDetail: async () => null }), /no work run/);
});

test("fallback branches retain bounded defaults without gaining authority", async () => {
  const harness = makeHarness({
    workHistory: {
      deploymentLinks: async () => ({
        latest_preview: { deployment_id: "dep_preview", status: "building" },
        latest_applied: { deployment_id: "dep_live", recorded_at: "yesterday" },
      }),
      attachFeedback: async () => ({ feedback: { feedback_id: "fb_2", status: "recorded", target_refs: [{ id: "wr_2" }] }, control_requests: [{ control_id: "ctl_2" }] }),
    },
    listAllAgentRuns: () => [{ id: "done", status: "completed", output_preview: "ok", prompt_preview: "job" }],
  });
  const context = { transcript: "deploy it", turnId: "t", brokerEvent: {}, sessionId: "", branchId: "default", body: { source: "browser" } };
  const links = await harness.executeWorkHistoryIntent({ kind: "deployment_link" }, context);
  assert.match(links.speak, /dep_preview/);
  const emptyLinks = makeHarness();
  assert.match((await emptyLinks.executeWorkHistoryIntent({ kind: "deployment_link" }, context)).speak, /No deployment records/);
  const fallbackCreate = await harness.executeWorkHistoryIntent({ kind: "create_work", wants_run: true }, context);
  assert.equal(fallbackCreate.refs.run_status, "queued");
  const cancel = await harness.executeWorkHistoryIntent({ kind: "feedback", intent: "cancellation", text: "stop" }, context);
  assert.match(cancel.speak, /cancel request/);
  const genericUi = await harness.executeWorkHistoryIntent({ kind: "ui_open", route_kind: "run" }, context);
  assert.match(genericUi.speak, /a client/);

  await route(harness, "POST", "/v1/work-history/runs", { actor: { kind: "worker", id: "w" } });
  await route(harness, "POST", "/v1/work-history/deployments/requests/dreq_1/claim", {});
  const typed = await route(harness, "POST", "/v1/work-history/turns", { text: "typed task", turn_id: "turn_fixed", session_id: "session", branch_id: "branch", source: "browser" });
  assert.equal(typed.payload.turn_id, "turn_fixed");

  const speechSummary = {
    ...structuredClone(EMPTY_SUMMARY),
    active: [{ run_id: "a", status: "running", worker_id: "" }], queued: [{ run_id: "q", status: "queued" }],
    blocked: [{ run_id: "b", blocking_reason: "reason" }], completed: [{ run_id: "c" }], failed: [{ run_id: "f", status: "failed", blocking_reason: "blocked" }],
  };
  assert.match(workHistoryStatusSpeech({ scope: "overview" }, speechSummary, ""), /Blocked/);
  assert.match(workHistoryStatusSpeech({ scope: "failed" }, { ...structuredClone(EMPTY_SUMMARY), failed: [{ run_id: "f", status: "failed" }] }, ""), /no failure detail/);
  assert.match(workHistoryStatusSpeech({ scope: "waiting" }, { ...structuredClone(EMPTY_SUMMARY), queued: [{ run_id: "q", status: "queued" }] }, ""), /queued/);

  const beforeOnly = { status: "running", before_snapshot: { commit_sha: "" }, after_snapshot: null, diffs: [], verifications: [{ status: "failed", verification_id: "ver_2" }] };
  assert.match(await workHistoryChangedDetail({ scope: "changed", target: "wr_2" }, { runs: [] }, { runDetail: async () => beforeOnly }), /unknown/);
  const noSnapshots = { status: "running", before_snapshot: null, after_snapshot: null, diffs: [], verifications: [] };
  assert.match(await workHistoryChangedDetail({ scope: "changed" }, { runs: [{ run_id: "wr_3", status: "running", diff_count: 0, latest_event_at: "now" }] }, { runDetail: async () => noSnapshots }), /No repo snapshots/);
});
