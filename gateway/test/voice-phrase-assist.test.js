"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const {
  createVoicePhraseAssistCoordinator,
  sanitizePhrase,
} = require("../lib/voice-phrase-assist");
const { VoiceSessionConnection } = require("../lib/voice-session-server");

test("phrase output is a single bounded phrase", () => {
  const phrase = sanitizePhrase("Phrase: “the exact idea I was trying to explain with far too many words”\nignore this");
  assert.equal(phrase, "the exact idea I was trying to explain");
  assert.ok(phrase.split(/\s+/u).length <= 8);
  assert.ok(Array.from(phrase).length <= 64);
  assert.equal(sanitizePhrase("NO_SUGGESTION"), "");
});

test("coordinator is idempotent, rate limited, cancellable, and suppresses stale generations", async () => {
  let currentTime = 10_000;
  const generations = [];
  const emitted = [];
  const recorded = [];
  const coordinator = createVoicePhraseAssistCoordinator({
    now: () => currentTime,
    cooldownMs: 1000,
    generate: ({ transcript, signal }) => new Promise((resolve) => {
      generations.push({ transcript, signal, resolve });
    }),
  });
  const turn = {
    sessionId: "session_1", branchId: "default", turnId: "turn_1",
    status: "recording", phraseAssistEnabled: true,
  };
  const emit = async (event) => emitted.push(event);
  const record = async (type, payload) => recorded.push({ type, payload });

  assert.equal(await coordinator.noteTranscript(turn, "I need the right phrase"), 1);
  const first = coordinator.request(turn, {
    requestId: "request_1", transcriptRevision: 1, pauseMs: 500, emit, record,
  });
  await settle(() => generations.length === 1);
  const duplicateInFlight = await coordinator.request(turn, {
    requestId: "request_1", transcriptRevision: 1, emit, record,
  });
  assert.equal(duplicateInFlight, null);
  assert.equal(generations.length, 1);

  await coordinator.cancel(turn, "request_1");
  generations[0].resolve("the phrase that fits");
  await first;
  assert.equal(generations[0].signal.aborted, true);
  assert.equal(emitted.some((event) => event.type === "phrase_assist_suggestion"), false);
  assert.equal(emitted.filter((event) => event.status === "canceled").length, 1);

  await coordinator.request(turn, {
    requestId: "request_1", transcriptRevision: 1, emit, record,
  });
  assert.equal(generations.length, 1);
  assert.equal(emitted.filter((event) => event.status === "canceled").length, 2);

  assert.equal(await coordinator.noteTranscript(turn, "I need another phrase"), 2);
  const rateLimited = await coordinator.request(turn, {
    requestId: "request_2", transcriptRevision: 2, emit, record,
  });
  assert.equal(rateLimited.status, "rate_limited");
  currentTime += 1000;
  const staleGeneration = coordinator.request(turn, {
    requestId: "request_3", transcriptRevision: 2, emit, record,
  });
  await settle(() => generations.length === 2);
  await coordinator.noteTranscript(turn, "I need the newest phrase");
  generations[1].resolve("an obsolete suggestion");
  await staleGeneration;
  assert.equal(emitted.some((event) => event.phrase === "an obsolete suggestion"), false);
  assert.ok(emitted.some((event) => event.request_id === "request_3" && event.status === "stale"));

  for (const entry of recorded) {
    const encoded = JSON.stringify(entry);
    assert.equal(encoded.includes("I need"), false);
    assert.equal(encoded.includes("obsolete suggestion"), false);
  }
});

