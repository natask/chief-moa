"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAccountConnectionStore } = require("../lib/account-connections");
const { createProviderAdapters, loadProviderCatalog } = require("../lib/account-providers");

const USER = "usr_test";

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-account-connections-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let clock = Date.now();
  const store = createAccountConnectionStore({
    dataDir,
    env: { ACCOUNT_FIXTURE_PROVIDER: "1", ...(options.env || {}) },
    publicBaseUrl: "https://gateway.test///",
    now: () => clock,
    actionTtlMs: options.actionTtlMs ?? 1_000,
    refreshLeewayMs: options.refreshLeewayMs ?? 120_000,
    adapters: options.adapters,
    catalog: options.catalog,
    onUserActionNotification: options.onUserActionNotification,
  });
  return { store, dataDir, advance(ms) { clock += ms; } };
}

function tokenFrom(action, name) {
  return new URL(action.url).searchParams.get(name);
}

async function connectOauth(store, code = "fixture-grant-ok:primary", body = {}) {
  const created = store.create(USER, {
    provider: "fixture",
    credential_kind: "oauth2_authorization_code",
    label: "Fixture OAuth",
    scopes: ["fixture.read", 42, ""],
    ...body,
  });
  const state = tokenFrom(created.reauth_action, "state");
  const result = await store.completeOauthCallback({ state, code, error: "" });
  return { created, state, connection: result.connection };
}

function createSecret(store, body = {}) {
  const created = store.create(USER, {
    provider: "fixture",
    credential_kind: "api_key",
    label: "Fixture key",
    ...body,
  });
  const token = tokenFrom(created.reauth_action, "token");
  return { created, token };
}

test("validates creation, ownership, actions, and patches", async (t) => {
  const { store, advance } = fixture(t);
  assert.equal(store.catalog().at(-1).id, "fixture");
  assert.deepEqual(store.list("nobody"), []);
  assert.throws(() => store.create(USER, { provider: "missing", credential_kind: "api_key" }), /unknown provider/);
  assert.throws(() => store.create(USER), /unknown provider: \(empty\)/);
  assert.throws(() => store.create(USER, { provider: "fixture" }), /credential_kind \(empty\)/);
  assert.throws(() => store.create(USER, { provider: "fixture", credential_kind: "none" }), /does not support/);
  assert.throws(() => store.create(USER, { provider: "fixture", credential_kind: "api_key", nested: { password: "bad" } }), /password/);
  assert.throws(() => store.get(USER, "missing"), /not found/);
  assert.throws(() => store.get(USER), /not found/);
  assert.throws(() => store.secretFormInfo(), /unknown or expired/);

  const secret = createSecret(store, {
    label: "  ",
    return_url: "javascript:alert(1)",
    device_notification_target: [],
  });
  assert.equal(secret.created.connection.label, "Fixture Provider connection");
  assert.equal(secret.created.connection.device_notification_target, null);
  assert.equal(store.secretFormInfo(secret.token).credential_kind_label, "API key");
  assert.throws(() => store.oauthStartRedirect(secret.token), /unknown or expired/);
  assert.throws(() => store.submitSecretForm(secret.token, {}), /secret value is required/);
  const connected = store.submitSecretForm(secret.token, {
    secret: "fixture-secret-value-long",
    account_display: " Tester ",
    expires_at: "not-a-date",
  }).connection;
  assert.equal(connected.account_subject.display, "Tester");
  assert.equal(connected.expires_at, "");
  assert.throws(() => store.submitSecretForm(secret.token, { secret: "again" }), /already used/);
  assert.throws(() => store.patch(USER, connected.id, { api_key: "leak" }), /cannot be set/);
  const patched = store.patch(USER, connected.id, {
    label: "  Renamed key  ",
    device_notification_target: { device_id: " phone-1 ", surface_type: "ios", channel: "alerts", enabled: false },
  });
  assert.equal(patched.label, "Renamed key");
  assert.deepEqual(patched.device_notification_target, { device_id: "phone-1", surface_type: "ios", channel: "alerts", enabled: false });
  assert.equal(store.patch(USER, connected.id, { label: "" }).label, "Renamed key");

  const expiring = createSecret(store);
  advance(1_001);
  assert.throws(() => store.secretFormInfo(expiring.token), /expired/);
  const old = createSecret(store);
  advance(2_001);
  createSecret(store); // prunes actions older than a second beyond expiry
  assert.throws(() => store.secretFormInfo(old.token), /unknown or expired/);
});

