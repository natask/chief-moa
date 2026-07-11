#!/usr/bin/env node
"use strict";

// Smoke for the cascaded voice REASONER (server-side leg 2), driven in-process.
// The provider-level smoke (smoke-cascaded-voice.js) stubs the reasoner; this one
// exercises the real gateway reasoner so its OUTPUT-context and model-routing
// behavior is covered. No network: global.fetch is stubbed to capture the model
// request and return a canned reply.
//
// Asserts:
//   1. History injection: a prior turn's transcript reaches the reasoning model's
//      messages, so a spoken cascaded turn is no longer amnesiac.
//   2. Modality hint: the reasoner tells the model how the reply is delivered
//      (response_modality, hosted-TTS availability, previous tts_error) so it can
//      answer "why did you reply in text?" truthfully.
//   3. Model tool loop: a chat turn where the model calls update_agent_profile
//      patches the profile through the shared sanitizer, and a second round
//      returns the spoken confirmation text.
//   4. Model routing: profile.model + profile.reasoning_provider route the next
//      cascaded reasoning call to the selected provider/model (openai + vertex).
//   5. Expressive speech: on the gemini-tts leg the reasoner prompts for style +
//      inline tags, then splits a reply into a clean display transcript, the
//      whitelisted-tag speech text, and the style prompt.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "cascaded-reasoner-smoke-token";
const SESSION_ID = "cascaded-reasoner-smoke-session";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-cascaded-reasoner-"));
const dataDir = path.join(tempDir, "data");

process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
process.env.MOA_MODE = "local";
process.env.DATA_DIR = dataDir;
process.env.ANDROID_OTA_DIR = path.join(dataDir, "android-ota");
process.env.MOA_GATEWAY_TOKEN = TOKEN;
process.env.MODEL_PROVIDER = "openai-compatible";
process.env.MODEL_ID = "cascaded-reasoner-smoke-model";
process.env.MODEL_BASE_URL = "https://model.smoke.test/v1";
process.env.MODEL_API_KEY = "cascaded-reasoner-smoke-key";
process.env.OPENAI_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
process.env.GEMINI_API_KEY = "";
// Vertex routing target for the model-routing case. VERTEX_ACCESS_TOKEN bypasses
// the ADC/gcloud token exchange so the only network call is the stubbed model
// generateContent request.
process.env.VERTEX_PROJECT = "cascaded-reasoner-smoke-project";
process.env.VERTEX_LOCATION = "us-central1";
process.env.VERTEX_ACCESS_TOKEN = "cascaded-reasoner-smoke-vertex-token";

const previousFetch = global.fetch;
const fetchCalls = [];
// When set, the model returns this tool call on the first round of a tools
// request (no prior tool result), then plain confirmation text on the next round.
let pendingToolCall = null;
// When set, the model returns this exact text as its plain reply content.
let pendingReply = null;
let pendingContextDecision = null;
// When set, streaming (stream:true or :streamGenerateContent) requests consume
// one round of SSE events per request. The literal "__fault__" makes the body
// throw mid-stream, exercising the per-round non-streaming fallback.
let pendingStreamRounds = null;

function sseResponse(events) {
  async function* body() {
    for (const event of events) {
      if (event === "__fault__") {
        throw new Error("simulated SSE transport fault");
      }
      // Plain Uint8Array, NOT Buffer: undici's fetch yields Uint8Array chunks
      // in production. A stub that yields Buffer hid the String(chunk)
      // corruption bug (2026-07-07 empty-voice-reply incident), so the stub
      // must match the real chunk type.
      yield new Uint8Array(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
    }
    yield new Uint8Array(Buffer.from("data: [DONE]\n\n"));
  }
  return { ok: true, status: 200, body: body(), json: async () => ({}), text: async () => "" };
}

global.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes(":streamGenerateContent")) {
    const body = JSON.parse(String(options.body || "{}"));
    fetchCalls.push({ kind: "vertex-stream", url: u, body });
    if (Array.isArray(pendingStreamRounds) && pendingStreamRounds.length > 0) {
      return sseResponse(pendingStreamRounds.shift());
    }
    return sseResponse([{ candidates: [{ content: { parts: [{ text: "Understood, master." }] } }] }]);
  }
  if (u.includes("/chat/completions")) {
    const body = JSON.parse(String(options.body || "{}"));
    const contextPreflight = body.tool_choice?.function?.name === "context_management";
    fetchCalls.push({ kind: contextPreflight ? "context-preflight" : "openai", url: u, body });
    if (contextPreflight) {
      const decision = pendingContextDecision || { action: "continue", retrieval_query: "" };
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "context_1", type: "function", function: { name: "context_management", arguments: JSON.stringify(decision) } }] } }] });
    }
    if (body.stream === true && Array.isArray(pendingStreamRounds) && pendingStreamRounds.length > 0) {
      return sseResponse(pendingStreamRounds.shift());
    }
    const hasToolResult = Array.isArray(body.messages) && body.messages.some((m) => m.role === "tool");
    if (pendingToolCall && !hasToolResult) {
      return jsonResponse({
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: pendingToolCall.name, arguments: JSON.stringify(pendingToolCall.arguments || {}) },
            }],
          },
        }],
      });
    }
    return jsonResponse({
      choices: [{ message: { role: "assistant", content: pendingReply != null ? pendingReply : (pendingToolCall ? "Done, master — switched to the Charon voice." : "Understood, master.") } }],
    });
  }
  if (u.includes(":generateContent")) {
    const body = JSON.parse(String(options.body || "{}"));
    const contextPreflight = body.toolConfig?.functionCallingConfig?.allowedFunctionNames?.includes("context_management");
    fetchCalls.push({ kind: contextPreflight ? "context-preflight" : "vertex", url: u, body });
    if (contextPreflight) {
      const decision = pendingContextDecision || { action: "continue", retrieval_query: "" };
      return jsonResponse({ candidates: [{ content: { parts: [{ functionCall: { name: "context_management", args: decision } }] } }] });
    }
    return jsonResponse({ candidates: [{ content: { parts: [{ text: "Understood, master." }] } }] });
  }
  throw new Error(`unexpected fetch to ${u}`);
};

