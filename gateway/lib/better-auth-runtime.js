"use strict";

const AUTH_PATH = "/api/auth";

function createBetterAuthRuntime(env = process.env, options = {}) {
  const enabled = String(env.MOA_AUTH || "").trim().toLowerCase() === "better-auth";
  const ownerEmail = String(env.BETTER_AUTH_OWNER_EMAIL || "").trim().toLowerCase();
  let loaded;

  async function load() {
    if (!enabled) return null;
    if (!loaded) {
      loaded = typeof options.loadRuntime === "function"
        ? Promise.resolve().then(options.loadRuntime)
        : Promise.all([import("../auth.mjs"), import("better-auth/node")])
        .then(([module, node]) => ({
          auth: module.auth,
          handler: node.toNodeHandler(module.auth),
          fromNodeHeaders: node.fromNodeHeaders,
        }));
    }
    return loaded;
  }

  async function route(request, response, url) {
    if (!enabled || !url.pathname.startsWith(`${AUTH_PATH}/`)) return false;
    const runtime = await load();
    await runtime.handler(request, response);
    return true;
  }

  async function attachPrincipal(request) {
    if (!enabled) return null;
    const header = String(request.headers.authorization || "");
    const cookie = String(request.headers.cookie || "");
    if (!header.startsWith("Bearer ") && !cookie) return null;
    const runtime = await load();
    let session;
    try {
      session = await runtime.auth.api.getSession({ headers: runtime.fromNodeHeaders(request.headers) });
    } catch {
      return null;
    }
    if (!session?.user?.id || !session?.session?.id) return null;
    if (!ownerEmail || String(session.user.email || "").trim().toLowerCase() !== ownerEmail) return null;
    const principal = Object.freeze({
      user_id: "owner",
      auth_user_id: String(session.user.id),
      session_id: String(session.session.id),
      email: String(session.user.email || ""),
      kind: header.startsWith("Bearer ") ? "device_session" : "browser_session",
      ...recentAuthentication(session.session.createdAt),
    });
    request.moaAuthPrincipal = principal;
    return principal;
  }

  return { enabled, route, attachPrincipal };
}

function recentAuthentication(value) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp) || timestamp <= 0) return {};
  return { recent_auth_at: new Date(timestamp).toISOString() };
}

module.exports = { AUTH_PATH, createBetterAuthRuntime };
