#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-modes-smoke-"));
process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
process.env.MOA_MODE = "local";
process.env.DATA_DIR = path.join(tempDir, "data");
process.env.ANDROID_OTA_DIR = path.join(tempDir, "android-ota");
process.env.MOA_GATEWAY_TOKEN = "voice-modes-smoke-token";
process.env.MODEL_PROVIDER = "openai-compatible";
process.env.MODEL_ID = "voice-modes-smoke-model";
process.env.MODEL_BASE_URL = "https://voice-modes.smoke.test/v1";
process.env.MODEL_API_KEY = "voice-modes-smoke-key";
process.env.CONTEXT_PREFLIGHT_FAST_MAX_WORDS = "99";
process.env.SYSTEM_PROMPT = "You are A.G. Preserve this dry-pirate base persona.";

const previousFetch = global.fetch;
const modelRequests = [];
global.fetch = async (url, options = {}) => {
  const body = JSON.parse(String(options.body || "{}"));
  modelRequests.push({ url: String(url), body });
  const payload = { choices: [{ message: { role: "assistant", content: "Take one concrete next step." } }] };
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

const { agentProfile, runCascadedVoiceReasoning, server } = require("../server");

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}).finally(async () => {
  global.fetch = previousFetch;
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const deviceId = "android-smoke";
  const basePersona = agentProfile.effective().system_prompt;

  const unauthenticated = await request(`${baseUrl}/v1/voice/mode?device_id=${deviceId}`, { auth: false });
  assert.equal(unauthenticated.status, 401);

  const ask = await request(`${baseUrl}/v1/voice/mode?device_id=${deviceId}`);
  assert.equal(ask.json.mode, "ask");
  assert.equal(ask.json.routing.response_policy, "normal");
  assert.equal(ask.json.routing.provider_work_allowed, true);

  const note = await request(`${baseUrl}/v1/voice/mode`, {
    method: "PUT", body: { device_id: deviceId, mode: "note", source: "smoke" },
  });
  assert.equal(note.json.mode, "note");
  assert.equal(note.json.routing.provider_work_allowed, false);
  modelRequests.length = 0;
  const blockedTurn = await request(`${baseUrl}/v1/voice/turns`, {
    method: "POST",
    body: { device_id: deviceId, session_id: "mode-smoke", turn_id: "note-1", transcript: "save this note" },
  });
  assert.equal(blockedTurn.status, 202);
  assert.equal(blockedTurn.json.classification, "note_capture_required");
  assert.equal(blockedTurn.json.routing.capture_endpoint, "/v1/audio-notes");
  assert.equal(modelRequests.length, 0, "Note admission must happen before provider work");

  await request(`${baseUrl}/v1/voice/mode`, {
    method: "PUT", body: { device_id: deviceId, mode: "coach", source: "smoke" },
  });
  modelRequests.length = 0;
  const coached = await runCascadedVoiceReasoning({
    device_id: deviceId, session_id: "mode-smoke", turn_id: "coach-1", transcript: "I keep avoiding the task",
  });
  assert.equal(coached.classification, "chat");
  assert.ok(modelRequests.length > 0);
  const coachMessages = modelRequests.flatMap((entry) => entry.body.messages || []);
  const coachSystem = coachMessages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  assert.match(coachSystem, /dry-pirate base persona/);
  assert.match(coachSystem, /Coach delivery mode applies to this turn only/);
  assert.equal(agentProfile.effective().system_prompt, basePersona, "Coach must not mutate the base persona");

  const reverted = await request(`${baseUrl}/v1/voice/mode`, {
    method: "PUT", body: { device_id: deviceId, mode: "ask", source: "smoke" },
  });
  assert.equal(reverted.json.mode, "ask");
  assert.equal(reverted.json.version, "voice_mode_v0003");
  modelRequests.length = 0;
  await runCascadedVoiceReasoning({
    device_id: deviceId, session_id: "mode-smoke", turn_id: "ask-2", transcript: "what should I do next",
  });
  const askMessages = modelRequests.flatMap((entry) => entry.body.messages || []);
  const askSystem = askMessages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  assert.match(askSystem, /dry-pirate base persona/);
  assert.doesNotMatch(askSystem, /Coach delivery mode applies to this turn only/);
  assert.equal(agentProfile.effective().system_prompt, basePersona);

  const versions = await request(`${baseUrl}/v1/voice/mode/versions?device_id=${deviceId}`);
  assert.deepEqual(versions.json.versions.map((entry) => entry.mode), ["note", "coach", "ask"]);
  console.log(JSON.stringify({ ok: true, checks: [
    "authenticated device-mode API defaults to Ask",
    "Note returns storage-only routing before any model request",
    "Coach adds a bounded turn overlay without changing the saved persona",
    "reverting to Ask removes the Coach overlay",
  ] }, null, 2));
}

async function request(url, { method = "GET", body, auth = true } = {}) {
  const response = await previousFetch(url, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${process.env.MOA_GATEWAY_TOKEN}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json() };
}
