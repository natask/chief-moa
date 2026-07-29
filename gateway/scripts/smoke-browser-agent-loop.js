#!/usr/bin/env node
"use strict";

// Smoke for the browser agent-loop store + endpoints (lib/browser-agent-loop.js
// and the /v1/browser/agent-tasks routes). Keyless and deterministic: no model
// provider is configured, so the gateway's step planner falls back to the
// deterministic planner (step 0 -> wait, step >=1 -> finish).
//
// Drives: create -> claim -> step 0 (expect wait) -> step 1 (expect finish) ->
// finish endpoint, then asserts the task record shape, the linked agent_run
// events, and the /health browser_agent_tasks counts.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "browser-agent-loop-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-browser-agent-loop-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startGateway({ port, dataDir });

    await step("agent-task endpoints require auth", () => assertAuthRequired(baseUrl));
    const created = await step("create links an agent_run and queues browser_agent_task_queued", () => assertCreate(baseUrl, dataDir));
    await step("health reports one pending agent task", () => assertHealth(baseUrl, { pending: 1, active: 0 }));
    const claimed = await step("claim leases the task for 120s", () => assertClaim(baseUrl, created.id));
    await step("health reports the claimed task as active", () => assertHealth(baseUrl, { pending: 0, active: 1 }));
    await step("step 0 plans a deterministic wait", () => assertStep(baseUrl, created.id, {
      step: 0,
      title: "Example Domain",
      url: "https://example.test/",
      expectKind: "wait",
      expectDone: false,
    }));
    await step("step 1 plans a deterministic finish", () => assertStep(baseUrl, created.id, {
      step: 1,
      title: "Example Domain",
      url: "https://example.test/",
      expectKind: "finish",
      expectDone: true,
    }));
    await step("latest bounded screenshot is stored for visual planning and audit", () => assertScreenshotStored(baseUrl, dataDir, created.id));
    await step("finish folds the summary into the linked agent_run", () => assertFinish(baseUrl, dataDir, created));
    await step("finished task record has the expected shape", () => assertFinalRecord(baseUrl, dataDir, created.id));
    await step("role catalog and turn authority are deterministic", () => assertRoleContract(baseUrl, dataDir));
    assert.equal(claimed.lease_ms >= 100000 && claimed.lease_ms <= 121000, true, `claim lease must be ~120s, got ${claimed.lease_ms}ms`);

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      task_id: created.id,
      agent_run_id: created.agent_run_id,
      checks: [
        "/v1/browser/agent-tasks endpoints require a gateway token",
        "create links a non-blocking agent_run and appends browser_agent_task_queued",
        "claim leases the task for ~120s and marks it active in /health",
        "step 0 returns a deterministic wait, step 1 a deterministic finish (keyless fallback)",
        "the latest screenshot is stored on the task record only, never in step history",
        "finish folds the summary into the linked agent_run output and appends browser_agent_task_finished",
        "the finished task record carries the contract fields (status, steps, summary, timestamps)",
        "GET /v1/browser/roles defaults the selector to delegate while omitted turn roles remain explain",
        "only confirmed-envelope delegate turns link visible browser task/run ids; prose-only delegate requests confirmation",
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
  const list = await fetch(`${baseUrl}/v1/browser/agent-tasks`);
  assert.equal(list.status, 401, "list must require a token");
  const create = await fetch(`${baseUrl}/v1/browser/agent-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction: "no auth" }),
  });
  assert.equal(create.status, 401, "create must require a token");
}

async function assertCreate(baseUrl, dataDir) {
  const instruction = "Find the pricing page and summarize the tiers.";
  const url = "https://example.test/";
  const created = await postJson(`${baseUrl}/v1/browser/agent-tasks`, {
    instruction,
    url,
    source: "browser-agent-loop-smoke",
    conversation_id: "bal_smoke_session",
    max_steps: 5,
    delegation_envelope: confirmedEnvelope(instruction, url, 5),
  });
  assert.equal(created.status, 202, `create must return 202: ${JSON.stringify(created.json)}`);
  const task = created.json.task;
  assert.ok(task.id, "task must have an id");
  assert.equal(task.status, "pending");
  assert.equal(task.instruction, instruction);
  assert.equal(task.url, "https://example.test/");
  assert.equal(task.max_steps, 5, "max_steps must be honored");
  assert.equal(task.step_count, 0);
  assert.ok(task.agent_run_id, "task must link an agent_run");
  assert.equal(task.agent_role.id, "delegate");
  assert.equal(task.authority, "bounded_browser_actions");
  assert.equal(task.execution_policy, "multi_step_claim_receipt");
  assert.equal(task.delegation_envelope.confirmation.confirmed, true);
  assert.deepEqual(task.steps, [], "a fresh task has no steps");

  // The linked agent_run exists and carries browser_agent_task_queued.
  const runPath = path.join(dataDir, "agent-runs", `${task.agent_run_id}.json`);
  const eventsPath = path.join(dataDir, "agent-runs", `${task.agent_run_id}.events.jsonl`);
  assert.ok(fs.existsSync(runPath), "linked agent_run file must exist");
  const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
  assert.equal(run.browser_agent_role, "delegate");
  assert.equal(run.browser_authority, "bounded_browser_actions");
  const events = readEvents(eventsPath);
  assert.ok(events.some((event) => event.type === "browser_agent_task_queued" && event.browser_agent_task_id === task.id),
    "run must carry browser_agent_task_queued");

  // The task JSON is stored under DATA_DIR/browser-agent-tasks/.
  const taskPath = path.join(dataDir, "browser-agent-tasks", `${task.id}.json`);
  assert.ok(fs.existsSync(taskPath), "task JSON file must exist under browser-agent-tasks/");
  return { id: task.id, agent_run_id: task.agent_run_id };
}

async function assertRoleContract(baseUrl, dataDir) {
  const unauthorized = await fetch(`${baseUrl}/v1/browser/roles`);
  assert.equal(unauthorized.status, 401);
  const catalog = await getJson(`${baseUrl}/v1/browser/roles`);
  assert.equal(catalog.default_role, "delegate");
  assert.equal(catalog.legacy_omitted_role, "explain");
  assert.deepEqual(catalog.roles.map((role) => role.id), ["delegate", "help", "collaborate", "explain"]);

  const common = {
    text: "Inspect the current page.",
    session_id: "role_smoke_session",
    page: { title: "Role Fixture", url: "https://example.test/roles" },
    evidence: { visible_text: "A bounded deterministic browser role fixture." },
  };
  const legacy = await postJson(`${baseUrl}/v1/browser/turns`, common);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.json.agent_role.id, "explain");
  assert.equal(legacy.json.role_explicit, false);
  assert.deepEqual(legacy.json.task_ids, []);

  const collaborate = await postJson(`${baseUrl}/v1/browser/turns`, { ...common, role: "collaborate" });
  assert.equal(collaborate.status, 200);
  assert.equal(collaborate.json.authority, "proposal_only");
  assert.equal(collaborate.json.proposals.length, 1);
  assert.equal(collaborate.json.proposals[0].executable, false);
  assert.deepEqual(collaborate.json.task_ids, []);

  const delegated = await postJson(`${baseUrl}/v1/browser/turns`, { ...common, role: "delegate" });
  assert.equal(delegated.json.execution.status, "needs_confirmation");
  assert.equal(delegated.json.proposals[0].type, "delegation_confirmation");
  assert.equal(delegated.json.proposals[0].executable, false);
  assert.deepEqual(delegated.json.task_ids, []);
  const confirmed = await postJson(`${baseUrl}/v1/browser/turns`, {
    ...common,
    role: "delegate",
    delegation_envelope: confirmedEnvelope(common.text, common.page.url, 5),
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json.authority, "bounded_browser_actions");
  assert.equal(confirmed.json.execution.status, "pending");
  assert.equal(confirmed.json.task_ids.length, 1);
  assert.equal(confirmed.json.agent_run_ids.length, 1);
  const task = JSON.parse(fs.readFileSync(path.join(dataDir, "browser-agent-tasks", `${confirmed.json.task_ids[0]}.json`), "utf8"));
  const run = JSON.parse(fs.readFileSync(path.join(dataDir, "agent-runs", `${confirmed.json.agent_run_ids[0]}.json`), "utf8"));
  assert.equal(task.turn_id, confirmed.json.turn_id);
  assert.equal(task.agent_role.id, "delegate");
  assert.equal(run.browser_agent_role, "delegate");
  assert.equal(run.turn_id, confirmed.json.turn_id);
  assert.equal(run.delegation_envelope.version, "moa.browser-delegation.v1");
}

function confirmedEnvelope(intent, url, maxSteps = 5) {
  return {
    version: "moa.browser-delegation.v1",
    confirmation: { confirmed: true, user_intent: intent },
    goal: intent,
    scope: { page_url: url, allowed_origins: [new URL(url).origin] },
    allowed_action_classes: ["click", "type", "wait"],
    approval_policy: { preauthorized: ["click", "type", "wait"], always_ask: [] },
    checkpoints: ["before external submit"],
    stop_conditions: ["goal complete", "scope changed", "evidence stale"],
    max_steps: maxSteps,
    completion_evidence: ["requested result is visible"],
  };
}

async function assertHealth(baseUrl, expected) {
  const health = await getJson(`${baseUrl}/health`);
  assert.ok(health.browser_agent_tasks, "/health must expose browser_agent_tasks");
  assert.equal(health.browser_agent_tasks.pending, expected.pending, `pending count: ${JSON.stringify(health.browser_agent_tasks)}`);
  assert.equal(health.browser_agent_tasks.active, expected.active, `active count: ${JSON.stringify(health.browser_agent_tasks)}`);
  assert.ok(health.execute_tool, "/health must expose execute_tool");
  assert.equal(typeof health.execute_tool.enabled, "boolean");
  assert.ok(health.execute_tool.capability_count > 0, "execute_tool.capability_count must be positive");
}

async function assertClaim(baseUrl, taskId) {
  const claim = await postJson(`${baseUrl}/v1/browser/agent-tasks/claim`, { client_id: "agee-smoke" });
  assert.equal(claim.status, 200, `claim must return 200: ${JSON.stringify(claim.json)}`);
  const task = claim.json.task;
  assert.equal(task.id, taskId);
  assert.equal(task.status, "claimed");
  assert.equal(task.claimed_by, "agee-smoke");
  const leaseMs = Date.parse(task.lease_expires_at) - Date.parse(task.claimed_at);
  assert.ok(Number.isFinite(leaseMs), "lease must be a valid duration");

  const empty = await postJson(`${baseUrl}/v1/browser/agent-tasks/claim`, { client_id: "agee-smoke-2" });
  assert.equal(empty.status, 204, "a second claim finds no unleased task");
  return { lease_ms: leaseMs };
}

async function assertStep(baseUrl, taskId, opts) {
  const result = await postJson(`${baseUrl}/v1/browser/agent-tasks/${taskId}/steps`, {
    observation: {
      step: opts.step,
      url: opts.url,
      title: opts.title,
      elements: [
        { i: 0, tag: "a", type: "", label: "Pricing" },
        { i: 1, tag: "button", type: "submit", label: "Search" },
      ],
      page_text: "Example Domain. This domain is for use in examples.",
    },
  });
  assert.equal(result.status, 200, `step must return 200: ${JSON.stringify(result.json)}`);
  assert.equal(result.json.step, opts.step);
  assert.equal(result.json.action.kind, opts.expectKind, `step ${opts.step} action kind`);
  assert.equal(result.json.done, opts.expectDone);
  if (opts.expectKind === "finish") {
    assert.equal(result.json.action.status, "done");
    assert.match(result.json.action.summary, /Example Domain/, "deterministic finish summary names the observed title");
  }
}

async function assertScreenshotStored(baseUrl, dataDir, taskId) {
  // A step carrying a small base64 screenshot: it must be stored on the task
  // record (latest only) and NOT copied into the step-history observation.
  const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  const result = await postJson(`${baseUrl}/v1/browser/agent-tasks/${taskId}/steps`, {
    observation: {
      step: 2,
      url: "https://example.test/pricing",
      title: "Pricing",
      screenshot: { encoding: "base64_jpeg", data: tinyJpeg },
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));

  const record = JSON.parse(fs.readFileSync(path.join(dataDir, "browser-agent-tasks", `${taskId}.json`), "utf8"));
  assert.ok(record.latest_screenshot, "task must store the latest screenshot");
  assert.equal(record.latest_screenshot.encoding, "base64_jpeg");
  assert.equal(record.latest_screenshot.data, tinyJpeg, "task keeps the latest screenshot bytes for audit");
  const lastStep = record.steps[record.steps.length - 1];
  assert.notEqual(
    lastStep.observation.screenshot && lastStep.observation.screenshot.encoding,
    "base64_jpeg",
    "step history must not carry screenshot bytes",
  );
}

async function assertFinish(baseUrl, dataDir, created) {
  const finish = await postJson(`${baseUrl}/v1/browser/agent-tasks/${created.id}/finish`, {
    status: "done",
    summary: "Summarized the three pricing tiers.",
  });
  assert.equal(finish.status, 200, `finish must return 200: ${JSON.stringify(finish.json)}`);
  assert.equal(finish.json.task.status, "done");
  assert.equal(finish.json.task.summary, "Summarized the three pricing tiers.");

  const runPath = path.join(dataDir, "agent-runs", `${created.agent_run_id}.json`);
  const eventsPath = path.join(dataDir, "agent-runs", `${created.agent_run_id}.events.jsonl`);
  const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
  assert.equal(run.status, "completed", "linked run is marked completed on a done finish");
  assert.match(run.output, /Summarized the three pricing tiers/, "finish folds the summary into run output");
  const events = readEvents(eventsPath);
  assert.ok(events.some((event) => event.type === "browser_agent_task_finished"), "run must carry browser_agent_task_finished");
  assert.ok(events.some((event) => event.type === "browser_agent_task_step"), "run must carry browser_agent_task_step events");
}

async function assertFinalRecord(baseUrl, dataDir, taskId) {
  const got = await getJson(`${baseUrl}/v1/browser/agent-tasks/${taskId}`);
  const task = got.task;
  assert.equal(task.status, "done");
  assert.ok(Array.isArray(task.steps) && task.steps.length >= 2, "GET by id includes the step history");
  assert.ok(task.finished_at, "finished_at is set");
  for (const field of ["id", "status", "instruction", "max_steps", "step_count", "created_at", "updated_at"]) {
    assert.ok(field in task, `record must carry ${field}`);
  }
  // Terminal task cannot be stepped again.
  const late = await postJson(`${baseUrl}/v1/browser/agent-tasks/${taskId}/steps`, { observation: { step: 9 } });
  assert.equal(late.status, 409, "stepping a finished task is rejected");
}

function readEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {};
      }
    });
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
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text.trim() ? JSON.parse(text) : {} };
}

async function getJson(url) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  const text = await response.text();
  assert.ok(response.ok, `GET ${url} failed: ${response.status} ${text}`);
  return text.trim() ? JSON.parse(text) : {};
}

async function startGateway({ port, dataDir }) {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      MOA_GATEWAY_TOKEN: TOKEN,
      MODEL_PROVIDER: "openai-compatible",
      MODEL_API_KEY: "",
      VOICE_PROVIDER: "loopback",
      VOICE_STT_PROVIDER: "loopback",
      VOICE_LLM_PROVIDER: "loopback",
      VOICE_TTS_PROVIDER: "loopback",
      ALLOW_AGENT_WITHOUT_TOKEN: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const baseUrl = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (server.exitCode != null) {
      throw new Error(`gateway exited with ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return server;
    } catch {
      // Keep waiting.
    }
    await delay(100);
  }
  throw new Error("gateway did not start");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
