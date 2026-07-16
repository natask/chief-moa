"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  WorkerRuntimeError,
  cliHarness,
  createWorkerRuntime,
  detectHarnesses,
  echoHarness,
  forbiddenClaimKeys,
} = require("../lib/worker-runtime");

test("runtime validates gateway configuration and exposes error metadata", () => {
  for (const gatewayUrl of ["", "ftp://gateway.test", "not a url"]) {
    assert.throws(() => createWorkerRuntime({ gatewayUrl }), (error) => {
      assert.equal(error instanceof WorkerRuntimeError, true);
      assert.equal(error.code, "invalid_config");
      assert.equal(error.status, 0);
      assert.equal(error.retryable, false);
      return true;
    });
  }
});

test("echo harness and recursive forbidden-key inspection remain inert", async () => {
  assert.deepEqual(await echoHarness({ prompt: "hello" }), {
    exit_code: 0,
    output: "hello",
    stdout_tail: "hello\n",
    stderr_tail: "",
  });
  assert.equal((await echoHarness({})).stdout_tail, "");
  assert.deepEqual(forbiddenClaimKeys(null), []);
  assert.deepEqual(forbiddenClaimKeys({ safe: [{ command: "no" }, { nested: { CWD: "/tmp" } }], args: [] }), ["args", "command", "cwd"]);
});

test("harness detection always retains a safe echo fallback", () => {
  assert.deepEqual(Object.keys(detectHarnesses({ MOA_WORKER_HARNESSES: "echo" })), ["echo"]);
  assert.deepEqual(Object.keys(detectHarnesses({ MOA_WORKER_HARNESSES: " missing " })), ["echo"]);
  assert.deepEqual(Object.keys(detectHarnesses({
    GEMINI_BIN: {},
    CODEX_BIN: {},
    CLAUDE_BIN: {},
    MOA_WORKER_HARNESSES: "gemini",
  })), ["echo"]);
});

test("harness detection builds environment-scoped CLI profiles", () => {
  const profiles = [];
  const env = {
    GEMINI_BIN: "gemini-test",
    GEMINI_APPROVAL_MODE: "manual",
    CODEX_BIN: "codex-test",
    CODEX_SANDBOX: "read-only",
    CLAUDE_BIN: "claude-test",
    CLAUDE_MODEL: "opus",
    CLAUDE_PERMISSION_MODE: "acceptEdits",
  };
  const harnesses = detectHarnesses(env, {
    probe: () => true,
    createHarness: (bin, argsFor, options) => {
      const profile = { bin, args: argsFor({ prompt: "hello" }, "/work"), options };
      profiles.push(profile);
      return async () => profile;
    },
  });
  assert.deepEqual(Object.keys(harnesses), ["echo", "gemini", "codex", "claude"]);
  assert.deepEqual(profiles[0].args, ["--prompt", "hello", "--skip-trust", "--approval-mode", "manual", "--output-format", "text"]);
  assert.deepEqual(profiles[1].args, ["exec", "--cd", "/work", "--skip-git-repo-check", "--sandbox", "read-only", "hello"]);
  assert.deepEqual(profiles[2].args, ["--print", "--output-format", "json", "--model", "opus", "--add-dir", "/work", "--permission-mode", "acceptEdits", "hello"]);
  assert.deepEqual(profiles[2].options.parseOutput('{"result":"answer"}'), { output: "answer" });
  assert.deepEqual(profiles[2].options.parseOutput('{"output":"fallback"}'), { output: "fallback" });
  assert.deepEqual(profiles[2].options.parseOutput("plain"), { output: "plain" });
  assert.deepEqual(profiles[2].options.parseOutput("{bad"), { output: "{bad" });

  const dangerous = [];
  detectHarnesses({
    CODEX_BYPASS_APPROVALS: "1",
    CLAUDE_DANGEROUS_SKIP_PERMISSIONS: "1",
    CLAUDE_AGENT_MODEL: "haiku",
  }, {
    probe: () => true,
    createHarness: (_bin, argsFor) => {
      dangerous.push(argsFor({}, "/work"));
      return async () => {};
    },
  });
  assert.equal(dangerous[1].includes("--dangerously-bypass-approvals-and-sandbox"), true);
  assert.equal(dangerous[2].includes("--dangerously-skip-permissions"), true);
  assert.equal(dangerous[2].includes("haiku"), true);
  assert.deepEqual(Object.keys(detectHarnesses({}, { probe: () => false })), ["echo"]);

  const defaults = [];
  detectHarnesses({}, {
    probe: () => true,
    createHarness: (bin, argsFor, options) => {
      defaults.push({ bin, args: argsFor({}, "/work"), options });
      return async () => {};
    },
  });
  assert.equal(defaults[0].args.includes("yolo"), true);
  assert.equal(defaults[1].args.includes("workspace-write"), true);
  assert.equal(defaults[2].args.includes("sonnet"), true);
  assert.equal(defaults[2].args.includes("plan"), true);
  assert.deepEqual(defaults[2].options.parseOutput("{}"), { output: "{}" });
  assert.deepEqual(defaults[2].options.parseOutput(undefined), { output: "" });
});

