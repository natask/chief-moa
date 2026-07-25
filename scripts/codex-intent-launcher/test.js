"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const test = require("node:test");
const {
  IntentPlaneClient,
  buildIdentity,
  processMatches,
  processSnapshot,
  publicState,
  stableId,
  writeJsonAtomic,
} = require("./lib");
const {
  assertSafeCommand,
  childEnvironment,
  codexCommand,
  config,
  launchState,
  parse,
} = require("./cli");
const execFileAsync = promisify(execFile);

test("stable identities are deterministic and namespace scoped", () => {
  const first = buildIdentity({ namespace: "personal", project: "chief-moa", intentKey: "one", agentKey: "owner" });
  const replay = buildIdentity({ namespace: "personal", project: "chief-moa", intentKey: "one", agentKey: "owner" });
  const other = buildIdentity({ namespace: "work", project: "chief-moa", intentKey: "one", agentKey: "owner" });
  assert.deepEqual(first, replay);
  assert.notEqual(first.intentId, other.intentId);
  assert.match(first.intentId, /^intent_codex_[a-f0-9]{32}$/);
  assert.match(first.agentId, /^agent_codex_[a-f0-9]{32}$/);
});

test("parser separates adapter options from an arbitrary command", () => {
  const parsed = parse(["--user-confirmed", "--capability", "code", "--capability", "test", "--", "printf", "--secret-looking-arg"]);
  assert.equal(parsed.values["user-confirmed"], true);
  assert.deepEqual(parsed.values.capability, ["code", "test"]);
  assert.deepEqual(parsed.command, ["printf", "--secret-looking-arg"]);
});

test("durable public state excludes command arguments and gateway token", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moa-codex-launcher-"));
  const values = {
    "user-confirmed": true,
    namespace: "personal",
    project: "chief-moa",
    "intent-key": "intent",
    "agent-key": "owner",
    title: "Title",
    objective: "Objective",
    "launch-reason": "Explicit request",
    cwd: directory,
  };
  const settings = config({ "state-dir": directory, gateway: "https://api.example.test" }, {
    MOA_GATEWAY_TOKEN: "super-secret-token",
  });
  const state = launchState(values, ["/bin/echo", "super-secret-command-argument"], settings);
  const serialized = JSON.stringify(publicState(state));
  assert.doesNotMatch(serialized, /super-secret/);
  assert.equal(state.gateway_url, "https://api.example.test");
  assert.equal(state.token_env, "MOA_GATEWAY_TOKEN");
  assert.equal(state.tenant_id, "tenant_global");
  assert.equal(state.sphere, "personal");
});

test("atomic state files are private", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moa-codex-state-"));
  const file = path.join(directory, "nested", "state.json");
  writeJsonAtomic(file, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ok: true });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("intent plane client sends explicit confirmation and never sends token in payload", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 201, text: async () => "{}" };
  };
  const client = new IntentPlaneClient({
    gatewayUrl: "https://api.example.test/",
    token: "secret-bearer",
    fetchImpl,
  });
  const state = {
    intent_id: stableId("intent_codex", "n", "p", "i"),
    agent_id: stableId("agent_codex", "n", "p", "i", "a"),
    namespace: "n",
    project: "p",
    intent_key: "i",
    agent_key: "a",
    title: "Title",
    objective: "Objective",
    sensitivity: "normal",
    launch_reason: "Reason",
    launcher_agent_id: "root",
    capabilities: ["codex"],
    authority_summary: "No children",
  };
  await client.createIntent(state);
  await client.registerAgent(state);
  const createBody = JSON.parse(calls[0].options.body);
  assert.equal(createBody.user_confirmed, true);
  assert.equal(calls[0].options.headers.authorization, "Bearer secret-bearer");
  assert.doesNotMatch(calls.map((call) => call.options.body).join(""), /secret-bearer/);
  assert.equal(JSON.parse(calls[1].options.body).current_run_id, "");
  assert.equal(JSON.parse(calls[0].options.body).namespace_id, "n");
  assert.equal(JSON.parse(calls[1].options.body).runtime_type, "codex_exec");
});

