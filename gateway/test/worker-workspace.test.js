"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createWorkerRuntime, cliHarness, forbiddenClaimKeys } = require("../lib/worker-runtime");
const { createWorkerPullStore } = require("../lib/worker-pull");
const { WorkerWorkspaceError, createWorkerWorkspace, loadWorkerProjectConfig } = require("../lib/worker-workspace");

test("persistent worker reconstructs a base and reuses a durable run worktree", async (t) => {
  const fixture = fixtureRepo(t);
  const root = tempDir(t);
  const configPath = writeConfig(root, {
    workspace_root: path.join(root, "workspace"),
    projects: [{ id: "proj_fixture", local_alias: "fixture", repo_url: fixture, default_ref: "main", path: "projects/fixture" }],
  });
  const workspace = createWorkerWorkspace(loadWorkerProjectConfig(configPath));
  const first = workspace.prepareRun({ projectId: "proj_fixture", alias: "fixture", runId: "run_123" });
  assert.equal(first.reused, false);
  assert.equal(fs.readFileSync(path.join(first.work_dir, "README.md"), "utf8"), "fixture\n");
  fs.writeFileSync(path.join(first.work_dir, "survives.txt"), "durable\n");
  const second = workspace.prepareRun({ projectId: "proj_fixture", alias: "fixture", runId: "run_123" });
  assert.equal(second.reused, true);
  assert.equal(fs.readFileSync(path.join(second.work_dir, "survives.txt"), "utf8"), "durable\n");

  fs.rmSync(fixture, { recursive: true, force: true });
  const another = workspace.prepareRun({ projectId: "proj_fixture", alias: "fixture", runId: "run_456" });
  assert.equal(another.reused, false, "existing base must be reused without reaching the source repository");
});

test("worker-local config and claims reject traversal, symlink escape, and unsafe identifiers", (t) => {
  const fixture = fixtureRepo(t);
  const root = tempDir(t);
  assert.throws(() => loadWorkerProjectConfig(writeConfig(root, {
    projects: [{ id: "proj_fixture", repo_url: fixture }],
  })), (error) => error.code === "invalid_workspace_root");
  assert.throws(() => loadWorkerProjectConfig(writeConfig(root, {
    workspace_root: "relative/workspace",
    projects: [{ id: "proj_fixture", repo_url: fixture }],
  })), (error) => error.code === "invalid_workspace_root");
  assert.throws(() => loadWorkerProjectConfig(writeConfig(root, {
    workspace_root: path.join(root, "workspace-a"),
    projects: [{ id: "proj_fixture", repo_url: fixture, path: "../escape" }],
  })), (error) => error instanceof WorkerWorkspaceError && error.code === "unsafe_path");

  const workspaceRoot = path.join(root, "workspace-b");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(workspaceRoot, "projects"));
  const workspace = createWorkerWorkspace({
    workspace_root: workspaceRoot,
    projects: [{ id: "proj_fixture", local_alias: "fixture", repo_url: fixture, default_ref: "main", path: "projects/fixture" }],
  });
  assert.throws(() => workspace.prepareRun({ projectId: "proj_fixture", alias: "fixture", runId: "run_safe" }), (error) => error.code === "symlink_escape");
  assert.throws(() => workspace.resolveProject("proj_fixture", "../fixture"), (error) => error.code === "unsafe_identifier");
  assert.throws(() => workspace.prepareRun({ projectId: "proj_fixture", alias: "fixture", runId: "../run" }), (error) => error.code === "unsafe_identifier");
  assert.throws(() => workspace.resolveProject("proj_unknown", "fixture"), (error) => error.code === "unknown_project");
});

