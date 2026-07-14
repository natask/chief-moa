#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "project-state-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-project-state-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const workDir = path.join(tempDir, "project");
  fs.mkdirSync(workDir, { recursive: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  try {
    server = spawn(process.execPath, ["server.js"], {
      cwd: GATEWAY_DIR,
      env: {
        PATH: process.env.PATH || "",
        HOME: process.env.HOME || "",
        TMPDIR: process.env.TMPDIR || os.tmpdir(),
        HOST: "127.0.0.1",
        PORT: String(port),
        DATA_DIR: dataDir,
        HARNESS_WORKDIR: tempDir,
        ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
        MOA_GATEWAY_TOKEN: TOKEN,
        DEFAULT_AGENT_HARNESS: "echo",
        MODEL_PROVIDER: "openai-compatible",
        MODEL_API_KEY: "",
        DATABASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logs = collectLogs(server);
    await waitForHealth(baseUrl, logs);

    const created = await requestJson(`${baseUrl}/v1/projects`, {
      method: "POST",
      auth: true,
      body: { name: "Useful project", working_dir: workDir, default_harness: "echo" },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.json.project.brief, {
      problem: "", desired_outcome: "", current_state: "", next_step: "",
    });
    const id = created.json.project.id;

    const denied = await requestJson(`${baseUrl}/v1/projects/${id}`, {
      method: "PATCH",
      body: { brief: { problem: "secret mutation" } },
    });
    assert.equal(denied.status, 401);

    const updated = await requestJson(`${baseUrl}/v1/projects/${id}`, {
      method: "PATCH",
      auth: true,
      body: { brief: {
        problem: "People lose project intent in agent sessions.",
        desired_outcome: "Return and know what matters.",
        current_state: "The gateway can launch disposable agents.",
        next_step: "Make project state visible.",
      } },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.project.brief.next_step, "Make project state visible.");
    assert.ok(updated.json.project.updated_at);

    const listed = await requestJson(`${baseUrl}/v1/projects`, { auth: true });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.projects[0].brief.problem, "People lose project intent in agent sessions.");

    const launched = await requestJson(`${baseUrl}/v1/agent/runs`, {
      method: "POST",
      auth: true,
      body: { project_id: id, harness: "echo", prompt: "Advance the next step.", wait: false },
    });
    assert.equal(launched.status, 202);
    const runRecord = JSON.parse(fs.readFileSync(path.join(dataDir, "agent-runs", `${launched.json.run.id}.json`), "utf8"));
    assert.match(runRecord.prompt, /Durable project brief \(Useful project\):/);
    assert.match(runRecord.prompt, /Next viable step: Make project state visible\./);

    console.log(JSON.stringify({
      ok: true,
      checks: [
        "project brief starts as a durable empty shape",
        "project brief update requires authorization",
        "problem, outcome, current state, and next step survive a later read",
        "project-targeted agent work receives the durable brief",
      ],
    }, null, 2));
  } finally {
    if (server) server.kill("SIGTERM");
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      ...(options.auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, json: await response.json() };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    if (logs.exited) throw new Error(`gateway exited before health\n${logs.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`gateway health timed out\n${logs.text()}`);
}

function collectLogs(child) {
  let output = "";
  const append = (chunk) => { output = (output + chunk.toString("utf8")).slice(-12000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const logs = { exited: false, text: () => output };
  child.on("exit", () => { logs.exited = true; });
  return logs;
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