test("Codex launch uses prompt stdin and an explicit recap file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moa-codex-command-"));
  const prompt = path.join(directory, "prompt.md");
  fs.writeFileSync(prompt, "Do the bounded task.");
  const values = {
    cwd: directory,
    "prompt-file": prompt,
    "state-dir": directory,
    model: "example-model",
    sandbox: "workspace-write",
  };
  const command = codexCommand(values);
  assert.deepEqual(command.slice(0, 4), ["codex", "exec", "--json", "--color"]);
  assert.equal(command.at(-1), "-");
  assert.equal(values["stdin-files"][0], path.join(__dirname, "direct-owner-prompt.md"));
  assert.equal(values["stdin-files"][1], prompt);
  assert.ok(values["summary-file"].startsWith(directory));
  assert.ok(command.includes("--model"));
});

test("foreground launch records hosted running and completion lifecycle", async (context) => {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      calls.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : {} });
      response.writeHead(request.url.endsWith("/heartbeat") ? 404 : 200, { "content-type": "application/json" });
      response.end(request.url.endsWith("/heartbeat") ? JSON.stringify({ error: "not deployed" }) : "{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moa-codex-e2e-"));
  const gateway = `http://127.0.0.1:${server.address().port}`;
  const args = [
    path.join(__dirname, "cli.js"),
    "launch",
    "--user-confirmed",
    "--namespace", "personal",
    "--project", "chief-moa",
    "--intent-key", "adapter-integration",
    "--agent-key", "owner",
    "--title", "Adapter integration",
    "--objective", "Prove a terminal lifecycle.",
    "--launch-reason", "Test request",
    "--cwd", directory,
    "--gateway", gateway,
    "--state-dir", directory,
    "--foreground",
    "--",
    "/usr/bin/true",
  ];
  const { stdout } = await execFileAsync(process.execPath, args, {
    env: { ...process.env, MOA_GATEWAY_TOKEN: "integration-token" },
  });
  const finalState = JSON.parse(stdout);
  assert.equal(finalState.status, "completed");
  assert.equal(finalState.remote_pending, false);
  assert.ok(calls.some((call) => call.url === "/v1/intent-plane/intents"));
  assert.ok(calls.some((call) => call.url.includes("/runs") && call.body.reopen_intent === false));
  assert.ok(calls.some((call) => call.url.includes("/progress") && call.body.status === "completed"));
  assert.ok(calls.some((call) => call.method === "PATCH" && call.body.status === "completed"));
  assert.doesNotMatch(JSON.stringify(calls), /integration-token/);
  const receipt = JSON.parse(fs.readFileSync(finalState.artifact_refs.find((item) => item.endsWith("receipt.json"))));
  assert.equal(receipt.exit_code, 0);
  const terminalIntent = calls.find((call) => call.method === "PATCH" && call.body.status === "completed");
  assert.equal(terminalIntent.body.current_run_id, finalState.adapter_run_id);
});

test("foreground failure maps to needs_user instead of inventing completion", async (context) => {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      calls.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : {} });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moa-codex-fail-"));
  const args = [
    path.join(__dirname, "cli.js"),
    "launch",
    "--user-confirmed",
    "--namespace", "personal",
    "--project", "chief-moa",
    "--intent-key", "adapter-failure",
    "--agent-key", "owner",
    "--title", "Adapter failure",
    "--objective", "Prove failure is visible.",
    "--launch-reason", "Test request",
    "--cwd", directory,
    "--gateway", `http://127.0.0.1:${server.address().port}`,
    "--state-dir", directory,
    "--foreground",
    "--",
    "/usr/bin/false",
  ];
  await assert.rejects(execFileAsync(process.execPath, args, {
    env: { ...process.env, MOA_GATEWAY_TOKEN: "integration-token" },
  }));
  assert.ok(calls.some((call) => call.url.includes("/progress") && call.body.status === "failed"));
  assert.ok(calls.some((call) => call.method === "PATCH" && call.body.status === "needs_user"));
  assert.ok(!calls.some((call) => call.method === "PATCH" && call.body.status === "completed"));
});

