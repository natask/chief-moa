"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { WorkerPullError, createWorkerPullStore } = require("../lib/worker-pull");

function runFixture(overrides = {}) {
  return {
    id: "run_1", status: "queued", harness: "echo", project_id: "proj_1",
    prompt: "do work", source: "test", created_at: "2026-01-01T00:00:00.000Z",
    attempt: 0, max_attempts: 2, stdout: "", stderr: "", ...overrides,
  };
}

function harness(initialRuns = [], options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-pull-test-"));
  const runs = new Map(initialRuns.map((run) => [run.id, { ...run }]));
  const events = new Map(initialRuns.map((run) => [run.id, []]));
  const productEvents = [];
  const runStore = {
    exists: (id) => runs.has(id),
    readRun: (id) => runs.get(id),
    updateRun: (id, patch) => { const next = { ...runs.get(id), ...patch }; runs.set(id, next); return next; },
    appendEvent: (id, type, payload) => {
      const row = { type, ...payload };
      events.set(id, [...(events.get(id) || []), row]);
      return row;
    },
    readEvents: (id) => events.get(id) || [],
    listRunsRaw: () => [...runs.values()],
  };
  const store = createWorkerPullStore({
    dataDir, runStore, leaseDurationMs: options.leaseDurationMs ?? 5000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 1000,
    recordEvent: options.recordEvent === false ? null : (event) => productEvents.push(event),
  });
  return {
    dataDir, runs, events, productEvents, runStore, store,
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
}

function expectCode(action, code, status) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof WorkerPullError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

function register(h, registrationBody = {}, worker = {}) {
  const registration = h.store.createRegistration(registrationBody, { actor: { kind: "user", id: "owner" } });
  const result = h.store.registerWorker({
    registration_id: registration.registration_id,
    setup_code: registration.setup_code,
    worker,
  });
  const request = { headers: { authorization: `Bearer ${result.worker_token}` } };
  return { ...result, auth: h.store.authenticate(request), request };
}

test("store validates every runStore operation and WorkerPullError metadata", () => {
  const complete = {
    exists() {}, readRun() {}, updateRun() {}, appendEvent() {}, readEvents() {}, listRunsRaw() {},
  };
  for (const key of Object.keys(complete)) {
    expectCodeLike(() => createWorkerPullStore({ runStore: { ...complete, [key]: null } }), `runStore.${key}`);
  }
  expectCodeLike(() => createWorkerPullStore({}), "runStore.exists");
  const error = new WorkerPullError(409, "stale", "stale claim", true);
  assert.equal(error.status, 409); assert.equal(error.code, "stale"); assert.equal(error.retryable, true);
});

function expectCodeLike(action, pattern) {
  assert.throws(action, (error) => String(error.message).includes(pattern));
}

test("registration normalizes aliases, bounds constraints, records events, and reports status", () => {
  const h = harness([], { leaseDurationMs: 1, heartbeatIntervalMs: Infinity });
  try {
    const result = h.store.createRegistration({
      name: "x".repeat(200), harnessAllowlist: ["Echo", "echo", "bad harness"],
      projectAllowlist: ["proj.1", "proj_2"], maxParallelClaims: 99, expiresInSeconds: 1,
    });
    assert.equal(result.constraints.max_parallel_claims, 8);
    assert.deepEqual(result.constraints.harness_allowlist, ["echo", "badharness"]);
    assert.deepEqual(result.constraints.project_allowlist, ["proj1", "proj_2"]);
    assert.equal(h.productEvents[0].event_type, "worker.registration.created");
    assert.equal(h.productEvents[0].actor.kind, "gateway");
    const status = h.store.status();
    assert.equal(status.pending_registration_count, 1);
    assert.equal(status.lease_duration_ms, 5000);
    assert.equal(status.heartbeat_interval_ms, 15000);
    assert.equal(status.worker_count, 0);
  } finally { h.cleanup(); }
});

test("registration redemption rejects missing, unknown, expired, reused, and invalid codes", () => {
  const h = harness();
  try {
    expectCode(() => h.store.registerWorker({}), "invalid_request", 400);
    expectCode(() => h.store.registerWorker({ registration_id: "missing", setup_code: "code" }), "registration_not_found", 404);
    const first = h.store.createRegistration();
    expectCode(() => h.store.registerWorker({ registration_id: first.registration_id }), "invalid_request", 400);
    expectCode(() => h.store.registerWorker({ registration_id: first.registration_id, setup_code: "wrong" }), "invalid_registration_code", 401);

    const registrationsFile = path.join(h.dataDir, "worker-registrations.json");
    const rows = JSON.parse(fs.readFileSync(registrationsFile, "utf8"));
    rows[0].expires_at = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(registrationsFile, JSON.stringify(rows));
    expectCode(() => h.store.registerWorker({ registration_id: first.registration_id, setup_code: first.setup_code }), "registration_expired", 410);

    const second = h.store.createRegistration();
    h.store.registerWorker({ registration_id: second.registration_id, setup_code: second.setup_code });
    expectCode(() => h.store.registerWorker({ registration_id: second.registration_id, setup_code: second.setup_code }), "registration_used", 409);
  } finally { h.cleanup(); }
});

test("worker registration normalizes machine capabilities without paths", () => {
  const h = harness();
  try {
    const registered = register(h, {
      name: "Default worker", harness_allowlist: "echo,codex", project_allowlist: "proj_1,proj_2",
      max_parallel_claims: "2",
    }, {
      name: "Machine", version: "1.0", machineLabel: "Desk", machineId: "machine.1",
      platform: "Mac OS!", capabilities: {
        transports: ["long_poll", "websocket", "invalid", "long_poll"],
        harnesses: [{ name: "Codex", version: "v1", supportsResume: true }, null],
        projects: [{ id: "proj_1", localAlias: "Repo Alias" }, null],
        machine: ["GPU A", null],
      },
    });
    assert.match(registered.worker_token, /^moa_wkt_/);
    assert.equal(registered.heartbeat_interval_ms, 1000);
    assert.equal(registered.lease_duration_ms, 5000);
    const workers = JSON.parse(fs.readFileSync(path.join(h.dataDir, "workers.json"), "utf8"));
    assert.equal(workers[0].platform, "mac-os-");
    assert.deepEqual(workers[0].capabilities.transports, ["long_poll", "websocket"]);
    assert.deepEqual(workers[0].capabilities.harnesses[0], { id: "codex", version: "v1", supports_resume: true });
    assert.equal(workers[0].capabilities.projects[0].local_alias, "repo-alias");
    assert.deepEqual(workers[0].capabilities.machine, ["gpu-a"]);
    assert.equal(h.store.status().worker_count, 1);
  } finally { h.cleanup(); }
});

test("authentication rejects missing, unknown, expired, revoked, and insufficient-scope tokens", () => {
  const h = harness();
  try {
    const registered = register(h);
    expectCode(() => h.store.authenticate({ headers: {} }), "invalid_worker_token", 401);
    expectCode(() => h.store.authenticate({ headers: { authorization: "Basic nope" } }), "invalid_worker_token", 401);
    expectCode(() => h.store.authenticate({ headers: { authorization: "Bearer unknown" } }), "invalid_worker_token", 401);

    const workersFile = path.join(h.dataDir, "workers.json");
    const workers = JSON.parse(fs.readFileSync(workersFile, "utf8"));
    workers[0].tokens[0].scopes = [];
    fs.writeFileSync(workersFile, JSON.stringify(workers));
    expectCode(() => h.store.authenticate(registered.request, "agent_runs:claim"), "insufficient_scope", 403);
    workers[0].tokens[0].expires_at = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(workersFile, JSON.stringify(workers));
    expectCode(() => h.store.authenticate(registered.request), "invalid_worker_token", 401);
    workers[0].tokens[0].expires_at = "2999-01-01T00:00:00.000Z";
    workers[0].tokens[0].revoked_at = "2026-01-01T00:00:00.000Z";
    fs.writeFileSync(workersFile, JSON.stringify(workers));
    expectCode(() => h.store.authenticate(registered.request), "invalid_worker_token", 401);
  } finally { h.cleanup(); }
});

test("claim enforces authority, transport, allowlists, retry timing, and deterministic queue order", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const h = harness([
    runFixture({ id: "wrong_harness", harness: "claude", created_at: "2025-01-01T00:00:00Z" }),
    runFixture({ id: "empty_project", project_id: "", created_at: "2025-01-01T12:00:00Z" }),
    runFixture({ id: "wrong_project", project_id: "proj_2", created_at: "2025-01-02T00:00:00Z" }),
    runFixture({ id: "retry_elapsed", harness: "claude", retry_after_at: "2000-01-01T00:00:00Z", created_at: "2025-01-02T12:00:00Z" }),
    runFixture({ id: "retry_later", retry_after_at: future, created_at: "2025-01-03T00:00:00Z" }),
    runFixture({ id: "eligible", created_at: "2025-01-04T00:00:00Z", timeout_ms: 50,
      conversation_id: "conv.1", branch_id: "branch.1", turn_id: "turn.1", broker_event_id: "evt.1",
      route_decision_id: "route.1", work_node_id: "work.1", context_pack_ref: "/ctx\\pack?",
      parent_run_id: "parent.1", profile_version: "profile.1", local_project_alias: "Repo Alias",
      input_artifact_refs: [{ artifactId: "artifact.1", kind: "input!", uri: "/a\\b?", sha256: "aa-11" }, null],
      deployment_candidate_refs: [{ candidateId: "candidate.1", target: "gateway!", previewUrl: "https://preview.test/a" }],
    }),
  ]);
  try {
    const registered = register(h, { harness_allowlist: ["echo"], project_allowlist: ["proj_1"] });
    expectCode(() => h.store.claim({}, null), "invalid_worker_token", 401);
    const noScope = { worker: registered.auth.worker, token: { ...registered.auth.token, scopes: [] } };
    expectCode(() => h.store.claim({ worker_id: registered.worker_id }, noScope), "insufficient_scope", 403);
    expectCode(() => h.store.claim({ worker_id: "other" }, registered.auth), "insufficient_scope", 403);
    expectCode(() => h.store.claim({ worker_id: registered.worker_id, transport: "websocket" }, registered.auth), "invalid_request", 400);
    const claimed = h.store.claim({ workerId: registered.worker_id, acceptedHarnesses: ["echo", "codex"], acceptedProjects: ["proj_1", "proj_2"] }, registered.auth);
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.claim.run_id, "eligible");
    assert.equal(claimed.run.working_dir.local_alias, "repo-alias");
    assert.equal(claimed.run.session.conversation_id, "conv1");
    assert.equal(claimed.run.artifacts.input_refs[0].artifact_id, "artifact1");
    assert.equal(claimed.run.deployments.candidate_refs[0].applied, false);
    assert.equal(h.events.get("eligible")[0].type, "claimed");
    assert.equal(h.productEvents.at(-1).event_type, "worker.run.claimed");
    const none = h.store.claim({ worker_id: registered.worker_id }, registered.auth);
    assert.deepEqual(Object.keys(none).sort(), ["claimed", "retry_after_ms", "server_time"]);
  } finally { h.cleanup(); }
});

