"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createPetSharingHandlers } = require("../lib/pet-sharing-handlers");

function makeHarness(overrides = {}) {
  const calls = [];
  const pets = new Map([
    ["pet 1", { id: "pet 1", visibility: "shared", voice_binding: { voice: "Kore" }, voice_clone: { status: "blocked" } }],
    ["pet_2", { id: "pet_2", visibility: "private" }],
  ]);
  const catalog = {
    get: (id) => pets.get(id) || null,
    listVoiceCloneJobs: (id) => id === "pet 1" ? [{ id: "job_1" }, { id: "job_2" }] : [],
    createVoiceCloneJob: (input) => ({ job: { id: "job_new", ...input }, companion: pets.get(input.companion_id) }),
    publishCompanion: ({ id }) => ({ ...pets.get(id), visibility: "shared" }),
    listShared: (input) => [{ ...pets.get("pet 1"), query: input.query }],
    ...(overrides.companionCatalog || {}),
  };
  for (const name of ["get", "listVoiceCloneJobs", "createVoiceCloneJob", "publishCompanion", "listShared"]) {
    const operation = catalog[name];
    catalog[name] = (...args) => { calls.push([name, ...args]); return operation(...args); };
  }
  const deps = {
    companionCatalog: catalog,
    catalogVersion: "pets/v1",
    voiceCloneMaxAudioBytes: 8,
    authorizedAgent: () => true,
    agentAuthError: () => ({ error: "unauthorized" }),
    readJsonBody: async (request) => request.body,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    cleanError: (error) => error.message,
    companionPetRecord: (pet) => ({ record_id: pet.id }),
    profileOptionsFromBody: (body, scope) => ({ device_id: body?.device_id, scope }),
    requireDeviceScope: () => true,
    applyCompanionToProfile: (input, options, source) => ({ companion: pets.get(input.companion_id), options, source }),
    liveVoiceClone: () => false,
    ...overrides,
    companionCatalog: catalog,
  };
  return { ...createPetSharingHandlers(deps), calls };
}

async function route(harness, method, pathname, body, query = "") {
  const response = {};
  const handled = await harness.routePetSharing(
    { method, body, headers: {} }, response, new URL(`https://gateway.test${pathname}${query}`),
  );
  return { handled, response };
}

test("shared library lists bounded query results and defaults", async () => {
  const harness = makeHarness();
  const result = await route(harness, "GET", "/v1/agent/pets/shared", null, "?query=owl&limit=4");
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 200);
  assert.equal(result.response.payload.query, "owl");
  assert.deepEqual(harness.calls[0], ["listShared", { query: "owl", limit: 4 }]);
  assert.equal(result.response.payload.pets[0].record_id, "pet 1");
  const defaults = harness.sharedPayload(undefined);
  assert.equal(defaults.query, "");
  assert.equal(defaults.endpoints.install, "/v1/agent/pets/install");
  assert.equal(harness.sharedPayload(new URL("https://gateway.test/?q=bird")).query, "bird");
});

test("clone references are bounded descriptors and never retain audio bytes", () => {
  const harness = makeHarness();
  const audio = harness.voiceCloneReferenceFromBody({ reference_audio_base64: "data:audio/wav;base64,YWJj" });
  assert.equal(audio.ok, true);
  assert.deepEqual(Object.keys(audio.record).sort(), ["audio_bytes", "audio_sha256", "kind"]);
  assert.equal(audio.record.audio_bytes, 3);
  assert.equal(harness.voiceCloneReferenceFromBody({ reference_audio_base64: "" }).ok, false);
  assert.match(harness.voiceCloneReferenceFromBody({ reference_audio_base64: Buffer.alloc(9).toString("base64") }).error, /8-byte cap/);
  assert.deepEqual(harness.voiceCloneReferenceFromBody({ reference_url: "https://example.test/sample.wav" }), {
    ok: true, record: { kind: "url", url: "https://example.test/sample.wav" },
  });
  assert.match(harness.voiceCloneReferenceFromBody({ reference_url: "://bad" }).error, /valid URL/);
  assert.match(harness.voiceCloneReferenceFromBody({ reference_url: "http://example.test" }).error, /https/);
  assert.match(harness.voiceCloneReferenceFromBody().error, /provide/);
});

test("voice clone requires a pet, explicit consent, and a valid reference", async () => {
  const harness = makeHarness();
  assert.deepEqual((await route(harness, "POST", "/v1/agent/pets/missing/voice-clone", {})).response,
    { status: 404, payload: { error: "companion not found" } });
  for (const consent of [undefined, [], { attested: false }]) {
    const result = await route(harness, "POST", "/v1/agent/pets/pet%201/voice-clone", { consent });
    assert.equal(result.response.status, 422);
    assert.match(result.response.payload.error, /attested/);
  }
  const missingReference = await route(harness, "POST", "/v1/agent/pets/pet%201/voice-clone", { consent: { attested: true } });
  assert.equal(missingReference.response.status, 422);
});

