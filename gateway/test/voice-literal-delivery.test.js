"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  completeLiteralTurn,
  literalSttHooks,
  resolveSessionDeliveryIntent,
  transcribeLiteralTurn,
} = require("../lib/voice-literal-delivery");

test("session intent defaults, validates, and preserves unexpected failures", () => {
  assert.equal(resolveSessionDeliveryIntent({}).deliveryIntent, "assistant_response");
  assert.equal(resolveSessionDeliveryIntent({ delivery_intent: "literal_text" }).deliveryIntent, "literal_text");
  assert.equal(resolveSessionDeliveryIntent({ delivery_intent: "wrong" }).error.code, "delivery_intent_unsupported");
  const failure = new Error("getter failed");
  const event = {};
  Object.defineProperty(event, "delivery_intent", { get() { throw failure; } });
  assert.throws(() => resolveSessionDeliveryIntent(event), failure);
});

test("literal sessions receive only STT-safe provider hooks", () => {
  const hooks = {
    isTurnActive() {}, onStageStart() {}, onStageDone() {}, onStageError() {},
    onTranscriptPartial() {}, onTranscriptFinal() {}, onAssistantText() {}, onToolCall() {},
  };
  assert.equal(literalSttHooks("assistant_response", hooks), hooks);
  assert.deepEqual(Object.keys(literalSttHooks("literal_text", hooks)).sort(), [
    "isTurnActive", "onStageDone", "onStageError", "onStageStart",
    "onTranscriptFinal", "onTranscriptPartial",
  ]);
});

test("literal transcription supports composed, batch, stream, and unavailable STT paths", async () => {
  const baseTurn = {
    sttStream: null,
    providerStatus: { provider: "primary", stt_provider: "chirp" },
  };
  const composed = await transcribeLiteralTurn({
    finalizeStreamingSttSession: async () => ({ text: " composed ", languageRejected: true }),
  }, { ...baseTurn }, ["en-US"]);
  assert.deepEqual(composed, {
    text: "composed", transcript_source: "stt", transcript_provider: "chirp",
    transcript_language_rejected: true,
  });

  const batch = await transcribeLiteralTurn({
    runSttStage: async (_turn, languages) => {
      assert.deepEqual(languages, ["am-ET"]);
      return { text: "batch", language_rejected: true };
    },
  }, { ...baseTurn, providerStatus: { provider: "fallback" } }, ["am-ET"]);
  assert.equal(batch.transcript_provider, "fallback");
  assert.equal(batch.transcript_language_rejected, true);

  const streamTurn = {
    ...baseTurn,
    sttStream: { finalize: async () => ({ text: "stream" }) },
  };
  assert.equal((await transcribeLiteralTurn({}, streamTurn, [])).text, "stream");
  assert.equal(streamTurn.sttStream, null);

  const empty = await transcribeLiteralTurn({
    finalizeStreamingSttSession: async () => undefined,
  }, { sttStream: null }, []);
  assert.equal(empty.text, "");
  assert.equal(empty.transcript_provider, "");
  assert.equal(empty.transcript_language_rejected, false);

  await assert.rejects(
    transcribeLiteralTurn({}, { ...baseTurn }, []),
    (error) => error.code === "stt_only_unavailable",
  );
});

test("empty literal transcription completes as no_speech without canonical effects", async () => {
  const events = [];
  const metadata = [];
  const turn = { sessionId: "s", branchId: "b", turnId: "t", status: "committed" };
  const connection = {
    turn,
    stopTurnProgress() { events.push("stopped"); },
    async recordProviderEvent(_turn, _providerEvents, type, payload) { events.push({ type, payload }); },
    async sendTurnDone(event) { events.push(event); },
  };
  await completeLiteralTurn(connection, turn, {}, { text: "" }, {
    writeTurnMetadata(_turn, patch) { metadata.push(patch); },
    nowIso() { return "2026-07-16T00:00:00.000Z"; },
    turnInputLanguages() { return ["en-US"]; },
  });
  assert.equal(turn.status, "no_speech");
  assert.equal(connection.turn, null);
  assert.equal(metadata[0].delivery_intent, "literal_text");
  assert.equal(events.at(-1).transcription_only, true);
  assert.deepEqual(events.at(-1).input_languages, ["en-US"]);
});

test("completed literal helpers preserve an existing final transcript", async () => {
  const events = [];
  const turn = { sessionId: "s", branchId: "b", turnId: "t", status: "committed" };
  const connection = {
    turn: null,
    providerHooks() {
      return { onTranscriptFinal() { throw new Error("must not resend final transcript"); } };
    },
    stopTurnProgress() {},
    async recordProviderEvent() {},
    async sendEvent(event) { events.push(event); },
    async sendTurnDone(event) { events.push(event); },
  };
  let metadata;
  await completeLiteralTurn(connection, turn, { transcriptFinalSent: true }, { text: "exact" }, {
    writeTurnMetadata(_turn, patch) { metadata = patch; },
    nowIso() { return "2026-07-16T00:00:00.000Z"; },
    turnInputLanguages() { return []; },
  });
  assert.equal(metadata.transcript.source, "stt");
  assert.equal(metadata.transcript.provider, "");
  assert.equal(events[0].type, "literal_candidate");
  assert.equal(turn.status, "completed");
});
