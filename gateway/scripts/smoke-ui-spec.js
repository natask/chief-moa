#!/usr/bin/env node
"use strict";

// Smoke for the engine-served declarative UI spec (tier A of the thin-client
// architecture). Proves the round-trip the thin client depends on:
//
//   1. Store: a fresh store returns the default spec; replace() persists a valid
//      spec; an invalid spec is rejected (the surface is never blanked); a new
//      store over the same dir sees the persisted spec; reset() returns default.
//   2. HTTP round-trip (task 4.1): GET /v1/ui/spec requires a token; PUT a
//      changed spec, and a follow-up GET reflects it -- a "deployment" travels
//      engine -> client with no extension code change. An invalid PUT returns
//      400 and leaves the live spec unchanged.
//
// Boots `node server.js` on a throwaway port + token + DATA_DIR so the real
// .env is never loaded.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "ui-spec-smoke-token";
const { createUiSpecStore, defaultSpec, normalizeSpec } = require(path.join(GATEWAY_DIR, "lib", "ui-spec"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-ui-spec-smoke-"));
  const storeDir = path.join(tempDir, "store");
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    await step("store: default, replace, reject, persist, reset", () => assertStore(storeDir));
    await step("store primitive: distinct directories remain isolated", () => assertDirectoryIsolation(path.join(tempDir, "accounts")));
    await step("normalizer: document fanout is bounded", assertDocumentBounds);

    fs.mkdirSync(dataDir, { recursive: true });
    const legacy = defaultSpec();
    legacy.surfaces[0].title = "Legacy single-token owner";
    fs.writeFileSync(path.join(dataDir, "ui-spec.json"), JSON.stringify(legacy));
    server = await startGateway({ port, dataDir });
    await step("GET requires a token", () => assertAuthRequired(baseUrl));
    await step("legacy single-token file is consumed once by token-derived owner", async () => {
      const payload = await getJson(`${baseUrl}/v1/ui/spec`);
      assert.equal(payload.spec.surfaces[0].title, "Legacy single-token owner");
      assert.equal(fs.existsSync(path.join(dataDir, "ui-spec.json")), false, "legacy file must be consumed");
      const accountDirs = fs.readdirSync(path.join(dataDir, "ui-specs"));
      assert.equal(accountDirs.length, 1, "exactly one token-derived owner directory must be created");
      assert.equal(fs.existsSync(path.join(dataDir, "ui-specs", accountDirs[0], "ui-spec.json")), true);
      await assertReset(baseUrl);
    });
    await step("default spec is served", () => assertDefaultSpec(baseUrl));
    await step("round-trip: PUT then GET reflects it", () => assertRoundTrip(baseUrl));
    await step("invalid PUT is 400 and leaves spec unchanged", () => assertInvalidRejected(baseUrl));
    await step("reset returns the default", () => assertReset(baseUrl));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      checks: [
        "store: default spec, replace persists, invalid rejected, reload sees persisted, reset clears",
        "GET /v1/ui/spec requires a token",
        "legacy single-token spec is consumed once into the configured token-derived owner",
        "GET returns the default command-panel spec when uncustomized",
        "PUT a changed spec; GET reflects it for the configured single-token account scope",
        "store primitive keeps explicitly distinct directories isolated (not a multi-identity route claim)",
        "invalid spec PUT -> 400; the live spec is left unchanged (never blanked)",
        "POST /v1/ui/spec/reset returns to the default spec",
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
  const store = createUiSpecStore({ dataDir: dir });
  assert.equal(store.isCustomized(), false, "fresh store must be uncustomized");
  assert.equal(store.effective().surfaces[0].id, "command-panel", "default spec must carry the command panel");

  const custom = {
    surfaces: [
      {
        id: "command-panel",
        title: "my Aggie",
        components: [
          { type: "card", id: "brief", title: "Next step", body: "Open the browser agent panel.", tone: "info" },
          { type: "stat", id: "runs", label: "Runs", value: "2", delta: "+1", tone: "good" },
          { type: "list", id: "apps", title: "Apps", items: [{ label: "Maps", detail: "Open a map workflow", action: "agent.run", prompt: "Open Maps" }] },
          {
            type: "map",
            id: "nearby",
            title: "Nearby",
            center: { lat: 37.7749, lng: -122.4194, label: "San Francisco" },
            zoom: 11,
            markers: [{ lat: 37.7749, lng: -122.4194, label: "SF", detail: "Center" }],
          },
        ],
        controls: [{ type: "button", id: "go", label: "Go", action: "agent.run", prompt: "Open the app manager" }],
      },
    ],
  };
  const replaced = store.replace(custom);
  assert.equal(replaced.surfaces[0].title, "my Aggie", "replace must persist the new title");
  assert.equal(replaced.surfaces[0].components.length, 4, "replace must persist known components");
  assert.equal(replaced.surfaces[0].components.find((component) => component.type === "map").markers[0].label, "SF", "map markers must survive normalization");
  assert.equal(replaced.surfaces[0].controls[0].prompt, "Open the app manager", "control prompts must survive normalization");
  assert.equal(store.isCustomized(), true, "store must report customized after replace");

  // Invalid: not a renderable document -> throws, surface stays customized.
  assert.throws(() => store.replace({ surfaces: [] }), /invalid ui spec/, "empty surfaces must be rejected");
  assert.throws(() => store.replace({ nope: true }), /invalid ui spec/, "missing surfaces must be rejected");
  assert.equal(store.effective().surfaces[0].title, "my Aggie", "rejected replace must leave the spec unchanged");

  // A new store over the same dir sees the persisted spec.
  const reopened = createUiSpecStore({ dataDir: dir });
  assert.equal(reopened.effective().surfaces[0].title, "my Aggie", "reopened store must see the persisted spec");

  reopened.reset();
  assert.equal(reopened.isCustomized(), false, "reset must clear customization");
  assert.deepEqual(reopened.effective(), defaultSpec(), "reset must return the default spec");
}

function assertDirectoryIsolation(rootDir) {
  const first = createUiSpecStore({ dataDir: path.join(rootDir, "usr_first") });
  const second = createUiSpecStore({ dataDir: path.join(rootDir, "usr_second") });
  const firstSpec = defaultSpec();
  firstSpec.surfaces[0].title = "First account";
  const secondSpec = defaultSpec();
  secondSpec.surfaces[0].title = "Second account";

  first.replace(firstSpec);
  second.replace(secondSpec);

  assert.equal(first.effective().surfaces[0].title, "First account");
  assert.equal(second.effective().surfaces[0].title, "Second account");
  first.reset();
  assert.equal(second.effective().surfaces[0].title, "Second account", "resetting one account must not alter another");
}

function assertDocumentBounds() {
  const surfaces = Array.from({ length: 20 }, (_, surfaceIndex) => ({
    id: `surface-${surfaceIndex}`,
    components: Array.from({ length: 100 }, (_, index) => ({ type: "card", id: `card-${index}`, body: "bounded" })),
    controls: Array.from({ length: 100 }, (_, index) => ({ type: "button", id: `button-${index}`, action: "noop" })),
  }));
  const normalized = normalizeSpec({ surfaces });
  assert.equal(normalized.surfaces.length, 8);
  assert.equal(normalized.surfaces[0].components.length, 40);
  assert.equal(normalized.surfaces[0].controls.length, 24);
}

async function assertAuthRequired(baseUrl) {
  const unauth = await requestJson(`${baseUrl}/v1/ui/spec`, { auth: false });
  assert.equal(unauth.status, 401, "GET /v1/ui/spec must require a token");
}

async function assertDefaultSpec(baseUrl) {
  const payload = await getJson(`${baseUrl}/v1/ui/spec`);
  assert.equal(payload.is_customized, false, "fresh gateway must report is_customized=false");
  assert.equal(payload.spec.surfaces[0].id, "command-panel", "default spec must carry the command panel");
}

async function assertRoundTrip(baseUrl) {
  const spec = {
    surfaces: [
      {
        id: "command-panel",
        title: "Aggie — deployed",
        components: [
          { type: "card", id: "status", title: "Live UI", body: "Rendered by the extension from gateway data.", tone: "info" },
          { type: "list", id: "targets", title: "Targets", items: [{ label: "Calendar", detail: "Open an app workflow", action: "agent.run", prompt: "Open Calendar" }] },
          {
            type: "map",
            id: "meetup",
            title: "Meetup map",
            center: { lat: 40.7128, lng: -74.006, label: "NYC" },
            markers: [{ lat: 40.7128, lng: -74.006, label: "Meet here" }],
          },
        ],
        controls: [
          { type: "button", id: "talk", label: "Speak", action: "voice.toggle", prompt: "Start voice" },
          { type: "text", id: "intent", label: "Do this:", action: "agent.run" },
        ],
      },
    ],
  };
  const put = await putJson(`${baseUrl}/v1/ui/spec`, { spec });
  assert.equal(put.status, 200, `PUT must succeed: ${JSON.stringify(put.json)}`);
  assert.equal(put.json.is_customized, true, "PUT response must report is_customized=true");

  const after = await getJson(`${baseUrl}/v1/ui/spec`);
  assert.equal(after.spec.surfaces[0].title, "Aggie — deployed", "GET must reflect the deployed title");
  assert.equal(after.spec.surfaces[0].controls[0].label, "Speak", "GET must reflect the deployed control label");
  assert.equal(after.spec.surfaces[0].controls[0].prompt, "Start voice", "GET must reflect bounded control prompts");
  assert.equal(after.spec.surfaces[0].components.length, 3, "GET must reflect deployed known components");
  assert.equal(after.spec.surfaces[0].components.find((component) => component.type === "map").markers[0].label, "Meet here", "GET must reflect deployed map markers");
}

async function assertInvalidRejected(baseUrl) {
  const before = await getJson(`${baseUrl}/v1/ui/spec`);
  const put = await putJson(`${baseUrl}/v1/ui/spec`, { spec: { surfaces: [] } });
  assert.equal(put.status, 400, "invalid spec must return 400");

  const after = await getJson(`${baseUrl}/v1/ui/spec`);
  assert.deepEqual(after.spec, before.spec, "an invalid PUT must leave the live spec unchanged");
}

async function assertReset(baseUrl) {
  const reset = await fetch(`${baseUrl}/v1/ui/spec/reset`, { method: "POST", headers: authHeaders() });
  assert.equal(reset.status, 200, "reset must return 200");
  const after = await getJson(`${baseUrl}/v1/ui/spec`);
  assert.equal(after.is_customized, false, "after reset is_customized must be false");
  assert.equal(after.spec.surfaces[0].title, "A.G.", "after reset the default title returns");
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
    MODEL_ID: "ui-spec-smoke-model",
    MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GEMINI_API_KEY: "",
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

async function putJson(url, body, options = {}) {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      ...(options.auth === false ? {} : authHeaders()),
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
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
