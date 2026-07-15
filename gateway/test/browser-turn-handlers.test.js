"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserTurnHandlers } = require("../lib/browser-turn-handlers");

function harness(overrides = {}) {
  const writes = [];
  const evidenceWrites = [];
  const turn = {
    id: "turn-1", session_id: "session-1", conversation_id: "conversation-1",
    branch_id: "default", evidence_request_ids: ["evidence-request-1"], evidence_refs: ["old-ref"],
    page_ref: { url: "https://example.test" }, evidence_summary: { visible_text: "old" },
  };
  const store = {
    readBrowserTurnRecord: (id) => id === "turn-1" ? turn : null,
    findBrowserTurnByEvidenceRequestId: (id) => id === "evidence-request-1" ? turn : null,
    writeBrowserTurnRecord: (record) => writes.push(record),
    writeBrowserEvidenceRecord: (record) => evidenceWrites.push(record),
  };
  const browserTurns = {
    browserTurnHttpStatus: (record) => record.status === "completed" ? 200 : 202,
    browserLifecyclePayload: (record, options = {}) => ({ id: record.id, status: record.status, legacy: options.legacy || "" }),
  };
  const deps = {
    authorized: () => true,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    readJsonBody: async (request) => request.body || {},
    browserAgentRoleCatalog: () => ({ roles: ["delegate"] }),
    browserTurnStore: store,
    browserTurns,
    browserTurnModality: (body) => body.transcript ? "voice" : "text",
    browserTurnInputText: (body) => String(body.text || body.transcript || "").trim(),
    buildBrowserTurnRecord: async (body, options) => ({ id: "built", text: body.text || body.transcript, status: body.completed ? "completed" : "needs_evidence", modality: options.modality }),
    cleanError: (error) => error.message,
    browserEvidenceSummaryFromBody: (body) => body.summary || { visible_text: body.visible_text || "", source_ref: body.source_ref || "", page_ref: body.page_ref || null },
    sanitizeOptionalId: (value, fallback) => String(value || fallback),
    randomId: () => "evidence-generated",
    sanitizeLooseId: (value) => `safe-${value}`,
    sanitizeBrowserClientMetadata: (value) => value || {},
    mergeBrowserPageRefs: (...refs) => Object.assign({}, ...refs.filter(Boolean)),
    browserPageRefFromBody: (body) => body.page || {},
    sanitizeBrowserScreenshot: (value) => value || null,
    browserTurnLifecycle: { completeBrowserTurnRecord: async (record) => ({ ...record, status: "completed" }) },
    mergeBrowserEvidenceSummaries: (left, right) => ({ ...(left || {}), ...(right || {}) }),
    attachBrowserRoleExecution: (record) => ({ ...record, role_attached: true }),
    now: () => "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
  return { handlers: createBrowserTurnHandlers(deps), store, browserTurns, turn, writes, evidenceWrites };
}

const request = (method, body = {}) => ({ method, body });
const url = (path) => new URL(`http://gateway.test${path}`);

test("router authorizes browser routes and leaves unrelated traffic alone", async () => {
  const state = harness({ authorized: () => false });
  const response = {};
  assert.equal(await state.handlers.routeBrowserTurns(request("GET"), response, url("/v1/browser/roles")), true);
  assert.deepEqual(response, { status: 401, payload: { error: "missing or invalid gateway token" } });
  assert.equal(await state.handlers.routeBrowserTurns(request("DELETE"), {}, url("/v1/browser/turns")), false);
  assert.equal(await state.handlers.routeBrowserTurns(request("GET"), {}, url("/other")), false);
});

test("router covers roles, create, evidence, and decoded status reads", async () => {
  const state = harness();
  let response = {};
  await state.handlers.routeBrowserTurns(request("GET"), response, url("/v1/browser/roles"));
  assert.deepEqual(response.payload, { roles: ["delegate"] });
  response = {};
  await state.handlers.routeBrowserTurns(request("POST", { text: "question" }), response, url("/v1/browser/turns"));
  assert.equal(response.status, 202);
  response = {};
  await state.handlers.routeBrowserTurns(request("POST", { turn_id: "turn-1", visible_text: "answer" }), response, url("/v1/browser/evidence"));
  assert.equal(response.status, 200);
  response = {};
  await state.handlers.routeBrowserTurns(request("GET"), response, url("/v1/browser/turns/turn%2D1/status"));
  assert.equal(response.payload.id, "turn-1");
  response = {};
  await state.handlers.routeBrowserTurns(request("GET"), response, url("/v1/browser/turns/missing/status"));
  assert.equal(response.status, 404);
});

test("turn creation validates text, bounds build errors, and preserves modality and legacy shape", async () => {
  let state = harness();
  let response = {};
  await state.handlers.handleBrowserTurnBody(response, {});
  assert.equal(response.status, 400);

  state = harness({ buildBrowserTurnRecord: async () => { throw new Error("invalid turn"); } });
  response = {};
  await state.handlers.handleBrowserTurnBody(response, { text: "hello" });
  assert.deepEqual(response, { status: 400, payload: { error: "invalid turn" } });

  state = harness();
  response = {};
  await state.handlers.handleBrowserTurnBody(response, { text: "hello", completed: true }, { modality: "voice", legacy: "chat" });
  assert.equal(response.status, 200);
  assert.equal(state.writes[0].modality, "voice");
  assert.equal(response.payload.legacy, "chat");

  response = {};
  await state.handlers.handleBrowserTurn(request("POST", { transcript: "spoken" }), response);
  assert.equal(state.writes[1].modality, "voice");
  assert.equal(response.payload.legacy, "browser");
});

test("evidence requires a locator, an existing turn, and visible evidence", async () => {
  let state = harness();
  let response = {};
  await state.handlers.handleBrowserEvidence(request("POST"), response);
  assert.equal(response.status, 400);

  response = {};
  await state.handlers.handleBrowserEvidence(request("POST", { browserTurnId: "missing", visible_text: "x" }), response);
  assert.equal(response.status, 404);

  state = harness();
  response = {};
  await state.handlers.handleBrowserEvidence(request("POST", { browser_turn_id: "turn-1" }), response);
  assert.deepEqual(response, { status: 400, payload: { error: "evidence or screen visible text is required" } });
});

test("evidence lookup by request id completes, dedupes, persists, and projects aliases", async () => {
  const state = harness();
  const response = {};
  await state.handlers.handleBrowserEvidence(request("POST", {
    requestId: "evidence-request-1", id: "evidence-explicit", source_ref: "dom:1",
    source: "extension", client: { source: "client-source" }, page: { title: "Page" }, screenshot: { id: 1 },
  }), response);
  assert.equal(response.status, 200);
  assert.equal(response.payload.evidence.id, "evidence-explicit");
  assert.equal(response.payload.evidence.evidence_request_id, "safe-evidence-request-1");
  assert.deepEqual(state.writes[0].evidence_refs, ["old-ref", "evidence-explicit"]);
  assert.equal(state.writes[0].role_attached, true);
  assert.equal(state.evidenceWrites.length, 1);
});

test("turn-id evidence uses request fallback, generated ids, client source, and default clock", async () => {
  const state = harness({ now: undefined });
  const response = {};
  await state.handlers.handleBrowserEvidence(request("POST", {
    turn_id: "turn-1", visible_text: "visible", client: { source: "client-source" }, evidence_id: "",
  }), response);
  assert.equal(response.payload.evidence.id, "evidence-generated");
  assert.equal(response.payload.evidence.evidence_request_id, "evidence-request-1");
  assert.equal(response.payload.evidence.source, "client-source");
  assert.match(response.payload.evidence.created_at, /^2026-/);
});

test("primitive aliases cover browserTurnId and evidence_request_id precedence", async () => {
  const state = harness();
  let response = {};
  await state.handlers.handleBrowserEvidence(request("POST", { browserTurnId: "turn-1", request_id: "evidence-request-1", visible_text: "x" }), response);
  assert.equal(response.payload.evidence.evidence_request_id, "safe-evidence-request-1");
  response = {};
  await state.handlers.handleBrowserEvidence(request("POST", { evidence_request_id: "evidence-request-1", visible_text: "x" }), response);
  assert.equal(response.status, 200);
});