test("runtime option normalization covers explicit projects and workspace filtering", () => {
  const requiresWorkspace = async () => {};
  requiresWorkspace.requiresWorkspace = true;
  const filtered = createWorkerRuntime({
    gatewayUrl: "http://gateway.test",
    workerId: "worker",
    token: "token",
    projects: [{ id: "project!", local_alias: "Local Alias" }, null],
    harnesses: { echo: echoHarness, cli: requiresWorkspace },
    machineId: "machine",
  });
  assert.deepEqual(filtered.harnessIds(), ["echo"]);

  const retained = createWorkerRuntime({
    gatewayUrl: "http://gateway.test",
    workerId: "worker",
    token: "token",
    projectConfig: { projects: [] },
    workspace: {},
    harnesses: { cli: requiresWorkspace },
    projectAliases: " One,one,TWO ",
    machineId: "machine",
  });
  assert.deepEqual(retained.harnessIds(), ["cli"]);
});

test("runtime registers once, writes bounded state, and reloads credentials", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-runtime-state-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const stateFile = path.join(tempDir, "nested", "worker.json");
  const requests = [];
  const runtime = createWorkerRuntime({
    gatewayUrl: "https://gateway.test/",
    registrationId: " registration_1 ",
    setupCode: " setup-code ",
    stateFile,
    name: "n".repeat(140),
    machineId: "machine_1",
    machineLabel: "label<script>",
    platform: "MAC OS!",
    machineCapabilities: [" GPU ", "gpu", "bad value!"],
    projects: [{ id: " project_1! ", localAlias: " My Project " }],
    harnesses: { echo: echoHarness },
    log: () => {},
    fetch: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse(201, {
        worker_id: "worker_1",
        worker_token: "token_1",
        token_id: "token-id",
        expires_at: "2099-01-01T00:00:00Z",
        heartbeat_interval_ms: 500,
      });
    },
  });

  assert.deepEqual(await runtime.ensureCredentials(), {
    worker_id: "worker_1",
    token: "token_1",
    heartbeat_interval_ms: 1000,
  });
  assert.equal(requests[0].url, "https://gateway.test/v1/agent/workers/register");
  assert.equal(requests[0].options.headers.authorization, undefined);
  assert.equal(requests[0].body.worker.name.length, 123);
  assert.equal(requests[0].body.worker.machine_label, "label-script-");
  assert.deepEqual(requests[0].body.worker.capabilities.machine, ["gpu", "bad-value-"]);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);

  let fetched = false;
  const reloaded = createWorkerRuntime({
    gatewayUrl: "https://gateway.test",
    stateFile,
    harnesses: { echo: echoHarness },
    log: () => {},
    fetch: async () => { fetched = true; throw new Error("must not fetch"); },
  });
  assert.equal((await reloaded.ensureCredentials()).token, "token_1");
  assert.equal(fetched, false);
});

test("runtime requires either complete credentials or one-use registration data", async () => {
  const runtime = createWorkerRuntime({
    gatewayUrl: "https://gateway.test",
    workerId: "worker_1",
    harnesses: { echo: echoHarness },
    fetch: async () => { throw new Error("must not fetch"); },
  });
  await assert.rejects(runtime.ensureCredentials(), (error) => error.code === "missing_credentials");
});

