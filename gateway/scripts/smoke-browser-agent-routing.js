#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "browser-agent-routing-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-browser-agent-routing-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const sessionId = `browser_agent_${Date.now().toString(36)}`;
  let server;
  let modelServer;

  try {
    modelServer = await startFakeModelServer();
    server = await startGateway({ port, dataDir, modelBaseUrl: modelServer.baseUrl });

    await step("auth required", () => assertAuthRequired(baseUrl));
    const needsEvidence = await step("missing page evidence returns lifecycle request", () => assertNeedsEvidence(baseUrl, sessionId));
    await step("posted evidence completes the pending turn", () => assertEvidenceCompletesTurn(baseUrl, dataDir, needsEvidence));
    await step("inline evidence completes an explicit browser turn", () => assertInlineEvidenceTurn(baseUrl, sessionId));
    await step("browser-shaped chat delegates to browser turn path", () => assertChatDelegates(baseUrl, sessionId));
    await step("browser-shaped voice delegates to browser turn path", () => assertVoiceDelegates(baseUrl, sessionId));
    await step("browser turns appear in session context", () => assertSessionContextIncludesBrowserTurns(baseUrl, sessionId));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      session_id: sessionId,
      checks: [
        "POST /v1/browser/turns requires a token",
        "missing evidence returns classification=browser_page_question and status=needs_evidence",
        "GET /v1/browser/turns/:id/status reflects pending and completed lifecycle state",
        "POST /v1/browser/evidence links to the evidence request and completes the turn",
    "inline evidence produces a model-backed browser answer when a model is configured",
    "browser-shaped /v1/chat and /v1/voice/turns delegate to the same browser turn path",
    "browser voice profile-control with screen context does not get stolen by the browser turn adapter",
    "browser turns are stored under DATA_DIR and visible in session context",
      ],
    }, null, 2));
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    if (modelServer) {
      await closeHttpServer(modelServer.server);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function assertAuthRequired(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/browser/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "describe this page" }),
  });
  assert.equal(response.status, 401, "browser turns must require a gateway token");
}

async function assertNeedsEvidence(baseUrl, sessionId) {
  const turn = await postJson(`${baseUrl}/v1/browser/turns`, {
    source: "browser-agent-routing-smoke",
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: "page",
    turn_id: "browser_needs_evidence",
    client: { platform: "browser", id: "smoke-extension" },
    text: "What is this page about?",
    input: { type: "text", text: "What is this page about?" },
    page_ref: {
      title: "Chief Moa",
      url: "https://example.test/chief-moa",
    },
  });
  assert.equal(turn.status, 202, `needs-evidence turn must return 202: ${JSON.stringify(turn.json)}`);
  assert.equal(turn.json.status, "needs_evidence");
  assert.equal(turn.json.modality, "text");
  assert.equal(turn.json.classification, "browser_page_question");
  assert.equal(turn.json.page_ref.title, "Chief Moa");
  assert.ok(Array.isArray(turn.json.evidence_request_ids));
  assert.equal(turn.json.evidence_request_ids.length, 1, "pending turn must ask for page evidence");
  assert.match(turn.json.status_url, /\/v1\/browser\/turns\/browser_needs_evidence\/status$/);

  const status = await getJson(`${baseUrl}${turn.json.status_url}`);
  assert.equal(status.status, "needs_evidence", "status endpoint must show pending lifecycle state");
  return turn.json;
}

