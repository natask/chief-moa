"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createEventProjectHandlers, query } = require("../lib/event-project-handlers");

function harness(overrides = {}) {
  const calls = [];
  const eventSubstrate = {
    storageInfo: async () => ({ mode: "jsonl" }),
    listEvents: async (filter) => { calls.push(["list-events", filter]); return [{ id: "evt" }]; },
    appendEvent: async (event) => { calls.push(["append-event", event]); return { id: "evt", ...event }; },
    ...overrides.eventSubstrate,
  };
  const projectStore = {
    list: () => [{ id: "proj" }],
    create: (body) => { calls.push(["create-project", body]); return { id: "proj", ...body }; },
    update: (id, body) => { calls.push(["update-project", id, body]); return id === "missing" ? null : { id, ...body }; },
    ...overrides.projectStore,
  };
  const handlers = createEventProjectHandlers({
    eventSubstrate,
    normalizeEventType: (value) => String(value || "").trim(),
    authorized: overrides.authorized || (() => true),
    authorizedAgent: overrides.authorizedAgent || (() => true),
    agentAuthError: () => ({ error: "agent unauthorized" }),
    projectStore,
    readJsonBody: async (request) => request.body,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    cleanError: (error) => String(error?.message || error),
    databaseConfigured: true,
  });
  return { handlers, calls };
}

async function route(h, method, pathname, body) {
  const response = {};
  const handled = await h.handlers.routeEventProjects({ method, body }, response, new URL(pathname, "http://local"));
  return { handled, ...response };
}

test("event and project authorization remain distinct and unrelated paths fall through", async () => {
  let h = harness({ authorized: () => false });
  let response = await route(h, "GET", "/v1/events");
  assert.equal(response.status, 401);
  assert.equal(response.payload.error, "missing or invalid gateway token");
  h = harness({ authorizedAgent: () => false });
  response = await route(h, "GET", "/v1/projects");
  assert.equal(response.status, 401);
  assert.equal(response.payload.error, "agent unauthorized");
  h = harness();
  assert.equal((await route(h, "GET", "/unrelated")).handled, false);
  assert.equal((await route(h, "DELETE", "/v1/projects")).handled, false);
});

test("event status reports storage and converts failures to fail-closed evidence", async () => {
  let response = await route(harness(), "GET", "/v1/events/status");
  assert.deepEqual(response.payload.event_substrate, { mode: "jsonl" });
  const failed = harness({ eventSubstrate: { storageInfo() { throw new Error("offline"); } } });
  response = await route(failed, "GET", "/v1/events/status");
  assert.deepEqual(response.payload.event_substrate, { mode: "error", error: "offline", postgres_configured: true });
});

test("event listing supports preferred, alias, empty, ordering, and limit filters", async () => {
  const h = harness();
  const response = await route(h, "GET", "/v1/events?event_type=a&eventType=b&eventTypePrefix=p&streamId=s&originId=o&correlationId=c&idempotencyKey=i&order=desc&limit=3");
  assert.equal(response.status, 200);
  assert.equal(response.payload.events[0].id, "evt");
  assert.deepEqual(h.calls[0], ["list-events", {
    event_type: "a", event_type_prefix: "p", stream_id: "s", origin_id: "o",
    correlation_id: "c", idempotency_key: "i", order: "desc", limit: 3,
  }]);
  await route(h, "GET", "/v1/events");
  assert.deepEqual(h.calls[1][1], {
    event_type: "", event_type_prefix: "", stream_id: "", origin_id: "",
    correlation_id: "", idempotency_key: "", order: "", limit: 100,
  });
});

test("event creation supplies an actor, preserves explicit actors, and rejects reserved or invalid events", async () => {
  const h = harness();
  let response = await route(h, "POST", "/v1/events", { event_type: "custom", payload: {} });
  assert.equal(response.status, 201);
  assert.deepEqual(h.calls[0][1].actor, { kind: "gateway", id: "api" });
  response = await route(h, "POST", "/v1/events", { eventType: "custom", actor: { kind: "user", id: "u" } });
  assert.equal(response.status, 201);
  assert.deepEqual(h.calls[1][1].actor, { kind: "user", id: "u" });
  response = await route(h, "POST", "/v1/events", { type: "telemetry.semantic.v1" });
  assert.equal(response.status, 400);
  assert.match(response.payload.error, /reserved/);
  const failed = harness({ eventSubstrate: { appendEvent() { throw new Error("invalid event"); } } });
  response = await route(failed, "POST", "/v1/events", { type: "custom" });
  assert.equal(response.status, 400);
  assert.equal(response.payload.error, "invalid event");
});

test("projects list, create, update, decode ids, and report errors", async () => {
  const h = harness();
  let response = await route(h, "GET", "/v1/projects");
  assert.equal(response.payload.projects[0].id, "proj");
  response = await route(h, "POST", "/v1/projects", { name: "New" });
  assert.equal(response.status, 201);
  assert.deepEqual(h.calls[0], ["create-project", { name: "New" }]);
  response = await route(h, "PATCH", "/v1/projects/proj%3A1", { next_step: "go" });
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls[1], ["update-project", "proj:1", { next_step: "go" }]);
  response = await route(h, "PATCH", "/v1/projects/missing", {});
  assert.equal(response.status, 404);
  const failed = harness({ projectStore: {
    create() { throw new Error("create failed"); }, update() { throw new Error("update failed"); },
  } });
  assert.equal((await route(failed, "POST", "/v1/projects", null)).payload.error, "create failed");
  assert.equal((await route(failed, "PATCH", "/v1/projects/id", null)).payload.error, "update failed");
});

test("direct handlers cover public seams and query fallbacks", async () => {
  const h = harness();
  let response = {};
  await h.handlers.createEvent({ body: { type: "custom" } }, response);
  assert.equal(response.status, 201);
  response = {};
  await h.handlers.createProject({ body: { name: "Direct" } }, response);
  assert.equal(response.status, 201);
  response = {};
  await h.handlers.updateProject({ body: {} }, response, "missing");
  assert.equal(response.status, 404);
  assert.equal(query(new URL("http://local/?b=2"), "a", "b"), "2");
  assert.equal(query(new URL("http://local/"), "a", "b"), "");
});