test("runtime ignores absent, malformed, and primitive credential state", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-runtime-bad-state-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  for (const [name, content] of [["missing", null], ["invalid", "{"], ["primitive", "7"]]) {
    const stateFile = path.join(tempDir, name);
    if (content != null) fs.writeFileSync(stateFile, content);
    const runtime = createWorkerRuntime({ gatewayUrl: "https://gateway.test", stateFile, harnesses: { echo: echoHarness } });
    await assert.rejects(runtime.ensureCredentials(), (error) => error.code === "missing_credentials");
  }
});

test("runtime supplies the saved heartbeat default", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-runtime-saved-state-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const stateFile = path.join(tempDir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ worker_id: "worker", worker_token: "token" }));
  const runtime = createWorkerRuntime({ gatewayUrl: "https://gateway.test", stateFile, harnesses: { echo: echoHarness }, log: () => {} });
  assert.equal((await runtime.ensureCredentials()).heartbeat_interval_ms, 15_000);
});

test("runtime completes an allowed echo claim and sends bounded lifecycle requests", async () => {
  const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }]);
  const runtime = makeRuntime(gateway.fetch);
  const summary = await runtime.runLoop();

  assert.deepEqual(summary, { ok: true, idle: false, processed: [{ run_id: "run_1", status: "completed" }] });
  assert.deepEqual(gateway.paths, [
    "/v1/agent/workers/claim",
    "/v1/agent/runs/run_1/heartbeat",
    "/v1/agent/runs/run_1/events",
    "/v1/agent/runs/run_1/events",
    "/v1/agent/runs/run_1/result",
  ]);
  assert.equal(gateway.bodies.at(-1).status, "completed");
  assert.equal(gateway.bodies.at(-1).output, "hello");
});

test("runtime rejects forbidden claims before invoking a harness", async () => {
  let invoked = false;
  const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: { ...claimRun(), nested: { env: {} } } }]);
  const runtime = makeRuntime(gateway.fetch, { harnesses: { echo: async () => { invoked = true; } } });
  const summary = await runtime.runLoop();

  assert.equal(invoked, false);
  assert.equal(summary.processed[0].local_rejection, true);
  assert.match(summary.processed[0].reason, /env/);
  assert.equal(gateway.bodies.at(-1).status, "failed");
});

test("runtime rejects unadvertised harnesses and unsafe claim identifiers", async () => {
  const missing = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: { ...claimRun(), harness: "shell" } }]);
  assert.equal((await makeRuntime(missing.fetch).runLoop()).processed[0].local_rejection, true);

  const unsafe = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: { ...claimRun(), id: "../run" } }]);
  await assert.rejects(makeRuntime(unsafe.fetch).runLoop(), (error) => error.code === "unsafe_claim");

  const missingAlias = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: { ...claimRun(), working_dir: { project_id: "project" } } }]);
  await assert.rejects(makeRuntime(missingAlias.fetch).runLoop(), (error) => error.code === "unsafe_claim");

  const blankHarness = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: { ...claimRun(), harness: "" } }]);
  assert.match((await makeRuntime(blankHarness.fetch).runLoop()).processed[0].reason, /harness  is not/);

  const project = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: { ...claimRun(), working_dir: { project_id: "other", local_alias: "other" } } }]);
  assert.match((await makeRuntime(project.fetch).runLoop()).processed[0].reason, /not in the local allowlist/);
});

