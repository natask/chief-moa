"use strict";

// LiveKit voice-transport helpers (flag-gated PROTOTYPE).
//
// This module is the gateway side of the Option-A LiveKit spike: the gateway
// mints short-lived room tokens and a standalone agents-js worker (see
// ../../livekit_worker) joins the room and drives STT -> the gateway's existing
// reasoning -> the gateway's existing TTS through the /v1/internal/voice/* hooks.
// Clients still hold only a gateway URL + token; a room token is the same
// short-lived credential posture as the browser voice ticket.
//
// Everything here is inert unless LIVEKIT_URL + LIVEKIT_API_KEY +
// LIVEKIT_API_SECRET are all set, so the live cascaded WS pipeline stays the
// untouched default when the spike is not configured.

const DEFAULT_TOKEN_TTL_SECONDS = 600; // 10 minutes; a spike room token is short-lived.
const MIN_TOKEN_TTL_SECONDS = 30;
const MAX_TOKEN_TTL_SECONDS = 3600;

function livekitConfig(env = process.env) {
  const url = String(env.LIVEKIT_URL || "").trim();
  const apiKey = String(env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = String(env.LIVEKIT_API_SECRET || "").trim();
  return {
    url,
    apiKey,
    apiSecret,
    configured: Boolean(url && apiKey && apiSecret),
  };
}

function livekitConfigured(env = process.env) {
  return livekitConfig(env).configured;
}

// Non-secret health/status shape: reports whether the spike is wired and, when
// it is, the (already public) wss URL. Never exposes the API key or secret.
function livekitStatus(env = process.env) {
  const config = livekitConfig(env);
  return {
    enabled: config.configured,
    url: config.configured ? config.url : null,
    token_endpoint: "/v1/voice/livekit/token",
    internal_endpoints: [
      "/v1/internal/voice/reason",
      "/v1/internal/voice/synthesize",
      "/v1/internal/voice/turn-record",
    ],
    // Missing config is the expected default, not an error: the spike is opt-in.
    reason: config.configured ? "" : "LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must all be set",
  };
}

// One room per session/branch so a LiveKit turn shares the same thread identity
// the rest of the gateway uses. Sanitized to the safe LiveKit room charset.
function livekitRoomName(sessionId, branchId) {
  const session = sanitizeRoomPart(sessionId) || "default";
  const branch = sanitizeRoomPart(branchId) || "default";
  return `moa-${session}-${branch}`;
}

function sanitizeRoomPart(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
}

function clampTtlSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_TOKEN_TTL_SECONDS;
  }
  return Math.min(MAX_TOKEN_TTL_SECONDS, Math.max(MIN_TOKEN_TTL_SECONDS, Math.floor(seconds)));
}

// Mint a short-lived join token for the session/branch room. The identity is the
// caller's device/client id so turn records keep the same device attribution.
// livekit-server-sdk is required lazily so an unconfigured gateway never loads it.
async function mintRoomToken(options = {}) {
  const env = options.env || process.env;
  const config = livekitConfig(env);
  if (!config.configured) {
    throw new Error("livekit transport is not configured");
  }
  const { AccessToken } = require("livekit-server-sdk");
  const room = livekitRoomName(options.sessionId, options.branchId);
  const identity = String(options.identity || "").trim() || `moa-client-${Math.random().toString(36).slice(2, 10)}`;
  const ttlSeconds = clampTtlSeconds(options.ttlSeconds);
  const at = new AccessToken(config.apiKey, config.apiSecret, {
    identity,
    ttl: `${ttlSeconds}s`,
    metadata: options.metadata ? String(options.metadata).slice(0, 4000) : undefined,
  });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  const token = await at.toJwt();
  const now = Date.now();
  return {
    token,
    url: config.url,
    room,
    identity,
    ttl_seconds: ttlSeconds,
    expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
    expires_in_ms: ttlSeconds * 1000,
  };
}

module.exports = {
  DEFAULT_TOKEN_TTL_SECONDS,
  livekitConfig,
  livekitConfigured,
  livekitStatus,
  livekitRoomName,
  mintRoomToken,
};
