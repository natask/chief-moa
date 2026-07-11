#!/usr/bin/env node
"use strict";

// Smoke for the context_management decision: the pure deterministic prior +
// double-gate resolver (lib/context-decision), plus the wired chat path
// (/v1/chat). Golden table for the pure logic; in-process HTTP with a stubbed
// model for the tool-call override, the incognito warrant gate, and the
// response `context` block + persistence skip.
//
// Asserts:
//   1. Deterministic prior: plain=continue, phrasing lifts to new/fork, warrant
//      lifts to incognito, explicit client action always wins.
//   2. The model tool call can override the prior (continue -> new).
//   3. The model may only choose incognito with an explicit linguistic warrant;
//      without one it is denied and the prior stands.
//   4. An explicit client context_action beats the model tool call.
//   5. /v1/chat returns a `context` block and, for incognito, skips persistence
//      (persisted:false, no chat turn stored) while a new-thread turn is filed on
//      a fresh thr- branch.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const {
  deterministicPrior,
  resolveContextDecision,
  normalizeContextAction,
  hasIncognitoWarrant,
} = require(path.join(GATEWAY_DIR, "lib", "context-decision"));

const TOKEN = "context-decision-smoke-token";
const SESSION_ID = "context-decision-smoke-session";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-context-decision-"));
const dataDir = path.join(tempDir, "data");

process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
process.env.MOA_MODE = "local";
process.env.DATA_DIR = dataDir;
process.env.ANDROID_OTA_DIR = path.join(dataDir, "android-ota");
process.env.MOA_GATEWAY_TOKEN = TOKEN;
process.env.MODEL_PROVIDER = "openai-compatible";
process.env.MODEL_ID = "context-decision-smoke-model";
process.env.MODEL_BASE_URL = "https://model.smoke.test/v1";
process.env.MODEL_API_KEY = "context-decision-smoke-key";
process.env.OPENAI_API_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.GBRAIN_BIN = path.join(tempDir, "no-such-gbrain");

const previousFetch = global.fetch;
// When set, the model returns this context_management tool call on the first
// round (no prior tool result), then plain text on the next round.
let pendingContextCall = null;
const modelRequests = [];
global.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("/chat/completions")) {
    const body = JSON.parse(String(options.body || "{}"));
    modelRequests.push(body);
    const isPreflight = body.tool_choice?.function?.name === "context_management";
    if (pendingContextCall && isPreflight) {
      return jsonResponse({
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_ctx",
              type: "function",
              function: { name: "context_management", arguments: JSON.stringify(pendingContextCall) },
            }],
          },
        }],
      });
    }
    return jsonResponse({ choices: [{ message: { role: "assistant", content: "Understood, master." } }] });
  }
  throw new Error(`unexpected fetch to ${u}`);
};

const { server } = require(path.join(GATEWAY_DIR, "server"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}).finally(() => {
  global.fetch = previousFetch;
  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  goldenTable();
  await modelOverridesPrior();
  await incognitoWarrantGate();
  await clientActionBeatsModel();
  await chatContextBlockAndPersistence();

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "deterministic prior: plain=continue, phrasing=new/fork, warrant=incognito, client action wins",
      "the model tool call overrides the prior (continue -> new)",
      "the model may only choose incognito with an explicit warrant; else it is denied",
      "an explicit client context_action beats the model tool call",
      "/v1/chat returns a context block, skips persistence for incognito, files a new thread on a thr- branch",
    ],
  }, null, 2));
}

function goldenTable() {
  // Pure prior.
  const priors = [
    { text: "can you help me reconcile the invoice", expect: "continue" },
    { text: "let's start a new topic about taxes", expect: "new" },
    { text: "fork this into a separate thread", expect: "fork" },
    { text: "keep this off the record", expect: "incognito" },
    { text: "don't save this conversation", expect: "incognito" },
  ];
  for (const row of priors) {
    const result = deterministicPrior({ text: row.text });
    assert.equal(result.action, row.expect, `prior for "${row.text}" must be ${row.expect}, got ${result.action}`);
  }
  // Explicit client action always wins over phrasing.
  assert.equal(deterministicPrior({ text: "fork this", contextAction: "continue" }).action, "continue", "client continue must win over fork phrasing");
  assert.equal(deterministicPrior({ contextAction: "incognito" }).action, "incognito", "client incognito must be honored");

  // Normalizer + warrant.
  assert.equal(normalizeContextAction("NEW"), "new", "action normalization must lowercase");
  assert.equal(normalizeContextAction("bogus"), "", "an unknown action must normalize to empty");
  assert.ok(hasIncognitoWarrant("please keep this off the record"), "off the record is a warrant");
  assert.ok(!hasIncognitoWarrant("my account is private"), "a lone private mention is not a warrant");

  // Resolver: model override of the prior.
  const override = resolveContextDecision({ text: "hello there", toolCall: { action: "new", retrieval_query: "taxes" } });
  assert.equal(override.action, "new", "the model tool call must override the continue prior");
  assert.equal(override.model_override, true, "an override must be flagged");
  assert.equal(override.retrieval_query, "taxes", "the retrieval query must be captured");

  // Resolver: incognito denied without a warrant.
  const denied = resolveContextDecision({ text: "hello there", toolCall: { action: "incognito", retrieval_query: "x" } });
  assert.equal(denied.action, "continue", "incognito must be denied without a warrant");
  assert.equal(denied.model_override, false, "a denied incognito is not an override");

  // Resolver: incognito allowed with a warrant.
  const allowed = resolveContextDecision({ text: "keep this off the record", toolCall: { action: "incognito", retrieval_query: "x" } });
  assert.equal(allowed.action, "incognito", "incognito must be allowed with a warrant");

  // Resolver: client action beats the model.
  const clientWins = resolveContextDecision({ text: "hello", contextAction: "continue", toolCall: { action: "new", retrieval_query: "x" } });
  assert.equal(clientWins.action, "continue", "an explicit client action must beat the model tool call");
}