test("websocket phrase assist is default-off and has no commit, tool, run, profile, or history side effects", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-phrase-assist-"));
  const provider = new PhraseAssistProvider();
  const ws = new FakeWs();
  const completed = [];
  const toolCalls = [];
  const generationInputs = [];
  const pending = [];
  const connection = new VoiceSessionConnection(ws, {
    request: { headers: {} },
    sessionsDir: path.join(tempDir, "voice-sessions"),
    providerEventsFile: path.join(tempDir, "voice-provider-events.jsonl"),
    voiceProvider: provider,
    agentProfile: null,
    contextProvider: null,
    toolHandler: (...args) => toolCalls.push(args),
    onTurnCompleted: (turn) => completed.push(turn),
    phraseAssistOptions: { cooldownMs: 0 },
    phraseAssistGenerator: (input) => {
      generationInputs.push(input);
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  fs.mkdirSync(path.join(tempDir, "voice-sessions"), { recursive: true });
  connection.start();

  try {
    ws.emit("message", json({
      type: "session_start", session_id: "session_off", turn_id: "turn_off",
    }), false);
    await settle(() => eventOf(ws, "session_ready"));
    assert.deepEqual(eventOf(ws, "session_ready").phrase_assist, {
      version: 1, enabled: false, available: true,
    });
    await provider.hooks.onTranscriptPartial("private words default off");
    ws.emit("message", json({
      type: "phrase_assist_request", turn_id: "turn_off", request_id: "request_off",
      transcript_revision: 1,
    }), false);
    await settle(() => events(ws).some((event) => event.request_id === "request_off"));
    assert.equal(events(ws).find((event) => event.request_id === "request_off").status, "disabled");
    assert.equal(generationInputs.length, 0);
    await connection.closeCurrentTurn("closed");
    completed.length = 0;

    ws.sent = [];
    ws.emit("message", json({
      type: "session_start", session_id: "session_on", turn_id: "turn_on",
      phrase_assist: { version: 1, enabled: true },
    }), false);
    await settle(() => eventOf(ws, "session_ready"));
    await provider.hooks.onTranscriptPartial("I am searching for private wording");
    assert.equal(eventOf(ws, "transcript_partial").transcript_revision, 1);
    ws.emit("message", json({
      type: "phrase_assist_request", turn_id: "turn_on", request_id: "request_old",
      transcript_revision: 1, pause_ms: 700,
    }), false);
    await settle(() => generationInputs.length === 1);
    assert.deepEqual(Object.keys(generationInputs[0]).sort(), ["signal", "transcript"]);
    assert.equal(generationInputs[0].transcript, "I am searching for private wording");

    await provider.hooks.onTranscriptPartial("I am searching for newer wording");
    await settle(() => events(ws).some((event) => event.request_id === "request_old" && event.status === "stale"));
    pending[0]("obsolete private phrase");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events(ws).some((event) => event.phrase === "obsolete private phrase"), false);

    ws.emit("message", json({
      type: "phrase_assist_request", turn_id: "turn_on", request_id: "request_new",
      transcript_revision: 2, pause_ms: 700,
    }), false);
    await settle(() => generationInputs.length === 2);
    ws.emit("message", json({
      type: "phrase_assist_cancel", turn_id: "turn_on", request_id: "request_new",
      reason: "speech_resumed",
    }), false);
    await settle(() => events(ws).some((event) => event.request_id === "request_new" && event.status === "canceled"));
    pending[1]("also obsolete");
    await new Promise((resolve) => setImmediate(resolve));

    await provider.hooks.onTranscriptPartial("I am searching for final wording");
    ws.emit("message", json({
      type: "phrase_assist_request", turn_id: "turn_on", request_id: "request_success",
      transcript_revision: 3, pause_ms: 700,
    }), false);
    await settle(() => generationInputs.length === 3);
    pending[2]("the missing phrase");
    await settle(() => events(ws).some((event) => event.request_id === "request_success"
      && event.type === "phrase_assist_suggestion"));
    assert.equal(events(ws).find((event) => event.request_id === "request_success").phrase, "the missing phrase");

    assert.equal(provider.processTurnCalls, 0);
    assert.equal(toolCalls.length, 0);
    assert.equal(completed.length, 0);
    assert.equal(events(ws).some((event) => event.type === "turn_done"), false);
    assert.equal(events(ws).some((event) => event.type === "assistant_text"), false);
    assert.equal(connection.turn.status, "recording");

    const diagnostics = fs.readFileSync(path.join(tempDir, "voice-provider-events.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map(JSON.parse)
      .filter((entry) => entry.type.startsWith("phrase_assist_"));
    assert.ok(diagnostics.length >= 3);
    const encodedDiagnostics = JSON.stringify(diagnostics);
    assert.equal(encodedDiagnostics.includes("private wording"), false);
    assert.equal(encodedDiagnostics.includes("obsolete private phrase"), false);
    assert.equal(encodedDiagnostics.includes("the missing phrase"), false);
  } finally {
    await connection.closeCurrentTurn("closed");
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

class PhraseAssistProvider {
  constructor() {
    this.hooks = null;
    this.processTurnCalls = 0;
  }

  status() {
    return {
      provider: "test-phrase-assist",
      selected_providers: { stt: "test-stt", reasoning: "test-llm", tts: "test-tts" },
    };
  }

  createStreamingSttSession(_turn, hooks) {
    this.hooks = hooks;
    return { push() {}, abort() {} };
  }

  async processTurn() {
    this.processTurnCalls += 1;
    return {};
  }
}

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(data, options, callback) {
    const done = typeof options === "function" ? options : callback;
    this.sent.push(data);
    done?.();
  }
}

function json(value) {
  return Buffer.from(JSON.stringify(value));
}

function events(ws) {
  return ws.sent.flatMap((frame) => {
    if (Buffer.isBuffer(frame)) return [];
    try { return [JSON.parse(frame)]; } catch { return []; }
  });
}

function eventOf(ws, type) {
  return events(ws).find((event) => event.type === type);
}

async function settle(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