test("runtime maps cancellation, stale authority, harness failure, and terminal exits", async (t) => {
  await t.test("cancellation", async () => {
    const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }], {
      heartbeat: { cancel_requested: true },
    });
    assert.equal((await makeRuntime(gateway.fetch).runLoop()).processed[0].status, "canceled");
    assert.equal(gateway.bodies.at(-1).status, "canceled");
  });

  await t.test("stale heartbeat authority", async () => {
    const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }], { heartbeatStatus: 409 });
    assert.equal((await makeRuntime(gateway.fetch).runLoop()).processed[0].status, "stale-authority");
  });

  await t.test("stale event authority", async () => {
    const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }], { eventStatus: 409 });
    assert.equal((await makeRuntime(gateway.fetch).runLoop()).processed[0].status, "stale-authority");
  });

  await t.test("harness throw", async () => {
    const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }]);
    const runtime = makeRuntime(gateway.fetch, { harnesses: { echo: async () => { throw new Error("local failure"); } } });
    const result = await runtime.runLoop();
    assert.deepEqual(result.processed[0], { run_id: "run_1", status: "failed", reason: "local failure" });
  });

  for (const [name, outcome, expected] of [
    ["nonzero", { exit_code: 7, stderr_tail: "bad" }, "failed"],
    ["timeout", { exit_code: null, timed_out: true }, "timed-out"],
  ]) {
    await t.test(name, async () => {
      const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }]);
      const runtime = makeRuntime(gateway.fetch, { harnesses: { echo: async () => outcome } });
      assert.equal((await runtime.runLoop()).processed[0].status, expected);
      assert.equal(gateway.bodies.at(-1).status, expected);
    });
  }
});

test("runtime treats a stale terminal result as lost authority", async () => {
  const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }], { resultStatus: 409 });
  assert.equal((await makeRuntime(gateway.fetch).runLoop()).processed[0].status, "stale-authority");
});

test("runtime retries transient claim failures and exits after bounded idleness", async () => {
  let calls = 0;
  const runtime = createWorkerRuntime({
    gatewayUrl: "https://gateway.test",
    workerId: "worker_1",
    token: "token_1",
    harnesses: { echo: echoHarness },
    maxIdleMs: 1,
    idleDelayMs: 1,
    claimWaitMs: 0,
    log: () => {},
    fetch: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(503, { error: { code: "busy", message: "retry", retryable: true } });
      return jsonResponse(200, { claimed: false, retry_after_ms: 1 });
    },
  });
  assert.deepEqual(await runtime.runLoop(), { ok: true, idle: true, processed: [] });
  assert.equal(calls, 2);
});

test("runtime waits once for an empty claim before reaching the idle bound", async () => {
  let calls = 0;
  const runtime = createWorkerRuntime({
    gatewayUrl: "https://gateway.test",
    workerId: "worker_1",
    token: "token_1",
    harnesses: { echo: echoHarness },
    maxIdleMs: 50,
    idleDelayMs: 1,
    log: () => {},
    fetch: async () => {
      calls += 1;
      return jsonResponse(200, { claimed: false, retry_after_ms: "invalid" });
    },
  });
  assert.equal((await runtime.runLoop()).idle, true);
  assert.equal(calls, 2);
});

test("runtime does not retry authentication failures", async () => {
  const runtime = makeRuntime(async () => jsonResponse(401, { error: { code: "unauthorized", message: "no" } }));
  await assert.rejects(runtime.runLoop(), (error) => error.status === 401 && error.retryable === false);
});

test("runtime also fails closed on forbidden scope", async () => {
  const runtime = makeRuntime(async () => jsonResponse(403, { error: { code: "forbidden", message: "no" } }));
  await assert.rejects(runtime.runLoop(), (error) => error.status === 403);
});

test("runtime sends configured project ids in claim scope", async () => {
  const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun({ working_dir: { project_id: "project", local_alias: "local" } }) }]);
  const runtime = makeRuntime(gateway.fetch, {
    projectAliases: [],
    projects: [{ id: "project", local_alias: "local" }],
  });
  await runtime.runLoop();
  assert.deepEqual(gateway.bodies[0].accepted_projects, ["project"]);
});

test("runtime permits echo claims without configured project scope", async () => {
  const run = claimRun({ working_dir: { local_alias: "unscoped" }, work: { project_id: "unscoped" } });
  const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run }]);
  const runtime = makeRuntime(gateway.fetch, { projectAliases: [] });
  assert.equal((await runtime.runLoop()).processed[0].status, "completed");
  assert.equal("accepted_projects" in gateway.bodies[0], false);
});

test("runtime sends project scope when aliases and projects differ in length", async () => {
  const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }]);
  const runtime = makeRuntime(gateway.fetch, {
    projectAliases: ["project"],
    projects: [{ id: "project", local_alias: "project" }, { id: "second", local_alias: "second" }],
  });
  await runtime.runLoop();
  assert.deepEqual(gateway.bodies[0].accepted_projects, ["project", "second"]);
});

