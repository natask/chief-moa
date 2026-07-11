#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  MACOS_PROACTIVE_MAX_BODY_BYTES, MACOS_PROACTIVE_MAX_OUTPUT_TOKENS, MACOS_PROACTIVE_SYSTEM_PROMPT,
  buildMacosOpenAiPayload, buildMacosVertexPayload, macosOpenAiText, macosVertexText, validateMacosProactiveBody,
} = require("../lib/macos-proactive-turn");

const ROOT = path.resolve(__dirname, "..");
const TOKEN = "macos-proactive-smoke-token";

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });

function jpeg() { return Buffer.from("/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/fyiiigD/9k=", "base64"); }
function validBody(withImage = false) {
  const image = jpeg();
  return {
    version: 1,
    client: { surface: "macos", release_mode: "ask_each_time" },
    observation: {
      observation_id: "obs_123", captured_at: "2026-07-11T12:00:00.000Z",
      app: { bundle_id: "com.example.Editor", name: "Editor" }, window: { title: "Draft" },
      ax: { nodes: [{ id: "root", parent_id: null, role: "AXWindow", subrole: "", label: "Draft", enabled: true, focused: true, actions: ["press"] }], truncated: false, dropped: 0 },
      screenshot: withImage ? { mime_type: "image/jpeg", data_base64: image.toString("base64"), sha256: crypto.createHash("sha256").update(image).digest("hex"), width: 1, height: 1 } : null,
    },
  };
}

