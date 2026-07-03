#!/usr/bin/env node
"use strict";

// Positive whole-turn check for a native-audio Live turn. This is the counterpart
// to smoke-voice-session-ready.js's failure case: with a native-audio-shaped
// provider, a turn must reach session_ready, then produce assistant audio, then
// complete. It proves the five stages the user listed hold together at the
// session-server layer: audio captured (provider receives the client bytes),
// transcript produced (user transcript on completion), LLM query made (the live
// session is created once per turn), response routed back (assistant audio events
// reach the client on the same turn id), and turn_done(completed).
//
// Uses a fake in-process provider so it never calls Vertex; the real provider
// handshake is covered by the opt-in live eval, not this fast check. On
// native-audio, assistant_text is empty by design, so the transcript assertion is
// on the USER transcript, not the assistant text.

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");
const { createVoiceSessionServer } = require("../lib/voice-session-server");

const AUDIO_FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };
const USER_TRANSCRIPT = "hello in amharic and english";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  await assertNativeAudioTurnProducesAudio();
  console.log(JSON.stringify({
    ok: true,
    checks: [
      "session_ready is emitted for the turn",
      "the provider receives the client audio (audio captured)",
      "assistant_audio_start, binary audio, assistant_audio_done arrive in order (response routed back)",
      "a transcript_final event carries the user transcript (transcript produced)",
      "the live session is created exactly once (LLM query made)",
      "turn_done reports status completed for the same turn id",
    ],
  }, null, 2));
}

async function assertNativeAudioTurnProducesAudio() {
  const state = { createCalls: 0, receivedAudioBytes: 0 };
  const provider = nativeAudioProvider(state);
  await withServer(provider, async (target) => {
    const events = [];
    const binaryFrames = [];
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(target);
      const timeout = setTimeout(() => {
        closeQuietly(ws);
        reject(new Error("timed out waiting for turn_done"));
      }, 5000);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "session_start",
          session_id: "native_session",
          turn_id: "native_turn",
          format: AUDIO_FORMAT,
        }));
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          binaryFrames.push(Buffer.from(data));
          return;
        }
        const event = JSON.parse(Buffer.from(data).toString("utf8"));
        events.push(event);
        if (event.type === "error") {
          clearTimeout(timeout);
          closeQuietly(ws);
          reject(new Error(event.message || "voice session error"));
          return;
        }
        if (event.type === "session_ready") {
          ws.send(Buffer.alloc(640, 1));
          ws.send(JSON.stringify({ type: "commit_turn", turn_id: "native_turn" }));
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

    const ready = events.find((event) => event.type === "session_ready");
    assert.ok(ready, "session_ready was never sent");

    assert.ok(state.receivedAudioBytes >= 640, "the provider never received the client audio");

    const startIndex = events.findIndex((event) => event.type === "assistant_audio_start");
    const doneIndex = events.findIndex((event) => event.type === "assistant_audio_done");
    assert.ok(startIndex >= 0, "assistant_audio_start was never sent");
    assert.ok(doneIndex > startIndex, "assistant_audio_done must follow assistant_audio_start");
    const audioBytes = binaryFrames.reduce((sum, frame) => sum + frame.length, 0);
    assert.ok(audioBytes > 0, "no assistant audio was routed back to the client");

    const done = events.find((event) => event.type === "turn_done");
    assert.equal(done.status, "completed", "the turn must complete successfully");
    assert.equal(done.turn_id, "native_turn", "turn_done must carry the turn id the client opened with");

    assert.equal(state.createCalls, 1, "the live session must be created exactly once per turn");

    // The user transcript must be present even though assistant_text is empty on
    // native audio. It surfaces as a transcript_final event, not on turn_done.
    const transcriptEvent = events.find((event) => event.type === "transcript_final" && event.text);
    const transcript = transcriptEvent ? transcriptEvent.text : "";
    assert.ok(
      String(transcript).includes("amharic"),
      `the user transcript must be produced and carried through, got ${JSON.stringify(transcript)}`,
    );
  });
}

// A provider shaped like the native-audio Live provider: it reports native_live,
// emits a user transcript and empty assistant text, streams assistant audio, and
// completes. It records how many times it was created and how much audio it got.
function nativeAudioProvider(state) {
  return {
    status: () => providerStatus(),
    createLiveTurnSession(turn, hooks) {
      state.createCalls += 1;
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      return {
        done,
        sendAudio(chunk) {
          state.receivedAudioBytes += Buffer.from(chunk).length;
        },
        async commit() {
          await hooks.onTranscriptFinal(USER_TRANSCRIPT);
          // Native audio emits no assistant text on purpose.
          await hooks.onAssistantAudioStart(AUDIO_FORMAT);
          await hooks.sendAudio(Buffer.alloc(320, 7));
          await hooks.onAssistantAudioDone();
          resolveDone({
            provider: "native-audio-test",
            model: "gemini-live-2.5-flash-native-audio",
            transcript: USER_TRANSCRIPT,
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

function providerStatus() {
  return {
    provider: "native-audio-test",
    model: "gemini-live-2.5-flash-native-audio",
    configured: true,
    assistant_audio_format: AUDIO_FORMAT,
    runtime_mode: "native_live",
    selected_providers: {
      native_live: "native-audio-test",
      stt: "native-audio-test",
      reasoning: "native-audio-test",
      tts: "native-audio-test",
    },
    capabilities: {},
  };
}

async function withServer(provider, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-native-audio-turn-"));
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
