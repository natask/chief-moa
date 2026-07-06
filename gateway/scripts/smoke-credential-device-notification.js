#!/usr/bin/env node
"use strict";

// Smoke for the credential-autopilot device-notification bridge and panel
// (reference/openspec/changes/remote-hosted-gateway/account-connection-policy.md,
// ARCHITECTURE.md "Account Connection And Credential Health").
//
// This proves the load-bearing new behavior: when a connection enters
// needs_user_action, the gateway does not just record an internal notification;
// it bridges that notification onto the cross-device tool hub
// (/v1/tool/requests) so a registered device actually learns it must
// reauthorize, links the two by tool_request_id, and lets the device claim and
// receipt it. Everything runs against the deterministic fixture provider: no
// network, no real credential.
//
// Paths covered:
//   A. explicit refresh failure -> action_required -> device tool request
//      -> device claim -> device receipt
//   B. periodic health pass on a near-expiry, refresh-failing connection
//      -> action_required -> device tool request (the autonomous loop)
//   C. no device target -> needs_user_action true but NO tool request queued
//      (skipped, so devices are never spammed with untargeted work)
//   D. the gateway serves the read-and-fix credential panel at /credentials
//   E. no plaintext credential material leaks onto disk or into tool requests

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "credential-notify-smoke-token";
const DEVICE_ID = "android_primary";
const NOTIFY_TOOL = "notification.account_connection";
const NON_SECRET_INPUT_KEYS = ["connection_id", "connection_label", "provider_label", "reason", "reauth_endpoint"];

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const checks = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-credential-notify-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  try {
    server = await startGateway({ port, dataDir });
    await step(checks, "panel: gateway serves the credential panel at /credentials", () => assertPanelServed(baseUrl));
    await step(checks, "device: register a notification-capable device client", () => registerDevice(baseUrl));
    await step(checks, "A: refresh failure -> device tool request -> claim -> receipt", () => assertRefreshFailureBridge(baseUrl));
    await step(checks, "B: health pass on near-expiry bad-refresh -> device tool request", () => assertHealthLoopBridge(baseUrl));
    await step(checks, "C: no device target -> needs_user_action but no tool request", () => assertNoTargetSkips(baseUrl));
    await step(checks, "E: no plaintext credential material on disk or in tool requests", () => assertNoSecretLeak(baseUrl, dataDir));
    console.log(JSON.stringify({ ok: true, base_url: baseUrl, checks }, null, 2));
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// --- checks --------------------------------------------------------------------

async function assertPanelServed(baseUrl) {
  // The panel shell loads without a token (the browser supplies it after load),
  // mirroring the gateway-ui surface.
  const response = await fetch(`${baseUrl}/credentials`);
  assert.equal(response.status, 200, "panel must be served at /credentials");
  const html = await response.text();
  assert.ok(/text\/html/.test(response.headers.get("content-type") || ""), "panel must be html");
  assert.ok(html.includes("Credential autopilot"), "panel must render the credential-autopilot surface");
  assert.ok(html.includes("/v1/account-connections"), "panel must read the account-connections API");
  const alias = await fetch(`${baseUrl}/credential-panel`);
  assert.equal(alias.status, 200, "the /credential-panel alias must also serve the panel");
}

async function registerDevice(baseUrl) {
  const res = await postJson(`${baseUrl}/v1/device-clients/heartbeat`, {
    device_id: DEVICE_ID,
    surface_type: "android",
    local_tool_manifest: [{ tool: NOTIFY_TOOL }],
  });
  assert.equal(res.status, 200, `device heartbeat must succeed: ${JSON.stringify(res.json)}`);
  assert.equal(res.json.device.device_id, DEVICE_ID);
  const supported = res.json.device.local_tool_manifest.map((item) => item.tool);
  assert.ok(supported.includes(NOTIFY_TOOL), "device must advertise the notification tool");
}

async function assertRefreshFailureBridge(baseUrl) {
  const connection = await connectFixture(baseUrl, { label: "Refresh-fail fixture", code: "fixture-grant-badrefresh:a", target: true });

  const refresh = await postJson(`${baseUrl}/v1/account-connections/${connection.id}/refresh`, {});
  assert.equal(refresh.status, 202, `refresh attempt is accepted even on provider rejection: ${JSON.stringify(refresh.json)}`);
  assert.equal(refresh.json.connection.status, "action_required", "failed refresh must move to action_required");
  assert.equal(refresh.json.connection.needs_user_action, true, "failed refresh must flag the user");

  // The failure must have created an internal notification linked to a bridged
  // device-hub tool request. (The /v1/tool/requests list omits input, so the
  // link is the account notification's tool_request_id.)
  const { notification, request } = await bridgedRequest(baseUrl, connection.id);
  assert.ok(notification, "failed refresh must create an account notification");
  assert.ok(notification.tool_request_id, "notification must link to a bridged tool request");
  assert.deepEqual(Object.keys(notification.input).sort(), [...NON_SECRET_INPUT_KEYS].sort(), "notification input must carry only non-secret fields");
  assert.equal(notification.input.connection_id, connection.id);
  assert.ok(notification.input.reauth_endpoint.endsWith(`/v1/account-connections/${connection.id}/reauth`));

  assert.ok(request, "the linked tool request must exist on the device hub");
  assert.equal(request.tool, NOTIFY_TOOL, "tool request must use the account-connection notification tool");
  assert.equal(request.target_device_id, DEVICE_ID, "tool request must target the notification device");
  assert.equal(request.status, "pending", "the bridged tool request must be pending for the device");

  // The device claims the request through the normal tool-hub claim path; the
  // claim response is where the device receives the (non-secret) input.
  const claim = await postJson(`${baseUrl}/v1/tool/requests/claim`, { device_id: DEVICE_ID });
  assert.equal(claim.status, 200, `device must be able to claim the notification: ${JSON.stringify(claim.json)}`);
  assert.equal(claim.json.request.id, request.id, "the claimed request must be the credential notification");
  assert.equal(claim.json.request.status, "claimed");
  assert.deepEqual(Object.keys(claim.json.request.input).sort(), [...NON_SECRET_INPUT_KEYS].sort(), "claimed input must carry only non-secret fields");
  assert.ok(!JSON.stringify(claim.json).includes("fixture-refresh-"), "claim leaked a refresh token");
  assert.ok(!JSON.stringify(claim.json).includes("fixture-access-"), "claim leaked an access token");

  // The device receipts it after displaying it to the user.
  const receipt = await postJson(`${baseUrl}/v1/tool/requests/${request.id}/receipts`, {
    device_id: DEVICE_ID,
    ok: true,
    summary: "shown credential-health reauth prompt",
  });
  assert.equal(receipt.status, 200, `receipt must be accepted: ${JSON.stringify(receipt.json)}`);
  assert.equal(receipt.json.request.status, "completed", "receipt must complete the tool request");
}

async function assertHealthLoopBridge(baseUrl) {
  // A near-expiry connection whose refresh always fails: the autonomous health
  // pass (not an explicit user refresh) must flag the user and ping the device.
  const connection = await connectFixture(baseUrl, { label: "Health-loop fixture", code: "fixture-grant-shortbad:b", target: true });
  assert.ok(Date.parse(connection.expires_at) - Date.now() < 5 * 60 * 1000, "fixture short-bad grant must be near expiry");

  const run = await postJson(`${baseUrl}/v1/account-connections/health/run`, {});
  assert.equal(run.status, 200, JSON.stringify(run.json));
  assert.ok(run.json.summary.refresh_failed >= 1, `health pass must record a failed refresh: ${JSON.stringify(run.json.summary)}`);

  const after = (await getJson(`${baseUrl}/v1/account-connections/${connection.id}`)).connection;
  assert.equal(after.status, "action_required", "health-loop refresh failure must move to action_required");
  assert.equal(after.needs_user_action, true, "health-loop failure must flag the user");

  const { notification, request } = await bridgedRequest(baseUrl, connection.id);
  assert.ok(notification, "the health pass must create an account notification for the failing connection");
  assert.ok(notification.tool_request_id, "the health-pass notification must link to a bridged tool request");
  assert.ok(request, "the health pass must bridge a device tool request for the failing connection");
  assert.equal(request.tool, NOTIFY_TOOL);
  assert.equal(request.target_device_id, DEVICE_ID);
}

async function assertNoTargetSkips(baseUrl) {
  // No device_notification_target: the connection still needs the user, but the
  // gateway must not queue an untargeted tool request onto the hub.
  const connection = await connectFixture(baseUrl, { label: "No-target fixture", code: "fixture-grant-badrefresh:c", target: false });
  const refresh = await postJson(`${baseUrl}/v1/account-connections/${connection.id}/refresh`, {});
  assert.equal(refresh.status, 202);
  assert.equal(refresh.json.connection.needs_user_action, true, "connection still needs the user without a device target");

  // Without a target, the bridge cannot fire: no internal notification and no
  // tool request are created for this connection.
  const notification = await findAccountNotificationForConnection(baseUrl, connection.id);
  assert.equal(notification, undefined, "a connection with no device target must not create an internal notification");
  const { request } = await bridgedRequest(baseUrl, connection.id);
  assert.equal(request, null, "a connection with no device target must not queue a tool request");
}

async function assertNoSecretLeak(baseUrl, dataDir) {
  const markers = ["fixture-refresh-", "fixture-access-"];
  // Tool-request records and their product events must be secret-free.
  const requests = (await getJson(`${baseUrl}/v1/tool/requests?limit=100`)).requests;
  const requestsRaw = JSON.stringify(requests);
  for (const marker of markers) {
    assert.ok(!requestsRaw.includes(marker), `tool request listing leaked ${marker}`);
  }
  // On-disk sweep: only the encrypted credentials file may reference secrets,
  // and only as ciphertext that cannot contain the plaintext marker.
  const offenders = [];
  walk(dataDir, (filePath) => {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const marker of markers) {
      if (raw.includes(marker)) offenders.push(`${filePath}: ${marker}`);
    }
  });
  assert.deepEqual(offenders, [], `plaintext credential material found on disk:\n${offenders.join("\n")}`);
}

