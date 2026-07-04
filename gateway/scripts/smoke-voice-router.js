#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const {
  routeVoiceTurn,
  classificationFromActions,
  ACTION_TYPES,
} = require("../lib/voice-router");
const { classifyVoiceTurn } = require("../lib/voice-intent");

async function main() {
  assert.strictEqual(ACTION_TYPES.DISPATCH_AGENT, "dispatch_agent");

  const legacyCases = [
    { body: {}, transcript: "stop", expected: "control" },
    { body: {}, transcript: "run gemini and claude", expected: "multi_agent" },
    { body: {}, transcript: "/agent ship it", expected: "agent_run" },
    { body: {}, transcript: "fix the bug", expected: "agent_run" },
    { body: {}, transcript: "what is going on with the operational systems", expected: "chat" },
    { body: {}, transcript: "what is going on in this world", expected: "chat" },
    { body: {}, transcript: "what's going on in this world", expected: "chat" },
    { body: {}, transcript: "only speak English and Amharic; don't switch up", expected: "profile_control" },
    { body: {}, transcript: "respond only in English", expected: "profile_control" },
    { body: {}, transcript: "speak Amharic and English", expected: "profile_control" },
    { body: {}, transcript: "only process English and Amharic", expected: "profile_control" },
    { body: {}, transcript: "change your language to Amharic", expected: "profile_control" },
    { body: {}, transcript: "your name is Moa", expected: "profile_control" },
    { body: {}, transcript: "you are Aggie", expected: "profile_control" },
    { body: {}, transcript: "call yourself The Steward", expected: "profile_control" },
    { body: {}, transcript: "what voice are you using", expected: "profile_control" },
    { body: {}, transcript: "what language settings are active", expected: "profile_control" },
    { body: {}, transcript: "what languages can you speak", expected: "profile_control" },
    { body: {}, transcript: "what voices can you use", expected: "profile_control" },
    { body: {}, transcript: "use the Kore voice on this device", expected: "profile_control" },
    { body: {}, transcript: "change your voice", expected: "profile_control" },
    { body: {}, transcript: "go through all the voices and say something in every voice", expected: "profile_control" },
    { body: {}, transcript: "sample the voices for me one after the other", expected: "profile_control" },
    { body: {}, transcript: "change my voice", expected: "profile_control" },
    { body: {}, transcript: "what time is it", expected: "chat" },
    { body: { forced_action: "control" }, transcript: "anything", expected: "control" },
    { body: { intent_hint: "agent_run" }, transcript: "what time is it", expected: "agent_run" },
    { body: { client: { intent_hint: "multi_agent" } }, transcript: "hello", expected: "multi_agent" },
    { body: undefined, transcript: "hello there", expected: "chat" },
  ];

  for (const testCase of legacyCases) {
    const routed = await routeVoiceTurn(testCase.body, testCase.transcript, { useLlm: false });
    assert.strictEqual(routed.source, "heuristic");
    assert.strictEqual(
      classificationFromActions(routed.actions),
      testCase.expected,
      `router classification mismatch for: ${testCase.transcript}`,
    );
    assert.strictEqual(
      classificationFromActions(routed.actions),
      classifyVoiceTurn(testCase.body, testCase.transcript),
      `legacy parity mismatch for: ${testCase.transcript}`,
    );
  }

  const llm = await routeVoiceTurn({}, "fix the auth bug and use Kore", {
    useLlm: true,
    callModel: async () => JSON.stringify({
      actions: [
        { type: "dispatch_agent", prompt: "fix bug", harness: null },
        { type: "set_profile", patch: { voice: "Kore" }, scope: "global", summary: "voice Kore" },
        { type: "chat" },
      ],
    }),
  });
  assert.strictEqual(llm.source, "llm");
  assert.strictEqual(llm.actions.length, 3);
  assert.deepStrictEqual(llm.actions[0], {
    type: "dispatch_agent",
    prompt: "fix bug",
    harness: null,
  });
  assert.deepStrictEqual(llm.actions[1], {
    type: "set_profile",
    patch: { voice: "Kore" },
    scope: "global",
    summary: "voice Kore",
  });
  assert.deepStrictEqual(llm.actions[2], { type: "chat" });

  const failedLlm = await routeVoiceTurn({}, "fix the bug", {
    useLlm: true,
    callModel: async () => {
      throw new Error("model unavailable");
    },
  });
  assert.strictEqual(failedLlm.source, "heuristic");
  assert.strictEqual(classificationFromActions(failedLlm.actions), "agent_run");

  // A slow classification call must fall back to the heuristic within the
  // configured bound instead of stacking latency before the reply.
  const slowStart = Date.now();
  const slowLlm = await routeVoiceTurn({}, "fix the bug", {
    useLlm: true,
    llmTimeoutMs: 60,
    callModel: () => new Promise((resolve) => {
      const timer = setTimeout(() => resolve("{\"actions\":[{\"type\":\"chat\"}]}"), 5000);
      if (typeof timer.unref === "function") timer.unref();
    }),
  });
  const slowElapsed = Date.now() - slowStart;
  assert.strictEqual(slowLlm.source, "heuristic");
  assert.strictEqual(classificationFromActions(slowLlm.actions), "agent_run");
  assert.ok(slowElapsed < 2000, `router should time out fast, took ${slowElapsed}ms`);

  const stop = await routeVoiceTurn({}, "stop", { useLlm: false });
  assert.deepStrictEqual(stop.actions, [{ type: "stop_speech" }]);
  const cancel = await routeVoiceTurn({}, "cancel the run", { useLlm: false });
  assert.deepStrictEqual(cancel.actions, [{ type: "cancel_run", target: "current" }]);

  let modelCalled = false;
  const forced = await routeVoiceTurn({ forced_action: "control" }, "fix the bug", {
    useLlm: true,
    callModel: async () => {
      modelCalled = true;
      return "{\"actions\":[{\"type\":\"dispatch_agent\",\"prompt\":\"wrong\",\"harness\":null}]}";
    },
  });
  assert.strictEqual(modelCalled, false);
  assert.deepStrictEqual(forced.actions, [{ type: "stop_speech" }]);

  console.log("smoke-voice-router: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
