"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WebSocket } = require("ws");
const { createVoiceSessionServer } = require("../lib/voice-session-server");

const AUDIO_FORMAT = Object.freeze({
  encoding: "pcm16",
  sample_rate: 16000,
  channels: 1,
});

test("finalize_transcript stores exact literal text and audio without ordinary turn execution", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-finalize-transcript-"));
  const calls = {
    stt: 0,
    processTurn: 0,
    reasoner: 0,
    tool: 0,
    tts: 0,
  };
  const stored = [];
  const provider = {
    status: () => ({
      provider: "focused-stt",
      model: "literal-v1",
      configured: true,
      prompt_language_codes: ["en-US"],
    }),
    async processTurn() {
      calls.processTurn += 1;
      calls.reasoner += 1;
      throw new Error("ordinary turn pipeline must not run");
    },
    async transcribeTurn(turn, hooks) {
      calls.stt += 1;
      assert.equal(turn.transcriptionOnly, true);
      assert.equal(turn.audioBytes, 640);
      await hooks.onStageStart("stt", { audio_bytes: turn.audioBytes });
      await hooks.onTranscriptFinal("Exact final transcript — አግ.");
      await hooks.onStageDone("stt", { transcript_chars: 30 });
      return {
        provider: "focused-stt",
        model: "literal-v1",
        transcript: "Exact final transcript — አግ.",
        assistant_text: "",
        transcription_only: true,
        audio_format: AUDIO_FORMAT,
      };
    },
    async synthesizeAssistantSpeech() {
      calls.tts += 1;
      throw new Error("TTS must not run");
    },
  };
  const voiceServer = createVoiceSessionServer({
    dataDir: root,
    voiceProvider: provider,
    toolHandler: async () => {
      calls.tool += 1;
      throw new Error("tools must not run");
    },
    onTurnCompleted: async (turn) => {
      stored.push(turn);
      return { ...turn, response: { speak: "", display: "", actions: [] } };
    },
  });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => {
    voiceServer.handleUpgrade(request, socket, head);
  });
  await listen(server);
  t.after(async () => {
    await closeVoiceServer(voiceServer);
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const events = await runFinalization(
    `ws://127.0.0.1:${server.address().port}${voiceServer.endpoint}`,
  );

  assert.deepEqual(calls, {
    stt: 1,
    processTurn: 0,
    reasoner: 0,
    tool: 0,
    tts: 0,
  });
  assert.equal(events.some((event) => event.type === "assistant_text"), false);
  assert.equal(events.some((event) => event.type === "assistant_audio_start"), false);
  assert.equal(events.some((event) => event.type === "turn_done"), false);
  assert.deepEqual(
    events.find((event) => event.type === "session_ready").transcript_finalize,
    { supported: true },
  );

  const finalText = events.find((event) => event.type === "transcript_final");
  assert.equal(finalText.text, "Exact final transcript — አግ.");
  const receipt = events.find((event) => event.type === "transcript_finalized");
  assert.deepEqual(receipt, {
    type: "transcript_finalized",
    session_id: "ordinary_session",
    branch_id: "default",
    turn_id: "ordinary_turn",
    status: "completed",
    transcript: "Exact final transcript — አግ.",
    transcription_only: true,
    stored: true,
    reply_language: "en-US",
    input_languages: ["en-US"],
  });

  assert.equal(stored.length, 1);
  assert.equal(stored[0].transcript, "Exact final transcript — አግ.");
  assert.equal(stored[0].assistant_text, "");
  assert.equal(stored[0].transcription_only, true);
  assert.deepEqual(stored[0].audio, {
    pcm_file: "ordinary_turn.pcm",
    bytes: 640,
    chunks: 1,
  });
  assert.equal(
    fs.readFileSync(path.join(root, "voice-sessions", "ordinary_session", "ordinary_turn.pcm")).length,
    640,
  );
});

function runFinalization(target) {
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(target);
    const timeout = setTimeout(() => reject(new Error("timed out waiting for transcript_finalized")), 3000);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session_start",
        session_id: "ordinary_session",
        conversation_id: "ordinary_session",
        branch_id: "default",
        turn_id: "ordinary_turn",
        source: "agee-extension",
        format: AUDIO_FORMAT,
      }));
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        reject(new Error("transcript finalization must not emit assistant audio"));
        return;
      }
      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      if (event.type === "error") {
        reject(new Error(event.message));
        return;
      }
      events.push(event);
      if (event.type === "session_ready") {
        ws.send(Buffer.alloc(640, 7));
        ws.send(JSON.stringify({
          type: "finalize_transcript",
          turn_id: "ordinary_turn",
        }));
      }
      if (event.type === "transcript_finalized") {
        clearTimeout(timeout);
        ws.close();
        resolve(events);
      }
    });
    ws.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeVoiceServer(voiceServer) {
  return new Promise((resolve) => voiceServer.close(resolve));
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(resolve);
  });
}
