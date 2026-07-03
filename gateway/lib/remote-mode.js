"use strict";

const VALID_MODES = new Set(["local", "self-host", "hosted"]);
const TOKEN_AUTH_MODES = new Set(["", "token", "gateway-token", "legacy-token", "bearer"]);

function resolveRemoteMode(env = process.env) {
  const mode = normalizeMode(env.MOA_MODE || "local");
  const authMode = String(env.MOA_AUTH || "").trim().toLowerCase();
  const remote = mode === "self-host" || mode === "hosted";
  const databaseConfigured = Boolean(String(env.DATABASE_URL || "").trim());
  const tokenConfigured = Boolean(String(env.MOA_GATEWAY_TOKEN || "").trim());
  const futureAuthEnabled = Boolean(authMode) && !TOKEN_AUTH_MODES.has(authMode);
  const issues = [];

  if (!VALID_MODES.has(mode)) {
    issues.push(`MOA_MODE must be one of: ${Array.from(VALID_MODES).join(", ")}`);
  }
  if (remote && !databaseConfigured) {
    issues.push(`${mode} mode requires DATABASE_URL`);
  }
  if (remote && !tokenConfigured && !futureAuthEnabled) {
    issues.push(`${mode} mode requires MOA_GATEWAY_TOKEN unless MOA_AUTH enables a future auth mode`);
  }
  if (remote && env.ALLOW_AGENT_WITHOUT_TOKEN === "1") {
    issues.push(`${mode} mode cannot use ALLOW_AGENT_WITHOUT_TOKEN=1`);
  }

  const authConfigured = tokenConfigured || futureAuthEnabled;
  return {
    mode,
    remote,
    local: mode === "local",
    valid: issues.length === 0,
    issues,
    defaultHost: remote ? "0.0.0.0" : "127.0.0.1",
    trustProxy: remote ? env.MOA_TRUST_PROXY !== "0" : env.MOA_TRUST_PROXY === "1",
    databaseRequired: remote,
    databaseConfigured,
    tokenConfigured,
    authMode: authMode || "gateway-token",
    futureAuthEnabled,
    authConfigured,
    workerPullDefault: remote,
    protectedRoutesOpenWithoutToken: !remote && !tokenConfigured,
    health() {
      return {
        mode,
        remote,
        auth_mode: authMode || "gateway-token",
        auth_configured: authConfigured,
        token_auth_configured: tokenConfigured,
        future_auth_enabled: futureAuthEnabled,
        database_required: remote,
        database_configured: databaseConfigured,
        trust_proxy: this.trustProxy,
        default_host: this.defaultHost,
        worker_pull_default: this.workerPullDefault,
      };
    },
  };
}

function normalizeMode(value) {
  const mode = String(value || "local").trim().toLowerCase().replace(/_/g, "-");
  if (mode === "selfhost") return "self-host";
  return mode || "local";
}

module.exports = { resolveRemoteMode };
