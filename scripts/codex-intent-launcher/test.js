"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const test = require("node:test");
const { IntentPlaneClient, buildIdentity, publicState, stableId, writeJsonAtomic } = require("./lib");
const { codexCommand, config, launchState, parse } = require("./cli");
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
  assert.equal(state.tenant_id, "global");
  assert.equal(state.sphere, "default");
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
  assert.equal(values["stdin-file"], prompt);
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
  assert.ok(calls.some((call) => call.url.includes("/progress") && call.body.status === "running"));
  assert.ok(calls.some((call) => call.url.includes("/progress") && call.body.status === "completed"));
  assert.ok(calls.some((call) => call.method === "PATCH" && call.body.status === "completed"));
  assert.doesNotMatch(JSON.stringify(calls), /integration-token/);
  const receipt = JSON.parse(fs.readFileSync(finalState.artifact_refs.find((item) => item.endsWith("receipt.json"))));
  assert.equal(receipt.exit_code, 0);
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
