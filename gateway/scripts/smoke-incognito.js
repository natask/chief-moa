#!/usr/bin/env node
"use strict";

// Incognito invariants smoke: an incognito turn is answered normally but the
// gateway persists NOTHING for it. Covers the HTTP voice path (POST
// /v1/voice/turns) and the streaming recorder (recordStreamingVoiceTurn),
// driven in-process with a stubbed model and the file-backed Brain.
//
// Asserts, for an incognito turn:
//   - no new voice turn file, no voice-turns.jsonl line,
//   - no new product event (product-events.jsonl),
//   - no new gbrain/brain-facts write (memory capture is skipped),
//   - the response reports context.action=incognito, persisted:false, inc- branch,
//   - standing facts are still read (the answer still knows the user),
//   - the buffered PCM archive is deleted on the streaming path.
// And a control (non-incognito) turn DOES persist all of the above, so the skip
// is proven, not vacuous.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "incognito-smoke-token";
const SESSION_ID = "incognito-smoke-session";
const STREAM_SESSION_ID = "incognito-smoke-stream-session";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-incognito-"));
const dataDir = path.join(tempDir, "data");
fs.mkdirSync(dataDir, { recursive: true });

process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
process.env.MOA_MODE = "local";
process.env.DATA_DIR = dataDir;
process.env.ANDROID_OTA_DIR = path.join(dataDir, "android-ota");
process.env.MOA_GATEWAY_TOKEN = TOKEN;
process.env.MODEL_PROVIDER = "openai-compatible";
process.env.MODEL_ID = "incognito-smoke-model";
process.env.MODEL_BASE_URL = "https://model.smoke.test/v1";
process.env.MODEL_API_KEY = "incognito-smoke-key";
process.env.OPENAI_API_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.GBRAIN_BIN = path.join(tempDir, "no-such-gbrain");

const brainFactsFile = path.join(dataDir, "brain-facts.jsonl");
const voiceLedger = path.join(dataDir, "voice-turns.jsonl");
const productEvents = path.join(dataDir, "product-events.jsonl");

const previousFetch = global.fetch;
const fetchCalls = [];
global.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("/chat/completions")) {
    const body = JSON.parse(String(options.body || "{}"));
    fetchCalls.push({ url: u, body });
    return jsonResponse({ choices: [{ message: { role: "assistant", content: "Understood, master." } }] });
  }
  throw new Error(`unexpected fetch to ${u}`);
};

const { server, recordStreamingVoiceTurn } = require(path.join(GATEWAY_DIR, "server"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}).finally(() => {
  global.fetch = previousFetch;
  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  seedStandingFact();
  await controlTurnPersists();
  await incognitoHttpVoiceTurnPersistsNothing();
  await incognitoStreamingTurnDeletesPcmAndPersistsNothing();

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "a control voice turn persists a turn file, ledger line, product event, and (for a memory statement) a gbrain fact",
      "an incognito HTTP voice turn adds zero turn files, ledger lines, product events, and gbrain facts",
      "the incognito response reports action=incognito, persisted:false, on an inc- branch, and is still answered",
      "standing facts are still read on an incognito turn (the model messages carry the known user fact)",
      "an incognito streaming turn deletes its buffered PCM archive and persists nothing",
    ],
  }, null, 2));
}

function seedStandingFact() {
  fs.appendFileSync(brainFactsFile, `${JSON.stringify({
    ts: new Date().toISOString(),
    slug: "moa/memory/standing/user-name",
    kind: "identity",
    tags: ["memory", "standing", "identity"],
    title: "The user is called Master Zed",
    text: "The user is called Master Zed.",
  })}\n`);
}

async function controlTurnPersists() {
  const before = snapshot(SESSION_ID);
  const turn = await requestJson("POST", "/v1/voice/turns", {
    session_id: SESSION_ID,
    branch_id: "default",
    turn_id: "incognito-smoke-control",
    source: "android-overlay",
    transcript: "remember that my favorite color is teal",
  });
  assert.equal(turn.status, 200, `control turn must succeed: ${JSON.stringify(turn.json)}`);
  const after = snapshot(SESSION_ID);
  assert.ok(after.voiceFiles > before.voiceFiles, "a control turn must write a voice turn file");
  assert.ok(after.ledgerLines > before.ledgerLines, "a control turn must append a voice-turns ledger line");
  assert.ok(after.productEvents > before.productEvents, "a control turn must mirror at least one product event");
  assert.ok(after.brainFacts > before.brainFacts, "a control turn with a memory statement must write a gbrain fact");
  assert.ok((turn.json.context && turn.json.context.persisted) !== false, "a control turn must report persisted");
}

