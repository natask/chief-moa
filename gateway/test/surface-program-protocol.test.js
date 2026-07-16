"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../lib/surface-program-protocol");

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const hex = (letter) => letter.repeat(64);
const clone = (value) => JSON.parse(JSON.stringify(value));

function advertisement(overrides = {}, options = {}) {
  const value = {
    version: 1, type: "surface.runtime.advertised", advertisement_id: "ad-1",
    target: { surface_type: "browser_extension", device_id: "browser-1" },
    runtime: { runtime_id: "browser.javascript.v1", language: "javascript", bridge_version: 1, entrypoint: "main" },
    catalog: { version: 7, sha256: hex("a"), capability_ids: ["browser.observe", "browser.click"] },
    limits: { source_bytes: 4096, wall_ms: 30000, memory_bytes: 32 * 1024 * 1024, tool_calls: 100, parallel_calls: 8, result_bytes: 65536, log_bytes: 32768 },
    issued_at: new Date(NOW - 1000).toISOString(), expires_at: new Date(NOW + 60000).toISOString(),
    ...overrides,
  };
  return p.sanitizeExecutionRuntime(value, { nowMs: NOW, ...options });
}

function selection(ad = advertisement()) {
  return { device: { device_id: "browser-1", surface_type: "browser_extension", online: true }, advertisement: ad, runtime: ad.runtime };
}

function proposal(overrides = {}, options = {}) {
  const source = "const page = await tools.browser.observe({}); return page;";
  return p.createSurfaceProgramEnvelope({
    source, session_id: "session-1", turn_id: "turn-1",
    bindings: { kind: "browser_document", tab_id: 7, window_id: 3, frame_id: 0, origin: "https://fixture.test", document_id: "doc-1", page_epoch: 9, observation_id: "obs-1", observation_sha256: hex("b"), state_sha256: hex("c") },
    limits: { wall_ms: 5000, memory_bytes: 2 * 1024 * 1024, tool_calls: 8, parallel_calls: 2, result_bytes: 4096, log_bytes: 0 },
    approval_policy: { program: "local_policy", always_ask: ["external_side_effect"] },
    expires_in_ms: 30000, idempotency_key: "idem-1", ...overrides,
  }, selection(options.advertisement || advertisement()), { nowMs: NOW, executionId: "exec-1", ...options });
}

function receipt(envelope, overrides = {}) {
  const value = {
    version: 1, type: "surface.execution.receipt", receipt_id: "receipt-1",
    execution_id: envelope.execution_id, session_id: envelope.session_id, turn_id: envelope.turn_id,
    claimant: { surface_type: "browser_extension", device_id: "browser-1", client_instance_id: "client-1" },
    runtime_id: envelope.runtime.runtime_id, ...p.surfaceProgramReceiptBindings(envelope),
    started_at: new Date(NOW + 100).toISOString(), finished_at: new Date(NOW + 200).toISOString(), status: "completed",
    tool_attempts: { count: 0, first_receipt_sha256: null, last_receipt_sha256: null },
    result: { summary: "Fixture complete", data_sha256: null, artifact_refs: [] },
    final_state_sha256: hex("d"), error: { code: null, message: null }, previous_receipt_sha256: null, receipt_sha256: hex("e"),
    ...overrides,
  };
  value.receipt_sha256 = p.receiptDigest(value);
  return value;
}

function executionEvent(envelope, sequence, kind, payload) {
  return { version: 1, type: "surface.execution.event", event_id: `event-${sequence}`, execution_id: envelope.execution_id, sequence, kind, occurred_at: new Date(NOW + sequence).toISOString(), claimant: { surface_type: envelope.target.surface_type, device_id: envelope.target.device_id, client_instance_id: "client-1" }, payload };
}

function toolReceipt(envelope, overrides = {}) {
  const value = {
    version: 1, type: "surface.execution.tool_receipt", receipt_id: "tool-receipt-1", execution_id: envelope.execution_id,
    claimant: { surface_type: envelope.target.surface_type, device_id: envelope.target.device_id, client_instance_id: "client-1" },
    tool_call_id: "call-1", attempt: 1, capability_id: "browser.observe", ...p.surfaceProgramReceiptBindings(envelope),
    input_sha256: hex("1"), pre_state_sha256: envelope.bindings.state_sha256, approval_id: null,
    started_at: new Date(NOW + 10).toISOString(), finished_at: new Date(NOW + 20).toISOString(), status: "succeeded",
    result: { summary: "Observed fixture", data_sha256: null, resource_id: "fixture-1" }, post_state_sha256: hex("2"), previous_receipt_sha256: null, receipt_sha256: hex("3"),
    ...overrides,
  };
  value.receipt_sha256 = p.receiptDigest(value);
  return value;
}

