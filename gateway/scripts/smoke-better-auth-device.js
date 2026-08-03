#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");

const origin = required("MOA_AUTH_SMOKE_ORIGIN").replace(/\/$/, "");
const email = required("MOA_AUTH_SMOKE_EMAIL").toLowerCase();
const password = required("MOA_AUTH_SMOKE_PASSWORD");
const clientId = process.env.MOA_AUTH_SMOKE_CLIENT_ID || "ag-macos";

main().catch((error) => {
  console.error(`better-auth device smoke failed: ${bounded(error?.message)}`);
  process.exitCode = 1;
});

async function main() {
  let signIn = await request("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Ag Preview Owner", email, password },
  });
  if (!signIn.ok) {
    signIn = await request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password },
    });
  }
  assert.equal(signIn.ok, true, `owner sign-in returned ${signIn.status}`);
  const cookie = sessionCookie(signIn.headers);
  assert.ok(cookie, "owner sign-in did not issue a session cookie");

  const codeResponse = await request("/api/auth/device/code", {
    method: "POST",
    body: { client_id: clientId, scope: "openid profile email" },
  });
  assert.equal(codeResponse.ok, true, `device code returned ${codeResponse.status}`);
  const code = await codeResponse.json();
  assert.match(String(code.device_code || ""), /^[A-Za-z0-9_-]{16,128}$/);
  assert.match(String(code.user_code || "").replace(/-/g, ""), /^[A-Z2-9]{6,16}$/);

  const userCode = String(code.user_code).replace(/-/g, "").toUpperCase();
  const claim = await request(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`, {
    headers: { cookie },
  });
  assert.equal(claim.ok, true, `device claim returned ${claim.status}`);

  const approval = await request("/api/auth/device/approve", {
    method: "POST",
    headers: { cookie },
    body: { userCode },
  });
  assert.equal(approval.ok, true, `device approval returned ${approval.status}`);

  const tokenResponse = await request("/api/auth/device/token", {
    method: "POST",
    body: {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: code.device_code,
      client_id: clientId,
    },
  });
  assert.equal(tokenResponse.ok, true, `device token returned ${tokenResponse.status}`);
  const tokenPayload = await tokenResponse.json();
  const accessToken = String(tokenPayload.access_token || "");
  assert.ok(accessToken.length >= 24, "device token is missing or too short");

  const authHeaders = { authorization: `Bearer ${accessToken}` };
  const session = await request("/api/auth/get-session", { headers: authHeaders });
  assert.equal(session.ok, true, `device session returned ${session.status}`);
  const sessionPayload = await session.json();
  assert.equal(String(sessionPayload?.user?.email || "").toLowerCase(), email);

  const protectedRead = await request("/v1/supervisor/status", { headers: authHeaders });
  assert.equal(protectedRead.ok, true, `protected gateway read returned ${protectedRead.status}`);
  const voiceTicket = await request("/v1/voice/session-ticket", {
    method: "POST", headers: authHeaders, body: {},
  });
  assert.equal(voiceTicket.ok, true, `voice ticket returned ${voiceTicket.status}`);
  const voicePayload = await voiceTicket.json();
  assert.ok(String(voicePayload.ticket || "").length >= 24, "voice ticket is missing");

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "owner session established",
      "device code claimed and approved",
      "device bearer authenticated a protected gateway read",
      "device bearer minted a voice WebSocket ticket",
    ],
  }, null, 2));
}

async function request(path, options = {}) {
  // Better Auth rejects state-changing browser routes without an allowed
  // Origin. Model the real sign-in/device browser instead of bypassing its
  // CSRF boundary in the deployment smoke.
  const headers = { origin, ...(options.headers || {}) };
  let body;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  return fetch(`${origin}${path}`, {
    method: options.method || "GET",
    headers,
    body,
    redirect: "error",
  });
}

function sessionCookie(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie() : [headers.get("set-cookie") || ""];
  return values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function bounded(value) {
  return String(value || "unknown error").replace(/[\r\n\t]/g, " ").slice(0, 300);
}