test("workspace harness prepares and releases a locally locked run", async () => {
  let lockAttempts = 0;
  let releases = 0;
  const workspace = {
    acquireRunLock: () => {
      lockAttempts += 1;
      if (lockAttempts === 1) throw Object.assign(new Error("busy"), { code: "run_locked" });
      return { release: () => { releases += 1; } };
    },
    prepareRun: () => ({ work_dir: os.tmpdir(), reused: true }),
  };
  const harness = async (_run, context) => ({ exit_code: 0, output: context.workDir });
  harness.requiresWorkspace = true;
  const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }]);
  const runtime = makeRuntime(gateway.fetch, {
    projectConfig: { projects: [{ id: "project", local_alias: "project" }] },
    workspace,
    harnesses: { echo: harness },
    lockWaitMs: 100,
    lockRetryMs: 1,
  });
  assert.equal((await runtime.runLoop()).processed[0].status, "completed");
  assert.equal(lockAttempts, 2);
  assert.equal(releases, 1);
  assert.equal(gateway.bodies.some((body) => body?.events?.[0]?.type === "workspace_ready"), true);
});

test("workspace lock expiry leaves gateway lease handling authoritative", async () => {
  const harness = async () => ({ exit_code: 0 });
  harness.requiresWorkspace = true;
  const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }]);
  const runtime = makeRuntime(gateway.fetch, {
    projectConfig: { projects: [{ id: "project", local_alias: "project" }] },
    workspace: { acquireRunLock: () => { throw Object.assign(new Error("busy"), { code: "run_locked" }); } },
    harnesses: { echo: harness },
    lockWaitMs: 0,
  });
  assert.equal((await runtime.runLoop()).processed[0].status, "lock-wait-expired");
});

test("long-running harness emits heartbeat ticks and absorbs heartbeat failures", async () => {
  let heartbeatCalls = 0;
  const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }], {
    heartbeat: () => {
      heartbeatCalls += 1;
      return heartbeatCalls === 1 ? {} : { status: 500 };
    },
  });
  const runtime = makeRuntime(gateway.fetch, {
    heartbeatIntervalMs: 100,
    harnesses: { echo: async () => {
      await new Promise((resolve) => setTimeout(resolve, 130));
      return { exit_code: 0 };
    } },
  });
  assert.equal((await runtime.runLoop()).processed[0].status, "completed");
  assert.equal(heartbeatCalls >= 2, true);
});

test("runtime covers no-result, stale cancellation, and malformed terminal outcomes", async (t) => {
  await t.test("no result", async () => {
    const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }]);
    const result = await makeRuntime(gateway.fetch, { harnesses: { echo: async () => undefined } }).runLoop();
    assert.equal(result.processed[0].status, "failed");
    assert.equal(gateway.bodies.at(-1).error, "harness produced no result");
  });
  await t.test("non-Error throw", async () => {
    const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }]);
    const result = await makeRuntime(gateway.fetch, { harnesses: { echo: async () => { throw "string failure"; } } }).runLoop();
    assert.equal(result.processed[0].reason, "string failure");
  });
  await t.test("stale canceled result", async () => {
    const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }], {
      heartbeat: { cancel_requested: true },
      resultStatus: 409,
    });
    assert.equal((await makeRuntime(gateway.fetch).runLoop()).processed[0].status, "stale-authority");
  });
  for (const exitCode of [null, "not-a-number"]) {
    await t.test(`exit ${exitCode}`, async () => {
      const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }]);
      const outcome = { exit_code: exitCode, output: "", stdout_tail: "", stderr_tail: "", signal: "" };
      await makeRuntime(gateway.fetch, { harnesses: { echo: async () => outcome } }).runLoop();
      assert.match(gateway.bodies.at(-1).error, /no exit code/);
    });
  }
});

test("runtime propagates non-authority event and result failures", async (t) => {
  await t.test("event", async () => {
    const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }], { eventStatus: 500 });
    await assert.rejects(makeRuntime(gateway.fetch).runLoop(), (error) => error.status === 500);
  });
  await t.test("result", async () => {
    const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }], { resultStatus: 500 });
    await assert.rejects(makeRuntime(gateway.fetch).runLoop(), (error) => error.status === 500);
  });
});

