#!/usr/bin/env node
"use strict";

// Smoke for POST /v1/voice/turns/:sessionId/:turnId/retranscribe.
//
// The stored user PCM is the durable source of truth: spoken input is never
// lost, so STT can always be re-run over the recording. This drives a real
// spawned gateway against a fake Google recognize endpoint (MOA_MODE=local +
// MOA_TEST_CHIRP_ENDPOINT) and asserts:
//   1. retranscribe round-trips on a stored turn: the fresh transcript is
//      returned AND persisted non-destructively (original kept as revision 0,
//      the new one appended, retranscribed:true).
//   2. a language_codes override is honored and forwarded to STT.
//   3. a missing PCM returns 404 (e.g. incognito-deleted audio).

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "retranscribe-token";

async function main() {
  const fakeGoogle = await startFakeGoogle();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-retranscribe-"));
  const dataDir = path.join(tempDir, "data");
  let gateway = null;

  try {
    gateway = await startGateway({
      port,
      dataDir,
      env: {
        MOA_MODE: "local",
        MOA_GATEWAY_TOKEN: TOKEN,
        VOICE_PROVIDER: "chirp",
        VOICE_TTS_PROVIDER: "cloud-tts",
        VOICE_REASONING_PROVIDER: "gateway",
        GCP_PROJECT_ID: "test-project",
        CHIRP_ACCESS_TOKEN: "test-token",
        CHIRP_MODEL: "chirp_3",
        CHIRP_LANGUAGE_CODES: "en-US,am-ET",
        MOA_TEST_CHIRP_ENDPOINT: `${fakeGoogle.baseUrl}/v2/projects/test/locations/us/recognizers/_:recognize`,
      },
    });

    const sessionId = "retr_sess";
    const turnId = "retr_turn";

    // Seed a stored user PCM + canonical turn record, as a completed turn would.
    const pcmDir = path.join(dataDir, "voice-sessions", sessionId);
    fs.mkdirSync(pcmDir, { recursive: true });
    fs.writeFileSync(path.join(pcmDir, `${turnId}.pcm`), Buffer.alloc(3200, 7));

    const turnDir = path.join(dataDir, "voice-turns", sessionId);
    fs.mkdirSync(turnDir, { recursive: true });
    const originalRecord = {
      id: turnId,
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: "default",
      transcript: "the original noisy transcript",
      transcript_source: "stt",
      classification: "chat",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      response: { speak: "", display: "the original noisy transcript" },
      references: { voice_session: { provider: "chirp", provider_events: [] } },
    };
    fs.writeFileSync(path.join(turnDir, `${turnId}.json`), JSON.stringify(originalRecord, null, 2));

    // 1. Round-trip: fresh transcript returned + persisted non-destructively.
    fakeGoogle.setTranscript("the clean retranscribed transcript");
    const ok = await postRetranscribe(baseUrl, sessionId, turnId, {});
    assert.equal(ok.status, 200, `retranscribe should succeed, got ${ok.status}: ${JSON.stringify(ok.body)}`);
    assert.equal(ok.body.retranscribed, true, "response marks the turn retranscribed");
    assert.equal(ok.body.transcript, "the clean retranscribed transcript", "returns the fresh transcript");
    assert.equal(ok.body.revision, 1, "first retranscription is revision 1");
    assert.equal(ok.body.record_updated, true, "the stored record was updated");

    const updated = JSON.parse(fs.readFileSync(path.join(turnDir, `${turnId}.json`), "utf8"));
    assert.equal(updated.transcript, "the clean retranscribed transcript", "current transcript is the fresh one");
    assert.equal(updated.retranscribed, true, "record carries the retranscribed marker");
    assert.ok(Array.isArray(updated.transcript_revisions), "record keeps a revision history");
    assert.equal(updated.transcript_revisions[0].transcript, "the original noisy transcript",
      "original transcript is preserved as revision 0 (non-destructive)");
    assert.equal(updated.transcript_revisions[1].transcript, "the clean retranscribed transcript",
      "the retranscription is appended as a new revision");
    assert.ok(
      (updated.references.voice_session.provider_events || []).some((e) => e.type === "transcript_retranscribed"),
      "a provider event records the re-transcription",
    );

    // 2. language_codes override is honored and forwarded to STT.
    fakeGoogle.reset();
    fakeGoogle.setTranscript("amharic retranscription");
    const withCodes = await postRetranscribe(baseUrl, sessionId, turnId, { language_codes: ["am-ET"] });
    assert.equal(withCodes.status, 200, "override request succeeds");
    assert.deepEqual(withCodes.body.language_codes, ["am-ET"], "override codes are echoed back");
    assert.deepEqual(fakeGoogle.lastLanguageCodes(), ["am-ET"], "override codes are forwarded to STT");
    assert.equal(withCodes.body.revision, 2, "second retranscription is revision 2");

    // 3. Missing PCM -> 404.
    const missing = await postRetranscribe(baseUrl, sessionId, "no_such_turn", {});
    assert.equal(missing.status, 404, "missing PCM returns 404");

    console.log("smoke-voice-retranscribe: ok");
  } finally {
    if (gateway) {
      gateway.kill("SIGKILL");
    }
    await fakeGoogle.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function postRetranscribe(baseUrl, sessionId, turnId, body) {
  const response = await fetch(
    `${baseUrl}/v1/voice/turns/${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}/retranscribe`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    },
  );
  let parsed = {};
  try {
    parsed = await response.json();
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed };
}

async function startFakeGoogle() {
  const state = { transcript: "stub transcript", calls: [] };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch {
      body = {};
    }
    if (request.url.includes(":recognize")) {
      state.calls.push({ language_codes: body?.config?.languageCodes || [] });
      sendJson(response, 200, { results: [{ alternatives: [{ transcript: state.transcript }] }] });
      return;
    }
    sendJson(response, 404, { error: "not found" });
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    setTranscript: (value) => { state.transcript = value; },
    reset: () => { state.calls = []; },
    lastLanguageCodes: () => (state.calls.length ? state.calls[state.calls.length - 1].language_codes : []),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startGateway({ port, dataDir, env }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    server.on("error", reject);
  });
}

async function waitForHealth(baseUrl, logs) {
  // Generous deadline: this smoke spawns a full gateway and runs alongside other
  // spawn-based smokes under test concurrency, so cold startup can be slow.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (logs.exited) throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

function collectLogs(child) {
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const logs = {
    exited: false,
    text: () => Buffer.concat(chunks).toString("utf8").slice(-6000),
  };
  child.on("exit", () => { logs.exited = true; });
  return logs;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
