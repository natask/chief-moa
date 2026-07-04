#!/usr/bin/env node
"use strict";

// Smoke for interrupted Gemini Live handoff: a live voice turn that is cut off
// mid-stream (here, the client socket drops) must still land in the canonical
// conversation history with whatever transcript/assistant text the provider
// produced, and that partial turn must flow into the NEXT live session's
// Moa-owned context pack. This is what lets the user interrupt the model on one
// device and pick the thread up on another ("move information from one to the
// other").
//
// Boots `node server.js` against a fake Gemini Live WebSocket so no real key or
// network is touched. The fake captures each setup payload (the context pack
// lives in systemInstruction) and emits a partial transcript + partial answer
// as soon as it receives audio, never completing the first turn.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket, WebSocketServer } = require("ws");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "live-interrupt-smoke-token";
const PARTIAL_TRANSCRIPT = "my favorite color is teal";
const PARTIAL_ANSWER = "Your favorite color is being noted as te";
const TOOL_TRANSCRIPT = "fix the browser continuity context";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-live-interrupt-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const fake = await startFakeLive();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/v1/voice/sessions`;
  const sessionId = `live_handoff_${Date.now().toString(36)}`;
  let server;

  try {
    server = await startGateway({ port, dataDir, fakeUrl: fake.url });

    // Device A: start a live turn, get a partial transcript, then drop the
    // socket mid-turn (interruption).
    const turn1 = `t1_${Date.now().toString(36)}`;
    await step("interrupted turn persists to canonical history", () =>
      runInterruptedTurn(wsUrl, sessionId, turn1));

    // The interrupted partial must be queryable like any other history turn.
    await step("interrupted turn is queryable and marked incomplete", () =>
      assertInterruptedHistory(baseUrl, sessionId, turn1));

    // Device B: a fresh live session on the same session id must receive the
    // interrupted partial inside its context pack.
    const turn2 = `t2_${Date.now().toString(36)}`;
    await step("next live session carries the interrupted partial in its context pack", () =>
      assertHandoffContext(wsUrl, sessionId, turn2, fake));

    await step("live tool-launched run carries all-branch browser context", () =>
      assertLiveToolLaunchContext(baseUrl, wsUrl, dataDir, sessionId));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      session_id: sessionId,
      checks: [
        "a live turn interrupted by a dropped socket is stored as a canonical turn",
        "the stored turn keeps the partial transcript + partial assistant text",
        "GET /v1/sessions/:id/turns lists it; context marks incomplete=true",
        "the next live session's setup context pack includes the interrupted partial",
        "a live tool-launched run from a later browser cue includes prior cue context",
      ],
    }, null, 2));
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    await fake.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runInterruptedTurn(wsUrl, sessionId, turnId) {
  const ws = await openClient(wsUrl);
  try {
    await sendJsonWs(ws, {
      type: "session_start",
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: "default",
      turn_id: turnId,
      format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    });
    await waitForEvent(ws, (msg) => msg.type === "session_ready" && msg.turn_id === turnId);
    ws.send(Buffer.alloc(640, 1));
    // Wait until the gateway has captured the partial transcript for this turn.
    await waitForEvent(ws, (msg) => msg.type === "transcript_partial" && msg.turn_id === turnId);
    await waitForEvent(ws, (msg) => msg.type === "assistant_text" && msg.turn_id === turnId);
  } finally {
    // Drop the socket mid-turn: this is the interruption.
    ws.terminate();
  }
}

async function assertInterruptedHistory(baseUrl, sessionId, turnId) {
  const history = await pollFor(async () => {
    const json = await getJson(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/turns`);
    const turn = (json.turns || []).find((t) => t.turn_id === turnId);
    return turn ? json : null;
  }, 5000, "interrupted turn never appeared in session history");

  const turn = history.turns.find((t) => t.turn_id === turnId);
  assert.ok(turn, "interrupted turn must be present in /turns");
  assert.equal(turn.classification, "interrupted", "interrupted turn must be classified as interrupted");
  assert.ok(
    turn.transcript.includes("teal"),
    `interrupted turn must keep the partial transcript, got: ${turn.transcript}`
  );
  assert.ok(
    String(turn.reply || "").length > 0,
    "interrupted turn must keep the partial assistant text"
  );

  const context = await getJson(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/context`);
  const record = (context.turns || []).find((t) => t.turn_id === turnId);
  assert.ok(record, "interrupted turn must be present in /context");
  const voiceSession = record.references?.voice_session || {};
  assert.equal(voiceSession.incomplete, true, "context record must mark the turn incomplete");
  assert.ok(
    String(voiceSession.status || "").length > 0,
    "context record must carry the interruption status"
  );
}

async function assertHandoffContext(wsUrl, sessionId, turnId, fake) {
  const beforeCount = fake.setups.length;
  const ws = await openClient(wsUrl);
  try {
    await sendJsonWs(ws, {
      type: "session_start",
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: "default",
      turn_id: turnId,
      format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    });
    await waitForEvent(ws, (msg) => msg.type === "session_ready" && msg.turn_id === turnId);
    // The setup for THIS new session must have been captured by the fake, and
    // its context pack must replay the interrupted partial.
    const setup = await pollFor(
      () => (fake.setups.length > beforeCount ? fake.setups[fake.setups.length - 1] : null),
      3000,
      "no setup captured for the second live session"
    );
    assert.ok(
      setup.systemText.includes("teal"),
      `handoff context pack must replay the interrupted partial, got: ${setup.systemText.slice(0, 400)}`
    );
    assert.ok(
      /interrupted/i.test(setup.systemText),
      "handoff context pack should flag the prior turn as interrupted"
    );
  } finally {
    ws.terminate();
  }
}

async function assertLiveToolLaunchContext(baseUrl, wsUrl, dataDir, sessionId) {
  const marker = "browser persistence smoke marker is cobalt";
  const seed = await postJson(`${baseUrl}/v1/voice/turns`, {
    source: "agee-extension",
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: "cue_a",
    turn_id: "voice_browser_tool_seed",
    transcript: `The ${marker}.`,
  });
  assert.equal(seed.session_id, sessionId, "seed browser voice turn must keep session id");
  assert.equal(seed.branch_id, "cue_a", "seed browser voice turn must keep its cue branch");

  const ws = await openClient(wsUrl);
  try {
    const turnId = `tool_${Date.now().toString(36)}`;
    await sendJsonWs(ws, {
      type: "session_start",
      source: "agee-extension",
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: "cue_b",
      turn_id: turnId,
      all_branches_context: true,
      format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    });
    await waitForEvent(ws, (msg) => msg.type === "session_ready" && msg.turn_id === turnId);
    ws.send(Buffer.alloc(640, 2));
    await sendJsonWs(ws, { type: "commit_turn", turn_id: turnId });
    const toolResponse = await waitForEvent(ws, (msg) => msg.type === "tool_response" && msg.turn_id === turnId);
    await waitForEvent(ws, (msg) => msg.type === "turn_done" && msg.turn_id === turnId);

    const runId = toolResponse.responses?.[0]?.response?.run?.id;
    assert.ok(runId, `tool response must include a launched run id, got ${JSON.stringify(toolResponse)}`);
    const detail = await pollFor(async () => {
      const payload = await getJson(`${baseUrl}/v1/agent/runs/${encodeURIComponent(runId)}`);
      return payload.run?.status === "completed" ? payload : null;
    }, 5000, "live tool-launched run did not complete");
    assert.match(
      detail.run.prompt,
      new RegExp(marker),
      "live tool-launched run prompt must include prior browser cue context",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dataDir, "agent-runs", `${runId}.json`), "utf8")).harness,
      "echo",
      "live tool smoke must use deterministic echo harness",
    );
  } finally {
    ws.terminate();
  }
}

async function startFakeLive() {
  const setups = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  wss.on("connection", (ws) => {
    let marker = 0;
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(Buffer.from(data).toString("utf8"));
      } catch {
        return;
      }
      if (message.setup) {
        const parts = message.setup.systemInstruction?.parts || [];
        setups.push({ systemText: parts.map((p) => String(p.text || "")).join("\n") });
        ws.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (message.toolResponse) {
        ws.send(JSON.stringify({
          serverContent: {
            outputTranscription: { text: "Started continuity tool run." },
            turnComplete: true,
          },
        }));
        return;
      }
      if (message.realtimeInput?.audioStreamEnd) {
        ws.send(JSON.stringify({
          toolCall: {
            functionCalls: [{
              id: "tool_call_all_branch_context",
              name: "launch_agent_run",
              args: {
                prompt: "Inspect the browser continuity context.",
                harness: "echo",
              },
            }],
          },
        }));
        return;
      }
      if (message.realtimeInput?.audio) {
        marker = Buffer.from(String(message.realtimeInput.audio.data || ""), "base64")[0] || 0;
        if (marker === 2) {
          ws.send(JSON.stringify({
            serverContent: {
              inputTranscription: { text: TOOL_TRANSCRIPT },
            },
          }));
          return;
        }
        // Emit a partial transcript + partial answer, but never turnComplete:
        // the turn stays open so the client-side interruption is what ends it.
        ws.send(JSON.stringify({
          serverContent: {
            inputTranscription: { text: PARTIAL_TRANSCRIPT },
            modelTurn: { parts: [{ text: PARTIAL_ANSWER }] },
          },
        }));
      }
    });
  });
  const { port } = wss.address();
  return {
    url: `ws://127.0.0.1:${port}/v1beta/fake-live`,
    setups,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
}