test("runtime retries a retryable event exactly once", async () => {
  let eventCalls = 0;
  const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }], {
    event: () => {
      eventCalls += 1;
      return eventCalls === 1 ? { status: 503, retryable: true } : {};
    },
  });
  const runtime = makeRuntime(gateway.fetch, { maxRequestRetries: 1, idleDelayMs: 1 });
  assert.equal((await runtime.runLoop()).processed[0].status, "completed");
  assert.equal(eventCalls, 3);
});

test("runtime stops on harness-declared and post-output stale authority", async (t) => {
  await t.test("harness declaration", async () => {
    const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }]);
    const outcome = { exit_code: null, cancellation_reason: "stale-authority" };
    assert.equal((await makeRuntime(gateway.fetch, { harnesses: { echo: async () => outcome } }).runLoop()).processed[0].status, "stale-authority");
  });
  await t.test("stdout event", async () => {
    let eventCalls = 0;
    const gateway = fakeGateway([{ claimed: true, claim: { claim_id: "claim_1", attempt: 1 }, run: claimRun() }], {
      event: () => {
        eventCalls += 1;
        return eventCalls === 2 ? { status: 409 } : {};
      },
    });
    assert.equal((await makeRuntime(gateway.fetch).runLoop()).processed[0].status, "stale-authority");
  });
});

test("gateway request parsing bounds transport and provider failures", async (t) => {
  const registration = (fetch) => createWorkerRuntime({
    gatewayUrl: "https://gateway.test",
    registrationId: "registration",
    setupCode: "setup",
    harnesses: { echo: echoHarness },
    fetch,
  }).ensureCredentials();
  await t.test("transport", async () => {
    await assert.rejects(registration(async () => { throw new Error("offline"); }), (error) => error.code === "gateway_unreachable" && error.retryable);
  });
  await t.test("non-json provider error", async () => {
    await assert.rejects(registration(async () => ({ ok: false, status: 429, text: async () => "not-json" })), (error) => error.code === "http_429" && error.retryable);
  });
  await t.test("empty provider error", async () => {
    await assert.rejects(registration(async () => ({ ok: false, status: 400, text: async () => "" })), (error) => error.message === "gateway returned 400" && !error.retryable);
  });
});

test("CLI harness requires an absolute workspace and captures process output", async () => {
  const harness = cliHarness(process.execPath, () => ["-e", "process.stdout.write('out'); process.stderr.write('err')"], {
    parseOutput: (stdout) => ({ output: stdout.toUpperCase() }),
    minTimeoutMs: 20,
  });
  assert.equal(harness.requiresWorkspace, true);
  await assert.rejects(harness({ prompt: "x" }), (error) => error.code === "workspace_required");
  await assert.rejects(harness({ prompt: "x" }, { workDir: "relative" }), (error) => error.code === "workspace_required");
  const result = await harness({ timeout_ms: 1000 }, { workDir: os.tmpdir() });
  assert.equal(result.exit_code, 0);
  assert.equal(result.output, "OUT");
  assert.equal(result.stdout_tail, "out");
  assert.equal(result.stderr_tail, "err");
  assert.equal(result.timed_out, false);
});

test("CLI harness falls back from stdout to stderr without a parser", async () => {
  const harness = cliHarness(process.execPath, () => ["-e", "process.stderr.write('only stderr')"], { minTimeoutMs: 20, cancelPollMs: 20 });
  const result = await harness({}, { workDir: os.tmpdir() });
  assert.equal(result.output, "only stderr");
  assert.equal(result.signal, "");
});

test("CLI harness falls back to stdout when a parser omits output", async () => {
  const harness = cliHarness(process.execPath, () => ["-e", "process.stdout.write('raw stdout')"], {
    parseOutput: () => undefined,
    minTimeoutMs: 20,
  });
  assert.equal((await harness({}, { workDir: os.tmpdir() })).output, "raw stdout");
});

