#!/usr/bin/env node
"use strict";

// Deterministic regression for the voice-reply variation bug: the same kind of
// utterance must always take the same path. Four scenarios, all through the
// real session server with fake providers (no network):
//
//   1. transcript settle gate: a turn that completes before its transcript
//      arrives waits (bounded) instead of resolving without one.
//   2. delayed transcript: a streamed transcript_final rescues a provider
//      result that carries no transcript — the stored turn holds real words.
//   3. missing transcript with no assistant output: explicit turn_done
//      status=no_speech, no fake canonical turn, no fabricated transcript.
//   4. leading audio: frames sent before session_ready still reach the
//      provider and the stored PCM — the start of the utterance survives.

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");
const { createVoiceSessionServer } = require("../lib/voice-session-server");
const { createTranscriptSettleGate } = require("../lib/voice-providers");

const AUDIO_FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  await checkSettleGate();
  const noSpeech = await runScenario(noSpeechProvider());
  assertNoSpeechScenario(noSpeech);
  const delayed = await runScenario(delayedTranscriptProvider());
  assertDelayedTranscriptScenario(delayed);
  const audioOnly = await runScenario(audioOnlyReplyProvider());
  assertAudioOnlyScenario(audioOnly);
  const leading = await runScenario(byteCountingProvider(), { sendLeadingAudio: true });
  assertLeadingAudioScenario(leading);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "settle gate resolves immediately when a transcript already exists",
      "settle gate holds for a late transcript and resolves after it settles",
      "settle gate resolves at the grace cap when no transcript ever arrives",
      "empty transcript with no assistant output ends as turn_done status=no_speech with no canonical record and no transcript_final",
      "a late streamed transcript_final rescues an empty provider result into the canonical record",
      "audio-only replies complete with an empty transcript, never a fabricated placeholder",
      "audio frames sent before session_ready reach the provider and the stored PCM in full",
    ],
  }, null, 2));
}

// --- scenario 1: the settle gate itself -------------------------------------

async function checkSettleGate() {
  // Transcript already present: resolve is synchronous.
  {
    let resolved = false;
    const gate = createTranscriptSettleGate({
      graceMs: 500,
      settleMs: 50,
      hasTranscript: () => true,
      resolve: () => { resolved = true; },
    });
    gate.request();
    assert.equal(resolved, true, "gate must resolve immediately when a transcript exists");
    assert.equal(gate.pending(), false);
  }

  // Late transcript: request with nothing, transcript arrives, gate resolves
  // after the settle window — well before the grace cap.
  {
    let transcript = "";
    let resolvedAt = 0;
    const startedAt = Date.now();
    const gate = createTranscriptSettleGate({
      graceMs: 2000,
      settleMs: 60,
      hasTranscript: () => Boolean(transcript),
      resolve: () => { resolvedAt = Date.now(); },
    });
    gate.request();
    assert.equal(gate.pending(), true, "gate must hold while the transcript is missing");
    await delay(40);
    transcript = "hello there";
    gate.noteTranscript();
    await waitFor(() => resolvedAt > 0, 1000, "gate did not resolve after a late transcript");
    const heldMs = resolvedAt - startedAt;
    assert.ok(heldMs < 1000, `gate resolved via settle timer, not the grace cap (${heldMs}ms)`);
  }

  // No transcript ever: the grace cap bounds the wait.
  {
    let resolvedAt = 0;
    const startedAt = Date.now();
    const gate = createTranscriptSettleGate({
      graceMs: 120,
      settleMs: 60,
      hasTranscript: () => false,
      resolve: () => { resolvedAt = Date.now(); },
    });
    gate.request();
    await waitFor(() => resolvedAt > 0, 1000, "gate did not resolve at the grace cap");
    assert.ok(resolvedAt - startedAt >= 100, "gate resolved before the grace cap");
  }

  // Cancel stops the pending resolve.
  {
    let resolved = false;
    const gate = createTranscriptSettleGate({
      graceMs: 80,
      settleMs: 60,
      hasTranscript: () => false,
      resolve: () => { resolved = true; },
    });
    gate.request();
    gate.cancel();
    await delay(150);
    assert.equal(resolved, false, "cancel must stop the pending resolve");
    assert.equal(gate.pending(), false);
  }
}

// --- fake providers ----------------------------------------------------------

