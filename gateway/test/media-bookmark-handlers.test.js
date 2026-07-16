"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createMediaBookmarkHandlers, bookmarkIdFromPath, publicBookmark } = require("../lib/media-bookmark-handlers");

const OWNER = "usr_token_scope";

function harness(overrides = {}) {
  const calls = [];
  const bookmark = {
    id: "bookmark_1", owner_id: OWNER, provider: "youtube", video_id: "dQw4w9WgXcQ",
    canonical_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    position_ms: 42_500, label: "chorus", title: "Example", note: "good part",
    aliases: ["harmony"], source_surface: "android",
    preferred_package: "app.revanced.android.youtube", preferred_instance: "YouTube Advanced",
    idempotency_key: "private-key", user_approved: true,
    created_at: "2026-07-16T12:00:00.000Z", updated_at: "2026-07-16T12:00:00.000Z",
  };
  const store = {
    save: (owner, body) => { calls.push(["save", owner, body]); return bookmark; },
    list: (owner, filter) => { calls.push(["list", owner, filter]); return [bookmark]; },
    resolve: (owner, query, options) => { calls.push(["resolve", owner, query, options]); return { status: "matched", bookmark }; },
    get: (owner, id) => { calls.push(["get", owner, id]); return owner === OWNER && id === bookmark.id ? bookmark : null; },
    remove: (owner, id) => { calls.push(["remove", owner, id]); return owner === OWNER && id === bookmark.id ? bookmark : null; },
    ...overrides.store,
  };
  const handlers = createMediaBookmarkHandlers({
    authorized: () => true,
    principal: () => OWNER,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    readJsonBody: async (request) => request.body || {},
    store,
    ...overrides,
  });
  return { handlers, calls, bookmark };
}

function request(method, body = {}) { return { method, body }; }
function url(value) { return new URL(value, "https://gateway.test"); }

function assertPublic(bookmark) {
  assert.deepEqual(Object.keys(bookmark).sort(), [
    "aliases", "canonical_url", "created_at", "id", "label", "note", "position_ms",
    "provider", "source_surface", "title", "updated_at", "video_id",
  ]);
}

test("recognizes only bounded methods and authenticates before resolving a principal", async () => {
  const { handlers, calls } = harness();
  for (const [method, pathname] of [["PATCH", "/v1/media/bookmarks"], ["GET", "/v1/media/bookmarks/a/b"], ["GET", "/other"]]) {
    assert.equal(await handlers.routeMediaBookmarks(request(method), {}, url(pathname)), false);
  }
  assert.deepEqual(calls, []);
  let principalCalls = 0;
  const denied = harness({ authorized: () => false, principal: () => { principalCalls += 1; return OWNER; } });
  for (const [method, pathname] of [["GET", "/v1/media/bookmarks"], ["POST", "/v1/media/bookmarks"], ["GET", "/v1/media/bookmarks/id"], ["DELETE", "/v1/media/bookmarks/id"]]) {
    const response = {};
    assert.equal(await denied.handlers.routeMediaBookmarks(request(method), response, url(pathname)), true);
    assert.equal(response.status, 401);
  }
  assert.equal(principalCalls, 0);
});

test("injects trusted ownership on create and returns only the shared projection", async () => {
  const state = harness();
  const body = { user_approved: true, owner_id: "attacker", source_surface: "android" };
  const response = { setHeader: (name, value) => { response.header = [name, value]; } };
  await state.handlers.routeMediaBookmarks(request("POST", body), response, url("/v1/media/bookmarks"));
  assert.equal(response.status, 201);
  assert.deepEqual(state.calls, [["save", OWNER, body]]);
  assertPublic(response.payload.bookmark);
  assert.equal(response.payload.bookmark.owner_id, undefined);
  assert.equal(publicBookmark({ ...state.bookmark, title: "" }).title, undefined);
  assert.deepEqual(response.header, ["cache-control", "no-store"]);
});

