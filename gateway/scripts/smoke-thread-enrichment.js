#!/usr/bin/env node
"use strict";

// Smoke for per-query enrichment + rolling thread summaries:
//   - the semantic recall block (brain.recall over rolling thread summaries +
//     intent memories), injected alongside recency into the model messages,
//   - rolling per-thread summary regeneration on the cadence boundary + its
//     gbrain index,
//   - fork-point inheritance in the recency block.
//
// Driven in-process. The Brain uses its file fallback (no gbrain binary), so
// recall is deterministic keyword matching. global.fetch is stubbed to capture
// the model messages and return canned replies.
//
// Asserts:
//   1. A seeded rolling thread summary is recalled and injected as a "Related
//      past threads" block on a later turn whose words match it.
//   2. The recall block is bounded (<= THREAD_RECALL_MAX_CHARS).
//   3. After the cadence number of persisted turns on a branch, a rolling summary
//      record is written and indexed into gbrain under moa/memory/thread/*.
//   4. Continuing on a fork branch inherits the parent branch's recency up to the
//      fork point.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "thread-enrichment-smoke-token";
const SESSION_ID = "thread-enrichment-smoke-session";
const RECALL_MAX_CHARS = 1200;
const SUMMARY_EVERY = 6;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-thread-enrichment-"));
const dataDir = path.join(tempDir, "data");
fs.mkdirSync(dataDir, { recursive: true });

process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
process.env.MOA_MODE = "local";
process.env.DATA_DIR = dataDir;
process.env.ANDROID_OTA_DIR = path.join(dataDir, "android-ota");
process.env.MOA_GATEWAY_TOKEN = TOKEN;
process.env.MODEL_PROVIDER = "openai-compatible";
process.env.MODEL_ID = "thread-enrichment-smoke-model";
process.env.MODEL_BASE_URL = "https://model.smoke.test/v1";
process.env.MODEL_API_KEY = "thread-enrichment-smoke-key";
process.env.OPENAI_API_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.GBRAIN_BIN = path.join(tempDir, "no-such-gbrain");
process.env.THREAD_RECALL_MAX_CHARS = String(RECALL_MAX_CHARS);
process.env.THREAD_SUMMARY_EVERY_TURNS = String(SUMMARY_EVERY);

const brainFactsFile = path.join(dataDir, "brain-facts.jsonl");

const previousFetch = global.fetch;
const fetchCalls = [];
let cannedReply = "Understood, master.";
global.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("/chat/completions")) {
    const body = JSON.parse(String(options.body || "{}"));
    fetchCalls.push({ url: u, body });
    return jsonResponse({ choices: [{ message: { role: "assistant", content: cannedReply } }] });
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
  await recallBlockSurfacesThreadSummary();
  await rollingSummaryAfterCadence();
  await forkInheritsParentRecency();

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "a seeded rolling thread summary is recalled and injected as a Related past threads block",
      "the recall block is bounded to THREAD_RECALL_MAX_CHARS",
      "the cadence boundary writes a rolling summary record and indexes it into gbrain thread memory",
      "continuing on a fork branch inherits the parent branch recency up to the fork point",
    ],
  }, null, 2));
}

function seedBrainFact(record) {
  fs.appendFileSync(brainFactsFile, `${JSON.stringify(record)}\n`);
}