test("heartbeat validates current claim and reports event- or state-based cancellation", () => {
  const h = harness([runFixture()]);
  try {
    const registered = register(h);
    const claimed = h.store.claim({ worker_id: registered.worker_id }, registered.auth);
    const common = { worker_id: registered.worker_id, claim_id: claimed.claim.claim_id };
    expectCode(() => h.store.heartbeat("missing", common, registered.auth), "run_not_found", 404);
    expectCode(() => h.store.heartbeat("run_1", { ...common, worker_id: "other" }, registered.auth), "insufficient_scope", 403);
    expectCode(() => h.store.heartbeat("run_1", { ...common, claim_id: "stale" }, registered.auth), "stale_claim", 409);
    const noHarness = { ...registered.auth, token: { ...registered.auth.token, harness_allowlist: ["codex"] } };
    expectCode(() => h.store.heartbeat("run_1", common, noHarness), "insufficient_scope", 403);
    const noProject = { ...registered.auth, token: { ...registered.auth.token, project_allowlist: ["other"] } };
    expectCode(() => h.store.heartbeat("run_1", common, noProject), "insufficient_scope", 403);

    const first = h.store.heartbeat("run_1", { ...common, status: "claimed", progress: { nested: { value: "ok" } }, lastEventSeq: 3, observedAt: "bad" }, registered.auth);
    assert.equal(first.cancel_requested, false);
    assert.equal(h.runs.get("run_1").status, "claimed");
    h.events.get("run_1").push({ type: "cancel_requested" });
    const second = h.store.heartbeat("run_1", { ...common, status: "RUNNING", last_event_seq: 4, observed_at: "2026-01-01T00:00:00Z" }, registered.auth);
    assert.equal(second.cancel_requested, true);
    assert.equal(h.runs.get("run_1").status, "running");
    h.runs.get("run_1").cancel_requested = true;
    assert.equal(h.store.heartbeat("run_1", common, registered.auth).cancel_requested, true);
  } finally { h.cleanup(); }
});

