#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "supervisor-smoke-token";
const EXPECT_POSTGRES = Boolean(process.env.DATABASE_URL);

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-supervisor-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startGateway({ port, dataDir });

    await step("auth required", () => assertAuthRequired(baseUrl));
    const launched = await step("create node and launch echo executor", () => assertLaunchNode(baseUrl));
    await step("node completes from run lifecycle", () => assertNodeCompletes(baseUrl, launched.node.id, launched.run.id));
    await step("events and artifacts are durable API records", () => assertEventsAndArtifacts(baseUrl, launched.node.id, launched.run.id));
    await step("supervisor status reports graph and runs", () => assertSupervisorStatus(baseUrl, launched.node.id, launched.run.id));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      checks: [
        "supervisor and work-node routes require the gateway token",
        "POST /v1/work/nodes launch=true creates a durable node and echo run",
        "executor completion updates node status from running to done",
        "workers can POST events/artifacts and reduce events into a merged_answer artifact",
        "GET /v1/supervisor/status reports the work graph and recent runs",
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

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

async function assertAuthRequired(baseUrl) {
  const status = await requestJson(`${baseUrl}/v1/supervisor/status`, { auth: false });
  assert.equal(status.status, 401, "supervisor status must require auth");
  const nodes = await requestJson(`${baseUrl}/v1/work/nodes`, { auth: false });
  assert.equal(nodes.status, 401, "work nodes must require auth");
}

async function assertLaunchNode(baseUrl) {
  const launched = await postJson(`${baseUrl}/v1/work/nodes`, {
    title: "Supervisor smoke node",
    intent: "Return exactly supervisor smoke ok.",
    launch: true,
    harness: "echo",
  });
  assert.equal(launched.status, 202, `launch must return 202: ${JSON.stringify(launched.json)}`);
  assert.ok(launched.json.node.id.startsWith("wg_"), "node id must start with wg_");
  assert.equal(launched.json.node.status, "running", "node starts running after launch");
  assert.equal(launched.json.node.executor.kind, "local", "node must bind a local executor");
  assert.ok(launched.json.run.id.startsWith("run_"), "launch must return a run id");
  return launched.json;
}

async function assertNodeCompletes(baseUrl, nodeId, runId) {
  const detail = await waitForRunTerminal(baseUrl, runId);
  assert.equal(detail.run.status, "completed", "echo run must complete");
  const node = await getJson(`${baseUrl}/v1/work/nodes/${nodeId}`);
  assert.equal(node.node.status, "done", "completed run must mark node done");
  assert.equal(node.run.id, runId, "node payload must include bound run summary");
}

async function assertSupervisorStatus(baseUrl, nodeId, runId) {
  const status = await getJson(`${baseUrl}/v1/supervisor/status`);
  assert.equal(status.frame, "node_based_execution_with_thin_supervisor");
  assert.equal(status.supervisor.standing_chief_agent, false);
  assert.equal(status.supervisor.conductor_loop, false);
  assert.equal(status.storage.postgres_configured, EXPECT_POSTGRES, "storage mode should follow DATABASE_URL");
  assert.ok(status.work_graph.total >= 1, "status must count work nodes");
  assert.ok(status.agent_runs.recent.some((run) => run.id === runId), "status must include recent run");
  const nodes = await getJson(`${baseUrl}/v1/work/nodes`);
  assert.ok(nodes.nodes.some((node) => node.id === nodeId), "node list must include created node");
}

async function assertEventsAndArtifacts(baseUrl, nodeId, runId) {
  const event = await postJson(`${baseUrl}/v1/work/events`, {
    node_id: nodeId,
    run_id: runId,
    type: "status",
    payload: { text: "worker posted a database event" },
  });
  assert.equal(event.status, 201, `event POST must return 201: ${JSON.stringify(event.json)}`);
  assert.equal(event.json.event.node_id, nodeId);
  assert.ok(Number(event.json.event.seq) >= 1, "event must get a node-local seq");

  const events = await getJson(`${baseUrl}/v1/work/events?node_id=${encodeURIComponent(nodeId)}`);
  assert.ok(events.events.some((item) => item.payload?.text === "worker posted a database event"), "event query must return posted event");

  const artifact = await postJson(`${baseUrl}/v1/work/artifacts`, {
    node_id: nodeId,
    run_id: runId,
    kind: "decision",
    title: "Supervisor smoke decision",
    body: "Use durable artifacts instead of chat archaeology.",
  });
  assert.equal(artifact.status, 201, `artifact POST must return 201: ${JSON.stringify(artifact.json)}`);
  assert.equal(artifact.json.artifact.kind, "decision");

  const artifacts = await getJson(`${baseUrl}/v1/work/artifacts?node_id=${encodeURIComponent(nodeId)}&q=durable`);
  assert.ok(artifacts.artifacts.some((item) => item.title === "Supervisor smoke decision"), "artifact query must find posted artifact");

  const reduced = await postJson(`${baseUrl}/v1/work/nodes/${nodeId}/reduce`, {
    title: "Supervisor smoke merged answer",
  });
  assert.equal(reduced.status, 201, `reduce must return 201: ${JSON.stringify(reduced.json)}`);
  assert.equal(reduced.json.artifact.kind, "merged_answer");

  const merged = await getJson(`${baseUrl}/v1/work/artifacts?node_id=${encodeURIComponent(nodeId)}&kind=merged_answer`);
  assert.ok(merged.artifacts.some((item) => item.title === "Supervisor smoke merged answer"), "merged artifact must be queryable");
}

async function waitForRunTerminal(baseUrl, runId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const detail = await getJson(`${baseUrl}/v1/agent/runs/${runId}`);
    if (["completed", "failed", "timed-out", "canceled"].includes(detail.run.status)) {
      return detail;
    }
    await sleep(100);
  }
  throw new Error(`run ${runId} did not finish`);
}

async function startGateway({ port, dataDir }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: gatewayEnv({ port, dataDir }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

function gatewayEnv({ port, dataDir }) {
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
    MOA_GATEWAY_TOKEN: TOKEN,
    DEFAULT_AGENT_HARNESS: "echo",
    MODEL_PROVIDER: "openai-compatible",
    MODEL_ID: "supervisor-smoke-model",
    MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GEMINI_API_KEY: "",
    DATABASE_URL: process.env.DATABASE_URL || "",
  };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Server may still be starting.
    }
    if (logs.exited) {
      throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

async function getJson(url, options) {
  const response = await requestJson(url, options);
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { headers: options.auth === false ? {} : authHeaders() });
  const json = await response.json();
  return { status: response.status, json };
}

async function postJson(url, body, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...(options.auth === false ? {} : authHeaders()),
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function collectLogs(child) {
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (output.length > 12000) output = output.slice(-12000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", () => {
    logs.exited = true;
  });
  const logs = {
    exited: false,
    text: () => output,
  };
  return logs;
}

async function onceExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
