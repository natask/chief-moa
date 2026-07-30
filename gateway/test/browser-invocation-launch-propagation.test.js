"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");

const TOKEN = "browser-invocation-launch-test";

test("HTTP and live voice launches preserve one sanitized browser invocation snapshot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-browser-launch-context-"));
  const previous = saveEnvironment(["DATA_DIR", "DEFAULT_AGENT_HARNESS", "HOST", "MOA_GATEWAY_TOKEN", "MOA_MODE", "PORT"]);
  const serverPath = require.resolve("../server");
  let gateway;

  try {
    process.env.DEFAULT_AGENT_HARNESS = "echo";
    process.env.DATA_DIR = path.join(root, "data");
    process.env.MOA_GATEWAY_TOKEN = TOKEN;
    process.env.HOST = "127.0.0.1";
    process.env.MOA_MODE = "local";
    process.env.PORT = "0";
    delete require.cache[serverPath];
    const runtime = require(serverPath);
    gateway = runtime.server;
    runtime.startServer();
    await once(gateway, "listening");

    const context = invocationContext();
    const voice = await postJson(gateway.address().port, "/v1/voice/turns", {
      session_id: "voice-session",
      turn_id: "voice-turn",
      source: "agee-extension",
      client: { platform: "browser" },
      transcript: "Launch an agent to inspect this task.",
      forced_action: "agent_run",
      invocation_context: context,
      invocation_evidence_refs: ["evidence-voice"],
      harness: "echo",
    });
    assert.equal(voice.status, 202);
    assert.equal(voice.body.agent_run.invocation_context.page.url, "https://tasks.example.test/send-time");
    assert.deepEqual(voice.body.agent_run.invocation_evidence_refs, ["evidence-voice"]);
    assertRunPrompt(root, voice.body.agent_run.id);

    const liveCall = {
      transcript: "Fix the browser code with an agent.",
      session_id: "live-session",
      branch_id: "live-branch",
      turn_id: "live-turn",
      source: "agee-extension",
      invocation_context: context,
      invocation_evidence_refs: ["evidence-live"],
    };
    const liveRun = await runtime.handleLiveVoiceToolCall({
      ...liveCall,
      name: "launch_agent_run",
      args: { prompt: "Inspect the task", harness: "echo" },
    });
    assert.equal(liveRun.ok, true);
    assert.equal(liveRun.run.turn_id, "live-turn");
    assert.equal(liveRun.run.invocation_context.executable, false);
    assert.deepEqual(liveRun.run.invocation_evidence_refs, ["evidence-live"]);
    assertRunPrompt(root, liveRun.run.id);

    const browserLaunch = await runtime.handleLiveVoiceToolCall({
      ...liveCall,
      name: "launch_browser_agent",
      args: { instruction: "Inspect the task", url: "https://tasks.example.test/send-time" },
    });
    assert.equal(browserLaunch.ok, true);
    assert.equal(browserLaunch.run.invocation_context.digest, browserLaunch.task.invocation_context.digest);
    assert.equal(browserLaunch.task.invocation_context.page.title, "Send-time task");
    assert.deepEqual(browserLaunch.task.invocation_evidence_refs, ["evidence-live"]);
    assertRunPrompt(root, browserLaunch.run.id);
    await Promise.all([
      waitForRunTerminal(root, voice.body.agent_run.id),
      waitForRunTerminal(root, liveRun.run.id),
      waitForRunTerminal(root, browserLaunch.run.id),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    if (gateway?.listening) await new Promise((resolve) => gateway.close(resolve));
    delete require.cache[serverPath];
    restoreEnvironment(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function invocationContext() {
  return {
    schema: "moa.browser-invocation-context.v1",
    input: "voice",
    tab_id: 22,
    captured_at: "2026-07-29T20:00:00.000Z",
    page: { url: "https://tasks.example.test/send-time", title: "Send-time task", snapshot_id: "snap-send" },
    snapshot: {
      snapshot_id: "snap-send",
      url: "https://tasks.example.test/send-time",
      title: "Send-time task",
      page_text: "The exact task visible when the user submitted the message.",
      document_context: { scope: "whole_rendered_document", complete: true, truncated: false },
      elements: [],
      element_summaries: [],
      captured_at: "2026-07-29T20:00:00.000Z",
      action: { type: "must_not_execute" },
    },
    command: "must_not_survive",
  };
}

function assertRunPrompt(root, runId) {
  const run = JSON.parse(fs.readFileSync(path.join(root, "data", "agent-runs", `${runId}.json`), "utf8"));
  assert.match(run.prompt, /captured when this exact message was submitted/);
  assert.match(run.prompt, /Send-time task/);
  assert.doesNotMatch(run.prompt, /must_not_execute|must_not_survive/);
  assert.equal(run.invocation_context.command, undefined);
}

async function waitForRunTerminal(root, runId) {
  const runPath = path.join(root, "data", "agent-runs", `${runId}.json`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
    if (["completed", "failed", "timed-out", "canceled"].includes(run.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`agent run ${runId} did not finish`);
}

function postJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

function saveEnvironment(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
