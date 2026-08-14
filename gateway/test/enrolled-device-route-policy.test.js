"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  enforceEnrolledDeviceHttpAccess,
  enforceEnrolledDeviceWebSocketAccess,
  enrolledDeviceHttpAccess,
  enrolledDeviceWebSocketAccess,
} = require("../lib/enrolled-device-route-policy");

const ALL_SCOPES = [
  "continuity.read",
  "conversation.read",
  "conversation.write",
  "profile.read",
  "release.read",
  "device.receipts.write",
];

function deviceRequest(method, pathname, scopes = ALL_SCOPES) {
  return {
    request: {
      method,
      moaAuthPrincipal: { kind: "enrolled_device", user_id: "owner", scopes },
    },
    url: { pathname },
  };
}

test("enrolled Device credentials retain Android chat, voice, history, and release access", () => {
  for (const [method, pathname] of [
    ["POST", "/v1/chat"],
    ["POST", "/v1/voice/turns"],
    ["POST", "/v1/voice/session-ticket"],
    ["GET", "/v1/sessions/default"],
    ["GET", "/v1/sessions/session_1/messages"],
    ["GET", "/v1/release-control/apps/chief-moa/view"],
    ["POST", "/v1/release-control/apps/chief-moa/candidate-selections"],
    ["POST", "/v1/release-control/apps/chief-moa/fallback"],
    ["GET", "/v1/android/updates/latest"],
    ["GET", "/v1/android/updates/releases/ag.companion-1.apk"],
  ]) {
    const access = enrolledDeviceHttpAccess(...Object.values(deviceRequest(method, pathname)));
    assert.equal(access.allowed, true, `${method} ${pathname}`);
  }
});

test("enrolled Device credentials receive 403 policy decisions for agent and development execution", () => {
  for (const [method, pathname] of [
    ["POST", "/v1/agent/runs"],
    ["POST", "/v1/agent/runs/run_1/followups"],
    ["POST", "/v1/development/intents/intent_1/dispatch"],
    ["POST", "/v1/development/intents"],
    ["POST", "/v1/agent/workers/registrations"],
    ["POST", "/v1/internal/voice/reason"],
    ["POST", "/v1/android/updates/rollback"],
    ["POST", "/v1/device-credentials/registrations"],
    ["GET", "/v1/supervisor/report"],
  ]) {
    const access = enrolledDeviceHttpAccess(...Object.values(deviceRequest(method, pathname)));
    assert.equal(access.applies, true, `${method} ${pathname}`);
    assert.equal(access.allowed, false, `${method} ${pathname}`);
    assert.equal(access.reason, "route_not_allowed", `${method} ${pathname}`);
  }
});

test("HTTP enforcement returns 403 before agent launch or development dispatch handlers", () => {
  for (const pathname of [
    "/v1/agent/runs",
    "/v1/development/intents/intent_1/dispatch",
  ]) {
    const { request, url } = deviceRequest("POST", pathname);
    const responses = [];
    assert.equal(enforceEnrolledDeviceHttpAccess(request, {}, url,
      (_response, status, body) => responses.push({ status, body })), true);
    assert.deepEqual(responses, [{
      status: 403,
      body: { error: "enrolled_device_route_forbidden", reason: "route_not_allowed" },
    }]);
  }
});

test("enrolled Device route policy enforces the route-specific scope", () => {
  const chat = deviceRequest("POST", "/v1/chat", ["conversation.read"]);
  assert.deepEqual(enrolledDeviceHttpAccess(chat.request, chat.url), {
    applies: true,
    allowed: false,
    reason: "scope_not_granted",
    required_scopes: ["conversation.write"],
  });

  const release = deviceRequest("GET", "/v1/release-control/apps/chief-moa/view", ["conversation.read"]);
  assert.equal(enrolledDeviceHttpAccess(release.request, release.url).allowed, false);
});

test("legacy bearer and Better Auth principals are unaffected", () => {
  for (const principal of [undefined, { kind: "browser_session", user_id: "owner" }]) {
    const access = enrolledDeviceHttpAccess(
      { method: "POST", moaAuthPrincipal: principal },
      { pathname: "/v1/agent/runs" },
    );
    assert.deepEqual(access, {
      applies: false,
      allowed: true,
      reason: "different_principal",
      required_scopes: [],
    });
  }
});

test("voice WebSocket requires the exact endpoint and both conversation scopes", () => {
  const valid = deviceRequest("GET", "/v1/voice/sessions");
  assert.equal(enrolledDeviceWebSocketAccess(valid.request, valid.url).allowed, true);

  const missingWrite = deviceRequest("GET", "/v1/voice/sessions", ["conversation.read"]);
  assert.deepEqual(enrolledDeviceWebSocketAccess(missingWrite.request, missingWrite.url), {
    applies: true,
    allowed: false,
    reason: "scope_not_granted",
    required_scopes: ["conversation.read", "conversation.write"],
  });

  const wrongEndpoint = deviceRequest("GET", "/v1/agent/runs");
  assert.equal(enrolledDeviceWebSocketAccess(wrongEndpoint.request, wrongEndpoint.url).allowed, false);
});

test("WebSocket enforcement emits 403 for a Device principal without voice scopes", () => {
  const { request, url } = deviceRequest("GET", "/v1/voice/sessions", ["conversation.read"]);
  const rejections = [];
  assert.equal(enforceEnrolledDeviceWebSocketAccess(request, {}, url,
    (_socket, status, message) => rejections.push({ status, message })), true);
  assert.deepEqual(rejections, [{ status: 403, message: "Forbidden" }]);
});