test("scopes list and resolution to the trusted principal and projects ambiguity candidates", async () => {
  let state = harness();
  let response = {};
  await state.handlers.routeMediaBookmarks(request("GET"), response, url("/v1/media/bookmarks?videoId=dQw4w9WgXcQ&sourceSurface=android&limit=7"));
  assert.deepEqual(state.calls[0], ["list", OWNER, { video_id: "dQw4w9WgXcQ", source_surface: "android", limit: "7" }]);
  assertPublic(response.payload.bookmarks[0]);

  state = harness({ store: { resolve: (owner, query, options) => {
    state?.calls.push(["resolve", owner, query, options]);
    return { status: "ambiguous", match_type: "exact_alias", candidates: [state.bookmark, state.bookmark] };
  } } });
  response = {};
  await state.handlers.routeMediaBookmarks(request("GET"), response, url("/v1/media/bookmarks?q=harmony&video_id=dQw4w9WgXcQ"));
  assert.equal(response.payload.resolution.status, "ambiguous");
  assertPublic(response.payload.resolution.candidates[0]);
});

test("gets and deletes only through the trusted owner scope", async () => {
  const state = harness();
  let response = {};
  await state.handlers.routeMediaBookmarks(request("GET"), response, url("/v1/media/bookmarks/bookmark_1"));
  assert.deepEqual(state.calls[0], ["get", OWNER, "bookmark_1"]);
  assertPublic(response.payload.bookmark);
  response = {};
  await state.handlers.routeMediaBookmarks(request("DELETE"), response, url("/v1/media/bookmarks/bookmark_1"));
  assert.deepEqual(state.calls[1], ["remove", OWNER, "bookmark_1"]);
  assertPublic(response.payload.bookmark);
  response = {};
  state.handlers.readItem(response, "missing", OWNER);
  assert.equal(response.status, 404);
  response = {};
  state.handlers.remove(response, "missing", OWNER);
  assert.deepEqual(response, { status: 200, payload: { deleted: false, already_absent: true } });
  for (const method of ["readItem", "remove"]) {
    response = {};
    state.handlers[method](response, "%E0%A4%A", OWNER);
    assert.deepEqual(response, { status: 400, payload: { error: "invalid media bookmark id" } });
  }
  assert.equal(bookmarkIdFromPath("/v1/media/bookmarks/"), null);
});

test("malformed opaque item ids return 400 before get or delete reaches the store", async () => {
  const state = harness();
  const malformed = ["bookmark_1%20", "bookmark_1%0A", "bookmark_1%2Fextra", "bookmark_1%00", "a".repeat(121)];
  for (const encoded of malformed) {
    for (const method of ["GET", "DELETE"]) {
      const before = state.calls.length;
      const response = {};
      assert.equal(await state.handlers.routeMediaBookmarks(request(method), response, url(`/v1/media/bookmarks/${encoded}`)), true);
      assert.deepEqual(response, { status: 400, payload: { error: "invalid media bookmark id" } });
      assert.equal(state.calls.length, before, `${method} ${encoded} reached the store`);
    }
  }
});

test("maps validation, collision, capacity, corruption, and I/O without leaking storage details", async () => {
  let state = harness({ readJsonBody: async () => { throw new Error("parser internals"); } });
  let response = {};
  await state.handlers.create(request("POST"), response, OWNER);
  assert.deepEqual(response, { status: 400, payload: { error: "request body must be valid JSON" } });

  for (const [code, message, expectedStatus, expectedError] of [
    ["validation", "video_id must be an 11-character YouTube video id", 400, "video_id must be an 11-character YouTube video id"],
    ["idempotency_collision", "private collision detail", 409, "media bookmark idempotency collision"],
    ["capacity", "private capacity detail", 507, "media bookmark capacity exceeded"],
    ["storage_corrupt", "secret file contents", 500, "media bookmark storage unavailable"],
    ["EACCES", "/private/path denied", 500, "media bookmark storage unavailable"],
  ]) {
    const error = Object.assign(new Error(message), { code });
    state = harness({ store: { save: () => { throw error; } } });
    response = {};
    await state.handlers.create(request("POST"), response, OWNER);
    assert.deepEqual(response, { status: expectedStatus, payload: { error: expectedError } });
  }
});
