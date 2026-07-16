"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const jpeg = require("jpeg-js");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function post(origin, pathname, body) {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: {
      authorization: "Bearer integration-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function jpegEvidence() {
  const bytes = jpeg.encode({
    width: 2,
    height: 1,
    data: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]),
  }, 70).data;
  return {
    version: "moa.screen-evidence.request.v1",
    surface: "android",
    captured_at: new Date().toISOString(),
    binding: { kind: "package", id: "com.example.editor", generation: "focus-1" },
    semantic_summary: "A blank ordinary editor is focused.",
    screenshot: {
      mime_type: "image/jpeg",
      data_base64: bytes.toString("base64"),
      bytes: bytes.length,
      width: 2,
      height: 1,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

function durableText(root) {
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(durableText(filePath));
    else if (entry.isFile() && /\.(?:json|jsonl)$/.test(entry.name)) output.push(fs.readFileSync(filePath, "utf8"));
  }
  return output.join("\n");
}

test("HTTP dictation routes bypass literal effects and attach only ephemeral screen bytes", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dictation-http-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const providerBodies = [];
  const provider = http.createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      providerBodies.push(JSON.parse(text));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "screen-aware draft" } }] }));
    });
  });
  await listen(provider);
  t.after(() => close(provider));
  const providerOrigin = `http://127.0.0.1:${provider.address().port}/v1`;

  process.env.DATA_DIR = dataDir;
  process.env.MOA_MODE = "local";
  process.env.MOA_GATEWAY_TOKEN = "integration-token";
  process.env.MODEL_PROVIDER = "openai-compatible";
  process.env.MODEL_BASE_URL = providerOrigin;
  process.env.MODEL_API_KEY = "fixture-key";
  process.env.CONTEXT_PREFLIGHT_FAST_MAX_WORDS = "3";
  process.env.ACCOUNT_HEALTH_INTERVAL_MS = "0";
  const { server } = require("../server");
  await listen(server);
  t.after(() => close(server));
  const gatewayOrigin = `http://127.0.0.1:${server.address().port}`;

  const literal = "Exact literal words.  ";
  const chatLiteral = await post(gatewayOrigin, "/v1/chat", {
    delivery_intent: "literal_text",
    transcript: literal,
    screen_evidence: { malformed: "must not be read" },
    messages: [{ role: "user", content: "must not dispatch" }],
  });
  assert.equal(chatLiteral.status, 200);
  assert.deepEqual(chatLiteral.body, {
    delivery_intent: "literal_text",
    candidate: { kind: "literal_text", text: literal },
  });
  const voiceLiteral = await post(gatewayOrigin, "/v1/voice/turns", {
    delivery_intent: "literal_text",
    transcript: "voice literal",
    source: "android",
  });
  assert.equal(voiceLiteral.status, 200);
  assert.equal(voiceLiteral.body.candidate.text, "voice literal");
  assert.equal(providerBodies.length, 0);
  assert.doesNotMatch(durableText(dataDir), /Exact literal words|voice literal|must not dispatch/);

  const evidence = jpegEvidence();
  const assistant = await post(gatewayOrigin, "/v1/chat", {
    delivery_intent: "assistant_response",
    source: "android",
    messages: [{ role: "user", content: "draft this" }],
    screen_evidence: evidence,
  });
  assert.equal(assistant.status, 200);
  assert.equal(assistant.body.text, "screen-aware draft");
  assert.equal(providerBodies.length, 1);
  const imagePart = providerBodies[0].messages
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((part) => part.type === "image_url");
  assert.equal(imagePart.image_url.url, `data:image/jpeg;base64,${evidence.screenshot.data_base64}`);
  const persisted = durableText(dataDir);
  assert.match(persisted, new RegExp(evidence.screenshot.sha256));
  assert.doesNotMatch(persisted, new RegExp(evidence.screenshot.data_base64.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const voiceAssistant = await post(gatewayOrigin, "/v1/voice/turns", {
    delivery_intent: "assistant_response",
    transcript: "draft this",
    transcript_source: "client_stt",
    source: "android",
    session_id: "screen-voice",
    turn_id: "screen-voice-turn",
    screen_evidence: evidence,
  });
  assert.equal(voiceAssistant.status, 200);
  assert.equal(voiceAssistant.body.display, "screen-aware draft");
  assert.equal(providerBodies.length, 2);
  assert.match(JSON.stringify(providerBodies[1]), /data:image\/jpeg;base64/);
  assert.doesNotMatch(durableText(dataDir), new RegExp(evidence.screenshot.data_base64.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const malformed = await post(gatewayOrigin, "/v1/voice/turns", {
    delivery_intent: "assistant_response",
    transcript: "draft this",
    screen_evidence: { surface: "android" },
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "invalid_screen_evidence_captured_at");
  assert.equal(providerBodies.length, 2);

  const legacy = await post(gatewayOrigin, "/v1/chat", {
    source: "android",
    messages: [{ role: "user", content: "legacy request" }],
  });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.text, "screen-aware draft");
  assert.equal(providerBodies.length, 3);
});
