#!/usr/bin/env node
"use strict";

// Isolated HTTP smoke for the canonical cross-surface history read. All source
// records live under a throwaway DATA_DIR and the gateway uses an ephemeral
// loopback port, so this never contacts or restarts an active gateway.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "session-messages-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-session-messages-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const sessionId = "shared-session-smoke";
  const longText = "Recovered Android direction: " + "finish the whole connected product. ".repeat(340);
  assert.ok(longText.length > 11_392, "fixture must exceed the recovered 11,392-character message");
  seedSources(dataDir, sessionId, longText);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  try {
    server = spawn(process.execPath, ["server.js"], {
      cwd: GATEWAY_DIR,
      env: gatewayEnv(dataDir, port),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logs = collectLogs(server);
    await waitForHealth(baseUrl, logs);

    const unauthorized = await requestJson(`${baseUrl}/v1/sessions/${sessionId}/messages`, false);
    assert.equal(unauthorized.status, 401);

    const response = await requestJson(`${baseUrl}/v1/sessions/${sessionId}/messages?branch_id=default&limit=20`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const payload = response.json;
    assert.equal(payload.version, "session_messages.v1");
    assert.equal(payload.has_more, false);
    assert.deepEqual(payload.messages.map((message) => message.speaker), [
      "user", "assistant", "user", "assistant", "user", "assistant",
    ]);
    assert.deepEqual(payload.messages.map((message) => message.turn_id), [
      "browser-turn", "browser-turn", "android-chat", "android-chat", "android-voice", "android-voice",
    ]);
    assert.equal(payload.messages.find((message) => message.turn_id === "android-chat" && message.speaker === "user").text, longText);
    assert.equal(payload.messages.filter((message) => message.turn_id === "android-voice").length, 2, "voice/chat mirror and broker evidence must deduplicate");
    assert.ok(payload.messages.some((message) => message.source_surface === "browser"));
    assert.ok(payload.messages.every((message) => message.message_id && message.session_id === sessionId));
    const voiceUser = payload.messages.find((message) => message.message_id === `turn:${sessionId}:default:android-voice:user`);
    assert.deepEqual(voiceUser.provenance.map((item) => item.store).sort(), ["broker", "chat", "voice"]);
    assert.equal(voiceUser.voice_history.audio_accessible, true);
    assert.equal(voiceUser.voice_history.retranscription_supported, false);
    assert.equal(voiceUser.voice_history.retranscription_available, false);
    assert.deepEqual(voiceUser.voice_history.transcript_revisions.map((item) => item.transcript), [
      "original voice direction", "voice direction",
    ]);
    assert.equal(voiceUser.voice_history.current_revision, 1);
    assert.ok(!JSON.stringify(voiceUser.voice_history).includes("voice-sessions/"));
    assert.ok(!JSON.stringify(voiceUser.voice_history).includes("http"));

    const unknown = await requestJson(`${baseUrl}/v1/sessions/unknown/messages`);
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.json.messages, []);

    console.log(JSON.stringify({
      ok: true,
      session_id: sessionId,
      retained_long_text_chars: longText.length,
      message_count: payload.messages.length,
      checks: ["authenticated", "newest-first", "turn-grouped", "deduplicated", "mixed-source", "audio-probed", "revisions", "complete-long-text", "unknown-session-empty"],
    }, null, 2));
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function seedSources(dataDir, sessionId, longText) {
  const write = (relative, value) => {
    const target = path.join(dataDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value, null, 2));
  };
  write(`voice-turns/${sessionId}/android-voice.json`, {
    id: "android-voice", session_id: sessionId, branch_id: "default", source: "android-voice",
    transcript: "voice direction", response: { display: "voice answer" }, classification: "chat",
    retranscribed: true,
    transcript_revisions: [
      {
        revision: 0, transcript: "original voice direction", transcript_source: "stt",
        source: "original", created_at: "2026-07-16T10:00:00.000Z",
      },
      {
        revision: 1, transcript: "voice direction", transcript_source: "stt-retranscribe",
        source: "retranscribe", created_at: "2026-07-16T10:00:01.000Z",
      },
    ],
    created_at: "2026-07-16T10:00:00.000Z",
  });
  const pcmPath = path.join(dataDir, "voice-sessions", sessionId, "android-voice.pcm");
  fs.mkdirSync(path.dirname(pcmPath), { recursive: true });
  fs.writeFileSync(pcmPath, Buffer.from([1, 2, 3, 4]));
  write(`chat-turns/${sessionId}/voice-mirror.json`, {
    turn_id: "voice-mirror", voice_turn_id: "android-voice", session_id: sessionId, branch_id: "default",
    source: "android-live-transcript", user_text: "voice direction", response_text: "voice answer",
    created_at: "2026-07-16T10:00:00.000Z",
  });
  write(`chat-turns/${sessionId}/android-chat.json`, {
    turn_id: "android-chat", session_id: sessionId, branch_id: "default", source: "android-chat",
    user_text: longText, response_text: "typed answer", created_at: "2026-07-16T10:01:00.000Z",
  });
  write("browser-turns/browser-turn.json", {
    id: "browser-turn", turn_id: "browser-turn", session_id: sessionId, branch_id: "default",
    source: "browser-extension", text: "browser direction", response: { text: "browser answer" },
    created_at: "2026-07-16T10:02:00.000Z", updated_at: "2026-07-16T10:02:00.000Z",
  });
  write("broker-events/broker-evidence.json", {
    id: "broker-evidence", conversation_id: sessionId, branch_id: "default", source: "android-broker",
    text: "voice direction", evidence_refs: [{ turn_id: "android-voice" }],
    created_at: "2026-07-16T10:03:00.000Z",
  });
}

function gatewayEnv(dataDir, port) {
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
    MOA_GATEWAY_TOKEN: TOKEN,
    MODEL_PROVIDER: "openai-compatible",
    MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
  };
}

async function requestJson(url, auth = true) {
  const response = await fetch(url, { headers: auth ? { authorization: `Bearer ${TOKEN}` } : {} });
  return { status: response.status, json: await response.json() };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function collectLogs(child) {
  let output = "";
  const logs = { exited: false, text: () => output };
  const append = (chunk) => { output = (output + chunk.toString("utf8")).slice(-12000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", () => { logs.exited = true; });
  return logs;
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    if (logs.exited) throw new Error(`gateway exited before health\n${logs.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`gateway health timed out\n${logs.text()}`);
}

async function onceExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)).then(() => child.kill("SIGKILL")),
  ]);
}
