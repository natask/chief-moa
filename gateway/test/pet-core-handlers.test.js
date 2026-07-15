"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createPetCoreHandlers } = require("../lib/pet-core-handlers");

function makeHarness(overrides = {}) {
  const calls = [];
  const catalog = {
    createDraft: (input) => ({ id: "pet_1", ...input }),
    preview: (input) => ({ companion: { id: input.companion_id || "pet_1" }, profile_overrides: { voice: "Kore" } }),
    ...(overrides.companionCatalog || {}),
  };
  for (const name of ["createDraft", "preview"]) {
    const fn = catalog[name]; catalog[name] = (...args) => { calls.push([name, ...args]); return fn(...args); };
  }
  const agentProfile = {
    effective: () => ({ voice: "Aoede" }),
    effectiveWithOverrides: (_patch) => ({ voice: "Kore" }),
    currentVersion: () => 7,
    ...(overrides.agentProfile || {}),
  };
  const deps = {
    companionCatalog: catalog, agentProfile, catalogVersion: "pets/v1",
    authorizedAgent: () => true, agentAuthError: () => ({ error: "unauthorized" }),
    readJsonBody: async (request) => request.body,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    cleanError: (error) => error.message,
    catalogPayload: (url) => ({ catalog: url.searchParams.get("q") || "" }),
    activePetPayload: (options) => ({ active: options }),
    profileOptionsFromUrl: (url) => ({ deviceId: url.searchParams.get("device_id") || "" }),
    profileOptionsFromBody: (body, scope) => ({ deviceId: body?.device_id || "", scope }),
    requireDeviceScope: () => true,
    petInputFromBody: (body) => ({ species: body?.species || "bird" }),
    manifestV2FieldsFromBody: () => ({ manifest_version: 2 }),
    companionPetRecord: (value) => ({ record_id: value.id }),
    petPreviewPayload: (value) => ({ rendered: value.companion.id }),
    companionInputFromPetBody: (body) => ({ companion_id: body.companion_id || "pet_1" }),
    agentProfileRuntimeStatus: () => ({ status: "ready" }),
    summarizePreviewProfile: (before, after) => ({ before: before.voice, after: after.voice }),
    applyCompanionToProfile: (input, options, source, extra) => ({ companion: { id: input.companion_id }, options, source, extra }),
    canonicalVoice: (voice) => voice === "Kore" ? "Kore" : "",
    petGenerationPlan: (body) => ({ prompt: body.prompt || "default" }),
    petGenerationConfigured: () => false,
    callVertexPetImage: async () => ({ image_data_url: "data:image/png;base64,AA==" }),
    ...overrides, companionCatalog: catalog, agentProfile,
  };
  return { ...createPetCoreHandlers(deps), calls };
}

async function route(harness, method, pathname, body, query = "") {
  const response = {};
  const handled = await harness.routePetCore({ method, body }, response, new URL(`https://test${pathname}${query}`));
  return { handled, response };
}

test("catalog and active routes retain query and profile scope adapters", async () => {
  const harness = makeHarness();
  assert.deepEqual((await route(harness, "GET", "/v1/agent/pets", null, "?q=owl")).response.payload, { catalog: "owl" });
  assert.deepEqual((await route(harness, "GET", "/v1/agent/pets/active", null, "?device_id=dev_1")).response.payload,
    { active: { deviceId: "dev_1" } });
});

test("create accepts every legacy text and image alias without applying", async () => {
  const harness = makeHarness();
  for (const body of [
    { text: "a", image_data_url: "i1" }, { request: "b", imageDataUrl: "i2" },
    { prompt: "c", source_image: "i3" }, { description: "d", sourceImage: "i4", name: "Moa", voice: "Kore", rules: [], species: "owl" }, {},
  ]) {
    const result = await route(harness, "POST", "/v1/agent/pets", body);
    assert.equal(result.response.status, 201);
    assert.equal(result.response.payload.active_profile_mutated, false);
  }
  assert.equal(harness.calls.filter(([name]) => name === "preview").length, 5);
  const broken = makeHarness({ companionCatalog: { createDraft: () => { throw new Error("invalid pet"); } } });
  assert.deepEqual((await route(broken, "POST", "/v1/agent/pets", {})).response,
    { status: 400, payload: { error: "invalid pet" } });
});

