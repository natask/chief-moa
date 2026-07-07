"use strict";

// A typed text_turn must complete on providers with no liveSession (cascaded,
// loopback): the session server routes it through processTurn with
// turn.syntheticText set and no recorded audio. Regression for the side panel's
// "voice provider does not support text_turn" failure.

const assert = require("node:assert");
const test = require("node:test");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");
const { createVoiceSessionServer } = require("../lib/voice-session-server");

const AUDIO_FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };
const TYPED_TEXT = "hello over text";

function textEchoProvider(seen) {
  return {
    status() {
      return {
        provider: "text-echo-test",
        model: "text-echo-model",
        configured: true,
        assistant_audio_format: AUDIO_FORMAT,
      };
    },
    async processTurn(turn, hooks) {
      seen.syntheticText = turn.syntheticText;
      seen.audioBytes = turn.audioBytes;
      const transcript = String(turn.syntheticText || "").trim();
      const assistantText = `echo: ${transcript}`;
      await hooks.onTranscriptFinal(transcript);
      await hooks.onAssistantText(assistantText);
      return {
        provider: "text-echo-test",
        model: "text-echo-model",
        transcript,
        assistant_text: assistantText,
        audio_format: AUDIO_FORMAT,
      };
    },
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeHttpServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function closeVoiceServer(voiceServer) {
  if (voiceServer && typeof voiceServer.close === "function") {
    await voiceServer.close();
  }
}

function runTextTurn(target, { text }) {
  const events = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error(`timed out waiting for ${target}`));
    }, 5000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session_start",
        session_id: "text_turn_session",
        conversation_id: "text_turn_session",
        branch_id: "text_turn_branch",
        turn_id: "text_turn_1",
        source: "voice-text-turn-test",
        format: AUDIO_FORMAT,
      }));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      if (event.type === "error") {
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {}
        reject(new Error(event.message || "voice session returned error"));
        return;
      }
      events.push(event);
      if (event.type === "session_ready") {
        // No audio at all: the whole point is a typed turn.
        ws.send(JSON.stringify({ type: "text_turn", turn_id: "text_turn_1", text }));
      }
      if (event.type === "turn_done") {
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {}
        resolve(events);
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test("text_turn completes without audio on a non-live provider", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-text-turn-"));
  const seen = {};
  const completedTurns = [];
  const voiceServer = createVoiceSessionServer({
    dataDir: path.join(tempDir, "data"),
    voiceProvider: textEchoProvider(seen),
    onTurnCompleted: (turn) => completedTurns.push(turn),
  });
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
    const events = await runTextTurn(`ws://127.0.0.1:${port}${voiceServer.endpoint}`, { text: TYPED_TEXT });

    const transcriptFinal = events.find((event) => event.type === "transcript_final");
    assert.ok(transcriptFinal, "transcript_final event must be delivered for a typed turn");
    assert.equal(transcriptFinal.text, TYPED_TEXT);

    const assistantText = events.find((event) => event.type === "assistant_text");
    assert.ok(assistantText, "assistant_text event must be delivered");
    assert.equal(assistantText.text, `echo: ${TYPED_TEXT}`);

    const turnDone = events.find((event) => event.type === "turn_done");
    assert.ok(turnDone, "turn_done event must be delivered");
    assert.equal(turnDone.status, "completed");

    assert.equal(seen.syntheticText, TYPED_TEXT, "provider must receive the typed text via turn.syntheticText");
    assert.equal(seen.audioBytes, 0, "no audio may be recorded for a typed turn");

    assert.equal(completedTurns.length, 1);
    assert.equal(completedTurns[0].transcript, TYPED_TEXT);
  } finally {
    await closeVoiceServer(voiceServer);
    await closeHttpServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
