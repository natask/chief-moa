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
