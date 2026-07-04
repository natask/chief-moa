#!/usr/bin/env node
"use strict";

// Audio-stored stage check: "I must never lose what I said." A completed turn
// must leave the user's PCM on disk at the turn's pcmPath, non-empty, and the
// turn metadata must record a byte count that matches the file. This is the
// concrete test behind the diagnosis observation that turns record ~900 bytes of
// user PCM. Fake provider, real createVoiceSessionServer, temp data dir; no
// network, no secret.

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");
const { createVoiceSessionServer } = require("../lib/voice-session-server");

const AUDIO_FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };
const USER_AUDIO = Buffer.alloc(1280, 5); // two 640-byte frames of non-zero PCM

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  await assertTurnAudioIsStored();
  console.log(JSON.stringify({
    ok: true,
    checks: [
      "the turn PCM file exists on disk after the turn completes",
      "the stored PCM file is non-empty and holds the bytes the client sent",
      "the turn metadata records an audio byte count matching the PCM file size",
    ],
  }, null, 2));
}

async function assertTurnAudioIsStored() {
  const provider = completingProvider();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-turn-storage-"));
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
    const target = `ws://127.0.0.1:${port}${voiceServer.endpoint}`;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(target);
      const timeout = setTimeout(() => {
        closeQuietly(ws);
        reject(new Error("timed out waiting for turn_done"));
      }, 5000);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "session_start",
          session_id: "storage_session",
          turn_id: "storage_turn",
          format: AUDIO_FORMAT,
        }));
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const event = JSON.parse(Buffer.from(data).toString("utf8"));
        if (event.type === "error") {
          clearTimeout(timeout);
          closeQuietly(ws);
          reject(new Error(event.message || "voice session error"));
          return;
        }
        if (event.type === "session_ready") {
          ws.send(USER_AUDIO);
          ws.send(JSON.stringify({ type: "commit_turn", turn_id: "storage_turn" }));
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

    // Find the stored turn directory and its PCM + metadata under the data dir.
    const pcmFiles = findFiles(dataDir, (name) => name.endsWith(".pcm") && !name.endsWith(".assistant.pcm"));
    assert.ok(pcmFiles.length >= 1, "no turn PCM file was written to the data dir");
    const pcmPath = pcmFiles.find((file) => path.basename(file) === "storage_turn.pcm") || pcmFiles[0];
    const pcmStat = fs.statSync(pcmPath);
    assert.ok(pcmStat.size > 0, "the stored PCM file is empty; user audio was lost");
    assert.ok(pcmStat.size >= USER_AUDIO.length, "the stored PCM is smaller than the audio the client sent");

    const metaFiles = findFiles(dataDir, (name) => name.endsWith(".json"));
    const metaPath = metaFiles.find((file) => path.basename(file) === "storage_turn.json");
    assert.ok(metaPath, "no turn metadata file was written");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    assert.ok(meta.audio && typeof meta.audio.bytes === "number", "turn metadata has no audio byte count");
    assert.equal(meta.audio.bytes, pcmStat.size, "metadata audio byte count must match the PCM file size");
    assert.equal(meta.status, "completed", "the stored turn must be marked completed");
  } finally {
    await new Promise((resolve) => voiceServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function completingProvider() {
  return {
    status: () => ({
      provider: "storage-test",
      model: "storage-model",
      configured: true,
      assistant_audio_format: AUDIO_FORMAT,
      runtime_mode: "native_live",
      selected_providers: {
        native_live: "storage-test",
        stt: "storage-test",
        reasoning: "storage-test",
        tts: "storage-test",
      },
      capabilities: {},
    }),
    createLiveTurnSession(turn, hooks) {
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      return {
        done,
        sendAudio() {},
        async commit() {
          await hooks.onTranscriptFinal("stored");
          await hooks.onAssistantAudioStart(AUDIO_FORMAT);
          await hooks.sendAudio(Buffer.alloc(320, 3));
          await hooks.onAssistantAudioDone();
          resolveDone({
            provider: "storage-test",
            model: "storage-model",
            transcript: "stored",
            assistant_text: "",
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

function findFiles(dir, predicate) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (predicate(entry.name)) {
        out.push(full);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
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
