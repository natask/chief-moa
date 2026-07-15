"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBrokerResearchHandlers } = require("../lib/broker-research-handlers");

function harness(overrides = {}) {
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-broker-research-"));
  const calls = { stored: [], research: [], models: [], events: [] };
  const decision = { id: "decision-1", target_type: "workflow", target_id: "landscape-research" };
  const stored = { id: "event-1", session_id: "session-1", branch_id: "branch-1", decisions: [decision] };
  const deps = {
    authorized: () => true, sendJson: (r, status, payload) => Object.assign(r, { status, payload }),
    readJsonBody: async (request) => request.body || {}, brokerMessageText: (body) => body.text || body.transcript || "",
    storeBrokerMessage: async (body, text) => { calls.stored.push({ body, text }); return { stored, decisions: [decision], contextPacks: ["pack"], launches: ["launch"] }; },
    runResearch: async (input, options) => { calls.research.push({ input, options }); return { id: options.idFactory(), query: input.query, broker_event_id: input.broker_event_id, created_at: "2026-01-01", pass_count: 2, runner_used: true, session_id: input.session_id, route_decision_id: input.route_decision_id }; },
    randomId: (prefix) => `${prefix}-id`, callModelOrFallback: async (messages, profile) => { calls.models.push({ messages, profile }); return "  findings  "; },
    effectiveProfile: () => ({ model: "test" }), truncate: (value, limit) => String(value).slice(0, limit),
    sanitizeOptionalId: (value, fallback) => String(value || "").replace(/[^a-z0-9-]/gi, "") || fallback,
    reportsDir, recordProductEventBestEffort: async (event) => calls.events.push(event),
    now: () => new Date("2026-07-15T00:00:00Z"), ...overrides, reportsDir,
  };
  return { handlers: createBrokerResearchHandlers(deps), calls, reportsDir, stored, decision };
}
const req = (method, body = {}) => ({ method, body });
const url = (pathValue) => new URL(`https://test${pathValue}`);

test("router ignores unrelated traffic and protects all broker routes", async (t) => {
  let state = harness(); t.after(() => fs.rmSync(state.reportsDir, { recursive: true, force: true }));
  assert.equal(await state.handlers.routeBrokerResearch(req("GET"), {}, url("/other")), false);
  state = harness({ authorized: () => false }); t.after(() => fs.rmSync(state.reportsDir, { recursive: true, force: true }));
  for (const [method, pathValue] of [["POST", "/v1/broker/messages"], ["POST", "/v1/broker/research"], ["GET", "/v1/broker/research/id"]]) {
    const response = {}; assert.equal(await state.handlers.routeBrokerResearch(req(method), response, url(pathValue)), true); assert.equal(response.status, 401);
  }
});

test("message validation and accepted storage preserve response projections", async (t) => {
  const state = harness(); t.after(() => fs.rmSync(state.reportsDir, { recursive: true, force: true }));
  let response = {}; await state.handlers.handleMessage(req("POST"), response); assert.equal(response.status, 400);
  response = {}; await state.handlers.routeBrokerResearch(req("POST", { transcript: "hello" }), response, url("/v1/broker/messages"));
  assert.equal(response.status, 202); assert.equal(response.payload.event.id, "event-1"); assert.deepEqual(response.payload.context_packs, ["pack"]); assert.deepEqual(response.payload.launches, ["launch"]);
});

test("selected research stores a report, event, and exact routing evidence", async (t) => {
  const state = harness(); t.after(() => fs.rmSync(state.reportsDir, { recursive: true, force: true })); const response = {};
  await state.handlers.routeBrokerResearch(req("POST", { text: "market", context: 42, max_passes: 3 }), response, url("/v1/broker/research"));
  assert.equal(response.status, 201); assert.equal(response.payload.research_selected, true); assert.equal(response.payload.report.id, "research-id");
  assert.equal(state.calls.stored[0].body.source, "broker-research");
  assert.deepEqual(state.calls.research[0].input, { query: "market", context: "42", source: "broker-research", session_id: "session-1", branch_id: "branch-1", broker_event_id: "event-1", route_decision_id: "decision-1", max_passes: 3 });
  assert.equal(state.calls.events[0].stream_id, "broker:event-1"); assert.equal(state.calls.events[0].correlation_id, "event-1");
  assert.equal(state.handlers.readReport("research-id").query, "market");
});