const {
  server,
  runCascadedVoiceReasoning,
  recordStreamingVoiceTurn,
  agentProfile,
} = require(path.join(GATEWAY_DIR, "server"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}).finally(() => {
  global.fetch = previousFetch;
  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  await historyReachesTheModel();
  await modalityHintIsInjected();
  await modelToolCallUpdatesProfile();
  await modelToolCallLaunchesAgentRun();
  await modelAndReasoningProviderRoute();
  await expressiveDirectiveAndParsing();
  await streamingDeltasForPlainReply();
  await streamingToolRoundOnlyTextIsFlushed();
  await streamingVertexDeltasAndEndpoint();
  await streamingVertexReplaysThoughtSignature();
  await streamingSseFaultFallsBackPerRound();
  await sessionPersonaReachesTheModel();
  await completedCascadedRetryIsIdempotent();
  await incognitoClassificationHasNoDurableEffects();
  await modelSelectedColdScopesAreCaptured();

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "a prior voice turn's transcript reaches the cascaded reasoning model messages",
      "the reasoner injects a modality/TTS delivery hint (modality, availability, previous error)",
      "a model update_agent_profile tool call patches the profile through the sanitizer and the confirmation is spoken",
      "a model launch_agent_run tool call starts a run in this session's work state, and the transcript gate blocks launches the user never asked for",
      "profile.model and profile.reasoning_provider route the next reasoning call to the selected provider/model",
      "on gemini-tts the reasoner prompts for expressive speech and splits style, tags, and clean display text",
      "with on_speak_delta the reasoner streams the final answer via SSE (stream:true) and the deltas equal the returned speak",
      "tool-round-only text is buffered, flushed to deltas at loop end, and the tool handler runs (streaming loop)",
      "reasoning_provider=vertex streams over :streamGenerateContent?alt=sse and deltas fire only for final text",
      "SSE stubs yield Uint8Array chunks (undici shape) and the parser still decodes them",
      "a signed vertex functionCall part replays with its thoughtSignature on the next round",
      "an SSE transport fault falls back to one non-streaming call for that round and the reply is still spoken",
      "a session persona (pet name/character) becomes a system block for that turn and is absent without one",
      "a completed cascaded turn replay skips preflight and preserves its filing branch",
      "an incognito agent classification launches no action and stores no voice turn",
      "model-selected new/incognito cascaded answers are standing-only and stream only after preflight",
    ],
  }, null, 2));
}

