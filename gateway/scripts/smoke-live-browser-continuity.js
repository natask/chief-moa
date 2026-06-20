#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "live-browser-continuity-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-live-browser-continuity-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const sessionId = `continuity_${Date.now().toString(36)}`;
  let server;

  try {
    server = await startGateway({ port, dataDir });

    const initialProfile = await getJson(`${baseUrl}/v1/agent/profile`);
    const profileUpdate = await putJson(`${baseUrl}/v1/agent/profile`, {
      source: "live-browser-continuity-smoke",
      profile: {
        system_prompt: "You are Moa. Remember this smoke profile.",
        voice: "Aoede",
      },
    });
    assert.notEqual(profileUpdate.profile_version, initialProfile.profile_version, "profile update must create a new version");
    assert.equal(profileUpdate.profile.voice, "Aoede", "profile voice must persist");

    const versions = await getJson(`${baseUrl}/v1/agent/profile/versions?limit=10`);
    assert.ok(versions.versions.length >= 2, "profile versions endpoint must list prior versions");
    assert.equal(versions.current_version, profileUpdate.profile_version, "versions endpoint must identify current version");

    const rollback = await postJson(`${baseUrl}/v1/agent/profile/rollback`, {
      source: "live-browser-continuity-smoke",
      version: initialProfile.profile_version,
    });
    assert.notEqual(rollback.profile_version, profileUpdate.profile_version, "rollback must create a new profile version");
    assert.equal(rollback.profile.voice, initialProfile.profile.voice, "rollback must restore the selected prior profile");

    const activeProfile = await putJson(`${baseUrl}/v1/agent/profile`, {
      source: "live-browser-continuity-smoke",
      profile: {
        system_prompt: "You are Moa. Remember this smoke profile.",
        voice: "Aoede",
      },
    });
    assert.equal(activeProfile.profile.voice, "Aoede", "profile voice must persist after reapplying");

    const languageTurn = await postJson(`${baseUrl}/v1/voice/turns`, {
      source: "live-browser-continuity-smoke",
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: "profile",
      turn_id: "voice_profile_language_1",
      transcript: "Only speak English and Amharic, don't switch up.",
    });
    assert.equal(languageTurn.classification, "profile_control", "spoken language lock must route as profile_control");
    assert.equal(languageTurn.profile.language.allowed, "en-US,am-ET", "spoken language lock must persist allowed languages");
    assert.equal(languageTurn.profile.language.primary, "en-US", "spoken language lock must keep first-mentioned language as primary");
    assert.equal(languageTurn.profile.language.auto_switch, false, "spoken language lock must disable auto-switch");
    const liveProfile = await getJson(`${baseUrl}/v1/agent/profile`);
    assert.equal(liveProfile.profile_version, languageTurn.profile_version, "profile endpoint must reflect the spoken language update version");

    const chat = await postJson(`${baseUrl}/v1/chat`, {
      source: "agee-extension",
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: "browser",
      turn_id: "chat_browser_1",
      messages: [
        { role: "user", content: "Describe this browser page and keep it in session context." },
      ],
    });
    assert.equal(chat.session_id, sessionId, "chat response must echo session id");
    assert.equal(chat.branch_id, "browser", "chat response must echo branch id");
    assert.equal(chat.profile_version, liveProfile.profile_version, "chat turn must record current profile version");

    const queued = await postJson(`${baseUrl}/v1/browser/tasks`, {
      source: "gemini-live-tool",
      conversation_id: sessionId,
      branch_id: "browser",
      instruction: "Open example.com and report the page title.",
      url: "https://example.com/",
      cdp_actions: [
        {
          method: "Runtime.evaluate",
          params: {
            expression: "JSON.stringify({ title: document.title, url: location.href })",
          },
        },
        {
          method: "Page.captureScreenshot",
          params: { format: "jpeg", quality: 30 },
        },
      ],
    }, { expectedStatus: 202 });
    assert.equal(queued.task.status, "pending", "browser task starts pending");
    assert.equal(queued.task.profile_version, liveProfile.profile_version, "browser task must record current profile version");
    assert.equal(queued.task.action_count, 2, "bounded CDP actions must be retained");

    const claimed = await postJson(`${baseUrl}/v1/browser/tasks/claim`, {
      client_id: "smoke-extension",
    });
    assert.equal(claimed.task.id, queued.task.id, "extension claim must return the queued task");
    assert.equal(claimed.task.status, "claimed", "claimed task status must be claimed");
    assert.equal(claimed.task.cdp_actions.length, 2, "claim response must include sanitized actions");

    const receipted = await postJson(`${baseUrl}/v1/browser/tasks/${encodeURIComponent(queued.task.id)}/receipts`, {
      client_id: "smoke-extension",
      ok: true,
      summary: "Browser task completed in smoke.",
      action_results: [
        { method: "Runtime.evaluate", ok: true, value: { title: "Example Domain" } },
        { method: "Page.captureScreenshot", ok: true, value: { data_bytes: 1200 } },
      ],
      page_state: {
        title: "Example Domain",
        url: "https://example.com/",
        ready: "complete",
      },
      screenshot: {
        format: "jpeg",
        bytes: 1200,
      },
    });
    assert.equal(receipted.task.status, "completed", "receipt must complete the browser task");
    assert.equal(receipted.receipt.ok, true, "receipt must be ok");

    const context = await getJson(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/context?all_branches=1`);
    assert.equal(context.profile.current_version, liveProfile.profile_version, "context must expose current profile version");
    assert.equal(context.profile.voice, "Aoede", "context must expose current profile voice");
    assert.equal(context.profile.language.allowed, "en-US,am-ET", "context must expose allowed language profile");
    assert.ok(context.chat_turns.some((turn) => turn.turn_id === "chat_browser_1"), "context must include browser chat turn");
    assert.ok(context.browser_tasks.some((task) => task.id === queued.task.id && task.status === "completed"), "context must include completed browser task");

    const latestContext = await getJson(`${baseUrl}/v1/context/latest`);
    assert.ok(latestContext.recent_chat_turns.some((turn) => turn.turn_id === "chat_browser_1"), "latest context must include recent chat turn");
    assert.ok(latestContext.recent_browser_tasks.some((task) => task.id === queued.task.id), "latest context must include recent browser task");

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      session_id: sessionId,
      profile_version: liveProfile.profile_version,
      browser_task_id: queued.task.id,
      checks: [
        "profile update created a durable version",
        "profile rollback created a new version from a selected prior profile",
        "spoken language lock updated the global profile through /v1/voice/turns",
        "browser /v1/chat turn kept session_id, branch_id, turn_id, and profile_version",
        "gateway browser task queued, claimed by extension client, and completed by receipt",
        "session context with all_branches includes profile, chat turn, and browser task",
        "latest context includes recent chat turns and browser tasks",
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
      MOA_GATEWAY_TOKEN: TOKEN,
      MODEL_PROVIDER: "openai-compatible",
      MODEL_ID: "continuity-smoke-model",
      MODEL_API_KEY: "",
      OPENAI_API_KEY: "",
      GOOGLE_API_KEY: "",
      GEMINI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
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

async function getJson(url) {
  const response = await fetch(url, { headers: authHeaders() });
  const json = await response.json();
  assert.ok(response.ok, `${url} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const json = await response.json();
  assert.ok(response.ok, `${url} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function postJson(url, body, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const json = response.status === 204 ? null : await response.json();
  const expected = options.expectedStatus || 200;
  assert.equal(response.status, expected, `${url} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

function authHeaders() {
  return {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.on("error", reject);
  });
}

function collectLogs(child) {
  const chunks = [];
  const logs = {
    exited: false,
    text: () => chunks.join(""),
  };
  child.stdout.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
  child.on("exit", () => {
    logs.exited = true;
  });
  return logs;
}

function onceExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
