"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { WebSocket } = require("ws");
const { createVoiceSessionServer } = require("../lib/voice-session-server");

const FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };

test("cascaded commit starts correlated STT progress before provider processing completes", async () => {
  const gate = deferred();
  const provider = baseProvider({
    async processTurn(_turn, hooks) {
      await gate.promise;
      await hooks.onTranscriptFinal("hello");
      return { provider: "lifecycle-test", model: "test", transcript: "hello", assistant_text: "" };
    },
  });
  await withServer({ provider, turnProgressIntervalMs: 20 }, async (target) => {
    const client = await connect(target);
    try {
      client.ws.send(JSON.stringify(startEvent("progress_turn")));
      await client.waitFor("session_ready");
      client.ws.send(Buffer.alloc(640, 1));
      client.ws.send(JSON.stringify({ type: "commit_turn", turn_id: "progress_turn" }));
      const progress = await client.waitFor("turn_progress");
      assert.equal(progress.turn_id, "progress_turn");
      assert.equal(progress.session_id, "lifecycle_session");
      assert.equal(progress.branch_id, "default");
      assert.equal(progress.stage, "reasoning");
      gate.resolve();
      assert.equal((await client.waitFor("turn_done")).status, "completed");
    } finally {
      gate.resolve();
      client.ws.terminate();
    }
  });
});

test("input spool error terminalizes once with correlated cleanup", { concurrency: false }, async () => {
  const originalCreateWriteStream = fs.createWriteStream;
  const spool = new EventEmitter();
  spool.write = () => true;
  spool.end = (callback) => callback?.();
  let aborts = 0;
  fs.createWriteStream = (filePath, options) => {
    if (String(filePath).endsWith("spool_turn.pcm")) return spool;
    return originalCreateWriteStream(filePath, options);
  };
  const provider = baseProvider({
    createStreamingSttSession() {
      return { push() {}, abort() { aborts += 1; } };
    },
    async processTurn() { throw new Error("must not process a failed spool"); },
  });
  try {
    await withServer({ provider }, async (target) => {
      const client = await connect(target);
      try {
        client.ws.send(JSON.stringify(startEvent("spool_turn")));
        await client.waitFor("session_ready");
        client.ws.send(Buffer.alloc(640, 2));
        spool.emit("error", new Error("disk unavailable"));
        spool.emit("error", new Error("duplicate stream error"));
        const done = await client.waitFor("turn_done");
        assert.equal(done.status, "error");
        assert.equal(done.reason, "input_spool_error");
        assert.equal(done.turn_id, "spool_turn");
        assert.match(done.error_summary, /input audio spool failed.*disk unavailable/i);
        await delay(30);
        assert.equal(client.events.filter((event) => event.type === "turn_done").length, 1);
        assert.equal(aborts, 1, "streaming STT must be canceled exactly once");
      } finally {
        client.ws.terminate();
      }
    });
  } finally {
    fs.createWriteStream = originalCreateWriteStream;
  }
});

test("early audio beyond the ten-second admission bound fails explicitly without truncation", async () => {
  let processed = 0;
  const provider = baseProvider({
    async processTurn() { processed += 1; return {}; },
  });
  await withServer({ provider }, async (target) => {
    const client = await connect(target);
    try {
      // 16 kHz PCM16 mono: ten seconds is 320000 bytes. Sending one sample
      // beyond that before session_start must fail the correlated turn rather
      // than silently evicting its leading audio.
      client.ws.send(Buffer.alloc(320_002, 3));
      client.ws.send(JSON.stringify(startEvent("early_overflow_turn")));
      const done = await client.waitFor("turn_done");
      assert.equal(done.status, "error");
      assert.equal(done.reason, "early_audio_overflow");
      assert.equal(done.session_id, "lifecycle_session");
      assert.equal(done.branch_id, "default");
      assert.equal(done.turn_id, "early_overflow_turn");
      assert.match(done.error_summary, /10000ms session admission window/);
      assert.equal(client.events.some((event) => event.type === "session_ready"), false);
      assert.equal(processed, 0);
    } finally {
      client.ws.terminate();
    }
  });
});

function baseProvider(overrides = {}) {
  return {
    status: () => ({
      provider: "lifecycle-test", model: "test", configured: true,
      assistant_audio_format: FORMAT, prompt_language_codes: ["en-US"],
    }),
    async processTurn() {
      return { provider: "lifecycle-test", model: "test", transcript: "", assistant_text: "" };
    },
    ...overrides,
  };
}

function startEvent(turnId) {
  return {
    type: "session_start", session_id: "lifecycle_session",
    conversation_id: "lifecycle_session", branch_id: "default",
    turn_id: turnId, source: "voice-session-lifecycle-test", format: FORMAT,
  };
}

async function withServer(options, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-lifecycle-"));
  const voiceServer = createVoiceSessionServer({
    dataDir: tempDir,
    voiceProvider: options.provider,
    turnProgressIntervalMs: options.turnProgressIntervalMs,
  });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => voiceServer.handleUpgrade(request, socket, head));
  try {
    const port = await listen(server);
    await run(`ws://127.0.0.1:${port}${voiceServer.endpoint}`);
  } finally {
    await new Promise((resolve) => voiceServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function connect(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    const events = [];
    const waiters = [];
    ws.on("open", () => resolve({ ws, events, waitFor: (type) => waitFor(events, waiters, type) }));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      events.push(event);
      for (const waiter of waiters.splice(0)) waiter();
    });
    ws.on("error", reject);
  });
}

function waitFor(events, waiters, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const event = events.find((entry) => entry.type === type);
      if (event) return resolve(event);
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${type}: ${JSON.stringify(events)}`));
      waiters.push(check);
    };
    check();
    const timer = setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(timer);
        check();
      }
    }, 20);
    timer.unref?.();
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