async function modelSelectedColdScopesAreCaptured() {
  const callerSentinel = "CASCADED_CALLER_RECENCY_SENTINEL";
  const standingSentinel = "CASCADED_STANDING_FACT_SENTINEL";
  await recordStreamingVoiceTurn({
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    branch_id: "default",
    turn_id: "cascaded-cold-scope-seed",
    source: "voice-cascaded",
    transcript: callerSentinel,
    assistant_text: "seeded",
  });
  const originalStanding = require(path.join(GATEWAY_DIR, "server")).brain.recallStandingFacts;
  require(path.join(GATEWAY_DIR, "server")).brain.recallStandingFacts = () => [{ slug: "standing/cascaded", snippet: standingSentinel }];
  try {
    fetchCalls.length = 0;
    const deltas = [];
    pendingContextDecision = { action: "new", retrieval_query: "cold scope" };
    const fresh = await runCascadedVoiceReasoning({
      session_id: SESSION_ID,
      conversation_id: SESSION_ID,
      branch_id: "default",
      turn_id: "cascaded-model-new",
      source: "voice-cascaded",
      transcript: "draft an unrelated quarterly plan",
      on_speak_delta: (delta) => deltas.push(delta),
    });
    assert.equal(fresh.context.action, "new");
    assert.ok(deltas.length > 0, "streamed answer must emit after decision phase");
    const preflightIndex = fetchCalls.findIndex((call) => call.kind === "context-preflight");
    const answerIndex = fetchCalls.findIndex((call) => call.kind === "openai");
    assert.ok(preflightIndex >= 0 && answerIndex > preflightIndex, "answer request must follow preflight");
    const preflight = fetchCalls[preflightIndex].body;
    const answer = fetchCalls[answerIndex].body;
    assert.doesNotMatch(JSON.stringify(preflight), new RegExp(`${callerSentinel}|${standingSentinel}`));
    assert.match(JSON.stringify(answer.messages), new RegExp(standingSentinel));
    assert.doesNotMatch(JSON.stringify(answer.messages), new RegExp(callerSentinel));

    fetchCalls.length = 0;
    pendingContextDecision = { action: "incognito", retrieval_query: "private scope" };
    const privateTurn = await runCascadedVoiceReasoning({
      session_id: SESSION_ID,
      conversation_id: SESSION_ID,
      branch_id: "default",
      turn_id: "cascaded-model-incognito",
      source: "voice-cascaded",
      transcript: "keep this off the record while you answer privately",
    });
    assert.equal(privateTurn.context.action, "incognito");
    const privateAnswer = fetchCalls.find((call) => call.kind === "openai").body;
    assert.match(JSON.stringify(privateAnswer.messages), new RegExp(standingSentinel));
    assert.doesNotMatch(JSON.stringify(privateAnswer.messages), new RegExp(callerSentinel));
    await recordStreamingVoiceTurn({
      session_id: SESSION_ID,
      conversation_id: SESSION_ID,
      branch_id: "default",
      turn_id: "cascaded-model-incognito",
      source: "voice-cascaded",
      transcript: "keep this off the record while you answer privately",
      assistant_text: privateTurn.display,
      context: privateTurn.context,
    });
    assert.equal(fs.existsSync(path.join(dataDir, "voice-turns", SESSION_ID, "cascaded-model-incognito.json")), false);
  } finally {
    pendingContextDecision = null;
    require(path.join(GATEWAY_DIR, "server")).brain.recallStandingFacts = originalStanding;
  }
}

async function incognitoClassificationHasNoDurableEffects() {
  const turnId = "cascaded-incognito-agent-turn";
  const input = {
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    branch_id: "default",
    turn_id: turnId,
    source: "voice-cascaded",
    context_action: "incognito",
    transcript: "fix the bug",
  };
  fetchCalls.length = 0;
  const reasoning = await runCascadedVoiceReasoning(input);
  assert.equal(reasoning.classification, "agent_run");
  const record = await recordStreamingVoiceTurn({ ...input, assistant_text: reasoning.display, context: reasoning.context });
  assert.deepEqual(record.response.actions, [], "incognito classification must execute no action");
  const stored = path.join(dataDir, "voice-turns", SESSION_ID, `${turnId}.json`);
  assert.equal(fs.existsSync(stored), false, "incognito classified turn must not persist");
  assert.equal(fetchCalls.length, 0, "explicit incognito non-chat turn must not call a provider");
}

async function completedCascadedRetryIsIdempotent() {
  const turnId = "cascaded-retry-stable-turn";
  const input = {
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    branch_id: "default",
    turn_id: turnId,
    source: "voice-cascaded",
    context_action: "new",
    transcript: "draft quarterly budget options",
  };
  fetchCalls.length = 0;
  const first = await runCascadedVoiceReasoning(input);
  assert.equal(first.classification, "chat");
  assert.ok(first.context.branch_id.startsWith("thr-"));
  assert.equal(fetchCalls.filter((call) => call.kind === "context-preflight").length, 0, "explicit new skips preflight");
  await recordStreamingVoiceTurn({
    ...input,
    assistant_text: first.display,
    reply_language: first.language,
    context: first.context,
    completed_at: new Date().toISOString(),
  });
  fetchCalls.length = 0;
  const replay = await runCascadedVoiceReasoning(input);
  assert.equal(replay.replayed, true, "completed voice turn must be replayed from storage");
  assert.equal(replay.context.branch_id, first.context.branch_id, "replay must preserve filing branch");
  assert.equal(fetchCalls.length, 0, "completed replay must make no provider request");
}

