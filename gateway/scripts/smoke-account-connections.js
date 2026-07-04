#!/usr/bin/env node
"use strict";

// Smoke for account connections + credential health
// (reference/openspec/changes/remote-hosted-gateway/account-connection-policy.md).
//
// Part 1 drives the store directly (temp DATA_DIR): user scoping, multiple
// connections per provider, encrypted credentials at rest, serializer secrecy.
//
// Part 2 boots `node server.js` on a throwaway port + token + DATA_DIR with the
// deterministic fixture provider enabled and exercises the API surface:
// catalog, create, OAuth start/callback, gateway secret form, list/detail,
// PATCH label + rejected secret fields, explicit refresh (supported,
// unsupported 409, failed), the health-check pass, reauth actions, queued +
// receipted device notifications, disable/re-enable, and disconnect.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const { createAccountConnectionStore } = require(path.join(GATEWAY_DIR, "lib", "account-connections"));
const TOKEN = "account-connections-smoke-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const checks = [];
  await step(checks, "store: user scoping + multi-connection + encryption at rest", storeLevelChecks);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-account-connections-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  try {
    server = await startGateway({ port, dataDir });
    await step(checks, "api: auth required", () => assertAuthRequired(baseUrl));
    await step(checks, "api: provider catalog", () => assertCatalog(baseUrl));
    const oauth = await step(checks, "api: oauth connect round trip", () => assertOauthConnect(baseUrl));
    await step(checks, "api: second connection same provider", () => assertSecondConnection(baseUrl, oauth.id));
    await step(checks, "api: secret form connect (api_key)", () => assertSecretFormConnect(baseUrl));
    await step(checks, "api: patch label + reject secret fields", () => assertPatch(baseUrl, oauth.id));
    await step(checks, "api: refresh supported succeeds", () => assertRefreshSucceeds(baseUrl, oauth.id));
    await step(checks, "api: refresh unsupported returns 409 + user action", () => assertRefreshUnsupported(baseUrl));
    await step(checks, "api: failed refresh moves to action_required + notification", () => assertFailedRefresh(baseUrl));
    await step(checks, "api: health run refreshes near-expiry connection", () => assertHealthRun(baseUrl));
    await step(checks, "api: reauth completes and clears user action", () => assertReauthFlow(baseUrl));
    await step(checks, "api: disable / re-enable / disconnect", () => assertDisableDisconnect(baseUrl, oauth.id));
    await step(checks, "storage: no plaintext secret on disk outside credential boundary", () => assertNoPlaintextSecrets(dataDir));
    console.log(JSON.stringify({ ok: true, base_url: baseUrl, checks }, null, 2));
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// --- part 1: store-level ------------------------------------------------------

async function storeLevelChecks() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-account-store-smoke-"));
  try {
    const store = createAccountConnectionStore({
      dataDir: tempDir,
      env: { ACCOUNT_FIXTURE_PROVIDER: "1" },
      publicBaseUrl: "http://gateway.test",
    });

    // Two same-provider connections for one user, different subjects.
    const first = store.create("usr_a", { provider: "fixture", label: "Work fixture", credential_kind: "oauth2_authorization_code" });
    const second = store.create("usr_a", { provider: "fixture", label: "Personal fixture", credential_kind: "oauth2_authorization_code" });
    assert.equal(first.statusCode, 202);
    assert.equal(first.reauth_action.type, "open_url");
    await completeOauthViaStore(store, first, "fixture-grant-ok:work");
    await completeOauthViaStore(store, second, "fixture-grant-ok:personal");

    const mine = store.list("usr_a");
    assert.equal(mine.length, 2, "one user must hold two same-provider connections");
    assert.ok(mine.every((connection) => connection.provider === "fixture"));
    assert.ok(mine.every((connection) => connection.status === "connected"));
    assert.ok(mine.every((connection) => connection.credential_ref_kind === "encrypted_server_secret"));
    const labels = mine.map((connection) => connection.label).sort();
    assert.deepEqual(labels, ["Personal fixture", "Work fixture"]);

    // Serialized payloads never contain credential material.
    const serialized = JSON.stringify(mine) + JSON.stringify(store.get("usr_a", first.connection.id));
    assert.ok(!serialized.includes("fixture-access-"), "serialized connection leaked an access token");
    assert.ok(!serialized.includes("fixture-refresh-"), "serialized connection leaked a refresh token");

    // User scoping: another user sees nothing and cannot read/refresh/patch.
    assert.equal(store.list("usr_b").length, 0, "second user must not see first user's connections");
    assert.throws(() => store.get("usr_b", first.connection.id), /not found/);
    assert.throws(() => store.patch("usr_b", first.connection.id, { label: "stolen" }), /not found/);
    await assert.rejects(() => store.requestRefresh("usr_b", first.connection.id), /not found/);

    // Encryption at rest: the credentials file holds ciphertext, not tokens.
    const credentialsRaw = fs.readFileSync(path.join(tempDir, "account-connections", "credentials.json"), "utf8");
    assert.ok(!credentialsRaw.includes("fixture-access-"), "credentials file stored a plaintext access token");
    assert.ok(!credentialsRaw.includes("fixture-refresh-"), "credentials file stored a plaintext refresh token");
    assert.ok(credentialsRaw.includes('"algorithm": "aes-256-gcm"'), "credentials must be aes-256-gcm ciphertext");

    // Duplicate provider subject for the same user is rejected.
    const dup = store.create("usr_a", { provider: "fixture", label: "Dup fixture", credential_kind: "oauth2_authorization_code" });
    await assert.rejects(
      () => completeOauthViaStore(store, dup, "fixture-grant-ok:work"),
      /already connected/,
      "duplicate provider subject must be rejected"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function completeOauthViaStore(store, created, code) {
  const state = new URL(created.reauth_action.url).searchParams.get("state");
  return store.completeOauthCallback({ state, code, error: "" });
}

// --- part 2: api-level --------------------------------------------------------

async function assertAuthRequired(baseUrl) {
  const providers = await requestJson(`${baseUrl}/v1/account-providers`, { auth: false });
  assert.equal(providers.status, 401, "provider catalog must require the gateway token");
  const list = await requestJson(`${baseUrl}/v1/account-connections`, { auth: false });
  assert.equal(list.status, 401, "connection list must require the gateway token");
}

async function assertCatalog(baseUrl) {
  const { providers } = await getJson(`${baseUrl}/v1/account-providers`);
  assert.ok(Array.isArray(providers) && providers.length >= 2);
  const fixture = providers.find((provider) => provider.id === "fixture");
  assert.ok(fixture, "fixture provider must be in the catalog when enabled");
  for (const field of ["id", "label", "credential_kinds", "supports_refresh", "supports_manual_reauth", "supports_multiple_connections"]) {
    assert.ok(field in fixture, `catalog entry missing ${field}`);
  }
  const raw = JSON.stringify(providers);
  assert.ok(!raw.includes(TOKEN), "catalog must not expose env secrets");
}

async function assertOauthConnect(baseUrl, options = {}) {
  const create = await postJson(`${baseUrl}/v1/account-connections`, {
    provider: "fixture",
    label: options.label || "Work fixture",
    credential_kind: "oauth2_authorization_code",
    device_notification_target: options.target || { device_id: "android_primary", surface_type: "android", channel: "credential_health", enabled: true },
  });
  assert.equal(create.status, 202, `create must return 202: ${JSON.stringify(create.json)}`);
  assert.equal(create.json.connection.status, "pending_user_auth");
  assert.equal(create.json.reauth_action.type, "open_url");
  const startUrl = create.json.reauth_action.url;
  assert.ok(startUrl.includes("/v1/account-connections/oauth/start?state="), "action must point at the gateway oauth start");

  // Follow the fixture redirect loop: start 302s to the gateway callback.
  const start = await fetch(startUrl, { redirect: "manual" });
  assert.equal(start.status, 302, "oauth start must redirect");
  let callbackUrl = new URL(start.headers.get("location"));
  if (options.code) {
    callbackUrl.searchParams.set("code", options.code);
  }
  const callback = await fetch(callbackUrl);
  assert.equal(callback.status, 200, `callback must succeed: ${await callback.text()}`);

  const { connection } = await getJson(`${baseUrl}/v1/account-connections/${create.json.connection.id}`);
  assert.equal(connection.status, "connected");
  assert.equal(connection.credential_ref_kind, "encrypted_server_secret");
  assert.equal(connection.refresh.supported, true);
  assert.ok(connection.expires_at, "oauth connection must record expires_at");
  assert.ok(!JSON.stringify(connection).includes("fixture-refresh-"), "detail leaked a refresh token");
  const eventTypes = connection.recent_events.map((event) => event.type);
  for (const type of ["account.connection.created", "account.connection.auth.started", "account.connection.secret.stored", "account.connection.auth.completed", "account.connection.status.changed"]) {
    assert.ok(eventTypes.includes(type), `detail events missing ${type}: ${eventTypes.join(", ")}`);
  }
  return connection;
}

async function assertSecondConnection(baseUrl, firstId) {
  const second = await assertOauthConnect(baseUrl, { label: "Personal fixture", code: "fixture-grant-ok:personal" });
  assert.notEqual(second.id, firstId);
  const { connections } = await getJson(`${baseUrl}/v1/account-connections`);
  const fixtureConnections = connections.filter((connection) => connection.provider === "fixture");
  assert.ok(fixtureConnections.length >= 2, "user must hold multiple connections for one provider");
  const labels = fixtureConnections.map((connection) => connection.label);
  assert.ok(labels.includes("Work fixture") && labels.includes("Personal fixture"), `labels must distinguish connections: ${labels.join(", ")}`);
}

async function assertSecretFormConnect(baseUrl) {
  const create = await postJson(`${baseUrl}/v1/account-connections`, {
    provider: "openai",
    label: "OpenAI main",
    credential_kind: "api_key",
  });
  assert.equal(create.status, 202);
  assert.equal(create.json.reauth_action.type, "gateway_secret_form");
  const formUrl = create.json.reauth_action.url;

  // The form itself is served by the gateway (no bearer token; URL token auth).
  const form = await fetch(formUrl);
  assert.equal(form.status, 200);
  const formHtml = await form.text();
  assert.ok(formHtml.includes("OpenAI"), "secret form must show the provider label");

  // Posting the secret as a browser form does not echo it back.
  const token = new URL(formUrl).searchParams.get("token");
  const submit = await fetch(`${baseUrl}/v1/account-connections/secret-form`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, secret: "sk-fixture-plaintext-secret-1234567890", account_display: "nat@example.com" }).toString(),
  });
  assert.equal(submit.status, 200);
  const submitHtml = await submit.text();
  assert.ok(!submitHtml.includes("sk-fixture-plaintext-secret"), "form response echoed the secret");

  const { connection } = await getJson(`${baseUrl}/v1/account-connections/${create.json.connection.id}`);
  assert.equal(connection.status, "connected");
  assert.equal(connection.credential_kind, "api_key");
  assert.equal(connection.credential_ref_kind, "encrypted_server_secret");
  assert.equal(connection.account_subject.display, "nat@example.com");
  assert.ok(!JSON.stringify(connection).includes("sk-fixture-plaintext-secret"), "detail leaked the api key");

  // The used form token is single-use.
  const replay = await fetch(formUrl);
  assert.ok([404, 410].includes(replay.status), `used form token must be rejected, got ${replay.status}`);
  return connection;
}

