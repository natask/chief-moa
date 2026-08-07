"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyActor,
  applyContextFromBody,
  createSelfExtensionHandlers,
} = require("../lib/self-extension-handlers");

function harness(overrides = {}) {
  const calls = [];
  const events = [];
  const artifacts = {
    list: (filter) => { calls.push(["list", filter]); return [{ id: "art_1" }]; },
    runtime: (protocol) => {
      calls.push(["runtime", protocol]);
      return { active: { avatar_behavior: { artifact_id: "art_1" } } };
    },
    known: () => ({ artifact_types: ["avatar_behavior"] }),
    createCandidate: (input) => ({
      id: "art_1", type: "avatar_behavior", title: input.title || "title", status: "draft",
      variant_group_id: "var_1", parent_id: "", prompt: "prompt", spec: input.spec || {},
      preview: {}, validation: { ok: true }, created_at: "2026-07-15T00:00:00Z",
    }),
    apply: (id, context) => id === "missing" ? null : ({
      id, type: "avatar_behavior", title: "title", variant_group_id: "var_1", spec: {}, preview: {},
      applied_at: "2026-07-15T00:01:00Z", apply_context: context,
    }),
    ...overrides.artifacts,
  };
  const handlers = createSelfExtensionHandlers({
    artifacts,
    authorizedAgent: overrides.authorizedAgent || (() => true),
    agentAuthError: () => ({ error: "unauthorized" }),
    readJsonBody: async (request) => request.body,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    cleanError: (error) => String(error?.message || error),
    recordProductEventBestEffort: (event) => events.push(event),
    ...(overrides.useDefaultNow ? {} : { now: () => "2026-07-15T00:02:00Z" }),
  });
  return { handlers, artifacts, calls, events };
}

async function route(h, method, pathname, body) {
  const request = { method, body };
  const response = {};
  const handled = await h.handlers.routeSelfExtensions(request, response, new URL(pathname, "http://local"));
  return { handled, ...response };
}

test("router rejects unauthorized requests and ignores unrelated or unsupported methods", async () => {
  const denied = harness({ authorizedAgent: () => false });
  const response = await route(denied, "GET", "/v1/self-extension/artifacts");
  assert.equal(response.handled, true);
  assert.equal(response.status, 401);
  assert.deepEqual(response.payload, { error: "unauthorized" });

  const h = harness();
  assert.equal((await route(h, "GET", "/unrelated")).handled, false);
  assert.equal((await route(h, "DELETE", "/v1/self-extension/artifacts")).handled, false);
  assert.equal((await route(h, "POST", "/v1/self-extension/runtime")).handled, false);
  assert.equal((await route(h, "GET", "/v1/self-extension/artifacts/art_1/apply")).handled, false);
});

test("list and runtime routes return filtered safe projections", async () => {
  const h = harness();
  let response = await route(h, "GET", "/v1/self-extension/artifacts?type=avatar_behavior&status=draft&limit=2");
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls[0], ["list", { type: "avatar_behavior", status: "draft", limit: 2 }]);
  assert.equal(response.payload.active.avatar_behavior.artifact_id, "art_1");
  assert.deepEqual(response.payload.known.artifact_types, ["avatar_behavior"]);

  response = await route(h, "GET", "/v1/self-extension/runtime?shell_protocol=1.0.0");
  assert.equal(response.status, 200);
  assert.equal(response.payload.runtime.active.avatar_behavior.artifact_id, "art_1");
  assert.deepEqual(h.calls.at(-1), ["runtime", "1.0.0"]);
});

test("create accepts wrappers, records product evidence, and sanitizes failures", async () => {
  const h = harness();
  let response = await route(h, "POST", "/v1/self-extension/artifacts", { artifact: { title: "wrapped", spec: { trigger: "idle" } } });
  assert.equal(response.status, 201);
  assert.equal(response.payload.artifact.title, "wrapped");
  assert.equal(h.events[0].event_type, "self_extension.artifact.created");
  assert.equal(h.events[0].payload.id, "art_1");

  response = await route(h, "POST", "/v1/self-extension/artifacts", null);
  assert.equal(response.status, 201);

  const failed = harness({ artifacts: { createCandidate() { throw new Error("invalid candidate"); } } });
  response = await route(failed, "POST", "/v1/self-extension/artifacts", []);
  assert.equal(response.status, 400);
  assert.equal(response.payload.error, "invalid candidate");
});

