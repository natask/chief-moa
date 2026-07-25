"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SCHEMA = "moa.codex-intent-launcher.v1";
const VERSION = "0.2.0";
const TERMINAL = new Set(["completed", "failed", "cancelled", "blocked"]);
const AGENT_STATUSES = new Set(["running", "blocked", "completed", "failed", "cancelled"]);

function clean(value, max = 2_000) {
  const result = String(value || "").trim();
  if (result.length > max) throw new Error(`value exceeds ${max} characters`);
  return result;
}

function required(value, label, max = 2_000) {
  const result = clean(value, max);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function stableId(prefix, ...parts) {
  const digest = crypto.createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32);
  return `${prefix}_${digest}`;
}

function makeRunId(agentId) {
  return `run_codex_${crypto.randomUUID().replaceAll("-", "")}_${stableId("", agentId, Date.now()).slice(1, 9)}`;
}

function defaultStateDir(env = process.env) {
  return path.resolve(env.MOA_CODEX_INTENT_STATE_DIR
    || path.join(os.homedir(), ".local", "state", "chief-moa", "codex-intent-launcher"));
}

function ensurePrivateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Some mounted filesystems do not support chmod. The caller still gets a
    // private-by-default create mode.
  }
}

function writeJsonAtomic(file, value) {
  ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // See ensurePrivateDir.
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function stateFile(stateDir, runId) {
  return path.join(stateDir, "runs", `${runId}.json`);
}

function artifactDir(stateDir, runId) {
  return path.join(stateDir, "artifacts", runId);
}

function validateGatewayUrl(raw) {
  const parsed = new URL(required(raw, "gateway URL", 1_000));
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("gateway URL must use http or https");
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (parsed.protocol !== "https:" && !loopback) {
    throw new Error("gateway URL must use https except for a loopback development endpoint");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

class IntentPlaneClient {
  constructor({ gatewayUrl, token, fetchImpl = globalThis.fetch }) {
    this.gatewayUrl = validateGatewayUrl(gatewayUrl);
    this.token = required(token, "gateway token", 20_000);
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable; Node 20+ is required");
    this.fetchImpl = fetchImpl;
  }

  async request(method, route, body) {
    const response = await this.fetchImpl(`${this.gatewayUrl}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`intent plane returned non-JSON (${response.status})`);
    }
    if (!response.ok) {
      const error = new Error(`intent plane ${method} ${route} failed (${response.status}): ${clean(json.error || text, 600)}`);
      error.status = response.status;
      throw error;
    }
    return json;
  }

  createIntent(state) {
    return this.request("POST", "/v1/intent-plane/intents", {
      intent_id: state.intent_id,
      title: state.title,
      objective: state.objective,
      status: "active",
      source: {
        kind: "codex_launcher_adapter",
        namespace: state.namespace,
        project: state.project,
      },
      provenance: {
        adapter: "chief-moa-codex-intent-launcher",
        adapter_version: VERSION,
        launch_key: state.intent_key,
      },
      tenant_id: state.tenant_id,
      namespace_id: state.namespace,
      sphere: state.sphere,
      project_id: state.project,
      sensitivity: state.sensitivity,
      next_action: "Launch the registered Codex owner.",
      user_confirmed: true,
      idempotency_key: `codex-adapter:intent:${state.intent_id}`,
    });
  }

  registerAgent(state) {
    return this.request("POST", `/v1/intent-plane/intents/${encodeURIComponent(state.intent_id)}/agents`, {
      agent_id: state.agent_id,
      launch_reason: state.launch_reason,
      launcher_provenance: {
        adapter: "chief-moa-codex-intent-launcher",
        adapter_version: VERSION,
        namespace: state.namespace,
        project: state.project,
        launcher_agent_id: state.launcher_agent_id,
      },
      capabilities: state.capabilities,
      authority_summary: state.authority_summary,
      current_run_id: "",
      latest_recap: "",
      registration_mode: "launcher_adapter",
      runtime_type: "codex_exec",
      execution_location: "local",
      endpoint_ref: `local-agent:${state.agent_id}`,
      parent_agent_id: state.launcher_agent_id,
      recovery_policy: "pid_and_terminal_receipt_reconcile",
      idempotency_key: `codex-adapter:agent:${state.agent_id}`,
    });
  }

  progressAgent(state, status, progress, { recap = "", artifactRefs = [], idempotencyKey = "" } = {}) {
    return this.request("POST", `/v1/intent-plane/agents/${encodeURIComponent(state.agent_id)}/progress`, {
      status,
      progress: clean(progress),
      current_run_id: state.adapter_run_id,
      latest_recap: clean(recap),
      artifact_refs: artifactRefs.slice(0, 40),
      idempotency_key: idempotencyKey || `codex-adapter:progress:${state.adapter_run_id}:${state.remote_sequence}:${status}`,
    });
  }

  startAgentRun(state, { reopenIntent = false, idempotencyKey = "" } = {}) {
    return this.request("POST", `/v1/intent-plane/agents/${encodeURIComponent(state.agent_id)}/runs`, {
      current_run_id: state.adapter_run_id,
      reopen_intent: reopenIntent,
      progress: "Codex owner process is starting.",
      latest_recap: "",
      artifact_refs: state.artifact_refs,
      idempotency_key: idempotencyKey || `codex-adapter:start:${state.adapter_run_id}`,
    });
  }

  heartbeatAgent(state, progress, { recap = "", artifactRefs = [] } = {}) {
    return this.request("POST", `/v1/intent-plane/agents/${encodeURIComponent(state.agent_id)}/heartbeat`, {
      progress: clean(progress),
      current_run_id: state.adapter_run_id,
      latest_recap: clean(recap),
      artifact_refs: artifactRefs.slice(0, 40),
      idempotency_key: `codex-adapter:heartbeat:${state.adapter_run_id}:${state.heartbeat_sequence}`,
    });
  }

  updateIntent(state, status, nextAction, artifactRefs = [], { idempotencyKey = "" } = {}) {
    return this.request("PATCH", `/v1/intent-plane/intents/${encodeURIComponent(state.intent_id)}`, {
      status,
      owner_agent_id: state.agent_id,
      next_action: clean(nextAction),
      artifact_refs: artifactRefs.slice(0, 40),
      current_run_id: state.adapter_run_id,
      idempotency_key: idempotencyKey || `codex-adapter:intent:${state.adapter_run_id}:${state.remote_sequence}:${status}`,
    });
  }

  projection() {
    return this.request("GET", "/v1/intent-plane?limit=500");
  }
}

function buildIdentity(input) {
  const namespace = required(input.namespace, "namespace", 160);
  const project = required(input.project, "project", 240);
  const intentKey = required(input.intentKey, "intent key", 240);
  const agentKey = required(input.agentKey, "agent key", 240);
  const intentId = stableId("intent_codex", namespace, project, intentKey);
  const agentId = stableId("agent_codex", namespace, project, intentKey, agentKey);
  return { namespace, project, intentKey, agentKey, intentId, agentId };
}

function publicState(state) {
  return {
    schema: state.schema,
    adapter_run_id: state.adapter_run_id,
    intent_id: state.intent_id,
    agent_id: state.agent_id,
    namespace: state.namespace,
    project: state.project,
    title: state.title,
    status: state.status,
    pid: state.pid || null,
    created_at: state.created_at,
    updated_at: state.updated_at,
    started_at: state.started_at || "",
    finished_at: state.finished_at || "",
    progress: state.progress || "",
    latest_recap: state.latest_recap || "",
    artifact_refs: state.artifact_refs || [],
    remote_pending: Boolean(state.remote_pending),
    terminal_reason: state.terminal_reason || "",
    command: state.command,
  };
}

function processAlive(pid) {
  return processSnapshot(pid).alive;
}

function processSnapshot(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { alive: false, identity: "" };
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return { alive: false, identity: "" };
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(/\s+/);
    if (fields[0] === "Z") return { alive: false, identity: `linux:${fields[19] || ""}` };
    return { alive: true, identity: `linux:${required(fields[19], "process start identity", 120)}` };
  } catch {
    try {
      const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "ppid=", "-o", "comm="], {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return started ? { alive: true, identity: `ps:${started.replace(/\s+/g, " ")}` } : { alive: false, identity: "" };
    } catch {
      return { alive: false, identity: "" };
    }
  }
}

function processMatches(pid, expectedIdentity) {
  const expected = clean(expectedIdentity, 240);
  if (!expected) return false;
  const snapshot = processSnapshot(pid);
  return snapshot.alive && snapshot.identity === expected;
}

function listStateFiles(stateDir) {
  const directory = path.join(stateDir, "runs");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(directory, name))
    .sort();
}

function terminalMapping(status) {
  if (status === "completed") return { agent: "completed", intent: "completed" };
  if (status === "cancelled") return { agent: "cancelled", intent: "needs_user" };
  if (status === "blocked") return { agent: "blocked", intent: "needs_user" };
  return { agent: "failed", intent: "needs_user" };
}

async function syncProgress(client, state, status, progress, options = {}) {
  validateAgentStatus(status);
  state.remote_sequence = Number(state.remote_sequence || 0) + 1;
  await client.progressAgent(state, status, progress, options);
  state.remote_pending = false;
}

function validateAgentStatus(status) {
  const result = required(status, "status", 40);
  if (!AGENT_STATUSES.has(result)) throw new Error(`unsupported adapter status: ${result}`);
  return result;
}

function prepareTerminalSync(state) {
  if (state.terminal_sync) return state.terminal_sync;
  const mapping = terminalMapping(state.status);
  const next = state.status === "completed"
    ? state.latest_recap || "The Codex owner completed its bounded task."
    : state.terminal_reason || state.progress || "The Codex owner needs attention.";
  state.terminal_sync = {
    schema: SCHEMA,
    run_id: state.adapter_run_id,
    status: state.status,
    agent: {
      done: false,
      status: mapping.agent,
      progress: state.progress || state.terminal_reason || state.status,
      recap: state.latest_recap || "",
      artifact_refs: [...(state.artifact_refs || [])],
      idempotency_key: `codex-adapter:terminal-agent:${state.adapter_run_id}:${mapping.agent}`,
    },
    intent: {
      done: false,
      status: mapping.intent,
      next_action: next,
      artifact_refs: [...(state.artifact_refs || [])],
      idempotency_key: `codex-adapter:terminal-intent:${state.adapter_run_id}:${mapping.intent}`,
    },
  };
  return state.terminal_sync;
}

async function syncTerminal(client, state, { persist = () => {} } = {}) {
  const checkpoint = prepareTerminalSync(state);
  persist(state);
  if (!checkpoint.agent.done) {
    await client.progressAgent(state, checkpoint.agent.status, checkpoint.agent.progress, {
      recap: checkpoint.agent.recap,
      artifactRefs: checkpoint.agent.artifact_refs,
      idempotencyKey: checkpoint.agent.idempotency_key,
    });
    checkpoint.agent.done = true;
    persist(state);
  }
  if (!checkpoint.intent.done) {
    await client.updateIntent(
      state,
      checkpoint.intent.status,
      checkpoint.intent.next_action,
      checkpoint.intent.artifact_refs,
      { idempotencyKey: checkpoint.intent.idempotency_key },
    );
    checkpoint.intent.done = true;
    persist(state);
  }
  state.remote_pending = false;
}

module.exports = {
  AGENT_STATUSES,
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
  processMatches,
  processSnapshot,
  prepareTerminalSync,
  publicState,
  readJson,
  required,
  stableId,
  stateFile,
  syncProgress,
  syncTerminal,
  validateAgentStatus,
  validateGatewayUrl,
  writeJsonAtomic,
};
