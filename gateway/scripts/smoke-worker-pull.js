#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "worker-pull-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-worker-pull-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  try {
    server = await startGateway({ port, dataDir });
    await step("worker owner endpoints require auth", () => assertAuthRequired(baseUrl));
    const runId = await step("queue worker-pull run", () => queueRun(baseUrl));
    const registration = await step("create registration", () => createRegistration(baseUrl));
    const worker = await step("register worker once", () => registerWorker(baseUrl, registration));
    await step("plaintext worker token not stored", () => assertTokenHashesOnly(dataDir, registration.setup_code, worker.worker_token));
    const claim = await step("claim queued run", () => claimRun(baseUrl, worker.worker_id, worker.worker_token, runId));
    await step("heartbeat event and result", () => completeClaim(baseUrl, worker, claim));
    await step("terminal run cannot be claimed or overwritten", () => assertTerminalRunStable(baseUrl, worker, claim.claim.run_id));
    await step("run detail has worker lifecycle and linkage", () => assertRunDetail(baseUrl, claim.claim.run_id));

    console.log(JSON.stringify({
      ok: true,
      run_id: claim.claim.run_id,
      worker_id: worker.worker_id,
      checks: [
        "owner worker registration requires gateway token",
        "setup code is one-use",
        "worker token plaintext is returned once and hashes only are stored",
        "long-poll claim returns one queued run with linkage",
        "claim payload excludes command, args, shell, env, and absolute working_dir",
        "heartbeat, stdout event, and completed result update the existing run",
        "completed run cannot be claimed again or overwritten",
        "no active deployment was applied",
      ],
    }, null, 2));
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function assertAuthRequired(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/agent/workers/registrations`, { name: "No token" }, { auth: false });
  assert.equal(response.status, 401);
}

async function queueRun(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/agent/runs`, {
    prompt: "worker pull smoke",
    harness: "echo",
    wait: false,
    source: "worker-pull-smoke",
    conversation_id: "sess_worker_pull",
    branch_id: "branch_worker_pull",
    turn_id: "turn_worker_pull",
    broker_event_id: "bev_worker_pull",
    route_decision_id: "route_worker_pull",
    project_id: "proj_chief_moa",
    local_project_alias: "chief-moa",
    work_node_id: "wg_worker_pull",
    context_pack_ref: "broker-context-packs/pack_worker_pull.json",
    artifacts: {
      input_refs: [{ artifact_id: "art_input", kind: "context_pack", uri: "broker-context-packs/pack_worker_pull.json", sha256: "a".repeat(64) }],
    },
    deployments: {
      candidate_refs: [],
    },
  });
  assert.equal(response.status, 202, JSON.stringify(response.json));
  assert.equal(response.json.worker_pull.queued, true);
  assert.equal(response.json.run.status, "queued");
  return response.json.run.id;
}

