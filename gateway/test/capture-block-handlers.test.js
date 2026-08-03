"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createCaptureBlockHandlers,
  captureBlockIdFromPath,
  captureBlockActionIdFromPath,
  decodeCaptureBlockId,
  sendCaptureError,
} = require("../lib/capture-block-handlers");

const ID = `cap_${"a".repeat(64)}`;
const BLOCK = {
  id: ID,
  literal_transcript: "hello",
  routing_proposals: [{ route: "file_only", executable: false }],
};

function harness(overrides = {}) {
  const calls = [];
  const store = {
    get: async (id) => { calls.push(["get", id]); return id === ID ? BLOCK : null; },
    list: async (filters) => {
      calls.push(["list", filters]);
      return { items: [BLOCK], offset: 0, limit: 50, has_more: false };
    },
    search: async (query, filters) => {
      calls.push(["search", query, filters]);
      return { items: [BLOCK], offset: 0, limit: 50, has_more: false };
    },
    ...overrides.store,
  };
  const handlers = createCaptureBlockHandlers({
    authorized: () => true,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    store,
    audioCapture: { create: async (input) => { calls.push(["create", input]); return BLOCK; } },
    audioTranscription: { retry: async (input) => { calls.push(["retry", input]); return BLOCK; } },
    readJsonBody: async () => ({
      audio_note_id: "note_1",
      idempotency_key: "request_1",
      source: { surface: "browser-extension" },
    }),
    principal: () => "usr_owner",
    ...overrides,
  });
  return { handlers, calls };
}

function request(method) {
  return { method };
}

function url(pathname) {
  return new URL(pathname, "https://gateway.test");
}

test("recognizes only collection, search, bounded item, and retry routes", async () => {
  const state = harness();
  for (const [method, pathname] of [
    ["PUT", "/v1/capture-blocks"],
    ["POST", "/v1/capture-blocks/search"],
    ["GET", "/v1/capture-blocks/a/b"],
    ["GET", "/v1/other"],
  ]) {
    assert.equal(await state.handlers.routeCaptureBlocks(request(method), {}, url(pathname)), false);
  }
  assert.deepEqual(state.calls, []);
  assert.equal(captureBlockIdFromPath(`/v1/capture-blocks/${ID}`), ID);
  assert.equal(captureBlockIdFromPath("/v1/capture-blocks/search"), null);
  assert.equal(captureBlockIdFromPath("/v1/capture-blocks/"), null);
  assert.equal(captureBlockActionIdFromPath(`/v1/capture-blocks/${ID}/retry`, "retry"), ID);
  assert.equal(captureBlockActionIdFromPath(`/v1/capture-blocks/${ID}/claim`, "retry"), null);
});

test("creates an authenticated queued block from a stored audio note", async () => {
  const state = harness();
  const response = {};
  assert.equal(await state.handlers.routeCaptureBlocks(request("POST"), response, url("/v1/capture-blocks")), true);
  assert.deepEqual(state.calls, [["create", {
    audio_note_id: "note_1",
    idempotency_key: "request_1",
    source: { surface: "browser-extension" },
    owner_id: "usr_owner",
  }]]);
  assert.deepEqual(response, { status: 201, payload: { capture_block: BLOCK } });
});

test("retries failed transcription without exposing a provider request route", async () => {
  const state = harness();
  const response = {};
  assert.equal(await state.handlers.routeCaptureBlocks(
    request("POST"), response, url(`/v1/capture-blocks/${ID}/retry`),
  ), true);
  assert.deepEqual(state.calls, [["retry", { capture_block_id: ID }]]);
  assert.deepEqual(response, { status: 200, payload: { capture_block: BLOCK } });
  assert.equal(await state.handlers.routeCaptureBlocks(
    request("POST"), {}, url(`/v1/capture-blocks/${ID}/claim`),
  ), false);
});

