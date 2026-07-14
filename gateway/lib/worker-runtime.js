"use strict";

// Local execution-machine worker runtime for the worker-pull contract.
// The worker connects outbound to the gateway, claims scoped runs, executes
// locally allowlisted harness profiles, and reports events plus a terminal
// result. It starts no listener and never accepts command/args/shell/env or
// absolute paths from the gateway.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const { createWorkerWorkspace, loadWorkerProjectConfig } = require("./worker-workspace");

class WorkerRuntimeError extends Error {
  constructor(code, message, { status = 0, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

// The only harness enabled in this slice. It is deterministic and touches no
// filesystem path, process, or shell: the run prompt is echoed back as output.
async function echoHarness(run) {
  const prompt = String(run.prompt || "");
  return {
    exit_code: 0,
    output: prompt,
    stdout_tail: prompt ? `${prompt}\n` : "",
    stderr_tail: "",
  };
}

const DEFAULT_HARNESSES = { echo: echoHarness };
const FORBIDDEN_CLAIM_KEYS = new Set([
  "command", "args", "shell", "env", "credentials", "credential",
  "path", "cwd", "repo_url", "repourl", "default_ref", "defaultref",
  "workspace_root", "workspaceroot", "executable", "bin",
  "paths", "workdir", "working_path", "workingpath", "working_directory",
]);

// Real CLI harnesses. Each runs a locally-installed agent CLI against the
// claimed run's PROMPT ONLY - the gateway never supplies command, args, paths,
// or env (FORBIDDEN_CLAIM_KEYS enforces that upstream). The CLI executes in a
// durable worker-local Git worktree and inherits this machine's credentials,
// which never leave the machine. A harness is registered only when its binary
// answers a version probe, so the worker's hello advertises exactly what this
// machine can actually execute.
function cliHarness(command, argsFor, { parseOutput, terminationGraceMs = 2000, cancelPollMs = 100, minTimeoutMs = 10_000 } = {}) {
  const harness = async function runCliHarness(run, { isCanceled, workDir } = {}) {
    if (!workDir || !path.isAbsolute(workDir)) throw new WorkerRuntimeError("workspace_required", "CLI harness requires a prepared worker-local worktree");
    const timeoutMs = clamp(run.timeout_ms, minTimeoutMs, 30 * 60_000, 10 * 60_000);
    return await new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let stdoutTail = "";
        let stderrTail = "";
        let settled = false;
        let child;
        let terminationReason = "";
        let killTimer = null;
        let timer = null;
        let cancelPoll = null;
        let graceElapsed = false;
        let closeRecord = null;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(cancelPoll);
          clearTimeout(killTimer);
          fn(value);
        };
        const signalTree = (signal) => {
          if (!child?.pid) return;
          try {
            if (process.platform === "win32") child.kill(signal);
            else process.kill(-child.pid, signal);
          } catch {
            try { child.kill(signal); } catch { /* already gone */ }
          }
        };
        const terminate = (reason) => {
          if (terminationReason) return;
          terminationReason = reason;
          signalTree("SIGTERM");
          killTimer = setTimeout(() => {
            graceElapsed = true;
            signalTree("SIGKILL");
            if (closeRecord) resolveClose();
          }, clamp(terminationGraceMs, 0, 30_000, 2000));
        };
        const resolveClose = () => {
          if (!closeRecord) return;
          const parsed = typeof parseOutput === "function" ? parseOutput(stdout) : null;
          finish(resolve, {
            exit_code: closeRecord.code == null ? null : Number(closeRecord.code),
            output: truncate(String(parsed?.output || stdout.trim() || stderr.trim()), 120_000),
            stdout_tail: stdoutTail,
            stderr_tail: stderrTail,
            signal: closeRecord.signal || "",
            timed_out: terminationReason === "timeout",
            canceled: Boolean(terminationReason && terminationReason !== "timeout"),
            cancellation_reason: terminationReason,
          });
        };
        try {
          child = spawn(command, argsFor(run, workDir), {
            cwd: workDir,
            env: process.env,
            shell: false,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          finish(reject, error);
          return;
        }
        timer = setTimeout(() => terminate("timeout"), timeoutMs);
        cancelPoll = setInterval(() => {
          const reason = typeof isCanceled === "function" ? isCanceled() : false;
          if (reason) terminate(typeof reason === "string" ? reason : "canceled");
        }, clamp(cancelPollMs, 20, 2000, 100));
        child.stdout.on("data", (chunk) => {
          stdout = appendHead(stdout, chunk, 120_000);
          stdoutTail = appendBoundedTail(stdoutTail, chunk, 16_000);
        });
        child.stderr.on("data", (chunk) => {
          stderr = appendHead(stderr, chunk, 120_000);
          stderrTail = appendBoundedTail(stderrTail, chunk, 16_000);
        });
        child.on("error", (error) => finish(reject, error));
        child.on("close", (code, signal) => {
          closeRecord = { code, signal };
          if (!terminationReason || graceElapsed) resolveClose();
        });
    });
  };
  harness.requiresWorkspace = true;
  return harness;
}

// Claude with --output-format json prints { result, session_id, ... }; unwrap
// to the human text. Non-JSON stdout passes through untouched.
function parseClaudeJsonEnvelope(stdout) {
  const text = String(stdout || "").trim();
  if (!text.startsWith("{")) return { output: text };
  try {
    const json = JSON.parse(text);
    return { output: String(json.result || json.output || text) };
  } catch {
    return { output: text };
  }
}

const CLI_HARNESS_DEFS = {
  gemini: {
    bin: () => process.env.GEMINI_BIN || "gemini",
    versionArgs: ["-v"],
    argsFor: (run) => [
      "--prompt", String(run.prompt || ""),
      "--skip-trust",
      "--approval-mode", process.env.GEMINI_APPROVAL_MODE || "yolo",
      "--output-format", "text",
    ],
  },
  codex: {
    bin: () => process.env.CODEX_BIN || "codex",
    versionArgs: ["--version"],
    argsFor: (run, workDir) => {
      const args = ["exec", "--cd", workDir, "--skip-git-repo-check"];
      if (process.env.CODEX_BYPASS_APPROVALS === "1") {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      } else {
        args.push("--sandbox", process.env.CODEX_SANDBOX || "workspace-write");
      }
      args.push(String(run.prompt || ""));
      return args;
    },
  },
  claude: {
    bin: () => process.env.CLAUDE_BIN || "claude",
    versionArgs: ["--version"],
    parseOutput: parseClaudeJsonEnvelope,
    argsFor: (run, workDir) => {
      const args = [
        "--print",
        "--output-format", "json",
        "--model", process.env.CLAUDE_AGENT_MODEL || process.env.CLAUDE_MODEL || "sonnet",
        "--add-dir", workDir,
      ];
      if (process.env.CLAUDE_DANGEROUS_SKIP_PERMISSIONS === "1") {
        args.push("--dangerously-skip-permissions");
      } else {
        args.push("--permission-mode", process.env.CLAUDE_PERMISSION_MODE || "plan");
      }
      args.push(String(run.prompt || ""));
      return args;
    },
  },
};

function binaryAnswersProbe(bin, versionArgs) {
  try {
    const probe = spawnSync(bin, versionArgs, { stdio: "ignore", timeout: 8000 });
    return probe.status === 0;
  } catch {
    return false;
  }
}

// echo is always available; each CLI harness registers only when its binary
// answers a version probe. MOA_WORKER_HARNESSES (comma list) narrows the set.
function detectHarnesses(env = process.env) {
  const harnesses = { ...DEFAULT_HARNESSES };
  for (const [name, def] of Object.entries(CLI_HARNESS_DEFS)) {
    const bin = def.bin();
    if (binaryAnswersProbe(bin, def.versionArgs)) {
      harnesses[name] = cliHarness(bin, def.argsFor, { parseOutput: def.parseOutput });
    }
  }
  const allowlist = String(env.MOA_WORKER_HARNESSES || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (allowlist.length === 0) {
    return harnesses;
  }
  const filtered = {};
  for (const name of allowlist) {
    if (harnesses[name]) filtered[name] = harnesses[name];
  }
  return Object.keys(filtered).length > 0 ? filtered : { echo: echoHarness };
}

function createWorkerRuntime(options = {}) {
  const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl);
  if (!gatewayUrl) throw new WorkerRuntimeError("invalid_config", "gatewayUrl is required (http or https)");
  const localConfig = options.projectConfig || loadWorkerProjectConfig(options.projectConfigFile, { workspaceRoot: options.workspaceRoot });
  const workspace = localConfig.projects.length ? createWorkerWorkspace(localConfig, { gitBin: options.gitBin }) : null;
  const availableHarnesses = options.harnesses && typeof options.harnesses === "object"
    ? options.harnesses
    : detectHarnesses();
  const harnesses = workspace
    ? availableHarnesses
    : Object.fromEntries(Object.entries(availableHarnesses).filter(([, harness]) => harness?.requiresWorkspace !== true));
  const projectAliases = [...new Set(listOf(options.projectAliases).map(sanitizeAlias).filter(Boolean))];
  const configuredProjects = localConfig.projects.length ? localConfig.projects.map((item) => ({ id: item.id, local_alias: item.local_alias })) : Array.isArray(options.projects)
    ? options.projects.map((item) => ({ id: sanitizeId(item?.id || ""), local_alias: sanitizeAlias(item?.local_alias || item?.localAlias || item?.id || "") })).filter((item) => item.id)
    : [];
  const projects = configuredProjects.length
    ? configuredProjects
    : projectAliases.map((aliasValue) => ({ id: aliasValue, local_alias: aliasValue }));
  const stateFile = options.stateFile ? path.resolve(String(options.stateFile)) : "";
  const name = truncate(options.name || "Moa worker", 120);
  const machineLabel = String(options.machineLabel || "").trim().replace(/[^a-zA-Z0-9_.: -]/g, "-").slice(0, 120);
  const machineId = machineIdentifier(options.machineId, machineLabel);
  const platform = normalizeCapability(options.platform || defaultPlatform());
  const machineCapabilities = normalizeCapabilities(options.machineCapabilities);
  const once = options.once === true;
  const maxIdleMs = clamp(options.maxIdleMs, 0, 24 * 3600_000, 0);
  const idleDelayMs = clamp(options.idleDelayMs, 100, 60_000, 1000);
  const claimWaitMs = clamp(options.claimWaitMs, 0, 55_000, 25_000);
  const requestTimeoutMs = clamp(options.requestTimeoutMs, 1000, 120_000, 30_000);
  const maxRequestRetries = clamp(options.maxRequestRetries, 0, 10, 3);
  const lockWaitMs = clamp(options.lockWaitMs, 0, 10 * 60_000, 30_000);
  const lockRetryMs = clamp(options.lockRetryMs, 20, 5000, 250);
  const log = typeof options.log === "function" ? options.log : (line) => process.stdout.write(`${line}\n`);
  const fetchFn = typeof options.fetch === "function" ? options.fetch : fetch;

  let credentials = {
    worker_id: sanitizeId(options.workerId || ""),
    token: String(options.token || "").trim(),
    heartbeat_interval_ms: clamp(options.heartbeatIntervalMs, 100, 300_000, 15_000),
  };

  async function ensureCredentials() {
    if (credentials.token && credentials.worker_id) return credentials;
    const saved = readState(stateFile);
    if (saved?.worker_token && saved?.worker_id) {
      credentials = { worker_id: saved.worker_id, token: saved.worker_token, heartbeat_interval_ms: saved.heartbeat_interval_ms || 15_000 };
      log(`[worker] loaded credentials for ${credentials.worker_id} from state file`);
      return credentials;
    }
    const registrationId = sanitizeId(options.registrationId || "");
    const setupCode = String(options.setupCode || "").trim();
    if (!registrationId || !setupCode) {
      throw new WorkerRuntimeError("missing_credentials", "provide a worker token or a registration_id plus one-use setup_code");
    }
    const body = {
      registration_id: registrationId,
      setup_code: setupCode,
      worker: {
        name,
        version: "moa-worker/0.1.0",
        machine_label: machineLabel,
        machine_id: machineId,
        platform,
        capabilities: {
          transports: ["long_poll"],
          harnesses: Object.keys(harnesses).map((id) => ({ id, version: id === "echo" ? "builtin" : "local-profile", supports_resume: false })),
          projects: projects.map((item) => ({ ...item, path_policy: "local_allowlist" })),
          machine: machineCapabilities,
        },
      },
    };
    const registered = await request("POST", "/v1/agent/workers/register", body, { auth: false });
    credentials = {
      worker_id: registered.worker_id,
      token: registered.worker_token,
      heartbeat_interval_ms: clamp(registered.heartbeat_interval_ms, 1000, 300_000, 15_000),
    };
    writeState(stateFile, { worker_id: registered.worker_id, worker_token: registered.worker_token, token_id: registered.token_id, expires_at: registered.expires_at, heartbeat_interval_ms: credentials.heartbeat_interval_ms });
    log(`[worker] registered as ${credentials.worker_id} (token id ${registered.token_id})`);
    return credentials;
  }

  async function runLoop() {
    await ensureCredentials();
    const processed = [];
    let lastActivityAt = Date.now();
    let claimFailureCount = 0;
    for (;;) {
      let claimResponse;
      try {
        const claimBody = {
          worker_id: credentials.worker_id,
          transport: "long_poll",
          wait_ms: claimWaitMs,
          max_claims: 1,
          accepted_harnesses: Object.keys(harnesses),
        };
        const acceptedProjects = projects.map((item) => item.id).filter(Boolean);
        if (acceptedProjects.length && !onlyAliasDerivedProjects(projectAliases, projects)) {
          claimBody.accepted_projects = acceptedProjects;
        }
        claimResponse = await request("POST", "/v1/agent/workers/claim", claimBody);
        claimFailureCount = 0;
      } catch (error) {
        if (error.status === 401 || error.status === 403) throw error;
        claimFailureCount += 1;
        const delay = backoffDelayMs(idleDelayMs, claimFailureCount);
        log(`[worker] claim error ${error.code || error.message}; backing off ${delay}ms`);
        await sleep(delay);
        continue;
      }
      if (!claimResponse.claimed) {
        if (maxIdleMs && Date.now() - lastActivityAt >= maxIdleMs) {
          return { ok: true, idle: true, processed };
        }
        await sleep(clamp(claimResponse.retry_after_ms, 100, 60_000, idleDelayMs));
        continue;
      }
      const summary = await processClaim(claimResponse);
      processed.push(summary);
      lastActivityAt = Date.now();
      if (once) return { ok: true, idle: false, processed };
    }
  }

  async function processClaim({ claim, run }) {
    const ids = { worker_id: credentials.worker_id, claim_id: claim.claim_id };
    const runId = exactClaimId(run.id, "run id");
    const projectId = exactClaimId(run.working_dir?.project_id || run.work?.project_id || "", "project id");
    const localAlias = exactClaimAlias(run.working_dir?.local_alias || "", "project alias");
    log(`[worker] claimed run ${runId} harness=${run.harness} alias=${localAlias} attempt=${claim.attempt}`);

    const forbiddenKeys = forbiddenClaimKeys(run);
    if (forbiddenKeys.length) {
      const reason = `claim payload included forbidden key(s): ${forbiddenKeys.join(", ")}`;
      await reportEvents(runId, ids, [{ seq: 1, event_id: `wevt_${runId}_forbidden_claim`, type: "local_rejection", data: { reason } }]);
      await reportResult(runId, ids, { status: "failed", error: reason, retryable: false, exit_code: null });
      log(`[worker] rejected run ${runId} locally: ${reason}`);
      return { run_id: runId, status: "failed", local_rejection: true, reason };
    }

    const harnessFn = harnesses[String(run.harness || "")];
    const configuredProject = projects.find((item) => item.id === projectId && item.local_alias === localAlias);
    const aliasAllowed = !projectAliases.length || projectAliases.includes(localAlias);
    const projectAllowed = Boolean(configuredProject) || (projects.length === 0 && harnessFn?.requiresWorkspace !== true);
    if (typeof harnessFn !== "function" || !aliasAllowed || !projectAllowed) {
      const reason = typeof harnessFn !== "function"
        ? `harness ${String(run.harness || "")} is not in the local allowlist`
        : `project ${projectId}/${localAlias} is not in the local allowlist`;
      await reportEvents(runId, ids, [{ seq: 1, event_id: `wevt_${runId}_local_rejection`, type: "local_rejection", data: { reason } }]);
      await reportResult(runId, ids, { status: "failed", error: reason, retryable: false, exit_code: null });
      log(`[worker] rejected run ${runId} locally: ${reason}`);
      return { run_id: runId, status: "failed", local_rejection: true, reason };
    }

    let cancelRequested = false;
    let staleAuthority = false;
    const observeCancel = (payload) => {
      if (payload?.cancel_requested === true) cancelRequested = true;
    };
    const observeAuthorityError = (error) => {
      if (error?.status === 409) {
        staleAuthority = true;
        return true;
      }
      return false;
    };
    try {
      observeCancel(await reportHeartbeat(runId, ids, { phase: "start", message: `running ${run.harness}` }));
    } catch (error) {
      if (!observeAuthorityError(error)) throw error;
      return { run_id: runId, status: "stale-authority" };
    }

    let seq = 0;
    const sendEvent = async (type, data) => {
      seq += 1;
      try {
        const response = await reportEvents(runId, ids, [{ seq, event_id: `wevt_${runId}_${seq}`, type, data }]);
        observeCancel(response);
        return response;
      } catch (error) {
        if (observeAuthorityError(error)) return null;
        throw error;
      }
    };

    await sendEvent("started", { harness: run.harness, local_project_alias: localAlias });
    if (staleAuthority) return { run_id: runId, status: "stale-authority" };

    let outcome = null;
    let harnessError = "";
    let runLock = null;
    let lockWaitExpired = false;
    if (!cancelRequested) {
      const beat = startHeartbeat(runId, ids, observeCancel, observeAuthorityError);
      try {
        let workDir = "";
        if (harnessFn.requiresWorkspace === true) {
          if (!workspace) throw new WorkerRuntimeError("project_config_required", "real CLI harnesses require a worker-local project config");
          runLock = await waitForRunLock({
            projectId,
            alias: localAlias,
            runId,
            claimId: ids.claim_id,
            attempt: claim.attempt,
            workerId: ids.worker_id,
            machineId,
          }, () => staleAuthority || cancelRequested);
          if (!runLock && !staleAuthority && !cancelRequested) {
            lockWaitExpired = true;
          } else if (runLock) {
            const prepared = workspace.prepareRun({ projectId, alias: localAlias, runId });
            workDir = prepared.work_dir;
            await sendEvent("workspace_ready", { project_id: projectId, local_project_alias: localAlias, reused: prepared.reused });
          }
        }
        if (!staleAuthority && !cancelRequested && !lockWaitExpired) outcome = await harnessFn(run, { isCanceled: () => staleAuthority ? "stale-authority" : cancelRequested ? "canceled" : false, workDir });
      } catch (error) {
        harnessError = truncate(error?.message || String(error), 4000);
      } finally {
        await beat.stop();
        if (runLock) runLock.release();
      }
    }

    if (staleAuthority || outcome?.cancellation_reason === "stale-authority") {
      log(`[worker] run ${runId} stopped after stale claim authority`);
      return { run_id: runId, status: "stale-authority" };
    }

    if (lockWaitExpired) {
      log(`[worker] run ${runId} lock wait expired; leaving lease expiry/requeue authoritative`);
      return { run_id: runId, status: "lock-wait-expired" };
    }

    if (outcome && !cancelRequested) {
      await sendEvent("stdout", { text: truncate(outcome.stdout_tail || "", 16_000) });
    }

    if (staleAuthority) {
      log(`[worker] run ${runId} lost claim authority before terminal reporting`);
      return { run_id: runId, status: "stale-authority" };
    }

    if (cancelRequested) {
      await sendEvent("cancellation_observed", {});
      if (staleAuthority) return { run_id: runId, status: "stale-authority" };
      const result = await reportResult(runId, ids, { status: "canceled", error: "", retryable: false, exit_code: null });
      if (!result) return { run_id: runId, status: "stale-authority" };
      log(`[worker] run ${runId} canceled`);
      return { run_id: runId, status: "canceled" };
    }
    if (!outcome) {
      const result = await reportResult(runId, ids, { status: "failed", error: harnessError || "harness produced no result", retryable: false, exit_code: null });
      if (!result) return { run_id: runId, status: "stale-authority" };
      log(`[worker] run ${runId} failed locally`);
      return { run_id: runId, status: "failed", reason: harnessError };
    }
    const exitCode = outcome.exit_code == null || !Number.isFinite(Number(outcome.exit_code)) ? null : Number(outcome.exit_code);
    const terminalStatus = outcome.timed_out ? "timed-out" : exitCode === 0 ? "completed" : "failed";
    const result = await reportResult(runId, ids, {
      status: terminalStatus,
      error: terminalStatus === "failed" ? truncate(outcome.stderr_tail || `harness exited with ${exitCode == null ? "no exit code" : exitCode}`, 4000) : terminalStatus === "timed-out" ? "harness timed out" : "",
      exit_code: exitCode,
      signal: outcome.signal || "",
      output: truncate(outcome.output || "", 120_000),
      stdout_tail: truncate(outcome.stdout_tail || "", 16_000),
      stderr_tail: truncate(outcome.stderr_tail || "", 16_000),
    });
    if (!result) return { run_id: runId, status: "stale-authority" };
    log(`[worker] run ${runId} ${terminalStatus}`);
    return { run_id: runId, status: terminalStatus };
  }

  async function waitForRunLock(identity, isStopped) {
    const deadline = Date.now() + lockWaitMs;
    let attempt = 0;
    for (;;) {
      if (isStopped()) return null;
      try {
        return workspace.acquireRunLock(identity);
      } catch (error) {
        if (error?.code !== "run_locked") throw error;
      }
      if (Date.now() >= deadline) return null;
      attempt += 1;
      const delay = Math.min(lockRetryMs * (2 ** Math.min(attempt - 1, 4)), 250, Math.max(0, deadline - Date.now()));
      await sleep(delay);
    }
  }

  function startHeartbeat(runId, ids, observeCancel, observeAuthorityError) {
    let stopped = false;
    const pending = new Set();
    const tick = () => {
      if (stopped) return;
      const request = reportHeartbeat(runId, ids, { phase: "running", message: "harness in progress" })
        .then(observeCancel)
        .catch((error) => {
          if (!observeAuthorityError(error)) log(`[worker] heartbeat error ${error.code || error.message}`);
        })
        .finally(() => pending.delete(request));
      pending.add(request);
    };
    const interval = setInterval(tick, clamp(credentials.heartbeat_interval_ms, 100, 300_000, 15_000));
    return {
      async stop() {
        stopped = true;
        clearInterval(interval);
        await Promise.allSettled([...pending]);
      },
    };
  }

  function reportHeartbeat(runId, ids, progress) {
    return requestWithRetry("POST", `/v1/agent/runs/${runId}/heartbeat`, { ...ids, status: "running", progress, observed_at: new Date().toISOString() });
  }

  function reportEvents(runId, ids, events) {
    return requestWithRetry("POST", `/v1/agent/runs/${runId}/events`, { ...ids, events: events.map((event) => ({ ...event, observed_at: new Date().toISOString() })) });
  }

  async function reportResult(runId, ids, body) {
    try {
      return await requestWithRetry("POST", `/v1/agent/runs/${runId}/result`, { ...ids, ...body, finished_at: new Date().toISOString() });
    } catch (error) {
      if (error.status === 409) {
        log(`[worker] result for run ${runId} was stale; leaving gateway state untouched`);
        return null;
      }
      throw error;
    }
  }

  async function requestWithRetry(method, pathname, body, options) {
    let attempt = 0;
    for (;;) {
      try {
        return await request(method, pathname, body, options);
      } catch (error) {
        attempt += 1;
        if (attempt > maxRequestRetries || error.status === 401 || error.status === 403 || error.status === 409 || error.retryable === false) {
          throw error;
        }
        const delay = backoffDelayMs(idleDelayMs, attempt);
        log(`[worker] ${pathname} error ${error.code || error.message}; retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  async function request(method, pathname, body, { auth = true } = {}) {
    const headers = { "content-type": "application/json" };
    if (auth) headers.authorization = `Bearer ${credentials.token}`;
    let response;
    try {
      response = await fetchFn(`${gatewayUrl}${pathname}`, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      throw new WorkerRuntimeError("gateway_unreachable", `gateway request failed: ${truncate(error?.message || String(error), 300)}`, { retryable: true });
    }
    const text = await response.text();
    let parsed = {};
    try {
      parsed = text.trim() ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      const errorBody = parsed?.error && typeof parsed.error === "object" ? parsed.error : {};
      throw new WorkerRuntimeError(errorBody.code || `http_${response.status}`, errorBody.message || `gateway returned ${response.status}`, {
        status: response.status,
        retryable: errorBody.retryable === true || response.status === 429 || response.status === 503,
      });
    }
    return parsed;
  }

  return { runLoop, ensureCredentials, harnessIds: () => Object.keys(harnesses) };
}

function onlyAliasDerivedProjects(projectAliases, projects) {
  if (!projectAliases.length || projectAliases.length !== projects.length) return false;
  return projects.every((item) => projectAliases.includes(item.id) && item.id === item.local_alias);
}

function forbiddenClaimKeys(value, found = new Set()) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    for (const item of value) forbiddenClaimKeys(item, found);
    return [...found].sort();
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = String(key || "").toLowerCase();
    if (FORBIDDEN_CLAIM_KEYS.has(normalized)) found.add(normalized);
    forbiddenClaimKeys(item, found);
  }
  return [...found].sort();
}

function backoffDelayMs(baseMs, attempt) {
  const exponent = Math.min(Number(attempt) || 1, 6);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseMs / 3)));
  return clamp((baseMs * (2 ** (exponent - 1))) + jitter, baseMs, 60_000, baseMs);
}

function readState(stateFile) {
  if (!stateFile) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(stateFile, value) {
  if (!stateFile) return;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function normalizeGatewayUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return ["http:", "https:"].includes(parsed.protocol) ? raw : "";
  } catch {
    return "";
  }
}

function listOf(value) {
  if (Array.isArray(value)) return value;
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function sanitizeId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
}

function sanitizeAlias(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, "-").slice(0, 120);
}

function exactClaimId(value, label) {
  const text = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(text)) throw new WorkerRuntimeError("unsafe_claim", `${label} is invalid`);
  return text;
}

function exactClaimAlias(value, label) {
  const text = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9_.:-]{0,119}$/.test(text)) throw new WorkerRuntimeError("unsafe_claim", `${label} is invalid`);
  return text;
}

function normalizeCapability(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, "-").slice(0, 80);
}

function normalizeCapabilities(value) {
  return [...new Set(listOf(value).map(normalizeCapability).filter(Boolean))].slice(0, 50);
}

function defaultPlatform() {
  const osName = process.platform === "darwin" ? "macos" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${osName}-${arch}`;
}

function machineIdentifier(value, label) {
  const explicit = String(value || "").trim();
  if (explicit) return exactClaimId(explicit, "machine id");
  return `machine_${crypto.createHash("sha256").update(`${process.platform}:${process.arch}:${os.hostname()}:${label || "default"}`).digest("hex").slice(0, 20)}`;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function appendHead(current, chunk, max) {
  if (current.length >= max) return current;
  return `${current}${String(chunk)}`.slice(0, max);
}

function appendBoundedTail(current, chunk, max) {
  const next = `${current}${String(chunk)}`;
  return next.length > max ? next.slice(next.length - max) : next;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { WorkerRuntimeError, createWorkerRuntime, echoHarness, detectHarnesses, cliHarness, forbiddenClaimKeys };
