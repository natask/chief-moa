#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  IntentPlaneClient,
  SCHEMA,
  TERMINAL,
  VERSION,
  artifactDir,
  buildIdentity,
  clean,
  defaultStateDir,
  ensurePrivateDir,
  listStateFiles,
  makeRunId,
  processMatches,
  processSnapshot,
  publicState,
  readJson,
  required,
  stateFile,
  syncProgress,
  syncTerminal,
  validateAgentStatus,
  validateGatewayUrl,
  writeJsonAtomic,
} = require("./lib");

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

function usage(error = "") {
  const output = `${error ? `${error}\n\n` : ""}Chief Moa Codex intent launcher ${VERSION}

Usage:
  moa-codex-intent launch [options] -- <command> [args...]
  moa-codex-intent launch-codex [options] --prompt-file <path>
  moa-codex-intent progress --run <id> --status <running|blocked|completed|failed|cancelled> --message <text>
  moa-codex-intent reconcile
  moa-codex-intent status [--remote]

Required launch options:
  --user-confirmed                 Admit this explicit user intention
  --namespace <name>               Hosted logical authority namespace
  --project <name>                 Project metadata
  --intent-key <stable-key>        Stable key for the intention
  --agent-key <stable-key>         Stable key for the owner
  --title <text>
  --objective <text>
  --launch-reason <text>
  --cwd <path>

Optional:
  --gateway <url>                  Defaults to MOA_GATEWAY_URL
  --token-env <name>               Defaults to MOA_GATEWAY_TOKEN
  --launcher-agent-id <id>
  --tenant-id <id>                 Defaults to tenant_global
  --sphere <name>                  Defaults to personal
  --capability <name>              Repeatable
  --authority-summary <text>
  --sensitivity <normal|sensitive|restricted>
  --summary-file <path>            Explicit final recap produced by the command
  --artifact <path-or-ref>         Repeatable
  --foreground                     Wait instead of returning after durable launch
  --allow-offline                  Launch if the hosted plane is temporarily unavailable
  --reopen                         Explicitly start a new run for a terminal owner
  --state-dir <path>               Defaults to ~/.local/state/chief-moa/codex-intent-launcher
  --heartbeat-seconds <number>     Defaults to 60; minimum 15

launch-codex additionally accepts:
  --prompt-file <path>             Prompt stays out of argv and is streamed on stdin
  --codex-bin <path>               Defaults to codex
  --model <name>
  --sandbox <mode>

The adapter never stores the gateway token or the raw command arguments in its
durable state. It strips the gateway token from the launched command environment.
`;
  (error ? process.stderr : process.stdout).write(output);
}

