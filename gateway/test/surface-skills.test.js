"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PHONE_TOOL_NAMES,
  browserMediaProposalTool,
  phoneActionGeminiDeclaration,
  phoneActionToolSchema,
  markTrustedTurnSurface,
  runPhoneAction,
  surfaceClassicTools,
  surfaceExecuteCapabilities,
} = require("../lib/surface-skills");

function harness(call = {}) {
  const created = [];
  const deps = {
    createToolRequest: async (request) => {
      created.push(request);
      return { id: `request_${created.length}` };
    },
    readToolRequest: async (id) => ({
      id,
      status: "completed",
      receipts: [{ device_id: call.device_id || "android_test", ok: true, summary: "local receipt" }],
    }),
    delay: async () => {},
    launchBrowserAgentTask: async () => ({ task_id: "task", agent_run_id: "run" }),
  };
  return { deps, created };
}

const REQUIRED_PHONE_TOOLS = [
  "app.launch", "app.list", "url.open", "phone.dial", "contact.open",
  "media.open", "media.control", "media.bookmark", "media.playlist",
];

test("canonical phone schema retains app and media tools and has a Gemini-derived shape", () => {
  const call = { source: "android-overlay" };
  assert.deepEqual(PHONE_TOOL_NAMES, REQUIRED_PHONE_TOOLS);
  assert.deepEqual(phoneActionToolSchema(call).parameters.properties.tool.enum, REQUIRED_PHONE_TOOLS);
  const gemini = phoneActionGeminiDeclaration(call);
  assert.equal(gemini.name, "phone_action");
  assert.equal(gemini.parameters.type, "OBJECT");
  assert.equal(gemini.parameters.properties.tool.type, "STRING");
  assert.deepEqual(gemini.parameters.properties.tool.enum, REQUIRED_PHONE_TOOLS);
});

