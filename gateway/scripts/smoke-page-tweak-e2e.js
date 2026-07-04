#!/usr/bin/env node
"use strict";

// Integration smoke for the wave-3 page-tweak seam, both loops, deterministic
// (no live Vertex, no real OpenAI):
//
//   A. Live loop: a fake Gemini Live socket emits a propose_page_tweak toolCall
//      on a browser-sourced session. The gateway must forward the validated
//      page_tweak action to the client as its own "page_tweak" event on the
//      voice session socket (the extension consumes this event, not the tool
//      response the provider sees).
//
//   B. Typed loop: a browser-sourced POST /v1/voice/turns whose (fake
//      OpenAI-compatible) model returns a propose_page_tweak tool_call must come
//      back with actions[] carrying the validated { type:"page_tweak", record }.
//      A turn where the model does NOT call the tool must return a plain reply
//      with no page_tweak action, and the turn must stay fast (one tool round).
//
// Boots node server.js on a throwaway port + token + DATA_DIR (real .env never
// loaded), with a fake Gemini Live endpoint and a fake OpenAI-compatible chat
// endpoint so no real provider is touched. The user's live gateway (8787) and
// gateway/data are never touched.

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket, WebSocketServer } = require("ws");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "page-tweak-e2e-smoke-token";
const ENV_DEFAULT_VOICE = "Kore";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-page-tweak-e2e-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/v1/voice/sessions`;
  let server;
  let fakeLive;
  let fakeModel;

  try {
    fakeLive = await startFakeLive();
    fakeModel = await startFakeModel();
    server = await startGateway({ port, dataDir, fakeLiveUrl: fakeLive.url, modelBaseUrl: fakeModel.url });

    await step("live loop: toolCall -> client page_tweak event", () => assertLivePageTweakEvent(wsUrl, fakeLive));
    await step("typed loop: model tool_call -> actions[] page_tweak", () => assertHttpPageTweakAction(baseUrl, fakeModel));
    await step("typed loop: no tool_call -> plain reply, no action", () => assertHttpPlainReply(baseUrl, fakeModel));
    await step("typed loop: non-browser source is not offered the tool", () => assertHttpNonBrowserSource(baseUrl, fakeModel));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      checks: [
        "live: a browser-source propose_page_tweak toolCall produces a client-visible page_tweak event on the session socket carrying { type:'page_tweak', record }",
        "typed: a browser-source HTTP turn whose model calls propose_page_tweak returns actions[] with the validated { type:'page_tweak', record }, kind+params intact",
        "typed: a turn where the model does not call the tool returns a plain reply with an empty actions[]",
        "typed: a non-browser source turn does not expose the tool and returns a plain reply",
      ],
    }, null, 2));
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    if (fakeLive) await fakeLive.close();
    if (fakeModel) await fakeModel.close();
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

// --- Loop A: live socket --------------------------------------------------

async function assertLivePageTweakEvent(wsUrl, fakeLive) {
  fakeLive.nextToolCall = {
    name: "propose_page_tweak",
    args: { kind: "hide", params: { selectors: ["aside", "#sidebar"] }, name: "Hide sidebar" },
  };
  const sessionId = `pt_live_${Math.random().toString(36).slice(2, 8)}`;
  const turnId = `turn_${Math.random().toString(36).slice(2, 8)}`;
  const ws = await openVoiceClient(wsUrl);
  const events = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    try {
      events.push(JSON.parse(Buffer.from(data).toString("utf8")));
    } catch {
      // ignore non-JSON frames
    }
  });
  try {
    await sendJsonWs(ws, {
      type: "session_start",
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: "default",
      turn_id: turnId,
      source: "agee-extension",
      format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    });
    await waitForEvent(events, (e) => e.type === "session_ready" && e.turn_id === turnId);
    ws.send(Buffer.alloc(640, 1));
    await sendJsonWs(ws, { type: "commit_turn", turn_id: turnId });
    const tweakEvent = await waitForEvent(events, (e) => e.type === "page_tweak" && e.turn_id === turnId);
    assert.ok(tweakEvent.action && tweakEvent.action.type === "page_tweak", `page_tweak event must carry a page_tweak action: ${JSON.stringify(tweakEvent)}`);
    assert.deepStrictEqual(
      tweakEvent.action,
      { type: "page_tweak", record: { kind: "hide", params: { selectors: ["aside", "#sidebar"] }, name: "Hide sidebar" } },
      `live page_tweak event action must match the validated record contract: ${JSON.stringify(tweakEvent.action)}`,
    );
    assert.deepStrictEqual(tweakEvent.record, tweakEvent.action.record, "live page_tweak event must duplicate record at top level for the client");
    await waitForEvent(events, (e) => e.type === "turn_done" && e.turn_id === turnId);
  } finally {
    closeWebSocketQuietly(ws);
  }
}

// --- Loop B: HTTP turn ----------------------------------------------------

async function assertHttpPageTweakAction(baseUrl, fakeModel) {
  fakeModel.nextResponse = toolCallResponse({
    kind: "hide",
    params: { selectors: ["#cookie-banner"] },
    name: "Hide cookie banner",
  }, "Hid the cookie banner on this page.");
  const turn = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "pt-http-smoke",
    turn_id: "http-tweak",
    transcript: "hide the cookie banner",
    source: "agee-extension",
  });
  assert.equal(turn.status, 200, `browser page-tweak turn must succeed: ${JSON.stringify(turn.json)}`);
  const action = (turn.json.actions || []).find((a) => a.type === "page_tweak");
  assert.ok(action, `browser turn must attach a page_tweak action: ${JSON.stringify(turn.json.actions)}`);
  assert.deepStrictEqual(
    action.record,
    { kind: "hide", params: { selectors: ["#cookie-banner"] }, name: "Hide cookie banner" },
    `page_tweak action record must be the validated record: ${JSON.stringify(action.record)}`,
  );
}

async function assertHttpPlainReply(baseUrl, fakeModel) {
  fakeModel.nextResponse = plainReply("The capital of France is Paris.");
  const turn = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "pt-http-smoke",
    turn_id: "http-plain",
    transcript: "what is the capital of france",
    source: "agee-extension",
  });
  assert.equal(turn.status, 200, `plain browser turn must succeed: ${JSON.stringify(turn.json)}`);
  const action = (turn.json.actions || []).find((a) => a.type === "page_tweak");
  assert.ok(!action, `a turn with no tool call must not attach a page_tweak action: ${JSON.stringify(turn.json.actions)}`);
  assert.ok(String(turn.json.display || "").toLowerCase().includes("paris"), `plain reply text must be returned: ${JSON.stringify(turn.json.display)}`);
}

async function assertHttpNonBrowserSource(baseUrl, fakeModel) {
  // A non-browser source must never be offered the tool; even if the fake model
  // is primed with a tool call, the gateway must not send tools and must return a
  // plain reply. We prime a plain reply here (the gateway never sends tools), and
  // assert no page_tweak action lands.
  fakeModel.nextResponse = plainReply("Sure, here is an answer.");
  const turn = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "pt-http-smoke",
    turn_id: "http-nonbrowser",
    transcript: "hide the sidebar",
    source: "android-overlay",
  });
  assert.equal(turn.status, 200, `non-browser turn must succeed: ${JSON.stringify(turn.json)}`);
  const action = (turn.json.actions || []).find((a) => a.type === "page_tweak");
  assert.ok(!action, `non-browser source must not get a page_tweak action: ${JSON.stringify(turn.json.actions)}`);
  assert.ok(fakeModel.lastRequestHadNoTools, "gateway must not send a tools array for a non-browser source turn");
}

function toolCallResponse(args, content) {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: content || "",
        tool_calls: [{
          id: `call_${Math.random().toString(36).slice(2, 8)}`,
          type: "function",
          function: { name: "propose_page_tweak", arguments: JSON.stringify(args) },
        }],
      },
    }],
  };
}

function plainReply(text) {
  return { choices: [{ message: { role: "assistant", content: text } }] };
}

// --- Fakes ----------------------------------------------------------------

// Fake Gemini Live: completes setup, and on audioStreamEnd emits the queued
// toolCall, then finishes the turn on receiving the toolResponse.
async function startFakeLive() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const state = { nextToolCall: null };
  await waitForServerListening(server);
  server.on("connection", (ws) => {
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(Buffer.from(data).toString("utf8"));
      } catch {
        return;
      }
      if (message.setup) {
        ws.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (message.toolResponse) {
        ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
        return;
      }
      if (message.realtimeInput?.audioStreamEnd) {
        if (state.nextToolCall) {
          const call = state.nextToolCall;
          state.nextToolCall = null;
          ws.send(JSON.stringify({
            toolCall: { functionCalls: [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, name: call.name, args: call.args }] },
          }));
          return;
        }
        ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}/v1beta/fake-live`,
    get nextToolCall() { return state.nextToolCall; },
    set nextToolCall(value) { state.nextToolCall = value; },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

