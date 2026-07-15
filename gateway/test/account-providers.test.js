"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CREDENTIAL_KINDS,
  loadProviderCatalog,
  providerById,
  oauthConfigFor,
  createProviderAdapters,
} = require("../lib/account-providers");

test("catalog is stable, optional fixture is isolated, and lookup fails closed", () => {
  assert.deepEqual(CREDENTIAL_KINDS, [
    "oauth2_authorization_code", "oauth2_device_code", "api_key",
    "personal_access_token", "service_account", "external_handle", "none",
  ]);
  const base = loadProviderCatalog({});
  assert.deepEqual(base.map((provider) => provider.id), ["openai", "anthropic", "google", "github"]);
  assert.equal(providerById(base, "google").supports_refresh, true);
  assert.equal(providerById(base, "missing"), null);
  const fixture = loadProviderCatalog({ ACCOUNT_FIXTURE_PROVIDER: "1" });
  assert.equal(fixture.at(-1).id, "fixture");
  assert.equal(base.length, 4);
});

test("OAuth configuration uses provider defaults, custom endpoints, scopes, and sanitized keys", () => {
  assert.equal(oauthConfigFor("google", {}), null);
  const google = oauthConfigFor("google", {
    ACCOUNT_OAUTH_GOOGLE_CLIENT_ID: " id ",
    ACCOUNT_OAUTH_GOOGLE_CLIENT_SECRET: " secret ",
    ACCOUNT_OAUTH_GOOGLE_SCOPES: "openid,email profile",
  });
  assert.equal(google.auth_url, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual(google.scopes, ["openid", "email", "profile"]);
  const custom = oauthConfigFor("my-provider", {
    ACCOUNT_OAUTH_MY_PROVIDER_CLIENT_ID: "id",
    ACCOUNT_OAUTH_MY_PROVIDER_CLIENT_SECRET: "secret",
    ACCOUNT_OAUTH_MY_PROVIDER_AUTH_URL: "https://provider.test/auth",
    ACCOUNT_OAUTH_MY_PROVIDER_TOKEN_URL: "https://provider.test/token",
  });
  assert.equal(custom.token_url, "https://provider.test/token");
  assert.equal(oauthConfigFor(null, {}), null);
});

test("generic adapter caches, builds authorize URLs, exchanges, refreshes, and revokes", async () => {
  const requests = [];
  const env = {
    ACCOUNT_OAUTH_GOOGLE_CLIENT_ID: "client",
    ACCOUNT_OAUTH_GOOGLE_CLIENT_SECRET: "secret",
    ACCOUNT_OAUTH_GOOGLE_SCOPES: "openid profile",
  };
  const adapters = createProviderAdapters({
    env,
    fetchImpl: async (url, options) => {
      requests.push({ url, body: new URLSearchParams(options.body) });
      return jsonResponse(200, {
        access_token: "access",
        refresh_token: "refresh",
        token_type: "Bearer",
        scope: "openid,profile",
        expires_in: 60,
      });
    },
  });
  const adapter = adapters.get("google");
  assert.equal(adapters.get("google"), adapter);
  assert.equal(adapter.oauthConfigured(), true);
  assert.equal(adapter.supportsRefresh(), true);
  const authorize = new URL(adapter.authorizeUrl({ state: "state", redirectUri: "https://gateway.test/callback" }));
  assert.equal(authorize.searchParams.get("client_id"), "client");
  assert.equal(authorize.searchParams.get("scope"), "openid profile");
  assert.equal(authorize.searchParams.get("access_type"), "offline");
  const overridden = new URL(adapter.authorizeUrl({ state: "s", redirectUri: "https://gateway.test/c", scopes: ["email"] }));
  assert.equal(overridden.searchParams.get("scope"), "email");

  const grant = await adapter.exchangeCode({ code: "code", redirectUri: "https://gateway.test/c" });
  assert.equal(grant.access_token, "access");
  assert.equal(grant.token_type, "Bearer");
  assert.deepEqual(grant.scope, ["openid", "profile"]);
  assert.match(grant.expires_at, /^\d{4}-/);
  assert.deepEqual(grant.account_subject, { display: "", provider_account_id: "", subscription_id: "", organization_id: "" });
  await adapter.refresh({ refreshToken: "refresh" });
  assert.equal(requests[0].body.get("grant_type"), "authorization_code");
  assert.equal(requests[1].body.get("grant_type"), "refresh_token");
  assert.deepEqual(await adapter.revoke({}), { revoked: false });
});

test("generic adapter supports empty scopes and non-expiring token defaults", async () => {
  const env = {
    ACCOUNT_OAUTH_CUSTOM_CLIENT_ID: "id",
    ACCOUNT_OAUTH_CUSTOM_CLIENT_SECRET: "secret",
    ACCOUNT_OAUTH_CUSTOM_AUTH_URL: "https://provider.test/auth",
    ACCOUNT_OAUTH_CUSTOM_TOKEN_URL: "https://provider.test/token",
  };
  const adapter = createProviderAdapters({ env, fetchImpl: async () => jsonResponse(200, {}) }).get("custom");
  const url = new URL(adapter.authorizeUrl({ state: "s", redirectUri: "https://gateway.test/c", scopes: [] }));
  assert.equal(url.searchParams.has("scope"), false);
  const grant = await adapter.exchangeCode({ code: "c", redirectUri: "r" });
  assert.equal(grant.access_token, "");
  assert.equal(grant.refresh_token, "");
  assert.equal(grant.token_type, "bearer");
  assert.equal(grant.expires_at, "");
});

test("generic token errors are bounded and classified across JSON failures", async (t) => {
  const env = {
    ACCOUNT_OAUTH_GITHUB_CLIENT_ID: "id",
    ACCOUNT_OAUTH_GITHUB_CLIENT_SECRET: "secret",
  };
  await t.test("provider payload", async () => {
    const adapter = createProviderAdapters({ env, fetchImpl: async () => jsonResponse(400, { error: "invalid_grant", error_description: "bad code" }) }).get("github");
    await assert.rejects(adapter.exchangeCode({ code: "bad", redirectUri: "r" }), (error) => error.code === "invalid_grant" && error.message === "bad code");
  });
  await t.test("HTTP fallback", async () => {
    const adapter = createProviderAdapters({ env, fetchImpl: async () => jsonResponse(503, {}) }).get("github");
    await assert.rejects(adapter.refresh({ refreshToken: "bad" }), (error) => error.code === "http_503" && /503/.test(error.message));
  });
  await t.test("non-JSON", async () => {
    const adapter = createProviderAdapters({ env, fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error("html"); } }) }).get("github");
    await assert.rejects(adapter.refresh({ refreshToken: "bad" }), (error) => error.code === "http_502");
  });
});