async function createRegistration(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/agent/workers/registrations`, {
    name: "Worker smoke machine",
    harness_allowlist: ["echo"],
    project_allowlist: ["proj_chief_moa"],
    max_parallel_claims: 1,
    expires_in_seconds: 600,
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  assert.match(response.json.setup_code, /^MOA-WORKER-/);
  return response.json;
}

async function registerWorker(baseUrl, registration) {
  const first = await requestJson(`${baseUrl}/v1/agent/workers/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      registration_id: registration.registration_id,
      setup_code: registration.setup_code,
      worker: {
        name: "Worker smoke machine",
        version: "moa-worker/0.1.0",
        machine_label: "smoke-local",
        capabilities: {
          transports: ["long_poll"],
          harnesses: [{ id: "echo", version: "builtin", supports_resume: false }],
          projects: [{ id: "proj_chief_moa", local_alias: "chief-moa", path_policy: "local_allowlist" }],
        },
      },
    }),
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.match(first.json.worker_token, /^moa_wkt_/);

  const second = await requestJson(`${baseUrl}/v1/agent/workers/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ registration_id: registration.registration_id, setup_code: registration.setup_code, worker: { name: "second" } }),
  });
  assert.equal(second.status, 409, JSON.stringify(second.json));
  assert.equal(second.json.error.code, "registration_used");
  return first.json;
}

async function assertTokenHashesOnly(dataDir, setupCode, workerToken) {
  const registrations = fs.readFileSync(path.join(dataDir, "worker-registrations.json"), "utf8");
  const workers = fs.readFileSync(path.join(dataDir, "workers.json"), "utf8");
  assert.ok(!registrations.includes(setupCode), "setup code plaintext must not be stored");
  assert.ok(!workers.includes(workerToken), "worker token plaintext must not be stored");
  assert.match(workers, /token_hash/);
}

async function claimRun(baseUrl, workerId, workerToken, runId) {
  const response = await workerPost(`${baseUrl}/v1/agent/workers/claim`, workerToken, {
    worker_id: workerId,
    transport: "long_poll",
    wait_ms: 100,
    max_claims: 1,
    accepted_harnesses: ["echo"],
    accepted_projects: ["proj_chief_moa"],
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.json.claimed, true);
  assert.equal(response.json.claim.run_id, runId);
  assert.equal(response.json.run.harness, "echo");
  assert.equal(response.json.run.session.session_id, "sess_worker_pull");
  assert.equal(response.json.run.session.branch_id, "branch_worker_pull");
  assert.equal(response.json.run.work.context_pack_ref, "broker-context-packs/pack_worker_pull.json");
  assert.deepEqual(response.json.run.deployments.candidate_refs, []);
  assert.equal(response.json.run.deployments.apply_allowed, false);
  const serialized = JSON.stringify(response.json.run);
  for (const forbidden of ["command", "args", "shell", "env"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(response.json.run, forbidden), false, `claim run must not expose ${forbidden}`);
    assert.ok(!serialized.includes(`"${forbidden}"`), `claim payload must not contain ${forbidden}`);
  }
  assert.equal(typeof response.json.run.working_dir, "object");
  assert.equal(response.json.run.working_dir.local_alias, "chief-moa");
  assert.ok(!JSON.stringify(response.json.run.working_dir).includes(GATEWAY_DIR), "claim working_dir must not expose an absolute path");
  return response.json;
}

async function completeClaim(baseUrl, worker, claim) {
  const runId = claim.claim.run_id;
  const common = { worker_id: worker.worker_id, claim_id: claim.claim.claim_id };
  const heartbeat = await workerPost(`${baseUrl}/v1/agent/runs/${runId}/heartbeat`, worker.worker_token, {
    ...common,
    status: "running",
    progress: { phase: "smoke", message: "running worker smoke", percent: null },
    last_event_seq: 0,
  });
  assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.json));
  assert.equal(heartbeat.json.cancel_requested, false);

  const events = await workerPost(`${baseUrl}/v1/agent/runs/${runId}/events`, worker.worker_token, {
    ...common,
    events: [
      { seq: 1, event_id: "wevt_started", type: "started", data: { harness: "echo", local_project_alias: "chief-moa" } },
      { seq: 2, event_id: "wevt_stdout", type: "stdout", data: { text: "worker smoke complete\n" } },
    ],
  });
  assert.equal(events.status, 200, JSON.stringify(events.json));
  assert.equal(events.json.accepted, 2);

  const duplicate = await workerPost(`${baseUrl}/v1/agent/runs/${runId}/events`, worker.worker_token, {
    ...common,
    events: [{ seq: 2, event_id: "wevt_stdout", type: "stdout", data: { text: "duplicate\n" } }],
  });
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.json));
  assert.equal(duplicate.json.duplicate, 1);

  const result = await workerPost(`${baseUrl}/v1/agent/runs/${runId}/result`, worker.worker_token, {
    ...common,
    status: "completed",
    exit_code: 0,
    output: "Worker smoke complete.",
    stdout_tail: "Worker smoke complete.\n",
    stderr_tail: "",
    artifacts: [{ artifact_id: "art_summary", kind: "work_summary", uri: "agent-runs/summary.md", sha256: "b".repeat(64) }],
    deployments: [{ candidate_id: "dep_preview", target: "gateway-preview", preview_url: "https://preview.example.com", applied: false, apply_allowed: false }],
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.run.status, "completed");
}

async function assertTerminalRunStable(baseUrl, worker, runId) {
  const emptyClaim = await workerPost(`${baseUrl}/v1/agent/workers/claim`, worker.worker_token, {
    worker_id: worker.worker_id,
    transport: "long_poll",
    accepted_harnesses: ["echo"],
    accepted_projects: ["proj_chief_moa"],
  });
  assert.equal(emptyClaim.status, 200, JSON.stringify(emptyClaim.json));
  assert.equal(emptyClaim.json.claimed, false);

  const detail = await getJson(`${baseUrl}/v1/agent/runs/${runId}`);
  const overwrite = await workerPost(`${baseUrl}/v1/agent/runs/${runId}/result`, worker.worker_token, {
    worker_id: worker.worker_id,
    claim_id: detail.run.claim_id,
    status: "failed",
    error: "should not overwrite",
  });
  assert.equal(overwrite.status, 409, JSON.stringify(overwrite.json));
  const after = await getJson(`${baseUrl}/v1/agent/runs/${runId}`);
  assert.equal(after.run.status, "completed");
  assert.ok(!String(after.run.error || "").includes("should not overwrite"));
}

async function assertRunDetail(baseUrl, runId) {
  const detail = await getJson(`${baseUrl}/v1/agent/runs/${runId}`);
  assert.equal(detail.run.status, "completed");
  assert.equal(detail.run.conversation_id, "sess_worker_pull");
  assert.equal(detail.run.branch_id, "branch_worker_pull");
  assert.equal(detail.run.work_node_id, "wg_worker_pull");
  assert.equal(detail.run.context_pack_ref, "broker-context-packs/pack_worker_pull.json");
  assert.deepEqual(detail.run.deployment_candidate_refs?.map((item) => item.apply_allowed), [false]);
  const types = detail.events.map((event) => event.type);
  for (const type of ["queued", "claimed", "heartbeat", "started", "stdout", "completed"]) {
    assert.ok(types.includes(type), `missing event ${type}`);
  }
}

async function startGateway({ port, dataDir }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
      MOA_MODE: "local",
      MOA_WORKER_PULL: "1",
      MOA_GATEWAY_TOKEN: TOKEN,
      DEFAULT_AGENT_HARNESS: "echo",
      ROUTER_DEFAULT_HARNESS: "echo",
      MODEL_PROVIDER: "openai-compatible",
      MODEL_API_KEY: "",
      VOICE_PROVIDER: "loopback",
      VOICE_STT_PROVIDER: "loopback",
      VOICE_LLM_PROVIDER: "loopback",
      VOICE_TTS_PROVIDER: "loopback",
      HARNESS_STATUS_TIMEOUT_MS: "200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

async function postJson(url, body, options = {}) {
  return requestJson(url, {
    method: "POST",
    headers: { ...(options.auth === false ? {} : authHeaders()), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function workerPost(url, token, body) {
  return requestJson(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(url) {
  const response = await requestJson(url, { headers: authHeaders() });
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { status: response.status, json: text.trim() ? JSON.parse(text) : {} };
}

function authHeaders() {
  return { authorization: `Bearer ${TOKEN}` };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (logs.exited) throw new Error(`gateway exited before health\n${logs.text()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for health\n${logs.text()}`);
}

function collectLogs(child) {
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));
  const logs = { exited: false, text: () => chunks.join("") };
  child.on("exit", () => { logs.exited = true; });
  return logs;
}

function onceExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode != null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(child.exitCode ?? -1);
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