async function modelToolCallLaunchesAgentRun() {
  // A transcript that plainly asks for agent work passes the transcript gate,
  // and the model's launch_agent_run tool call queues a run bound to THIS
  // session (conversation_id = session), which is what makes the run visible
  // to later turns' session context and list_agent_runs.
  pendingToolCall = { name: "launch_agent_run", arguments: { prompt: "Research the top three voice pipelines and summarize the tradeoffs.", harness: "echo" } };
  fetchCalls.length = 0;
  try {
    await runCascadedVoiceReasoning({
      transcript: "launch an agent to research the top three voice pipelines",
      session_id: SESSION_ID,
      branch_id: "default",
      turn_id: "reasoner-agent-turn",
    });
    const openaiCalls = fetchCalls.filter((c) => c.kind === "openai");
    assert.ok(openaiCalls.length >= 1, "the reasoner must call the model");
    const offered = openaiCalls[0].body.tools.map((t) => t.function && t.function.name).filter(Boolean);
    for (const name of ["launch_agent_run", "list_agent_runs", "cancel_agent_run"]) {
      assert.ok(offered.includes(name), `${name} must be offered to the cascaded model (offered: ${offered.join(",")})`);
    }
    const runs = await requestJson("GET", "/v1/agent/runs");
    const sessionRuns = (runs.json?.runs || []).filter((run) => run.conversation_id === SESSION_ID);
    assert.ok(sessionRuns.length >= 1, `the launched run must be stored under this session (got ${JSON.stringify(runs.json).slice(0, 300)})`);

    // The full loop: the echo run executes and reaches a terminal state, so the
    // completion is visible to later turns in this session's work state.
    const deadline = Date.now() + 15000;
    let finished = null;
    while (Date.now() < deadline && !finished) {
      const poll = await requestJson("GET", "/v1/agent/runs");
      finished = (poll.json?.runs || []).find((run) => run.conversation_id === SESSION_ID
        && ["completed", "failed", "timed-out", "canceled"].includes(String(run.status)));
      if (!finished) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(finished, "the launched echo run must reach a terminal state");
    assert.equal(finished.status, "completed", `the echo run must complete (got ${finished && finished.status})`);
    const detail = await requestJson("GET", `/v1/agent/runs/${finished.id}`);
    const detailRun = detail.json?.run || detail.json || {};
    assert.ok(String(detailRun.output || detailRun.stdout || "").includes("Routed intent"), `the run output must carry the agent result back to the session (got ${JSON.stringify(detailRun).slice(0, 300)})`);
  } finally {
    pendingToolCall = null;
  }

  // The gate: a transcript with no agent request must block the same tool call.
  pendingToolCall = { name: "launch_agent_run", arguments: { prompt: "do something" } };
  fetchCalls.length = 0;
  try {
    await runCascadedVoiceReasoning({
      transcript: "what is the weather like today",
      session_id: SESSION_ID,
      branch_id: "default",
      turn_id: "reasoner-agent-blocked-turn",
    });
    const runs = await requestJson("GET", "/v1/agent/runs");
    const sessionRuns = (runs.json?.runs || []).filter((run) => run.conversation_id === SESSION_ID);
    assert.equal(sessionRuns.length, 1, "a non-agent transcript must not launch a second run");
  } finally {
    pendingToolCall = null;
  }
}

async function historyReachesTheModel() {
  // Seed a prior chat voice turn under the shared session so it becomes durable
  // history the next cascaded turn should see.
  const seed = await requestJson("POST", "/v1/voice/turns", {
    session_id: SESSION_ID,
    branch_id: "default",
    turn_id: "reasoner-seed-turn",
    source: "cascaded-reasoner-smoke",
    transcript: "my favorite color is teal",
  });
  assert.equal(seed.status, 200, `seed voice turn must succeed: ${JSON.stringify(seed.json)}`);

  fetchCalls.length = 0;
  const reasoning = await runCascadedVoiceReasoning({
    transcript: "good morning, how are you",
    session_id: SESSION_ID,
    branch_id: "default",
    turn_id: "reasoner-history-turn",
    source: "voice-cascaded",
  });

  assert.equal(reasoning.classification, "chat", "an ordinary greeting must classify as chat");
  assert.ok(String(reasoning.speak || "").length > 0, "a chat turn must produce spoken reply text");
  const call = fetchCalls.find((c) => c.kind === "openai");
  assert.ok(call, "the reasoner must call the configured model");
  const messagesText = JSON.stringify(call.body.messages || []);
  assert.match(messagesText, /my favorite color is teal/, "the prior turn transcript must reach the reasoning model messages");
}

async function modalityHintIsInjected() {
  const put = await requestJson("PUT", "/v1/agent/profile", { profile: { response_modality: "text" } });
  assert.equal(put.status, 200, `profile update must succeed: ${JSON.stringify(put.json)}`);

  fetchCalls.length = 0;
  await runCascadedVoiceReasoning({
    transcript: "tell me a short joke",
    session_id: SESSION_ID,
    branch_id: "default",
    turn_id: "reasoner-modality-turn",
    tts_provider_id: "gemini-tts",
    tts_available: true,
    previous_tts_error: "cloud TTS failed (500)",
  });

  const call = fetchCalls.find((c) => c.kind === "openai");
  assert.ok(call, "the reasoner must call the configured model");
  const messagesText = JSON.stringify(call.body.messages || []);
  assert.match(messagesText, /response_modality: text/, "the modality hint must report the current response_modality");
  assert.match(messagesText, /available via gemini-tts/, "the modality hint must report hosted-TTS availability and provider");
  assert.match(messagesText, /previous turn could not be spoken by hosted TTS: cloud TTS failed/, "the modality hint must carry the previous turn's tts_error");

  // Restore the default modality so later cases are unaffected.
  const reset = await requestJson("PUT", "/v1/agent/profile", { profile: { response_modality: "auto" } });
  assert.equal(reset.status, 200, `profile reset must succeed: ${JSON.stringify(reset.json)}`);
}

async function modelToolCallUpdatesProfile() {
  assert.notEqual(agentProfile.effective().voice, "Charon", "precondition: voice must not already be Charon");
  // The model calls update_agent_profile with a lower-case voice; the shared
  // sanitizer must canonicalize it to the valid "Charon" voice id.
  pendingToolCall = { name: "update_agent_profile", arguments: { profile: { voice: "charon" } } };
  fetchCalls.length = 0;
  try {
    const reasoning = await runCascadedVoiceReasoning({
      transcript: "good evening",
      session_id: SESSION_ID,
      branch_id: "default",
      turn_id: "reasoner-tool-turn",
    });

    const openaiCalls = fetchCalls.filter((c) => c.kind === "openai");
    assert.equal(openaiCalls.length, 2, "the tool loop must run a tool round then a final text round");
    const firstBody = openaiCalls[0].body;
    assert.ok(Array.isArray(firstBody.tools), "the first request must offer tools");
    assert.ok(firstBody.tools.some((t) => t.function && t.function.name === "update_agent_profile"), "update_agent_profile must be offered");
    const secondBody = openaiCalls[1].body;
    assert.ok(Array.isArray(secondBody.messages) && secondBody.messages.some((m) => m.role === "tool"), "the second round must carry the tool result");

    assert.equal(agentProfile.effective().voice, "Charon", "the sanitizer must canonicalize the tool's voice value and persist it");
    assert.match(String(reasoning.speak || ""), /Charon/, "the spoken confirmation must reflect the applied change");
  } finally {
    pendingToolCall = null;
    // Restore the default voice so the run leaves no residue.
    await requestJson("POST", "/v1/agent/profile/reset", { source: "cascaded-reasoner-smoke" });
  }
}

async function modelAndReasoningProviderRoute() {
  // Default (unset reasoning_provider) routes to the boot provider: openai-compatible.
  fetchCalls.length = 0;
  await runCascadedVoiceReasoning({
    transcript: "good day",
    session_id: SESSION_ID,
    branch_id: "default",
    turn_id: "reasoner-route-default",
  });
  assert.ok(fetchCalls.some((c) => c.kind === "openai"), "an unset reasoning_provider must route to the boot openai-compatible provider");
  assert.ok(!fetchCalls.some((c) => c.kind === "vertex"), "the default turn must not call Vertex");
  const openAiPreflight = fetchCalls.find((c) => c.kind === "context-preflight");
  assert.deepEqual(openAiPreflight.body.tools.map((tool) => tool.function.name), ["context_management"]);
  assert.equal(openAiPreflight.body.tool_choice.function.name, "context_management");
  assert.equal(openAiPreflight.body.messages.length, 2, "OpenAI preflight shape contains only instruction and current turn");

  // Swap reasoning_provider to vertex and model to a custom id: the next reasoning
  // call must route to Vertex generateContent for that model, no restart required.
  const put = await requestJson("PUT", "/v1/agent/profile", {
    profile: { reasoning_provider: "vertex", model: "gemini-smoke-custom" },
  });
  assert.equal(put.status, 200, `provider swap must succeed: ${JSON.stringify(put.json)}`);

  fetchCalls.length = 0;
  await runCascadedVoiceReasoning({
    transcript: "good day again",
    session_id: SESSION_ID,
    branch_id: "default",
    turn_id: "reasoner-route-vertex",
  });
  const vertexCall = fetchCalls.find((c) => c.kind === "vertex");
  const vertexPreflight = fetchCalls.find((c) => c.kind === "context-preflight");
  assert.ok(vertexCall, "reasoning_provider=vertex must route the next call to Vertex");
  assert.deepEqual(vertexPreflight.body.toolConfig.functionCallingConfig.allowedFunctionNames, ["context_management"]);
  assert.equal(vertexPreflight.body.toolConfig.functionCallingConfig.mode, "ANY");
  assert.equal(vertexPreflight.body.contents.length, 1, "Vertex preflight shape contains only current-turn contents");
  assert.match(vertexCall.url, /\/models\/gemini-smoke-custom:generateContent/, `profile.model must select the Vertex model in the URL: ${vertexCall.url}`);
  assert.ok(!fetchCalls.some((c) => c.kind === "openai"), "a vertex-routed turn must not also call the openai-compatible endpoint");

  // An invalid model id is dropped by the sanitizer, keeping the previous value.
  const bad = await requestJson("PUT", "/v1/agent/profile", { profile: { model: "bad model!!" } });
  assert.equal(bad.status, 200, `invalid model update must still return 200: ${JSON.stringify(bad.json)}`);
  assert.equal(agentProfile.effective().model, "gemini-smoke-custom", "an invalid model id must be rejected and the previous model kept");

  const reset = await requestJson("POST", "/v1/agent/profile/reset", { source: "cascaded-reasoner-smoke" });
  assert.equal(reset.status, 200, `provider reset must succeed: ${JSON.stringify(reset.json)}`);
}

async function expressiveDirectiveAndParsing() {
  pendingReply = "[style: warm, amused] Hey there [whispering] good to see you [bogustag] friend.";
  fetchCalls.length = 0;
  try {
    const reasoning = await runCascadedVoiceReasoning({
      transcript: "hello again",
      session_id: SESSION_ID,
      branch_id: "default",
      turn_id: "reasoner-expressive-turn",
      // Signals the gemini-tts leg is active so the reasoner opts into expressive
      // direction and tag parsing.
      tts_provider_id: "gemini-tts",
      tts_available: true,
    });

    const call = fetchCalls.find((c) => c.kind === "openai");
    assert.ok(call, "the reasoner must call the configured model");
    assert.match(JSON.stringify(call.body.messages || []), /Expressive voice direction/, "the reasoner must add the expressive-speech directive on the gemini-tts leg");

    assert.equal(reasoning.tts_style, "warm, amused", "the leading style directive must become the TTS style prompt");
    assert.match(reasoning.tts_text, /\[whispering\]/, "a whitelisted inline tag must survive into the speech text");
    assert.doesNotMatch(reasoning.tts_text, /\[bogustag\]/, "a non-whitelisted tag must be stripped from the speech text");
    assert.doesNotMatch(reasoning.tts_text, /\[style/i, "the style directive line must not remain in the speech text");
    assert.doesNotMatch(reasoning.speak, /\[/, "the displayed/stored reply must be clean of all bracket tags");
    assert.match(reasoning.speak, /Hey there/, "the displayed reply must keep the actual words");
  } finally {
    pendingReply = null;
  }
}

// Streaming reasoning: with on_speak_delta wired the loop uses stream:true and
// forwards final-answer deltas; the sanitized deltas concatenate to the speak.
async function streamingDeltasForPlainReply() {
  pendingStreamRounds = [[
    { choices: [{ delta: { content: "Hello " } }] },
    { choices: [{ delta: { content: "there, master." } }] },
  ]];
  fetchCalls.length = 0;
  const deltas = [];
  try {
    const reasoning = await runCascadedVoiceReasoning({
      transcript: "say hello to me",
      session_id: SESSION_ID,
      branch_id: "default",
      turn_id: "reasoner-stream-plain",
      on_speak_delta: (delta) => deltas.push(delta),
    });
    assert.equal(reasoning.speak, "Hello there, master.", `streamed reply must be returned whole (got ${JSON.stringify(reasoning.speak)})`);
    assert.ok(deltas.length >= 1, "on_speak_delta must fire");
    assert.equal(deltas.join(""), "Hello there, master.", `deltas must equal the spoken reply (got ${JSON.stringify(deltas.join(""))})`);
    const streamCall = fetchCalls.find((c) => c.kind === "openai" && c.body.stream === true);
    assert.ok(streamCall, "the reasoner must request stream:true when a delta consumer exists");
  } finally {
    pendingStreamRounds = null;
  }
}

// Tool-round text is buffered, not dropped: when the ONLY prose rides the tool
// round, the loop flushes it to deltas at loop end so it is spoken, and the
// tool handler ran through the shared sanitizer. Split tool-call argument
// fragments must accumulate by index.
async function streamingToolRoundOnlyTextIsFlushed() {
  assert.notEqual(agentProfile.effective().voice, "Charon", "precondition: voice must not already be Charon");
  pendingStreamRounds = [
    [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_s1", function: { name: "update_agent_profile", arguments: "{\"profile\":{\"voi" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "ce\":\"charon\"}}" } }] } }] },
      { choices: [{ delta: { content: "Done, master. Charon voice is active." } }] },
    ],
    [
      { choices: [{ delta: { content: "" } }] },
    ],
  ];
  fetchCalls.length = 0;
  const deltas = [];
  try {
    const reasoning = await runCascadedVoiceReasoning({
      transcript: "good evening",
      session_id: SESSION_ID,
      branch_id: "default",
      turn_id: "reasoner-stream-toolround",
      on_speak_delta: (delta) => deltas.push(delta),
    });
    assert.equal(agentProfile.effective().voice, "Charon", "the streamed tool call must patch the profile through the sanitizer");
    assert.equal(reasoning.speak, "Done, master. Charon voice is active.");
    assert.equal(deltas.join(""), "Done, master. Charon voice is active.", "the tool round's buffered text must be flushed to deltas at loop end");
  } finally {
    pendingStreamRounds = null;
    await requestJson("POST", "/v1/agent/profile/reset", { source: "cascaded-reasoner-smoke" });
  }
}