// --- helpers -------------------------------------------------------------------

// Drive the fixture OAuth connect loop and return the connected connection.
async function connectFixture(baseUrl, { label, code, target }) {
  const body = {
    provider: "fixture",
    label,
    credential_kind: "oauth2_authorization_code",
  };
  if (target) {
    body.device_notification_target = { device_id: DEVICE_ID, surface_type: "android", channel: "credential_health", enabled: true };
  }
  const create = await postJson(`${baseUrl}/v1/account-connections`, body);
  assert.equal(create.status, 202, `create must return 202: ${JSON.stringify(create.json)}`);
  const startUrl = create.json.reauth_action.url;
  const start = await fetch(startUrl, { redirect: "manual" });
  assert.equal(start.status, 302, "oauth start must redirect to the callback");
  const callbackUrl = new URL(start.headers.get("location"));
  callbackUrl.searchParams.set("code", code);
  const callback = await fetch(callbackUrl);
  assert.equal(callback.status, 200, `callback must succeed: ${await callback.text()}`);
  const connection = (await getJson(`${baseUrl}/v1/account-connections/${create.json.connection.id}`)).connection;
  assert.equal(connection.status, "connected", "fixture connection must be connected before the failure path");
  return connection;
}

async function findAccountNotificationForConnection(baseUrl, connectionId) {
  const { notifications } = await getJson(`${baseUrl}/v1/account-connections/notifications`);
  return notifications.find((notification) => notification.connection_id === connectionId);
}

