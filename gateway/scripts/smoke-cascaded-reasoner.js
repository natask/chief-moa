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

const previousFetch = global.fetch;
const fetchCalls = [];
global.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("/chat/completions")) {
    fetchCalls.push({ kind: "openai", url: u, body: JSON.parse(String(options.body || "{}")) });
    return jsonResponse({ choices: [{ message: { content: "Understood, master." } }] });
  }
  throw new Error(`unexpected fetch to ${u}`);
};

const {
  server,
  runCascadedVoiceReasoning,
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

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "a prior voice turn's transcript reaches the cascaded reasoning model messages",
      "the reasoner injects a modality/TTS delivery hint (modality, availability, previous error)",
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