test("canonical workspace rejects external git-dir/common-dir and foreign worktree ownership", (t) => {
  const fixture = fixtureRepo(t);
  const root = tempDir(t);
  const realParent = path.join(root, "real-parent");
  fs.mkdirSync(realParent);
  fs.symlinkSync(realParent, path.join(root, "parent-alias"));
  const workspaceRoot = path.join(root, "parent-alias", "workspace");
  const config = { workspace_root: workspaceRoot, projects: [{ id: "proj_fixture", local_alias: "fixture", repo_url: fixture, default_ref: "main", path: "projects/fixture" }] };
  const workspace = createWorkerWorkspace(config);
  const first = workspace.prepareRun({ projectId: "proj_fixture", alias: "fixture", runId: "run_owned" });
  assert.equal(first.work_dir.startsWith(fs.realpathSync(workspaceRoot)), true, "returned paths must use the canonical workspace root");

  git(["-C", first.base_path, "worktree", "remove", "--force", first.work_dir]);
  const foreign = fixtureRepo(t);
  git(["-C", foreign, "worktree", "add", "--detach", first.work_dir, "main"]);
  assert.throws(() => workspace.prepareRun({ projectId: "proj_fixture", alias: "fixture", runId: "run_owned" }), (error) => error.code === "git_ownership_escape");

  const escapedRoot = path.join(root, "escaped-workspace");
  const base = path.join(escapedRoot, "projects", "fixture");
  const outsideGit = path.join(root, "outside.git");
  fs.mkdirSync(base, { recursive: true });
  git(["clone", "--bare", fixture, outsideGit]);
  git(["--git-dir", outsideGit, "config", "core.bare", "false"]);
  git(["--git-dir", outsideGit, "config", "core.worktree", base]);
  fs.writeFileSync(path.join(base, ".git"), `gitdir: ${outsideGit}\n`);
  const escaped = createWorkerWorkspace({ workspace_root: escapedRoot, projects: config.projects });
  assert.throws(() => escaped.prepareRun({ projectId: "proj_fixture", alias: "fixture", runId: "run_escape" }), (error) => error.code === "git_ownership_escape");
});

test("run locks are atomic and record claim authority", (t) => {
  const fixture = fixtureRepo(t);
  const root = tempDir(t);
  const workspace = createWorkerWorkspace({ workspace_root: path.join(root, "workspace"), projects: [{ id: "proj_fixture", local_alias: "fixture", repo_url: fixture, default_ref: "main", path: "projects/fixture" }] });
  const lock = workspace.acquireRunLock({ projectId: "proj_fixture", alias: "fixture", runId: "run_lock", claimId: "clm_one", attempt: 2, workerId: "wrk_one", machineId: "machine_one" });
  const stored = JSON.parse(fs.readFileSync(lock.path, "utf8"));
  assert.deepEqual({ claim_id: stored.claim_id, attempt: stored.attempt, worker_id: stored.worker_id, machine_id: stored.machine_id, pid: stored.pid }, { claim_id: "clm_one", attempt: 2, worker_id: "wrk_one", machine_id: "machine_one", pid: process.pid });
  assert.throws(() => workspace.acquireRunLock({ projectId: "proj_fixture", alias: "fixture", runId: "run_lock", claimId: "clm_two", attempt: 3, workerId: "wrk_two", machineId: "machine_one" }), (error) => error.code === "run_locked");
  lock.release();
  const next = workspace.acquireRunLock({ projectId: "proj_fixture", alias: "fixture", runId: "run_lock", claimId: "clm_two", attempt: 3, workerId: "wrk_two", machineId: "machine_one" });
  next.release();

  fs.writeFileSync(next.path, JSON.stringify({ ...next.identity, nonce: "dead", pid: 2147483647 }));
  const recovered = workspace.acquireRunLock({ projectId: "proj_fixture", alias: "fixture", runId: "run_lock", claimId: "clm_three", attempt: 4, workerId: "wrk_three", machineId: "machine_one" });
  assert.equal(recovered.identity.claim_id, "clm_three");
  recovered.release();

  fs.writeFileSync(next.path, JSON.stringify({ ...next.identity, nonce: "foreign", pid: 2147483647, machine_id: "machine_foreign" }));
  assert.throws(() => workspace.acquireRunLock({ projectId: "proj_fixture", alias: "fixture", runId: "run_lock", claimId: "clm_four", attempt: 5, workerId: "wrk_four", machineId: "machine_one" }), (error) => error.code === "run_locked");
  fs.unlinkSync(next.path);
});