test("covers OAuth redirect, rejection, exchange failure, reuse, and duplicate subjects", async (t) => {
  const { store } = fixture(t);
  const first = store.create(USER, { provider: "fixture", credential_kind: "oauth2_authorization_code" });
  const state = tokenFrom(first.reauth_action, "state");
  const redirect = new URL(store.oauthStartRedirect(state));
  assert.equal(redirect.origin, "https://gateway.test");
  assert.equal(redirect.searchParams.get("state"), state);
  await store.completeOauthCallback({ state, code: "fixture-grant-ok:one", error: "" });
  await assert.rejects(() => store.completeOauthCallback({ state, code: "fixture-grant-ok:one", error: "" }), /already used/);

  const rejected = store.create(USER, { provider: "fixture", credential_kind: "oauth2_authorization_code" });
  await assert.rejects(
    () => store.completeOauthCallback({ state: tokenFrom(rejected.reauth_action, "state"), code: "", error: "access_denied_by_user" }),
    /authorization failed/
  );
  assert.equal(store.get(USER, rejected.connection.id).status, "action_required");

  const failed = store.create(USER, { provider: "fixture", credential_kind: "oauth2_authorization_code" });
  await assert.rejects(
    () => store.completeOauthCallback({ state: tokenFrom(failed.reauth_action, "state"), code: "bad-code", error: "" }),
    /code exchange failed/
  );
  assert.equal(store.get(USER, failed.connection.id).status, "error");

  const duplicate = store.create(USER, { provider: "fixture", credential_kind: "oauth2_authorization_code" });
  await assert.rejects(
    () => store.completeOauthCallback({ state: tokenFrom(duplicate.reauth_action, "state"), code: "fixture-grant-ok:one", error: "" }),
    /already connected/
  );
  assert.ok(store.get(USER, first.connection.id).recent_events.length > 4);
  assert.deepEqual(store.listEvents("missing"), []);
});

test("refreshes OAuth grants and handles provider evidence", async (t) => {
  const bridged = [];
  const { store } = fixture(t, {
    onUserActionNotification(notification) {
      bridged.push(notification);
      return { tool_request_id: "tool-123" };
    },
  });
  const good = await connectOauth(store, "fixture-grant-ok:good", {
    device_notification_target: { device_id: "android-1" },
  });
  const refreshed = await store.requestRefresh(USER, good.connection.id);
  assert.equal(refreshed.statusCode, 202);
  assert.equal(refreshed.connection.refresh.state, "succeeded");

  const bad = await connectOauth(store, "fixture-grant-badrefresh:bad", {
    device_notification_target: { device_id: "android-1" },
  });
  const failed = await store.requestRefresh(USER, bad.connection.id);
  assert.equal(failed.connection.status, "action_required");
  assert.equal(failed.connection.refresh.failure_code, "invalid_grant");
  const notifications = store.listNotifications({ userId: USER, deviceId: "android-1", status: "queued" });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].tool_request_id, "tool-123");
  assert.equal(bridged.length, 1);
  await store.requestRefresh(USER, bad.connection.id);
  assert.equal(store.listNotifications({ userId: USER }).length, 1, "duplicates stay coalesced");

  assert.throws(() => store.recordNotificationReceipt("other", notifications[0].id), /not found/);
  const received = store.recordNotificationReceipt(USER, notifications[0].id, { device_id: "android-2", displayed: false, note: "shown\nlate" });
  assert.equal(received.status, "received");
  assert.deepEqual(received.receipt.displayed, false);
  assert.equal(store.listNotifications({ userId: USER, status: "queued" }).length, 0);
  assert.throws(() => store.recordNotificationReceipt(USER), /not found/);
});

