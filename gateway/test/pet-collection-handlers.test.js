"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createPetCollectionHandlers } = require("../lib/pet-collection-handlers");

function makeHarness(overrides = {}) {
  const calls = [];
  const companionCatalog = {
    listAgents: (input) => [{ id: "agent_1", input }],
    listBookmarks: (input) => [{ id: "bookmark_1", input }],
    getAgent: (id) => id === "missing" ? null : { id },
    getBookmark: (id) => id === "missing" ? null : { id },
    createAgent: (input) => ({ agent_id: "agent_1", companion_id: "pet_1", ...input }),
    createBookmark: (input) => ({ bookmark_id: "bookmark_1", ...input }),
    preview: (input) => ({ companion: input.companion_id }),
    ...(overrides.companionCatalog || {}),
  };
  const deps = {
    companionCatalog,
    catalogVersion: "pets/v1",
    authorizedAgent: () => true,
    agentAuthError: () => ({ error: "unauthorized" }),
    readJsonBody: async (request) => request.body,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    cleanError: (error) => error.message,
    petInputFromBody: (body) => ({ species: body?.species || "bird" }),
    manifestV2FieldsFromBody: () => ({ manifest_version: 2 }),
    petPreviewPayload: (preview) => ({ preview }),
    ...overrides,
    companionCatalog,
  };
  for (const name of ["listAgents", "listBookmarks", "getAgent", "getBookmark", "createAgent", "createBookmark", "preview"]) {
    const operation = companionCatalog[name];
    companionCatalog[name] = (...args) => {
      calls.push([name, ...args]);
      return operation(...args);
    };
  }
  return { ...createPetCollectionHandlers(deps), calls };
}

async function route(harness, method, pathname, body, query = "") {
  const response = {};
  const handled = await harness.routePetCollections(
    { method, body, headers: {} }, response, new URL(`https://gateway.test${pathname}${query}`),
  );
  return { handled, response };
}

test("agent and bookmark collections list with bounded query options", async () => {
  const harness = makeHarness();
  const agents = await route(harness, "GET", "/v1/agent/pets/agents", null, "?q=falcon&limit=4");
  assert.equal(agents.handled, true);
  assert.equal(agents.response.status, 200);
  assert.equal(agents.response.payload.query, "falcon");
  assert.deepEqual(harness.calls[0], ["listAgents", { query: "falcon", limit: 4 }]);

  const bookmarks = await route(harness, "GET", "/v1/agent/pets/bookmarks", null, "?query=saved");
  assert.equal(bookmarks.response.payload.query, "saved");
  assert.deepEqual(harness.calls[1], ["listBookmarks", { query: "saved", limit: 100 }]);

  const defaults = harness.collectionPayload(undefined, "agents");
  assert.equal(defaults.query, "");
  assert.equal(defaults.endpoints.bookmarks, "/v1/agent/pets/bookmarks");
  assert.equal(harness.collectionPayload(new URL("https://gateway.test"), "bookmarks").endpoints.agents, "/v1/agent/pets/agents");
});

test("item reads decode ids and distinguish missing agents from bookmarks", async () => {
  const harness = makeHarness();
  assert.equal((await route(harness, "GET", "/v1/agent/pets/agents/agent%201")).response.payload.agent.id, "agent 1");
  assert.equal((await route(harness, "GET", "/v1/agent/pets/bookmarks/bookmark%201")).response.payload.bookmark.id, "bookmark 1");
  const agentMissing = await route(harness, "GET", "/v1/agent/pets/agents/missing");
  assert.deepEqual(agentMissing.response.payload, { error: "agent not found" });
  const bookmarkMissing = await route(harness, "GET", "/v1/agent/pets/bookmarks/missing");
  assert.deepEqual(bookmarkMissing.response.payload, { error: "bookmark not found" });
});

test("every collection route enforces agent authorization", async () => {
  const harness = makeHarness({ authorizedAgent: () => false });
  for (const [method, path] of [
    ["GET", "/v1/agent/pets/agents"], ["POST", "/v1/agent/pets/agents"], ["GET", "/v1/agent/pets/agents/a"],
    ["GET", "/v1/agent/pets/bookmarks"], ["POST", "/v1/agent/pets/bookmarks"], ["GET", "/v1/agent/pets/bookmarks/b"],
  ]) {
    const result = await route(harness, method, path, {});
    assert.equal(result.handled, true);
    assert.equal(result.response.status, 401);
  }
});

test("agent creation returns an inert preview and accepts legacy body aliases", async () => {
  const harness = makeHarness();
  const bodies = [
    { text: "text", image_data_url: "image-a" },
    { request: "request", imageDataUrl: "image-b" },
    { prompt: "prompt", source_image: "image-c" },
    { description: "description", sourceImage: "image-d", name: "Moa", voice: "Kore", rules: ["safe"], species: "owl" },
    {},
  ];
  for (const body of bodies) {
    const result = await route(harness, "POST", "/v1/agent/pets/agents", body);
    assert.equal(result.response.status, 201);
    assert.equal(result.response.payload.active_profile_mutated, false);
    assert.equal(result.response.payload.version, "pets/v1");
  }
  assert.equal(harness.calls.filter((call) => call[0] === "preview").length, bodies.length);
});

test("creation errors remain bounded and bookmarks preserve not-found semantics", async () => {
  const brokenAgent = makeHarness({ companionCatalog: { createAgent: () => { throw new Error("bad agent"); } } });
  assert.deepEqual((await route(brokenAgent, "POST", "/v1/agent/pets/agents", {})).response, { status: 400, payload: { error: "bad agent" } });

  const harness = makeHarness();
  const bookmark = await route(harness, "POST", "/v1/agent/pets/bookmarks", { agent_id: "agent_1" });
  assert.equal(bookmark.response.status, 201);
  assert.equal(bookmark.response.payload.bookmark.bookmark_id, "bookmark_1");
  const empty = await route(harness, "POST", "/v1/agent/pets/bookmarks", null);
  assert.equal(empty.response.status, 201);

  const brokenBookmark = makeHarness({ companionCatalog: { createBookmark: () => { throw new Error("agent missing"); } } });
  assert.deepEqual((await route(brokenBookmark, "POST", "/v1/agent/pets/bookmarks", {})).response, { status: 404, payload: { error: "agent missing" } });
});

test("unrelated paths and methods fall through to the gateway router", async () => {
  const harness = makeHarness();
  assert.equal((await route(harness, "DELETE", "/v1/agent/pets/agents/a")).handled, false);
  assert.equal((await route(harness, "GET", "/v1/agent/pets/shared")).handled, false);
});
