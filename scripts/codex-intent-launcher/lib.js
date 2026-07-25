"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCHEMA = "moa.codex-intent-launcher.v1";
const VERSION = "0.1.0";
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

  progressAgent(state, status, progress, { recap = "", artifactRefs = [] } = {}) {
    return this.request("POST", `/v1/intent-plane/agents/${encodeURIComponent(state.agent_id)}/progress`, {
      status,
      progress: clean(progress),
      current_run_id: state.adapter_run_id,
      latest_recap: clean(recap),
      artifact_refs: artifactRefs.slice(0, 40),
      idempotency_key: `codex-adapter:progress:${state.adapter_run_id}:${state.remote_sequence}:${status}`,
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

  updateIntent(state, status, nextAction, artifactRefs = []) {
    return this.request("PATCH", `/v1/intent-plane/intents/${encodeURIComponent(state.intent_id)}`, {
      status,
      owner_agent_id: state.agent_id,
      next_action: clean(nextAction),
      artifact_refs: artifactRefs.slice(0, 40),
      idempotency_key: `codex-adapter:intent:${state.adapter_run_id}:${state.remote_sequence}:${status}`,
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
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
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
  if (!AGENT_STATUSES.has(status)) throw new Error(`unsupported adapter status: ${status}`);
  state.remote_sequence = Number(state.remote_sequence || 0) + 1;
  await client.progressAgent(state, status, progress, options);
  state.remote_pending = false;
}

async function syncTerminal(client, state) {
  const mapping = terminalMapping(state.status);
  await syncProgress(client, state, mapping.agent, state.progress || state.terminal_reason || state.status, {
    recap: state.latest_recap,
    artifactRefs: state.artifact_refs,
  });
  state.remote_sequence += 1;
  const next = state.status === "completed"
    ? state.latest_recap || "The Codex owner completed its bounded task."
    : state.terminal_reason || state.progress || "The Codex owner needs attention.";
  await client.updateIntent(state, mapping.intent, next, state.artifact_refs);
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
  publicState,
  readJson,
  required,
  stableId,
  stateFile,
  syncProgress,
  syncTerminal,
  validateGatewayUrl,
  writeJsonAtomic,
};