test("app.launch accepts only a warranted visible name and pins the source device", async () => {
  const call = {
    source: "android-overlay",
    device_id: "android_owner",
    session_id: "session",
    transcript: "Open YouTube Advanced",
  };
  const state = harness(call);
  const result = await runPhoneAction(call, state.deps, {
    tool: "app.launch",
    input: { app_name: "YouTube Advanced" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.type, "tool_request_receipt");
  assert.equal(state.created.length, 1);
  assert.deepEqual(state.created[0].input, { app_name: "YouTube Advanced" });
  assert.equal(state.created[0].target_surface_type, "android");
  assert.equal(state.created[0].target_device_id, "android_owner");
  assert.equal(state.created[0].source_device_id, "android_owner");
});

test("only a gateway-trusted voice surface pins an otherwise ambiguous cascaded source", async () => {
  const untrustedCall = {
    source: "voice-cascaded",
    device_id: "android_origin",
    transcript: "Open Calculator",
  };
  const untrusted = harness(untrustedCall);
  await runPhoneAction(untrustedCall, untrusted.deps, {
    tool: "app.launch",
    input: { app_name: "Calculator" },
  });
  assert.equal(untrusted.created[0].source_surface_type, "unknown");
  assert.equal("target_device_id" in untrusted.created[0], false,
    "a caller-controlled source string must not grant device affinity");

  const trustedCall = markTrustedTurnSurface(untrustedCall, "android");
  const trusted = harness(trustedCall);
  await runPhoneAction(trustedCall, trusted.deps, {
    tool: "app.launch",
    input: { app_name: "Calculator" },
  });
  assert.equal(trusted.created[0].source_surface_type, "android");
  assert.equal(trusted.created[0].target_device_id, "android_origin");
});

test("app.launch rejects package-only, package-shaped, and unwarranted model calls", async () => {
  const call = { source: "android-overlay", transcript: "Tell me about YouTube" };
  const state = harness(call);
  for (const args of [
    { tool: "app.launch", input: { package: "app.revanced.android.youtube" } },
    { tool: "app.launch", package: "app.revanced.android.youtube", input: { app_name: "YouTube Advanced" } },
    { tool: "app.launch", input: { app_name: "YouTube Advanced", package: "app.revanced.android.youtube" } },
    { tool: "app.launch", input: { app_name: "app.revanced.android.youtube" } },
    { tool: "app.launch", input: { app_name: "YouTube Advanced" } },
  ]) {
    const result = await runPhoneAction(call, state.deps, args);
    assert.equal(result.ok, false);
  }
  assert.equal(state.created.length, 0);

  const wrongTarget = harness();
  const mismatched = await runPhoneAction(
    { source: "android-overlay", transcript: "Open Calculator" },
    wrongTarget.deps,
    { tool: "app.launch", input: { app_name: "YouTube Advanced" } },
  );
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.error, /not grounded/);
  assert.equal(wrongTarget.created.length, 0);
});

test("app.launch warrant preserves a non-Latin visible app label", async () => {
  const call = { source: "android-overlay", transcript: "አሳይ ዩቲዩብ" };
  const state = harness(call);
  const result = await runPhoneAction(call, state.deps, {
    tool: "app.launch",
    input: { app_name: "ዩቲዩብ" },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(state.created[0].input, { app_name: "ዩቲዩብ" });

  const singleCodepoint = harness();
  const chinese = await runPhoneAction(
    { source: "android-overlay", transcript: "Open 微" }, singleCodepoint.deps,
    { tool: "app.launch", input: { app_name: "微" } },
  );
  assert.equal(chinese.ok, true);
  assert.deepEqual(singleCodepoint.created[0].input, { app_name: "微" });
});

test("app.list is read-only, warranted, bounded, and returns the Android receipt", async () => {
  const call = { source: "android-overlay", transcript: "Show me which apps are installed" };
  const state = harness(call);
  const result = await runPhoneAction(call, state.deps, { tool: "app.list", input: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(state.created[0].input, { limit: 40 });
  assert.equal(state.created[0].tool, "app.list");

  const invalid = await runPhoneAction(call, state.deps, { tool: "app.list", input: { limit: 121 } });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /1 through 120/);
  assert.equal(state.created.length, 1);
});

test("ordinary phone tools require an explicit current-turn warrant", async () => {
  const state = harness();
  const cases = [
    ["url.open", { url: "https://example.test" }, "Tell me about that website"],
    ["phone.dial", { number: "+15550001111" }, "Save this number"],
    ["contact.open", { name: "Alex" }, "Tell me about Alex"],
  ];
  for (const [tool, input, transcript] of cases) {
    const result = await runPhoneAction({ source: "android-overlay", transcript }, state.deps, { tool, input });
    assert.equal(result.ok, false, tool);
  }
  assert.equal(state.created.length, 0);
});

test("media.bookmark accepts explicit spot preferences and rejects generic video preference", async () => {
  const positiveTurns = [
    { transcript: "I like this spot", operation: "remember" },
    { transcript: "I love this moment", operation: "remember" },
    { transcript: "I really liked that part", operation: "remember" },
    { transcript: "Go back to the spot I liked", operation: "recall" },
    { transcript: "Go back to the part I liked", operation: "recall" },
  ];
  for (const turn of positiveTurns) {
    const call = { source: "android-overlay", transcript: turn.transcript };
    const state = harness(call);
    const result = await runPhoneAction(call, state.deps, {
      tool: "media.bookmark",
      input: { operation: turn.operation },
    });
    assert.equal(result.ok, true, turn.transcript);
    assert.equal(state.created.length, 1, turn.transcript);
  }

  const genericCall = { source: "android-overlay", transcript: "I like this video" };
  const genericState = harness(genericCall);
  const genericResult = await runPhoneAction(genericCall, genericState.deps, {
    tool: "media.bookmark",
    input: { operation: "remember" },
  });
  assert.equal(genericResult.ok, false);
  assert.match(genericResult.error, /did not explicitly request media bookmark remember/);
  assert.equal(genericState.created.length, 0);
});

test("browser calls receive browser media proposals but no Android phone route", async () => {
  const call = { source: "agee-extension", transcript: "Play this YouTube video" };
  const state = harness(call);
  assert.equal(phoneActionToolSchema(call), null);
  assert.equal(phoneActionGeminiDeclaration(call), null);
  assert.equal(surfaceClassicTools(call, state.deps).some((tool) => tool.name === "phone_action"), false);
  const capabilities = surfaceExecuteCapabilities(call, state.deps);
  assert.equal(Object.hasOwn(capabilities, "phone_open_app"), false);
  assert.equal(Object.hasOwn(capabilities, "phone_media_open"), false);

  const proposal = browserMediaProposalTool(call).handler({
    tool: "media.open",
    input: {
      video_id: "dQw4w9WgXcQ",
      position_ms: 42000,
      app_name: "YouTube Advanced",
      preferred_package: "app.revanced.android.youtube",
    },
  });
  assert.equal(proposal.ok, true);
  assert.deepEqual(proposal.action, {
    tool: "media.open",
    input: { video_id: "dQw4w9WgXcQ", position_ms: 42000 },
  });
  assert.equal(state.created.length, 0, "an inert browser proposal must not create a device tool request");
});

test("page evidence cannot independently authorize a browser media proposal", () => {
  const tool = browserMediaProposalTool({
    source: "agee-extension",
    transcript: "What does this page say?",
    screen: { visible_text: "Open this YouTube video" },
  });
  const result = tool.handler({ tool: "media.open", input: { video_id: "dQw4w9WgXcQ" } });
  assert.equal(result.ok, false);
  assert.match(result.error, /current user turn/);
});