async function assertEvidenceCompletesTurn(baseUrl, dataDir, pending) {
  const evidenceRequestId = pending.evidence_request_ids[0];
  const completed = await postJson(`${baseUrl}/v1/browser/evidence`, {
    source: "browser-agent-routing-smoke",
    turn_id: pending.turn_id,
    evidence_request_id: evidenceRequestId,
    evidence_id: "browser_evidence_1",
    client: { platform: "browser", id: "smoke-extension" },
    evidence: {
      title: "Chief Moa",
      url: "https://example.test/chief-moa",
      visible_text: "Chief Moa is a cross-platform assistant. The browser extension routes page questions through the gateway.",
    },
    screenshot: {
      media_type: "image/jpeg",
      encoding: "omitted",
      omitted: true,
      bytes: 650000,
      reason: "screenshot too large for gateway evidence payload",
    },
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.json.status, "completed");
  assert.equal(completed.json.classification, "browser_page_question");
  assert.match(completed.json.display, /MODEL_BROWSER_ANSWER/);
  assert.match(completed.json.display, /Chief Moa/);
  assert.match(completed.json.display, /cross-platform assistant/);
  assert.deepEqual(completed.json.actions, [], "gateway must not enqueue hidden browser actions");

  const status = await getJson(`${baseUrl}${pending.status_url}`);
  assert.equal(status.status, "completed", "status endpoint must advance after evidence is posted");
  assert.match(status.text, /MODEL_BROWSER_ANSWER/);

  const turnPath = path.join(dataDir, "browser-turns", `${pending.turn_id}.json`);
  const evidencePath = path.join(dataDir, "browser-evidence", "browser_evidence_1.json");
  assert.ok(fs.existsSync(turnPath), "browser turn JSON file must exist");
  assert.ok(fs.existsSync(evidencePath), "browser evidence JSON file must exist");
  const stored = JSON.parse(fs.readFileSync(turnPath, "utf8"));
  const storedEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal(stored.id, pending.turn_id);
  assert.equal(stored.turn_id, pending.turn_id);
  assert.equal(stored.status, "completed");
  assert.ok(stored.evidence_refs.includes("browser_evidence_1"));
  assert.equal(storedEvidence.screenshot.encoding, "omitted");
  assert.equal(storedEvidence.screenshot.omitted, true);
  assert.equal(storedEvidence.screenshot.data, undefined, "stored browser evidence must not persist screenshot base64 data");
}

async function assertInlineEvidenceTurn(baseUrl, sessionId) {
  const turn = await postJson(`${baseUrl}/v1/browser/turns`, {
    source: "browser-agent-routing-smoke",
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: "page",
    turn_id: "browser_inline_evidence",
    client: { platform: "browser", id: "smoke-extension" },
    input: { type: "voice", text: "Summarize this visible page." },
    text: "Summarize this visible page.",
    page_ref: {
      title: "Gateway Status",
      url: "https://example.test/status",
    },
    evidence: {
      visible_text: "Gateway status is healthy. Browser turn routing is active. No extension-local action has run.",
    },
  });
  assert.equal(turn.status, 200);
  assert.equal(turn.json.modality, "voice");
  assert.equal(turn.json.status, "completed");
  assert.match(turn.json.display, /MODEL_BROWSER_ANSWER/);
  assert.match(turn.json.display, /Browser turn routing is active/);
  assert.deepEqual(turn.json.task_ids, [], "first slice must not create browser tasks");
}

async function assertChatDelegates(baseUrl, sessionId) {
  const chat = await postJson(`${baseUrl}/v1/chat`, {
    source: "browser-agent-routing-smoke",
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: "chat",
    turn_id: "browser_chat_delegate",
    client: { platform: "browser", id: "smoke-extension" },
    messages: [
      { role: "user", content: "Describe this page from the visible text." },
    ],
    page_context: {
      title: "Adapter Page",
      url: "https://example.test/adapter",
      visible_text: "Adapter page visible text proves chat delegation uses the browser turn path.",
    },
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.json.turn_id, "browser_chat_delegate");
  assert.equal(chat.json.status, "completed");
  assert.equal(chat.json.classification, "browser_page_question");
  assert.match(chat.json.text, /MODEL_BROWSER_ANSWER/);
  assert.match(chat.json.text, /chat delegation uses the browser turn path/);
  assert.deepEqual(chat.json.actions, []);
}

async function assertVoiceDelegates(baseUrl, sessionId) {
  const profileControl = await postJson(`${baseUrl}/v1/voice/turns`, {
    source: "browser-agent-routing-smoke",
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: "voice",
    turn_id: "browser_voice_profile_control",
    client: { platform: "browser", id: "smoke-extension" },
    transcript: "switch to a female voice",
    screen: {
      summary: "A browser page is visible, but the user is changing assistant voice settings.",
      nodes: [{ text: "fixture" }],
    },
  });
  assert.equal(profileControl.status, 200);
  assert.equal(profileControl.json.classification, "profile_control");
  assert.notEqual(profileControl.json.classification, "browser_page_question");
  assert.notEqual(profileControl.json.status, "needs_evidence");

  const pending = await postJson(`${baseUrl}/v1/voice/turns`, {
    source: "browser-agent-routing-smoke",
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: "voice",
    turn_id: "browser_voice_needs_evidence",
    client: { platform: "browser", id: "smoke-extension" },
    intent_hint: "browser_page_question",
    transcript: "What am I looking at?",
    page_ref: {
      title: "Voice Pending Page",
      url: "https://example.test/voice-pending",
    },
  });
  assert.equal(pending.status, 202);
  assert.equal(pending.json.status, "needs_evidence");
  assert.equal(pending.json.speak, "", "pending browser voice turn must not pretend to answer");

  const completed = await postJson(`${baseUrl}/v1/voice/turns`, {
    source: "browser-agent-routing-smoke",
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: "voice",
    turn_id: "browser_voice_screen",
    client: { platform: "browser", id: "smoke-extension" },
    transcript: "Describe the current page.",
    page_ref: {
      title: "Voice Screen Page",
      url: "https://example.test/voice-screen",
    },
    screen: {
      summary: "The page shows a checkout button, cart total, and shipping address form.",
      nodes: [
        { text: "Checkout", clickable: true },
        { text: "Cart total $42.00" },
      ],
    },
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.json.status, "completed");
  assert.match(completed.json.display, /MODEL_BROWSER_ANSWER/);
  assert.match(completed.json.display, /checkout button/);
  assert.ok(String(completed.json.speak || "").length > 0, "completed voice browser turn must include speak text");
  assert.deepEqual(completed.json.actions, []);
}

async function assertSessionContextIncludesBrowserTurns(baseUrl, sessionId) {
  const context = await getJson(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/context?all_branches=1`);
  assert.ok(context.session.browser_turn_count >= 4, `expected browser turns in context: ${JSON.stringify(context.session)}`);
  assert.ok(
    context.browser_turns.some((turn) => turn.turn_id === "browser_chat_delegate"),
    "session context must include delegated chat browser turn",
  );
  const latest = await getJson(`${baseUrl}/v1/context/latest`);
  assert.ok(
    latest.recent_browser_turns.some((turn) => turn.turn_id === "browser_voice_screen"),
    "latest context must include delegated voice browser turn",
  );
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
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const json = await response.json();
  assert.ok(response.ok, `GET ${url} failed: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function startGateway({ port, dataDir, modelBaseUrl }) {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      MOA_GATEWAY_TOKEN: TOKEN,
      MODEL_PROVIDER: "openai-compatible",
      MODEL_BASE_URL: modelBaseUrl,
      MODEL_ID: "browser-agent-routing-smoke-model",
      MODEL_API_KEY: "fake-browser-agent-routing-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForServer(`http://127.0.0.1:${port}/health`, logs);
  return server;
}

async function startFakeModelServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {}
      const lastUser = Array.isArray(body.messages)
        ? [...body.messages].reverse().find((message) => message.role === "user")
        : null;
      const prompt = String(lastUser?.content || "");
      const answer = [
        "MODEL_BROWSER_ANSWER",
        prompt.includes("Chief Moa") ? "Chief Moa" : "",
        prompt.includes("cross-platform assistant") ? "cross-platform assistant" : "",
        prompt.includes("Browser turn routing is active") ? "Browser turn routing is active" : "",
        prompt.includes("chat delegation uses the browser turn path") ? "chat delegation uses the browser turn path" : "",
        prompt.includes("checkout button") ? "checkout button" : "",
      ].filter(Boolean).join(" - ");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: answer } }],
      }));
    });
  });
  const port = await freePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

function closeHttpServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function collectLogs(child) {
  let output = "";
  child.stdout.on("data", (chunk) => {
    output = tail(output, chunk.toString("utf8"), 8000);
  });
  child.stderr.on("data", (chunk) => {
    output = tail(output, chunk.toString("utf8"), 8000);
  });
  return () => output;
}

async function waitForServer(url, logs) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the child server binds.
    }
    await sleep(75);
  }
  throw new Error(`gateway did not start. Logs:\n${logs()}`);
}

function onceExit(child, timeoutMs) {
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

function tail(current, addition, max) {
  const next = `${current}${addition}`;
  return next.length > max ? next.slice(next.length - max) : next;
}