// Vertex streaming: the loop switches to :streamGenerateContent?alt=sse and
// forwards text-part deltas from the SSE chunks.
async function streamingVertexDeltasAndEndpoint() {
  const put = await requestJson("PUT", "/v1/agent/profile", {
    profile: { reasoning_provider: "vertex", model: "gemini-stream-custom" },
  });
  assert.equal(put.status, 200, `provider swap must succeed: ${JSON.stringify(put.json)}`);
  pendingStreamRounds = [[
    { candidates: [{ content: { parts: [{ text: "Selam " }] } }] },
    { candidates: [{ content: { parts: [{ text: "friend, master." }] } }] },
  ]];
  fetchCalls.length = 0;
  const deltas = [];
  try {
    const reasoning = await runCascadedVoiceReasoning({
      transcript: "greet me warmly",
      session_id: SESSION_ID,
      branch_id: "default",
      turn_id: "reasoner-stream-vertex",
      on_speak_delta: (delta) => deltas.push(delta),
    });
    const streamCall = fetchCalls.find((c) => c.kind === "vertex-stream");
    assert.ok(streamCall, "reasoning_provider=vertex must stream over :streamGenerateContent");
    assert.match(streamCall.url, /:streamGenerateContent\?alt=sse/, `the streaming URL must use alt=sse (got ${streamCall && streamCall.url})`);
    assert.match(streamCall.url, /gemini-stream-custom/, "profile.model must select the streamed Vertex model");
    assert.equal(reasoning.speak, "Selam friend, master.");
    assert.equal(deltas.join(""), "Selam friend, master.", "vertex deltas must equal the spoken reply");
  } finally {
    pendingStreamRounds = null;
    await requestJson("POST", "/v1/agent/profile/reset", { source: "cascaded-reasoner-smoke" });
  }
}