test("reconcile turns a vanished running process into a visible blocked intent", async (context) => {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      calls.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : {} });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moa-codex-reconcile-"));
  const values = {
    "user-confirmed": true,
    namespace: "personal",
    project: "chief-moa",
    "intent-key": "adapter-reconcile",
    "agent-key": "owner",
    title: "Adapter reconcile",
    objective: "Prove interruption recovery.",
    "launch-reason": "Test request",
    cwd: directory,
  };
  const settings = config({ "state-dir": directory, gateway: `http://127.0.0.1:${server.address().port}` }, {
    MOA_GATEWAY_TOKEN: "integration-token",
  });
  const state = launchState(values, ["/usr/bin/true"], settings);
  state.status = "running";
  state.pid = 2_147_483_647;
  state.remote_pending = false;
  writeJsonAtomic(state.state_file, state);
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(__dirname, "cli.js"),
    "reconcile",
    "--gateway", settings.gatewayUrl,
    "--state-dir", directory,
  ], { env: { ...process.env, MOA_GATEWAY_TOKEN: "integration-token" } });
  const result = JSON.parse(stdout);
  assert.equal(result.runs[0].status, "blocked");
  assert.match(result.runs[0].terminal_reason, /ended before a terminal receipt/);
  assert.ok(calls.some((call) => call.url.includes("/progress") && call.body.status === "blocked"));
  assert.ok(calls.some((call) => call.method === "PATCH" && call.body.status === "needs_user"));
});

test("gateway transport requires HTTPS except on loopback", () => {
  assert.throws(() => config({ gateway: "http://api.example.test" }, {
    MOA_GATEWAY_TOKEN: "token",
  }), /must use https/);
  assert.equal(config({ gateway: "http://127.0.0.1:8787" }, {
    MOA_GATEWAY_TOKEN: "token",
  }).gatewayUrl, "http://127.0.0.1:8787");
  assert.equal(config({ gateway: "http://localhost:8787" }, {
    MOA_GATEWAY_TOKEN: "token",
  }).gatewayUrl, "http://localhost:8787");
});

test("selected and known Chief Moa credentials never reach the worker command", () => {
  const child = childEnvironment({
    PATH: "/bin",
    CUSTOM_GATEWAY_TOKEN: "selected",
    MOA_GATEWAY_TOKEN: "gateway",
    AGEE_GATEWAY_TOKEN: "agee",
    MOA_PRODUCTION_PROMOTER_TOKEN: "promoter",
    ACCOUNT_OAUTH_GOOGLE_CLIENT_SECRET: "oauth",
    SAFE_SETTING: "visible",
  }, "CUSTOM_GATEWAY_TOKEN");
  assert.equal(child.PATH, "/bin");
  assert.equal(child.SAFE_SETTING, "visible");
  assert.equal(child.CUSTOM_GATEWAY_TOKEN, undefined);
  assert.equal(child.MOA_GATEWAY_TOKEN, undefined);
  assert.equal(child.AGEE_GATEWAY_TOKEN, undefined);
  assert.equal(child.MOA_PRODUCTION_PROMOTER_TOKEN, undefined);
  assert.equal(child.ACCOUNT_OAUTH_GOOGLE_CLIENT_SECRET, undefined);
  assert.throws(() => config({ "token-env": "PATH", gateway: "https://api.example.test" }, {
    PATH: "/bin",
  }), /uppercase TOKEN, KEY, or SECRET/);
});

test("credential-shaped raw arguments fail closed", () => {
  assert.throws(() => assertSafeCommand(["tool", "--api-key", "value"]), /appear to contain a credential/);
  assert.throws(() => assertSafeCommand(["tool", "https://user:pass@example.test/path"]), /appear to contain a credential/);
  assert.throws(() => assertSafeCommand(["tool", "https://example.test/?token=value"]), /appear to contain a credential/);
  assert.doesNotThrow(() => assertSafeCommand(["tool", "--input", "/private/task-prompt.md"]));
});

test("process identity prevents PID reuse from looking alive", () => {
  const snapshot = processSnapshot(process.pid);
  assert.equal(snapshot.alive, true);
  assert.ok(snapshot.identity);
  assert.equal(processMatches(process.pid, snapshot.identity), true);
  assert.equal(processMatches(process.pid, `${snapshot.identity}-reused`), false);
  assert.equal(processMatches(process.pid, ""), false);
});