test("event append bounds batches, deduplicates ids, advances sequence, and sanitizes data", () => {
  const h = harness([runFixture()]);
  try {
    const registered = register(h);
    const claimed = h.store.claim({ worker_id: registered.worker_id }, registered.auth);
    const common = { workerId: registered.worker_id, claimId: claimed.claim.claim_id };
    expectCode(() => h.store.appendEvents("run_1", common, registered.auth), "invalid_request", 400);
    expectCode(() => h.store.appendEvents("run_1", { ...common, events: Array(51).fill({}) }, registered.auth), "event_too_large", 413);
    h.events.get("run_1").push({ worker_event_id: "known" });
    const deep = { value: { value: { value: { value: { value: { value: { value: "too deep" } } } } } } };
    const result = h.store.appendEvents("run_1", { ...common, events: [
      { eventId: "known", seq: 1 },
      { event_id: "new.1", seq: 7, type: "Progress Started!", observedAt: "bad", data: { text: "x".repeat(5000), deep, fn: () => 1 } },
      null,
    ] }, registered.auth);
    assert.deepEqual(result, { ok: true, accepted: 2, duplicate: 1, last_event_seq: 7, cancel_requested: false });
    assert.equal(h.runs.get("run_1").status, "running");
    assert.equal(h.runs.get("run_1").last_worker_event_seq, 7);
    assert.ok(h.events.get("run_1").some((row) => row.type === "progress_started_"));
  } finally { h.cleanup(); }
});