test("unconfigured generic adapters advertise unavailable OAuth", () => {
  const adapter = createProviderAdapters({ env: {}, fetchImpl: async () => assert.fail("must not fetch") }).get("unknown");
  assert.equal(adapter.oauthConfigured(), false);
  assert.equal(adapter.supportsRefresh(), false);
  assert.throws(() => adapter.authorizeUrl({ state: "s", redirectUri: "r" }), /null/);
});

test("fixture adapter covers redirect, grant variants, subjects, refresh, denial, and revoke", async () => {
  const adapter = createProviderAdapters({ env: {} }).get("fixture");
  assert.equal(adapter.oauthConfigured(), true);
  assert.equal(adapter.supportsRefresh(), true);
  const redirect = new URL(adapter.authorizeUrl({ state: "state", redirectUri: "https://gateway.test/callback", loginHint: "fixture-grant-ok:alice" }));
  assert.equal(redirect.searchParams.get("code"), "fixture-grant-ok:alice");
  assert.equal(new URL(adapter.authorizeUrl({ state: "s", redirectUri: "https://gateway.test/c" })).searchParams.get("code"), "fixture-grant-ok");

  const normal = await adapter.exchangeCode({ code: "fixture-grant-ok:alice" });
  assert.equal(normal.account_subject.provider_account_id, "fixture-acct-alice");
  assert.match(normal.refresh_token, /^fixture-refresh-ok-/);
  const primary = await adapter.exchangeCode({ code: "fixture-grant-ok" });
  assert.equal(primary.account_subject.display, "primary@fixture.example");
  const short = await adapter.exchangeCode({ code: "fixture-grant-shortlived:bob" });
  assert.ok(Date.parse(short.expires_at) - Date.now() < 70_000);
  const bad = await adapter.exchangeCode({ code: "fixture-grant-badrefresh:bob" });
  assert.match(bad.refresh_token, /expired/);
  const shortbad = await adapter.exchangeCode({ code: "fixture-grant-shortbad:bob" });
  assert.match(shortbad.refresh_token, /expired/);

  const refreshed = await adapter.refresh({ refreshToken: normal.refresh_token });
  assert.equal(refreshed.account_subject.display, "alice@fixture.example");
  await assert.rejects(adapter.refresh({ refreshToken: "expired" }), (error) => error.code === "invalid_grant");
  await assert.rejects(adapter.exchangeCode({ code: "fixture-grant-deny" }), (error) => error.code === "access_denied");
  await assert.rejects(adapter.exchangeCode({ code: "unknown" }), (error) => error.code === "invalid_grant");
  assert.deepEqual(await adapter.revoke({}), { revoked: true });
});

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}
