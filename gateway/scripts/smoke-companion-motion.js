#!/usr/bin/env node
"use strict";

// Smoke for the companion_motion agent tool wired into the cascaded voice tool
// loop (companion-character-voice-library task 4). Driven in-process against the
// real gateway reasoner; global.fetch is stubbed so the model returns a
// companion_motion tool call on the first round and a spoken confirmation on the
// next. No network, no live provider.
//
// Asserts:
//   1. A spoken turn whose model calls companion_motion with a valid verb/target
//      yields a validated motion plan AND a client-forwardable action envelope
//      { type: "companion_motion", plan } on the turn result's actions[].
//   2. A companion_motion call with an unsupported verb is rejected by the tool
//      handler (no action envelope leaks to the client), and the turn still
//      completes with a spoken reply.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "companion-motion-smoke-token";
const SESSION_ID = "companion-motion-smoke-session";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-companion-motion-"));
const dataDir = path.join(tempDir, "data");

process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
process.env.MOA_MODE = "local";
process.env.DATA_DIR = dataDir;
process.env.ANDROID_OTA_DIR = path.join(dataDir, "android-ota");
process.env.MOA_GATEWAY_TOKEN = TOKEN;
process.env.MODEL_PROVIDER = "openai-compatible";
process.env.MODEL_ID = "companion-motion-smoke-model";
process.env.MODEL_BASE_URL = "https://model.smoke.test/v1";
process.env.MODEL_API_KEY = "companion-motion-smoke-key";
process.env.OPENAI_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
process.env.GEMINI_API_KEY = "";
// Short-continue fast path would skip the model preflight/tool round for terse
// turns; disable it so the tool round always runs.
process.env.CONTEXT_PREFLIGHT_FAST_MAX_WORDS = "0";

const previousFetch = global.fetch;
// When set, the model returns this tool call on the first tools round (no prior
// tool result), then plain confirmation text on the next round.
let pendingToolCall = null;

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

global.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("/chat/completions")) {
    const body = JSON.parse(String(options.body || "{}"));
    const contextPreflight = body.tool_choice?.function?.name === "context_management";
    if (contextPreflight) {
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "context_1", type: "function", function: { name: "context_management", arguments: JSON.stringify({ action: "continue", retrieval_query: "" }) } }] } }] });
    }
    const hasToolResult = Array.isArray(body.messages) && body.messages.some((m) => m.role === "tool");
    if (pendingToolCall && !hasToolResult) {
      return jsonResponse({
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_motion_1",
              type: "function",
              function: { name: pendingToolCall.name, arguments: JSON.stringify(pendingToolCall.arguments || {}) },
            }],
          },
        }],
      });
    }
    return jsonResponse({ choices: [{ message: { role: "assistant", content: "On my way, master." } }] });
  }
  throw new Error(`unexpected fetch to ${u}`);
};

const { server, runCascadedVoiceReasoning } = require(path.join(GATEWAY_DIR, "server"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}).finally(() => {
  global.fetch = previousFetch;
  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  await validMotionYieldsActionEnvelope();
  await invalidVerbIsRejected();

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "a spoken turn whose model calls companion_motion (valid verb + target) yields a validated plan and a { type:'companion_motion', plan } action envelope on the turn result actions[]",
      "a companion_motion call with an unsupported verb is rejected by the tool handler and leaks no action envelope, while the turn still completes with a spoken reply",
    ],
  }, null, 2));
}

async function validMotionYieldsActionEnvelope() {
  pendingToolCall = { name: "companion_motion", arguments: { verb: "walk", target: "corner_top_right", duration_ms: 1500 } };
  const result = await runCascadedVoiceReasoning({
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    branch_id: "default",
    turn_id: "motion-valid",
    source: "voice-cascaded",
    transcript: "walk to the top right corner",
  });
  assert.ok(Array.isArray(result.actions), "a companion_motion turn must carry actions[]");
  const motion = result.actions.find((a) => a.type === "companion_motion");
  assert.ok(motion, `the turn must attach a companion_motion action: ${JSON.stringify(result.actions)}`);
  assert.equal(motion.plan.verb, "walk", "plan verb must be the requested verb");
  assert.equal(motion.plan.target, "corner_top_right", "plan target must be the requested target");
  assert.equal(motion.plan.duration_ms, 1500, "plan must carry the requested duration");
  assert.equal(motion.plan.renderer, "shimeji-web", "plan must name the motion runtime");
  assert.ok(String(result.speak || "").length > 0, "the turn must still produce a spoken reply");
}

async function invalidVerbIsRejected() {
  pendingToolCall = { name: "companion_motion", arguments: { verb: "teleport", target: "center" } };
  const result = await runCascadedVoiceReasoning({
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    branch_id: "default",
    turn_id: "motion-invalid",
    source: "voice-cascaded",
    transcript: "teleport to the middle",
  });
  const actions = Array.isArray(result.actions) ? result.actions : [];
  assert.ok(!actions.some((a) => a.type === "companion_motion"), `an unsupported verb must not leak a motion action: ${JSON.stringify(actions)}`);
  assert.ok(String(result.speak || "").length > 0, "the turn must still complete with a spoken reply");
}
