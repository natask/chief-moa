"use strict";

const assert = require("node:assert");
const test = require("node:test");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");
const { createVoiceSessionServer } = require("../lib/voice-session-server");

const AUDIO_FORMAT = { encoding: "pcm16", sample_rate: 16000, channels: 1 };
const LITERAL_TEXT = "Send this exact text from my Mac.";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeHttpServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function closeVoiceServer(voiceServer) {
  return new Promise((resolve) => voiceServer.close(resolve));
}

function createClient(target) {
  const ws = new WebSocket(target);
  const events = [];
  const waiters = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const event = JSON.parse(Buffer.from(data).toString("utf8"));
    events.push(event);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue;
      clearTimeout(waiter.timeout);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  });

  return {
    ws,
    events,
    open() {
      if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
      return new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
    },
    send(event) {
      ws.send(JSON.stringify(event));
    },
    waitFor(predicate, description) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timeout: null };
        waiter.timeout = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`timed out waiting for ${description}`));
        }, 5000);
        waiters.push(waiter);
      });
    },
    close() {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise((resolve) => {
        ws.once("close", resolve);
        ws.close();
      });
    },
  };
}

function sessionStart(overrides = {}) {
  return {
    type: "session_start",
    session_id: "macos_dictation_session",
    conversation_id: "macos_dictation_session",
    branch_id: "default",
    turn_id: "macos_literal_1",
    source: "macos-notch",
    client: { platform: "macos", surface: "notch" },
    format: AUDIO_FORMAT,
    ...overrides,
  };
}

function instrumentedProvider(calls) {
  return {
    status() {
      return {
        provider: "instrumented-test-provider",
        model: "instrumented-test-model",
        stt_provider: "instrumented-test-stt",
        configured: true,
        assistant_audio_format: AUDIO_FORMAT,
      };
    },
    createStreamingSttSession(turn, hooks) {
      calls.sttSessions += 1;
      if (turn.deliveryIntent !== "literal_text") return null;
      calls.literalHookKeys = Object.keys(hooks).sort();
      let bytes = 0;
      return {
        push(chunk) {
          bytes += chunk.length;
        },
        async finalize() {
          calls.sttFinalizations += 1;
          assert.ok(bytes > 0, "literal STT must receive the Mac PCM frame");
          await hooks.onTranscriptPartial("Send this exact");
          return { ok: true, text: LITERAL_TEXT };
        },
        abort() {},
      };
    },
    async processTurn(turn, hooks) {
      calls.modelTurns += 1;
      assert.equal(turn.deliveryIntent, "assistant_response");
      await hooks.onTranscriptFinal("What is on screen?");
      await hooks.onAssistantText("I can help with what is on screen.");
      return {
        provider: "instrumented-test-provider",
        model: "instrumented-test-model",
        transcript: "What is on screen?",
        assistant_text: "I can help with what is on screen.",
        audio_format: AUDIO_FORMAT,
      };
    },
  };
}

test("macOS literal WebSocket turns are STT-only and intent resets across connections", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-intent-ws-"));
  const calls = {
    context: 0,
    canonical: 0,
    modelTurns: 0,
    sttSessions: 0,
    sttFinalizations: 0,
    literalHookKeys: [],
  };
  const completedTurns = [];
  const voiceServer = createVoiceSessionServer({
    dataDir: path.join(tempDir, "data"),
    voiceProvider: instrumentedProvider(calls),
    contextProvider() {
      calls.context += 1;
      return "screen and memory context";
    },
    toolHandler() {
      throw new Error("tool handler must not run in this regression");
    },
    onTurnCompleted(turn) {
      calls.canonical += 1;
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

  let literalClient;
  let assistantClient;
  try {
    const port = await listen(server);
    const target = `ws://127.0.0.1:${port}${voiceServer.endpoint}`;
    literalClient = createClient(target);
    await literalClient.open();

    literalClient.send(sessionStart({ delivery_intent: "dictate" }));
    const invalid = await literalClient.waitFor(
      (event) => event.type === "error" && event.code === "delivery_intent_unsupported",
      "invalid delivery intent rejection",
    );
    assert.match(invalid.message, /literal_text or assistant_response/);
    assert.equal(calls.context, 0);
    assert.equal(calls.sttSessions, 0);
    assert.equal(calls.modelTurns, 0);

    literalClient.send(sessionStart({ delivery_intent: "literal_text" }));
    const ready = await literalClient.waitFor(
      (event) => event.type === "session_ready" && event.turn_id === "macos_literal_1",
      "literal session_ready",
    );
    assert.equal(ready.delivery_intent, "literal_text");
    literalClient.ws.send(Buffer.from([0, 0, 1, 0]));
    literalClient.send({ type: "commit_turn", turn_id: "macos_literal_1" });

    await literalClient.waitFor((event) => event.type === "turn_done", "literal turn_done");
    assert.ok(literalClient.events.some((event) => event.type === "transcript_partial"));
    assert.deepEqual(
      literalClient.events.find((event) => event.type === "literal_candidate").candidate,
      { kind: "literal_text", text: LITERAL_TEXT },
    );
    const literalDone = literalClient.events.find((event) => event.type === "turn_done");
    assert.equal(literalDone.status, "completed");
    assert.equal(literalDone.delivery_intent, "literal_text");
    assert.equal(literalDone.transcription_only, true);
    assert.equal(literalDone.candidate.text, LITERAL_TEXT);
    assert.equal(literalClient.events.some((event) => event.type.startsWith("assistant_")), false);
    assert.equal(calls.context, 0, "literal session must not request screen or memory context");
    assert.equal(calls.modelTurns, 0, "literal session must not invoke the model provider");
    assert.equal(calls.canonical, 0, "literal session must not invoke agent or memory completion hooks");
    assert.deepEqual(calls.literalHookKeys, [
      "isTurnActive",
      "onStageDone",
      "onStageError",
      "onStageStart",
      "onTranscriptFinal",
      "onTranscriptPartial",
    ]);

    const metadataPath = path.join(
      voiceServer.sessionsDir,
      "macos_dictation_session",
      "macos_literal_1.json",
    );
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.delivery_intent, "literal_text");
    assert.deepEqual(metadata.literal_candidate, { kind: "literal_text", text: LITERAL_TEXT });

    await literalClient.close();
    literalClient = null;

    assistantClient = createClient(target);
    await assistantClient.open();
    assistantClient.send(sessionStart({
      session_id: "macos_assistant_session",
      conversation_id: "macos_assistant_session",
      turn_id: "macos_assistant_1",
      // Omission is the legacy/default assistant behavior after reconnect.
    }));
    const assistantReady = await assistantClient.waitFor(
      (event) => event.type === "session_ready",
      "assistant session_ready",
    );
    assert.equal(assistantReady.delivery_intent, "assistant_response");
    assistantClient.ws.send(Buffer.from([0, 0]));
    assistantClient.send({ type: "commit_turn", turn_id: "macos_assistant_1" });
    await assistantClient.waitFor((event) => event.type === "turn_done", "assistant turn_done");

    assert.equal(calls.context, 1, "default assistant session must retain context attachment");
    assert.equal(calls.modelTurns, 1, "default assistant session must retain model routing");
    assert.equal(calls.canonical, 1, "default assistant session must retain canonical completion");
    assert.equal(completedTurns[0].turn_id, "macos_assistant_1");
    assert.ok(assistantClient.events.some((event) => event.type === "assistant_text"));
  } finally {
    if (literalClient) await literalClient.close();
    if (assistantClient) await assistantClient.close();
    await closeVoiceServer(voiceServer);
    await closeHttpServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