test("CLI harness runs in the prepared durable worktree and does not delete it", async (t) => {
  const root = tempDir(t);
  const workDir = path.join(root, "worktree");
  fs.mkdirSync(workDir);
  const fakeCli = path.join(root, "fake-cli.sh");
  fs.writeFileSync(fakeCli, "#!/bin/sh\npwd\nprintf '%s' \"$1\" > cli-output.txt\n", { mode: 0o755 });
  const harness = cliHarness(fakeCli, (run) => [String(run.prompt)]);
  const result = await harness({ prompt: "hello", timeout_ms: 10_000 }, { workDir, isCanceled: () => false });
  assert.equal(result.exit_code, 0);
  assert.equal(result.output, fs.realpathSync(workDir));
  assert.equal(fs.readFileSync(path.join(workDir, "cli-output.txt"), "utf8"), "hello");
  assert.equal(fs.existsSync(workDir), true);
  await assert.rejects(() => harness({ prompt: "no workspace" }, {}), /prepared worker-local worktree/);
});

test("CLI harness bounds captured output while preserving tails", async (t) => {
  const root = tempDir(t);
  const workDir = path.join(root, "worktree");
  fs.mkdirSync(workDir);
  const fakeCli = path.join(root, "noisy-cli.js");
  fs.writeFileSync(fakeCli, `#!${process.execPath}\nprocess.stdout.write("A".repeat(200000) + "OUT-END");\nprocess.stderr.write("B".repeat(200000) + "ERR-END");\n`, { mode: 0o755 });
  const result = await cliHarness(fakeCli, () => [])({ timeout_ms: 10_000 }, { workDir, isCanceled: () => false });
  assert.equal(result.output.length <= 120_003, true);
  assert.equal(result.stdout_tail.length <= 16_000, true);
  assert.equal(result.stderr_tail.length <= 16_000, true);
  assert.match(result.stdout_tail, /OUT-END$/);
  assert.match(result.stderr_tail, /ERR-END$/);
});

test("registration exposes stable normalized machine capabilities without local paths", async (t) => {
  const fixture = fixtureRepo(t);
  const root = tempDir(t);
  const workspaceRoot = path.join(root, "private-workspace");
  const configPath = writeConfig(root, {
    workspace_root: workspaceRoot,
    projects: [{ id: "proj_fixture", local_alias: "fixture", repo_url: fixture, default_ref: "main", path: "projects/fixture" }],
  });
  let requestBody;
  const runtime = createWorkerRuntime({
    gatewayUrl: "https://gateway.invalid",
    registrationId: "wreg_fixture",
    setupCode: "MOA-WORKER-TEST-CODE",
    machineId: "machine_fixture",
    machineCapabilities: ["Xcode", "macOS", "xcode", "browser qa"],
    projectConfigFile: configPath,
    harnesses: { echo: async (run) => ({ exit_code: 0, output: run.prompt }) },
    fetch: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ worker_id: "wrk_fixture", worker_token: "token", token_id: "wkt_fixture", heartbeat_interval_ms: 15_000 }), { status: 201 });
    },
    log: () => {},
  });
  await runtime.ensureCredentials();
  assert.equal(requestBody.worker.machine_id, "machine_fixture");
  assert.deepEqual(requestBody.worker.capabilities.machine, ["xcode", "macos", "browser-qa"]);
  assert.deepEqual(requestBody.worker.capabilities.projects, [{ id: "proj_fixture", local_alias: "fixture", path_policy: "local_allowlist" }]);
  const serialized = JSON.stringify(requestBody);
  assert.equal(serialized.includes(workspaceRoot), false);
  assert.equal(serialized.includes(fixture), false);
  assert.equal(serialized.includes("repo_url"), false);
});