test("CLI harness terminates timed-out and canceled process groups", async (t) => {
  await t.test("timeout", async () => {
    const harness = cliHarness(process.execPath, () => ["-e", "setInterval(() => {}, 1000)"], {
      terminationGraceMs: 0,
      minTimeoutMs: 20,
      cancelPollMs: 20,
    });
    const result = await harness({ timeout_ms: 20 }, { workDir: os.tmpdir() });
    assert.equal(result.timed_out, true);
    assert.equal(result.canceled, false);
    assert.equal(result.cancellation_reason, "timeout");
  });

  await t.test("cancellation", async () => {
    const harness = cliHarness(process.execPath, () => ["-e", "setInterval(() => {}, 1000)"], {
      terminationGraceMs: 0,
      minTimeoutMs: 1000,
      cancelPollMs: 20,
    });
    const result = await harness({}, { workDir: os.tmpdir(), isCanceled: () => "user-stop" });
    assert.equal(result.canceled, true);
    assert.equal(result.cancellation_reason, "user-stop");
  });
  await t.test("boolean cancellation", async () => {
    const harness = cliHarness(process.execPath, () => ["-e", "setInterval(() => {}, 1000)"], {
      terminationGraceMs: 0,
      minTimeoutMs: 1000,
      cancelPollMs: 20,
    });
    const result = await harness({}, { workDir: os.tmpdir(), isCanceled: () => true });
    assert.equal(result.cancellation_reason, "canceled");
  });
});

test("CLI harness surfaces child spawn failures", async () => {
  const harness = cliHarness("/definitely/missing/moa-worker-command", () => [], { minTimeoutMs: 20 });
  await assert.rejects(harness({}, { workDir: os.tmpdir() }), /ENOENT/);
});

test("CLI harness rejects synchronous argument construction failures", async () => {
  const harness = cliHarness(process.execPath, () => { throw new Error("bad args"); });
  await assert.rejects(harness({}, { workDir: os.tmpdir() }), /bad args/);
});

function makeRuntime(fetch, overrides = {}) {
  return createWorkerRuntime({
    gatewayUrl: "https://gateway.test",
    workerId: "worker_1",
    token: "token_1",
    once: true,
    projectAliases: ["project"],
    harnesses: { echo: echoHarness },
    fetch,
    log: () => {},
    maxRequestRetries: 0,
    ...overrides,
  });
}

function claimRun(overrides = {}) {
  return {
    id: "run_1",
    harness: "echo",
    prompt: "hello",
    working_dir: { project_id: "project", local_alias: "project" },
    ...overrides,
  };
}

function fakeGateway(claims, options = {}) {
  const paths = [];
  const bodies = [];
  return {
    paths,
    bodies,
    fetch: async (url, request) => {
      const pathname = new URL(url).pathname;
      const body = request.body ? JSON.parse(request.body) : null;
      paths.push(pathname);
      bodies.push(body);
      if (pathname === "/v1/agent/workers/claim") return jsonResponse(200, claims.shift() || { claimed: false, retry_after_ms: 100 });
      if (pathname.endsWith("/heartbeat") && options.heartbeatStatus) {
        return jsonResponse(options.heartbeatStatus, { error: { code: "stale_claim", message: "stale" } });
      }
      if (pathname.endsWith("/heartbeat")) {
        const heartbeat = typeof options.heartbeat === "function" ? options.heartbeat() : options.heartbeat;
        if (heartbeat?.status) return jsonResponse(heartbeat.status, { error: { code: "heartbeat_failed", message: "failed", retryable: false } });
        return jsonResponse(200, heartbeat || {});
      }
      if (pathname.endsWith("/events") && options.eventStatus) {
        return jsonResponse(options.eventStatus, { error: { code: "stale_claim", message: "stale" } });
      }
      if (pathname.endsWith("/events") && typeof options.event === "function") {
        const event = options.event();
        if (event.status) return jsonResponse(event.status, { error: { code: "event_failed", message: "failed", retryable: event.retryable } });
      }
      if (pathname.endsWith("/result") && options.resultStatus) {
        return jsonResponse(options.resultStatus, { error: { code: "stale_claim", message: "stale" } });
      }
      return jsonResponse(200, {});
    },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}
