#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-session-events-"));
  const dataDir = path.join(tempDir, "data");
  const completedTurns = [];
  const voiceServer = createVoiceSessionServer({
    dataDir,
    voiceProvider: fakeVoiceProvider(),
    onTurnCompleted: (turn) => {
      completedTurns.push(turn);
    },
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
    const events = await runVoiceTurn(`ws://127.0.0.1:${port}${voiceServer.endpoint}`);
    assertStableTranscriptEvents(events);
    assertStableAssistantEvents(events);
    assertCanonicalCompletion(completedTurns);
    assertProviderEventLedger(dataDir);

    console.log(JSON.stringify({
      ok: true,
      checks: [
        "transcript_partial websocket event shape is stable",
        "transcript_final websocket event shape is stable",
        "assistant_text and turn_done websocket event shapes are stable",
        "canonical completed turn carries transcript, assistant text, and provider events",
        "provider event ledger keeps transcript/assistant events queryable by session and turn",
      ],
    }, null, 2));
  } finally {
    await closeVoiceServer(voiceServer);
    await closeHttpServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function fakeVoiceProvider() {
  return {
    status() {
      return {
        provider: "shape-test",
        model: "shape-model",
        configured: true,
        assistant_audio_format: AUDIO_FORMAT,
        runtime_mode: "native_live",
        selected_providers: {
          native_live: "shape-test",
          stt: "shape-test",
          reasoning: "shape-test",
          tts: "shape-test",
        },
        capabilities: {
          partial_transcripts: true,
          assistant_audio: true,
          voice_output: true,
        },
      };
    },
    async processTurn(turn, hooks) {
      assert.equal(turn.sessionId, "shape_session");
      await hooks.onTranscriptPartial("partial transcript");
      await hooks.onTranscriptFinal("final transcript");
      await hooks.onAssistantText("assistant event text");
      await hooks.onAssistantAudioStart(AUDIO_FORMAT);
      await hooks.sendAudio(Buffer.alloc(320));
      await hooks.onAssistantAudioDone();
      return {
        provider: "shape-test",
        model: "shape-model",
        transcript: "final transcript",
        assistant_text: "assistant event text",
        audio_format: AUDIO_FORMAT,
      };
    },
  };
}

function runVoiceTurn(target) {
  const events = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    const timeout = setTimeout(() => {
      closeWebSocketQuietly(ws);
      reject(new Error(`timed out waiting for ${target}`));
    }, 5000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session_start",
        session_id: "shape_session",
        conversation_id: "shape_session",
        branch_id: "shape_branch",
        turn_id: "shape_turn",
        source: "voice-session-events-smoke",
        format: AUDIO_FORMAT,
      }));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      if (event.type === "error") {
        clearTimeout(timeout);
        closeWebSocketQuietly(ws);
        reject(new Error(event.message || "voice session returned error"));
        return;
      }
      events.push(event);
      if (event.type === "session_ready") {
        ws.send(Buffer.alloc(640));
        ws.send(JSON.stringify({ type: "commit_turn", turn_id: "shape_turn" }));
      }
      if (event.type === "turn_done") {
        clearTimeout(timeout);
        closeWebSocketQuietly(ws);
        resolve(events);
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ws.on("close", () => {
      if (!events.some((event) => event.type === "turn_done")) {
        clearTimeout(timeout);
        reject(new Error("voice websocket closed before turn_done"));
      }
    });
  });
}

function assertStableTranscriptEvents(events) {
  const partial = eventOfType(events, "transcript_partial");
  assert.deepEqual(Object.keys(partial).sort(), ["branch_id", "session_id", "text", "turn_id", "type"]);
  assert.equal(partial.session_id, "shape_session");
  assert.equal(partial.branch_id, "shape_branch");
  assert.equal(partial.turn_id, "shape_turn");
  assert.equal(partial.text, "partial transcript");

  const final = eventOfType(events, "transcript_final");
  assert.deepEqual(Object.keys(final).sort(), ["branch_id", "session_id", "text", "turn_id", "type"]);
  assert.equal(final.session_id, "shape_session");
  assert.equal(final.branch_id, "shape_branch");
  assert.equal(final.turn_id, "shape_turn");
  assert.equal(final.text, "final transcript");
}

function assertStableAssistantEvents(events) {
  const text = eventOfType(events, "assistant_text");
  assert.deepEqual(Object.keys(text).sort(), ["branch_id", "session_id", "text", "turn_id", "type"]);
  assert.equal(text.text, "assistant event text");

  const done = eventOfType(events, "turn_done");
  assert.deepEqual(Object.keys(done).sort(), ["branch_id", "session_id", "status", "transcription_only", "turn_id", "type"]);
  assert.equal(done.status, "completed");
  assert.equal(done.transcription_only, false);
}

function assertCanonicalCompletion(completedTurns) {
  assert.equal(completedTurns.length, 1, "exactly one canonical turn should be recorded");
  const turn = completedTurns[0];
  assert.equal(turn.session_id, "shape_session");
  assert.equal(turn.conversation_id, "shape_session");
  assert.equal(turn.branch_id, "shape_branch");
  assert.equal(turn.turn_id, "shape_turn");
  assert.equal(turn.transcript, "final transcript");
  assert.equal(turn.assistant_text, "assistant event text");
  assert.equal(turn.provider, "shape-test");
  assert.equal(turn.model, "shape-model");
  assert.ok(Array.isArray(turn.provider_events), "canonical turn must include provider_events");
  assert.ok(turn.provider_events.some((event) => event.type === "transcript_partial"));
  assert.ok(turn.provider_events.some((event) => event.type === "transcript_final"));
  assert.ok(turn.provider_events.some((event) => event.type === "assistant_text"));
}

function assertProviderEventLedger(dataDir) {
  const ledgerPath = path.join(dataDir, "voice-provider-events.jsonl");
  assert.ok(fs.existsSync(ledgerPath), "provider event ledger missing");
  const events = fs.readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const type of ["transcript_partial", "transcript_final", "assistant_text", "turn_completed"]) {
    const event = events.find((candidate) => candidate.type === type);
    assert.ok(event, `provider ledger missing ${type}`);
    assert.equal(event.session_id, "shape_session");
    assert.equal(event.branch_id, "shape_branch");
    assert.equal(event.turn_id, "shape_turn");
    assert.equal(event.provider, "shape-test");
    assert.equal(event.provider_ids.native_live, "shape-test");
  }
}

function eventOfType(events, type) {
  const event = events.find((candidate) => candidate.type === type);
  assert.ok(event, `missing ${type} event; saw ${events.map((candidate) => candidate.type).join(", ")}`);
  return event;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
    server.on("error", reject);
  });
}

function closeWebSocketQuietly(ws) {
  try {
    ws.close(1000, "smoke complete");
  } catch {
    // Ignore close errors during smoke cleanup.
  }
}

function closeVoiceServer(voiceServer) {
  return new Promise((resolve) => voiceServer.close(resolve));
}

function closeHttpServer(server) {
  return new Promise((resolve) => server.close(resolve));
}