function parse(argv) {
  const values = {};
  const repeatable = new Set(["capability", "artifact"]);
  const booleans = new Set(["user-confirmed", "foreground", "allow-offline", "remote", "reopen"]);
  const divider = argv.indexOf("--");
  const optionArgs = divider === -1 ? argv : argv.slice(0, divider);
  const command = divider === -1 ? [] : argv.slice(divider + 1);
  for (let index = 0; index < optionArgs.length; index += 1) {
    const raw = optionArgs[index];
    if (!raw.startsWith("--")) throw new Error(`unexpected argument: ${raw}`);
    const key = raw.slice(2);
    if (booleans.has(key)) {
      values[key] = true;
      continue;
    }
    const value = optionArgs[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${raw} requires a value`);
    index += 1;
    if (repeatable.has(key)) {
      values[key] ||= [];
      values[key].push(value);
    } else {
      values[key] = value;
    }
  }
  return { values, command };
}

function config(values, env = process.env) {
  const tokenEnv = clean(values["token-env"], 160) || "MOA_GATEWAY_TOKEN";
  if (!/^[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET)$/.test(tokenEnv)) {
    throw new Error("token environment name must be an uppercase TOKEN, KEY, or SECRET variable");
  }
  const token = env[tokenEnv];
  const gatewayUrl = values.gateway || env.MOA_GATEWAY_URL;
  return {
    tokenEnv,
    token,
    gatewayUrl: gatewayUrl ? validateGatewayUrl(gatewayUrl) : "",
    stateDir: path.resolve(values["state-dir"] || defaultStateDir(env)),
  };
}

const CHIEF_MOA_CREDENTIAL_ENV = new Set([
  "MOA_GATEWAY_TOKEN",
  "AGEE_GATEWAY_TOKEN",
  "MOA_CONTROL_PLANE_TOKEN",
  "MOA_DEPLOY_USER_TOKEN",
  "MOA_DEPLOY_REVIEWER_TOKEN",
  "MOA_PREVIEW_DEPLOYER_TOKEN",
  "MOA_PRODUCTION_PROMOTER_TOKEN",
  "MOA_MAIN_MACHINE_SSH_KEY",
  "MOA_ANDROID_KEYSTORE_B64",
  "MOA_ANDROID_KEYSTORE_PASSWORD",
  "MOA_ANDROID_KEY_PASSWORD",
  "ACCOUNT_CREDENTIAL_KEY",
  "ACCOUNT_OAUTH_GOOGLE_CLIENT_SECRET",
  "ACCOUNT_OAUTH_GITHUB_CLIENT_SECRET",
  "CHIRP_ACCESS_TOKEN",
  "GCP_SERVICE_ACCOUNT_KEY",
  "GEMINI_API_KEY",
  "VERTEX_EXPRESS_API_KEY",
]);

function childEnvironment(env, selectedTokenEnv) {
  const result = { ...env };
  for (const name of new Set([...CHIEF_MOA_CREDENTIAL_ENV, selectedTokenEnv])) delete result[name];
  return result;
}

function assertSafeCommand(command) {
  const sensitiveName = /(?:^|[-_])(?:access[-_]?token|token|secret|password|passwd|api[-_]?key|authorization|credential)(?:=|$)/i;
  const credentialUrl = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+:[^@\s]+@|[?&](?:token|access_?token|api_?key|secret|signature|sig|authorization)=/i;
  for (const argument of command) {
    const value = String(argument);
    if (sensitiveName.test(value) || credentialUrl.test(value) || /\bBearer\s+\S+/i.test(value)) {
      throw new Error("command arguments appear to contain a credential; pass secrets through an approved secret store or narrowly scoped environment instead");
    }
  }
}

function clientFor(settings) {
  if (!settings.gatewayUrl) throw new Error("gateway URL is required via --gateway or MOA_GATEWAY_URL");
  if (!settings.token) throw new Error(`gateway token is required via ${settings.tokenEnv}`);
  return new IntentPlaneClient({ gatewayUrl: settings.gatewayUrl, token: settings.token });
}

function launchState(values, command, settings) {
  if (values["user-confirmed"] !== true) throw new Error("--user-confirmed is required");
  if (!Array.isArray(command) || command.length === 0) throw new Error("a command is required after --");
  assertSafeCommand(command);
  const identity = buildIdentity({
    namespace: values.namespace,
    project: values.project,
    intentKey: values["intent-key"],
    agentKey: values["agent-key"],
  });
  const adapterRunId = makeRunId(identity.agentId);
  const cwd = path.resolve(required(values.cwd, "cwd", 2_000));
  if (!fs.statSync(cwd).isDirectory()) throw new Error("cwd must be a directory");
  const artifacts = artifactDir(settings.stateDir, adapterRunId);
  ensurePrivateDir(artifacts);
  const summaryFile = values["summary-file"]
    ? path.resolve(values["summary-file"])
    : path.join(artifacts, "last-message.txt");
  return {
    schema: SCHEMA,
    adapter_version: VERSION,
    adapter_run_id: adapterRunId,
    intent_id: identity.intentId,
    agent_id: identity.agentId,
    namespace: identity.namespace,
    project: identity.project,
    tenant_id: clean(values["tenant-id"], 160) || "tenant_global",
    sphere: clean(values.sphere, 160) || "personal",
    intent_key: identity.intentKey,
    agent_key: identity.agentKey,
    title: required(values.title, "title", 240),
    objective: required(values.objective, "objective"),
    launch_reason: required(values["launch-reason"], "launch reason", 800),
    launcher_agent_id: clean(values["launcher-agent-id"], 160),
    capabilities: [...new Set(values.capability || ["filesystem", "codex"])].slice(0, 40),
    authority_summary: clean(values["authority-summary"], 800) || "Bounded local execution in the selected working directory; no recursive delegation.",
    sensitivity: clean(values.sensitivity, 40) || "normal",
    status: "queued",
    progress: "Queued by the local Chief Moa Codex launcher adapter.",
    latest_recap: "",
    artifact_refs: [...new Set([
      ...(values.artifact || []).map((item) => clean(item, 400)).filter(Boolean),
      path.join(artifacts, "stdout.log"),
      path.join(artifacts, "stderr.log"),
      summaryFile,
      path.join(artifacts, "receipt.json"),
    ])].slice(0, 40),
    cwd,
    command: {
      executable: path.basename(command[0]),
      argv_sha256: crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex"),
      argument_count: command.length - 1,
    },
    summary_file: summaryFile,
    state_file: stateFile(settings.stateDir, adapterRunId),
    gateway_url: settings.gatewayUrl,
    token_env: settings.tokenEnv,
    heartbeat_seconds: Math.max(15, Math.min(Number(values["heartbeat-seconds"]) || 60, 3_600)),
    heartbeat_sequence: 0,
    pid: null,
    worker_pid: null,
    remote_sequence: 0,
    remote_pending: true,
    reopen_requested: values.reopen === true,
    start_sync: {
      done: false,
      idempotency_key: `codex-adapter:start:${adapterRunId}`,
      reopen_intent: values.reopen === true,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function admit(client, state) {
  await client.createIntent(state);
  await client.registerAgent(state);
}

async function startRemoteRun(client, state, persist = () => {}) {
  state.start_sync ||= {
    done: false,
    idempotency_key: `codex-adapter:start:${state.adapter_run_id}`,
    reopen_intent: Boolean(state.reopen_requested),
  };
  persist(state);
  if (state.start_sync.done) return;
  await client.startAgentRun(state, {
    reopenIntent: state.start_sync.reopen_intent,
    idempotencyKey: state.start_sync.idempotency_key,
  });
  state.start_sync.done = true;
  state.remote_pending = false;
  persist(state);
}

function writeLaunchSpec(state, command, values, settings) {
  const directory = path.join(settings.stateDir, "launch-specs");
  ensurePrivateDir(directory);
  const file = path.join(directory, `${state.adapter_run_id}.${crypto.randomUUID()}.json`);
  writeJsonAtomic(file, {
    schema: SCHEMA,
    state_file: state.state_file,
    command,
    stdin_file: values["stdin-file"] ? path.resolve(values["stdin-file"]) : "",
    stdin_files: (values["stdin-files"] || []).map((item) => path.resolve(item)),
  });
  return file;
}

function spawnWorker(specFile, foreground) {
  const args = [__filename, "__worker", "--spec", specFile];
  const child = spawn(process.execPath, args, {
    detached: !foreground,
    stdio: foreground ? "inherit" : "ignore",
    env: process.env,
  });
  if (!foreground) child.unref();
  return child;
}

async function launch(values, command) {
  const settings = config(values);
  const state = launchState(values, command, settings);
  writeJsonAtomic(state.state_file, state);
  try {
    const client = clientFor(settings);
    await admit(client, state);
    await startRemoteRun(client, state, (next) => writeJsonAtomic(next.state_file, next));
    state.remote_pending = false;
  } catch (error) {
    state.progress = `Hosted admission failed: ${clean(error.message, 1_000)}`;
    state.remote_pending = true;
    state.updated_at = new Date().toISOString();
    writeJsonAtomic(state.state_file, state);
    if (!values["allow-offline"]) throw error;
  }
  const specFile = writeLaunchSpec(state, command, values, settings);
  const child = spawnWorker(specFile, Boolean(values.foreground));
  state.worker_pid = child.pid;
  state.worker_pid_identity = processSnapshot(child.pid).identity;
  if (!state.worker_pid_identity) {
    child.kill("SIGTERM");
    throw new Error("could not establish a stable launcher-worker identity");
  }
  state.updated_at = new Date().toISOString();
  writeJsonAtomic(state.state_file, state);
  if (values.foreground) {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    const finalState = readJson(state.state_file);
    process.stdout.write(`${JSON.stringify(publicState(finalState), null, 2)}\n`);
    process.exitCode = exitCode;
  } else {
    process.stdout.write(`${JSON.stringify(publicState(state), null, 2)}\n`);
  }
}

async function worker(specFile) {
  const spec = readJson(specFile);
  fs.unlinkSync(specFile);
  const state = readJson(spec.state_file);
  const settings = {
    gatewayUrl: state.gateway_url,
    tokenEnv: state.token_env,
    token: process.env[state.token_env],
  };
  const outputDirectory = artifactDir(path.dirname(path.dirname(spec.state_file)), state.adapter_run_id);
  ensurePrivateDir(outputDirectory);
  const stdoutPath = path.join(outputDirectory, "stdout.log");
  const stderrPath = path.join(outputDirectory, "stderr.log");
  const receiptPath = path.join(outputDirectory, "receipt.json");
  const stdout = fs.openSync(stdoutPath, "a", 0o600);
  const stderr = fs.openSync(stderrPath, "a", 0o600);
  let client = null;
  try {
    client = clientFor(settings);
  } catch {
    // Offline launches remain locally observable and reconcileable.
  }
  state.status = "running";
  state.pid = process.pid;
  state.pid_identity = processSnapshot(process.pid).identity;
  state.started_at = new Date().toISOString();
  state.updated_at = state.started_at;
  state.progress = "Codex owner process started.";
  state.remote_pending = true;
  writeJsonAtomic(state.state_file, state);
  if (client) {
    try {
      if (state.remote_pending) await admit(client, state);
      await startRemoteRun(client, state, (next) => writeJsonAtomic(next.state_file, next));
      writeJsonAtomic(state.state_file, state);
    } catch (error) {
      state.remote_pending = true;
      state.remote_error = clean(error.message, 1_000);
      writeJsonAtomic(state.state_file, state);
    }
  }

  const childEnv = childEnvironment(process.env, state.token_env);
  const stdinFiles = (spec.stdin_files || [spec.stdin_file]).filter(Boolean);
  let stdin = "ignore";
  if (stdinFiles.length) {
    const combined = path.join(outputDirectory, `.launch-input-${crypto.randomUUID()}`);
    fs.writeFileSync(combined, stdinFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n\n"), { mode: 0o600 });
    stdin = fs.openSync(combined, "r");
    fs.unlinkSync(combined);
  }
  let exitCode = 1;
  let signal = "";
  let heartbeatTimer = null;
  let heartbeatInFlight = Promise.resolve();
  try {
    const child = spawn(spec.command[0], spec.command.slice(1), {
      cwd: state.cwd,
      env: childEnv,
      stdio: [stdin, stdout, stderr],
    });
    state.pid = child.pid;
    state.pid_identity = processSnapshot(child.pid).identity;
    if (!state.pid_identity) {
      child.kill("SIGTERM");
      throw new Error("could not establish a stable child-process identity");
    }
    state.updated_at = new Date().toISOString();
    writeJsonAtomic(state.state_file, state);
    if (client) {
      heartbeatTimer = setInterval(() => {
        heartbeatInFlight = heartbeatInFlight.then(async () => {
          state.heartbeat_sequence = Number(state.heartbeat_sequence || 0) + 1;
          state.updated_at = new Date().toISOString();
          try {
            await client.heartbeatAgent(state, state.progress || "Codex owner is running.", {
              recap: state.latest_recap,
              artifactRefs: state.artifact_refs,
            });
            state.remote_pending = false;
            delete state.remote_error;
          } catch (error) {
            state.remote_pending = true;
            state.remote_error = clean(error.message, 1_000);
          }
          writeJsonAtomic(state.state_file, state);
        });
      }, state.heartbeat_seconds * 1_000);
      heartbeatTimer.unref();
    }
    ({ code: exitCode, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, childSignal) => resolve({ code: code ?? 1, signal: childSignal || "" }));
    }));
  } catch (error) {
    fs.writeSync(stderr, `${error.stack || error.message}\n`);
    state.terminal_reason = clean(error.message, 1_000);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await heartbeatInFlight;
    if (typeof stdin === "number") fs.closeSync(stdin);
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }

  let recap = "";
  try {
    recap = clean(fs.readFileSync(state.summary_file, "utf8"));
  } catch {
    recap = exitCode === 0 ? "The launched Codex owner completed without an explicit recap." : "";
  }
  state.status = exitCode === 0 ? "completed" : "failed";
  state.finished_at = new Date().toISOString();
  state.updated_at = state.finished_at;
  state.latest_recap = recap;
  state.progress = exitCode === 0 ? "Codex owner completed." : `Codex owner failed with exit code ${exitCode}${signal ? ` (${signal})` : ""}.`;
  state.terminal_reason ||= exitCode === 0 ? "" : state.progress;
  state.pid = null;
  state.remote_pending = true;
  writeJsonAtomic(receiptPath, {
    schema: SCHEMA,
    adapter_run_id: state.adapter_run_id,
    status: state.status,
    exit_code: exitCode,
    signal,
    finished_at: state.finished_at,
    command: state.command,
  });
  writeJsonAtomic(state.state_file, state);
  if (client) {
    try {
      if (!state.start_sync?.done) {
        await admit(client, state);
        await startRemoteRun(client, state, (next) => writeJsonAtomic(next.state_file, next));
      }
      await syncTerminal(client, state, { persist: (next) => writeJsonAtomic(next.state_file, next) });
      writeJsonAtomic(state.state_file, state);
    } catch (error) {
      state.remote_pending = true;
      state.remote_error = clean(error.message, 1_000);
      writeJsonAtomic(state.state_file, state);
    }
  }
  process.exitCode = exitCode;
}

async function progress(values) {
  const settings = config(values);
  const runId = required(values.run, "run", 200);
  const file = stateFile(settings.stateDir, runId);
  const state = readJson(file);
  const status = validateAgentStatus(values.status);
  const message = required(values.message, "message");
  const recap = clean(values.recap);
  if (state.terminal_sync) {
    throw new Error("terminal synchronization is already checkpointed; its status, recap, and artifacts are immutable");
  }
  const artifacts = [...new Set([...(state.artifact_refs || []), ...(values.artifact || [])])].slice(0, 40);
  state.status = status;
  state.progress = message;
  if (recap) state.latest_recap = recap;
  state.artifact_refs = artifacts;
  state.updated_at = new Date().toISOString();
  state.remote_pending = true;
  if (TERMINAL.has(status)) state.finished_at ||= state.updated_at;
  writeJsonAtomic(file, state);
  const client = clientFor(settings);
  if (TERMINAL.has(status)) {
    if (!state.start_sync?.done) await startRemoteRun(client, state, (next) => writeJsonAtomic(next.state_file, next));
    await syncTerminal(client, state, { persist: (next) => writeJsonAtomic(next.state_file, next) });
  }
  else await syncProgress(client, state, status, message, { recap, artifactRefs: artifacts });
  writeJsonAtomic(file, state);
  process.stdout.write(`${JSON.stringify(publicState(state), null, 2)}\n`);
}

async function reconcile(values) {
  const settings = config(values);
  const client = clientFor(settings);
  const results = [];
  for (const file of listStateFiles(settings.stateDir)) {
    const state = readJson(file);
    if (state.status === "running" && !processMatches(state.pid, state.pid_identity)) {
      state.status = "blocked";
      state.finished_at = new Date().toISOString();
      state.updated_at = state.finished_at;
      state.progress = "Launcher worker ended without a terminal receipt.";
      state.terminal_reason = "The local process or response stream ended before a terminal receipt was persisted. Inspect the logs, then relaunch or mark the task.";
      state.pid = null;
      state.remote_pending = true;
      writeJsonAtomic(file, state);
    } else if (state.status === "queued" && state.worker_pid
      && !processMatches(state.worker_pid, state.worker_pid_identity)) {
      state.status = "blocked";
      state.finished_at = new Date().toISOString();
      state.updated_at = state.finished_at;
      state.progress = "Queued launcher worker is no longer running.";
      state.terminal_reason = "The adapter did not observe the launched command start.";
      state.remote_pending = true;
      writeJsonAtomic(file, state);
    }
    if (state.remote_pending) {
      try {
        await admit(client, state);
        if (!state.start_sync?.done) {
          await startRemoteRun(client, state, (next) => writeJsonAtomic(next.state_file, next));
        }
        if (TERMINAL.has(state.status)) {
          await syncTerminal(client, state, { persist: (next) => writeJsonAtomic(next.state_file, next) });
        }
        else if (state.status === "running") await syncProgress(client, state, "running", state.progress || "Running.", {
          recap: state.latest_recap,
          artifactRefs: state.artifact_refs,
        });
        state.remote_pending = false;
        delete state.remote_error;
      } catch (error) {
        state.remote_pending = true;
        state.remote_error = clean(error.message, 1_000);
      }
      state.updated_at = new Date().toISOString();
      writeJsonAtomic(file, state);
    }
    results.push(publicState(state));
  }
  process.stdout.write(`${JSON.stringify({ schema: SCHEMA, reconciled: results.length, runs: results }, null, 2)}\n`);
}

async function status(values) {
  const settings = config(values);
  const runs = listStateFiles(settings.stateDir).map((file) => publicState(readJson(file)));
  const result = { schema: SCHEMA, runs };
  if (values.remote) result.remote = await clientFor(settings).projection();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function codexCommand(values) {
  const promptFile = path.resolve(required(values["prompt-file"], "prompt file", 2_000));
  if (!fs.statSync(promptFile).isFile()) throw new Error("prompt file must be a file");
  values["stdin-files"] = [path.join(__dirname, "direct-owner-prompt.md"), promptFile];
  const summaryFile = values["summary-file"] || path.join(
    path.resolve(values["state-dir"] || defaultStateDir()),
    "summaries",
    `${Date.now()}-${crypto.randomUUID()}.txt`,
  );
  ensurePrivateDir(path.dirname(summaryFile));
  values["summary-file"] = summaryFile;
  const command = [
    values["codex-bin"] || "codex",
    "exec",
    "--json",
    "--color",
    "never",
    "-o",
    summaryFile,
    "-C",
    path.resolve(required(values.cwd, "cwd", 2_000)),
  ];
  if (values.model) command.push("--model", values.model);
  if (values.sandbox) command.push("--sandbox", values.sandbox);
  command.push("-");
  return command;
}

async function main(argv = process.argv.slice(2)) {
  const subcommand = argv.shift();
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    usage();
    return;
  }
  const { values, command } = parse(argv);
  if (subcommand === "launch") return launch(values, command);
  if (subcommand === "launch-codex") return launch(values, codexCommand(values));
  if (subcommand === "progress") return progress(values);
  if (subcommand === "reconcile") return reconcile(values);
  if (subcommand === "status") return status(values);
  if (subcommand === "__worker") return worker(path.resolve(required(values.spec, "spec", 2_000)));
  throw new Error(`unknown subcommand: ${subcommand}`);
}

if (require.main === module) {
  main().catch((error) => {
    usage(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  admit,
  assertSafeCommand,
  childEnvironment,
  codexCommand,
  config,
  launchState,
  main,
  parse,
  startRemoteRun,
};
