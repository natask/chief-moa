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
global.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("/chat/completions")) {
    const body = JSON.parse(String(options.body || "{}"));
    fetchCalls.push({ kind: "openai", url: u, body });
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
    fetchCalls.push({ kind: "vertex", url: u, body: JSON.parse(String(options.body || "{}")) });
    return jsonResponse({ candidates: [{ content: { parts: [{ text: "Understood, master." }] } }] });
  }
  throw new Error(`unexpected fetch to ${u}`);
};

const {
  server,
  runCascadedVoiceReasoning,
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
  await modelAndReasoningProviderRoute();
  await expressiveDirectiveAndParsing();

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "a prior voice turn's transcript reaches the cascaded reasoning model messages",
      "the reasoner injects a modality/TTS delivery hint (modality, availability, previous error)",
      "a model update_agent_profile tool call patches the profile through the sanitizer and the confirmation is spoken",
      "profile.model and profile.reasoning_provider route the next reasoning call to the selected provider/model",
      "on gemini-tts the reasoner prompts for expressive speech and splits style, tags, and clean display text",
    ],
  }, null, 2));
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
  assert.ok(vertexCall, "reasoning_provider=vertex must route the next call to Vertex");
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