// Gemini 3.x thinking models sign functionCall parts with a thoughtSignature
// and reject a tool-loop replay that omits it (vertex HTTP 400 "Function call
// is missing a thought_signature"). Round 1 streams a signed functionCall;
// the round-2 request must replay the model turn with the signature verbatim.
// Regression for the 2026-07-07 empty-voice-reply incident.
async function streamingVertexReplaysThoughtSignature() {
  const put = await requestJson("PUT", "/v1/agent/profile", {
    profile: { reasoning_provider: "vertex" },
  });
  assert.equal(put.status, 200, `provider swap must succeed: ${JSON.stringify(put.json)}`);
  pendingStreamRounds = [
    [{
      candidates: [{
        content: {
          parts: [{
            functionCall: { name: "update_agent_profile", args: { profile: { voice: "charon" }, reason: "user asked for a deeper voice" } },
            thoughtSignature: "sig-thought-round1",
          }],
        },
      }],
    }],
    [{ candidates: [{ content: { parts: [{ text: "Done, master." }] } }] }],
  ];
  fetchCalls.length = 0;
  const deltas = [];
  try {
    const reasoning = await runCascadedVoiceReasoning({
      transcript: "good evening",
      session_id: SESSION_ID,
      branch_id: "default",
      turn_id: "reasoner-stream-thought-sig",
      on_speak_delta: (delta) => deltas.push(delta),
    });
    const streamCalls = fetchCalls.filter((c) => c.kind === "vertex-stream");
    assert.equal(streamCalls.length, 2, `the tool round must be followed by a second streamed round (got ${streamCalls.length})`);
    const replayTurn = (streamCalls[1].body.contents || []).find((entry) => entry.role === "model");
    assert.ok(replayTurn, "round 2 must replay the model's tool-call turn");
    const replayedCall = (replayTurn.parts || []).find((part) => part.functionCall);
    assert.ok(replayedCall, "the replayed model turn must carry the functionCall part");
    assert.equal(replayedCall.thoughtSignature, "sig-thought-round1", "the replayed functionCall must carry its thoughtSignature verbatim");
    assert.equal(agentProfile.effective().voice, "Charon", "the signed tool call must still patch the profile");
    assert.equal(reasoning.speak, "Done, master.");
    assert.equal(deltas.join(""), "Done, master.", "round-2 text must stream to deltas");
  } finally {
    pendingStreamRounds = null;
    await requestJson("POST", "/v1/agent/profile/reset", { source: "cascaded-reasoner-smoke" });
  }
}