test("terminal results validate status and persist bounded output, refs, and aliases", () => {
  const h = harness([runFixture({ stdout: "old out", stderr: "old err", session_id: "prior" })]);
  try {
    const registered = register(h);
    const claimed = h.store.claim({ worker_id: registered.worker_id }, registered.auth);
    const common = { worker_id: registered.worker_id, claim_id: claimed.claim.claim_id };
    expectCode(() => h.store.result("run_1", { ...common, status: "running" }, registered.auth), "invalid_request", 400);
    const result = h.store.result("run_1", {
      ...common, status: "COMPLETED", finishedAt: "bad", exit_code: "0", signal: "SIGTERM!",
      stdoutTail: "new out", stderr_tail: "new err", error: "none", sessionId: "session_2",
      artifacts: [{ artifactId: "artifact.1", kind: "log!", uri: "artifact://out", sha256: "aa-11" }, "bad"],
      deployments: [{ id: "deploy.1", target: "gateway!", preview_url: "javascript:bad" }, { previewUrl: "https://preview.test" }],
    }, registered.auth);
    assert.equal(result.run.status, "completed");
    assert.deepEqual(result.run.artifact_refs, ["artifact1"]);
    assert.deepEqual(result.run.deployment_refs, ["deploy1"]);
    assert.equal(h.runs.get("run_1").stdout, "old out\nnew out");
    assert.equal(h.runs.get("run_1").stderr, "old err\nnew err");
    assert.equal(h.runs.get("run_1").output, "new out");
    assert.equal(h.productEvents.at(-1).event_type, "worker.run.result");
    expectCode(() => h.store.result("run_1", { ...common, status: "failed" }, registered.auth), "stale_claim", 409);
  } finally { h.cleanup(); }
});

