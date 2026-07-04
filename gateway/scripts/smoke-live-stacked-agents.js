#!/usr/bin/env node
"use strict";

// Smoke for Gemini Live-launched stacked agent runs:
// - barge-in interrupts only the spoken Live turn, not the detached run
// - later Live turns can launch additional runs in the same conversation
// - Live tools can list and cancel those runs through the real gateway server

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket, WebSocketServer } = require("ws");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "live-stacked-agents-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-live-stacked-agents-"));
  const dataDir = path.join(tempDir, "data");
  const harnessBin = writeSlowEchoHarness(tempDir);
  const sessionId = `stacked_${Date.now().toString(36)}`;
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

    // Turn 1: the live model launches detached run A (slow harness, still
    // running after the turn), then the live turn completes normally.
    const turn1 = `stack_a_${Date.now().toString(36)}`;
    await startTurn(ws, sessionId, turn1);
    await commitTurn(ws, turn1);
    const launchA = await waitForToolResponse(ws, turn1, "launch_agent_run");
    const runAId = launchA.run?.id;
    assert.ok(runAId, `turn 1 tool response must include run A id: ${JSON.stringify(launchA)}`);
    await waitForEvent(ws, (msg) => msg.type === "turn_done" && msg.turn_id === turn1);

    // Interruption: canceling a live turn must NOT cancel the detached run A.
    // Run A is still executing here; we do not wait for it yet.
    const turn2 = `stack_barge_${Date.now().toString(36)}`;
    await startTurn(ws, sessionId, turn2);
    await sendJsonWs(ws, { type: "cancel_turn", turn_id: turn2 });
    await waitForEvent(ws, (msg) => msg.type === "turn_done" && msg.turn_id === turn2 && msg.status === "canceled");
    const runAAfterBarge = await getJson(`${baseUrl}/v1/agent/runs/${encodeURIComponent(runAId)}`);
    assert.notEqual(runAAfterBarge.run.status, "canceled", "a live-turn cancel must not cancel detached run A");

    // Turn 3: stack run B beside the still-running run A.
    const turn3 = `stack_b_${Date.now().toString(36)}`;
    await startTurn(ws, sessionId, turn3);
    await commitTurn(ws, turn3);
    const launchB = await waitForToolResponse(ws, turn3, "launch_agent_run");
    const runBId = launchB.run?.id;
    assert.ok(runBId, `turn 3 tool response must include run B id: ${JSON.stringify(launchB)}`);
    assert.notEqual(runBId, runAId, "stacked runs must have distinct ids");
    await waitForEvent(ws, (msg) => msg.type === "turn_done" && msg.turn_id === turn3);

    // Both stacked runs reach completion.
    const completedA = await waitForRunStatus(baseUrl, runAId, "completed", 8000);
    const completedB = await waitForRunStatus(baseUrl, runBId, "completed", 8000);
    assert.equal(completedA.run.status, "completed", "run A must complete after the interruption");
    assert.equal(completedB.run.status, "completed", "run B must complete");

    // Turn 4: list_agent_runs surfaces both runs for this conversation.
    const turn4 = `stack_list_${Date.now().toString(36)}`;
    await startTurn(ws, sessionId, turn4);
    await commitTurn(ws, turn4, 2);
    const listed = await waitForToolResponse(ws, turn4, "list_agent_runs");
    assert.equal(listed.type, "agent_runs", "list tool must return agent_runs");
    assert.ok(
      (listed.runs || []).some((run) => run.id === runAId),
      `list tool must include run A: ${JSON.stringify(listed)}`,
    );
    assert.ok(
      (listed.runs || []).some((run) => run.id === runBId),
      `list tool must include run B: ${JSON.stringify(listed)}`,
    );
    await waitForEvent(ws, (msg) => msg.type === "turn_done" && msg.turn_id === turn4);

    // Turn 5: launch run C then cancel it through the live cancel_agent_run tool.
    const turn5 = `stack_cancel_${Date.now().toString(36)}`;
    await startTurn(ws, sessionId, turn5);
    await commitTurn(ws, turn5, 3);
    const launchC = await waitForToolResponse(ws, turn5, "launch_agent_run");
    const runCId = launchC.run?.id;
    assert.ok(runCId, `cancel turn launch response must include run C id: ${JSON.stringify(launchC)}`);
    const canceled = await waitForToolResponse(ws, turn5, "cancel_agent_run");
    assert.equal(canceled.type, "agent_runs_canceled", "cancel tool must return agent_runs_canceled");
    assert.equal(canceled.count, 1, `cancel tool must cancel one run: ${JSON.stringify(canceled)}`);
    assert.ok(
      (canceled.canceled || []).some((run) => run.id === runCId),
      `cancel tool response must include run C: ${JSON.stringify(canceled)}`,
    );
    await waitForEvent(ws, (msg) => msg.type === "turn_done" && msg.turn_id === turn5);
    const canceledC = await waitForRunStatus(baseUrl, runCId, "canceled", 8000);
    assert.equal(canceledC.run.status, "canceled", "run C must become canceled");

    console.log("smoke-live-stacked-agents: ok");
  } finally {
    if (ws) {
      ws.terminate();
    }
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    if (fake) {
      await fake.close();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeSlowEchoHarness(tempDir) {
  const filePath = path.join(tempDir, "slow-echo-harness.js");
  fs.writeFileSync(filePath, [
    "#!/usr/bin/env node",
    '"use strict";',
    'if (process.argv.includes("--version")) {',
    '  console.log("slow-echo-smoke 1.0.0");',
    "  process.exit(0);",
    "}",
    "const prompt = process.argv[process.argv.length - 1] || '';",
    "const delay = Number(process.env.SLOW_ECHO_DELAY_MS || 1200);",
    "setTimeout(() => {",
    "  const oneLine = String(prompt).replace(/\\s+/g, ' ').trim().slice(0, 200);",
    "  console.log('Slow echo harness completed.');",
    "  console.log('Intent: ' + (oneLine || '(empty)'));",
    "}, delay);",
    "",
  ].join("\n"));
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

async function startFakeLive() {
  const calls = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await waitForListening(wss);

  wss.on("connection", (ws) => {
    // The scenario is decoded from the first audio marker byte the client sends,
    // so it never depends on connection order (a canceled turn's socket can
    // register out of order). marker 2 -> list; 3 -> launch+cancel; else launch.
    let scenario = "launch";
    let cancelSent = false;

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
        const marker = Buffer.from(String(audio.data), "base64")[0];
        scenario = marker === 2 ? "list" : marker === 3 ? "launch-and-cancel" : "launch";
        calls.push({ scenario });
        return;
      }

      if (message.toolResponse) {
        const response = message.toolResponse.functionResponses?.[0]?.response || {};
        if (scenario === "launch-and-cancel" && !cancelSent) {
          const launchedRunId = response.run?.id || "";
          assert.ok(launchedRunId, `launch-and-cancel must receive launched run id: ${JSON.stringify(message.toolResponse)}`);
          cancelSent = true;
          ws.send(JSON.stringify({
            toolCall: {
              functionCalls: [{
                id: "tool_cancel_c",
                name: "cancel_agent_run",
                args: { run_id: launchedRunId },
              }],
            },
          }));
          return;
        }

        ws.send(JSON.stringify({
          serverContent: {
            outputTranscription: { text: "Tool result handled." },
            turnComplete: true,
          },
        }));
        return;
      }

      if (message.realtimeInput?.audioStreamEnd || message.realtimeInput?.activityEnd) {
        if (scenario === "list") {
          ws.send(JSON.stringify({
            toolCall: {
              functionCalls: [{
                id: "tool_list_runs",
                name: "list_agent_runs",
                args: { limit: 10 },
              }],
            },
          }));
          return;
        }

        ws.send(JSON.stringify({
          toolCall: {
            functionCalls: [{
              id: scenario === "launch-and-cancel" ? "tool_launch_c" : "tool_launch",
              name: "launch_agent_run",
              args: {
                prompt: scenario === "launch-and-cancel"
                  ? "Run C should be canceled by live voice tool control."
                  : "A stacked agent run launched from live voice.",
                harness: "echo",
              },
            }],
          },
        }));
      }
    });
  });

  const { port } = wss.address();
  return {
    url: `ws://127.0.0.1:${port}/v1beta/fake-live`,
    calls,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
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
      MODEL_ID: "live-stacked-agents-smoke-model",
      MODEL_API_KEY: "",
      VOICE_PROVIDER: "gemini-live",
      VOICE_STT_PROVIDER: "gemini-live",
      VOICE_LLM_PROVIDER: "gemini-live",
      VOICE_TTS_PROVIDER: "gemini-live",
      GEMINI_API_KEY: "live-stacked-agents-smoke-key",
      GEMINI_LIVE_ENDPOINT: fakeUrl,
      GEMINI_LIVE_MODEL: "fake-live-model",
      ECHO_HARNESS_BIN: harnessBin,
      SLOW_ECHO_DELAY_MS: "1200",
      AGENT_RUN_TIMEOUT_MS: "10000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

async function startTurn(ws, sessionId, turnId) {
  await sendJsonWs(ws, {
    type: "session_start",
    session_id: sessionId,
    conversation_id: sessionId,
    branch_id: "default",
    turn_id: turnId,
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
  });
  await waitForEvent(ws, (msg) => msg.type === "session_ready" && msg.turn_id === turnId);
}

async function commitTurn(ws, turnId, marker = 1) {
  // The audio bytes double as a deterministic scenario marker for the fake Live
  // server (1 launch, 2 list, 3 launch+cancel).
  ws.send(Buffer.alloc(640, marker));
  await sendJsonWs(ws, { type: "commit_turn", turn_id: turnId });
}

async function waitForToolResponse(ws, turnId, name) {
  const event = await waitForEvent(ws, (msg) => {
    if (msg.type !== "tool_response" || msg.turn_id !== turnId) return false;
    return (msg.responses || []).some((response) => response.name === name);
  }, 7000);
  const entry = (event.responses || []).find((response) => response.name === name);
  assert.ok(entry, `tool_response missing ${name}: ${JSON.stringify(event)}`);
  return entry.response || {};
}

async function waitForRunStatus(baseUrl, runId, status, timeoutMs) {
  return pollFor(async () => {
    const payload = await getJson(`${baseUrl}/v1/agent/runs/${encodeURIComponent(runId)}`);
    return payload.run?.status === status ? payload : null;
  }, timeoutMs, `run ${runId} did not reach ${status}`);
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
        reject(new Error(`timed out waiting for a matching voice-session event; inbox: ${JSON.stringify(ws._inbox.map((m) => ({ t: m.type, turn: m.turn_id, msg: m.message, names: (m.responses || []).map((r) => r.name) })))}`));
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

async function pollFor(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(message);
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
