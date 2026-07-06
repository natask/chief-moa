#!/usr/bin/env node
"use strict";

// Smoke for the broker research workflow (task 4.3). It proves the pure engine
// fans a query out into focused passes, refines, and returns a report with no
// provider (deterministic), that an injected runner is used when present, and
// that POST /v1/broker/research stores the message broker-first, selects the
// research workflow, runs the fan-out, and returns/persists a durable report.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { runResearch, deriveSubQueries } = require("../lib/research-workflow");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "research-workflow-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  await step("deterministic fan-out with no provider", assertDeterministicEngine);
  await step("injected runner produces fan-out + refine passes", assertInjectedRunner);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-research-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  try {
    server = await startGateway({ port, dataDir });
    await step("research endpoint requires auth", () => assertAuthRequired(baseUrl));
    const report = await step("broker research fans out and returns a report", () =>
      assertBrokerResearchRoute(baseUrl, dataDir));
    await step("stored report is readable by id", () => assertReportReadback(baseUrl, report.id));

    console.log(JSON.stringify({
      ok: true,
      report_id: report.id,
      pass_count: report.pass_count,
      checks: [
        "engine derives one sub-query per lens and returns a report with no provider",
        "engine uses an injected runner and adds a refine synthesis pass",
        "POST /v1/broker/research requires a gateway token",
        "research message selects the landscape-research workflow and returns a report",
        "report fans out multiple passes, refines a recommendation, and stores markdown",
        "report is persisted and readable by id",
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

async function assertDeterministicEngine() {
  const subQueries = deriveSubQueries("what is the best worker pull model", 4);
  assert.equal(subQueries.length, 4);
  const report = await runResearch({ query: "what is the best worker pull model" }, {
    idFactory: () => "research_fixed",
  });
  assert.equal(report.id, "research_fixed");
  assert.equal(report.pass_count, 4);
  assert.equal(report.passes.length, 4);
  assert.equal(report.runner_used, false, "no runner injected -> runner_used false");
  assert.ok(report.recommendation, "report must have a recommendation from the refine pass");
  assert.match(report.report_markdown, /# Research report:/);
  assert.match(report.report_markdown, /## Recommendation/);
  assert.equal(new Set(report.passes.map((p) => p.lens_id)).size, 4, "each pass is a distinct lens");
}

async function assertInjectedRunner() {
  const calls = [];
  const report = await runResearch({ query: "compare codex and claude harnesses", max_passes: 3 }, {
    idFactory: () => "research_injected",
    runPass: async (subQuery, ctx) => {
      calls.push({ subQuery, refine: Boolean(ctx.refine) });
      return { text: ctx.refine ? `SYNTH:${subQuery.slice(0, 20)}` : `PASS:${subQuery.slice(0, 20)}` };
    },
  });
  assert.equal(report.pass_count, 3);
  assert.equal(report.runner_used, true, "injected runner -> runner_used true");
  // 3 fan-out passes + 1 refine pass = 4 runner calls.
  assert.equal(calls.length, 4, `expected 3 passes + 1 refine, got ${calls.length}`);
  assert.equal(calls.filter((c) => c.refine).length, 1, "exactly one refine pass");
  assert.match(report.recommendation, /^SYNTH:/, "recommendation comes from the refine pass");
  assert.ok(report.passes.every((p) => p.findings.startsWith("PASS:")), "each pass used the runner");
}

async function assertAuthRequired(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/broker/research`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "research the worker pull model" }),
  });
  assert.equal(response.status, 401);
}

async function assertBrokerResearchRoute(baseUrl, dataDir) {
  const response = await postJson(`${baseUrl}/v1/broker/research`, {
    source: "research-workflow-smoke",
    text: "start a research report and compare the most optimal worker pull execution options",
    max_passes: 4,
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  assert.equal(response.json.research_selected, true, "research workflow must be selected");
  const report = response.json.report;
  assert.ok(report && report.id, "response must include a report");
  assert.equal(report.pass_count, 4);
  assert.ok(report.passes.length === 4);
  assert.ok(report.recommendation, "report must have a recommendation");
  assert.match(report.report_markdown, /## Findings by angle/);
  assert.equal(report.broker_event_id, response.json.event.id, "report must link the broker event");

  // The report is persisted on disk.
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "broker-research-reports", `${report.id}.json`), "utf8"));
  assert.equal(stored.id, report.id);
  assert.equal(stored.query, report.query);

  // The broker event was stored broker-first (event ledger).
  const brokerEventPath = path.join(dataDir, "broker-events", `${response.json.event.id}.json`);
  assert.ok(fs.existsSync(brokerEventPath), "broker event must be stored broker-first");
  return report;
}

async function assertReportReadback(baseUrl, reportId) {
  const response = await fetch(`${baseUrl}/v1/broker/research/${encodeURIComponent(reportId)}`, {
    headers: authHeaders(),
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.report.id, reportId);
  assert.ok(Array.isArray(json.report.passes) && json.report.passes.length > 0);
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
      MOA_GATEWAY_TOKEN: TOKEN,
      DEFAULT_AGENT_HARNESS: "echo",
      MODEL_PROVIDER: "openai-compatible",
      MODEL_API_KEY: "",
      OPENAI_API_KEY: "",
      GOOGLE_API_KEY: "",
      GEMINI_API_KEY: "",
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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
