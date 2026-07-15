"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { VoiceSessionConnection } = require("../lib/voice-session-server");
const { planVoiceTurnRelation } = require("../lib/voice-turn-steering");

const active = {
  sessionId: "session-a", conversationId: "session-a", branchId: "default",
  turnId: "turn-old", status: "committed",
};

test("same-thread input steers an active assistant turn", () => {
  const relation = planVoiceTurnRelation(active, {
    sessionId: "session-a", conversationId: "session-a", branchId: "default", turnId: "turn-new",
  }, { boundaryId: "steer-1", occurredAt: "2026-07-15T00:00:00.000Z" });

  assert.equal(relation.closeStatus, "interrupted");
  assert.equal(relation.prior.kind, "steering");
  assert.equal(relation.prior.next_turn_id, "turn-new");
  assert.equal(relation.next.superseded_turn_id, "turn-old");
  assert.equal(relation.next.inherit_partial_context, true);
  assert.equal(relation.next.assistant_audio_policy, "stop");
  assert.equal(relation.next.provider_tail_policy, "cancel_and_drop_late_output");
});

test("fresh-thread input is isolated from the active assistant reply", () => {
  for (const next of [
    { sessionId: "session-a", conversationId: "session-a", branchId: "thr-fresh", turnId: "turn-new" },
    { sessionId: "session-a", conversationId: "session-a", branchId: "default", turnId: "turn-new", contextAction: "new" },
  ]) {
    const relation = planVoiceTurnRelation(active, next, { boundaryId: "fresh-1" });
    assert.equal(relation.closeStatus, "interrupted");
    assert.equal(relation.next.kind, "fresh_thread");
    assert.equal(relation.next.inherit_partial_context, false);
  }
});

test("replacing an uncommitted capture is not assistant steering", () => {
  const relation = planVoiceTurnRelation({ ...active, status: "recording" }, {
    sessionId: "session-a", conversationId: "session-a", branchId: "default", turnId: "turn-new",
  }, { boundaryId: "replace-1" });
  assert.equal(relation.closeStatus, "replaced");
  assert.equal(relation.next.kind, "replacement");
  assert.equal(relation.next.assistant_audio_policy, "not_applicable");
});

test("a relation requires a stable boundary id and no active turn yields none", () => {
  assert.equal(planVoiceTurnRelation(null, {}, { boundaryId: "unused" }), null);
  assert.throws(() => planVoiceTurnRelation(active, { turnId: "next" }), /boundaryId is required/);
});

test("a new same-thread turn interrupts promptly, persists the partial, and rejects stale output", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-steering-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const oldProviderReleased = deferred();
  const oldProviderStarted = deferred();
  let released = false;
  let staleAudioRejected = false;
  const provider = {
    status: () => ({ provider: "steering-test", model: "deterministic" }),
    async processTurn(turn, hooks) {
      await hooks.onTranscriptFinal(turn.syntheticText);
      await hooks.onAssistantText("partial assistant answer");
      await hooks.onAssistantAudioStart();
      await hooks.sendAudio(Buffer.alloc(320), { segmentText: "partial assistant answer" });
      oldProviderStarted.resolve();
      await oldProviderReleased.promise;
      released = true;
      await hooks.onAssistantText("stale provider tail");
      try {
        await hooks.sendAudio(Buffer.alloc(320), { segmentText: "stale provider tail" });
      } catch (error) {
        staleAudioRejected = error?.name === "TurnSupersededError";
        throw error;
      }
      return { transcript: turn.syntheticText, assistant_text: "stale provider tail" };
    },
  };
  const records = [];
  const ws = new FakeWebSocket();
  const connection = new VoiceSessionConnection(ws, {
    sessionsDir: path.join(dataDir, "voice-sessions"),
    providerEventsFile: path.join(dataDir, "provider-events.jsonl"),
    sessionAdmission: admissionFor(provider),
    contextProvider: ({ branch_id: branchId }) => records
      .filter((record) => record.branch_id === branchId)
      .map((record) => record.assistant_text)
      .join("\n"),
    onTurnCompleted: async (record) => { records.push(record); return record; },
  });

  await connection.handleSessionStart(sessionStart("turn-old", "default"));
  const oldTurnPromise = connection.handleTextTurn({ turn_id: "turn-old", text: "original user request" });
  await oldProviderStarted.promise;
  const binaryBeforeSteering = ws.binary.length;

  await connection.handleSessionStart(sessionStart("turn-steer", "default"));
  assert.equal(released, false, "new turn admission must not wait for the superseded provider to finish");
  assert.equal(connection.turn.turnId, "turn-steer");
  assert.match(connection.turn.contextPrompt, /partial assistant answer/);
  const ready = ws.json.find((event) => event.type === "session_ready" && event.turn_id === "turn-steer");
  assert.equal(ready.turn_relation.kind, "steering");
  assert.equal(ready.turn_relation.superseded_turn_id, "turn-old");

  const interrupted = records.find((record) => record.turn_id === "turn-old");
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.assistant_text, "partial assistant answer");
  assert.equal(interrupted.turn_relation.boundary_id, ready.turn_relation.boundary_id);
  assert.equal(interrupted.turn_relation.next_turn_id, "turn-steer");

  oldProviderReleased.resolve();
  await oldTurnPromise;
  assert.equal(staleAudioRejected, true);
  assert.equal(ws.binary.length, binaryBeforeSteering, "superseded audio must never reach the new turn");
  assert.equal(ws.json.some((event) => event.text === "stale provider tail"), false);
  await connection.closeCurrentTurn("closed");
});

function sessionStart(turnId, branchId) {
  return {
    type: "session_start", session_id: "session-a", conversation_id: "session-a",
    branch_id: branchId, turn_id: turnId,
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
  };
}

function admissionFor(provider) {
  return {
    admit: async () => ({ admission: null, provider }),
    applyProfile: (profile) => profile,
    effectiveProfile: () => null,
    profileVersion: () => "profile_v0001",
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.json = [];
    this.binary = [];
  }

  send(data, options, callback) {
    if (options?.binary) this.binary.push(Buffer.from(data));
    else this.json.push(JSON.parse(String(data)));
    if (typeof callback === "function") callback();
  }
}
