"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createHistoryArchiveHandlers, batchIdFromPath, batchBodyProblem } = require("../lib/history-archive-handlers");

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "history-archive-test-"));
}

function fakeBlobStore() {
  const blobs = new Map();
  const calls = [];
  return {
    blobs,
    calls,
    put: async (key, bytes) => { calls.push(["put", key]); blobs.set(key, Buffer.from(bytes)); },
    readBytes: async (key) => { calls.push(["readBytes", key]); return blobs.get(key) || null; },
  };
}

function harness(overrides = {}) {
  const dataDir = overrides.dataDir || tempDataDir();
  const blobStore = overrides.blobStore || fakeBlobStore();
  let readBodyCalls = 0;
  const handlers = createHistoryArchiveHandlers({
    authorized: () => true,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    readBody: async (request) => { readBodyCalls += 1; return request.body || {}; },
    blobStore,
    dataDir,
    ...overrides.deps,
  });
  return { handlers, blobStore, dataDir, readBodyCalls: () => readBodyCalls };
}

function request(method, body = {}) { return { method, body }; }
function url(value) { return new URL(value, "https://gateway.test"); }

function batchBody(overrides = {}) {
  return {
    batchId: "batch_1",
    deviceId: "device_a",
    createdAt: 1_000,
    count: 12,
    minRecordedAt: 500,
    maxRecordedAt: 900,
    blob: Buffer.from("iv-and-ciphertext").toString("base64"),
    ...overrides,
  };
}

async function store(state, overrides = {}) {
  const response = {};
  await state.handlers.routeHistoryArchive(request("POST", batchBody(overrides)), response, url("/v1/history/batches"));
  return response;
}

test("ignores non-matching routes without touching deps and authenticates before any work", async () => {
  const state = harness();
  for (const [method, pathname] of [
    ["DELETE", "/v1/history/batches"], ["POST", "/v1/history/batches/batch_1"],
    ["GET", "/v1/history/batches/a/b"], ["GET", "/v1/history"], ["GET", "/other"],
  ]) {
    assert.equal(await state.handlers.routeHistoryArchive(request(method), {}, url(pathname)), false);
  }
  assert.deepEqual(state.blobStore.calls, []);
  assert.equal(state.readBodyCalls(), 0);

  const denied = harness({ deps: { authorized: () => false } });
  for (const [method, pathname] of [
    ["POST", "/v1/history/batches"], ["GET", "/v1/history/batches"], ["GET", "/v1/history/batches/batch_1"],
  ]) {
    const response = {};
    assert.equal(await denied.handlers.routeHistoryArchive(request(method), response, url(pathname)), true);
    assert.deepEqual(response, { status: 401, payload: { error: "missing or invalid gateway token" } });
  }
  assert.deepEqual(denied.blobStore.calls, []);
  assert.equal(denied.readBodyCalls(), 0);
});

test("rejects invalid batch bodies before storage", async () => {
  const state = harness();
  const invalid = [
    { batchId: "" }, { batchId: "bad id" }, { batchId: "a".repeat(81) }, { batchId: "a/b" },
    { deviceId: "" }, { deviceId: "device!" },
    { createdAt: 0 }, { createdAt: "1000" }, { createdAt: Infinity },
    { count: -1 }, { count: 2.5 },
    { minRecordedAt: NaN }, { maxRecordedAt: 0 },
    { blob: "" }, { blob: "not base64!!" }, { blob: "abc" }, { blob: 42 },
  ];
  for (const overrides of invalid) {
    const response = await store(state, overrides);
    assert.equal(response.status, 400, JSON.stringify(overrides));
  }
  assert.deepEqual(state.blobStore.calls, []);
  assert.equal(batchBodyProblem(null), "request body must be a JSON object");
});

test("rejects oversize blobs with 413 without storing", async () => {
  const state = harness({ deps: { maxBlobBytes: 64 } });
  const response = await store(state, { blob: Buffer.alloc(65).toString("base64") });
  assert.equal(response.status, 413);
  assert.deepEqual(state.blobStore.calls, []);
  const atLimit = await store(state, { blob: Buffer.alloc(64).toString("base64") });
  assert.equal(atLimit.status, 201);
});

test("stores idempotently: 201 on first write, 200 with alreadyExisted on overwrite", async () => {
  const state = harness();
  const first = await store(state);
  assert.deepEqual(first, { status: 201, payload: { batchId: "batch_1", stored: true } });

  const replacement = Buffer.from("replacement-ciphertext").toString("base64");
  const second = await store(state, { blob: replacement, count: 13, createdAt: 2_000 });
  assert.deepEqual(second, { status: 200, payload: { batchId: "batch_1", stored: true, alreadyExisted: true } });
  assert.equal(
    state.blobStore.blobs.get("history-archive/device_a/batch_1.bin").toString("base64"),
    replacement,
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(state.dataDir, "history-archive", "device_a", "manifest.json"), "utf8"));
  assert.deepEqual(manifest, [{
    batchId: "batch_1", createdAt: 2_000, count: 13,
    bytes: Buffer.from(replacement, "base64").length, minRecordedAt: 500, maxRecordedAt: 900,
  }]);
});

