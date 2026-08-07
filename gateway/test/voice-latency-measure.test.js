"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WebSocket } = require("ws");
const { createVoiceSessionServer } = require("../lib/voice-session-server");

const FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };

test("records final-clause count and dead time only when latency measurement is enabled", async (t) => {
  let nowMs = 1000;
  const provider = fakeStreamingProvider();
  const service = await startServer(provider, { VOICE_LATENCY_MEASURE: "1" }, () => nowMs);
  const client = await connect(service.url);
  t.after(async () => { await client.close(); await service.close(); });

  client.send({
    type: "session_start", session_id: "latency-session", branch_id: "default",
    turn_id: "latency-turn", format: FORMAT,
  });
  await client.next("session_ready");
  await provider.emitFinal({ transcript: "never persisted in latency evidence" });
  nowMs = 1125;
  await provider.emitFinal({ transcript: "second private clause" });
  nowMs = 1250;
  await provider.emitFinal({ transcript: "third private clause" });
  nowMs = 1700;
  client.audio(Buffer.alloc(320));
  client.send({ type: "commit_turn", turn_id: "latency-turn" });
  const done = await client.next("turn_done");

  assert.equal(done.stage_timings.stt_ms, 125);
  assert.equal(done.stage_timings.reasoning_ms, 250);
  assert.equal(done.stage_timings.tts_ms, 375);
  assert.equal(done.reasoner_first_delta_ms, 225);

  const events = providerEvents(service.dataDir)
    .filter((event) => event.type === "voice_latency_clause_boundaries");
  assert.equal(events.length, 1);
  assert.equal(events[0].clause_count, 3);
  assert.equal(events[0].first_clause_to_commit_ms, 700);
  assert.equal(JSON.stringify(events).includes("private clause"), false);
});

test("latency measurement is off by default", async (t) => {
  const provider = fakeStreamingProvider();
  const service = await startServer(provider, {}, () => 1000);
  const client = await connect(service.url);
  t.after(async () => { await client.close(); await service.close(); });

  client.send({
    type: "session_start", session_id: "plain-session", branch_id: "default",
    turn_id: "plain-turn", format: FORMAT,
  });
  await client.next("session_ready");
  await provider.emitFinal({ transcript: "ordinary final clause" });
  client.audio(Buffer.alloc(320));
  client.send({ type: "commit_turn", turn_id: "plain-turn" });
  await client.next("turn_done");

  assert.equal(providerEvents(service.dataDir)
    .some((event) => event.type === "voice_latency_clause_boundaries"), false);
});

function fakeStreamingProvider() {
  let hooks;
  return {
    status: () => ({ provider: "latency-fixture", configured: true, assistant_audio_format: FORMAT }),
    createStreamingSttSession(_turn, value) {
      hooks = value;
      return { push() {}, abort() {} };
    },
    emitFinal: (segment) => hooks.onTranscriptFinalSegment(segment),
    async processTurn(_turn, providerHooks) {
      await providerHooks.onStageStart("stt");
      await providerHooks.onStageDone("stt", { duration_ms: 125 });
      await providerHooks.onStageStart("reasoning");
      await providerHooks.onStageDone("reasoning", { duration_ms: 250 });
      await providerHooks.onStageStart("tts");
      await providerHooks.onStageDone("tts", { duration_ms: 375 });
      return {
        provider: "latency-fixture", model: "fixture", transcript: "fixture transcript",
        assistant_text: "", transcription_only: true, reasoner_first_delta_ms: 225,
      };
    },
  };
}

async function startServer(provider, env, voiceLatencyNow) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-latency-"));
  const voice = createVoiceSessionServer({
    dataDir, voiceProvider: provider, heartbeatIntervalMs: 0, env, voiceLatencyNow,
  });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => voice.handleUpgrade(request, socket, head));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    dataDir,
    url: `ws://127.0.0.1:${server.address().port}${voice.endpoint}`,
    async close() {
      await new Promise((resolve) => voice.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function providerEvents(dataDir) {
  const file = path.join(dataDir, "voice-provider-events.jsonl");
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
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
      ? Promise.resolve() : new Promise((resolve) => { ws.once("close", resolve); ws.close(); }),
  };
}
