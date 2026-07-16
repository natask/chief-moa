"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolveRemoteMode } = require("../lib/remote-mode");

test("local defaults are loopback, open without a token, and database-optional", () => {
  const result = resolveRemoteMode({});
  assert.deepEqual({
    mode: result.mode, remote: result.remote, local: result.local, valid: result.valid,
    defaultHost: result.defaultHost, trustProxy: result.trustProxy,
    databaseRequired: result.databaseRequired, databaseConfigured: result.databaseConfigured,
    tokenConfigured: result.tokenConfigured, authMode: result.authMode,
    futureAuthEnabled: result.futureAuthEnabled, authConfigured: result.authConfigured,
    workerPullDefault: result.workerPullDefault,
    protectedRoutesOpenWithoutToken: result.protectedRoutesOpenWithoutToken,
  }, {
    mode: "local", remote: false, local: true, valid: true,
    defaultHost: "127.0.0.1", trustProxy: false,
    databaseRequired: false, databaseConfigured: false,
    tokenConfigured: false, authMode: "gateway-token",
    futureAuthEnabled: false, authConfigured: false,
    workerPullDefault: false, protectedRoutesOpenWithoutToken: true,
  });
  assert.deepEqual(result.health(), {
    mode: "local", remote: false, auth_mode: "gateway-token", auth_configured: false,
    token_auth_configured: false, future_auth_enabled: false, database_required: false,
    database_configured: false, trust_proxy: false, default_host: "127.0.0.1",
    worker_pull_default: false,
  });
});

test("local token and explicit trust proxy close protected routes", () => {
  const result = resolveRemoteMode({ MOA_MODE: " LOCAL ", MOA_GATEWAY_TOKEN: " token ", MOA_TRUST_PROXY: "1" });
  assert.equal(result.valid, true);
  assert.equal(result.tokenConfigured, true);
  assert.equal(result.authConfigured, true);
  assert.equal(result.trustProxy, true);
  assert.equal(result.protectedRoutesOpenWithoutToken, false);
});

test("self-host aliases normalize and remote defaults require database and token", () => {
  for (const alias of ["selfhost", "self_hosted", "self hosted", "self-host"] ) {
    const result = resolveRemoteMode({ MOA_MODE: alias });
    assert.equal(result.mode, "self-host");
    assert.equal(result.remote, true);
    assert.equal(result.local, false);
    assert.equal(result.defaultHost, "0.0.0.0");
    assert.equal(result.trustProxy, true);
    assert.equal(result.workerPullDefault, true);
    assert.equal(result.protectedRoutesOpenWithoutToken, false);
    assert.match(result.issues.join(" "), /DATABASE_URL/);
    assert.match(result.issues.join(" "), /MOA_GATEWAY_TOKEN/);
  }
});

test("remote token configuration is valid and trust proxy can be disabled", () => {
  for (const mode of ["self-host", "hosted"]) {
    const result = resolveRemoteMode({
      MOA_MODE: mode, DATABASE_URL: " postgres://db ", MOA_GATEWAY_TOKEN: "token",
      MOA_TRUST_PROXY: "0",
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.issues, []);
    assert.equal(result.databaseConfigured, true);
    assert.equal(result.authMode, "gateway-token");
    assert.equal(result.trustProxy, false);
    assert.equal(result.health().database_required, true);
  }
});

test("future auth satisfies remote auth while token aliases do not", () => {
  const future = resolveRemoteMode({ MOA_MODE: "hosted", DATABASE_URL: "db", MOA_AUTH: "better-auth" });
  assert.equal(future.valid, true);
  assert.equal(future.futureAuthEnabled, true);
  assert.equal(future.authConfigured, true);
  assert.equal(future.authMode, "better-auth");
  assert.equal(future.health().future_auth_enabled, true);

  for (const auth of ["token", "gateway-token", "legacy-token", "bearer", ""]) {
    const result = resolveRemoteMode({ MOA_MODE: "hosted", DATABASE_URL: "db", MOA_AUTH: auth });
    assert.equal(result.futureAuthEnabled, false);
    assert.equal(result.authConfigured, false);
    assert.match(result.issues.join(" "), /MOA_GATEWAY_TOKEN/);
  }
});

test("remote mode rejects the local token bypass even when otherwise configured", () => {
  const result = resolveRemoteMode({
    MOA_MODE: "hosted", DATABASE_URL: "db", MOA_GATEWAY_TOKEN: "token",
    ALLOW_AGENT_WITHOUT_TOKEN: "1",
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues, ["hosted mode cannot use ALLOW_AGENT_WITHOUT_TOKEN=1"]);
});

test("invalid and blank modes fail closed or normalize to local", () => {
  const invalid = resolveRemoteMode({ MOA_MODE: "EDGE MODE" });
  assert.equal(invalid.mode, "edge-mode");
  assert.equal(invalid.remote, false);
  assert.equal(invalid.valid, false);
  assert.match(invalid.issues[0], /local, self-host, hosted/);

  for (const value of ["", "   ", null, undefined]) {
    assert.equal(resolveRemoteMode({ MOA_MODE: value }).mode, "local");
  }
});