// Resolve the account notification for a connection and the device-hub tool
// request it bridged to (matched by tool_request_id, since the tool-request
// list summary omits input).
async function bridgedRequest(baseUrl, connectionId) {
  const notification = await findAccountNotificationForConnection(baseUrl, connectionId);
  if (!notification || !notification.tool_request_id) {
    return { notification: notification || null, request: null };
  }
  const { requests } = await getJson(`${baseUrl}/v1/tool/requests?limit=100`);
  const request = requests.find((req) => req.id === notification.tool_request_id) || null;
  return { notification, request };
}

// --- harness -------------------------------------------------------------------

async function step(checks, name, fn) {
  try {
    const result = await fn();
    checks.push(name);
    return result;
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

async function startGateway({ port, dataDir }) {
  const baseUrl = `http://127.0.0.1:${port}`;
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
      MODEL_PROVIDER: "openai-compatible",
      MODEL_API_KEY: "",
      OPENAI_API_KEY: "",
      GOOGLE_API_KEY: "",
      GEMINI_API_KEY: "",
      ACCOUNT_FIXTURE_PROVIDER: "1",
      // Drive the health pass explicitly; no background interval races the smoke.
      ACCOUNT_HEALTH_INTERVAL_MS: "0",
      PUBLIC_BASE_URL: baseUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // starting up
    }
    if (logs.exited) {
      throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

async function getJson(url) {
  const result = await requestJson(url);
  assert.ok(result.status >= 200 && result.status < 300, `${url} returned ${result.status}: ${JSON.stringify(result.json)}`);
  return result.json;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { headers: options.auth === false ? {} : authHeaders() });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}` };
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, visit);
    } else if (entry.isFile()) {
      visit(fullPath);
    }
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const p = server.address().port;
      server.close(() => resolve(p));
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
  const logs = { exited: false, text: () => output };
  child.on("exit", () => { logs.exited = true; });
  return logs;
}

async function onceExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => child.kill("SIGKILL")),
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