test("claim authority rejects commands, arguments, environment, credentials, and paths at any depth", () => {
  assert.deepEqual(forbiddenClaimKeys({ nested: { command: "sh", args: ["-c"], env: {}, repo_url: "local", path: "/tmp" } }), ["args", "command", "env", "path", "repo_url"]);
  assert.deepEqual(forbiddenClaimKeys({ prompt: "please inspect /tmp as text", working_dir: { project_id: "proj_fixture", local_alias: "fixture" } }), []);
});

test("gateway stores normalized machine metadata and never invents local paths", (t) => {
  const dataDir = tempDir(t);
  const runStore = {
    exists: () => false, readRun: () => null, updateRun: () => null,
    appendEvent: () => {}, readEvents: () => [], listRunsRaw: () => [],
  };
  const store = createWorkerPullStore({ dataDir, runStore });
  const registration = store.createRegistration({ project_allowlist: ["proj_fixture"] });
  store.registerWorker({
    registration_id: registration.registration_id,
    setup_code: registration.setup_code,
    worker: {
      name: "fixture", machine_id: "machine_fixture", platform: "macOS ARM64",
      capabilities: { machine: ["Xcode", "xcode", "desktop QA"], projects: [{ id: "proj_fixture", local_alias: "fixture", path: "/must/not/store" }] },
    },
  });
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "workers.json"), "utf8"))[0];
  assert.equal(persisted.machine_id, "machine_fixture");
  assert.equal(persisted.platform, "macos-arm64");
  assert.deepEqual(persisted.capabilities.machine, ["xcode", "desktop-qa"]);
  assert.equal(JSON.stringify(persisted).includes("/must/not/store"), false);
});

test("echo remains checkout-independent when no projects are configured", async () => {
  const requests = [];
  const runtime = createWorkerRuntime({
    gatewayUrl: "https://gateway.invalid",
    workerId: "wrk_fixture",
    token: "token",
    once: true,
    harnesses: { echo: async (run) => ({ exit_code: 0, output: run.prompt, stdout_tail: run.prompt }) },
    fetch: async (url, init) => {
      const pathname = new URL(url).pathname;
      const body = JSON.parse(init.body);
      requests.push({ pathname, body });
      if (pathname.endsWith("/claim")) return jsonResponse({
        claimed: true,
        claim: { claim_id: "clm_fixture", attempt: 1 },
        run: { id: "run_fixture", harness: "echo", prompt: "compatible", working_dir: { project_id: "proj_default", local_alias: "proj_default" }, work: { project_id: "proj_default" } },
      });
      return jsonResponse({ ok: true, cancel_requested: false });
    },
    log: () => {},
  });
  const summary = await runtime.runLoop();
  assert.equal(summary.processed[0].status, "completed");
  assert.equal(requests.find((item) => item.pathname.endsWith("/result")).body.output, "compatible");
});

test("integrated real CLI uses a durable worktree and maps nonzero exit to failed", async (t) => {
  const success = await integratedCliRun(t, { runId: "run_success", prompt: "success" });
  assert.equal(success.summary.processed[0].status, "completed");
  assert.equal(success.result.status, "completed");
  assert.equal(fs.readFileSync(path.join(success.workDir, "observed-cwd.txt"), "utf8").trim(), fs.realpathSync(success.workDir));
  assert.equal(fs.readFileSync(path.join(success.workDir, "durable.txt"), "utf8"), "durable\n");

  const failure = await integratedCliRun(t, { runId: "run_failure", prompt: "fail" });
  assert.equal(failure.summary.processed[0].status, "failed");
  assert.equal(failure.result.status, "failed");
  assert.equal(failure.result.exit_code, 7);
  assert.equal(fs.existsSync(path.join(failure.workDir, "durable.txt")), true, "failed run worktree must persist");

  const signaled = await integratedCliRun(t, { runId: "run_signaled", prompt: "signal" });
  assert.equal(signaled.summary.processed[0].status, "failed");
  assert.equal(signaled.result.status, "failed");
  assert.equal(signaled.result.exit_code, null);
});