test("closed runtime advertisements are normalized and exact-target filtered", () => {
  const ad = advertisement({}, { device_id: "browser-1", surface_type: "browser_extension" });
  assert.equal(ad.runtime.runtime_id, "browser.javascript.v1");
  assert.equal(ad.catalog.version, 7);
  assert.equal(Object.isFrozen(ad), true);
  assert.equal(advertisement({}, { device_id: "other" }), null);
  assert.equal(advertisement({}, { surface_type: "android" }), null);
  assert.equal(advertisement({ extra: true }), null);
  assert.equal(advertisement({ version: 2 }), null);
  assert.equal(advertisement({ issued_at: new Date(NOW + 31000).toISOString(), expires_at: new Date(NOW + 60000).toISOString() }), null);
  assert.equal(advertisement({ runtime: { runtime_id: "browser.javascript.v1", language: "shell", bridge_version: 1, entrypoint: "main" } }), null);
  assert.equal(advertisement({ runtime: { runtime_id: "unknown", language: "javascript", bridge_version: 1, entrypoint: "main" } }), null);
  assert.equal(advertisement({ catalog: { version: 7, sha256: "bad", capability_ids: [] } }), null);
  assert.equal(advertisement({ catalog: { version: 7, sha256: hex("a"), capability_ids: ["browser.observe", "browser.observe"] } }), null);
  assert.equal(advertisement({ expires_at: new Date(NOW - 2000).toISOString() }), null);
  assert.deepEqual(p.sanitizeExecutionRuntimes({}), []);
  assert.equal(p.sanitizeExecutionRuntimes([ad, ad], { nowMs: NOW }).length, 1);
});

test("selection honors live exact device, surface, runtime, language, and newest advertisement", () => {
  const older = advertisement({ advertisement_id: "old", issued_at: new Date(NOW - 2000).toISOString() });
  const newer = advertisement({ advertisement_id: "new" });
  const devices = [
    { device_id: "browser-1", surface_type: "browser_extension", online: true, execution_runtimes: [older, newer] },
    { device_id: "off", surface_type: "browser_extension", online: false, execution_runtimes: [newer] },
  ];
  assert.equal(p.selectSurfaceRuntime(devices, { nowMs: NOW }).advertisement.advertisement_id, "old"); // duplicate runtime ids preserve first
  assert.ok(p.selectSurfaceRuntime(devices, { nowMs: NOW, target_device_id: "browser-1", target_surface_type: "browser_extension", runtime_id: "browser.javascript.v1", language: "javascript" }));
  assert.equal(p.selectSurfaceRuntime(devices, { nowMs: NOW, device_id: "missing" }), null);
  assert.equal(p.selectSurfaceRuntime(devices, { nowMs: NOW, surface_type: "android" }), null);
  assert.equal(p.selectSurfaceRuntime(devices, { nowMs: NOW, runtime_id: "other" }), null);
  assert.equal(p.selectSurfaceRuntime({}, {}), null);
});