test("expired claims requeue retryable work and fail exhausted or canceled work", () => {
  const expired = "2000-01-01T00:00:00.000Z";
  const h = harness([
    runFixture({ id: "retry", status: "running", claim_id: "c1", claimed_by_worker_id: "w1", lease_expires_at: expired, attempt: 1, max_attempts: 2 }),
    runFixture({ id: "exhausted", status: "claimed", claim_id: "c2", claimed_by_worker_id: "w1", lease_expires_at: expired, attempt: 2, max_attempts: 2 }),
    runFixture({ id: "canceled", status: "running", claim_id: "c3", claimed_by_worker_id: "w1", lease_expires_at: expired, attempt: 1, max_attempts: 2, cancel_requested: true }),
    runFixture({ id: "invalid_lease", status: "running", lease_expires_at: "bad" }),
    runFixture({ id: "future", status: "running", lease_expires_at: "2999-01-01T00:00:00Z" }),
    runFixture({ id: "queued", status: "queued", lease_expires_at: expired }),
  ]);
  try {
    h.store.cleanupExpiredClaims();
    assert.equal(h.runs.get("retry").status, "queued");
    assert.equal(h.runs.get("retry").retry_reason, "worker claim expired");
    assert.equal(h.runs.get("exhausted").status, "failed");
    assert.equal(h.runs.get("canceled").status, "failed");
    assert.equal(h.runs.get("invalid_lease").status, "running");
    assert.equal(h.runs.get("future").status, "running");
    assert.equal(h.store.status().queued_run_count, 2);
    assert.equal(h.store.status().claimed_run_count, 2);
  } finally { h.cleanup(); }
});

test("store works without product-event recording and tolerates malformed persisted row files", () => {
  const h = harness([], { recordEvent: false });
  try {
    fs.writeFileSync(path.join(h.dataDir, "worker-registrations.json"), "not json");
    fs.writeFileSync(path.join(h.dataDir, "workers.json"), JSON.stringify({ wrong: true }));
    assert.equal(h.store.status().worker_count, 0);
    assert.equal(h.store.createRegistration().constraints.max_parallel_claims, 1);
  } finally { h.cleanup(); }
});

test("registration and worker camelCase aliases preserve bounded defaults", () => {
  const h = harness();
  try {
    const registration = h.store.createRegistration({
      harnessAllowlist: "Echo,Codex", projectAllowlist: "proj_1", maxParallelClaims: 0,
      expiresInSeconds: 99999,
    }, { actor: "not-an-object" });
    assert.equal(registration.constraints.max_parallel_claims, 1);
    const worker = h.store.registerWorker({
      registrationId: registration.registration_id,
      setupCode: registration.setup_code,
      worker: "not-an-object",
    });
    assert.equal(worker.websocket_url, "/v1/agent/workers/ws");
    const auth = h.store.authenticate({ headers: { authorization: `Bearer ${worker.worker_token}` } });
    assert.equal(auth.worker.name, "Moa worker");
    assert.equal(auth.worker.version, "");
    assert.deepEqual(auth.token.scopes.length, 6);
    const rows = JSON.parse(fs.readFileSync(path.join(h.dataDir, "workers.json"), "utf8"));
    assert.equal(rows[0].machine_id, "");
    assert.deepEqual(rows[0].capabilities, { transports: [], harnesses: [], projects: [], machine: [] });
  } finally { h.cleanup(); }
});

