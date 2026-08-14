"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AUTH_PATH, createBetterAuthRuntime } = require("../lib/better-auth-runtime");

test("better-auth runtime stays inert unless explicitly enabled", async () => {
  const runtime = createBetterAuthRuntime({ MOA_AUTH: "gateway-token" });
  assert.equal(runtime.enabled, false);
  assert.equal(await runtime.route({}, {}, new URL("https://ag.test/api/auth/get-session")), false);
  assert.equal(await runtime.attachPrincipal({ headers: {} }), null);
});

test("better-auth runtime recognizes only its bounded route prefix", async () => {
  const runtime = createBetterAuthRuntime({ MOA_AUTH: "better-auth" });
  assert.equal(runtime.enabled, true);
  assert.equal(AUTH_PATH, "/api/auth");
  assert.equal(await runtime.route({}, {}, new URL("https://ag.test/v1/chat")), false);
  assert.equal(await runtime.attachPrincipal({ headers: {} }), null);
});

test("principal recent auth comes only from trustworthy Better Auth session creation", async () => {
  const createdAt = new Date("2026-08-14T12:00:00.000Z");
  const runtime = createBetterAuthRuntime({
    MOA_AUTH: "better-auth",
    BETTER_AUTH_OWNER_EMAIL: "owner@example.com",
  }, {
    loadRuntime: async () => ({
      auth: { api: { getSession: async () => ({
        user: { id: "auth_owner", email: "owner@example.com" },
        session: { id: "session_1", createdAt },
      }) } },
      fromNodeHeaders: (headers) => headers,
      handler: async () => {},
    }),
  });
  const request = {
    headers: { cookie: "better-auth.session_token=trusted", "x-recent-auth-at": "2099-01-01" },
  };
  const principal = await runtime.attachPrincipal(request);
  assert.equal(principal.kind, "browser_session");
  assert.equal(principal.recent_auth_at, createdAt.toISOString());
  assert.notEqual(principal.recent_auth_at, request.headers["x-recent-auth-at"]);
});

test("missing or malformed server session creation time never asserts recent auth", async () => {
  for (const createdAt of [undefined, "invalid", new Date("invalid")]) {
    const runtime = createBetterAuthRuntime({
      MOA_AUTH: "better-auth", BETTER_AUTH_OWNER_EMAIL: "owner@example.com",
    }, {
      loadRuntime: async () => ({
        auth: { api: { getSession: async () => ({
          user: { id: "auth_owner", email: "owner@example.com" },
          session: { id: "session_1", createdAt },
        }) } },
        fromNodeHeaders: (headers) => headers,
        handler: async () => {},
      }),
    });
    const principal = await runtime.attachPrincipal({ headers: { cookie: "trusted" } });
    assert.equal(Object.hasOwn(principal, "recent_auth_at"), false);
  }
});