test("lists batches sorted ascending with device and since filtering across devices", async () => {
  const state = harness();
  await store(state, { batchId: "batch_b", deviceId: "device_a", createdAt: 2_000 });
  await store(state, { batchId: "batch_a", deviceId: "device_a", createdAt: 1_000 });
  await store(state, { batchId: "batch_c", deviceId: "device_b", createdAt: 3_000 });

  let response = {};
  await state.handlers.routeHistoryArchive(request("GET"), response, url("/v1/history/batches"));
  assert.deepEqual(response.payload.batches.map((entry) => [entry.deviceId, entry.batchId]), [
    ["device_a", "batch_a"], ["device_a", "batch_b"], ["device_b", "batch_c"],
  ]);
  assert.equal(response.payload.batches[0].count, 12);

  response = {};
  await state.handlers.routeHistoryArchive(request("GET"), response, url("/v1/history/batches?device=device_a"));
  assert.deepEqual(response.payload.batches.map((entry) => entry.batchId), ["batch_a", "batch_b"]);

  response = {};
  await state.handlers.routeHistoryArchive(request("GET"), response, url("/v1/history/batches?since=2000"));
  assert.deepEqual(response.payload.batches.map((entry) => entry.batchId), ["batch_c"]);

  response = {};
  await state.handlers.routeHistoryArchive(request("GET"), response, url("/v1/history/batches?device=unknown_device"));
  assert.deepEqual(response, { status: 200, payload: { batches: [] } });

  for (const query of ["?device=bad%20id", "?since=soon"]) {
    response = {};
    await state.handlers.routeHistoryArchive(request("GET"), response, url(`/v1/history/batches${query}`));
    assert.equal(response.status, 400, query);
  }
});

test("returns stored blobs byte-exact and requires a valid device parameter", async () => {
  const state = harness();
  const bytes = Buffer.from([0, 1, 2, 255, 254, 7, 0, 42]);
  await store(state, { blob: bytes.toString("base64") });

  let response = {};
  await state.handlers.routeHistoryArchive(request("GET"), response, url("/v1/history/batches/batch_1?device=device_a"));
  assert.equal(response.status, 200);
  assert.deepEqual(response.payload, {
    batchId: "batch_1", deviceId: "device_a", blob: bytes.toString("base64"),
  });
  assert.deepEqual(Buffer.from(response.payload.blob, "base64"), bytes);

  for (const pathname of ["/v1/history/batches/batch_1", "/v1/history/batches/batch_1?device=bad%20id", "/v1/history/batches/bad%20id?device=device_a"]) {
    response = {};
    await state.handlers.routeHistoryArchive(request("GET"), response, url(pathname));
    assert.equal(response.status, 400, pathname);
  }

  response = {};
  await state.handlers.routeHistoryArchive(request("GET"), response, url("/v1/history/batches/missing?device=device_a"));
  assert.deepEqual(response, { status: 404, payload: { error: "history batch not found" } });
  assert.equal(batchIdFromPath("/v1/history/batches/"), null);
});

test("manifest persists across handler re-creation", async () => {
  const first = harness();
  await store(first, { batchId: "batch_1", createdAt: 1_000 });
  await store(first, { batchId: "batch_2", createdAt: 2_000 });

  const second = harness({ dataDir: first.dataDir, blobStore: first.blobStore });
  let response = {};
  await second.handlers.routeHistoryArchive(request("GET"), response, url("/v1/history/batches?device=device_a"));
  assert.deepEqual(response.payload.batches.map((entry) => entry.batchId), ["batch_1", "batch_2"]);

  const overwrite = await store(second, { batchId: "batch_1", createdAt: 1_500 });
  assert.equal(overwrite.status, 200);
  assert.equal(overwrite.payload.alreadyExisted, true);

  response = {};
  await second.handlers.routeHistoryArchive(request("GET"), response, url("/v1/history/batches/batch_2?device=device_a"));
  assert.equal(response.status, 200);
});

test("default body reader enforces its byte cap with 413 and invalid JSON with 400", async () => {
  const state = harness({ deps: { readBody: undefined } });
  const oversize = new EventEmitter();
  oversize.destroy = () => {};
  let response = {};
  const oversizePending = state.handlers.routeHistoryArchive(
    Object.assign(oversize, { method: "POST" }), response, url("/v1/history/batches"),
  );
  oversize.emit("data", Buffer.alloc(12 * 1024 * 1024 + 1));
  oversize.emit("end");
  await oversizePending;
  assert.deepEqual(response, { status: 413, payload: { error: "request body too large" } });

  const malformed = new EventEmitter();
  response = {};
  const malformedPending = state.handlers.routeHistoryArchive(
    Object.assign(malformed, { method: "POST" }), response, url("/v1/history/batches"),
  );
  malformed.emit("data", Buffer.from("{not json"));
  malformed.emit("end");
  await malformedPending;
  assert.deepEqual(response, { status: 400, payload: { error: "request body must be valid JSON" } });
  assert.deepEqual(state.blobStore.calls, []);
});

test("maps blob storage failures to an opaque 500", async () => {
  const state = harness({ blobStore: {
    calls: [], blobs: new Map(),
    put: async () => { throw new Error("private disk detail"); },
    readBytes: async () => { throw new Error("private disk detail"); },
  } });
  const stored = await store(state);
  assert.deepEqual(stored, { status: 500, payload: { error: "history batch storage unavailable" } });

  const response = {};
  await state.handlers.routeHistoryArchive(request("GET"), response, url("/v1/history/batches/batch_1?device=device_a"));
  assert.deepEqual(response, { status: 500, payload: { error: "history batch storage unavailable" } });
});