async function main() {
  const axOnly = validateMacosProactiveBody(validBody());
  const imageBody = validateMacosProactiveBody(validBody(true));
  const openAi = buildMacosOpenAiPayload(imageBody, "model");
  assert.equal(openAi.max_tokens, MACOS_PROACTIVE_MAX_OUTPUT_TOKENS);
  assert.deepEqual(Object.keys(openAi), ["model", "messages", "temperature", "max_tokens", "stream"]);
  assert.equal(openAi.messages[0].content, MACOS_PROACTIVE_SYSTEM_PROMPT);
  assert.equal(openAi.messages[1].content[1].type, "image_url");
  assert.ok(!Object.hasOwn(openAi, "tools") && !Object.hasOwn(openAi, "tool_choice"));
  const vertex = buildMacosVertexPayload(imageBody);
  assert.equal(vertex.contents[0].parts[1].inlineData.mimeType, "image/jpeg");
  assert.ok(!Object.hasOwn(vertex, "tools") && !Object.hasOwn(vertex, "toolConfig"));
  assert.throws(() => macosOpenAiText({ choices: [{ message: { content: "x", tool_calls: [] } }] }), /executable/);
  assert.throws(() => macosVertexText({ candidates: [{ content: { parts: [{ functionCall: {} }] } }] }), /executable/);
  assert.equal(macosOpenAiText({ choices: [{ message: { content: "Suggestion" } }] }), "Suggestion");
  assert.equal(macosVertexText({ candidates: [{ content: { parts: [{ text: "Suggestion" }] } }] }), "Suggestion");
  const badHash = validBody(true); badHash.observation.screenshot.sha256 = "0".repeat(64);
  assert.throws(() => validateMacosProactiveBody(badHash), /invalid_screenshot_hash/);
  const unknown = validBody(); unknown.extra = true;
  assert.throws(() => validateMacosProactiveBody(unknown), /invalid_request_shape/);
  const badImage = validBody(true); badImage.observation.screenshot.data_base64 = Buffer.from("not jpeg").toString("base64"); badImage.observation.screenshot.sha256 = crypto.createHash("sha256").update(Buffer.from("not jpeg")).digest("hex");
  assert.throws(() => validateMacosProactiveBody(badImage), /invalid_screenshot_jpeg/);
  const truncated = validBody(true); const fake = Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,1,0,1,1,1,0x11,0,0xff,0xd9]); truncated.observation.screenshot.data_base64 = fake.toString("base64"); truncated.observation.screenshot.sha256 = crypto.createHash("sha256").update(fake).digest("hex");
  assert.throws(() => validateMacosProactiveBody(truncated), /invalid_screenshot_dimensions/);
  const fabricated = validBody(true); const fakeScan = Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,1,0,1,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,63,0,42,0xff,0xd9]); setScreenshotBytes(fabricated, fakeScan);
  assert.throws(() => validateMacosProactiveBody(fabricated), /invalid_screenshot_jpeg/);
  const trailing = validBody(true); setScreenshotBytes(trailing, Buffer.concat([jpeg(), Buffer.from([0])]));
  assert.throws(() => validateMacosProactiveBody(trailing), /invalid_screenshot_jpeg/);
  const wrongDimensions = validBody(true); wrongDimensions.observation.screenshot.width = 2;
  assert.throws(() => validateMacosProactiveBody(wrongDimensions), /invalid_screenshot_dimensions/);
  assert.equal(axOnly.observation.screenshot, null);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "moa-macos-proactive-"));
  const data = path.join(temp, "data"); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "sentinel"), "unchanged");
  const provider = await startFakeProvider();
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: {
    PATH: process.env.PATH || "", HOME: path.join(temp, "home"), NODE_ENV: "test", MOA_MODE: "local", HOST: "127.0.0.1", PORT: String(port),
    DATA_DIR: data, ANDROID_OTA_DIR: path.join(data, "ota"), HARNESS_WORKDIR: ROOT, DEFAULT_AGENT_HARNESS: "echo", MOA_GATEWAY_TOKEN: TOKEN,
    MODEL_PROVIDER: "openai-compatible", MODEL_BASE_URL: `${provider.baseUrl}/v1`, MODEL_API_KEY: "test-key", OPENAI_API_KEY: "",
    PROACTIVE_PROVIDER_TIMEOUT_MS: "300",
    VOICE_PROVIDER: "loopback", VOICE_STT_PROVIDER: "loopback", VOICE_LLM_PROVIDER: "loopback", VOICE_TTS_PROVIDER: "loopback",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stdout.on("data", (x) => { logs += x; }); child.stderr.on("data", (x) => { logs += x; });
  try {
    const base = `http://127.0.0.1:${port}`; await health(base, child, () => logs);
    const before = snapshot(data);
    const accepted = await post(base, validBody(true));
    assert.equal(accepted.status, 200, accepted.text); assert.equal(accepted.headers.get("cache-control"), "no-store");
    assert.deepEqual(accepted.json, { version: 1, suggestion: "MODEL_SUGGESTION", actions: [] });
    assert.deepEqual(Object.keys(accepted.json).sort(), ["actions", "suggestion", "version"]);
    assert.equal(provider.requests.length, 1); assert.deepEqual(Object.keys(provider.requests[0].body), ["model", "messages", "temperature", "max_tokens", "stream"]);
    assert.ok(!Object.hasOwn(provider.requests[0].body, "tools"));
    assert.equal((await post(base, validBody(), false)).status, 401);
    assert.equal((await post(base, { ...validBody(), extra: true })).status, 422);
    assert.equal((await fetch(`${base}/v1/proactive/macos`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "x".repeat(MACOS_PROACTIVE_MAX_BODY_BYTES + 1) })).status, 413);
    for (const mode of ["tool", "redirect", "oversize", "stall"]) {
      provider.mode = mode;
      const failed = await post(base, validBody());
      assert.equal(failed.status, 500, `${mode} provider output must fail closed: ${failed.text}`);
    }
    provider.mode = "normal";
    assert.deepEqual(snapshot(data), before, "proactive route mutated DATA_DIR");
  } finally { child.kill("SIGTERM"); }

  const vertexData = path.join(temp, "vertex-data"); fs.mkdirSync(vertexData, { recursive: true });
  const vertexPort = await freePort();
  const vertexChild = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: {
    PATH: process.env.PATH || "", HOME: path.join(temp, "home"), NODE_ENV: "test", MOA_MODE: "local", HOST: "127.0.0.1", PORT: String(vertexPort),
    DATA_DIR: vertexData, ANDROID_OTA_DIR: path.join(vertexData, "ota"), HARNESS_WORKDIR: ROOT, DEFAULT_AGENT_HARNESS: "echo", MOA_GATEWAY_TOKEN: TOKEN,
    MODEL_PROVIDER: "vertex", MODEL_ID: "vertex-smoke", VERTEX_PROJECT: "test-project", GOOGLE_CLOUD_PROJECT: "test-project", VERTEX_LOCATION: "global",
    VERTEX_API_BASE_URL: provider.baseUrl, VERTEX_ACCESS_TOKEN: "test-vertex-token", PROACTIVE_PROVIDER_TIMEOUT_MS: "300",
    VOICE_PROVIDER: "loopback", VOICE_STT_PROVIDER: "loopback", VOICE_LLM_PROVIDER: "loopback", VOICE_TTS_PROVIDER: "loopback",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let vertexLogs = ""; vertexChild.stdout.on("data", (x) => { vertexLogs += x; }); vertexChild.stderr.on("data", (x) => { vertexLogs += x; });
  try {
    const base = `http://127.0.0.1:${vertexPort}`; await health(base, vertexChild, () => vertexLogs);
    const accepted = await post(base, validBody(true)); assert.equal(accepted.status, 200, accepted.text);
    const request = provider.requests.at(-1).body;
    assert.deepEqual(Object.keys(request).sort(), ["contents", "generationConfig", "safetySettings", "systemInstruction"]);
    assert.ok(!Object.hasOwn(request, "tools") && !Object.hasOwn(request, "toolConfig"));
    provider.mode = "vertex-tool"; assert.equal((await post(base, validBody())).status, 500);
    provider.mode = "normal";
  } finally {
    vertexChild.kill("SIGTERM"); await provider.close(); fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log("macOS proactive smoke: PASS");
}

function setScreenshotBytes(body, bytes) {
  body.observation.screenshot.data_base64 = bytes.toString("base64");
  body.observation.screenshot.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
}

async function post(base, body, auth = true) {
  const headers = { "content-type": "application/json" }; if (auth) headers.authorization = `Bearer ${TOKEN}`;
  const response = await fetch(`${base}/v1/proactive/macos`, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" });
  const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: response.status, headers: response.headers, text, json };
}
function snapshot(dir, root = dir, out = {}) { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir, name); const key = path.relative(root, file); if (fs.statSync(file).isDirectory()) snapshot(file, root, out); else out[key] = fs.readFileSync(file).toString("hex"); } return out; }
function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close((e) => e ? reject(e) : resolve(port)); }); server.on("error", reject); }); }
async function health(base, child, logs) { const deadline = Date.now() + 10000; while (Date.now() < deadline) { try { if ((await fetch(`${base}/health`)).ok) return; } catch {} if (child.exitCode !== null) throw new Error(logs()); await new Promise((r) => setTimeout(r, 50)); } throw new Error(`health timeout\n${logs()}`); }

