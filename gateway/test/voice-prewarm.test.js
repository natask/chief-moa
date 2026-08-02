"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WebSocket } = require("ws");
const { startVoicePrewarm } = require("../lib/voice-prewarm");
const { createReasonerStage, createTtsStage } = require("../lib/voice-stages");
const { createVoiceSessionServer } = require("../lib/voice-session-server");

const FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };

test("stage prewarm is an optional no-op capability", async () => {
  const reasoner = createReasonerStage({ run: async () => ({}) });
  const tts = createTtsStage({ synthesize: async () => Buffer.alloc(0) });
  assert.equal(reasoner.capabilities.connection_prewarm, false);
  assert.equal(tts.capabilities.connection_prewarm, false);
  await reasoner.prewarm();
  await tts.prewarm();
});

test("prewarm failure is logged without transcript content", async () => {
  const logs = [];
  const provider = {
    reasonerStage: createReasonerStage({
      prewarm: async () => { throw new Error("transport unavailable"); },
      run: async () => ({}),
    }),
  };
  startVoicePrewarm(provider, {
    sessionId: "failure-session",
    branchId: "default",
    turnId: "failure-turn",
    effectiveProfile: { reasoning_provider: "gateway", model: "fixture" },
    syntheticText: "never log this transcript",
  }, (line) => logs.push(JSON.parse(line)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].at, "voice_prewarm_failed");
  assert.equal(logs[0].error, "transport unavailable");
  assert.equal(JSON.stringify(logs).includes("never log this transcript"), false);
});

test("content-free prewarm starts once at session_start and never blocks readiness", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-prewarm-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let prewarmCalls = 0;
  let releasePrewarm;
  const prewarmGate = new Promise((resolve) => { releasePrewarm = resolve; });
  const provider = {
    reasonerStage: createReasonerStage({
      prewarm: async (input) => {
        prewarmCalls += 1;
        assert.deepEqual(Object.keys(input).sort(), ["branch_id", "profile", "session_id", "turn_id"]);
        assert.equal(JSON.stringify(input).includes("spoken secret"), false);
        await prewarmGate;
      },
      run: async () => ({}),
    }),
    ttsStage: createTtsStage({ synthesize: async () => Buffer.alloc(0) }),
    status: () => ({ provider: "prewarm-test", configured: true, assistant_audio_format: FORMAT }),
    async processTurn() {
      return {
        provider: "prewarm-test",
        model: "fixture",
        transcript: "spoken secret",
        assistant_text: "",
        transcription_only: true,
      };
    },
  };
  const service = await startServer(dataDir, provider);
  const client = await connect(service.url);
  t.after(async () => {
    releasePrewarm();
    await client.close();
    await service.close();
  });

  client.send({
    type: "session_start",
    session_id: "prewarm-session",
    branch_id: "default",
    turn_id: "prewarm-turn",
    format: FORMAT,
  });
  await client.next("session_ready");
  assert.equal(prewarmCalls, 1, "readiness must arrive while prewarm remains unresolved");
  client.audio(Buffer.alloc(320));
  client.send({ type: "commit_turn", turn_id: "prewarm-turn" });
  await client.next("turn_done");
  assert.equal(prewarmCalls, 1, "commit_turn must not prewarm again");
  releasePrewarm();
});

async function startServer(dataDir, provider) {
  const voice = createVoiceSessionServer({ dataDir, voiceProvider: provider, heartbeatIntervalMs: 0 });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => voice.handleUpgrade(request, socket, head));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}${voice.endpoint}`,
    async close() {
      await new Promise((resolve) => voice.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const events = [];
  const waiters = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const event = JSON.parse(Buffer.from(data).toString("utf8"));
    const index = waiters.findIndex((waiter) => waiter.type === event.type);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(event);
    else events.push(event);
  });
  return {
    send: (event) => ws.send(JSON.stringify(event)),
    audio: (bytes) => ws.send(bytes),
    next(type) {
      const index = events.findIndex((event) => event.type === type);
      if (index >= 0) return Promise.resolve(events.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 5000);
        waiters.push({ type, resolve: (event) => { clearTimeout(timeout); resolve(event); } });
      });
    },
    close: () => ws.readyState === WebSocket.CLOSED
      ? Promise.resolve()
      : new Promise((resolve) => { ws.once("close", resolve); ws.close(); }),
  };
}