async function incognitoHttpVoiceTurnPersistsNothing() {
  const before = snapshot(SESSION_ID);
  fetchCalls.length = 0;
  const turn = await requestJson("POST", "/v1/voice/turns", {
    session_id: SESSION_ID,
    branch_id: "default",
    turn_id: "incognito-smoke-secret",
    source: "android-overlay",
    context_action: "incognito",
    transcript: "remember that my favorite food is injera",
  });
  assert.equal(turn.status, 200, `incognito turn must still return an answer: ${JSON.stringify(turn.json)}`);
  assert.ok(turn.json.context, "the response must carry a context block");
  assert.equal(turn.json.context.action, "incognito", "the action must be incognito");
  assert.equal(turn.json.context.persisted, false, "an incognito turn must report persisted:false");
  assert.ok(String(turn.json.context.branch_id || "").startsWith("inc-"), `incognito must ride an inc- branch, got ${turn.json.context.branch_id}`);
  assert.ok(String(turn.json.speak || turn.json.display || "").length > 0, "an incognito turn must still be answered");

  // Standing facts still read: the model messages must carry the known user fact.
  const call = fetchCalls.find((c) => Array.isArray(c.body.messages));
  assert.ok(call, "the incognito turn must still call the model");
  const systemText = call.body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(systemText, /Master Zed/, "standing facts must still be read on an incognito turn");

  const after = snapshot(SESSION_ID);
  assert.equal(after.voiceFiles, before.voiceFiles, "an incognito turn must not write a voice turn file");
  assert.equal(after.ledgerLines, before.ledgerLines, "an incognito turn must not append a ledger line");
  assert.equal(after.productEvents, before.productEvents, "an incognito turn must not mirror a product event");
  assert.equal(after.brainFacts, before.brainFacts, "an incognito turn must not write a gbrain fact");
  assert.ok(!fs.existsSync(path.join(dataDir, "voice-turns", SESSION_ID, "incognito-smoke-secret.json")), "no turn file may exist for the incognito turn id");
}

async function incognitoStreamingTurnDeletesPcmAndPersistsNothing() {
  const turnId = "incognito-smoke-stream";
  const sessionDir = path.join(dataDir, "voice-sessions", STREAM_SESSION_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  const userPcm = path.join(sessionDir, `${turnId}.pcm`);
  const assistantPcm = path.join(sessionDir, `${turnId}.assistant.pcm`);
  fs.writeFileSync(userPcm, Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(assistantPcm, Buffer.from([5, 6, 7, 8]));

  const before = snapshot(STREAM_SESSION_ID);
  const record = await recordStreamingVoiceTurn({
    session_id: STREAM_SESSION_ID,
    conversation_id: STREAM_SESSION_ID,
    branch_id: "inc-stream",
    turn_id: turnId,
    source: "voice-live",
    transcript: "a private streamed thought to keep off the record",
    transcript_source: "stt",
    assistant_text: "acknowledged",
    status: "completed",
    provider: "loopback",
    model: "loopback",
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    provider_events: [],
  });
  assert.ok(record, "the streaming recorder must still return an in-memory record");

  assert.ok(!fs.existsSync(userPcm), "the incognito streaming turn must delete the user PCM archive");
  assert.ok(!fs.existsSync(assistantPcm), "the incognito streaming turn must delete the assistant PCM archive");

  const after = snapshot(STREAM_SESSION_ID);
  assert.equal(after.voiceFiles, before.voiceFiles, "an incognito streaming turn must not write a voice turn file");
  assert.equal(after.ledgerLines, before.ledgerLines, "an incognito streaming turn must not append a ledger line");
  assert.equal(after.productEvents, before.productEvents, "an incognito streaming turn must not mirror a product event");
  assert.equal(after.brainFacts, before.brainFacts, "an incognito streaming turn must not write a gbrain fact");
}

function snapshot(sessionId) {
  return {
    voiceFiles: countVoiceFiles(sessionId),
    ledgerLines: countLines(voiceLedger),
    productEvents: countLines(productEvents),
    brainFacts: countLines(brainFactsFile),
  };
}

function countVoiceFiles(sessionId) {
  const dir = path.join(dataDir, "voice-turns", sessionId);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
}

function countLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).length;
}

function requestJson(method, url, body = null, options = {}) {
  const auth = options.auth !== false;
  return new Promise((resolve, reject) => {
    const request = new PassThrough();
    request.method = method;
    request.url = url;
    request.headers = {
      host: "localhost",
      ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
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
