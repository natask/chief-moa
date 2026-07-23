"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createThreadSwitchHandlers } = require("../lib/thread-switch-handlers");

function harness(overrides = {}) {
  const calls = { ensured: [], switches: [], writes: [] };
  const threadStore = {
    getActive: () => ({ branch_id: "active-parent" }),
    ensureThread: (sessionId, branchId, meta) => { calls.ensured.push({ sessionId, branchId, meta }); return { session_id: sessionId, branch_id: branchId, ...meta }; },
    readSummary: (_sessionId, branchId) => branchId === "active-parent" ? { summary: "parent summary" } : null,
    writeSummary: (...args) => calls.writes.push(args),
    recordSwitch: (sessionId, state) => { calls.switches.push({ sessionId, state }); return { active: state }; },
    ...overrides.threadStore,
  };
  const deps = {
    authorized: () => true, sendJson: (r, status, payload) => Object.assign(r, { status, payload }),
    readJsonBody: async (request) => request.body || {}, sanitizeOptionalId: (value, fallback) => value || fallback,
    sanitizeOptionalBlankId: (value) => String(value || "").trim(), defaultSessionId: () => "shared",
    profileDeviceIdFromBody: (body) => body.device_id || "", newBranchId: (action) => `${action}-id`,
    branchLatestTurn: (sessionId, branchId) => ({ turn_id: `${sessionId}:${branchId}` }), threadStore,
    isIncognitoBranch: (id) => id.startsWith("incognito"), threadListPayload: () => ({ threads: [{ id: "listed" }] }),
    now: () => new Date("2026-07-15T00:00:00Z"), ...overrides, threadStore,
  };
  return { handlers: createThreadSwitchHandlers(deps), calls };
}
const url = (path) => new URL(`https://test${path}`);
const request = (method, body = {}) => ({ method, body });

test("router ignores unrelated traffic and protects the mutation", async () => {
  assert.equal(await harness().handlers.routeThreadSwitch(request("GET"), {}, url("/v1/threads/switch")), false);
  assert.equal(await harness().handlers.routeThreadSwitch(request("POST"), {}, url("/other")), false);
  const state = harness({ authorized: () => false }); const response = {};
  assert.equal(await state.handlers.routeThreadSwitch(request("POST"), response, url("/v1/threads/switch")), true);
  assert.deepEqual(response, { status: 401, payload: { error: "missing or invalid gateway token" } });
});

test("explicit continuation preserves aliases, bounds metadata, and records the switch", async () => {
  const state = harness(); const response = {};
  await state.handlers.handleThreadSwitch(request("POST", { conversation_id: "s", branchId: "branch", source: "x".repeat(80), label: "y".repeat(140), device_id: "phone" }), response);
  assert.equal(response.status, 200); assert.equal(response.payload.surface.length, 60); assert.equal(response.payload.thread.branch_id, "branch");
  assert.equal(state.calls.ensured[0].meta.kind, undefined); assert.equal(state.calls.ensured[0].meta.label.length, 120);
  assert.equal(state.calls.switches[0].state.device_id, "phone"); assert.equal(state.calls.switches[0].state.at, "2026-07-15T00:00:00.000Z");
});

test("new and default actions create durable ordinary threads", async () => {
  let state = harness(); let response = {};
  await state.handlers.handleThreadSwitch(request("POST", { action: "NEW", thread_label: "Fresh" }), response);
  assert.equal(response.payload.thread.kind, "new"); assert.equal(response.payload.thread.branch_id, "new-id");
  state = harness(); response = {}; await state.handlers.handleThreadSwitch(request("POST", { action: "unknown" }), response);
  assert.equal(response.payload.thread.branch_id, "default"); assert.equal(response.payload.thread.kind, undefined);
});

test("fork inherits the active parent and seeds its summary exactly once", async () => {
  const state = harness(); const response = {};
  await state.handlers.handleThreadSwitch(request("POST", { session_id: "s", action: "fork" }), response);
  assert.equal(response.payload.thread.parent_branch_id, "active-parent");
  assert.deepEqual(response.payload.thread.fork_point, { turn_id: "s:active-parent" });
  assert.deepEqual(state.calls.writes[0], ["s", "fork-id", "parent summary", { turn_count: 0, source: "fork-seed" }]);

  state.calls.writes.length = 0;
  state.handlers.seedForkSummary("s", "existing", "missing-parent"); assert.equal(state.calls.writes.length, 0);
});

test("explicit fork parents, existing summaries, and incognito threads remain isolated", async () => {
  let state = harness({ threadStore: { readSummary: (_s, id) => id === "parent" ? { summary: "seed" } : { summary: "already" } } });
  let response = {}; await state.handlers.handleThreadSwitch(request("POST", { action: "fork", parent_branch_id: "parent" }), response);
  assert.equal(state.calls.writes.length, 0); assert.equal(response.payload.thread.parent_branch_id, "parent");

  state = harness(); response = {}; await state.handlers.routeThreadSwitch(request("POST", { action: "incognito" }), response, url("/v1/threads/switch"));
  assert.equal(state.calls.ensured.length, 0); assert.equal(response.payload.thread.kind, "incognito"); assert.equal(response.payload.thread.label, "Incognito");
  assert.deepEqual(response.payload.threads, [{ id: "listed" }]);
});

test("factory default clock emits an ISO switch timestamp", async () => {
  const state = harness({ now: undefined }); const response = {};
  await state.handlers.handleThreadSwitch(request("POST", { branch_id: "b" }), response);
  assert.match(state.calls.switches[0].state.at, /^\d{4}-\d{2}-\d{2}T/);
});
