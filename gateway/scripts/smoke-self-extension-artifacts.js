#!/usr/bin/env node
"use strict";

// Smoke for the self-extension artifact gateway slice. Boots the real gateway
// with a throwaway DATA_DIR and token so the user's live service and .env are
// untouched.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "self-extension-smoke-token";
const { createSelfExtensionArtifactStore } = require(path.join(GATEWAY_DIR, "lib", "self-extension-artifacts"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-self-extension-smoke-"));
  const storeDir = path.join(tempDir, "store");
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    await step("store: create, apply, reload, corrupt fallback", () => assertStore(storeDir));

    server = await startGateway({ port, dataDir });
    await step("GET artifacts requires auth", () => assertAuthRequired(baseUrl));
    await step("invalid avatar behavior is rejected", () => assertInvalidRejected(baseUrl));
    const created = await step("create two avatar behavior variants", () => assertCreateVariants(baseUrl));
    await step("apply one variant and fetch runtime", () => assertApplyAndRuntime(baseUrl, created.second.artifact.id));
    await step("create/apply mirrored to product events", () => assertMirroredEvents(baseUrl, created.second.artifact.id));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      checks: [
        "store creates candidates, applies active pointer, reloads active state, and falls back on corrupt persistence",
        "GET /v1/self-extension/artifacts requires authorizedAgent token",
        "invalid avatar_behavior spec returns 400",
        "POST creates two avatar_behavior variants",
        "POST /v1/self-extension/artifacts/:id/apply activates one variant",
        "GET /v1/self-extension/runtime includes active avatar_behavior",
        "create/apply actions mirror into product events",
      ],
    }, null, 2));
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

function assertStore(dir) {
  const store = createSelfExtensionArtifactStore({ dataDir: dir });
  const first = store.createCandidate({
    type: "avatar_behavior",
    title: "Thinking orbit",
    prompt: "Make Aggie orbit while thinking",
    spec: {
      trigger: "thinking",
      motion: "orbit",
      intensity: "subtle",
      duration: "while_active",
    },
  });
  const second = store.createCandidate({
    type: "avatar_behavior",
    title: "Listening glow",
    variant_group_id: first.variant_group_id,
    parent_id: first.id,
    spec: {
      trigger: "listening",
      motion: "glow",
      intensity: "normal",
      duration: "while_active",
    },
  });
  assert.equal(store.list({ type: "avatar_behavior" }).length, 2, "store must list both variants");
  const applied = store.apply(second.id);
  assert.equal(applied.status, "applied", "apply must mark the artifact applied");
  assert.equal(store.runtime().active.avatar_behavior.artifact_id, second.id, "runtime must expose the active artifact");

  const reopened = createSelfExtensionArtifactStore({ dataDir: dir });
  assert.equal(reopened.runtime().active.avatar_behavior.artifact_id, second.id, "reopened store must preserve active state");

  fs.writeFileSync(reopened.storePath, "{not json");
  const fallback = createSelfExtensionArtifactStore({ dataDir: dir });
  assert.deepEqual(fallback.list(), [], "corrupt persistence must fall back to an empty safe store");
  assert.equal(fallback.runtime().active.avatar_behavior, null, "corrupt persistence must not expose stale active behavior");
}

async function assertAuthRequired(baseUrl) {
  const response = await requestJson(`${baseUrl}/v1/self-extension/artifacts`, { auth: false });
  assert.equal(response.status, 401, "artifacts list must require auth");
}

