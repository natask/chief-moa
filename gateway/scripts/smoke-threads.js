#!/usr/bin/env node
"use strict";

// Smoke for the thread control plane (branches inside the one shared session):
// the /v1/threads list, /v1/threads/switch active-thread pointer, and the
// sessionSummaryPayload merge fix. Driven in-process, no network, no provider:
// chat turns use the gateway fallback reply and voice turns use the local
// time-utility reply, so every turn is deterministic.
//
// Asserts:
//   1. A chat-only thread is visible in /v1/sessions and /v1/threads (the merge
//      fix: chat-only sessions were previously invisible).
//   2. Voice + chat turns on different branches both appear as threads.
//   3. POST /v1/threads/switch action=new mints a fresh branch, and
//      /v1/threads/active resolves it across a later read.
//   4. action=fork records the parent branch and the parent's latest turn as the
//      fork point.
//   5. Switching by explicit branch_id continues that branch.
//   6. The endpoints require the gateway token.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "threads-smoke-token";
const SESSION_ID = "threads-smoke-session";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-threads-"));
const dataDir = path.join(tempDir, "data");

process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
process.env.MOA_MODE = "local";
process.env.DATA_DIR = dataDir;
process.env.ANDROID_OTA_DIR = path.join(dataDir, "android-ota");
process.env.MOA_GATEWAY_TOKEN = TOKEN;
// No model provider configured: chat falls back to the gateway reply.
process.env.MODEL_PROVIDER = "openai-compatible";
process.env.MODEL_BASE_URL = "";
process.env.MODEL_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.GBRAIN_BIN = path.join(tempDir, "no-such-gbrain");

const { server } = require(path.join(GATEWAY_DIR, "server"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}).finally(() => {
  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  await chatOnlyThreadIsVisible();
  await voiceAndChatBranchesListed();
  await switchNewThreadIsActive();
  await forkRecordsParentAndForkPoint();
  await switchByExplicitBranch();
  await tokenRequired();

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "a chat-only thread is visible in /v1/sessions and /v1/threads (merge fix)",
      "voice and chat turns on different branches both appear as threads",
      "POST /v1/threads/switch action=new mints a fresh branch resolved by /v1/threads/active",
      "action=fork records the parent branch and the parent latest turn as the fork point",
      "switching by explicit branch_id continues that branch",
      "the thread endpoints require the gateway token",
    ],
  }, null, 2));
}

async function chatOnlyThreadIsVisible() {
  const chat = await requestJson("POST", "/v1/chat", {
    session_id: SESSION_ID,
    branch_id: "default",
    source: "console",
    messages: [{ role: "user", content: "hello there" }],
  });
  assert.equal(chat.status, 200, `chat turn must succeed: ${JSON.stringify(chat.json)}`);

  const sessions = await requestJson("GET", "/v1/sessions?limit=100");
  assert.equal(sessions.status, 200, "sessions must be readable");
  const found = sessions.json.sessions.find((s) => s.session_id === SESSION_ID && s.branch_id === "default");
  assert.ok(found, "the chat-only session must be visible in /v1/sessions (merge fix)");
  assert.ok(found.turn_count >= 1, "the chat-only session must count its turn");

  const threads = await requestJson("GET", `/v1/threads?session_id=${encodeURIComponent(SESSION_ID)}`);
  assert.equal(threads.status, 200, "threads must be readable");
  const defaultThread = threads.json.threads.find((t) => t.branch_id === "default");
  assert.ok(defaultThread, "the default thread must be listed from a chat-only turn");
  assert.equal(defaultThread.kind, "default", "the default branch kind must be default");
}

async function voiceAndChatBranchesListed() {
  const voice = await requestJson("POST", "/v1/voice/turns", {
    session_id: SESSION_ID,
    branch_id: "topic-two",
    turn_id: "threads-voice-1",
    source: "threads-smoke",
    transcript: "what time is it",
  });
  assert.equal(voice.status, 200, `voice turn must succeed: ${JSON.stringify(voice.json)}`);

  const threads = await requestJson("GET", `/v1/threads?session_id=${encodeURIComponent(SESSION_ID)}`);
  const branchIds = threads.json.threads.map((t) => t.branch_id).sort();
  assert.ok(branchIds.includes("default"), "the chat branch must remain listed");
  assert.ok(branchIds.includes("topic-two"), "the voice branch must be listed alongside the chat branch");
}

async function switchNewThreadIsActive() {
  const switched = await requestJson("POST", "/v1/threads/switch", {
    session_id: SESSION_ID,
    action: "new",
    thread_label: "Groceries",
    surface: "android",
  });
  assert.equal(switched.status, 200, `switch must succeed: ${JSON.stringify(switched.json)}`);
  const newBranch = switched.json.active.branch_id;
  assert.ok(newBranch.startsWith("thr-"), `a new thread must get a thr- branch id, got ${newBranch}`);
  assert.equal(switched.json.thread.label, "Groceries", "the new thread must carry its label");
  assert.equal(switched.json.thread.kind, "new", "the new thread kind must be new");

  const active = await requestJson("GET", `/v1/threads/active?session_id=${encodeURIComponent(SESSION_ID)}&surface=android`);
  assert.equal(active.json.active.branch_id, newBranch, "the active thread must persist across a later read");
  assert.equal(active.json.active.label, "Groceries", "the active thread must resolve its label");
}

async function forkRecordsParentAndForkPoint() {
  // Seed a turn on default so the fork has a non-empty fork point.
  await requestJson("POST", "/v1/voice/turns", {
    session_id: SESSION_ID,
    branch_id: "default",
    turn_id: "threads-fork-seed",
    source: "threads-smoke",
    transcript: "what time is it",
  });

  const fork = await requestJson("POST", "/v1/threads/switch", {
    session_id: SESSION_ID,
    action: "fork",
    parent_branch_id: "default",
    surface: "android",
  });
  assert.equal(fork.status, 200, `fork must succeed: ${JSON.stringify(fork.json)}`);
  const forkBranch = fork.json.active.branch_id;
  assert.ok(forkBranch.startsWith("fork-"), `a fork must get a fork- branch id, got ${forkBranch}`);
  assert.equal(fork.json.thread.parent_branch_id, "default", "the fork must record its parent branch");
  assert.ok(fork.json.thread.fork_point, "the fork must record a fork point");
  assert.equal(fork.json.thread.fork_point.turn_id, "threads-fork-seed", "the fork point must be the parent's latest turn");
}

async function switchByExplicitBranch() {
  const switched = await requestJson("POST", "/v1/threads/switch", {
    session_id: SESSION_ID,
    branch_id: "topic-two",
    surface: "android",
  });
  assert.equal(switched.status, 200, "explicit-branch switch must succeed");
  assert.equal(switched.json.active.branch_id, "topic-two", "switching by branch_id must set that branch active");

  const active = await requestJson("GET", `/v1/threads/active?session_id=${encodeURIComponent(SESSION_ID)}&surface=android`);
  assert.equal(active.json.active.branch_id, "topic-two", "the explicit branch must remain active");
}

async function tokenRequired() {
  const list = await requestJson("GET", `/v1/threads?session_id=${encodeURIComponent(SESSION_ID)}`, null, { auth: false });
  assert.equal(list.status, 401, "GET /v1/threads must require the gateway token");
  const switchNoAuth = await requestJson("POST", "/v1/threads/switch", { session_id: SESSION_ID, branch_id: "default" }, { auth: false });
  assert.equal(switchNoAuth.status, 401, "POST /v1/threads/switch must require the gateway token");
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