async function assertPatch(baseUrl, connectionId) {
  const patched = await patchJson(`${baseUrl}/v1/account-connections/${connectionId}`, { label: "Work fixture (renamed)" });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.connection.label, "Work fixture (renamed)");

  const { connection } = await getJson(`${baseUrl}/v1/account-connections/${connectionId}`);
  assert.equal(connection.label, "Work fixture (renamed)", "label change must persist");

  for (const body of [{ api_key: "sk-x" }, { refresh_token: "r" }, { password: "p" }, { credential: { value: "v" } }]) {
    const rejected = await patchJson(`${baseUrl}/v1/account-connections/${connectionId}`, body);
    assert.equal(rejected.status, 400, `secret-field patch must fail with 400: ${JSON.stringify(body)} -> ${rejected.status}`);
  }
}

async function assertRefreshSucceeds(baseUrl, connectionId) {
  const before = await getJson(`${baseUrl}/v1/account-connections/${connectionId}`);
  const refresh = await postJson(`${baseUrl}/v1/account-connections/${connectionId}/refresh`, {});
  assert.equal(refresh.status, 202, `refresh must be accepted: ${JSON.stringify(refresh.json)}`);
  const connection = refresh.json.connection;
  assert.equal(connection.status, "connected", "refresh-capable connection must return to connected");
  assert.equal(connection.refresh.state, "succeeded");
  assert.ok(connection.refresh.last_success_at, "refresh must record last_success_at");
  assert.ok(Date.parse(connection.expires_at) >= Date.parse(before.connection.expires_at), "refresh must extend or keep expires_at");
  const eventTypes = (await getJson(`${baseUrl}/v1/account-connections/${connectionId}`)).connection.recent_events.map((event) => event.type);
  assert.ok(eventTypes.includes("account.connection.refresh.started"), "missing refresh.started event");
  assert.ok(eventTypes.includes("account.connection.refresh.succeeded"), "missing refresh.succeeded event");
}

