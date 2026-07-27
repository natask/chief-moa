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
    contextProvider: () => "Durable context marker for diagnosis smoke.",
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
    assert.deepEqual(voiceServer.activityStatus(), {
      active_voice_connections: 0,
      active_turns: 0,
      active_recording_turns: 0,
      active_committed_turns: 0,
      active_responding_connections: 0,
      drain_safe: true,
      turn_statuses: {},
    });
    const events = await runVoiceTurn(`ws://127.0.0.1:${port}${voiceServer.endpoint}`, voiceServer);
    await waitForDrain(voiceServer);
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
        "canonical completed turn carries bounded stage timing evidence",
        "canonical completed turn carries context, capture, and transport attribution",
        "provider event ledger keeps transcript/assistant events queryable by session and turn",
        "provider event ledger keeps STT/reasoning/TTS/first-audio timing queryable",
        "voice session activity status exposes active/drained counts for deploy safety",
        "provider event ledger keeps context and pre-provider commit attribution queryable",
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
      await hooks.onStageStart("stt", { audio_bytes: turn.audioBytes });
      await hooks.onTranscriptPartial("partial transcript");
      await hooks.onTranscriptFinal("final transcript");
      await hooks.onStageDone("stt", { duration_ms: 11, transcript_chars: "final transcript".length });
      await hooks.onStageStart("reasoning", { transcript_chars: "final transcript".length });
      await hooks.onAssistantText("assistant event text");
      await hooks.onStageDone("reasoning", { duration_ms: 17, speak_chars: "assistant event text".length });
      await hooks.onStageStart("tts", { text_chars: "assistant event text".length });
      await hooks.onAssistantAudioStart(AUDIO_FORMAT);
      await hooks.sendAudio(Buffer.alloc(320));
      await hooks.onAssistantAudioDone();
      await hooks.onStageDone("tts", { duration_ms: 23, audio_bytes: 320, segments: 1 });
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

