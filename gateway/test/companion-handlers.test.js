"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createCompanionHandlers } = require("../lib/companion-handlers");

function makeHarness(overrides = {}) {
  const catalog = {
    version: "companions/v1", list: (input) => [{ id: "pet_1", input }],
    createDraft: (input) => ({ id: "pet_1", ...input }),
    preview: (input) => ({ companion: { id: input.companion_id || "pet_1" }, profile_overrides: { voice: "Kore" } }),
    ...(overrides.companionCatalog || {}),
  };
  const profile = {
    effective: () => ({ active_companion_id: "pet_1", voice: "Aoede" }),
    effectiveWithOverrides: () => ({ voice: "Kore" }), currentVersion: () => 7,
    ...(overrides.agentProfile || {}),
  };
  const authority = {
    preview: (body) => ({ authority: "preview", body }),
    apply: (body) => ({ authority: "apply", body }),
    rollback: (body) => ({ authority: "rollback", body }),
    ...(overrides.companionRuntimeAuthority || {}),
  };
  const deps = {
    companionCatalog: catalog, agentProfile: profile, companionRuntimeAuthority: authority,
    authorizedAgent: () => true, agentAuthError: () => ({ error: "unauthorized" }),
    readJsonBody: async (request) => request.body,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    cleanError: (error) => error.message,
    activeCompanionPayload: (value) => ({ id: value.active_companion_id }),
    profileOptionsFromBody: (body, scope) => ({ scope, deviceId: body?.device_id || "" }),
    requireDeviceScope: () => true,
    agentProfileRuntimeStatus: () => ({ status: "ready" }),
    summarizePreviewProfile: (before, after) => ({ before: before.voice, after: after.voice }),
    applyCompanionToProfile: (body, options, source) => ({ body, options, source }),
    ...overrides, companionCatalog: catalog, agentProfile: profile, companionRuntimeAuthority: authority,
  };
  return createCompanionHandlers(deps);
}

async function route(harness, method, pathname, body, query = "") {
  const response = {};
  const handled = await harness.routeCompanions({ method, body }, response, new URL(`https://test${pathname}${query}`));
  return { handled, response };
}

test("catalog lists bounded queries and active companion evidence", async () => {
  const harness = makeHarness();
  const result = await route(harness, "GET", "/v1/agent/companions", null, "?query=owl&limit=4");
  assert.equal(result.response.payload.query, "owl");
  assert.deepEqual(result.response.payload.companions[0].input, { query: "owl", limit: 4 });
  assert.equal(result.response.payload.active_companion.id, "pet_1");
  const defaults = harness.catalogPayload(undefined);
  assert.equal(defaults.query, "");
  assert.equal(defaults.endpoints.apply, "/v1/agent/companions/apply");
  const empty = makeHarness({ agentProfile: { effective: () => ({}) } }).catalogPayload(new URL("https://test/?q=x"));
  assert.equal(empty.active_companion_id, "");
});

test("create accepts legacy prompt aliases and remains preview-only", async () => {
  for (const body of [{ text: "a" }, { request: "b" }, { prompt: "c" }, { description: "d", name: "Moa", voice: "Kore", rules: [] }, {}]) {
    const result = await route(makeHarness(), "POST", "/v1/agent/companions", body);
    assert.equal(result.response.status, 201);
    assert.equal(result.response.payload.active_profile_mutated, false);
  }
  const broken = makeHarness({ companionCatalog: { createDraft: () => { throw new Error("invalid"); } } });
  assert.deepEqual((await route(broken, "POST", "/v1/agent/companions", {})).response,
    { status: 400, payload: { error: "invalid" } });
});

test("plain preview reports profile evidence and not-found errors", async () => {
  const result = await route(makeHarness(), "POST", "/v1/agent/companions/preview", { companion_id: "pet_1" });
  assert.equal(result.response.status, 200);
  assert.equal(result.response.payload.mutates_profile, false);
  assert.deepEqual(result.response.payload.profile_preview, { before: "Aoede", after: "Kore" });
  const broken = makeHarness({ companionCatalog: { preview: () => { throw new Error("missing"); } } });
  assert.equal((await route(broken, "POST", "/v1/agent/companions/preview", {})).response.status, 404);
});

test("signed preview is profile-version bound and authority errors are typed", async () => {
  for (const key of ["package_base64", "package", "approval_binding"]) {
    const result = await route(makeHarness(), "POST", "/v1/agent/companions/preview", { [key]: "value", device_id: "dev" });
    assert.equal(result.response.payload.authority, "preview");
    assert.equal(result.response.payload.body.expected_profile_version, "7");
  }
  const stale = await route(makeHarness(), "POST", "/v1/agent/companions/preview", { package: "x", expected_profile_version: "6" });
  assert.equal(stale.response.status, 400);
  const coded = Object.assign(new Error("rejected"), { code: "bad_signature" });
  const broken = makeHarness({ companionRuntimeAuthority: { preview: () => { throw coded; } } });
  assert.equal((await route(broken, "POST", "/v1/agent/companions/preview", { package: "x" })).response.payload.code, "bad_signature");
});

test("plain and signed apply preserve separate authorities and device scope", async () => {
  const plain = await route(makeHarness(), "POST", "/v1/agent/companions/apply", { companion_id: "pet_1", source: "studio" });
  assert.equal(plain.response.payload.source, "studio");
  for (const key of ["package_base64", "package", "approval_binding", "package_digest"]) {
    const result = await route(makeHarness(), "POST", "/v1/agent/companions/apply", { [key]: "x" });
    assert.equal(result.response.payload.authority, "apply");
  }
  const denied = makeHarness({ requireDeviceScope: (response) => { response.denied = true; return false; } });
  assert.equal((await route(denied, "POST", "/v1/agent/companions/apply", {})).response.denied, true);
  const missing = makeHarness({ applyCompanionToProfile: () => { throw new Error("missing"); } });
  assert.equal((await route(missing, "POST", "/v1/agent/companions/apply", {})).response.status, 404);
  const rejected = makeHarness({ companionRuntimeAuthority: { apply: () => { throw new Error("approval missing"); } } });
  assert.equal((await route(rejected, "POST", "/v1/agent/companions/apply", { package: "x" })).response.status, 409);
});

test("rollback is authority-owned and preserves coded failures", async () => {
  assert.equal((await route(makeHarness(), "POST", "/v1/agent/companions/rollback", { receipt: "r" })).response.payload.authority, "rollback");
  const error = Object.assign(new Error("stale"), { code: "stale_receipt" });
  const broken = makeHarness({ companionRuntimeAuthority: { rollback: () => { throw error; } } });
  const result = await route(broken, "POST", "/v1/agent/companions/rollback", {});
  assert.equal(result.response.status, 409); assert.equal(result.response.payload.code, "stale_receipt");
});

test("all routes authorize and unrelated combinations fall through", async () => {
  const denied = makeHarness({ authorizedAgent: () => false });
  for (const [method, path] of [["GET", "/v1/agent/companions"], ["POST", "/v1/agent/companions"],
    ["POST", "/v1/agent/companions/preview"], ["POST", "/v1/agent/companions/apply"], ["POST", "/v1/agent/companions/rollback"]]) {
    const result = await route(denied, method, path, {}); assert.equal(result.handled, true); assert.equal(result.response.status, 401);
  }
  const harness = makeHarness();
  assert.equal((await route(harness, "DELETE", "/v1/agent/companions", {})).handled, false);
  assert.equal((await route(harness, "GET", "/v1/agent/companions/preview", {})).handled, false);
  assert.equal((await route(harness, "POST", "/v1/agent/other", {})).handled, false);
});
