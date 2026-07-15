"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPresentationHandlers } = require("../lib/presentation-handlers");

function harness(overrides = {}) {
  const calls = { models: [], sessions: [] };
  const evaluator = {
    buildEvaluatorMessages: (input) => [{ role: "user", content: JSON.stringify(input) }],
    parseLive: (reply) => ({ ok: true, nudge: reply, on_track: true }),
    parseFinal: (reply) => ({ ok: true, verdict: reply, weighted: 80 }),
    ...overrides.evaluator,
  };
  const deps = {
    authorized: () => true,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    readJsonBody: async (request) => request.body || {},
    sanitizeOptionalId: (value) => `safe-${value}`,
    listVoiceTurnsForSession: (id) => { calls.sessions.push(id); return [{ transcript: "stored turn" }]; },
    callModel: async (messages, profile) => { calls.models.push({ messages, profile }); return "model reply"; },
    effectiveProfile: () => ({ persona: "judge" }),
    cleanError: (error) => error.message,
    evaluator,
    ...overrides,
    evaluator,
  };
  return { handlers: createPresentationHandlers(deps), calls };
}

const request = (method, body = {}) => ({ method, body });
const url = (pathname) => new URL(`https://gateway.test${pathname}`);

test("router ignores unrelated traffic and protects the evaluation route", async () => {
  let state = harness();
  assert.equal(await state.handlers.routePresentation(request("GET"), {}, url("/v1/presentation/evaluate")), false);
  assert.equal(await state.handlers.routePresentation(request("POST"), {}, url("/elsewhere")), false);

  state = harness({ authorized: () => false });
  const response = {};
  assert.equal(await state.handlers.routePresentation(request("POST"), response, url("/v1/presentation/evaluate")), true);
  assert.deepEqual(response, { status: 401, payload: { error: "missing or invalid gateway token" } });
});

test("final evaluation prefers inline turns and defaults mode", async () => {
  const state = harness();
  const response = {};
  const body = { mode: "unexpected", session_id: "session-1", turns: [{ transcript: "inline" }], deck: ["beat"], elapsed_sec: "12" };
  assert.equal(await state.handlers.routePresentation(request("POST", body), response, url("/v1/presentation/evaluate")), true);
  assert.equal(response.status, 200);
  assert.deepEqual(response.payload, {
    mode: "final",
    session_id: "safe-session-1",
    turns_seen: 1,
    ok: true,
    verdict: "model reply",
    weighted: 80,
  });
  assert.deepEqual(state.calls.sessions, []);
  assert.deepEqual(state.calls.models[0].profile, { persona: "judge" });
  assert.match(state.calls.models[0].messages[0].content, /"elapsedSec":12/);
});

test("live evaluation loads stored session turns and parses a nudge", async () => {
  const state = harness();
  const response = {};
  await state.handlers.handleEvaluate(request("POST", { mode: "live", session_id: "voice-1", turns: [] }), response);
  assert.deepEqual(state.calls.sessions, ["safe-voice-1"]);
  assert.deepEqual(response.payload, {
    mode: "live",
    session_id: "safe-voice-1",
    turns_seen: 1,
    ok: true,
    nudge: "model reply",
    on_track: true,
  });
});

test("missing inline and stored transcripts return a bounded request error", async () => {
  let state = harness();
  let response = {};
  await state.handlers.handleEvaluate(request("POST"), response);
  assert.deepEqual(response, {
    status: 400,
    payload: { error: "no transcript: pass session_id with captured turns, or turns inline" },
  });

  state = harness({ listVoiceTurnsForSession: () => [] });
  response = {};
  await state.handlers.handleEvaluate(request("POST", { session_id: "empty" }), response);
  assert.equal(response.status, 400);
});

test("model failures are translated without parsing provider output", async () => {
  let parsed = false;
  const state = harness({
    callModel: async () => { throw new Error("provider offline"); },
    evaluator: { parseFinal: () => { parsed = true; return {}; } },
  });
  const response = {};
  await state.handlers.handleEvaluate(request("POST", { turns: [{ text: "pitch" }] }), response);
  assert.deepEqual(response, { status: 502, payload: { error: "evaluator model call failed: provider offline" } });
  assert.equal(parsed, false);
});

test("default evaluator dependency accepts a real live reply", async () => {
  const calls = [];
  const handlers = createPresentationHandlers({
    authorized: () => true,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    readJsonBody: async (requestValue) => requestValue.body,
    sanitizeOptionalId: String,
    listVoiceTurnsForSession: () => [],
    callModel: async (messages) => { calls.push(messages); return '{"nudge":"Show the demo.","on_track":false}'; },
    effectiveProfile: () => ({}),
    cleanError: String,
  });
  const response = {};
  await handlers.handleEvaluate(request("POST", { mode: "live", turns: [{ transcript: "opening" }] }), response);
  assert.equal(response.payload.nudge, "Show the demo.");
  assert.equal(response.payload.on_track, false);
  assert.match(calls[0][0].content, /Mode: LIVE/);
});