// SSE safety valve: a transport fault mid-stream falls back to ONE
// non-streaming call for that round; the reply still arrives and is flushed to
// deltas, and the turn never fails.
async function streamingSseFaultFallsBackPerRound() {
  pendingStreamRounds = [["__fault__"]];
  pendingReply = "Fallback reply, master.";
  fetchCalls.length = 0;
  const deltas = [];
  try {
    const reasoning = await runCascadedVoiceReasoning({
      transcript: "tell me something",
      session_id: SESSION_ID,
      branch_id: "default",
      turn_id: "reasoner-stream-fault",
      on_speak_delta: (delta) => deltas.push(delta),
    });
    assert.equal(reasoning.speak, "Fallback reply, master.", "the per-round fallback must still answer");
    assert.equal(deltas.join(""), "Fallback reply, master.", "the fallback reply must still be flushed to deltas");
    const streamAttempt = fetchCalls.find((c) => c.kind === "openai" && c.body.stream === true);
    const plainRound = fetchCalls.find((c) => c.kind === "openai" && c.body.stream !== true);
    assert.ok(streamAttempt, "the streaming round must have been attempted");
    assert.ok(plainRound, "the faulted round must retry once without streaming");
  } finally {
    pendingStreamRounds = null;
    pendingReply = null;
  }
}

