"use strict";

// Google OAuth token minting shared by the voice providers and the blob
// store. Extracted verbatim from lib/voice-providers.js: a service_account
// key exchanges a signed JWT, an authorized_user ADC exchanges its refresh
// token — both directly against oauth2.googleapis.com, no gcloud binary
// needed in the container.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

async function serviceAccountAccessToken(serviceAccountKeyJson) {
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountKeyJson);
  } catch (error) {
    throw new Error(`invalid GCP service account JSON: ${cleanError(error)}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: serviceAccount.private_key_id,
  };
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    scope: "https://www.googleapis.com/auth/cloud-platform",
  };
  const unsigned = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), serviceAccount.private_key);
  const assertion = `${unsigned}.${base64url(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GCP token exchange failed (${response.status}): ${cleanError(text)}`);
  }
  const token = await response.json();
  return {
    value: String(token.access_token || ""),
    expiresAt: Date.now() + Math.max(1, Number(token.expires_in || 3600)) * 1000,
  };
}

// Mirrors googleCredentialFile in server.js, but reads from the caller's env
// so tests can inject credentials without touching process.env.
function googleCredentialFile(env) {
  const explicit = env.GOOGLE_APPLICATION_CREDENTIALS || "";
  if (explicit && fs.existsSync(explicit)) return explicit;
  const adc = path.join(env.HOME || "", ".config", "gcloud", "application_default_credentials.json");
  return fs.existsSync(adc) ? adc : "";
}

// ADC files come in two shapes: a service_account key (signed-JWT exchange)
// and an authorized_user refresh token from `gcloud auth application-default
// login`.
async function adcAccessToken(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`failed to read Google ADC file: ${cleanError(error)}`);
  }
  let credential;
  try {
    credential = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid Google ADC JSON: ${cleanError(error)}`);
  }
  if (credential.type === "service_account") {
    return serviceAccountAccessToken(raw);
  }
  if (credential.type === "authorized_user") {
    return authorizedUserAccessToken(credential);
  }
  throw new Error(`unsupported Google ADC credential type: ${credential.type || "missing"}`);
}

async function authorizedUserAccessToken(credential) {
  const missing = ["client_id", "client_secret", "refresh_token"].filter((key) => !credential[key]);
  if (missing.length > 0) {
    throw new Error(`authorized-user ADC is missing ${missing.join(", ")}`);
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credential.client_id,
      client_secret: credential.client_secret,
      refresh_token: credential.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`authorized-user token refresh failed (${response.status}): ${cleanError(text)}`);
  }
  const token = await response.json();
  return {
    value: String(token.access_token || ""),
    expiresAt: Date.now() + Math.max(1, Number(token.expires_in || 3600)) * 1000,
  };
}

// Cached token source for callers that just need "a valid Bearer token".
// Credential order matches the Chirp provider: inline service-account JSON
// first (GCS_SERVICE_ACCOUNT_KEY, then GCP_SERVICE_ACCOUNT_KEY), then the
// GOOGLE_APPLICATION_CREDENTIALS / gcloud ADC file. `credentialType()`
// exposes the ADC shape so callers can decide whether a quota project
// header is needed (authorized_user tokens bill a user project).
function createGoogleTokenSource(options = {}) {
  const env = options.env || process.env;
  let cache = { value: "", expiresAt: 0 };
  let cachedType = "";

  function inlineKey() {
    return String(env.GCS_SERVICE_ACCOUNT_KEY || env.GCP_SERVICE_ACCOUNT_KEY || "").trim();
  }

  function credentialType() {
    if (cachedType) return cachedType;
    if (inlineKey()) {
      cachedType = "service_account";
      return cachedType;
    }
    const file = googleCredentialFile(env);
    if (!file) return "";
    try {
      cachedType = String(JSON.parse(fs.readFileSync(file, "utf8")).type || "");
    } catch {
      cachedType = "";
    }
    return cachedType;
  }

  async function token() {
    if (cache.value && cache.expiresAt > Date.now() + 60000) {
      return cache.value;
    }
    const keyJson = inlineKey();
    if (keyJson) {
      cache = await serviceAccountAccessToken(keyJson);
      return cache.value;
    }
    const file = googleCredentialFile(env);
    if (!file) {
      throw new Error(
        "no Google credentials found: set GCS_SERVICE_ACCOUNT_KEY, GCP_SERVICE_ACCOUNT_KEY, or GOOGLE_APPLICATION_CREDENTIALS",
      );
    }
    cache = await adcAccessToken(file);
    return cache.value;
  }

  return { token, credentialType };
}

function base64urlJson(value) {
  return base64url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}

module.exports = {
  adcAccessToken,
  authorizedUserAccessToken,
  base64url,
  base64urlJson,
  createGoogleTokenSource,
  googleCredentialFile,
  serviceAccountAccessToken,
};