test("a repeated stable owner starts a distinct run only through explicit reopen", async (context) => {
  const starts = [];
  const active = new Map();
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      const match = request.url.match(/\/agents\/([^/]+)\/runs$/);
      if (match) {
        const prior = active.get(match[1]);
        starts.push({ agent: match[1], body: parsed });
        if (prior && parsed.reopen_intent !== true) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "explicit reopen required" }));
          return;
        }
        active.set(match[1], parsed.current_run_id);
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moa-codex-repeat-"));
  const common = [
    path.join(__dirname, "cli.js"),
    "launch",
    "--user-confirmed",
    "--namespace", "personal",
    "--project", "chief-moa",
    "--intent-key", "repeat-intent",
    "--agent-key", "stable-owner",
    "--title", "Repeated owner",
    "--objective", "Run the stable owner more than once.",
    "--launch-reason", "Explicit repeated-run test",
    "--cwd", directory,
    "--gateway", `http://127.0.0.1:${server.address().port}`,
    "--state-dir", directory,
    "--foreground",
  ];
  const env = { ...process.env, MOA_GATEWAY_TOKEN: "integration-token" };
  const first = JSON.parse((await execFileAsync(process.execPath, [...common, "--", "/usr/bin/true"], { env })).stdout);
  const second = JSON.parse((await execFileAsync(process.execPath, [...common, "--reopen", "--", "/usr/bin/true"], { env })).stdout);
  assert.equal(first.agent_id, second.agent_id);
  assert.equal(first.intent_id, second.intent_id);
  assert.notEqual(first.adapter_run_id, second.adapter_run_id);
  assert.equal(starts.length, 2);
  assert.equal(starts[0].body.reopen_intent, false);
  assert.equal(starts[1].body.reopen_intent, true);
  assert.notEqual(starts[0].body.current_run_id, starts[1].body.current_run_id);
});

test("partial terminal synchronization resumes from a stable checkpoint with frozen recap", async (context) => {
  const calls = [];
  let failTerminalIntentOnce = true;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const call = { method: request.method, url: request.url, body: body ? JSON.parse(body) : {} };
      calls.push(call);
      if (request.method === "PATCH" && call.body.status === "completed" && failTerminalIntentOnce) {
        failTerminalIntentOnce = false;
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "injected terminal intent failure" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moa-codex-terminal-retry-"));
  const gateway = `http://127.0.0.1:${server.address().port}`;
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(__dirname, "cli.js"),
    "launch",
    "--user-confirmed",
    "--namespace", "personal",
    "--project", "chief-moa",
    "--intent-key", "terminal-retry",
    "--agent-key", "owner",
    "--title", "Terminal retry",
    "--objective", "Resume a partial terminal transition.",
    "--launch-reason", "Fault injection",
    "--cwd", directory,
    "--gateway", gateway,
    "--state-dir", directory,
    "--foreground",
    "--",
    "/usr/bin/true",
  ], { env: { ...process.env, MOA_GATEWAY_TOKEN: "integration-token" } });
  const initial = JSON.parse(stdout);
  const file = path.join(directory, "runs", `${initial.adapter_run_id}.json`);
  const checkpointed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(checkpointed.remote_pending, true);
  assert.equal(checkpointed.terminal_sync.agent.done, true);
  assert.equal(checkpointed.terminal_sync.intent.done, false);
  const frozenNextAction = checkpointed.terminal_sync.intent.next_action;
  checkpointed.latest_recap = "A changed recap after the checkpoint must not change the retry.";
  writeJsonAtomic(file, checkpointed);
  await execFileAsync(process.execPath, [
    path.join(__dirname, "cli.js"),
    "reconcile",
    "--gateway", gateway,
    "--state-dir", directory,
  ], { env: { ...process.env, MOA_GATEWAY_TOKEN: "integration-token" } });
  const completedProgress = calls.filter((call) => call.url.includes("/progress") && call.body.status === "completed");
  const completedIntent = calls.filter((call) => call.method === "PATCH" && call.body.status === "completed");
  assert.equal(completedProgress.length, 1);
  assert.equal(completedIntent.length, 2);
  assert.deepEqual(completedIntent[0].body, completedIntent[1].body);
  assert.equal(completedIntent[1].body.next_action, frozenNextAction);
  assert.equal(completedIntent[1].body.current_run_id, initial.adapter_run_id);
  const final = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(final.remote_pending, false);
  assert.equal(final.terminal_sync.intent.done, true);
});

