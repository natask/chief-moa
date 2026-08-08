#!/usr/bin/env node
"use strict";

// End-to-end durable-routing smoke for completed Gemini Live turns. The fake
// Live endpoint emits only user transcripts for most cases; the gateway must
// produce the response that should have happened from the captured transcript
// without requiring a second client POST to /v1/voice/turns.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket, WebSocketServer } = require("ws");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "live-durable-routing-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-live-durable-routing-"));
  const dataDir = path.join(tempDir, "data");
  const harnessBin = writeEchoHarness(tempDir);
  const sessionId = `durable_${Date.now().toString(36)}`;
  let fake;
  let server;
  let ws;

  try {
    fake = await startFakeLive();
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/v1/voice/sessions`;

    server = await startGateway({ port, dataDir, fakeUrl: fake.url, harnessBin });
    ws = await openClient(wsUrl);

    const agentTurn = `agent_${Date.now().toString(36)}`;
    await runTurn(ws, sessionId, agentTurn, 1);
    const agentRecord = await voiceTurn(baseUrl, sessionId, agentTurn);
    assert.equal(agentRecord.classification, "agent_run");
    assert.equal(agentRecord.transcript, "fix the bug");
    assert.ok(agentRecord.assistant_text.includes("Started"), `agent turn did not start a run: ${JSON.stringify(agentRecord)}`);
    assert.equal(agentRecord.references.agent_run_ids.length, 1);
    assert.equal(agentRecord.references.voice_session.transcription_only, false);

    const timeTurn = `time_${Date.now().toString(36)}`;
    await runTurn(ws, sessionId, timeTurn, 2);
    const timeRecord = await voiceTurn(baseUrl, sessionId, timeTurn);
    assert.equal(timeRecord.classification, "chat");
    assert.equal(timeRecord.transcript, "what time is it");
    assert.ok(timeRecord.assistant_text.startsWith("It's "), `time reply was not generated locally: ${JSON.stringify(timeRecord)}`);

    const chatTurn = `chat_${Date.now().toString(36)}`;
    await runTurn(ws, sessionId, chatTurn, 3);
    const chatRecord = await voiceTurn(baseUrl, sessionId, chatTurn);
    assert.equal(chatRecord.classification, "chat");
    assert.equal(chatRecord.transcript, "hello can you hear me");
    assert.equal(chatRecord.assistant_text, "Ready.");

    const blockedTurn = `blocked_profile_${Date.now().toString(36)}`;
    await startTurn(ws, sessionId, blockedTurn);
    await commitTurn(ws, blockedTurn, 4);
    const blockedTool = await waitForToolResponse(ws, blockedTurn, "update_agent_profile");
    assert.equal(blockedTool.type, "live_tool_blocked");
    assert.match(blockedTool.error, /transcript did not request/i);
    await waitForEvent(ws, (msg) => msg.type === "turn_done" && msg.turn_id === blockedTurn && msg.status === "completed", 7000);
    const blockedRecord = await voiceTurn(baseUrl, sessionId, blockedTurn);
    assert.equal(blockedRecord.transcript, "hello there");
    assert.ok(
      blockedRecord.references.voice_session.provider_events.some((event) => event.type === "tool_result" && event.result?.type === "live_tool_blocked"),
      `blocked profile tool result was not retained in provider events: ${JSON.stringify(blockedRecord.references.voice_session.provider_events)}`,
    );

    const blockedMemoryTurn = `blocked_memory_${Date.now().toString(36)}`;
    await startTurn(ws, sessionId, blockedMemoryTurn);
    await commitTurn(ws, blockedMemoryTurn, 5);
    const blockedMemoryTool = await waitForToolResponse(ws, blockedMemoryTurn, "remember_user_fact");
    assert.equal(blockedMemoryTool.type, "live_tool_blocked");
    assert.match(blockedMemoryTool.error, /memory request/i);
    await waitForEvent(ws, (msg) => msg.type === "turn_done" && msg.turn_id === blockedMemoryTurn && msg.status === "completed", 7000);

    console.log("smoke-live-durable-routing: ok");
  } finally {
    if (ws) ws.terminate();
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    if (fake) await fake.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeEchoHarness(tempDir) {
  const filePath = path.join(tempDir, "echo-harness.js");
  fs.writeFileSync(filePath, [
    "#!/usr/bin/env node",
    '"use strict";',
    'if (process.argv.includes("--version")) {',
    '  console.log("echo-harness 1.0.0");',
    "  process.exit(0);",
    "}",
    "const prompt = process.argv[process.argv.length - 1] || '';",
    "console.log(String(prompt).replace(/\\s+/g, ' ').trim().slice(0, 200));",
    "",
  ].join("\n"));
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

async function startFakeLive() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await waitForListening(wss);

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
        ws.send(JSON.stringify({ setupComplete: {} }));
        return;
      }

      const audio = message.realtimeInput?.audio;
      if (audio?.data) {
        marker = Buffer.from(String(audio.data), "base64")[0] || 0;
        return;
      }

      if (message.toolResponse) {
        ws.send(JSON.stringify({
          serverContent: {
            outputTranscription: { text: "Tool result handled." },
            turnComplete: true,
          },
        }));
        return;
      }

      if (message.realtimeInput?.audioStreamEnd || message.realtimeInput?.activityEnd) {
        const transcript = transcriptForMarker(marker);
        ws.send(JSON.stringify({
          serverContent: {
            inputTranscription: { text: transcript },
          },
        }));
        if (marker === 4) {
          // A non-language field: language fields are model-owned now (no
          // transcript parser to confirm them), so only a patch like voice —
          // which still requires the deterministic parser's confirmation —
          // exercises the blocked path.
          ws.send(JSON.stringify({
            toolCall: {
              functionCalls: [{
                id: "tool_bad_profile",
                name: "update_agent_profile",
                args: {
                  profile: { voice: "Kore" },
                  reason: "model_inferred_voice_change",
                },
              }],
            },
          }));
          return;
        }
        if (marker === 5) {
          ws.send(JSON.stringify({
            toolCall: {
              functionCalls: [{
                id: "tool_bad_memory",
                name: "remember_user_fact",
                args: {
                  fact: "The user likes cobalt.",
                  kind: "preference",
                },
              }],
            },
          }));
          return;
        }
        ws.send(JSON.stringify({
          serverContent: {
            outputTranscription: { text: "Ready." },
            turnComplete: true,
          },
        }));
      }
    });
  });

  const { port } = wss.address();
  return {
    url: `ws://127.0.0.1:${port}/v1beta/fake-live`,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
}

