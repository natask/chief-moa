"use strict";

const ENROLLED_DEVICE_KIND = "enrolled_device";

function enrolledDeviceHttpAccess(request = {}, url = {}) {
  const principal = request.moaAuthPrincipal;
  if (principal?.kind !== ENROLLED_DEVICE_KIND) return unaffected();
  const method = String(request.method || "GET").toUpperCase();
  const pathname = String(url.pathname || "");

  const rule = httpRule(method, pathname);
  if (!rule) return denied("route_not_allowed");
  return hasScopes(principal, rule.scopes)
    ? allowed()
    : denied("scope_not_granted", rule.scopes);
}

function enrolledDeviceWebSocketAccess(request = {}, url = {}) {
  const principal = request.moaAuthPrincipal;
  if (principal?.kind !== ENROLLED_DEVICE_KIND) return unaffected();
  if (String(url.pathname || "") !== "/v1/voice/sessions") {
    return denied("route_not_allowed");
  }
  const scopes = ["conversation.read", "conversation.write"];
  return hasScopes(principal, scopes)
    ? allowed()
    : denied("scope_not_granted", scopes);
}

function enforceEnrolledDeviceHttpAccess(request, response, url, sendJson) {
  const access = enrolledDeviceHttpAccess(request, url);
  if (!access.applies || access.allowed) return false;
  sendJson(response, 403, {
    error: "enrolled_device_route_forbidden",
    reason: access.reason,
  });
  return true;
}

function enforceEnrolledDeviceWebSocketAccess(request, socket, url, rejectUpgrade) {
  const access = enrolledDeviceWebSocketAccess(request, url);
  if (!access.applies || access.allowed) return false;
  rejectUpgrade(socket, 403, "Forbidden");
  return true;
}

function httpRule(method, pathname) {
  if (method === "GET" && pathname === "/health") return rule();
  if (method === "GET" && pathname === "/v1/device-enrollments/continuity") {
    return rule("continuity.read");
  }
  if (method === "POST" && pathname === "/v1/device-credentials/current/revoke") {
    return rule();
  }
  if (method === "GET" && (
    pathname === "/v1/release-recovery/manifest"
      || /^\/v1\/release-recovery\/artifacts\/[^/]+\.apk$/.test(pathname)
  )) return rule("release.recovery.read");
  if ((method === "GET" || method === "POST")
      && pathname === "/v1/development-requests") return rule("development.request");
  if (method === "GET" && /^\/v1\/development-requests\/[^/]+$/.test(pathname)) {
    return rule("development.request");
  }
  if (method === "POST" && /^\/v1\/development-requests\/[^/]+\/rename$/.test(pathname)) {
    return rule("development.request");
  }
  if (pathname.startsWith("/v1/release-control/apps/")) return rule("release.read");
  if (method === "GET" && pathname.startsWith("/v1/android/updates/")) {
    return rule("release.read");
  }

  if (method === "POST" && [
    "/v1/chat",
    "/v1/voice/turns",
    "/v1/voice/session-ticket",
    "/v1/voice/livekit/token",
    "/v1/voice/frames",
    "/v1/threads/switch",
    "/v1/audio-notes",
  ].includes(pathname)) return rule("conversation.write");

  if (method === "POST" && pathname.startsWith("/v1/voice/turns/")
      && pathname.endsWith("/retranscribe")) return rule("conversation.write");

  if (method === "GET" && (
    pathname === "/v1/sessions"
      || pathname.startsWith("/v1/sessions/")
      || pathname.startsWith("/v1/conversations/")
      || pathname === "/v1/history/messages"
      || pathname === "/v1/context/latest"
      || pathname === "/v1/threads"
      || pathname === "/v1/threads/active"
      || pathname === "/v1/voice/turns"
      || pathname.startsWith("/v1/voice/turns/")
      || pathname.startsWith("/v1/voice/audio/")
      || pathname === "/v1/voice/diagnosis"
  )) return rule("conversation.read");

  if (method === "GET" && (
    pathname === "/v1/voice/mode"
      || pathname === "/v1/voice/mode/versions"
      || pathname === "/v1/agent/profile"
      || pathname === "/v1/agent/profile/options"
      || pathname === "/v1/agent/provider-catalog"
  )) return rule("profile.read");

  return null;
}

function rule(...scopes) {
  return Object.freeze({ scopes: Object.freeze(scopes) });
}

function hasScopes(principal, required) {
  const granted = new Set(Array.isArray(principal?.scopes) ? principal.scopes.map(String) : []);
  return required.every((scope) => granted.has(scope));
}

function unaffected() {
  return Object.freeze({ applies: false, allowed: true, reason: "different_principal", required_scopes: Object.freeze([]) });
}

function allowed() {
  return Object.freeze({ applies: true, allowed: true, reason: "allowed", required_scopes: Object.freeze([]) });
}

function denied(reason, requiredScopes = []) {
  return Object.freeze({
    applies: true,
    allowed: false,
    reason,
    required_scopes: Object.freeze([...requiredScopes]),
  });
}

module.exports = {
  enforceEnrolledDeviceHttpAccess,
  enforceEnrolledDeviceWebSocketAccess,
  enrolledDeviceHttpAccess,
  enrolledDeviceWebSocketAccess,
};
