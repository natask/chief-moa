#!/usr/bin/env node
"use strict";

// Regression for the teardown race that crashed the deployed gateway:
// completeLiveTurn closes turn.audioStream before the turn reaches a terminal
// status, so a mic frame arriving in that window reaches writeTurnAudio with a
// null stream while status still reads "recording". Before the guard this threw
// an uncaught TypeError from the websocket message handler and killed the whole
// gateway process, dropping every open voice session.

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { VoiceSessionConnection } = require("../lib/voice-session-server");

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const ws = new EventEmitter();
  ws.send = () => {};
  ws.close = () => {};
  const connection = new VoiceSessionConnection(ws, {
    request: { headers: {} },
    sessionsDir: "/nonexistent-not-touched-by-this-smoke",
    voiceProvider: { status: () => ({ configured: true }) },
  });
  connection.turn = {
    status: "recording",
    audioBytes: 0,
    audioChunks: 0,
    lastAudioAt: null,
    audioStream: null,
    liveSession: null,
  };

  connection.handleAudio(Buffer.alloc(640));

  assert.equal(connection.turn.audioBytes, 0, "stale frame must be dropped, not counted");
  assert.equal(connection.turn.audioChunks, 0, "stale frame must be dropped, not counted");

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "an audio frame arriving after closeAudioStream but before a terminal turn status is dropped without throwing",
      "the dropped stale frame does not mutate turn audio counters",
    ],
  }, null, 2));
}