async function assertRefreshUnsupported(baseUrl) {
  const { connections } = await getJson(`${baseUrl}/v1/account-connections`);
  const apiKey = connections.find((connection) => connection.credential_kind === "api_key");
  assert.ok(apiKey, "expected an api_key connection from the secret form check");
  const refresh = await postJson(`${baseUrl}/v1/account-connections/${apiKey.id}/refresh`, {});
  assert.equal(refresh.status, 409, `unsupported refresh must return 409: ${JSON.stringify(refresh.json)}`);
  assert.equal(refresh.json.needs_user_action, true);
  assert.equal(refresh.json.connection.needs_user_action, true);
  assert.ok(refresh.json.connection.user_action.reauth_endpoint.endsWith(`/v1/account-connections/${apiKey.id}/reauth`));
  assert.ok(!JSON.stringify(refresh.json).includes("sk-fixture-plaintext-secret"), "409 payload leaked the credential");
}

async function assertFailedRefresh(baseUrl) {
  const connection = await assertOauthConnect(baseUrl, { label: "Bad refresh fixture", code: "fixture-grant-badrefresh:bad" });
  const refresh = await postJson(`${baseUrl}/v1/account-connections/${connection.id}/refresh`, {});
  assert.equal(refresh.status, 202, "refresh attempt is accepted even when the provider rejects it");
  const failed = refresh.json.connection;
  assert.equal(failed.status, "action_required", `failed refresh must need the user: ${failed.status}`);
  assert.equal(failed.refresh.state, "failed");
  assert.equal(failed.refresh.failure_code, "invalid_grant");
  assert.equal(failed.needs_user_action, true);
  assert.equal(failed.credential_ref_kind, "encrypted_server_secret", "failed refresh must not delete the last known credential");

  // The failure queued a device notification with only non-secret fields.
  const { notifications } = await getJson(`${baseUrl}/v1/account-connections/notifications?device_id=android_primary&status=queued`);
  const notification = notifications.find((candidate) => candidate.connection_id === connection.id);
  assert.ok(notification, "failed refresh must queue a notification for the device target");
  assert.equal(notification.tool, "notification.account_connection");
  assert.deepEqual(Object.keys(notification.input).sort(), ["connection_id", "connection_label", "provider_label", "reason", "reauth_endpoint"]);

  // The device records a receipt after displaying it.
  const receipt = await postJson(`${baseUrl}/v1/account-connections/notifications/${notification.id}/receipt`, {
    device_id: "android_primary",
    displayed: true,
    note: "shown as credential-health notification",
  });
  assert.equal(receipt.status, 200);
  assert.equal(receipt.json.notification.status, "received");
  assert.ok(receipt.json.notification.receipt.at, "receipt must be timestamped");
  return connection;
}