test("authenticates before reads and applies no-store to accepted routes", async () => {
  const denied = harness({ authorized: () => false });
  for (const [method, pathname] of [["GET", "/v1/capture-blocks"], ["POST", "/v1/capture-blocks"], ["POST", `/v1/capture-blocks/${ID}/retry`], ["GET", "/v1/capture-blocks/search?q=x"], ["GET", `/v1/capture-blocks/${ID}`]]) {
    const response = {};
    assert.equal(await denied.handlers.routeCaptureBlocks(request(method), response, url(pathname)), true);
    assert.deepEqual(response, { status: 401, payload: { error: "missing or invalid gateway token" } });
  }
  assert.deepEqual(denied.calls, []);

  const state = harness();
  const response = { setHeader: (name, value) => { response.header = [name, value]; } };
  await state.handlers.routeCaptureBlocks(request("GET"), response, url("/v1/capture-blocks"));
  assert.deepEqual(response.header, ["cache-control", "no-store"]);
});

test("lists and searches with bounded query filters", async () => {
  let state = harness();
  let response = {};
  await state.handlers.routeCaptureBlocks(
    request("GET"),
    response,
    url("/v1/capture-blocks?session_id=s1&turn_id=t1&source_surface=browser&limit=7&offset=2"),
  );
  assert.deepEqual(state.calls, [["list", {
    session_id: "s1",
    turn_id: "t1",
    source_surface: "browser",
    limit: "7",
    offset: "2",
  }]]);
  assert.deepEqual(response.payload.capture_blocks, [BLOCK]);

  state = harness();
  response = {};
  await state.handlers.routeCaptureBlocks(
    request("GET"),
    response,
    url("/v1/capture-blocks/search?q=Amharic&session_id=s1"),
  );
  assert.deepEqual(state.calls, [["search", "Amharic", {
    session_id: "s1",
    turn_id: "",
    source_surface: "",
    limit: "",
    offset: "",
  }]]);
  response = {};
  await state.handlers.routeCaptureBlocks(request("GET"), response, url("/v1/capture-blocks/search"));
  assert.deepEqual(response, { status: 400, payload: { error: "q is required for capture block search" } });

  state = harness();
  response = {};
  await state.handlers.routeCaptureBlocks(request("GET"), response, url("/v1/capture-blocks?query=literal"));
  assert.equal(state.calls[0][0], "search");
  assert.equal(state.calls[0][1], "literal");
});

test("gets one capture block and returns 404 for a valid absent id", async () => {
  const state = harness();
  let response = {};
  await state.handlers.routeCaptureBlocks(request("GET"), response, url(`/v1/capture-blocks/${ID}`));
  assert.deepEqual(state.calls, [["get", ID]]);
  assert.deepEqual(response, { status: 200, payload: { capture_block: BLOCK } });

  response = {};
  await state.handlers.readItem(response, `cap_${"b".repeat(64)}`);
  assert.equal(response.status, 404);
});

test("malformed ids and storage failures are mapped without leaking internals", async () => {
  const state = harness();
  for (const malformed of ["cap_bad", "%E0%A4%A", `${ID}%2Fextra`, `${ID}%00`]) {
    const before = state.calls.length;
    const response = {};
    await state.handlers.routeCaptureBlocks(request("GET"), response, url(`/v1/capture-blocks/${malformed}`));
    assert.deepEqual(response, { status: 400, payload: { error: "invalid capture block id" } });
    assert.equal(state.calls.length, before);
  }
  assert.throws(() => decodeCaptureBlockId("bad"), /invalid capture block id/);

  let response = {};
  await harness({ store: { list: async () => { throw new Error("/private/path"); } } })
    .handlers.readCollection(response, url("/v1/capture-blocks"));
  assert.deepEqual(response, { status: 500, payload: { error: "capture block storage unavailable" } });
  response = {};
  await harness({ store: { get: async () => { throw new Error("/private/path"); } } })
    .handlers.readItem(response, ID);
  assert.deepEqual(response, { status: 500, payload: { error: "capture block storage unavailable" } });
  response = {};
  sendCaptureError(response, Object.assign(new Error("bad limit"), { code: "validation" }),
    (target, status, payload) => Object.assign(target, { status, payload }));
  assert.deepEqual(response, { status: 400, payload: { error: "bad limit" } });
});

test("constructor requires explicit dependencies", () => {
  assert.throws(() => createCaptureBlockHandlers(), /require authorized/);
});
