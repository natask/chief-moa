"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionReadHandlers } = require("../lib/session-read-handlers");

function harness(overrides = {}) {
  const threadStore = { getActive: (_s, surface) => ({ branch_id: surface ? "branch" : "default" }), getThread: (_s, id) => id === "branch" ? { kind: "fork", label: "Fork" } : null };
  const deps = {
    authorized: () => true, sendJson: (r, status, payload) => Object.assign(r, { status, payload }),
    sendConversation: (r, id) => Object.assign(r, { status: 200, conversation: id }),
    sessionSummaryPayload: (limit) => ({ sessions: [limit] }), defaultSessionId: () => "shared",
    threadListPayload: (sessionId, limit) => ({ sessionId, limit }), threadStore,
    sanitizeOptionalId: (value, fallback) => value ? `safe-${value}` : fallback,
    sessionContextPayload: (input) => input, listVoiceTurnsForSession: (id) => [{ transcript: id }],
    historyMessagesPayload: (input) => input, resolveContextTurnLimit: (value) => Number(value || 2),
    sessionMessagesPayload: (input) => ({ projection: input }),
    listChatTurnRecordsForSession: (id) => [
      { turn_id: "one", ts: "old", response_text: "first" },
      { turn_id: "two", conversation_id: id, session_id: id, source: "chat", model: "m", profile_version: "p", created_at: "new" }, {},
    ], latestContextPayload: () => ({ latest: true }), ...overrides,
    threadStore: overrides.threadStore || threadStore,
  };
  return createSessionReadHandlers(deps);
}
const req = (method = "GET") => ({ method });
const url = (path) => new URL(`https://test${path}`);

test("router ignores unrelated traffic and protects every recognized read", async () => {
  assert.equal(await harness().routeSessionReads(req("POST"), {}, url("/v1/sessions")), false);
  assert.equal(await harness().routeSessionReads(req(), {}, url("/other")), false);
  const handlers = harness({ authorized: () => false });
  for (const path of ["/v1/conversations/c", "/v1/sessions", "/v1/sessions/default", "/v1/threads", "/v1/threads/active", "/v1/sessions/s/context", "/v1/sessions/s/messages", "/v1/sessions/s/turns", "/v1/history/messages", "/v1/sessions/s/chat-turns", "/v1/context/latest"]) {
    const response = {}; assert.equal(await handlers.routeSessionReads(req(), response, url(path)), true); assert.equal(response.status, 401);
  }
});

test("basic collection and identity reads preserve defaults", async () => {
  const handlers = harness();
  const cases = [
    ["/v1/conversations/a%20b", "conversation", "a%20b"], ["/v1/sessions?limit=7", "payload", { sessions: [7] }],
    ["/v1/sessions", "payload", { sessions: [25] }], ["/v1/sessions/default", "payload", { session_id: "shared" }],
    ["/v1/context/latest", "payload", { latest: true }],
  ];
  for (const [path, key, expected] of cases) { const response = {}; await handlers.routeSessionReads(req(), response, url(path)); assert.deepEqual(response[key], expected); }
});

test("thread aliases, active metadata, and fallbacks remain stable", async () => {
  let handlers = harness(); let response = {};
  await handlers.routeSessionReads(req(), response, url("/v1/threads?conversation_id=legacy&limit=9")); assert.deepEqual(response.payload, { sessionId: "legacy", limit: 9 });
  response = {}; await handlers.routeSessionReads(req(), response, url("/v1/threads")); assert.deepEqual(response.payload, { sessionId: "shared", limit: 50 });
  response = {}; await handlers.routeSessionReads(req(), response, url(`/v1/threads/active?session_id=s&surface=${"x".repeat(80)}`));
  assert.equal(response.payload.surface.length, 60); assert.equal(response.payload.active.kind, "fork"); assert.equal(response.payload.active.label, "Fork");
  handlers = harness({ threadStore: { getActive: () => ({ branch_id: "default" }), getThread: () => null } }); response = {};
  await handlers.sendActiveThread(response, url("/v1/threads/active?conversation_id=x")); assert.equal(response.payload.active.kind, "default"); assert.equal(response.payload.active.label, "Main thread");
  handlers = harness({ threadStore: { getActive: () => ({ branch_id: "new-1" }), getThread: () => null } }); response = {};
  await handlers.sendActiveThread(response, url("/v1/threads/active")); assert.equal(response.payload.active.kind, "new"); assert.equal(response.payload.active.label, "new-1");
});

test("context, turns, and history normalize decoding, aliases, and flags", async () => {
  const handlers = harness(); let response = {};
  await handlers.routeSessionReads(req(), response, url("/v1/sessions/a%20b/context?branch_id=fork&all_branches=true&turn_limit=4"));
  assert.deepEqual(response.payload, { sessionId: "a b", branchId: "fork", allBranches: true, turnLimit: "4" });
  response = {}; await handlers.routeSessionReads(req(), response, url("/v1/sessions/s/context?all_branches=1")); assert.equal(response.payload.branchId, "default"); assert.equal(response.payload.allBranches, true);
  response = {}; await handlers.routeSessionReads(req(), response, url("/v1/sessions/a%20b/turns")); assert.equal(response.payload.session_id, "safe-a b"); assert.equal(response.payload.turns[0].transcript, "a b");
  response = {}; await handlers.routeSessionReads(req(), response, url("/v1/sessions/a%20b/messages?branch_id=fork&limit=9"));
  assert.deepEqual(response.payload, { projection: { sessionId: "a b", branchId: "fork", limit: "9" } });
  response = {}; await handlers.routeSessionReads(req(), response, url("/v1/sessions/a%20b/messages"));
  assert.deepEqual(response.payload, { projection: { sessionId: "a b", branchId: "", limit: null } });
  response = {}; await handlers.routeSessionReads(req(), response, url("/v1/history/messages?conversation_id=s&query=find&limit=3")); assert.deepEqual(response.payload, { sessionId: "s", q: "find", limit: 3 });
  response = {}; await handlers.routeSessionReads(req(), response, url("/v1/history/messages")); assert.deepEqual(response.payload, { sessionId: "", q: "", limit: 50 });
});

test("chat turns paginate without colliding with voice turns", async () => {
  const handlers = harness(); const response = {};
  await handlers.routeSessionReads(req(), response, url("/v1/sessions/a%20b/chat-turns?limit=2"));
  assert.equal(response.payload.total, 3); assert.equal(response.payload.turns.length, 2); assert.equal(response.payload.turns[0].turn_id, "two");
  assert.equal(response.payload.turns[0].conversation_id, "safe-a b"); assert.equal(response.payload.turns[1].conversation_id, "safe-a b");
  assert.equal(response.payload.turns[1].created_at, ""); assert.equal(handlers.decodeSessionPath("/v1/sessions/a%2Fb/turns", "/turns"), "a/b");
});