test("apply requires provenance and approval and covers missing and store failures", async () => {
  const h = harness();
  let response = await route(h, "POST", "/v1/self-extension/artifacts/art_1/apply", {});
  assert.equal(response.status, 400);
  assert.match(response.payload.error, /source.kind is required/);
  assert.match(response.payload.error, /approval.mode is required/);
  assert.match(response.payload.error, /approved_by is required/);

  response = await route(h, "POST", "/v1/self-extension/artifacts/missing/apply", {
    source_kind: "manual_api", approval_mode: "developer", approved_by: "dev",
  });
  assert.equal(response.status, 404);

  const failed = harness({ artifacts: { apply() { throw new Error("cannot apply"); } } });
  response = await route(failed, "POST", "/v1/self-extension/artifacts/art_1/apply", {
    source_kind: "manual_api", approval_mode: "developer", approved_by: "dev",
  });
  assert.equal(response.status, 400);
  assert.equal(response.payload.error, "cannot apply");
});

test("apply stores normalized aliases and attributes user and agent approvals", async () => {
  const h = harness();
  let response = await route(h, "POST", "/v1/self-extension/artifacts/art%3A1/apply", {
    provenance: {
      kind: "user_turn", turnId: "turn bad!", brokerEventId: "event/1", agentRunId: "run/1",
      sessionId: "session/1", branchId: "branch/1", deviceId: "device/1", surface: "phone ui", reason: "source reason",
    },
    approval: { mode: "explicit_user", approvedBy: " User One ", approvalId: "approval/1" },
    requestedBy: "requester",
  });
  assert.equal(response.status, 200);
  assert.equal(response.payload.artifact.id, "art:1");
  assert.equal(response.payload.artifact.apply_context.source.turn_id, "turnbad");
  assert.equal(response.payload.artifact.apply_context.approval.approved_by, "User One");
  assert.deepEqual(h.events[0].actor, { kind: "user", id: "User One" });
  assert.equal(h.events[0].event_type, "self_extension.artifact.applied");

  response = await route(h, "POST", "/v1/self-extension/artifacts/art_2/apply", {
    source: { kind: "agent_run" },
    approval: { mode: "test", approved_by: "runner", reason: "test reason" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(h.events[1].actor, { kind: "agent", id: "runner", mode: "test" });
});

test("apply metadata pure helpers cover invalid types, enums, fallbacks, and bounds", () => {
  for (const body of [null, [], "bad", { source: [], approval: [] }]) {
    assert.equal(applyContextFromBody(body).ok, false);
  }
  let result = applyContextFromBody({ source_kind: "bad", approval_mode: "bad", approved_by: "x" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /must be one of/);

  result = applyContextFromBody({
    source_kind: "smoke",
    approval_mode: "developer",
    approved_by: "x".repeat(140),
    reason: "r".repeat(300),
    requested_by: 4,
  }, () => "fixed");
  assert.equal(result.ok, true);
  assert.equal(result.context.approval.approved_by.length, 120);
  assert.equal(result.context.reason.length, 240);
  assert.equal(result.context.requested_by, "");
  assert.equal(result.context.recorded_at, "fixed");

  result = applyContextFromBody({
    source_kind: "smoke", approval_mode: "test", approved_by: "coverage",
  });
  assert.match(result.context.recorded_at, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(applyActor({ approval: { mode: "explicit_user", approved_by: "" } }), { kind: "user", id: "unknown" });
  assert.deepEqual(applyActor({}), { kind: "agent", id: "self-extension", mode: "unknown" });
  assert.deepEqual(applyActor({ approval: { mode: 4, approved_by: 4 } }), { kind: "agent", id: "self-extension", mode: "unknown" });
});

test("handler factory supplies a timestamp when the caller omits a clock", async () => {
  const h = harness({ useDefaultNow: true });
  const response = await route(h, "POST", "/v1/self-extension/artifacts/art_1/apply", {
    source_kind: "smoke", approval_mode: "test", approved_by: "coverage",
  });
  assert.equal(response.status, 200);
  assert.match(response.payload.artifact.apply_context.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
});