async function startFakeProvider() {
  const requests = [];
  const state = { mode: "normal" };
  const server = http.createServer(async (request, response) => {
    if (request.url === "/redirect-target") { response.end(JSON.stringify({ choices: [{ message: { content: "redirect followed" } }] })); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
    response.setHeader("content-type", "application/json");
    if (state.mode === "redirect") { response.writeHead(307, { location: "/redirect-target" }); response.end(); return; }
    if (state.mode === "oversize") { response.end(JSON.stringify({ choices: [{ message: { content: "x".repeat(70 * 1024) } }] })); return; }
    if (state.mode === "stall") { response.writeHead(200); response.write('{"choices":['); return; }
    const vertex = request.url.includes(":generateContent");
    if (state.mode === "tool") { response.end(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "x" }] } }] })); return; }
    if (state.mode === "vertex-tool") { response.end(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "x" } }] } }] })); return; }
    response.end(vertex
      ? JSON.stringify({ candidates: [{ content: { parts: [{ text: "MODEL_SUGGESTION" }] } }] })
      : JSON.stringify({ choices: [{ message: { content: "MODEL_SUGGESTION" } }] }));
  });
  await new Promise((resolve, reject) => { server.listen(0, "127.0.0.1", resolve); server.on("error", reject); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, requests, get mode() { return state.mode; }, set mode(value) { state.mode = value; }, close: () => new Promise((resolve) => server.close(resolve)) };
}