async function assertHealthRun(baseUrl) {
  // Short-lived grant (60s) is inside the refresh leeway, so a health pass
  // must refresh it back out to a fresh expiry.
  const connection = await assertOauthConnect(baseUrl, { label: "Shortlived fixture", code: "fixture-grant-shortlived:short" });
  assert.ok(Date.parse(connection.expires_at) - Date.now() < 5 * 60 * 1000, "fixture short grant must be near expiry");
  const run = await postJson(`${baseUrl}/v1/account-connections/health/run`, {});
  assert.equal(run.status, 200, JSON.stringify(run.json));
  assert.ok(run.json.summary.checked >= 1, "health run must check connections");
  assert.ok(run.json.summary.refreshed >= 1, `health run must refresh the near-expiry connection: ${JSON.stringify(run.json.summary)}`);
  const after = (await getJson(`${baseUrl}/v1/account-connections/${connection.id}`)).connection;
  assert.equal(after.status, "connected");
  assert.ok(Date.parse(after.expires_at) - Date.now() > 30 * 60 * 1000, "health refresh must extend expiry");
  assert.ok(after.audit.last_health_check_at, "health run must stamp last_health_check_at");
  const eventTypes = after.recent_events.map((event) => event.type);
  assert.ok(eventTypes.includes("account.connection.health.checked"), "missing health.checked event");
}

