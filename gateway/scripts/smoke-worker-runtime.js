#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const OWNER_TOKEN = "worker-runtime-smoke-owner-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-worker-runtime-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freeNonDefaultPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  try {
    server = await startGateway({ port, dataDir });
    const registration = await step("create worker setup code", () => createRegistration(baseUrl));
    const worker = await step("register worker with setup code", () => registerWorker(baseUrl, registration));
    const runId = await step("queue echo run", () => queueEchoRun(baseUrl));
    const runtime = await step("run worker runtime", () => runWorkerRuntime({ baseUrl, worker }));
    await step("runtime processed one run", () => assertRuntimeSummary(runtime, worker.worker_token));
    const detail = await step("read completed lifecycle", () => readCompletedRun(baseUrl, runId));

    console.log(JSON.stringify({
      ok: true,
      run_id: runId,
      worker_id: worker.worker_id,
      lifecycle: detail.events.map((event) => event.type),
      checks: [
        "gateway used an ephemeral non-8787 localhost port",
        "worker registered through one-use setup code",
        "runtime authenticated with scoped worker bearer token",
        "runtime claimed one echo run over outbound long-poll",
        "runtime sent heartbeat, started, stdout, and completed lifecycle records",
        "owner readback saw completed run state",
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

async function createRegistration(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/agent/workers/registrations`, {
    name: "Worker runtime smoke",
    harness_allowlist: ["echo"],
    project_allowlist: ["proj_chief_moa"],
    max_parallel_claims: 1,
    expires_in_seconds: 600,
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  assert.match(response.json.registration_id, /^wreg_/);
  assert.match(response.json.setup_code, /^MOA-WORKER-/);
  return response.json;
}

async function registerWorker(baseUrl, registration) {
  const response = await requestJson(`${baseUrl}/v1/agent/workers/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      registration_id: registration.registration_id,
      setup_code: registration.setup_code,
      worker: {
        name: "Worker runtime smoke",
        version: "moa-worker/0.1.0",
        machine_label: "runtime-smoke-local",
        capabilities: {
          transports: ["long_poll"],
          harnesses: [{ id: "echo", version: "builtin", supports_resume: false }],
          projects: [{ id: "proj_chief_moa", local_alias: "chief-moa", path_policy: "local_allowlist" }],
        },
      },
    }),
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  assert.match(response.json.worker_id, /^wrk_/);
  assert.match(response.json.worker_token, /^moa_wkt_/);

  const reused = await requestJson(`${baseUrl}/v1/agent/workers/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      registration_id: registration.registration_id,
      setup_code: registration.setup_code,
      worker: { name: "Worker runtime smoke duplicate" },
    }),
  });
  assert.equal(reused.status, 409, JSON.stringify(reused.json));
  assert.equal(reused.json.error.code, "registration_used");
  return response.json;
}

async function queueEchoRun(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/agent/runs`, {
    prompt: "worker runtime smoke complete",
    harness: "echo",
    wait: false,
    source: "worker-runtime-smoke",
    conversation_id: "sess_worker_runtime",
    branch_id: "branch_worker_runtime",
    turn_id: "turn_worker_runtime",
    broker_event_id: "bev_worker_runtime",
    route_decision_id: "route_worker_runtime",
    project_id: "proj_chief_moa",
    local_project_alias: "chief-moa",
    work_node_id: "wg_worker_runtime",
    context_pack_ref: "broker-context-packs/pack_worker_runtime.json",
    artifacts: {
      input_refs: [{
        artifact_id: "art_worker_runtime_input",
        kind: "context_pack",
        uri: "broker-context-packs/pack_worker_runtime.json",
        sha256: "c".repeat(64),
      }],
    },
    deployments: { candidate_refs: [] },
  });
  assert.equal(response.status, 202, JSON.stringify(response.json));
  assert.equal(response.json.worker_pull.queued, true);
  assert.equal(response.json.run.status, "queued");
  return response.json.run.id;
}

async function runWorkerRuntime({ baseUrl, worker }) {
  const child = spawn(process.execPath, [
    "scripts/worker-runtime.js",
    "--once",
    "--claim-wait-ms",
    "1000",
    "--request-timeout-ms",
    "5000",
    "--project",
    "proj_chief_moa:chief-moa",
  ], {
    cwd: GATEWAY_DIR,
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      MOA_WORKER_GATEWAY_URL: baseUrl,
      MOA_WORKER_ID: worker.worker_id,
      MOA_WORKER_TOKEN: worker.worker_token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(child);
  const code = await onceExit(child, 10_000);
  assert.equal(code, 0, logs.text());
  return logs.text();
}

function assertRuntimeSummary(output, workerToken) {
  assert.ok(!output.includes(workerToken), "runtime output must not print worker token");
  const lines = output.trim().split("\n").filter(Boolean);
  const summary = JSON.parse(lines[lines.length - 1]);
  assert.equal(summary.ok, true);
  assert.equal(summary.idle, false);
  assert.equal(summary.processed.length, 1);
  assert.equal(summary.processed[0].status, "completed");
}

async function readCompletedRun(baseUrl, runId) {
  const detail = await getJson(`${baseUrl}/v1/agent/runs/${runId}`);
  assert.equal(detail.run.status, "completed");
  assert.equal(detail.run.conversation_id, "sess_worker_runtime");
  assert.equal(detail.run.branch_id, "branch_worker_runtime");
  assert.equal(detail.run.work_node_id, "wg_worker_runtime");
  assert.equal(detail.run.context_pack_ref, "broker-context-packs/pack_worker_runtime.json");
  assert.equal(detail.run.claimed_by_worker_id.startsWith("wrk_"), true);
  assert.match(detail.run.output, /worker runtime smoke complete/);
  const types = detail.events.map((event) => event.type);
  for (const type of ["queued", "claimed", "heartbeat", "started", "stdout", "completed"]) {
    assert.ok(types.includes(type), `missing event ${type}`);
  }
  const stdout = detail.events.find((event) => event.type === "stdout");
  assert.match(stdout?.data?.text || "", /worker runtime smoke complete/);
  return detail;
}

async function startGateway({ port, dataDir }) {
  assert.notEqual(port, 8787, "worker runtime smoke must not bind the default gateway port");
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
      MOA_GATEWAY_TOKEN: OWNER_TOKEN,
      DEFAULT_AGENT_HARNESS: "echo",
      ROUTER_DEFAULT_HARNESS: "echo",
      MODEL_PROVIDER: "openai-compatible",
      MODEL_API_KEY: "",
      VOICE_PROVIDER: "loopback",
      VOICE_STT_PROVIDER: "loopback",
      VOICE_LLM_PROVIDER: "loopback",
      VOICE_TTS_PROVIDER: "loopback",
      HARNESS_STATUS_TIMEOUT_MS: "200",
      WORKER_HEARTBEAT_INTERVAL_MS: "1000",
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

async function postJson(url, body) {
  return requestJson(url, {
    method: "POST",
    headers: { authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(url) {
  const response = await requestJson(url, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { status: response.status, json: text.trim() ? JSON.parse(text) : {} };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (logs.exited) throw new Error(`gateway exited before health\n${logs.text()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
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

async function freeNonDefaultPort() {
  for (;;) {
    const port = await freePort();
    if (port !== 8787) return port;
  }
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