test("proposal preserves typed browser bindings and validates exact advertisement", () => {
  const value = proposal();
  assert.equal(value.runtime.entrypoint, "main");
  assert.equal(typeof value.bindings.tab_id, "number");
  assert.equal(typeof value.bindings.window_id, "number");
  assert.equal(typeof value.bindings.page_epoch, "number");
  assert.equal(value.bindings.observation_sha256, hex("b"));
  assert.equal(value.program.sha256, p.sha256(value.program.source));
  assert.equal(value.limits.source_bytes, Buffer.byteLength(value.program.source));
  assert.equal(p.validateSurfaceProgramEnvelope(value, { nowMs: NOW + 1, target_device_id: "browser-1", advertisement: advertisement() }), value);
  assert.equal(p.canonicalJson({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
  assert.equal(p.sha256({ b: 1, a: 2 }), p.sha256({ a: 2, b: 1 }));
});

test("proposal creation rejects escalation, malformed bindings, limits, and source", () => {
  const bound = clone(proposal().bindings);
  assert.throws(() => p.createSurfaceProgramEnvelope({}, null), { code: "runtime_unavailable" });
  assert.throws(() => proposal({ source: "" }), { code: "invalid_program_source" });
  assert.throws(() => proposal({ source: "x".repeat(5000) }), { code: "invalid_program_source" });
  assert.throws(() => proposal({ extra: true }), { code: "unknown_request_field" });
  assert.throws(() => proposal({ allowed_capability_ids: ["browser.shell"] }), { code: "capability_escalation" });
  assert.throws(() => proposal({ expires_in_ms: 10 }), { code: "invalid_expires_in_ms" });
  assert.throws(() => proposal({ limits: { wall_ms: 1 } }), { code: "invalid_wall_ms" });
  assert.throws(() => proposal({ bindings: { kind: "other" } }), { code: "invalid_binding_kind" });
  assert.throws(() => proposal({ bindings: { ...bound, tab_id: "7" } }), { code: "invalid_tab_id" });
  assert.throws(() => proposal({ bindings: { ...bound, observation_sha256: "bad" } }), { code: "invalid_observation_sha256" });
  assert.throws(() => proposal({ bindings: { ...bound, unknown: true } }), { code: "unknown_bindings_field" });
  const evalAd = advertisement({ catalog: { version: 7, sha256: hex("a"), capability_ids: ["browser.observe", "browser.page.evaluate"] } });
  assert.throws(() => proposal({ bindings: bound }, { advertisement: evalAd }), { code: "missing_browser_evaluation_binding" });
  assert.throws(() => proposal({ bindings: { ...bound, allowed_frames: [0], allowed_worlds: ["WORLD"], site_grant_id: "grant" } }, { advertisement: evalAd }), { code: "invalid_allowed_worlds" });
  assert.equal(proposal({ bindings: { ...bound, allowed_frames: [0], allowed_worlds: ["ISOLATED"], site_grant_id: "grant" } }, { advertisement: evalAd }).bindings.site_grant_id, "grant");
  assert.throws(() => proposal({ bindings: { ...bound, origin: "https://user:pass@fixture.test" } }), { code: "invalid_origin" });
  assert.throws(() => proposal({ approval_policy: { program: "local", always_ask: "all" } }), { code: "invalid_always_ask" });
  assert.throws(() => proposal({ approval_policy: { program: "local", always_ask: [] } }), { code: "invalid_approval_policy" });
});

test("all binding variants preserve their authority-bearing types", () => {
  const cases = [
    [{ kind: "android_accessibility", package_name: "fixture.app", window_id: "window-1", observation_id: "obs", observation_generation: 2, state_sha256: hex("a") }, "android", { runtime_id: "android.webview-js.v1", language: "javascript", bridge_version: 1, entrypoint: "main" }],
    [{ kind: "macos_accessibility", bundle_id: "fixture.app", pid: 4, process_generation: "launch-2", signing_identity: "fixture", window_id: "w", ax_snapshot_id: "ax", state_sha256: hex("a"), local_grant_id: "grant" }, "macos", { runtime_id: "macos.javascriptcore-ax.v1", language: "javascript", bridge_version: 1, entrypoint: "main" }],
    [{ kind: "macos_apple_events", target_bundle_id: "fixture.app", signing_identity: "fixture", suite_allowlist: ["core"], command_allowlist: ["open"], state_sha256: hex("a"), local_grant_id: "grant" }, "macos", { runtime_id: "macos.jxa.v1", language: "jxa", bridge_version: 1, entrypoint: "main" }],
    [{ kind: "macos_shell", policy_id: "safe", argument_sha256: hex("a"), cwd_profile_id: "tmp", filesystem_profile_id: "fixture", network_profile_id: "none", environment_sha256: hex("b"), state_sha256: hex("c"), local_grant_id: "grant" }, "macos", { runtime_id: "macos.shell.v1", language: "shell", bridge_version: 1, entrypoint: "main" }],
    [{ kind: "gateway_server", tenant_id: "t", project_id: "p", state_sha256: hex("a") }, "gateway", { runtime_id: "gateway.quickjs.v1", language: "javascript", bridge_version: 1, entrypoint: "main" }],
  ];
  for (const [bindings, surfaceType, runtime] of cases) {
    const ad = advertisement({ target: { surface_type: surfaceType, device_id: "browser-1" }, runtime });
    assert.equal(proposal({ bindings }, { advertisement: ad }).bindings.kind, bindings.kind);
  }
});

test("proposal validation rejects tampering, expiry, target, and catalog drift", () => {
  const value = proposal();
  const cases = [
    ["unsupported_envelope", (v) => { v.version = 2; }],
    ["unknown_envelope_field", (v) => { v.extra = true; }],
    ["program_hash_mismatch", (v) => { v.program.source += " "; }],
    ["invalid_catalog_sha256", (v) => { v.catalog.sha256 = "bad"; }],
    ["invalid_allowed_capability_ids", (v) => { v.catalog.allowed_capability_ids = ["Bad Name"]; }],
    ["invalid_expiry", (v) => { v.expires_at = v.issued_at; }],
  ];
  for (const [code, mutate] of cases) { const copy = clone(value); mutate(copy); assert.throws(() => p.validateSurfaceProgramEnvelope(copy, { nowMs: NOW + 1 }), { code }); }
  assert.throws(() => p.validateSurfaceProgramEnvelope(value, { nowMs: NOW + 30000 }), { code: "expired" });
  assert.throws(() => p.validateSurfaceProgramEnvelope(value, { nowMs: NOW + 1, target_device_id: "other" }), { code: "target_mismatch" });
  const drift = clone(advertisement()); drift.catalog.version = 8;
  assert.throws(() => p.validateSurfaceProgramEnvelope(value, { nowMs: NOW + 1, advertisement: drift }), { code: "runtime_catalog_mismatch" });
});

test("terminal receipt is exact-claim bound and closed", () => {
  const env = proposal(); const claim = { device_id: "browser-1", client_instance_id: "client-1" };
  const valid = p.validateSurfaceProgramTerminalReceipt(env, receipt(env), claim, { nowMs: NOW + 300 });
  assert.equal(valid.status, "completed"); assert.equal(valid.result.summary, "Fixture complete");
  const cases = [
    ["unsupported_terminal_receipt", (v) => { v.type = "other"; }],
    ["invalid_terminal_status", (v) => { v.status = "running"; }],
    ["execution_id_mismatch", (v) => { v.execution_id = "other"; }],
    ["claimant_mismatch", (v) => { v.claimant.client_instance_id = "other"; }],
    ["runtime_id_mismatch", (v) => { v.runtime_id = "other"; }],
    ["program_sha256_mismatch", (v) => { v.program_sha256 = hex("f"); }],
    ["invalid_receipt_timestamps", (v) => { v.finished_at = new Date(NOW).toISOString(); }],
    ["invalid_tool_attempt_count", (v) => { v.tool_attempts.count = 9; }],
    ["sensitive_or_invalid_terminal_result", (v) => { v.result.summary = "x".repeat(3000); }],
    ["invalid_final_state_sha256", (v) => { v.final_state_sha256 = "bad"; }],
    ["unknown_terminal_receipt_field", (v) => { v.extra = true; }],
  ];
  for (const [code, mutate] of cases) { const copy = clone(receipt(env)); mutate(copy); assert.throws(() => p.validateSurfaceProgramTerminalReceipt(env, copy, claim, { nowMs: NOW + 300 }), { code }); }
  const rejected = receipt(env, { status: "rejected", started_at: null, tool_attempts: { count: 0, first_receipt_sha256: null, last_receipt_sha256: null }, result: { summary: "Denied", data_sha256: null, artifact_refs: [] }, error: { code: "denied", message: "Local policy denied" }, final_state_sha256: null });
  assert.equal(p.validateSurfaceProgramTerminalReceipt(env, rejected, claim, { nowMs: NOW + 60000 }).started_at, null);
  const forged = receipt(env); forged.receipt_sha256 = hex("f");
  assert.throws(() => p.validateSurfaceProgramTerminalReceipt(env, forged, claim, { nowMs: NOW + 300 }), { code: "receipt_sha256_mismatch" });
  const leaked = receipt(env, { result: { summary: "authorization: Bearer secret-token", data_sha256: null, artifact_refs: [] } });
  assert.throws(() => p.validateSurfaceProgramTerminalReceipt(env, leaked, claim, { nowMs: NOW + 300 }), { code: "sensitive_or_invalid_terminal_result" });
});

test("lifecycle events are closed, claimant-bound, typed, and fresh", () => {
  const env = proposal(); const claim = { device_id: "browser-1", client_instance_id: "client-1" };
  const accepted = executionEvent(env, 1, "accepted", { proposal_sha256: p.sha256(env) });
  assert.equal(p.validateSurfaceExecutionEvent(env, accepted, claim, { nowMs: NOW + 100 }).kind, "accepted");
  const events = [
    executionEvent(env, 2, "started", {}),
    executionEvent(env, 3, "tool_started", { capability_id: "browser.observe", tool_call_id: "call-1", attempt: 1 }),
    executionEvent(env, 4, "tool_finished", { capability_id: "browser.observe", tool_call_id: "call-1", attempt: 1, status: "succeeded", receipt_id: "tool-receipt-1", receipt_sha256: hex("a") }),
    executionEvent(env, 5, "approval_required", { approval_id: "approval-1", effect_class: "external_side_effect", capability_id: "browser.click", tool_call_id: "call-2", attempt: 1, expires_at: new Date(NOW + 10000).toISOString() }),
    executionEvent(env, 6, "approval_resolved", { approval_id: "approval-1", status: "approved" }),
    executionEvent(env, 7, "progress", { message: "Fixture progress", completed: 1, total: 2 }),
    executionEvent(env, 8, "stopping", { reason: "user_stop" }),
    executionEvent(env, 9, "terminal", { status: "completed", receipt_id: "receipt-1", receipt_sha256: hex("e") }),
  ];
  for (const event of events) assert.equal(p.validateSurfaceExecutionEvent(env, event, claim, { nowMs: NOW + 100 }).kind, event.kind);
  assert.throws(() => p.validateSurfaceExecutionEvent(env, { ...accepted, kind: "unknown" }, claim, { nowMs: NOW + 100 }), { code: "invalid_event_kind" });
  assert.throws(() => p.validateSurfaceExecutionEvent(env, { ...accepted, payload: { proposal_sha256: hex("f") } }, claim, { nowMs: NOW + 100 }), { code: "proposal_sha256_mismatch" });
  assert.throws(() => p.validateSurfaceExecutionEvent(env, executionEvent(env, 2, "tool_started", { capability_id: "browser.shell", tool_call_id: "call", attempt: 1 }), claim, { nowMs: NOW + 100 }), { code: "capability_escalation" });
  assert.throws(() => p.validateSurfaceExecutionEvent(env, executionEvent(env, 2, "progress", { message: "Bearer secret", completed: 1, total: 2 }), claim, { nowMs: NOW + 100 }), { code: "sensitive_or_invalid_progress" });
  assert.throws(() => p.validateSurfaceExecutionEvent(env, { ...accepted, occurred_at: new Date(NOW + 40000).toISOString() }, claim, { nowMs: NOW }), { code: "future_event" });
});

test("tool receipts recompute their digest, state link, and receipt chain", () => {
  const env = proposal(); const claim = { device_id: "browser-1", client_instance_id: "client-1" };
  const first = toolReceipt(env);
  assert.equal(p.validateSurfaceProgramToolReceipt(env, first, claim, { nowMs: NOW + 100 }).receipt_sha256, first.receipt_sha256);
  const second = toolReceipt(env, { receipt_id: "tool-receipt-2", tool_call_id: "call-2", pre_state_sha256: first.post_state_sha256, previous_receipt_sha256: first.receipt_sha256 });
  assert.equal(p.validateSurfaceProgramToolReceipt(env, second, claim, { nowMs: NOW + 100, previousToolReceipt: first }).receipt_id, "tool-receipt-2");
  const forged = clone(first); forged.receipt_sha256 = hex("f");
  assert.throws(() => p.validateSurfaceProgramToolReceipt(env, forged, claim, { nowMs: NOW + 100 }), { code: "receipt_sha256_mismatch" });
  assert.throws(() => p.validateSurfaceProgramToolReceipt(env, toolReceipt(env, { previous_receipt_sha256: hex("f") }), claim, { nowMs: NOW + 100 }), { code: "tool_receipt_chain_mismatch" });
  assert.throws(() => p.validateSurfaceProgramToolReceipt(env, toolReceipt(env, { pre_state_sha256: hex("f") }), claim, { nowMs: NOW + 100 }), { code: "pre_state_sha256_mismatch" });
  assert.throws(() => p.validateSurfaceProgramToolReceipt(env, toolReceipt(env, { capability_id: "browser.shell" }), claim, { nowMs: NOW + 100 }), { code: "capability_escalation" });
  assert.throws(() => p.validateSurfaceProgramToolReceipt(env, toolReceipt(env, { result: { summary: "password=secret", data_sha256: null, resource_id: null } }), claim, { nowMs: NOW + 100 }), { code: "sensitive_or_invalid_tool_result" });
  const terminal = receipt(env, { tool_attempts: { count: 2, first_receipt_sha256: first.receipt_sha256, last_receipt_sha256: second.receipt_sha256 }, previous_receipt_sha256: second.receipt_sha256 });
  assert.equal(p.validateSurfaceProgramTerminalReceipt(env, terminal, claim, { nowMs: NOW + 100, toolReceipts: [first, second] }).tool_attempts.count, 2);
});

test("profile, event, receipt, and sensitive-data adversaries fail closed", () => {
  const env = proposal(); const claim = { device_id: "browser-1", client_instance_id: "client-1" };
  const androidBindings = { kind: "android_accessibility", package_name: "fixture", window_id: "window", observation_id: "obs", observation_generation: 1, state_sha256: hex("a") };
  assert.throws(() => proposal({ bindings: androidBindings }), { code: "runtime_binding_target_mismatch" });
  assert.throws(() => proposal({ bindings: { kind: "gateway_server", tenant_id: "t", state_sha256: hex("a") } }, { advertisement: advertisement({ target: { surface_type: "gateway", device_id: "browser-1" }, runtime: { runtime_id: "gateway.quickjs.v1", language: "javascript", bridge_version: 1, entrypoint: "main" } }) }), { code: "invalid_gateway_resource_binding" });

  const eventCases = [
    [executionEvent(env, 1, "tool_finished", { capability_id: "browser.observe", tool_call_id: "c", attempt: 1, status: "bad", receipt_id: "r", receipt_sha256: hex("a") }), "invalid_tool_status"],
    [executionEvent(env, 1, "approval_required", { approval_id: "a", effect_class: "bad", capability_id: "browser.click", tool_call_id: "c", attempt: 1, expires_at: new Date(NOW + 1000).toISOString() }), "invalid_effect_class"],
    [executionEvent(env, 1, "approval_resolved", { approval_id: "a", status: "bad" }), "invalid_approval_status"],
    [executionEvent(env, 1, "progress", { message: "ok", completed: 2, total: 1 }), "invalid_progress"],
    [executionEvent(env, 1, "stopping", { reason: "bad" }), "invalid_stopping_reason"],
    [executionEvent(env, 1, "terminal", { status: "bad", receipt_id: "r", receipt_sha256: hex("a") }), "invalid_terminal_status"],
  ];
  for (const [event, code] of eventCases) assert.throws(() => p.validateSurfaceExecutionEvent(env, event, claim, { nowMs: NOW + 100 }), { code });

  const baseTool = toolReceipt(env);
  const toolCases = [
    [{ ...baseTool, type: "other" }, "unsupported_tool_receipt"],
    [{ ...baseTool, execution_id: "other" }, "execution_id_mismatch"],
    [{ ...baseTool, status: "bad" }, "invalid_tool_status"],
    [{ ...baseTool, finished_at: new Date(NOW).toISOString() }, "invalid_receipt_timestamps"],
    [{ ...baseTool, input_sha256: "bad" }, "invalid_input_sha256"],
  ];
  for (const [value, code] of toolCases) assert.throws(() => p.validateSurfaceProgramToolReceipt(env, value, claim, { nowMs: NOW + 100 }), { code });

  const invalidArtifact = receipt(env, { result: { summary: "ok", data_sha256: null, artifact_refs: ["https://fixture.test/raw"] } });
  assert.throws(() => p.validateSurfaceProgramTerminalReceipt(env, invalidArtifact, claim, { nowMs: NOW + 100 }), { code: "invalid_artifact_refs" });
  const wrongCount = receipt(env, { tool_attempts: { count: 1, first_receipt_sha256: null, last_receipt_sha256: null } });
  assert.throws(() => p.validateSurfaceProgramTerminalReceipt(env, wrongCount, claim, { nowMs: NOW + 100 }), { code: "tool_attempt_count_mismatch" });
  const wrongPrevious = receipt(env, { previous_receipt_sha256: hex("f") });
  assert.throws(() => p.validateSurfaceProgramTerminalReceipt(env, wrongPrevious, claim, { nowMs: NOW + 100 }), { code: "terminal_receipt_chain_mismatch" });
});
