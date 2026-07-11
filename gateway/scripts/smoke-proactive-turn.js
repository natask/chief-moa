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
  PROACTIVE_ACCEPTED_PROMPTS,
  PROACTIVE_SYSTEM_PROMPT,
  proactiveFallbackReply,
} = require("../lib/proactive-turn");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "proactive-turn-smoke-token";
const EXPECTED_PROMPTS = Object.freeze([
  "Help me make a checklist for reviewing this form's structure.",
  "Help me plan an analysis for a table.",
  "Help me organize a task surface.",
  "Help me plan a concise document summary.",
]);

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  assert.deepEqual(
    PROACTIVE_ACCEPTED_PROMPTS,
    EXPECTED_PROMPTS,
    "the gateway allowlist must stay pinned to the four packaged extension prompts",
  );
  for (const prompt of EXPECTED_PROMPTS) {
    assert.ok(proactiveFallbackReply(prompt), `missing deterministic fallback for: ${prompt}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-proactive-turn-smoke-"));
  const homeDir = path.join(tempDir, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  let gateway;
  let fallbackGateway;
  let fakeModel;

  try {
    fakeModel = await startFakeModelServer();
    const modelDataDir = path.join(tempDir, "model-data");
    gateway = await startGateway({
      dataDir: modelDataDir,
      homeDir,
      modelBaseUrl: `${fakeModel.baseUrl}/v1`,
      modelApiKey: "fake-model-key",
    });

    const before = await captureAuthorityState(gateway.baseUrl, modelDataDir);
    for (let index = 0; index < EXPECTED_PROMPTS.length; index += 1) {
      const result = await postJson(
        `${gateway.baseUrl}/v1/proactive/turns`,
        validBody(EXPECTED_PROMPTS[index]),
      );
      assert.equal(result.status, 200, `accepted prompt ${index + 1} failed: ${result.text}`);
      assert.equal(result.headers["cache-control"], "no-store");
      assertProactiveResponse(result.json, `MODEL_PROACTIVE_TEXT_ONLY_${index + 1}`);
    }

    await assertRejectedRequests(gateway.baseUrl);
    assert.equal(
      fakeModel.requests.length,
      EXPECTED_PROMPTS.length,
      "rejected requests must never reach the model provider",
    );
    assertProviderRequests(fakeModel.requests);

    const after = await captureAuthorityState(gateway.baseUrl, modelDataDir);
    assert.deepEqual(
      after,
      before,
      "proactive turns must not change agent-run, conversation, turn, broker, task, event, or other DATA_DIR state",
    );

    await stopChild(gateway.child);
    gateway = null;
    await closeServer(fakeModel.server);
    fakeModel = null;

    const fallbackDataDir = path.join(tempDir, "fallback-data");
    fallbackGateway = await startGateway({
      dataDir: fallbackDataDir,
      homeDir,
      modelBaseUrl: "https://api.openai.com/v1",
      modelApiKey: "",
    });
    const fallbackBefore = await captureAuthorityState(fallbackGateway.baseUrl, fallbackDataDir);
    const fallback = await postJson(
      `${fallbackGateway.baseUrl}/v1/proactive/turns`,
      validBody(EXPECTED_PROMPTS[0]),
    );
    assert.equal(fallback.status, 200, `fallback request failed: ${fallback.text}`);
    assertProactiveResponse(fallback.json, proactiveFallbackReply(EXPECTED_PROMPTS[0]));
    const fallbackAfter = await captureAuthorityState(fallbackGateway.baseUrl, fallbackDataDir);
    assert.deepEqual(fallbackAfter, fallbackBefore, "fallback proactive turn must also leave DATA_DIR unchanged");

    console.log(JSON.stringify({
      ok: true,
      checks: [
        "POST /v1/proactive/turns requires bearer authentication",
        "all four packaged prompts reach the no-tools model primitive and return inert text with actions:[]",
        "unknown, extra, sensitive-context, malformed, wrong-client, and oversized requests are rejected before model access",
        "provider payload contains only fixed proactive system text plus the allowlisted prompt and no tools",
        "agent-run, conversation, turn, broker, task, event, and complete DATA_DIR state remain unchanged",
        "the no-provider path uses the deterministic text-only fallback without persistence",
      ],
    }, null, 2));
  } finally {
    if (gateway) await stopChild(gateway.child);
    if (fallbackGateway) await stopChild(fallbackGateway.child);
    if (fakeModel) await closeServer(fakeModel.server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function validBody(transcript) {
  return {
    source: "proactive_accept_v1",
    transcript,
    modality: "text",
    client: {
      platform: "browser",
      source: "agee-extension",
      input: "text",
    },
  };
}

function assertProactiveResponse(response, expectedText) {
  assert.deepEqual(
    Object.keys(response).sort(),
    ["actions", "classification", "display", "persisted", "source", "text"],
    "response must expose only inert text metadata and the empty actions array",
  );
  assert.equal(response.source, "proactive_accept_v1");
  assert.equal(response.classification, "proactive_text_only");
  assert.equal(response.persisted, false);
  assert.deepEqual(response.actions, []);
  assert.equal(response.display, response.text);
  assert.match(response.text, new RegExp(escapeRegExp(expectedText)));
}

async function assertRejectedRequests(baseUrl) {
  const unauthenticated = await postJson(
    `${baseUrl}/v1/proactive/turns`,
    validBody(EXPECTED_PROMPTS[0]),
    { auth: false },
  );
  assert.equal(unauthenticated.status, 401, "proactive route must require a token");

  const wrongToken = await postJson(
    `${baseUrl}/v1/proactive/turns`,
    validBody(EXPECTED_PROMPTS[0]),
    { token: "wrong-token" },
  );
  assert.equal(wrongToken.status, 401, "proactive route must reject a wrong token");

  const semanticCases = [
    [{ ...validBody(EXPECTED_PROMPTS[0]), source: "browser" }, "invalid_source"],
    [{ ...validBody(EXPECTED_PROMPTS[0]), modality: "voice" }, "invalid_modality"],
    [validBody("Summarize the user's private page."), "unrecognized_prompt"],
    [validBody(`${EXPECTED_PROMPTS[0]} `), "unrecognized_prompt"],
    [{ ...validBody(EXPECTED_PROMPTS[0]), client: { platform: "browser", source: "agee-extension", input: "voice" } }, "invalid_client"],
    [{ ...validBody(EXPECTED_PROMPTS[0]), client: { ...validBody(EXPECTED_PROMPTS[0]).client, id: "extra" } }, "invalid_client_shape"],
    [null, "invalid_request_shape"],
    [[], "invalid_request_shape"],
  ];
  for (const [body, code] of semanticCases) {
    const result = await postJson(`${baseUrl}/v1/proactive/turns`, body);
    assert.equal(result.status, 422, `${code} must return 422: ${result.text}`);
    assert.equal(result.json.code, code);
  }

  const forbiddenFields = [
    "page",
    "page_context",
    "screen",
    "accessibility_context",
    "context",
    "session",
    "session_id",
    "conversation_id",
    "turn_id",
    "url",
    "title",
    "selection",
    "messages",
    "actions",
  ];
  for (const field of forbiddenFields) {
    const result = await postJson(`${baseUrl}/v1/proactive/turns`, {
      ...validBody(EXPECTED_PROMPTS[0]),
      [field]: field === "screen" || field === "context" ? {} : "forbidden",
    });
    assert.equal(result.status, 422, `${field} must be rejected: ${result.text}`);
    assert.equal(result.json.code, "invalid_request_shape");
  }

  const malformed = await postRaw(`${baseUrl}/v1/proactive/turns`, "{", {
    contentType: "application/json",
  });
  assert.equal(malformed.status, 400, `malformed JSON must return 400: ${malformed.text}`);
  assert.equal(malformed.json.code, "invalid_json");

  const empty = await postRaw(`${baseUrl}/v1/proactive/turns`, "", {
    contentType: "application/json",
  });
  assert.equal(empty.status, 400, `empty JSON must return 400: ${empty.text}`);
  assert.equal(empty.json.code, "invalid_json");

  const wrongContentType = await postRaw(
    `${baseUrl}/v1/proactive/turns`,
    JSON.stringify(validBody(EXPECTED_PROMPTS[0])),
    { contentType: "text/plain" },
  );
  assert.equal(wrongContentType.status, 415, `wrong content type must return 415: ${wrongContentType.text}`);
  assert.equal(wrongContentType.json.code, "content_type_required");

  const oversized = await postRaw(
    `${baseUrl}/v1/proactive/turns`,
    `${JSON.stringify(validBody(EXPECTED_PROMPTS[0]))}${" ".repeat(2200)}`,
    { contentType: "application/json" },
  );
  assert.equal(oversized.status, 413, `oversized body must return 413: ${oversized.text}`);
  assert.equal(oversized.json.code, "body_too_large");
}

function assertProviderRequests(requests) {
  assert.equal(requests.length, EXPECTED_PROMPTS.length);
  requests.forEach((request, index) => {
    assert.deepEqual(
      Object.keys(request).sort(),
      ["messages", "model", "stream", "temperature"],
      "proactive model call must not include tools or execution metadata",
    );
    assert.equal(request.model, "proactive-turn-smoke-model");
    assert.equal(request.temperature, 0.2);
    assert.equal(request.stream, false);
    assert.ok(!Object.hasOwn(request, "tools"));
    assert.ok(!Object.hasOwn(request, "tool_choice"));
    assert.ok(!Object.hasOwn(request, "functions"));
    assert.ok(Array.isArray(request.messages));
    const userMessages = request.messages.filter((message) => message.role === "user");
    const systemMessages = request.messages.filter((message) => message.role === "system");
    assert.deepEqual(userMessages, [{ role: "user", content: EXPECTED_PROMPTS[index] }]);
    assert.ok(systemMessages.length >= 1);
    for (const message of systemMessages) {
      assert.equal(message.content, PROACTIVE_SYSTEM_PROMPT, "stored profile/persona must not enter the provider request");
    }
    const serialized = JSON.stringify(request);
    for (const forbidden of [
      "accessibility_context",
      "page_context",
      "session_id",
      "conversation_id",
      "User identity profile",
      "Mission-agent access policy",
    ]) {
      assert.ok(!serialized.includes(forbidden), `provider request leaked forbidden context marker: ${forbidden}`);
    }
  });
}

async function captureAuthorityState(baseUrl, dataDir) {
  const runs = await requestJson(`${baseUrl}/v1/agent/runs`);
  assert.equal(runs.status, 200, `agent run listing failed: ${runs.text}`);
  return {
    agentRuns: runs.json,
    dataTree: snapshotTree(dataDir),
  };
}

function snapshotTree(root) {
  if (!fs.existsSync(root)) return [];
  const entries = [];
  const visit = (directory, relative = "") => {
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const fullPath = path.join(directory, child.name);
      if (child.isDirectory()) {
        entries.push(`D ${childRelative}`);
        visit(fullPath, childRelative);
      } else if (child.isFile()) {
        const bytes = fs.readFileSync(fullPath);
        const digest = crypto.createHash("sha256").update(bytes).digest("hex");
        entries.push(`F ${childRelative} ${bytes.length} ${digest}`);
      } else {
        entries.push(`O ${childRelative}`);
      }
    }
  };
  visit(root);
  return entries;
}

async function startFakeModelServer() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    try {
      const body = await readRequestJson(request, 64 * 1024);
      requests.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: `MODEL_PROACTIVE_TEXT_ONLY_${requests.length}: inert guidance only.` } }],
      }));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await listen(server, 0);
  const address = server.address();
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function startGateway({ dataDir, homeDir, modelBaseUrl, modelApiKey }) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: gatewayEnv({ port, dataDir, homeDir, modelBaseUrl, modelApiKey }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(child);
  await waitForHealth(baseUrl, logs);
  await sleep(50);
  return { baseUrl, child };
}

function gatewayEnv({ port, dataDir, homeDir, modelBaseUrl, modelApiKey }) {
  return {
    PATH: process.env.PATH || "",
    HOME: homeDir,
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    NODE_ENV: "test",
    MOA_MODE: "local",
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
    HARNESS_WORKDIR: GATEWAY_DIR,
    DEFAULT_AGENT_HARNESS: "echo",
    MOA_GATEWAY_TOKEN: TOKEN,
    MODEL_PROVIDER: "openai-compatible",
    MODEL_BASE_URL: modelBaseUrl,
    MODEL_ID: "proactive-turn-smoke-model",
    MODEL_API_KEY: modelApiKey,
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GEMINI_API_KEY: "",
    VERTEX_PROJECT: "",
    GOOGLE_CLOUD_PROJECT: "",
    GOOGLE_APPLICATION_CREDENTIALS: "",
    VERTEX_ACCESS_TOKEN: "",
    VOICE_PROVIDER: "loopback",
    VOICE_STT_PROVIDER: "loopback",
    VOICE_LLM_PROVIDER: "loopback",
    VOICE_TTS_PROVIDER: "loopback",
    MOA_TIME_ZONE: "UTC",
  };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Gateway may still be starting.
    }
    if (logs.exited) {
      throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

async function postJson(url, body, options = {}) {
  return postRaw(url, JSON.stringify(body), {
    ...options,
    contentType: "application/json; charset=utf-8",
  });
}

async function postRaw(url, body, options = {}) {
  const headers = {
    "content-type": options.contentType || "application/json",
  };
  if (options.auth !== false) {
    headers.authorization = `Bearer ${options.token || TOKEN}`;
  }
  return responsePayload(await fetch(url, {
    method: "POST",
    headers,
    body,
  }));
}

async function requestJson(url) {
  return responsePayload(await fetch(url, {
    headers: { authorization: `Bearer ${TOKEN}` },
  }));
}

async function responsePayload(response) {
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Assertion sites include the raw text for a useful failure.
  }
  return {
    status: response.status,
    text,
    json,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

async function readRequestJson(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("fake model request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function collectLogs(child) {
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (output.length > 16000) output = output.slice(-16000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const logs = { exited: false, text: () => output };
  child.on("exit", () => {
    logs.exited = true;
  });
  return logs;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(1500).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