test("integrated live-lock wait expiry leaves gateway lease/requeue authoritative", async (t) => {
  const setup = integratedSetup(t, "run_collision");
  const held = setup.workspace.acquireRunLock({ projectId: "proj_fixture", alias: "fixture", runId: "run_collision", claimId: "clm_old", attempt: 1, workerId: "wrk_old", machineId: "machine_fixture" });
  try {
    const run = await executeIntegrated(setup, { runId: "run_collision", prompt: "success", claimId: "clm_new", attempt: 2, lockWaitMs: 120, lockRetryMs: 20 });
    assert.equal(run.summary.processed[0].status, "lock-wait-expired");
    assert.equal(run.result, null);
    assert.equal(run.calls.some((item) => item.pathname.endsWith("/result")), false);
    assert.equal(fs.existsSync(path.join(setup.workspaceRoot, "worktrees", "fixture", "run_collision", "durable.txt")), false);
  } finally {
    held.release();
  }
});

test("integrated live-lock handoff runs exactly one replacement CLI after release", async (t) => {
  const setup = integratedSetup(t, "run_handoff");
  const held = setup.workspace.acquireRunLock({ projectId: "proj_fixture", alias: "fixture", runId: "run_handoff", claimId: "clm_old", attempt: 1, workerId: "wrk_old", machineId: "machine_fixture" });
  const release = setTimeout(() => held.release(), 120);
  try {
    const run = await executeIntegrated(setup, { runId: "run_handoff", prompt: "success", claimId: "clm_new", attempt: 2, lockWaitMs: 1000, lockRetryMs: 20 });
    assert.equal(run.summary.processed[0].status, "completed");
    assert.equal(run.result.status, "completed");
    const workDir = path.join(setup.workspaceRoot, "worktrees", "fixture", "run_handoff");
    assert.equal(fs.readFileSync(path.join(workDir, "invocations.log"), "utf8").trim().split("\n").length, 1);
    assert.equal(run.calls.filter((item) => item.pathname.endsWith("/result")).length, 1);
    assert.equal(run.calls.filter((item) => item.pathname.endsWith("/heartbeat")).length >= 2, true, "replacement must maintain claim authority while waiting");
  } finally {
    clearTimeout(release);
    if (fs.existsSync(held.path)) held.release();
  }
});

test("integrated unknown project fails before every workspace-requiring harness", async (t) => {
  const setup = integratedSetup(t, "run_unknown");
  const run = await executeIntegrated(setup, { runId: "run_unknown", prompt: "success", projectId: "proj_unknown", alias: "unknown" });
  assert.equal(run.summary.processed[0].status, "failed");
  assert.match(run.result.error, /not in the local allowlist/);
  assert.equal(fs.existsSync(path.join(setup.workspaceRoot, "worktrees", "unknown", "run_unknown")), false);
});

for (const mode of ["stale", "cancel", "timeout"]) {
  test(`integrated ${mode} authority stops the CLI process group and descendants`, async (t) => {
    const run = await integratedCliRun(t, { runId: `run_${mode}`, prompt: "descendant", mode });
    const expected = mode === "stale" ? "stale-authority" : mode === "cancel" ? "canceled" : "timed-out";
    assert.equal(run.summary.processed[0].status, expected);
    if (mode === "stale") assert.equal(run.result, null, "stale worker must not report a terminal result with lost authority");
    else assert.equal(run.result.status, expected);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(fs.existsSync(path.join(run.workDir, "descendant-survived.txt")), false, "descendant must not survive process-group termination");
    assert.equal(fs.existsSync(run.workDir), true, "worktree must persist after termination");
  });
}

test("stdout event stale authority prevents terminal result reporting", async (t) => {
  const run = await integratedCliRun(t, { runId: "run_stdout_stale", prompt: "success", mode: "stdout-stale" });
  assert.equal(run.summary.processed[0].status, "stale-authority");
  assert.equal(run.result, null);
  assert.equal(run.calls.some((item) => item.pathname.endsWith("/result")), false);
});