async function recallBlockSurfacesThreadSummary() {
  // A long thread summary so we can also assert the recall block is bounded.
  const longTail = " ".concat("The team debated the vendor selection at length.").repeat(60);
  seedBrainFact({
    ts: new Date().toISOString(),
    slug: "moa/memory/thread/topic-groceries",
    kind: "thread",
    tags: ["memory", "thread"],
    title: "Grocery budget thread",
    text: `Thread about the weekly grocery budget and vendor pricing.${longTail}`,
  });

  fetchCalls.length = 0;
  const chat = await requestJson("POST", "/v1/chat", {
    session_id: SESSION_ID,
    branch_id: "recall-branch",
    source: "console",
    messages: [{ role: "user", content: "remind me what we decided about the grocery budget" }],
  });
  assert.equal(chat.status, 200, `chat must succeed: ${JSON.stringify(chat.json)}`);
  const call = fetchCalls.find((c) => Array.isArray(c.body.messages));
  assert.ok(call, "the chat turn must call the model");
  const systemText = call.body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(systemText, /Related past threads \(semantic recall/, "the semantic recall block must be injected");
  assert.match(systemText, /grocery budget/, "the recalled thread summary must appear in the recall block");

  // Budget: the recall block itself must be bounded.
  const blockMatch = systemText.match(/Related past threads \(semantic recall[\s\S]*/);
  assert.ok(blockMatch, "the recall block must be present to measure");
  // The block is one system message; measure that exact message.
  const recallMessage = call.body.messages.find((m) => m.role === "system" && /Related past threads/.test(m.content));
  assert.ok(recallMessage.content.length <= RECALL_MAX_CHARS + 3, `recall block must be bounded to ${RECALL_MAX_CHARS}, got ${recallMessage.content.length}`);
}

async function rollingSummaryAfterCadence() {
  cannedReply = "Rolling summary: the ledger plan across several logged details.";
  const branch = "cadence-branch";
  for (let i = 1; i <= SUMMARY_EVERY; i += 1) {
    const chat = await requestJson("POST", "/v1/chat", {
      session_id: SESSION_ID,
      branch_id: branch,
      source: "console",
      messages: [{ role: "user", content: `logged detail ${i} for the ledger plan` }],
    });
    assert.equal(chat.status, 200, `cadence turn ${i} must succeed`);
    assert.equal(chat.json.context.action, "continue", `cadence turn ${i} must stay a continue turn`);
    assert.equal(chat.json.branch_id, branch, `cadence turn ${i} must stay on the branch`);
  }

  // The summary is regenerated asynchronously (setImmediate) after the response.
  await drainAsync();

  const summaryPath = path.join(dataDir, "thread-summaries", SESSION_ID, `${branch}.json`);
  assert.ok(fs.existsSync(summaryPath), `a rolling summary record must be written at ${summaryPath}`);
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  assert.ok(String(summary.summary || "").length > 0, "the summary record must carry summary text");
  assert.equal(summary.turn_count, SUMMARY_EVERY, `the summary must count the ${SUMMARY_EVERY} turns`);

  const facts = fs.readFileSync(brainFactsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(
    facts.some((fact) => String(fact.slug || "").startsWith(`moa/memory/thread/${branch}`)),
    "the summary must be indexed into gbrain under moa/memory/thread/<branch>"
  );
  cannedReply = "Understood, master.";
}

async function forkInheritsParentRecency() {
  // A parent turn on the default branch.
  await requestJson("POST", "/v1/chat", {
    session_id: SESSION_ID,
    branch_id: "default",
    source: "console",
    messages: [{ role: "user", content: "the parent decision was to use vendor alpha for shipping" }],
  });

  // Fork off the default branch.
  const fork = await requestJson("POST", "/v1/threads/switch", {
    session_id: SESSION_ID,
    action: "fork",
    parent_branch_id: "default",
    surface: "console",
  });
  const forkBranch = fork.json.active.branch_id;
  assert.ok(forkBranch.startsWith("fork-"), `fork must mint a fork- branch, got ${forkBranch}`);

  fetchCalls.length = 0;
  const chat = await requestJson("POST", "/v1/chat", {
    session_id: SESSION_ID,
    branch_id: forkBranch,
    source: "console",
    messages: [{ role: "user", content: "continue with that shipping plan" }],
  });
  assert.equal(chat.status, 200, `fork continue turn must succeed: ${JSON.stringify(chat.json)}`);
  const call = fetchCalls.find((c) => Array.isArray(c.body.messages));
  const systemText = call.body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(systemText, /vendor alpha for shipping/, "the fork must inherit the parent branch recency up to the fork point");
}

async function drainAsync() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
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
