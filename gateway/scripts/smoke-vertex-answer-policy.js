#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "vertex-answer-policy-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-vertex-policy-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const gatewayPort = await freePort();
  const vertex = await startFakeVertex();
  let gateway;

  try {
    gateway = await startGateway({ port: gatewayPort, dataDir, vertexUrl: vertex.url });
    const turn = await postJson(`http://127.0.0.1:${gatewayPort}/v1/voice/turns`, {
      session_id: "vertex-answer-policy-smoke",
      branch_id: "default",
      turn_id: "tax-advice-turn",
      source: "smoke",
      transcript: "Give me tax advice for deducting home office expenses.",
    });

    assert.equal(turn.status, 200, `voice turn must succeed: ${JSON.stringify(turn.json)}`);
    assert.equal(turn.json.classification, "chat", "ordinary tax advice must route as chat");
    assert.match(turn.json.display, /deduct/i, "gateway must return the fake Vertex answer");
    assert.equal(vertex.requests.length, 2, "gateway must select context before asking Vertex for the answer");

    const request = vertex.requests[1];
    assert.equal(request.headers.authorization, "Bearer test-vertex-token", "gateway must send Vertex bearer token");
    assert.ok(request.path.includes("/models/gemini-3.5-flash:generateContent"), `unexpected Vertex path: ${request.path}`);
    assert.deepEqual(
      request.body.safetySettings,
      [
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      ],
      "Vertex request must set the configurable safety filters to BLOCK_NONE",
    );
    const systemText = String(request.body.systemInstruction?.parts?.[0]?.text || "");
    assert.match(systemText, /Answer policy:/, "system instruction must include answer policy");
    assert.match(systemText, /tax, legal, medical, financial/i, "answer policy must name ordinary professional domains");
    assert.match(systemText, /give practical general information/i, "answer policy must steer professional-domain answers");
    assert.match(systemText, /live brokerage, bank, crypto, checkout, or payment flow/i, "answer policy must cover live transaction screens");
    assert.match(systemText, /do not recommend a specific transaction/i, "answer policy must avoid transaction-specific advice");
    assert.match(systemText, /submit\/preview\/place orders/i, "answer policy must avoid order submission help");

    console.log(JSON.stringify({
      ok: true,
      checks: [
        "ordinary tax-advice voice turn routes as chat",
        "Vertex request includes BLOCK_NONE safetySettings for configurable categories",
        "Vertex system instruction includes ordinary professional-domain answer policy",
        "Vertex system instruction covers live transaction screens without transaction-specific help",
      ],
    }, null, 2));
  } finally {
    if (gateway) {
      gateway.kill("SIGTERM");
      await onceExit(gateway, 1500);
    }
    await vertex.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function startGateway({ port, dataDir, vertexUrl }) {
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
      MOA_GATEWAY_TOKEN: TOKEN,
      MODEL_PROVIDER: "vertex",
      MODEL_ID: "gemini-3.5-flash",
      VERTEX_PROJECT: "smoke-project",
      VERTEX_LOCATION: "global",
      VERTEX_API_BASE_URL: vertexUrl,
      VERTEX_ACCESS_TOKEN: "test-vertex-token",
      VERTEX_SAFETY_THRESHOLD: "BLOCK_NONE",
      VOICE_PROVIDER: "loopback",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  server.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  await waitForHttp(`http://127.0.0.1:${port}/health`, 4000, () => output);
  return server;
}

async function startFakeVertex() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    let json = {};
    try {
      json = JSON.parse(body || "{}");
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "bad json" }));
      return;
    }
    requests.push({
      method: request.method,
      path: request.url,
      headers: request.headers,
      body: json,
    });
    const functionDeclarations = json.tools?.[0]?.functionDeclarations || [];
    if (functionDeclarations.some((tool) => tool.name === "context_management")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        candidates: [{
          finishReason: "STOP",
          content: { parts: [{ functionCall: { name: "context_management", args: { action: "continue" } } }] },
        }],
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      candidates: [{
        finishReason: "STOP",
        content: {
          parts: [{
            text: "For home office deductions, track exclusive business use, square footage, and eligible expenses.",
          }],
        },
      }],
    }));
  });
  await listen(server, "127.0.0.1", 0);
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  }).then(async (response) => ({
    status: response.status,
    json: await response.json(),
  }));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function waitForHttp(url, timeoutMs, output) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // Retry until timeout.
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`gateway did not become ready. Output:\n${output()}`));
        return;
      }
      setTimeout(tick, 80);
    };
    tick();
  });
}

function onceExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