test("authentication supplies safe defaults for legacy worker and token rows", () => {
  const h = harness();
  try {
    const registered = register(h);
    const file = path.join(h.dataDir, "workers.json");
    const workers = JSON.parse(fs.readFileSync(file, "utf8"));
    workers[0].worker_id = "";
    workers[0].name = "";
    workers[0].version = "";
    delete workers[0].tokens[0].scopes;
    delete workers[0].tokens[0].harness_allowlist;
    delete workers[0].tokens[0].project_allowlist;
    workers[0].tokens[0].max_parallel_claims = 0;
    fs.writeFileSync(file, JSON.stringify(workers));
    const auth = h.store.authenticate(registered.request);
    assert.equal(auth.worker.worker_id, workers[0].id);
    assert.deepEqual(auth.token.scopes, []);
    assert.deepEqual(auth.token.harness_allowlist, []);
    assert.deepEqual(auth.token.project_allowlist, []);
    assert.equal(auth.token.max_parallel_claims, 1);
  } finally { h.cleanup(); }
});

test("claims with unrestricted tokens cover minimal run defaults and retry eligibility", () => {
  const h = harness([
    runFixture({ id: "minimal", harness: "", project_id: "", prompt: "", source: "", created_at: "", retry_after_at: "bad",
      conversation_id: "", session_id: "", branch_id: "", artifacts: { input_refs: [{ uri: "relative/path" }], output_refs: [{ artifact_id: "out" }] },
      deployments: { candidate_refs: [{ preview_url: "not a url" }] },
    }),
  ]);
  try {
    const registered = register(h, { harness_allowlist: [], project_allowlist: [] });
    const unrestricted = {
      worker: registered.auth.worker,
      token: { ...registered.auth.token, harness_allowlist: [], project_allowlist: [] },
    };
    const claimed = h.store.claim({ worker_id: registered.worker_id, accepted_harnesses: "", accepted_projects: "" }, unrestricted);
    assert.equal(claimed.run.harness, "echo");
    assert.equal(claimed.run.working_dir.project_id, "proj_default");
    assert.equal(claimed.run.working_dir.local_alias, "proj_default");
    assert.equal(claimed.run.session.session_id, "default");
    assert.equal(claimed.run.session.branch_id, "default");
    assert.equal(claimed.run.artifacts.input_refs[0].uri, "relative/path");
    assert.equal(claimed.run.deployments.candidate_refs.length, 0);
  } finally { h.cleanup(); }
});

test("heartbeat and worker events cover defaults, aliases, primitives, and generated ids", () => {
  const h = harness([runFixture()]);
  try {
    const registered = register(h);
    const claimed = h.store.claim({ worker_id: registered.worker_id }, registered.auth);
    const common = { workerId: registered.worker_id, claimId: claimed.claim.claim_id };
    const heartbeat = h.store.heartbeat("run_1", { ...common, progress: [1, "two", null, true], last_event_seq: "bad" }, registered.auth);
    assert.equal(heartbeat.ok, true);
    assert.equal(h.runs.get("run_1").status, "running");
    const result = h.store.appendEvents("run_1", { ...common, events: [
      { seq: -1, type: "", observed_at: "2026-01-01T00:00:00Z", data: [1, false, null, Symbol("x")] },
      { event_id: "", eventId: "alias_id", seq: "bad", data: "text" },
      { event_id: "only_id", data: 4 },
    ] }, registered.auth);
    assert.equal(result.accepted, 3);
    assert.equal(result.last_event_seq, 0);
    assert.ok(h.events.get("run_1").some((event) => event.worker_event_id === "alias_id"));
    const wide = Object.fromEntries(Array.from({ length: 85 }, (_, index) => [`key_${index}`, index]));
    h.store.heartbeat("run_1", { ...common, progress: { wide, list: Array(55).fill("item") } }, registered.auth);
    assert.equal(Object.keys(h.runs.get("run_1").progress.wide).length, 80);
    assert.equal(h.runs.get("run_1").progress.list.length, 50);
  } finally { h.cleanup(); }
});