test("voice clone dry-run and live blockers remain explicit", async () => {
  for (const live of [false, true]) {
    const harness = makeHarness({ liveVoiceClone: () => live });
    const result = await route(harness, "POST", "/v1/agent/pets/pet%201/voice-clone", {
      consent: { attested: true, subject: live ? "Owner" : undefined },
      reference_url: "https://example.test/sample.wav",
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.response.payload.mutates_profile, false);
    assert.match(result.response.payload.blocker, live ? /not implemented/ : /allowlist-gated/);
    const input = harness.calls.find((call) => call[0] === "createVoiceCloneJob")[1];
    assert.equal(input.live, live);
    assert.equal(input.consent.subject, live ? "Owner" : "");
  }
  const broken = makeHarness({ companionCatalog: { createVoiceCloneJob: () => { throw new Error("catalog full"); } } });
  const result = await route(broken, "POST", "/v1/agent/pets/pet%201/voice-clone", {
    consent: { attested: true }, reference_url: "https://example.test/sample.wav",
  });
  assert.deepEqual(result.response, { status: 400, payload: { error: "catalog full" } });
});

test("voice clone status reports latest job and missing pets", async () => {
  const harness = makeHarness();
  const found = await route(harness, "GET", "/v1/agent/pets/pet%201/voice-clone");
  assert.equal(found.response.payload.found, true);
  assert.equal(found.response.payload.job.id, "job_2");
  assert.equal(found.response.payload.voice_binding.voice, "Kore");
  const missing = await route(harness, "GET", "/v1/agent/pets/missing/voice-clone");
  assert.equal(missing.response.payload.found, false);
  assert.equal(missing.response.payload.job, null);
  assert.equal(missing.response.payload.voice_binding, null);
  assert.equal(missing.response.payload.voice_clone, null);
});

test("publishing distinguishes consent, publishability, and absence", async () => {
  const success = makeHarness({ readJsonBody: async () => { throw new Error("ignored body"); } });
  const published = await route(success, "POST", "/v1/agent/pets/pet%201/publish", {});
  assert.equal(published.response.status, 200);
  assert.equal(published.response.payload.visibility, "shared");

  for (const [code, reason, expected] of [
    ["consent_not_approved", "denied", { status: 409, code: "consent_not_approved", reason: "denied" }],
    ["consent_not_approved", undefined, { status: 409, code: "consent_not_approved", reason: "unreviewed" }],
    ["not_publishable", undefined, { status: 409, code: "not_publishable" }],
    ["missing", undefined, { status: 404, code: undefined }],
  ]) {
    const error = Object.assign(new Error(code), { code, reason });
    const harness = makeHarness({ companionCatalog: { publishCompanion: () => { throw error; } } });
    const result = await route(harness, "POST", "/v1/agent/pets/pet_2/publish", {});
    assert.equal(result.response.status, expected.status);
    assert.equal(result.response.payload.code, expected.code);
    if (expected.reason) assert.equal(result.response.payload.reason, expected.reason);
  }
});

test("install accepts aliases, enforces device scope, and preserves errors", async () => {
  for (const body of [{ id: "pet_2" }, { companion_id: "pet_2" }, { companionId: "pet_2", source: "library", device_id: "dev_1" }]) {
    const harness = makeHarness();
    const result = await route(harness, "POST", "/v1/agent/pets/install", body);
    assert.equal(result.response.status, 200);
    assert.equal(result.response.payload.installed_id, "pet_2");
    assert.equal(result.response.payload.source, body.source || "pet-install");
  }
  assert.equal((await route(makeHarness(), "POST", "/v1/agent/pets/install", {})).response.status, 404);
  const denied = makeHarness({ requireDeviceScope: (response) => { response.denied = true; return false; } });
  assert.equal((await route(denied, "POST", "/v1/agent/pets/install", { id: "pet_2" })).response.denied, true);
  const broken = makeHarness({ applyCompanionToProfile: () => { throw new Error("profile unavailable"); } });
  assert.deepEqual((await route(broken, "POST", "/v1/agent/pets/install", { id: "pet_2" })).response,
    { status: 404, payload: { error: "profile unavailable" } });
});

test("every sharing route authorizes and unrelated methods fall through", async () => {
  const denied = makeHarness({ authorizedAgent: () => false });
  for (const [method, path] of [
    ["GET", "/v1/agent/pets/shared"], ["POST", "/v1/agent/pets/install"],
    ["GET", "/v1/agent/pets/pet_2/voice-clone"], ["POST", "/v1/agent/pets/pet_2/voice-clone"],
    ["DELETE", "/v1/agent/pets/pet_2/voice-clone"],
    ["POST", "/v1/agent/pets/pet_2/publish"],
  ]) {
    const result = await route(denied, method, path, {});
    assert.equal(result.handled, true);
    assert.equal(result.response.status, 401);
  }
  const harness = makeHarness();
  assert.equal((await route(harness, "DELETE", "/v1/agent/pets/pet_2/voice-clone")).handled, false);
  assert.equal((await route(harness, "GET", "/v1/agent/pets/pet_2/publish")).handled, false);
  assert.equal((await route(harness, "GET", "/v1/agent/pets/other")).handled, false);
});