function fixtureRepo(t) {
  const dir = tempDir(t);
  git(["init", "-b", "main", dir]);
  fs.writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git(["-C", dir, "add", "README.md"]);
  git(["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
  return dir;
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-worker-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeConfig(root, value) {
  const file = path.join(root, `projects-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

async function integratedCliRun(t, options) {
  const setup = integratedSetup(t, options.runId);
  return { ...await executeIntegrated(setup, options), workDir: path.join(setup.workspaceRoot, "worktrees", "fixture", options.runId) };
}

function integratedSetup(t, runId) {
  const fixture = fixtureRepo(t);
  const root = tempDir(t);
  const workspaceRoot = path.join(root, "workspace");
  const configPath = writeConfig(root, { workspace_root: workspaceRoot, projects: [{ id: "proj_fixture", local_alias: "fixture", repo_url: fixture, default_ref: "main", path: "projects/fixture" }] });
  const fakeCli = path.join(root, "fake-agent.sh");
  fs.writeFileSync(fakeCli, [
    "#!/bin/sh",
    "pwd > observed-cwd.txt",
    "printf 'invoked\\n' >> invocations.log",
    "printf 'durable\\n' > durable.txt",
    "if [ \"$1\" = fail ]; then echo failed >&2; exit 7; fi",
    "if [ \"$1\" = signal ]; then kill -TERM $$; fi",
    "if [ \"$1\" = descendant ]; then (trap '' TERM; exec >/dev/null 2>&1; sleep 0.5; echo survived > descendant-survived.txt) & sleep 10; fi",
    "printf 'ok\\n'",
  ].join("\n"), { mode: 0o755 });
  return {
    configPath, workspaceRoot,
    workspace: createWorkerWorkspace(loadWorkerProjectConfig(configPath)),
    harness: cliHarness(fakeCli, (run) => [run.prompt], { minTimeoutMs: 50, terminationGraceMs: 100, cancelPollMs: 20 }),
    runId,
  };
}

async function executeIntegrated(setup, { runId, prompt, mode = "normal", claimId = "clm_fixture", attempt = 1, projectId = "proj_fixture", alias = "fixture", lockWaitMs, lockRetryMs }) {
  const calls = [];
  let heartbeatCount = 0;
  let result = null;
  const runtime = createWorkerRuntime({
    gatewayUrl: "https://gateway.invalid", workerId: "wrk_fixture", machineId: "machine_fixture", token: "token", once: true,
    heartbeatIntervalMs: 100, lockWaitMs, lockRetryMs, projectConfigFile: setup.configPath, harnesses: { fake: setup.harness }, log: () => {},
    fetch: async (url, init) => {
      const pathname = new URL(url).pathname;
      const body = JSON.parse(init.body);
      calls.push({ pathname, body });
      if (pathname.endsWith("/claim")) return jsonResponse({ claimed: true, claim: { claim_id: claimId, attempt }, run: { id: runId, harness: "fake", prompt, timeout_ms: mode === "timeout" ? 100 : 5000, working_dir: { project_id: projectId, local_alias: alias }, work: { project_id: projectId } } });
      if (pathname.endsWith("/heartbeat")) {
        heartbeatCount += 1;
        if (heartbeatCount > 1 && mode === "stale") return new Response(JSON.stringify({ error: { code: "stale_claim", message: "stale" } }), { status: 409 });
        return jsonResponse({ ok: true, cancel_requested: heartbeatCount > 1 && mode === "cancel" });
      }
      if (pathname.endsWith("/events") && mode === "stdout-stale" && body.events?.some((event) => event.type === "stdout")) {
        return new Response(JSON.stringify({ error: { code: "stale_claim", message: "stale" } }), { status: 409 });
      }
      if (pathname.endsWith("/result")) result = body;
      return jsonResponse({ ok: true, cancel_requested: false });
    },
  });
  const summary = await runtime.runLoop();
  return { summary, result, calls };
}