async function assertInvalidRejected(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/self-extension/artifacts`, {
    type: "avatar_behavior",
    title: "Bad behavior",
    spec: {
      trigger: "thinking",
      motion: "teleport",
      intensity: "wild",
      duration: "forever",
    },
  });
  assert.equal(response.status, 400, `invalid spec must return 400: ${JSON.stringify(response.json)}`);

  const list = await getJson(`${baseUrl}/v1/self-extension/artifacts`);
  assert.equal(list.artifacts.length, 0, "rejected invalid spec must not create an artifact");
}

async function assertCreateVariants(baseUrl) {
  const first = await postJson(`${baseUrl}/v1/self-extension/artifacts`, {
    type: "avatar_behavior",
    title: "Thinking orbit",
    prompt: "Make Aggie orbit while thinking",
    spec: {
      trigger: "thinking",
      motion: "orbit",
      intensity: "subtle",
      duration: "while_active",
    },
  });
  assert.equal(first.status, 201, `first create must return 201: ${JSON.stringify(first.json)}`);
  assert.equal(first.json.artifact.type, "avatar_behavior");
  assert.equal(first.json.artifact.validation.ok, true);

  const second = await postJson(`${baseUrl}/v1/self-extension/artifacts`, {
    type: "avatar_behavior",
    title: "Busy pulse",
    variant_group_id: first.json.artifact.variant_group_id,
    parent_id: first.json.artifact.id,
    spec: {
      trigger: "busy",
      motion: "pulse",
      intensity: "strong",
      duration: "while_active",
    },
  });
  assert.equal(second.status, 201, `second create must return 201: ${JSON.stringify(second.json)}`);
  assert.equal(second.json.artifact.parent_id, first.json.artifact.id);

  const list = await getJson(`${baseUrl}/v1/self-extension/artifacts?type=avatar_behavior`);
  assert.equal(list.artifacts.length, 2, "artifact list must include both variants");
  assert.ok(list.known.avatar_behavior.motions.includes("orbit"), "known vocabulary must include avatar motions");
  return { first: first.json, second: second.json };
}

async function assertApplyAndRuntime(baseUrl, artifactId) {
  const applied = await postJson(`${baseUrl}/v1/self-extension/artifacts/${encodeURIComponent(artifactId)}/apply`, {});
  assert.equal(applied.status, 200, `apply must return 200: ${JSON.stringify(applied.json)}`);
  assert.equal(applied.json.artifact.id, artifactId, "apply response must return the applied artifact");
  assert.equal(applied.json.artifact.status, "applied", "artifact must be marked applied");
  assert.equal(applied.json.runtime.active.avatar_behavior.artifact_id, artifactId, "apply response runtime must include active avatar behavior");

  const runtime = await getJson(`${baseUrl}/v1/self-extension/runtime`);
  assert.equal(runtime.runtime.active.avatar_behavior.artifact_id, artifactId, "runtime endpoint must include active avatar behavior");
  assert.deepEqual(runtime.runtime.active.avatar_behavior.spec, {
    trigger: "busy",
    motion: "pulse",
    intensity: "strong",
    duration: "while_active",
  });
}

async function assertMirroredEvents(baseUrl, appliedArtifactId) {
  const created = await waitForEvents(baseUrl, "self_extension.artifact.created", 2);
  assert.ok(created.events.length >= 2, "create actions must be mirrored to product events");

  const applied = await waitForEvents(baseUrl, "self_extension.artifact.applied", 1);
  assert.ok(
    applied.events.some((event) => event.payload?.id === appliedArtifactId),
    "apply action must be mirrored with the applied artifact id",
  );
}

async function waitForEvents(baseUrl, eventType, minCount) {
  const deadline = Date.now() + 2000;
  let last = null;
  while (Date.now() < deadline) {
    last = await getJson(`${baseUrl}/v1/events?event_type=${encodeURIComponent(eventType)}&limit=10`);
    if (last.events.length >= minCount) return last;
    await sleep(50);
  }
  return last;
}

async function startGateway({ port, dataDir }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: gatewayEnv({ port, dataDir }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

function gatewayEnv({ port, dataDir }) {
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
    MODEL_ID: "self-extension-smoke-model",
    MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GEMINI_API_KEY: "",
    DATABASE_URL: "",
  };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Server may still be starting.
    }
    if (logs.exited) {
      throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

async function getJson(url, options) {
  const response = await requestJson(url, options);
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { headers: options.auth === false ? {} : authHeaders() });
  const json = await response.json();
  return { status: response.status, json };
}

async function postJson(url, body, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...(options.auth === false ? {} : authHeaders()),
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body || {}),
  });
  const json = await response.json();
  return { status: response.status, json };
}

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}` };
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
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (output.length > 12000) output = output.slice(-12000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", () => {
    logs.exited = true;
  });
  const logs = {
    exited: false,
    text: () => output,
  };
  return logs;
}

async function onceExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