test("unselected research uses legacy identity and event fallbacks", async (t) => {
  const stored = { id: "event-2", conversation_id: "legacy", decisions: null };
  const state = harness({ storeBrokerMessage: async () => ({ stored }), runResearch: async (input) => ({ id: "report-2", query: input.query, pass_count: 0, runner_used: false }) });
  t.after(() => fs.rmSync(state.reportsDir, { recursive: true, force: true })); let response = {};
  await state.handlers.handleResearch(req("POST"), response); assert.equal(response.status, 400);
  response = {}; await state.handlers.handleResearch(req("POST", { text: "query", source: "custom" }), response);
  assert.equal(response.payload.research_selected, false); assert.deepEqual(response.payload.decisions, []);
  assert.equal(state.calls.events[0].stream_id, "research:report-2"); assert.equal(state.calls.events[0].occurred_at, "2026-07-15T00:00:00.000Z");
  assert.equal(state.calls.events[0].payload.session_id, ""); assert.equal(state.calls.events[0].payload.route_decision_id, "");
});

test("research pass builds bounded evidence messages and returns provider output", async (t) => {
  const state = harness(); t.after(() => fs.rmSync(state.reportsDir, { recursive: true, force: true }));
  const sources = ["one", { url: "https://example.test" }];
  const result = await state.handlers.gatewayResearchRunPass("question", { context: "ctx", sources });
  assert.deepEqual(result, { text: "findings", sources }); assert.equal(state.calls.models[0].profile.model, "test");
  assert.match(state.calls.models[0].messages[1].content, /Context/); assert.match(state.calls.models[0].messages[2].content, /example/);
  const noSources = await state.handlers.gatewayResearchRunPass("plain"); assert.deepEqual(noSources.sources, []);
});

test("empty and failed model passes request deterministic fallback", async (t) => {
  let state = harness({ callModelOrFallback: async () => "  " }); t.after(() => fs.rmSync(state.reportsDir, { recursive: true, force: true }));
  assert.deepEqual(await state.handlers.gatewayResearchRunPass("q", { sources: "invalid" }), { __fallback: true });
  state = harness({ callModelOrFallback: async () => { throw new Error("offline"); } }); t.after(() => fs.rmSync(state.reportsDir, { recursive: true, force: true }));
  assert.deepEqual(await state.handlers.gatewayResearchRunPass("q"), { __fallback: true });
});

test("report persistence sanitizes ids and read routes map missing or corrupt files", async (t) => {
  const state = harness(); t.after(() => fs.rmSync(state.reportsDir, { recursive: true, force: true }));
  state.handlers.writeReport({ id: "bad/id", value: 1 }); assert.equal(state.handlers.readReport("badid").value, 1);
  state.handlers.writeReport({ id: "", value: 2 }); assert.equal(state.handlers.readReport("research-id").value, 2);
  fs.writeFileSync(path.join(state.reportsDir, "corrupt.json"), "{"); assert.equal(state.handlers.readReport("corrupt"), null); assert.equal(state.handlers.readReport(""), null);
  let response = {}; state.handlers.sendReport(response, "missing"); assert.equal(response.status, 404);
  response = {}; await state.handlers.routeBrokerResearch(req("GET"), response, url("/v1/broker/research/badid")); assert.equal(response.status, 200);
});

test("default event clock remains usable", async (t) => {
  const state = harness({ now: undefined }); t.after(() => fs.rmSync(state.reportsDir, { recursive: true, force: true }));
  await state.handlers.recordProductEvent({ id: "r", query: "q" }); assert.match(state.calls.events[0].occurred_at, /^\d{4}-/);
});
