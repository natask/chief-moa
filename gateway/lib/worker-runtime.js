"use strict";

// Local execution-machine worker runtime for the worker-pull contract.
// The worker connects outbound to the gateway, claims scoped runs, executes
// locally allowlisted harness profiles, and reports events plus a terminal
// result. It starts no listener and never accepts command/args/shell/env or
// absolute paths from the gateway.

const fs = require("node:fs");
const path = require("node:path");

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
const FORBIDDEN_CLAIM_KEYS = new Set(["command", "args", "shell", "env", "credentials", "credential"]);

function createWorkerRuntime(options = {}) {
  const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl);
  if (!gatewayUrl) throw new WorkerRuntimeError("invalid_config", "gatewayUrl is required (http or https)");
  const harnesses = DEFAULT_HARNESSES;
  const projectAliases = [...new Set(listOf(options.projectAliases).map(sanitizeAlias).filter(Boolean))];
  const configuredProjects = Array.isArray(options.projects)
    ? options.projects.map((item) => ({ id: sanitizeId(item?.id || ""), local_alias: sanitizeAlias(item?.local_alias || item?.localAlias || item?.id || "") })).filter((item) => item.id)
    : [];
  const projects = configuredProjects.length
    ? configuredProjects
    : projectAliases.map((aliasValue) => ({ id: aliasValue, local_alias: aliasValue }));
  const stateFile = options.stateFile ? path.resolve(String(options.stateFile)) : "";
  const name = truncate(options.name || "Moa worker", 120);
  const machineLabel = truncate(options.machineLabel || "", 120);
  const once = options.once === true;
  const maxIdleMs = clamp(options.maxIdleMs, 0, 24 * 3600_000, 0);
  const idleDelayMs = clamp(options.idleDelayMs, 100, 60_000, 1000);
  const claimWaitMs = clamp(options.claimWaitMs, 0, 55_000, 25_000);
  const requestTimeoutMs = clamp(options.requestTimeoutMs, 1000, 120_000, 30_000);
  const maxRequestRetries = clamp(options.maxRequestRetries, 0, 10, 3);
  const log = typeof options.log === "function" ? options.log : (line) => process.stdout.write(`${line}\n`);
  const fetchFn = typeof options.fetch === "function" ? options.fetch : fetch;

  let credentials = {
    worker_id: sanitizeId(options.workerId || ""),
    token: String(options.token || "").trim(),
    heartbeat_interval_ms: 15_000,
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
        capabilities: {
          transports: ["long_poll"],
          harnesses: Object.keys(harnesses).map((id) => ({ id, version: id === "echo" ? "builtin" : "local-profile", supports_resume: false })),
          projects: projects.map((item) => ({ ...item, path_policy: "local_allowlist" })),
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
    const runId = run.id;
    const localAlias = sanitizeAlias(run.working_dir?.local_alias || "");
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
    const aliasAllowed = !projectAliases.length || projectAliases.includes(localAlias);
    if (typeof harnessFn !== "function" || !aliasAllowed) {
      const reason = typeof harnessFn !== "function"
        ? `harness ${String(run.harness || "")} is not in the local allowlist`
        : `project alias ${localAlias} is not in the local allowlist`;
      await reportEvents(runId, ids, [{ seq: 1, event_id: `wevt_${runId}_local_rejection`, type: "local_rejection", data: { reason } }]);
      await reportResult(runId, ids, { status: "failed", error: reason, retryable: false, exit_code: null });
      log(`[worker] rejected run ${runId} locally: ${reason}`);
      return { run_id: runId, status: "failed", local_rejection: true, reason };
    }

    let cancelRequested = false;
    const observeCancel = (payload) => {
      if (payload?.cancel_requested === true) cancelRequested = true;
    };
    observeCancel(await reportHeartbeat(runId, ids, { phase: "start", message: `running ${run.harness}` }));

    let seq = 0;
    const sendEvent = async (type, data) => {
      seq += 1;
      const response = await reportEvents(runId, ids, [{ seq, event_id: `wevt_${runId}_${seq}`, type, data }]);
      observeCancel(response);
      return response;
    };

    await sendEvent("started", { harness: run.harness, local_project_alias: localAlias });

    let outcome = null;
    let harnessError = "";
    if (!cancelRequested) {
      const beat = startHeartbeat(runId, ids, observeCancel);
      try {
        outcome = await harnessFn(run, { isCanceled: () => cancelRequested });
      } catch (error) {
        harnessError = truncate(error?.message || String(error), 4000);
      } finally {
        beat.stop();
      }
    }

    if (outcome && !cancelRequested) {
      await sendEvent("stdout", { text: truncate(outcome.stdout_tail || "", 16_000) });
    }

    if (cancelRequested) {
      await sendEvent("cancellation_observed", {});
      await reportResult(runId, ids, { status: "canceled", error: "", retryable: false, exit_code: null });
      log(`[worker] run ${runId} canceled`);
      return { run_id: runId, status: "canceled" };
    }
    if (!outcome) {
      await reportResult(runId, ids, { status: "failed", error: harnessError || "harness produced no result", retryable: false, exit_code: null });
      log(`[worker] run ${runId} failed locally`);
      return { run_id: runId, status: "failed", reason: harnessError };
    }
    await reportResult(runId, ids, {
      status: "completed",
      exit_code: Number.isFinite(Number(outcome.exit_code)) ? Number(outcome.exit_code) : 0,
      output: truncate(outcome.output || "", 120_000),
      stdout_tail: truncate(outcome.stdout_tail || "", 16_000),
      stderr_tail: truncate(outcome.stderr_tail || "", 16_000),
    });
    log(`[worker] run ${runId} completed`);
    return { run_id: runId, status: "completed" };
  }

  function startHeartbeat(runId, ids, observeCancel) {
    const interval = setInterval(() => {
      reportHeartbeat(runId, ids, { phase: "running", message: "harness in progress" })
        .then(observeCancel)
        .catch((error) => log(`[worker] heartbeat error ${error.code || error.message}`));
    }, clamp(credentials.heartbeat_interval_ms, 1000, 300_000, 15_000));
    return { stop: () => clearInterval(interval) };
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

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { WorkerRuntimeError, createWorkerRuntime, echoHarness };