test("every terminal result status covers output priority and optional metadata defaults", () => {
  for (const [status, body] of [
    ["failed", { output: "explicit", stdout_tail: "stdout", stderrTail: "stderr", exit_code: null, signal: null }],
    ["timed-out", { stdout_tail: "stdout only", artifacts: "bad", deployments: "bad" }],
    ["canceled", { stderr_tail: "stderr only", finished_at: "2026-02-01T00:00:00Z" }],
  ]) {
    const h = harness([runFixture({ stdout: "x".repeat(120000), stderr: "" })]);
    try {
      const registered = register(h);
      const claimed = h.store.claim({ worker_id: registered.worker_id }, registered.auth);
      const result = h.store.result("run_1", {
        worker_id: registered.worker_id, claim_id: claimed.claim.claim_id, status, ...body,
      }, registered.auth);
      assert.equal(result.run.status, status);
      assert.ok(h.runs.get("run_1").stdout.length <= 120000);
      assert.equal(h.runs.get("run_1").session_id, "");
    } finally { h.cleanup(); }
  }
});

test("artifact and deployment aliases filter invalid rows and normalize valid URLs", () => {
  const h = harness([runFixture()]);
  try {
    const registered = register(h);
    const claimed = h.store.claim({ worker_id: registered.worker_id }, registered.auth);
    h.store.result("run_1", {
      worker_id: registered.worker_id, claim_id: claimed.claim.claim_id, status: "completed",
      artifacts: [{ artifact_id: "", uri: "" }, [], { artifact_id: "direct", uri: "\\root\\file" }],
      deployments: [[], { candidate_id: "direct", preview_url: "ftp://example.test" }, { candidateId: "alias", previewUrl: "http://example.test/a" }],
    }, registered.auth);
    assert.deepEqual(h.runs.get("run_1").artifact_refs, ["direct"]);
    assert.deepEqual(h.runs.get("run_1").deployment_refs, ["direct", "alias"]);
    assert.equal(h.runs.get("run_1").deployment_candidate_refs[0].preview_url, "");
    assert.equal(h.runs.get("run_1").deployment_candidate_refs[1].preview_url, "http://example.test/a");
  } finally { h.cleanup(); }
});

test("corrupt setup hashes fail safely and pending status excludes expired or used registrations", () => {
  const h = harness();
  try {
    const first = h.store.createRegistration();
    const second = h.store.createRegistration();
    const file = path.join(h.dataDir, "worker-registrations.json");
    const registrations = JSON.parse(fs.readFileSync(file, "utf8"));
    registrations[0].setup_code_hash = "aa";
    registrations[1].used_at = "2026-01-01T00:00:00Z";
    fs.writeFileSync(file, JSON.stringify(registrations));
    expectCode(() => h.store.registerWorker({ registration_id: first.registration_id, setup_code: first.setup_code }), "invalid_registration_code", 401);
    assert.equal(h.store.status().pending_registration_count, 1);
    registrations[0].expires_at = "2000-01-01T00:00:00Z";
    fs.writeFileSync(file, JSON.stringify(registrations));
    assert.equal(h.store.status().pending_registration_count, 0);
    assert.ok(second.registration_id);
  } finally { h.cleanup(); }
});

