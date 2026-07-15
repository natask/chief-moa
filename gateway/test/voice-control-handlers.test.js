"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createVoiceControlHandlers } = require("../lib/voice-control-handlers");

function harness(overrides = {}) {
  const calls = [];
  const fn = (name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(); };
  const handlers = createVoiceControlHandlers({
    authorized: () => true, sendJson: (r, status, payload) => Object.assign(r, { status, payload }),
    handleVoiceRetranscribe: fn("retranscribe"), handleVoiceTurnsList: fn("turns"), handleVoiceTurnGet: fn("turn"),
    voiceDiagnosisPayload: (input) => ({ diagnosis: input }), sendVoiceAudio: fn("audio"),
    handleVoiceSessionTicket: fn("ticket"), handleLivekitToken: fn("token"), livekitConfigured: () => true,
    livekitNotConfiguredPayload: () => ({ error: "livekit unavailable" }), handleInternalVoiceReason: fn("reason"),
    handleInternalVoiceSynthesize: fn("synthesize"), handleInternalVoiceTurnRecord: fn("turn-record"), handleVoiceFrame: fn("frames"),
    ...overrides,
  });
  return { handlers, calls };
}
const req = (method) => ({ method });
const url = (path) => new URL(`https://test${path}`);

const routes = [
  ["POST", "/v1/voice/turns/t/retranscribe", "retranscribe"], ["GET", "/v1/voice/turns", "turns"],
  ["GET", "/v1/voice/turns/t%201?session_id=s", "turn"], ["GET", "/v1/voice/diagnosis?session_id=s", "diagnosis"],
  ["GET", "/v1/voice/audio/t", "audio"], ["POST", "/v1/voice/session-ticket", "ticket"],
  ["POST", "/v1/voice/livekit/token", "token"], ["POST", "/v1/internal/voice/reason", "reason"],
  ["POST", "/v1/internal/voice/synthesize", "synthesize"], ["POST", "/v1/internal/voice/turn-record", "turn-record"],
  ["POST", "/v1/voice/frames", "frames"],
];

test("router ignores unsupported method and path combinations", async () => {
  const state = harness();
  for (const [method, path] of [["GET", "/other"], ["GET", "/v1/voice/session-ticket"], ["POST", "/v1/voice/turns"], ["GET", "/v1/voice/frames"]]) {
    assert.equal(await state.handlers.routeVoiceControls(req(method), {}, url(path)), false);
  }
  assert.deepEqual(state.calls, []);
});

test("every voice control route requires the gateway token", async () => {
  const state = harness({ authorized: () => false });
  for (const [method, path] of routes) {
    const response = {}; assert.equal(await state.handlers.routeVoiceControls(req(method), response, url(path)), true);
    assert.deepEqual(response, { status: 401, payload: { error: "missing or invalid gateway token" } });
  }
  assert.deepEqual(state.calls, []);
});

test("all authorized routes dispatch with exact precedence and decoded turn identity", async () => {
  const state = harness();
  for (const [method, path, expected] of routes) {
    const response = {}; await state.handlers.routeVoiceControls(req(method), response, url(path));
    if (expected === "diagnosis") assert.equal(response.payload.diagnosis.sessionId, "s");
    else assert.equal(state.calls.at(-1)[0], expected);
  }
  const turnCall = state.calls.find((call) => call[0] === "turn");
  assert.equal(turnCall[2], "t 1"); assert.equal(turnCall[3], "s");
});

test("diagnosis requires session scope and normalizes aliases and limits", () => {
  const state = harness(); let response = {};
  state.handlers.handleDiagnosis(response, url("/v1/voice/diagnosis"));
  assert.deepEqual(response, { status: 400, payload: { error: "session_id is required for a bounded voice diagnosis query" } });
  response = {}; state.handlers.handleDiagnosis(response, url("/v1/voice/diagnosis?conversation_id=legacy&turn_id=t&limit=4"));
  assert.deepEqual(response.payload.diagnosis, { sessionId: "legacy", turnId: "t", limit: 4 });
  response = {}; state.handlers.handleDiagnosis(response, url("/v1/voice/diagnosis?session_id=s"));
  assert.deepEqual(response.payload.diagnosis, { sessionId: "s", turnId: "", limit: 10 });
});

test("LiveKit reason and turn-record fail closed while synthesis remains ungated", async () => {
  const state = harness({ livekitConfigured: () => false });
  for (const path of ["/v1/internal/voice/reason", "/v1/internal/voice/turn-record"]) {
    const response = {}; await state.handlers.routeVoiceControls(req("POST"), response, url(path));
    assert.deepEqual(response, { status: 503, payload: { error: "livekit unavailable" } });
  }
  const response = {}; await state.handlers.routeVoiceControls(req("POST"), response, url("/v1/internal/voice/synthesize"));
  assert.equal(state.calls.at(-1)[0], "synthesize");
  assert.equal(state.calls.some((call) => call[0] === "reason" || call[0] === "turn-record"), false);
});

test("LiveKit gate invokes its supplied handler when configured", async () => {
  const state = harness(); let invoked = false;
  await state.handlers.handleLivekitGated({}, {}, async () => { invoked = true; });
  assert.equal(invoked, true);
});