function runVoiceTurn(target, voiceServer) {
  const events = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    let sawTurnDone = false;
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
        all_branches_context: true,
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
        const activity = voiceServer.activityStatus();
        assert.equal(activity.active_voice_connections, 1);
        assert.equal(activity.active_turns, 1);
        assert.equal(activity.active_recording_turns, 1);
        assert.equal(activity.drain_safe, false);
        ws.send(Buffer.alloc(640));
        ws.send(JSON.stringify({ type: "commit_turn", turn_id: "shape_turn" }));
      }
      if (event.type === "turn_done") {
        clearTimeout(timeout);
        sawTurnDone = true;
        closeWebSocketQuietly(ws);
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ws.on("close", () => {
      if (!sawTurnDone) {
        clearTimeout(timeout);
        reject(new Error("voice websocket closed before turn_done"));
        return;
      }
      resolve(events);
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
  // turn_done always carries reply_language + input_languages so a client overlay
  // can render a live "hears X / speaks Y" indicator every turn.
  assert.deepEqual(Object.keys(done).sort(), [
    "branch_id", "first_audio_ms", "input_languages", "reply_language", "session_id",
    "status", "transcription_only", "tts_complete", "tts_delivery",
    "tts_reply_text_chars", "tts_segments", "tts_spoke", "tts_spoken_text_end", "turn_id", "type",
  ]);
  assert.equal(done.status, "completed");
  assert.equal(done.transcription_only, false);
  assert.ok(Number.isFinite(done.first_audio_ms), "turn_done must carry first_audio_ms after audio is emitted");
  assert.ok(Array.isArray(done.input_languages), "turn_done must always carry input_languages as an array");
  assert.equal(typeof done.reply_language, "string", "turn_done must always carry reply_language as a string");
  assert.equal(done.tts_delivery, "complete");
  assert.equal(done.tts_complete, true);
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
  assert.ok(turn.provider_events.some((event) => event.type === "context_attached"));
  assert.ok(turn.provider_events.some((event) => event.type === "capture_committed"));
  assert.ok(turn.provider_events.some((event) => event.type === "transport_committed"));
  assert.ok(turn.provider_events.some((event) => event.type === "stage_done" && event.stage === "stt"));
  assert.ok(turn.provider_events.some((event) => event.type === "stage_done" && event.stage === "reasoning"));
  assert.ok(turn.provider_events.some((event) => event.type === "stage_done" && event.stage === "tts"));
  assert.ok(turn.provider_events.some((event) => event.type === "stage_done" && event.stage === "first_audio"));
  assert.equal(turn.stage_timings.stt_ms, 11);
  assert.equal(turn.stage_timings.reasoning_ms, 17);
  assert.equal(turn.stage_timings.tts_ms, 23);
  assert.ok(Number.isFinite(turn.stage_timings.first_audio_ms));
  assert.equal(turn.context.enabled, true);
  assert.ok(turn.context.chars > 0, "canonical turn must record durable context chars");
  assert.equal(turn.context.all_branches_context, true);
  assert.equal(turn.capture.input_kind, "audio");
  assert.ok(turn.capture.audio_bytes > 0, "canonical turn must record committed capture bytes");
  assert.equal(turn.transport.transport, "websocket_process_turn");
  assert.equal(turn.transport.input_kind, "audio");
  assert.equal(turn.transport.committed, true);
}

function assertProviderEventLedger(dataDir) {
  const ledgerPath = path.join(dataDir, "voice-provider-events.jsonl");
  assert.ok(fs.existsSync(ledgerPath), "provider event ledger missing");
  const events = fs.readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const type of ["context_attached", "capture_committed", "transport_committed", "transcript_partial", "transcript_final", "assistant_text", "stage_start", "stage_done", "turn_completed"]) {
    const event = events.find((candidate) => candidate.type === type);
    assert.ok(event, `provider ledger missing ${type}`);
    assert.equal(event.session_id, "shape_session");
    assert.equal(event.branch_id, "shape_branch");
    assert.equal(event.turn_id, "shape_turn");
    assert.equal(event.provider, "shape-test");
    assert.equal(event.provider_ids.native_live, "shape-test");
  }
  for (const stage of ["stt", "reasoning", "tts", "first_audio"]) {
    const event = events.find((candidate) => candidate.type === "stage_done" && candidate.stage === stage);
    assert.ok(event, `provider ledger missing stage_done ${stage}`);
    assert.ok(Number.isFinite(event.duration_ms), `stage_done ${stage} must carry duration_ms`);
  }
  const completed = events.find((candidate) => candidate.type === "turn_completed");
  assert.equal(completed.stage_timings.stt_ms, 11);
  assert.equal(completed.stage_timings.reasoning_ms, 17);
  assert.equal(completed.stage_timings.tts_ms, 23);
  assert.ok(Number.isFinite(completed.stage_timings.first_audio_ms));
  assert.ok(Number.isFinite(completed.stage_timings.completion_ms));
  const context = events.find((candidate) => candidate.type === "context_attached");
  assert.equal(context.enabled, true);
  assert.ok(context.chars > 0, "context_attached must record context size");
  assert.equal(context.all_branches_context, true);
  const capture = events.find((candidate) => candidate.type === "capture_committed");
  assert.equal(capture.input_kind, "audio");
  assert.ok(capture.audio_bytes > 0, "capture_committed must record audio bytes");
  const transport = events.find((candidate) => candidate.type === "transport_committed");
  assert.equal(transport.transport, "websocket_process_turn");
  assert.equal(transport.input_kind, "audio");
  assert.equal(transport.committed, true);
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

async function waitForDrain(voiceServer) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (voiceServer.activityStatus().drain_safe) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(voiceServer.activityStatus(), {
    active_voice_connections: 0,
    active_turns: 0,
    active_recording_turns: 0,
    active_committed_turns: 0,
    active_responding_connections: 0,
    drain_safe: true,
    turn_statuses: {},
  });
}