function providerStatus(provider) {
  return {
    provider,
    model: `${provider}-model`,
    configured: true,
    assistant_audio_format: AUDIO_FORMAT,
    runtime_mode: "native_live",
    selected_providers: {
      native_live: provider,
      stt: provider,
      reasoning: provider,
      tts: provider,
    },
    capabilities: {},
  };
}

function liveSessionProvider(provider, onCommit) {
  return {
    receivedAudioBytes: 0,
    status: () => providerStatus(provider),
    createLiveTurnSession(turn, hooks) {
      const self = this;
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      return {
        done,
        sendAudio(chunk) {
          self.receivedAudioBytes += Buffer.from(chunk).length;
        },
        async commit() {
          resolveDone(await onCommit(hooks, self));
        },
        cancel() {
          resolveDone({ transcript: "", transcript_source: "synthetic", assistant_text: "", audio_format: AUDIO_FORMAT });
        },
      };
    },
  };
}

// STT produced nothing and the model produced nothing: the exact "Voice
// captured." + contentless-reply failure mode, now expected to surface as an
// explicit no_speech turn.
function noSpeechProvider() {
  return liveSessionProvider("no-speech-test", async () => ({
    provider: "no-speech-test",
    model: "no-speech-test-model",
    transcript: "",
    transcript_source: "synthetic",
    assistant_text: "",
    audio_format: AUDIO_FORMAT,
  }));
}

// The provider result carries no transcript, but a real transcript_final
// arrived over the stream before the result resolved (the Gemini trailing
// inputTranscription shape). The streamed words must win.
function delayedTranscriptProvider() {
  return liveSessionProvider("delayed-transcript-test", async (hooks) => {
    await hooks.onTranscriptFinal("the real late transcript");
    await hooks.onAssistantAudioStart(AUDIO_FORMAT);
    await hooks.sendAudio(Buffer.alloc(640, 7));
    await hooks.onAssistantAudioDone();
    return {
      provider: "delayed-transcript-test",
      model: "delayed-transcript-test-model",
      transcript: "",
      transcript_source: "synthetic",
      assistant_text: "",
      audio_format: AUDIO_FORMAT,
    };
  });
}

// Native-audio shape: real spoken reply, no transcript at all. The turn must
// complete with an EMPTY transcript, never a fabricated placeholder.
function audioOnlyReplyProvider() {
  return liveSessionProvider("audio-only-test", async (hooks) => {
    await hooks.onAssistantAudioStart(AUDIO_FORMAT);
    await hooks.sendAudio(Buffer.alloc(640, 5));
    await hooks.onAssistantAudioDone();
    return {
      provider: "audio-only-test",
      model: "audio-only-test-model",
      transcript: "",
      transcript_source: "synthetic",
      assistant_text: "",
      audio_format: AUDIO_FORMAT,
    };
  });
}

// Counts every audio byte the provider receives so the leading-audio scenario
// can prove nothing sent before session_ready was dropped.
function byteCountingProvider() {
  return liveSessionProvider("leading-audio-test", async (hooks) => {
    await hooks.onTranscriptFinal("leading audio transcript");
    await hooks.onAssistantAudioStart(AUDIO_FORMAT);
    await hooks.sendAudio(Buffer.alloc(640, 9));
    await hooks.onAssistantAudioDone();
    return {
      provider: "leading-audio-test",
      model: "leading-audio-test-model",
      transcript: "leading audio transcript",
      transcript_source: "stt",
      assistant_text: "",
      audio_format: AUDIO_FORMAT,
    };
  });
}

// --- session-server harness ---------------------------------------------------