// Fake OpenAI-compatible chat endpoint: returns the primed nextResponse to any
// POST /chat/completions and records whether the request carried a tools array.
async function startFakeModel() {
  const state = { nextResponse: plainReply("ok"), lastRequestHadNoTools: false };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch {}
      state.lastRequestHadNoTools = !Array.isArray(parsed.tools) || parsed.tools.length === 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state.nextResponse));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    get nextResponse() { return state.nextResponse; },
    set nextResponse(value) { state.nextResponse = value; },
    get lastRequestHadNoTools() { return state.lastRequestHadNoTools; },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

// --- Gateway boot ---------------------------------------------------------

async function startGateway({ port, dataDir, fakeLiveUrl, modelBaseUrl }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: gatewayEnv({ port, dataDir, fakeLiveUrl, modelBaseUrl }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

function gatewayEnv({ port, dataDir, fakeLiveUrl, modelBaseUrl }) {
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
    MOA_GATEWAY_TOKEN: TOKEN,
    // OpenAI-compatible path pointed at the fake model so the typed tool round
    // runs deterministically. MODEL_API_KEY set so providerConfigured() is true.
    MODEL_PROVIDER: "openai-compatible",
    MODEL_ID: "page-tweak-e2e-model",
    MODEL_BASE_URL: modelBaseUrl,
    MODEL_API_KEY: "fake-key",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GEMINI_API_KEY: fakeLiveUrl ? "test-key" : "",
    GEMINI_LIVE_ENDPOINT: fakeLiveUrl || "",
    VOICE_PROVIDER: "gemini-live",
    GEMINI_LIVE_VOICE: ENV_DEFAULT_VOICE,
  };
}

// --- Shared helpers -------------------------------------------------------

function waitForServerListening(server) {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // starting
    }
    if (logs.exited) throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

function openVoiceClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const timeout = setTimeout(() => {
      closeWebSocketQuietly(ws);
      reject(new Error(`timed out opening ${wsUrl}`));
    }, 3000);
    ws.once("open", () => { clearTimeout(timeout); resolve(ws); });
    ws.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

function sendJsonWs(ws, payload) {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(payload), (error) => (error ? reject(error) : resolve()));
  });
}

// Poll a growing events array for the first entry matching predicate.
async function waitForEvent(events, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await sleep(25);
  }
  throw new Error(`timed out waiting for voice session event; saw: ${JSON.stringify(events.map((e) => e.type))}`);
}

function closeWebSocketQuietly(ws) {
  try { ws.close(1000, "smoke complete"); } catch { /* ignore */ }
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
  child.on("exit", () => { logs.exited = true; });
  const logs = { exited: false, text: () => output };
  return logs;
}

async function onceExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => child.kill("SIGKILL")),
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
