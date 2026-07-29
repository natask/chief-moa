"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { WebSocket } = require("ws");
const { createVoiceSessionServer } = require("../lib/voice-session-server");

const FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };

test("closing after assistant output cannot rewrite a completed turn as error", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-terminal-receipt-"));
  const dataDir = path.join(tempDir, "data");
  const provider = {
    status: () => ({
      provider: "terminal-receipt-test",
      model: "terminal-receipt-test",
      configured: true,
      assistant_audio_format: FORMAT,
    }),
    async processTurn(turn, hooks) {
      await hooks.onTranscriptFinal("synthetic transcript");
      await hooks.onAssistantText("synthetic reply");
      return {
        provider: "terminal-receipt-test",
        model: "terminal-receipt-test",
        transcript: "synthetic transcript",
        assistant_text: "synthetic reply",
        audio_format: FORMAT,
      };
    },
  };
  const voiceServer = createVoiceSessionServer({ dataDir, voiceProvider: provider });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => {
    voiceServer.handleUpgrade(request, socket, head);
  });

  try {
    const port = await listen(server);
    await closeAfterAssistantText(`ws://127.0.0.1:${port}${voiceServer.endpoint}`);
    const metadataPath = path.join(dataDir, "voice-sessions", "receipt_session", "receipt_turn.json");
    const metadata = await waitForJson(metadataPath, (value) => value.status === "completed");

    assert.equal(metadata.status, "completed");
    assert.ok(metadata.provider_events.some((event) => event.type === "turn_completed"));
    assert.ok(!metadata.provider_events.some((event) => event.type === "turn_error"));
    assert.ok(!metadata.provider_events.some((event) => event.type === "stage_error"
      && event.error_summary === "websocket is not open"));
  } finally {
    await new Promise((resolve) => voiceServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeAfterAssistantText(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    const timeout = setTimeout(() => reject(new Error("timed out waiting for assistant output")), 5000);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session_start",
        session_id: "receipt_session",
        conversation_id: "receipt_session",
        branch_id: "default",
        turn_id: "receipt_turn",
        source: "terminal-receipt-test",
        format: FORMAT,
      }));
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      if (event.type === "session_ready") {
        ws.send(JSON.stringify({ type: "text_turn", turn_id: "receipt_turn", text: "synthetic transcript" }));
      }
      if (event.type === "assistant_text") {
        clearTimeout(timeout);
        ws.terminate();
        resolve();
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForJson(filePath, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (predicate(value)) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}