async function runScenario(provider, options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-determinism-"));
  const dataDir = path.join(tempDir, "data");
  const completedTurns = [];
  const voiceServer = createVoiceSessionServer({
    dataDir,
    voiceProvider: provider,
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

  const events = [];
  const leadingFrame = Buffer.alloc(640, 1);
  const readyFrame = Buffer.alloc(1280, 2);
  const sentAudioBytes = leadingFrame.length + readyFrame.length;

  try {
    const port = await listen(server);
    const turnId = "determinism_turn";
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${voiceServer.endpoint}`);
      const timeout = setTimeout(() => {
        closeWebSocketQuietly(ws);
        reject(new Error("timed out waiting for turn_done"));
      }, 5000);

      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "session_start",
          session_id: "determinism_session",
          branch_id: "determinism_branch",
          turn_id: turnId,
          source: "voice-determinism-smoke",
          format: AUDIO_FORMAT,
        }));
        if (options.sendLeadingAudio) {
          // Race the frame against session_start processing: this is the
          // leading audio a client streams before the gateway turn is ready.
          ws.send(leadingFrame);
        }
      });

      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          return;
        }
        const event = JSON.parse(Buffer.from(data).toString("utf8"));
        events.push(event);
        if (event.type === "error") {
          clearTimeout(timeout);
          closeWebSocketQuietly(ws);
          reject(new Error(event.message || "voice session returned error"));
          return;
        }
        if (event.type === "session_ready") {
          ws.send(options.sendLeadingAudio ? readyFrame : leadingFrame);
          ws.send(JSON.stringify({ type: "commit_turn", turn_id: turnId }));
        }
        if (event.type === "turn_done") {
          clearTimeout(timeout);
          closeWebSocketQuietly(ws);
          resolve();
        }
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    const storedPcmBytes = statSizeQuietly(
      path.join(dataDir, "voice-sessions", "determinism_session", `${turnId}.pcm`)
    );

    return {
      events,
      completedTurns,
      provider,
      storedPcmBytes,
      sentAudioBytes: options.sendLeadingAudio ? sentAudioBytes : leadingFrame.length,
    };
  } finally {
    await new Promise((resolve) => voiceServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// --- scenario assertions --------------------------------------------------------

function assertNoSpeechScenario(outcome) {
  const done = eventOfType(outcome.events, "turn_done");
  assert.equal(done.status, "no_speech", "empty turn must end as no_speech");
  assert.equal(done.reason, "stt_empty");
  assert.equal(outcome.completedTurns.length, 0, "no canonical record for a no_speech turn");
  assertNoFabricatedTranscript(outcome.events);
  assert.ok(
    !outcome.events.some((event) => event.type === "transcript_final"),
    "no transcript_final may be sent for a turn with no transcript"
  );
}

function assertDelayedTranscriptScenario(outcome) {
  const done = eventOfType(outcome.events, "turn_done");
  assert.equal(done.status, "completed");
  assert.equal(outcome.completedTurns.length, 1, "delayed-transcript turn must record one canonical turn");
  const turn = outcome.completedTurns[0];
  assert.equal(turn.transcript, "the real late transcript", "streamed transcript must rescue the empty provider result");
  assert.equal(turn.transcript_source, "stt");
  assertNoFabricatedTranscript(outcome.events);
}

function assertAudioOnlyScenario(outcome) {
  const done = eventOfType(outcome.events, "turn_done");
  assert.equal(done.status, "completed", "an audio-only reply is still a completed turn");
  assert.equal(outcome.completedTurns.length, 1);
  const turn = outcome.completedTurns[0];
  assert.equal(turn.transcript, "", "audio-only reply must keep an empty transcript, never a placeholder");
  assert.equal(turn.transcript_source, "synthetic");
  assertNoFabricatedTranscript(outcome.events);
}

function assertLeadingAudioScenario(outcome) {
  const done = eventOfType(outcome.events, "turn_done");
  assert.equal(done.status, "completed");
  assert.equal(
    outcome.provider.receivedAudioBytes,
    outcome.sentAudioBytes,
    `provider must receive every audio byte including pre-ready frames (${outcome.provider.receivedAudioBytes}/${outcome.sentAudioBytes})`
  );
  assert.equal(
    outcome.storedPcmBytes,
    outcome.sentAudioBytes,
    `stored PCM must hold every audio byte including pre-ready frames (${outcome.storedPcmBytes}/${outcome.sentAudioBytes})`
  );
}

function assertNoFabricatedTranscript(events) {
  for (const event of events) {
    const text = String(event.text || "");
    assert.ok(!text.includes("Voice captured."), `fabricated placeholder leaked into ${event.type}`);
  }
}

// --- helpers -----------------------------------------------------------------

function eventOfType(events, type) {
  const event = events.find((candidate) => candidate.type === type);
  assert.ok(event, `missing ${type} event; saw ${events.map((candidate) => candidate.type).join(", ")}`);
  return event;
}

function statSizeQuietly(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
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

function waitFor(check, timeoutMs, message) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(message));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