test("preview returns bounded profile evidence and preserves not-found errors", async () => {
  const harness = makeHarness();
  const result = await route(harness, "POST", "/v1/agent/pets/preview", { companion_id: "pet_2", device_id: "dev" });
  assert.equal(result.response.status, 200);
  assert.equal(result.response.payload.profile_version, 7);
  assert.deepEqual(result.response.payload.profile_preview, { before: "Aoede", after: "Kore" });
  const broken = makeHarness({ companionInputFromPetBody: () => { throw new Error("agent not found"); } });
  assert.deepEqual((await route(broken, "POST", "/v1/agent/pets/preview", {})).response,
    { status: 404, payload: { error: "agent not found" } });
});

test("apply enforces device scope and canonicalizes optional voice", async () => {
  for (const body of [{ companion_id: "pet_1" }, { companion_id: "pet_1", voice: "Kore", source: "dashboard" }, { companion_id: "pet_1", voice: "unknown" }]) {
    const harness = makeHarness();
    const result = await route(harness, "POST", "/v1/agent/pets/apply", body);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.response.payload.extra, body.voice === "Kore" ? { voice: "Kore" } : {});
    assert.equal(result.response.payload.source, body.source || "pet-studio");
  }
  const denied = makeHarness({ requireDeviceScope: (response) => { response.denied = true; return false; } });
  assert.equal((await route(denied, "POST", "/v1/agent/pets/apply", {})).response.denied, true);
  const broken = makeHarness({ applyCompanionToProfile: () => { throw new Error("missing"); } });
  assert.equal((await route(broken, "POST", "/v1/agent/pets/apply", {})).response.status, 404);
});

test("generation reports disabled, success, and provider failure without profile mutation", async () => {
  const disabled = await route(makeHarness(), "POST", "/v1/agent/pets/generate", { prompt: "owl" });
  assert.equal(disabled.response.payload.status, "not_configured");
  assert.equal(disabled.response.payload.mutates_profile, false);
  const live = makeHarness({ petGenerationConfigured: () => true });
  const generated = await route(live, "POST", "/v1/agent/pets/generate", { prompt: "owl" });
  assert.equal(generated.response.payload.status, "generated");
  assert.match(generated.response.payload.image_data_url, /^data:/);
  const failed = makeHarness({ petGenerationConfigured: () => true, callVertexPetImage: async () => { throw new Error("vertex down"); } });
  const failure = await route(failed, "POST", "/v1/agent/pets/generate", {});
  assert.equal(failure.response.status, 502);
  assert.equal(failure.response.payload.error, "vertex down");
});

test("all routes authorize and unrelated method/path combinations fall through", async () => {
  const denied = makeHarness({ authorizedAgent: () => false });
  for (const [method, path] of [
    ["GET", "/v1/agent/pets"], ["GET", "/v1/agent/pets/active"], ["POST", "/v1/agent/pets"],
    ["POST", "/v1/agent/pets/preview"], ["POST", "/v1/agent/pets/apply"], ["POST", "/v1/agent/pets/generate"],
  ]) {
    const result = await route(denied, method, path, {});
    assert.equal(result.handled, true); assert.equal(result.response.status, 401);
  }
  const harness = makeHarness();
  assert.equal((await route(harness, "DELETE", "/v1/agent/pets", {})).handled, false);
  assert.equal((await route(harness, "GET", "/v1/agent/pets/preview", {})).handled, false);
  assert.equal((await route(harness, "POST", "/v1/agent/other", {})).handled, false);
});