function transcriptForMarker(marker) {
  if (marker === 1) return "fix the bug";
  if (marker === 2) return "what time is it";
  if (marker === 4) return "hello there";
  if (marker === 5) return "hello there";
  return "hello can you hear me";
}

async function startGateway({ port, dataDir, fakeUrl, harnessBin }) {
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
      MODEL_ID: "live-durable-routing-smoke-model",
      MODEL_API_KEY: "",
      VOICE_PROVIDER: "gemini-live",
      VOICE_STT_PROVIDER: "gemini-live",
      VOICE_LLM_PROVIDER: "gemini-live",
      VOICE_TTS_PROVIDER: "gemini-live",
      GEMINI_API_KEY: "live-durable-routing-smoke-key",
      GEMINI_LIVE_ENDPOINT: fakeUrl,
      GEMINI_LIVE_MODEL: "fake-live-model",
      ECHO_HARNESS_BIN: harnessBin,
      AGENT_RUN_TIMEOUT_MS: "10000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

async function runTurn(ws, sessionId, turnId, marker) {
  await startTurn(ws, sessionId, turnId);
  await commitTurn(ws, turnId, marker);
  await waitForEvent(ws, (msg) => msg.type === "turn_done" && msg.turn_id === turnId && msg.status === "completed", 7000);
}

async function startTurn(ws, sessionId, turnId) {
  await sendJsonWs(ws, {
    type: "session_start",
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: "default",
    turn_id: turnId,
    source: "live-durable-routing-smoke",
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
  });
  await waitForEvent(ws, (msg) => msg.type === "session_ready" && msg.turn_id === turnId);
}

async function commitTurn(ws, turnId, marker) {
  ws.send(Buffer.alloc(640, marker));
  await sendJsonWs(ws, { type: "commit_turn", turn_id: turnId });
}

async function voiceTurn(baseUrl, sessionId, turnId) {
  return getJson(`${baseUrl}/v1/voice/turns/${encodeURIComponent(turnId)}?session_id=${encodeURIComponent(sessionId)}`);
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

function waitForToolResponse(ws, turnId, name) {
  return waitForEvent(ws, (msg) => {
    if (msg.type !== "tool_response" || msg.turn_id !== turnId) return false;
    return (msg.responses || []).some((response) => response.name === name);
  }, 7000).then((event) => {
    const entry = (event.responses || []).find((response) => response.name === name);
    assert.ok(entry, `tool_response missing ${name}: ${JSON.stringify(event)}`);
    return entry.response || {};
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
        reject(new Error(`timed out waiting for voice event; inbox: ${JSON.stringify(ws._inbox.map((m) => ({
          t: m.type,
          turn: m.turn_id,
          msg: m.message,
          names: (m.responses || []).map((r) => r.name),
        })))}`));
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

async function getJson(url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const json = await response.json();
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
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

function waitForListening(server) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
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
    if (output.length > 16000) output = output.slice(-16000);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
