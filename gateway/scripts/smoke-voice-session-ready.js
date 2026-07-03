#!/usr/bin/env node
"use strict";

// session_ready must reach the client promptly on session_start, before a live
// provider finishes its cold start. Audio the client sends after session_ready
// is buffered by the provider session until it is ready, then flushed in order.
// A live provider that throws synchronously on session creation must surface a
// turn-scoped error event instead of leaving the client waiting forever.

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");
const { createVoiceSessionServer } = require("../lib/voice-session-server");

const AUDIO_FORMAT = {
  encoding: "pcm16",
  sample_rate: 16000,
  channels: 1,
};

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  await assertSessionReadyBeforeProviderReady();
  await assertSyncCreateFailureSurfacesError();
  console.log(JSON.stringify({
    ok: true,
    checks: [
      "session_ready is emitted before the live provider finishes its cold start",
      "audio sent after session_ready is delivered to the provider once it is ready",
      "a synchronous createLiveTurnSession failure surfaces a turn error and turn_done",
    ],
  }, null, 2));
}

async function assertSessionReadyBeforeProviderReady() {
  const readyGate = deferred();
  const audioSeen = deferred();
  const receivedAudio = [];
  const provider = coldStartProvider({ readyGate, audioSeen, receivedAudio });
  await withServer(provider, async (target) => {
    const events = [];
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(target);
      const timeout = setTimeout(() => {
        closeQuietly(ws);
        reject(new Error("timed out waiting for turn_done"));
      }, 5000);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "session_start",
          session_id: "ready_session",
          turn_id: "ready_turn",
          format: AUDIO_FORMAT,
        }));
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const event = JSON.parse(Buffer.from(data).toString("utf8"));
        events.push(event);
        if (event.type === "error") {
          clearTimeout(timeout);
          closeQuietly(ws);
          reject(new Error(event.message || "voice session error"));
          return;
        }
        if (event.type === "session_ready") {
          // The provider is deliberately NOT ready yet; releasing the gate only
          // after the audio frame is sent proves buffering, not a race.
          ws.send(Buffer.alloc(640));
          audioSeen.promise.then(() => readyGate.resolve());
          ws.send(JSON.stringify({ type: "commit_turn", turn_id: "ready_turn" }));
        }
        if (event.type === "turn_done") {
          clearTimeout(timeout);
          closeQuietly(ws);
          resolve();
        }
      });
      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    const readyIndex = events.findIndex((event) => event.type === "session_ready");
    assert.ok(readyIndex >= 0, "session_ready was never sent");
    assert.equal(events[readyIndex].turn_id, "ready_turn");
    assert.ok(
      receivedAudio.reduce((sum, chunk) => sum + chunk.length, 0) >= 640,
      "provider never received the audio buffered before it was ready",
    );
    const done = events.find((event) => event.type === "turn_done");
    assert.ok(done, "turn never completed");
    assert.equal(done.status, "completed");
  });
}

async function assertSyncCreateFailureSurfacesError() {
  const provider = throwingProvider();
  await withServer(provider, async (target) => {
    const events = [];
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(target);
      const timeout = setTimeout(() => {
        closeQuietly(ws);
        reject(new Error("timed out waiting for turn error"));
      }, 5000);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "session_start",
          session_id: "fail_session",
          turn_id: "fail_turn",
          format: AUDIO_FORMAT,
        }));
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const event = JSON.parse(Buffer.from(data).toString("utf8"));
        events.push(event);
        if (
          events.some((item) => item.type === "error") &&
          events.some((item) => item.type === "turn_done")
        ) {
          clearTimeout(timeout);
          closeQuietly(ws);
          resolve();
        }
      });
      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    assert.ok(events.some((event) => event.type === "error"), "no error event on sync create failure");
    const done = events.find((event) => event.type === "turn_done");
    assert.ok(done, "no turn_done on sync create failure");
    assert.equal(done.status, "error");
  });
}

function coldStartProvider({ readyGate, audioSeen, receivedAudio }) {
  return {
    status: providerStatus,
    createLiveTurnSession(turn, hooks) {
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      let audioNotified = false;
      return {
        done,
        sendAudio(chunk) {
          receivedAudio.push(Buffer.from(chunk));
          if (!audioNotified) {
            audioNotified = true;
            audioSeen.resolve();
          }
        },
        async commit() {
          // Complete only after the provider becomes ready, mirroring a cold
          // start that finishes well after session_ready was already sent.
          await readyGate.promise;
          await hooks.onTranscriptFinal("final transcript");
          await hooks.onAssistantText("assistant reply");
          await hooks.onAssistantAudioStart(AUDIO_FORMAT);
          await hooks.sendAudio(Buffer.alloc(320));
          await hooks.onAssistantAudioDone();
          resolveDone({
            provider: "cold-start-test",
            model: "cold-model",
            transcript: "final transcript",
            assistant_text: "assistant reply",
            audio_format: AUDIO_FORMAT,
          });
        },
        cancel() {
          resolveDone({ transcript: "", assistant_text: "", audio_format: AUDIO_FORMAT });
        },
      };
    },
  };
}

function throwingProvider() {
  return {
    status: providerStatus,
    createLiveTurnSession() {
      throw new Error("provider misconfigured");
    },
  };
}

function providerStatus() {
  return {
    provider: "cold-start-test",
    model: "cold-model",
    configured: true,
    assistant_audio_format: AUDIO_FORMAT,
    runtime_mode: "native_live",
    selected_providers: {
      native_live: "cold-start-test",
      stt: "cold-start-test",
      reasoning: "cold-start-test",
      tts: "cold-start-test",
    },
    capabilities: {},
  };
}

async function withServer(provider, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-session-ready-"));
  const dataDir = path.join(tempDir, "data");
  const voiceServer = createVoiceSessionServer({ dataDir, voiceProvider: provider });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === voiceServer.endpoint) {
      voiceServer.handleUpgrade(request, socket, head);
      return;
    }
    socket.destroy();
  });
  try {
    const port = await listen(server);
    await run(`ws://127.0.0.1:${port}${voiceServer.endpoint}`);
  } finally {
    await new Promise((resolve) => voiceServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    server.on("error", reject);
  });
}

function closeQuietly(ws) {
  try {
    ws.close(1000, "smoke complete");
  } catch {
    // Ignore close errors during smoke cleanup.
  }
}