// A voice session that speaks AS a companion (website pet) passes a sanitized
// persona through the session server to the reasoner; it must land as a system
// block for that turn only, and a persona-less turn must not carry the block.
async function sessionPersonaReachesTheModel() {
  fetchCalls.length = 0;
  await runCascadedVoiceReasoning({
    transcript: "tell me about yourself",
    session_id: SESSION_ID,
    branch_id: "default",
    turn_id: "reasoner-persona-1",
    persona: { name: "Shigmi Scout", text: "A curious research scout that peeks around page edges." },
  });
  const personaCall = fetchCalls.find((c) => c.kind === "openai");
  assert.ok(personaCall, "the persona turn must reach the model");
  const personaSystem = personaCall.body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n---\n");
  assert.match(personaSystem, /Session persona/, "the persona system block must be injected");
  assert.match(personaSystem, /Shigmi Scout/, "the persona name must reach the model");
  assert.match(personaSystem, /research scout/, "the persona character text must reach the model");

  fetchCalls.length = 0;
  await runCascadedVoiceReasoning({
    transcript: "tell me about yourself",
    session_id: SESSION_ID,
    branch_id: "default",
    turn_id: "reasoner-persona-2",
  });
  const plainCall = fetchCalls.find((c) => c.kind === "openai");
  assert.ok(plainCall, "the persona-less turn must reach the model");
  const plainSystem = plainCall.body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n---\n");
  assert.ok(!/Session persona/.test(plainSystem), "a turn without a persona must not carry the block");
}

function requestJson(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const request = new PassThrough();
    request.method = method;
    request.url = url;
    request.headers = {
      host: "localhost",
      authorization: `Bearer ${TOKEN}`,
      ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
    };
    request.socket = {};

    const response = {
      statusCode: 200,
      headers: {},
      body: "",
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
      },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(headers)) {
          this.setHeader(name, value);
        }
      },
      write(chunk) {
        this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      },
      end(chunk) {
        if (chunk) this.write(chunk);
        try {
          resolve({ status: this.statusCode, json: JSON.parse(this.body || "{}"), headers: this.headers });
        } catch (error) {
          reject(error);
        }
      },
    };

    server.emit("request", request, response);
    request.end(body ? JSON.stringify(body) : "");
  });
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}
