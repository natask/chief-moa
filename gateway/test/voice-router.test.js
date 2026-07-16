"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { ACTION_TYPES, classificationFromActions, routeVoiceTurn } = require("../lib/voice-router");

test("classification covers control, profile, dispatch, and malformed lists", () => {
  assert.equal(classificationFromActions(), "chat");
  assert.equal(classificationFromActions([null, { type: ACTION_TYPES.STOP_SPEECH }]), "control");
  assert.equal(classificationFromActions([{ type: ACTION_TYPES.CANCEL_RUN }]), "control");
  for (const type of [ACTION_TYPES.SET_PROFILE, ACTION_TYPES.QUERY_PROFILE, ACTION_TYPES.SAMPLE_VOICES, ACTION_TYPES.CLARIFY_VOICE]) {
    assert.equal(classificationFromActions([{ type }]), "profile_control");
  }
  assert.equal(classificationFromActions([{ type: ACTION_TYPES.DISPATCH_AGENT }]), "agent_run");
  assert.equal(classificationFromActions([{ type: ACTION_TYPES.DISPATCH_AGENT }, { type: ACTION_TYPES.DISPATCH_AGENT }]), "multi_agent");
});

test("forced actions honor body precedence and safe fallbacks", async () => {
  let routed = await routeVoiceTurn({ forced_action: " PROFILE_CONTROL " }, "hello", { useLlm: false });
  assert.deepEqual(routed.actions, [{ type: "query_profile", subject: "profile", scope: "global" }]);

  routed = await routeVoiceTurn({ client: { intent_hint: "multi_agent" }, intent_hint: "chat" }, " delegate this ", { useLlm: false });
  assert.equal(routed.actions.length, 2);
  assert.ok(routed.actions.every((action) => action.prompt === "delegate this"));

  routed = await routeVoiceTurn({ forced_action: "invalid" }, "ordinary chat", { useLlm: false });
  assert.deepEqual(routed.actions, [{ type: "chat" }]);

  routed = await routeVoiceTurn({ intent_hint: "agent_run" }, "/agent   ship it", { useLlm: false });
  assert.equal(routed.actions[0].type, "dispatch_agent");
  assert.equal(routed.actions[0].prompt, "ship it");

  routed = await routeVoiceTurn({ intent_hint: "chat" }, "fix it", { useLlm: false });
  assert.deepEqual(routed.actions, [{ type: "chat" }]);
});

test("heuristic cancellation distinguishes all, current, stop speech, and chat", async () => {
  assert.deepEqual((await routeVoiceTurn({}, "kill every agent", { useLlm: false })).actions, [{ type: "cancel_run", target: "all" }]);
  assert.deepEqual((await routeVoiceTurn({}, "stop the task", { useLlm: false })).actions, [{ type: "cancel_run", target: "current" }]);
  assert.deepEqual((await routeVoiceTurn({}, "be quiet", { useLlm: false })).actions, [{ type: "stop_speech" }]);
  assert.deepEqual((await routeVoiceTurn({}, "", { useLlm: false })).actions, [{ type: "chat" }]);
  assert.deepEqual((await routeVoiceTurn({}, "please switch languages when useful", { useLlm: false })).actions, [{ type: "clarify_voice", scope: "global" }]);
});

test("LLM routing normalizes every allowed action and drops unsafe entries", async () => {
  const rawActions = [
    null,
    { type: "unknown" },
    { type: "stop_speech", extra: true },
    { type: "cancel_run", target: "all" },
    { type: "cancel_run", target: "other" },
    { type: "set_profile", patch: { voice: "Kore" }, scope: "device", summary: "voice" },
    { type: "set_profile", patch: [], scope: "bad" },
    { type: "query_profile", subject: "languages", scope: "device" },
    { type: "query_profile" },
    { type: "sample_voices", sample_text: "hello", scope: "bad" },
    { type: "clarify_voice", scope: "device" },
    { type: "dispatch_agent", prompt: 42 },
    { type: "dispatch_agent", prompt: "ship", harness: "codex" },
    { type: "dispatch_agent", prompt: "default harness", harness: 1 },
    { type: "chat", text: "answer" },
    { type: "chat", text: 4 },
  ];
  const routed = await routeVoiceTurn({}, "route this", {
    useLlm: true,
    callModel: async (messages) => {
      assert.equal(messages[0].role, "system");
      assert.equal(messages[1].content, "route this");
      return `prefix ${JSON.stringify({ actions: rawActions })} suffix`;
    },
  });
  assert.equal(routed.source, "llm");
  assert.deepEqual(routed.actions, [
    { type: "stop_speech" },
    { type: "cancel_run", target: "all" },
    { type: "cancel_run", target: "current" },
    { type: "set_profile", patch: { voice: "Kore" }, scope: "device", summary: "voice" },
    { type: "set_profile", patch: {}, scope: "global", summary: "profile" },
    { type: "query_profile", subject: "languages", scope: "device" },
    { type: "query_profile", subject: "profile", scope: "global" },
    { type: "sample_voices", sample_text: "hello", scope: "global" },
    { type: "clarify_voice", scope: "device" },
    { type: "dispatch_agent", prompt: "ship", harness: "codex" },
    { type: "dispatch_agent", prompt: "default harness", harness: null },
    { type: "chat", text: "answer" },
    { type: "chat" },
  ]);
});

test("LLM parser handles escaped nested JSON and falls back on malformed output", async () => {
  const escaped = await routeVoiceTurn({}, "quoted", {
    useLlm: true,
    callModel: async () => 'analysis {"actions":[{"type":"chat","text":"a \\\"quoted\\\" {value}"}]} trailing',
  });
  assert.deepEqual(escaped.actions, [{ type: "chat", text: 'a "quoted" {value}' }]);

  for (const raw of ["no object", '{"actions":[]', '{"actions":not-json}', '{"other":true}', '{"actions":[null,{"type":"bad"}]}']) {
    const routed = await routeVoiceTurn({}, "ordinary chat", { useLlm: true, callModel: async () => raw });
    assert.equal(routed.source, "heuristic");
    assert.deepEqual(routed.actions, [{ type: "chat" }]);
  }
});

test("LLM enablement and timeout bounds honor options and environment", async (t) => {
  const oldEnabled = process.env.VOICE_ROUTER_LLM;
  const oldTimeout = process.env.VOICE_ROUTER_LLM_TIMEOUT_MS;
  t.after(() => {
    if (oldEnabled === undefined) delete process.env.VOICE_ROUTER_LLM;
    else process.env.VOICE_ROUTER_LLM = oldEnabled;
    if (oldTimeout === undefined) delete process.env.VOICE_ROUTER_LLM_TIMEOUT_MS;
    else process.env.VOICE_ROUTER_LLM_TIMEOUT_MS = oldTimeout;
  });

  process.env.VOICE_ROUTER_LLM = "1";
  process.env.VOICE_ROUTER_LLM_TIMEOUT_MS = "5";
  let routed = await routeVoiceTurn({}, "hello", { callModel: () => new Promise(() => {}) });
  assert.equal(routed.source, "heuristic");

  process.env.VOICE_ROUTER_LLM_TIMEOUT_MS = "invalid";
  routed = await routeVoiceTurn({}, "hello", {
    useLlm: true,
    llmTimeoutMs: "invalid",
    callModel: async () => '{"actions":[{"type":"chat"}]}',
  });
  assert.equal(routed.source, "llm");

  routed = await routeVoiceTurn({}, "hello", { useLlm: true });
  assert.equal(routed.source, "heuristic");
});
