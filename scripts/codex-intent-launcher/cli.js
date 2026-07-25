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
  processAlive,
  publicState,
  readJson,
  required,
  stateFile,
  syncProgress,
  syncTerminal,
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
  --tenant-id <id>                 Defaults to global
  --sphere <name>                  Defaults to default
  --capability <name>              Repeatable
  --authority-summary <text>
  --sensitivity <normal|sensitive|restricted>
  --summary-file <path>            Explicit final recap produced by the command
  --artifact <path-or-ref>         Repeatable
  --foreground                     Wait instead of returning after durable launch
  --allow-offline                  Launch if the hosted plane is temporarily unavailable
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
  const booleans = new Set(["user-confirmed", "foreground", "allow-offline", "remote"]);
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
  const token = env[tokenEnv];
  const gatewayUrl = values.gateway || env.MOA_GATEWAY_URL;
  return {
    tokenEnv,
    token,
    gatewayUrl: gatewayUrl ? validateGatewayUrl(gatewayUrl) : "",
    stateDir: path.resolve(values["state-dir"] || defaultStateDir(env)),
  };
}

function clientFor(settings) {
  if (!settings.gatewayUrl) throw new Error("gateway URL is required via --gateway or MOA_GATEWAY_URL");
  if (!settings.token) throw new Error(`gateway token is required via ${settings.tokenEnv}`);
  return new IntentPlaneClient({ gatewayUrl: settings.gatewayUrl, token: settings.token });
}

function launchState(values, command, settings) {
  if (values["user-confirmed"] !== true) throw new Error("--user-confirmed is required");
  if (!Array.isArray(command) || command.length === 0) throw new Error("a command is required after --");
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
    tenant_id: clean(values["tenant-id"], 160) || "global",
    sphere: clean(values.sphere, 160) || "default",
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function admit(client, state) {
  await client.createIntent(state);
  await client.registerAgent(state);
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
    await admit(clientFor(settings), state);
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
  state.started_at = new Date().toISOString();
  state.updated_at = state.started_at;
  state.progress = "Codex owner process started.";
  state.remote_pending = true;
  writeJsonAtomic(state.state_file, state);
  if (client) {
    try {
      if (state.remote_pending) await admit(client, state);
      await syncProgress(client, state, "running", state.progress);
      writeJsonAtomic(state.state_file, state);
    } catch (error) {
      state.remote_pending = true;
      state.remote_error = clean(error.message, 1_000);
      writeJsonAtomic(state.state_file, state);
    }
  }

  const childEnv = { ...process.env };
  delete childEnv[state.token_env];
  const stdin = spec.stdin_file ? fs.openSync(spec.stdin_file, "r") : "ignore";
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
      await syncTerminal(client, state);
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
  const status = required(values.status, "status", 40);
  const message = required(values.message, "message");
  const recap = clean(values.recap);
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
  if (TERMINAL.has(status)) await syncTerminal(client, state);
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
    if (state.status === "running" && !processAlive(state.pid)) {
      state.status = "blocked";
      state.finished_at = new Date().toISOString();
      state.updated_at = state.finished_at;
      state.progress = "Launcher worker ended without a terminal receipt.";
      state.terminal_reason = "The local process or response stream ended before a terminal receipt was persisted. Inspect the logs, then relaunch or mark the task.";
      state.pid = null;
      state.remote_pending = true;
      writeJsonAtomic(file, state);
    } else if (state.status === "queued" && state.worker_pid && !processAlive(state.worker_pid)) {
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
        if (TERMINAL.has(state.status)) await syncTerminal(client, state);
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
  values["stdin-file"] = promptFile;
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

module.exports = { admit, codexCommand, config, launchState, main, parse };