test("invalid progress status is rejected before local state mutation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moa-codex-invalid-status-"));
  const settings = config({ "state-dir": directory, gateway: "https://api.example.test" }, {
    MOA_GATEWAY_TOKEN: "integration-token",
  });
  const state = launchState({
    "user-confirmed": true,
    namespace: "personal",
    project: "chief-moa",
    "intent-key": "invalid-status",
    "agent-key": "owner",
    title: "Invalid status",
    objective: "Reject invalid status.",
    "launch-reason": "Test",
    cwd: directory,
  }, ["/usr/bin/true"], settings);
  writeJsonAtomic(state.state_file, state);
  const before = fs.readFileSync(state.state_file, "utf8");
  await assert.rejects(execFileAsync(process.execPath, [
    path.join(__dirname, "cli.js"),
    "progress",
    "--run", state.adapter_run_id,
    "--status", "definitely-not-valid",
    "--message", "Must not be written.",
    "--gateway", "https://api.example.test",
    "--state-dir", directory,
  ], { env: { ...process.env, MOA_GATEWAY_TOKEN: "integration-token" } }), /unsupported adapter status/);
  assert.equal(fs.readFileSync(state.state_file, "utf8"), before);
});

test("alternate gateway token and all Chief Moa credentials are absent inside the launched command", async (context) => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      assert.equal(request.headers.authorization, "Bearer alternate-token");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moa-codex-alt-token-"));
  const probe = path.join(directory, "probe.js");
  const result = path.join(directory, "child-environment.json");
  fs.writeFileSync(probe, `"use strict";
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], JSON.stringify({
  selected: Boolean(process.env.CUSTOM_GATEWAY_TOKEN),
  gateway: Boolean(process.env.MOA_GATEWAY_TOKEN),
  promoter: Boolean(process.env.MOA_PRODUCTION_PROMOTER_TOKEN),
  safe: process.env.SAFE_SETTING,
}));
`);
  await execFileAsync(process.execPath, [
    path.join(__dirname, "cli.js"),
    "launch",
    "--user-confirmed",
    "--namespace", "personal",
    "--project", "chief-moa",
    "--intent-key", "alternate-token",
    "--agent-key", "owner",
    "--title", "Alternate token",
    "--objective", "Strip credentials.",
    "--launch-reason", "Security test",
    "--cwd", directory,
    "--gateway", `http://127.0.0.1:${server.address().port}`,
    "--token-env", "CUSTOM_GATEWAY_TOKEN",
    "--state-dir", directory,
    "--foreground",
    "--",
    process.execPath,
    probe,
    result,
  ], {
    env: {
      ...process.env,
      CUSTOM_GATEWAY_TOKEN: "alternate-token",
      MOA_GATEWAY_TOKEN: "gateway-token",
      MOA_PRODUCTION_PROMOTER_TOKEN: "promoter-token",
      SAFE_SETTING: "retained",
    },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(result)), {
    selected: false,
    gateway: false,
    promoter: false,
    safe: "retained",
  });
});

test("launch-codex always prepends the zero-child direct-worker contract", async (context) => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moa-codex-role-"));
  const fakeCodex = path.join(directory, "fake-codex.js");
  const captured = path.join(directory, "captured-prompt.txt");
  const task = path.join(directory, "task.md");
  fs.writeFileSync(task, "TASK MARKER: implement the bounded fix.");
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.env.ROLE_CAPTURE_PATH, prompt);
const outputIndex = process.argv.indexOf("-o");
if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], "Fake owner completed.");
`);
  fs.chmodSync(fakeCodex, 0o700);
  await execFileAsync(process.execPath, [
    path.join(__dirname, "cli.js"),
    "launch-codex",
    "--user-confirmed",
    "--namespace", "personal",
    "--project", "chief-moa",
    "--intent-key", "role-contract",
    "--agent-key", "owner",
    "--title", "Role contract",
    "--objective", "Prove direct-worker specialization.",
    "--launch-reason", "Role test",
    "--cwd", directory,
    "--gateway", `http://127.0.0.1:${server.address().port}`,
    "--state-dir", directory,
    "--prompt-file", task,
    "--codex-bin", fakeCodex,
    "--foreground",
  ], {
    env: {
      ...process.env,
      MOA_GATEWAY_TOKEN: "integration-token",
      ROLE_CAPTURE_PATH: captured,
    },
  });
  const prompt = fs.readFileSync(captured, "utf8");
  assert.match(prompt, /launched direct worker/);
  assert.match(prompt, /numeric maximum child-agent count is 0/);
  assert.match(prompt, /TASK MARKER: implement the bounded fix/);
  assert.ok(prompt.indexOf("numeric maximum child-agent count is 0") < prompt.indexOf("TASK MARKER"));
});