async function assertReauthFlow(baseUrl) {
  const { connections } = await getJson(`${baseUrl}/v1/account-connections`);
  const broken = connections.find((connection) => connection.status === "action_required" && connection.credential_kind === "oauth2_authorization_code");
  assert.ok(broken, "expected an action_required oauth connection from the failed-refresh check");

  const reauth = await postJson(`${baseUrl}/v1/account-connections/${broken.id}/reauth`, {});
  assert.equal(reauth.status, 200);
  assert.equal(reauth.json.connection_id, broken.id);
  assert.equal(reauth.json.reauth_action.type, "open_url");
  assert.ok(reauth.json.reauth_action.expires_at, "reauth action must be short-lived");
  assert.ok(!JSON.stringify(reauth.json).includes("fixture-refresh-"), "reauth action leaked credential material");

  // User completes the reauth in a browser: start -> provider -> callback.
  const start = await fetch(reauth.json.reauth_action.url, { redirect: "manual" });
  assert.equal(start.status, 302);
  const callbackUrl = new URL(start.headers.get("location"));
  callbackUrl.searchParams.set("code", "fixture-grant-ok:bad");
  const callback = await fetch(callbackUrl);
  assert.equal(callback.status, 200, `reauth callback must succeed: ${await callback.text()}`);

  const after = (await getJson(`${baseUrl}/v1/account-connections/${broken.id}`)).connection;
  assert.equal(after.status, "connected");
  assert.equal(after.needs_user_action, false, "successful reauth must clear needs_user_action");
  const eventTypes = after.recent_events.map((event) => event.type);
  assert.ok(eventTypes.includes("account.connection.reauth.started"), "missing reauth.started event");
  assert.ok(eventTypes.includes("account.connection.reauth.completed"), "missing reauth.completed event");
}

async function assertDisableDisconnect(baseUrl, connectionId) {
  const disabled = await postJson(`${baseUrl}/v1/account-connections/${connectionId}/disable`, {});
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.connection.status, "disabled");
  const listed = (await getJson(`${baseUrl}/v1/account-connections`)).connections.find((connection) => connection.id === connectionId);
  assert.equal(listed.status, "disabled", "disabled connections stay listed");

  const enabled = await patchJson(`${baseUrl}/v1/account-connections/${connectionId}`, { enabled: true });
  assert.equal(enabled.json.connection.status, "connected", "re-enable with a stored credential returns to connected");

  const disconnected = await postJson(`${baseUrl}/v1/account-connections/${connectionId}/disconnect`, {});
  assert.equal(disconnected.status, 200);
  assert.equal(disconnected.json.connection.status, "revoked");
  assert.equal(disconnected.json.connection.credential_ref_kind, "none", "disconnect must retire the credential ref");
  const refreshAfter = await postJson(`${baseUrl}/v1/account-connections/${connectionId}/refresh`, {});
  assert.equal(refreshAfter.status, 409, "a disconnected connection cannot refresh");
  const eventTypes = (await getJson(`${baseUrl}/v1/account-connections/${connectionId}`)).connection.recent_events.map((event) => event.type);
  assert.ok(eventTypes.includes("account.connection.disabled"), "missing disabled event");
  assert.ok(eventTypes.includes("account.connection.disconnected"), "missing disconnected event");
}

function assertNoPlaintextSecrets(dataDir) {
  // Every stored secret in this smoke contains one of these markers. The only
  // file allowed to reference them is the encrypted credentials store, and even
  // there only as ciphertext, which cannot contain the plaintext marker.
  const markers = ["sk-fixture-plaintext-secret", "fixture-refresh-", "fixture-access-"];
  const offenders = [];
  walk(dataDir, (filePath) => {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const marker of markers) {
      if (raw.includes(marker)) {
        offenders.push(`${filePath}: ${marker}`);
      }
    }
  });
  assert.deepEqual(offenders, [], `plaintext credential material found on disk:\n${offenders.join("\n")}`);
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

// --- harness ------------------------------------------------------------------

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

function postJson(url, body) {
  return bodyRequest("POST", url, body);
}

function patchJson(url, body) {
  return bodyRequest("PATCH", url, body);
}

async function bodyRequest(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: { ...authHeaders(), "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
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
  const logs = { exited: false, text: () => output };
  child.on("exit", () => {
    logs.exited = true;
  });
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