test("registration actor and capability bounds use safe fallbacks", () => {
  const h = harness();
  try {
    h.store.createRegistration({}, { actor: { kind: "!!!", id: "..." } });
    const registration = JSON.parse(fs.readFileSync(path.join(h.dataDir, "worker-registrations.json"), "utf8"))[0];
    assert.deepEqual(registration.created_by, { kind: "gateway", id: "worker-pull" });

    const created = h.store.createRegistration({ harness_allowlist: Array(25).fill("echo"), project_allowlist: Array(55).fill("proj") });
    const worker = h.store.registerWorker({ registration_id: created.registration_id, setup_code: created.setup_code, worker: {
      capabilities: { transports: Array(15).fill("long_poll"), harnesses: Array(25).fill({ id: "echo" }), projects: Array(55).fill({ id: "proj" }), machine: Array(55).fill("gpu") },
    } });
    assert.ok(worker.worker_id);
  } finally { h.cleanup(); }
});

test("legacy empty fields retain safe defaults across registration, auth, claim, events, and result", () => {
  const h = harness([runFixture({
    conversation_id: "...", project_id: "...", max_attempts: 0,
  })]);
  try {
    const registration = h.store.createRegistration();
    const registrationFile = path.join(h.dataDir, "worker-registrations.json");
    const registrations = JSON.parse(fs.readFileSync(registrationFile, "utf8"));
    registrations[0].name = "";
    fs.writeFileSync(registrationFile, JSON.stringify(registrations));
    const registered = h.store.registerWorker({
      registration_id: registration.registration_id,
      setup_code: registration.setup_code,
      worker: { capabilities: [] },
    });
    const request = { headers: { authorization: `Bearer ${registered.worker_token}` } };
    const workerFile = path.join(h.dataDir, "workers.json");
    const workers = JSON.parse(fs.readFileSync(workerFile, "utf8"));
    delete workers[0].name;
    delete workers[0].version;
    delete workers[0].tokens[0].scopes;
    fs.writeFileSync(workerFile, JSON.stringify(workers));
    expectCode(() => h.store.authenticate(request, "agent_runs:claim"), "insufficient_scope", 403);

    workers[0].tokens[0].scopes = ["agent_runs:claim", "agent_runs:heartbeat", "agent_runs:append_event", "agent_runs:complete"];
    delete workers[0].tokens[0].harness_allowlist;
    delete workers[0].tokens[0].project_allowlist;
    fs.writeFileSync(workerFile, JSON.stringify(workers));
    const auth = h.store.authenticate(request);
    assert.equal(auth.worker.name, "");
    const claimed = h.store.claim({ worker_id: registered.worker_id }, auth);
    assert.equal(claimed.run.session.session_id, "default");
    assert.equal(claimed.run.working_dir.project_id, "proj_default");
    assert.equal(h.runs.get("run_1").max_attempts, 2);
    const common = { worker_id: registered.worker_id, claim_id: claimed.claim.claim_id };
    h.store.heartbeat("run_1", common, auth);
    h.store.appendEvents("run_1", {
      ...common,
      events: [{ type: { toString: () => "" }, data: undefined }],
    }, auth);
    assert.ok(h.events.get("run_1").some((event) => event.type === "worker_event"));
    h.store.result("run_1", { ...common, status: "completed" }, auth);
    assert.equal(h.runs.get("run_1").output, "");
  } finally { h.cleanup(); }
});

test("missing persisted setup hashes fail with constant-time-safe mismatch", () => {
  const h = harness();
  try {
    const registration = h.store.createRegistration();
    const file = path.join(h.dataDir, "worker-registrations.json");
    const registrations = JSON.parse(fs.readFileSync(file, "utf8"));
    delete registrations[0].setup_code_hash;
    fs.writeFileSync(file, JSON.stringify(registrations));
    expectCode(() => h.store.registerWorker({ registration_id: registration.registration_id, setup_code: registration.setup_code }), "invalid_registration_code", 401);
  } finally { h.cleanup(); }
});