async function modelOverridesPrior() {
  modelRequests.length = 0;
  pendingContextCall = { action: "new", retrieval_query: "grocery budget", thread_label: "Groceries" };
  try {
    const chat = await requestJson("POST", "/v1/chat", {
      session_id: SESSION_ID,
      source: "console",
      messages: [{ role: "user", content: "help me plan the week" }],
    });
    assert.equal(chat.status, 200, `chat must succeed: ${JSON.stringify(chat.json)}`);
    assert.equal(chat.json.context.action, "new", "the model's new action must apply");
    assert.equal(chat.json.context.model_override, true, "the override must be reported");
    assert.ok(chat.json.branch_id.startsWith("thr-"), `a new thread must file on a thr- branch, got ${chat.json.branch_id}`);
    assert.equal(chat.json.context.thread_label, "Groceries", "the thread label must be carried");
    assert.equal(modelRequests.length, 2, "an undecided turn must use one preflight and one answer request");
    const [preflight, answer] = modelRequests;
    assert.equal(preflight.tool_choice.function.name, "context_management", "preflight must force the decision tool");
    assert.deepEqual(preflight.tools.map((tool) => tool.function.name), ["context_management"], "preflight must offer no mutation tools");
    assert.ok(!JSON.stringify(preflight.messages).includes("grocery budget"), "preflight must not contain retrieval output");
    assert.ok(!answer.tools?.some((tool) => tool.function?.name === "context_management"), "answer must not offer context_management again");
    assert.ok(answer.messages.some((message) => message.role === "system"), "answer must receive the resolved canonical artifact");
  } finally {
    pendingContextCall = null;
  }
}

async function incognitoWarrantGate() {
  // Model asks for incognito but the transcript has no warrant: denied.
  pendingContextCall = { action: "incognito", retrieval_query: "x" };
  try {
    const chat = await requestJson("POST", "/v1/chat", {
      session_id: SESSION_ID,
      source: "console",
      messages: [{ role: "user", content: "what is the capital of France" }],
    });
    assert.notEqual(chat.json.context.action, "incognito", "incognito must be denied without a warrant");
    assert.equal(chat.json.context.persisted, true, "a denied-incognito turn must persist");
  } finally {
    pendingContextCall = null;
  }
}

async function clientActionBeatsModel() {
  modelRequests.length = 0;
  pendingContextCall = { action: "new", retrieval_query: "x" };
  try {
    const chat = await requestJson("POST", "/v1/chat", {
      session_id: SESSION_ID,
      source: "console",
      context_action: "continue",
      branch_id: "default",
      messages: [{ role: "user", content: "keep going on this" }],
    });
    assert.equal(chat.json.context.action, "continue", "an explicit client action must beat the model");
    assert.equal(chat.json.branch_id, "default", "a continue must stay on the caller branch");
  } finally {
    pendingContextCall = null;
  }
  assert.ok(modelRequests.every((request) => request.tool_choice?.function?.name !== "context_management"), "explicit client action must skip preflight");
}

async function chatContextBlockAndPersistence() {
  // Incognito via explicit client action: answered but not persisted.
  const before = await chatTurnCount(SESSION_ID);
  const incognito = await requestJson("POST", "/v1/chat", {
    session_id: SESSION_ID,
    source: "console",
    context_action: "incognito",
    messages: [{ role: "user", content: "this is a secret question" }],
  });
  assert.equal(incognito.status, 200, "incognito turn must still return an answer");
  assert.equal(incognito.json.context.action, "incognito", "the action must be incognito");
  assert.equal(incognito.json.context.persisted, false, "an incognito turn must report persisted:false");
  assert.ok(incognito.json.branch_id.startsWith("inc-"), `incognito must ride an inc- branch, got ${incognito.json.branch_id}`);
  assert.ok(String(incognito.json.text || "").length > 0, "an incognito turn must still be answered");
  const after = await chatTurnCount(SESSION_ID);
  assert.equal(after, before, "an incognito turn must not add a stored chat turn");
}

async function chatTurnCount(sessionId) {
  const history = await requestJson("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/chat-turns?limit=200`);
  return Array.isArray(history.json.turns) ? history.json.turns.length : 0;
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