async function startGateway({ port, dataDir, fakeUrl }) {
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
      GBRAIN_HOME: path.join(path.dirname(dataDir), "gbrain"),
      MOA_GATEWAY_TOKEN: TOKEN,
      MODEL_PROVIDER: "openai-compatible",
      MODEL_ID: "live-interrupt-smoke-model",
      MODEL_API_KEY: "",
      VOICE_PROVIDER: "gemini-live",
      VOICE_STT_PROVIDER: "gemini-live",
      VOICE_LLM_PROVIDER: "gemini-live",
      VOICE_TTS_PROVIDER: "gemini-live",
      GEMINI_API_KEY: "live-interrupt-smoke-key",
      GEMINI_LIVE_ENDPOINT: fakeUrl,
      GEMINI_LIVE_MODEL: "fake-live-model",
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
      // still starting
    }
    if (logs.exited) {
      throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

function openClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
    ws._inbox = [];
    ws._waiters = [];
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(Buffer.from(data).toString("utf8"));
      } catch {
        return;
      }
      ws._inbox.push(msg);
      for (const waiter of ws._waiters.splice(0)) {
        waiter();
      }
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitForEvent(ws, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const index = ws._inbox.findIndex((msg) => predicate(msg));
      if (index >= 0) {
        resolve(ws._inbox[index]);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timed out waiting for a matching voice-session event"));
        return;
      }
      ws._waiters.push(check);
      setTimeout(check, 50);
    };
    check();
  });
}

function sendJsonWs(ws, payload) {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(payload), (error) => (error ? reject(error) : resolve()));
  });
}

async function pollFor(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(message);
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const json = await response.json();
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
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

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