test("unsupported refresh and health checks produce durable user actions", async (t) => {
  const { store } = fixture(t, { onUserActionNotification() { throw new Error("hub offline"); } });
  const manual = createSecret(store, { device_notification_target: { device_id: "phone" } });
  const connected = store.submitSecretForm(manual.token, {
    secret: "manual-secret-long-value",
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  }).connection;
  await assert.rejects(
    () => store.requestRefresh(USER, connected.id),
    (error) => error.statusCode === 409 && error.payload.connection.needs_user_action
  );
  assert.equal(store.listNotifications({ userId: USER }).length, 1);
  await assert.rejects(() => store.requestRefresh(USER, connected.id), /not supported/);

  const near = createSecret(store, { device_notification_target: { device_id: "phone-2" } });
  store.submitSecretForm(near.token, {
    secret: "another-manual-secret",
    expires_at: new Date(Date.now() + 30_000).toISOString(),
  });
  const far = createSecret(store);
  store.submitSecretForm(far.token, {
    secret: "far-future-secret-value",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const short = await connectOauth(store, "fixture-grant-shortlived:health");
  const summary = await store.runHealthChecks();
  assert.ok(summary.checked >= 4);
  assert.equal(summary.refreshed, 1);
  assert.ok(summary.action_required >= 1);
  assert.equal(store.get(USER, short.connection.id).status, "connected");

  const noTarget = createSecret(store);
  store.submitSecretForm(noTarget.token, { secret: "unsupported-without-device" });
  await assert.rejects(() => store.requestRefresh(USER, noTarget.created.connection.id), /not supported/);
});

test("reauthorizes, disables, re-enables, and disconnects connections", async (t) => {
  const { store } = fixture(t);
  const oauth = await connectOauth(store, "fixture-grant-ok:lifecycle");
  const reauth = store.requestReauth(USER, oauth.connection.id);
  assert.equal(reauth.reauth_action.type, "open_url");
  await store.completeOauthCallback({
    state: tokenFrom(reauth.reauth_action, "state"),
    code: "fixture-grant-ok:lifecycle",
    error: "",
  });
  assert.equal(store.disable(USER, oauth.connection.id).status, "disabled");
  await assert.rejects(() => store.requestRefresh(USER, oauth.connection.id), /disabled/);
  assert.equal(store.patch(USER, oauth.connection.id, { enabled: true }).status, "connected");
  assert.equal((await store.disconnect(USER, oauth.connection.id)).status, "revoked");
  assert.equal(store.get(USER, oauth.connection.id).credential_ref_kind, "none");
  assert.throws(() => store.requestReauth(USER, oauth.connection.id), /revoked/);
  assert.throws(() => store.disable(USER, oauth.connection.id), /revoked/);
  await assert.rejects(() => store.requestRefresh(USER, oauth.connection.id), /revoked/);

  const manual = createSecret(store);
  store.submitSecretForm(manual.token, { secret: "manual-disconnect-secret" });
  store.disable(USER, manual.created.connection.id);
  assert.equal(store.patch(USER, manual.created.connection.id, { enabled: true }).status, "connected");
  assert.equal((await store.disconnect(USER, manual.created.connection.id)).status, "revoked");
  const status = store.status();
  assert.equal(status.by_status.revoked, 2);
  assert.equal(status.credential_encryption.algorithm, "aes-256-gcm");
});

test("persists encrypted state, tolerates malformed projections, and validates keys", async (t) => {
  const { store, dataDir } = fixture(t);
  const secret = createSecret(store);
  store.submitSecretForm(secret.token, { secret: "never-store-this-plaintext", account_display: "persisted" });
  const storeDir = path.join(dataDir, "account-connections");
  const credentialText = fs.readFileSync(path.join(storeDir, "credentials.json"), "utf8");
  assert.doesNotMatch(credentialText, /never-store-this-plaintext/);
  fs.appendFileSync(path.join(storeDir, "events.jsonl"), "not json\n");

  const reloaded = createAccountConnectionStore({ dataDir, env: { ACCOUNT_FIXTURE_PROVIDER: "1" } });
  assert.equal(reloaded.get(USER, secret.created.connection.id).account_subject.display, "persisted");
  assert.ok(reloaded.listEvents(secret.created.connection.id, "bad").length > 0);

  fs.writeFileSync(path.join(storeDir, "notifications.json"), "broken");
  const tolerant = createAccountConnectionStore({ dataDir, env: { ACCOUNT_FIXTURE_PROVIDER: "1" } });
  assert.deepEqual(tolerant.listNotifications({ userId: USER }), []);
  fs.writeFileSync(path.join(storeDir, "notifications.json"), JSON.stringify({ notifications: null }));
  assert.deepEqual(createAccountConnectionStore({ dataDir, env: { ACCOUNT_FIXTURE_PROVIDER: "1" } }).listNotifications({ userId: USER }), []);

  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-account-key-test-"));
  t.after(() => fs.rmSync(otherDir, { recursive: true, force: true }));
  assert.throws(() => createAccountConnectionStore({ dataDir: otherDir, env: { ACCOUNT_CREDENTIAL_KEY: "bad" } }), /must be 32 bytes/);
  const envKey = Buffer.alloc(32, 7).toString("base64");
  const keyed = createAccountConnectionStore({ dataDir: otherDir, env: { ACCOUNT_FIXTURE_PROVIDER: "1", ACCOUNT_CREDENTIAL_KEY: envKey } });
  assert.equal(keyed.status().credential_encryption.key_source, "env");
});

test("reports unconfigured OAuth and best-effort revoke failures", async (t) => {
  const catalog = loadProviderCatalog({ ACCOUNT_FIXTURE_PROVIDER: "1" });
  const realAdapters = createProviderAdapters({ env: { ACCOUNT_FIXTURE_PROVIDER: "1" } });
  const adapters = {
    get(provider) {
      if (provider === "fixture") {
        const fixtureAdapter = realAdapters.get(provider);
        return { ...fixtureAdapter, async revoke() { throw new Error("provider\nfailed"); } };
      }
      return realAdapters.get(provider);
    },
  };
  const controlled = fixture(t, { catalog, adapters }).store;
  const oauth = await connectOauth(controlled, "fixture-grant-ok:revoke-fail");
  const disconnected = await controlled.disconnect(USER, oauth.connection.id);
  assert.equal(disconnected.status_reason, "disconnected; server-side credential retired");
  assert.match(JSON.stringify(controlled.listEvents(oauth.connection.id)), /provider failed/);

  const unconfigured = fixture(t).store;
  assert.throws(
    () => unconfigured.create(USER, { provider: "google", credential_kind: "oauth2_authorization_code" }),
    /not configured/
  );
});

test("covers remaining health, notification, and adapter failure branches", async (t) => {
  const realAdapters = createProviderAdapters({ env: { ACCOUNT_FIXTURE_PROVIDER: "1" } });
  const fixtureAdapter = realAdapters.get("fixture");
  let failureCode = "provider_unavailable";
  let expiredGrant = false;
  const adapters = {
    get(provider) {
      if (provider !== "fixture") return realAdapters.get(provider);
      return {
        ...fixtureAdapter,
        async exchangeCode(args) {
          const grant = await fixtureAdapter.exchangeCode(args);
          if (expiredGrant) grant.expires_at = new Date(Date.now() - 60_000).toISOString();
          return grant;
        },
        async refresh() {
          const error = new Error("provider\nnetwork failure");
          if (failureCode) error.code = failureCode;
          throw error;
        },
      };
    },
  };
  const { store } = fixture(t, { adapters });
  const future = await connectOauth(store, "fixture-grant-ok:network", {
    device_notification_target: { device_id: "phone" },
  });
  const networkFailure = await store.requestRefresh(USER, future.connection.id);
  assert.equal(networkFailure.connection.status, "error");
  assert.equal(networkFailure.connection.refresh.failure_message, "provider network failure");

  expiredGrant = true;
  failureCode = "temporarily_unavailable";
  const expired = await connectOauth(store, "fixture-grant-ok:expired", {
    device_notification_target: { device_id: "phone-2" },
  });
  const expiredFailure = await store.requestRefresh(USER, expired.connection.id);
  assert.equal(expiredFailure.connection.status, "expired");
  assert.equal(store.listNotifications({ userId: USER, deviceId: "phone-2" }).length, 1);

  const reauth = store.requestReauth(USER, expired.connection.id);
  expiredGrant = false;
  await store.completeOauthCallback({ state: tokenFrom(reauth.reauth_action, "state"), code: "fixture-grant-ok:expired", error: "" });
  assert.equal(store.listNotifications({ userId: USER, deviceId: "phone-2" })[0].status, "resolved");

  const pending = createSecret(store);
  store.disable(USER, pending.created.connection.id);
  assert.equal(store.patch(USER, pending.created.connection.id, { enabled: true }).status, "action_required");
  assert.equal((await store.disconnect(USER, pending.created.connection.id)).credential_ref_kind, "none");
  const healthWithPending = await store.runHealthChecks();
  assert.ok(healthWithPending.checked >= 2);
});

test("retains refresh tokens when providers do not rotate them", async (t) => {
  const realAdapters = createProviderAdapters({ env: { ACCOUNT_FIXTURE_PROVIDER: "1" } });
  const fixtureAdapter = realAdapters.get("fixture");
  const adapters = {
    get(provider) {
      if (provider !== "fixture") return realAdapters.get(provider);
      return {
        ...fixtureAdapter,
        async refresh({ refreshToken }) {
          const grant = await fixtureAdapter.refresh({ refreshToken });
          delete grant.refresh_token;
          grant.expires_at = "";
          return grant;
        },
      };
    },
  };
  const { store } = fixture(t, { adapters, refreshLeewayMs: -1 });
  const oauth = await connectOauth(store, "fixture-grant-ok:no-rotation");
  const refreshed = await store.requestRefresh(USER, oauth.connection.id);
  assert.equal(refreshed.connection.status, "connected");
  assert.equal(refreshed.connection.expires_at, "");
});

test("covers manual kinds, URL normalization, keyfile recovery, and orphan actions", async (t) => {
  const manualCatalog = [{
    id: "manual",
    label: "Manual",
    credential_kinds: ["personal_access_token", "service_account", "oauth2_device_code"],
    supports_refresh: false,
  }];
  const adapters = { get() { return { oauthConfigured: () => true }; } };
  const { store, dataDir } = fixture(t, { catalog: manualCatalog, adapters });
  assert.deepEqual(store.listEvents("none"), []);
  const pat = store.create(USER, {
    provider: "manual",
    credential_kind: "personal_access_token",
    return_url: "https://client.test/done",
    device_notification_target: {},
  });
  assert.match(store.secretFormInfo(tokenFrom(pat.reauth_action, "token")).credential_kind_label, /personal access token/);
  const service = store.create(USER, { provider: "manual", credential_kind: "service_account", return_url: "not a url" });
  assert.match(store.secretFormInfo(tokenFrom(service.reauth_action, "token")).credential_kind_label, /service account/);
  assert.throws(
    () => store.create(USER, { provider: "manual", credential_kind: "oauth2_device_code" }),
    /no supported connect flow/
  );

  const storeDir = path.join(dataDir, "account-connections");
  const actionsPath = path.join(storeDir, "actions.json");
  const connectionsPath = path.join(storeDir, "connections.json");
  fs.writeFileSync(connectionsPath, JSON.stringify({ connections: {} }));
  const orphanStore = createAccountConnectionStore({ dataDir, catalog: manualCatalog, adapters });
  assert.throws(() => orphanStore.secretFormInfo(tokenFrom(pat.reauth_action, "token")), /no longer exists/);
  assert.throws(() => orphanStore.submitSecretForm(tokenFrom(service.reauth_action, "token"), { secret: "orphan-secret" }), /no longer exists/);
  assert.ok(fs.existsSync(actionsPath));

  const oauthDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-account-orphan-oauth-"));
  t.after(() => fs.rmSync(oauthDir, { recursive: true, force: true }));
  const oauthStore = createAccountConnectionStore({ dataDir: oauthDir, env: { ACCOUNT_FIXTURE_PROVIDER: "1" } });
  const oauth = oauthStore.create(USER, { provider: "fixture", credential_kind: "oauth2_authorization_code" });
  fs.writeFileSync(path.join(oauthDir, "account-connections", "connections.json"), JSON.stringify({ connections: {} }));
  const orphanOauth = createAccountConnectionStore({ dataDir: oauthDir, env: { ACCOUNT_FIXTURE_PROVIDER: "1" } });
  const oauthState = tokenFrom(oauth.reauth_action, "state");
  assert.throws(() => orphanOauth.oauthStartRedirect(oauthState), /no longer exists/);
  await assert.rejects(() => orphanOauth.completeOauthCallback({ state: oauthState, code: "fixture-grant-ok", error: "" }), /no longer exists/);

  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-account-keyfile-recovery-"));
  t.after(() => fs.rmSync(keyDir, { recursive: true, force: true }));
  const keyStoreDir = path.join(keyDir, "account-connections");
  fs.mkdirSync(keyStoreDir, { recursive: true });
  fs.writeFileSync(path.join(keyStoreDir, "credential.key"), "invalid-key");
  createAccountConnectionStore({ dataDir: keyDir, env: { ACCOUNT_FIXTURE_PROVIDER: "1" } });
  assert.match(fs.readFileSync(path.join(keyStoreDir, "credential.key"), "utf8"), /^[0-9a-f]{64}$/);
  const hexDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-account-hex-key-"));
  t.after(() => fs.rmSync(hexDir, { recursive: true, force: true }));
  assert.equal(createAccountConnectionStore({ dataDir: hexDir, env: { ACCOUNT_CREDENTIAL_KEY: "ab".repeat(32) } }).status().credential_encryption.key_source, "env");
});

test("uses safe fallbacks for legacy persisted records", async (t) => {
  const { store, dataDir } = fixture(t);
  const oauth = await connectOauth(store, "fixture-grant-ok:legacy", {
    device_notification_target: { device_id: "legacy-phone" },
  });
  const storeDir = path.join(dataDir, "account-connections");
  const connectionsPath = path.join(storeDir, "connections.json");
  const credentialsPath = path.join(storeDir, "credentials.json");
  const connectionProjection = JSON.parse(fs.readFileSync(connectionsPath, "utf8"));
  const legacy = connectionProjection.connections[oauth.connection.id];
  legacy.device_notification_target = { device_id: "legacy-phone", enabled: true };
  fs.writeFileSync(connectionsPath, JSON.stringify(connectionProjection));
  const credentialProjection = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  delete credentialProjection.credentials[oauth.connection.id].credential_ref_kind;
  fs.writeFileSync(credentialsPath, JSON.stringify(credentialProjection));
  const legacyStore = createAccountConnectionStore({
    dataDir,
    catalog: [],
    adapters: createProviderAdapters({ env: { ACCOUNT_FIXTURE_PROVIDER: "1" } }),
  });
  assert.equal(legacyStore.get(USER, oauth.connection.id).provider_label, "fixture");
  assert.equal(legacyStore.get(USER, oauth.connection.id).credential_ref_kind, "encrypted_server_secret");
  await assert.rejects(() => legacyStore.requestRefresh(USER, oauth.connection.id), /not supported/);
  const queued = legacyStore.listNotifications({ userId: USER })[0];
  assert.equal(queued.surface_type, "android");
  assert.equal(queued.channel, "credential_health");
  const receipt = legacyStore.recordNotificationReceipt(USER, queued.id);
  assert.equal(receipt.receipt.device_id, "legacy-phone");
  assert.equal(receipt.receipt.note, "");
});

test("health pass records failed refresh and expired non-refreshable credentials", async (t) => {
  const { store } = fixture(t);
  await connectOauth(store, "fixture-grant-shortbad:health-bad", {
    device_notification_target: { device_id: "bad-phone" },
  });
  const manual = createSecret(store, { device_notification_target: { device_id: "manual-phone" } });
  store.submitSecretForm(manual.token, {
    secret: "expired-manual-health-secret",
    expires_at: new Date(Date.now() - 1_000).toISOString(),
  });
  const summary = await store.runHealthChecks();
  assert.equal(summary.refresh_failed, 1);
  assert.equal(summary.expired, 1);
  assert.equal(summary.notifications_queued, 2);
  assert.equal(store.status().needs_user_action, 2);
});
