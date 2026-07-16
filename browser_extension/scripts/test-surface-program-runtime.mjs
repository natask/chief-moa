import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITIES,
  browserProgramRuntimeManifest,
  canonicalJson,
  capabilityDefinition,
  sha256,
  sha256Source,
  utf8Bytes,
  validateSurfaceProgramEnvelope,
} from "../extension/surface-program-contract.js";
import { bindingsMatch, createSurfaceProgramBroker, validateCapabilityArgs } from "../extension/surface-program-broker.js";
import { boundedSelector, createChromeSurfaceProgramAdapter, injectionValue } from "../extension/surface-program-chrome-adapter.js";

async function fixtureEnvelope(overrides = {}) {
  const runtime = await browserProgramRuntimeManifest("device_fixture", Date.parse("2026-07-16T12:00:00.000Z"));
  const source = "return await tools.browser.tab.get({});";
  const bindingState = { tab_id: 7, window_id: 2, frame_id: 0, origin: "http://127.0.0.1:8123", document_id: "doc_fixture", page_epoch: 42 };
  const binding = { kind: "browser_document", ...bindingState, observation_id: "obs_fixture", observation_sha256: await sha256({ fixture: "observation" }), state_sha256: await sha256(bindingState) };
  return {
    runtime,
    envelope: {
      version: 1, type: "surface.execution.proposed", execution_id: "exec_fixture", session_id: "session_fixture", turn_id: "turn_fixture",
      target: { surface_type: "browser_extension", device_id: "device_fixture" },
      runtime: { runtime_id: "browser.javascript.v1", language: "javascript", bridge_version: 1, entrypoint: "main" },
      program: { source, sha256: await sha256Source(source) },
      catalog: { version: runtime.catalog.version, sha256: runtime.catalog.sha256, allowed_capability_ids: CAPABILITIES.map((item) => item.capability_id) },
      bindings: binding,
      limits: { source_bytes: utf8Bytes(source), wall_ms: 5000, memory_bytes: null, tool_calls: 20, parallel_calls: 4, result_bytes: 16 * 1024, log_bytes: 0 },
      approval_policy: { program: "preauthorized", always_ask: [] }, idempotency_key: "idem_fixture",
      issued_at: "2026-07-16T12:00:00.000Z", expires_at: "2026-07-16T12:01:00.000Z", ...overrides,
    },
  };
}

test("surface program contract advertises exact schemas and validates a bound proposal", async () => {
  const { runtime, envelope } = await fixtureEnvelope();
  assert.equal(runtime.runtime.runtime_id, "browser.javascript.v1");
  assert.equal(runtime.runtime.entrypoint, "main");
  assert.equal(runtime.catalog.capability_ids.length, 8);
  assert.ok(runtime.catalog.sha256.match(/^[a-f0-9]{64}$/));
  assert.equal(capabilityDefinition("browser.page.fill").concurrency, "serialized_resource");
  assert.equal(capabilityDefinition("missing"), null);
  assert.equal(canonicalJson({ b: 2, a: [1] }), '{"a":[1],"b":2}');
  const valid = await validateSurfaceProgramEnvelope(envelope, { nowMs: Date.parse("2026-07-16T12:00:30Z"), expectedDeviceId: "device_fixture", runtime });
  assert.equal(valid.sourceBytes, utf8Bytes(envelope.program.source));
});

test("JCS and exact-source hashes match cross-language contract vectors", async () => {
  const catalogVector = { version: 7, capabilities: [{
    capability_id: "browser.page.observe", description: "Observe bounded state for the bound fixture page.",
    input_schema: {}, output_schema: {}, effect_class: "read", approval_class: "none",
    idempotency: "read_only", concurrency: "parallel_read", restore_capability_id: null,
  }] };
  assert.equal(canonicalJson(catalogVector), '{"capabilities":[{"approval_class":"none","capability_id":"browser.page.observe","concurrency":"parallel_read","description":"Observe bounded state for the bound fixture page.","effect_class":"read","idempotency":"read_only","input_schema":{},"output_schema":{},"restore_capability_id":null}],"version":7}');
  assert.equal(await sha256(catalogVector), "9b3084e1d7488ed0bc8754ca378b26536f954830561f01fc256927398b3f638b");
  assert.equal(await sha256Source("return 'é';\n"), "d9757c71db600244268f318e19e102a9bfd520eeb0d5e4f62139d1768521dfe8");
  assert.equal(await sha256({}), "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  assert.equal(await sha256({ fixture: "observation" }), "7e3298fbcc102021f32c271177f54a62d674a7584249afc51bfa757ce7aa09c8");
  assert.equal(await sha256({ b: 2, a: 1 }), await sha256({ a: 1, b: 2 }));
  assert.notEqual(await sha256Source("é"), await sha256Source("e\u0301"));
  for (const invalid of [undefined, Number.NaN, Infinity, 2 ** 53, "\uD800", { value: undefined }]) assert.throws(() => canonicalJson(invalid));
});

test("surface program contract fails closed for mutation, drift, stale target, approval, and unknown fields", async () => {
  const cases = [
    (e) => ({ ...e, surprise: true }),
    (e) => ({ ...e, version: 2 }),
    (e) => ({ ...e, target: { ...e.target, device_id: "other" } }),
    (e) => ({ ...e, runtime: { ...e.runtime, entrypoint: "async_body" } }),
    (e) => ({ ...e, program: { ...e.program, source: `${e.program.source} ` } }),
    (e) => ({ ...e, catalog: { ...e.catalog, sha256: "0".repeat(64) } }),
    (e) => ({ ...e, catalog: { ...e.catalog, allowed_capability_ids: ["browser.root.escape"] } }),
    (e) => ({ ...e, bindings: { ...e.bindings, origin: "https://user:pass@example.com" } }),
    (e) => ({ ...e, bindings: { ...e.bindings, frame_id: -1 } }),
    (e) => ({ ...e, bindings: { ...e.bindings, observation_sha256: "bad" } }),
    (e) => ({ ...e, limits: { ...e.limits, tool_calls: 0 } }),
    (e) => ({ ...e, approval_policy: { program: "preauthorized", always_ask: ["browser.page.click"] } }),
    (e) => ({ ...e, expires_at: "2026-07-16T12:00:01.000Z" }),
    (e) => ({ ...e, execution_id: "" }),
    (e) => ({ ...e, target: null }),
    (e) => ({ ...e, target: { ...e.target, surface_type: "android" } }),
    (e) => ({ ...e, program: { ...e.program, source: "" } }),
    (e) => ({ ...e, program: { ...e.program, sha256: "bad" } }),
    (e) => ({ ...e, catalog: { ...e.catalog, allowed_capability_ids: [e.catalog.allowed_capability_ids[0], e.catalog.allowed_capability_ids[0]] } }),
    (e) => ({ ...e, bindings: { ...e.bindings, kind: "gateway_server" } }),
    (e) => ({ ...e, bindings: { ...e.bindings, tab_id: -1 } }),
    (e) => ({ ...e, bindings: { ...e.bindings, state_sha256: "bad" } }),
    (e) => ({ ...e, bindings: { ...e.bindings, site_grant_id: "" } }),
    (e) => ({ ...e, limits: { ...e.limits, source_bytes: 1 } }),
    (e) => ({ ...e, approval_policy: { program: "approved", always_ask: [] } }),
    (e) => ({ ...e, issued_at: "bad" }),
    (e) => ({ ...e, expires_at: "2026-07-16T12:20:00.000Z" }),
  ];
  for (const mutate of cases) {
    const { runtime, envelope } = await fixtureEnvelope();
    await assert.rejects(validateSurfaceProgramEnvelope(mutate(envelope), { nowMs: Date.parse("2026-07-16T12:00:30Z"), expectedDeviceId: "device_fixture", runtime }));
  }
});

test("broker composes parallel reads, branches, serializes writes, validates handles, and receipts calls", async () => {
  const { envelope } = await fixtureEnvelope();
  let activeWrites = 0;
  let maxWrites = 0;
  const binding = { ...envelope.bindings };
  delete binding.kind; delete binding.observation_id;
  const adapter = {
    currentBinding: async () => binding,
    snapshot: async () => ({ title: "fixture" }),
    queryElements: async (_tab, args) => args.selector === "#missing" ? [] : [{ public: { label: "Continue" }, handle: { selector: "#continue", index: 0, fingerprint: { label: "Continue" } } }],
    getText: async () => "done", wait: async () => ({ found: true }), tabGet: async () => ({ tab_id: 7 }),
    click: async () => { activeWrites += 1; maxWrites = Math.max(maxWrites, activeWrites); await new Promise((r) => setTimeout(r, 5)); activeWrites -= 1; return { applied: true }; },
    fill: async () => ({ applied: true }), type: async () => ({ applied: true }),
  };
  const broker = createSurfaceProgramBroker({ envelope, adapter, clock: () => Date.parse("2026-07-16T12:00:30Z") });
  const [snapshot, tab] = await Promise.all([broker.call("browser.page.snapshot", {}), broker.call("browser.tab.get", {})]);
  assert.equal(snapshot.title, "fixture"); assert.equal(tab.tab_id, 7);
  assert.deepEqual(await broker.call("browser.page.query_elements", { selector: "#missing" }), []);
  const [element] = await broker.call("browser.page.query_elements", { selector: "#continue" });
  await Promise.all([broker.call("browser.page.click", { element_id: element.element_id }), broker.call("browser.page.click", { element_id: element.element_id })]);
  assert.equal(maxWrites, 1);
  assert.equal(broker.trace().length, 6);
  assert.ok(broker.trace().every((entry) => entry.receipt_sha256?.length === 64));
  broker.assertResultSize({ ok: true });
  await assert.rejects(broker.call("browser.page.click", { element_id: "unknown" }), /element_handle_invalid/);
  await assert.rejects(broker.call("browser.root.escape", {}), /capability_not_allowed/);
  assert.deepEqual(await broker.call("browser.page.get_text", { selector: "#status" }), "done");
  assert.deepEqual(await broker.call("browser.page.wait", { selector: "#status" }), { found: true });
  await broker.call("browser.page.fill", { element_id: element.element_id, text: "x" });
  await broker.call("browser.page.type", { element_id: element.element_id, text: "y" });
});

test("broker argument and binding validators reject escalation", () => {
  assert.deepEqual(validateCapabilityArgs("browser.page.wait", { selector: "#ok", text: "done", timeout_ms: 10 }), { selector: "#ok", text: "done", timeout_ms: 10 });
  assert.throws(() => validateCapabilityArgs("browser.page.snapshot", { selector: "body" }), /unknown/);
  assert.throws(() => validateCapabilityArgs("browser.page.fill", { element_id: "e", text: 2 }), /invalid_text/);
  assert.throws(() => validateCapabilityArgs("browser.page.query_elements", { selector: "" }), /invalid_selector/);
  assert.throws(() => validateCapabilityArgs("browser.page.wait", { selector: "x", timeout_ms: 9000 }), /invalid_timeout/);
  assert.throws(() => validateCapabilityArgs("browser.page.wait", null), /invalid_arguments/);
  assert.throws(() => validateCapabilityArgs("browser.page.click", { element_id: "" }), /invalid_element_id/);
  assert.throws(() => validateCapabilityArgs("browser.page.query_elements", { selector: "x", limit: 0 }), /invalid_limit/);
  assert.throws(() => validateCapabilityArgs("browser.page.query_elements", { selector: "x", limit: 101 }), /invalid_limit/);
  assert.throws(() => validateCapabilityArgs("browser.page.query_elements", { selector: "x".repeat(501) }), /invalid_selector/);
  assert.throws(() => validateCapabilityArgs("browser.page.query_elements", { selector: "x", limit: 1.5 }), /invalid_limit/);
  assert.throws(() => validateCapabilityArgs("browser.page.wait", { selector: "x", timeout_ms: 1.5 }), /invalid_timeout/);
  assert.throws(() => validateCapabilityArgs("browser.page.fill", { element_id: "e", text: "x".repeat(4001) }), /invalid_text/);
  assert.throws(() => validateCapabilityArgs("browser.page.wait", { selector: "x", text: 1 }), /invalid_text/);
  assert.equal(bindingsMatch({ tab_id: 1, window_id: 2, origin: "x", document_id: "d", page_epoch: 1, observation_sha256: "o", state_sha256: "s" }, { tab_id: 1, window_id: 2, origin: "x", document_id: "d", page_epoch: 1, observation_sha256: "o", state_sha256: "s" }), true);
  assert.equal(bindingsMatch({ tab_id: 1 }, { tab_id: 2 }), false);
  assert.equal(bindingsMatch({ tab_id: 1 }, null), false);
  assert.throws(() => createSurfaceProgramBroker({}), /configuration/);
});

test("broker enforces expiry, state, call, parallel, result, and failure boundaries", async () => {
  const { envelope } = await fixtureEnvelope();
  const baseBinding = { ...envelope.bindings }; delete baseBinding.kind; delete baseBinding.observation_id;
  const adapter = { currentBinding: async () => baseBinding, snapshot: async () => ({ ok: true }), queryElements: async () => [], getText: async () => "", wait: async () => ({}), tabGet: async () => ({}), click: async () => { throw new Error("write failed"); }, fill: async () => ({}), type: async () => ({}) };
  const expired = createSurfaceProgramBroker({ envelope, adapter, clock: () => Date.parse(envelope.expires_at) });
  await assert.rejects(expired.revalidate(), /expired/);
  const stale = createSurfaceProgramBroker({ envelope, adapter: { ...adapter, currentBinding: async () => ({ ...baseBinding, document_id: "other" }) }, clock: () => Date.parse("2026-07-16T12:00:30Z") });
  await assert.rejects(stale.revalidate(), /stale/);
  await assert.rejects(stale.call("browser.page.snapshot", {}), /stale/);
  assert.equal(stale.trace()[0].status, "stale_state");
  const oneCallEnvelope = { ...envelope, limits: { ...envelope.limits, tool_calls: 1, parallel_calls: 1, result_bytes: 1024 } };
  const limited = createSurfaceProgramBroker({ envelope: oneCallEnvelope, adapter, clock: () => Date.parse("2026-07-16T12:00:30Z") });
  await limited.call("browser.page.snapshot", {});
  await assert.rejects(limited.call("browser.page.snapshot", {}), /tool_call_limit/);
  assert.throws(() => limited.assertResultSize("x".repeat(2000)), /result_too_large/);
  const failing = createSurfaceProgramBroker({ envelope, adapter, clock: () => Date.parse("2026-07-16T12:00:30Z") });
  const elementsAdapter = { ...adapter, queryElements: async () => [{ public: {}, handle: {} }] };
  const writeBroker = createSurfaceProgramBroker({ envelope, adapter: elementsAdapter, clock: () => Date.parse("2026-07-16T12:00:30Z") });
  const [handle] = await writeBroker.call("browser.page.query_elements", { selector: "x" });
  await assert.rejects(writeBroker.call("browser.page.click", { element_id: handle.element_id }), /write failed/);
  assert.equal(writeBroker.trace().at(-1).status, "indeterminate");
  assert.equal(failing.stats().call_count, 0);

  let releaseRead;
  const blockedRead = new Promise((resolve) => { releaseRead = resolve; });
  const parallelEnvelope = { ...envelope, limits: { ...envelope.limits, parallel_calls: 1 } };
  const parallel = createSurfaceProgramBroker({ envelope: parallelEnvelope, adapter: { ...adapter, snapshot: () => blockedRead }, clock: () => Date.parse("2026-07-16T12:00:30Z") });
  const firstRead = parallel.call("browser.page.snapshot", {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(parallel.call("browser.page.snapshot", {}), /parallel_call_limit/);
  releaseRead({ ok: true }); await firstRead;

  const many = Array.from({ length: 100 }, () => ({ public: {}, handle: {} }));
  const handles = createSurfaceProgramBroker({ envelope, adapter: { ...adapter, queryElements: async () => many }, clock: () => Date.parse("2026-07-16T12:00:30Z") });
  await handles.call("browser.page.query_elements", { selector: "x" });
  await assert.rejects(handles.call("browser.page.query_elements", { selector: "x" }), /handle_limit/);
  const invalidElements = createSurfaceProgramBroker({ envelope, adapter: { ...adapter, queryElements: async () => null }, clock: () => Date.parse("2026-07-16T12:00:30Z") });
  await assert.rejects(invalidElements.call("browser.page.query_elements", { selector: "x" }), /element_result/);

  const readFail = createSurfaceProgramBroker({ envelope, adapter: { ...adapter, snapshot: async () => { throw new Error("read failed"); } }, clock: () => Date.parse("2026-07-16T12:00:30Z") });
  await assert.rejects(readFail.call("browser.page.snapshot", {}), /read failed/);
  assert.equal(readFail.trace()[0].status, "failed");
  const postStateFail = createSurfaceProgramBroker({ envelope, adapter: { ...adapter, currentBinding: (() => { let calls = 0; return async () => { calls += 1; if (calls > 1) throw new Error("gone"); return baseBinding; }; })() }, clock: () => Date.parse("2026-07-16T12:00:30Z") });
  await postStateFail.call("browser.page.snapshot", {});
  assert.equal(postStateFail.trace()[0].post_state_sha256, null);
  assert.throws(() => postStateFail.assertResultSize("x".repeat(20_000)), /result_too_large/);

  const missingPostState = createSurfaceProgramBroker({ envelope, adapter: { ...elementsAdapter, click: async () => ({ applied: true }), currentBinding: (() => { let calls = 0; return async () => (++calls < 4 ? baseBinding : null); })() }, clock: () => Date.parse("2026-07-16T12:00:30Z") });
  const [missingPostHandle] = await missingPostState.call("browser.page.query_elements", { selector: "x" });
  await assert.rejects(missingPostState.call("browser.page.click", { element_id: missingPostHandle.element_id }), /post_state_unavailable/);

  let releaseWrite;
  let dispatchedWrites = 0;
  const blockedWrite = new Promise((resolve) => { releaseWrite = resolve; });
  const revokeAdapter = { ...elementsAdapter, click: async () => { dispatchedWrites += 1; if (dispatchedWrites === 1) await blockedWrite; return { applied: true }; } };
  const revoked = createSurfaceProgramBroker({ envelope, adapter: revokeAdapter, clock: () => Date.parse("2026-07-16T12:00:30Z") });
  const [revokedHandle] = await revoked.call("browser.page.query_elements", { selector: "x" });
  const firstWrite = revoked.call("browser.page.click", { element_id: revokedHandle.element_id });
  const firstRejected = assert.rejects(firstWrite, /finalized_indeterminate/);
  const queuedWrite = revoked.call("browser.page.click", { element_id: revokedHandle.element_id });
  const queuedRejected = assert.rejects(queuedWrite, /revoked/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  revoked.revoke();
  assert.equal(revoked.stats().revoked, true);
  await assert.rejects(revoked.call("browser.page.snapshot", {}), /revoked/);
  assert.equal(await revoked.finalizeUnresolved(), 2);
  releaseWrite();
  await firstRejected;
  await queuedRejected;
  assert.equal(dispatchedWrites, 1, "a queued write began after bridge revocation");
  assert.deepEqual(revoked.trace().slice(-2).map((entry) => entry.status), ["indeterminate", "rejected"]);

  let releaseIndeterminate;
  const indeterminateEffect = new Promise((resolve) => { releaseIndeterminate = resolve; });
  const indeterminate = createSurfaceProgramBroker({ envelope, adapter: { ...elementsAdapter, click: () => indeterminateEffect }, clock: () => Date.parse("2026-07-16T12:00:30Z") });
  const [indeterminateHandle] = await indeterminate.call("browser.page.query_elements", { selector: "x" });
  const lateWrite = indeterminate.call("browser.page.click", { element_id: indeterminateHandle.element_id });
  const lateRejected = assert.rejects(lateWrite, /finalized_indeterminate/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  indeterminate.revoke();
  assert.equal(await indeterminate.finalizeUnresolved(), 1);
  assert.equal(indeterminate.trace().at(-1).status, "indeterminate");
  const finalizedReceipt = indeterminate.trace().at(-1).receipt_sha256;
  releaseIndeterminate({ applied: true });
  await lateRejected;
  assert.equal(indeterminate.trace().filter((entry) => entry.capability_id === "browser.page.click").length, 1);
  assert.equal(indeterminate.trace().at(-1).receipt_sha256, finalizedReceipt, "late effect completion changed the durable receipt chain");

  let releaseA; let releaseB; let releaseFirstReceipt;
  const effectA = new Promise((resolve) => { releaseA = resolve; });
  const effectB = new Promise((resolve) => { releaseB = resolve; });
  const firstReceiptBlocked = new Promise((resolve) => { releaseFirstReceipt = resolve; });
  let snapshotCall = 0; let receiptCall = 0;
  const parallelFinalize = createSurfaceProgramBroker({
    envelope,
    adapter: { ...adapter, snapshot: () => (++snapshotCall === 1 ? effectA : effectB) },
    clock: () => Date.parse("2026-07-16T12:00:30Z"),
    recordReceipt: async (entry) => { receiptCall += 1; if (receiptCall === 1) await firstReceiptBlocked; return entry; },
  });
  const callA = parallelFinalize.call("browser.page.snapshot", {});
  const callB = parallelFinalize.call("browser.page.snapshot", {});
  const rejectedA = assert.rejects(callA, /finalized_indeterminate/);
  const rejectedB = assert.rejects(callB, /finalized_indeterminate/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const finalizing = parallelFinalize.finalizeUnresolved();
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseB({ ok: "b" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseFirstReceipt();
  assert.equal(await finalizing, 2);
  releaseA({ ok: "a" });
  await Promise.all([rejectedA, rejectedB]);
  assert.equal(parallelFinalize.trace().length, 2);
  assert.ok(parallelFinalize.trace().every((entry) => entry.status === "indeterminate"));

  const immediate = createSurfaceProgramBroker({ envelope, adapter, clock: () => Date.parse("2026-07-16T12:00:30Z") });
  const admitted = immediate.call("browser.page.snapshot", {});
  const admittedRejected = assert.rejects(admitted, /revoked|finalized/);
  immediate.revoke();
  assert.equal(await immediate.finalizeUnresolved(), 1, "an admitted call was lost across asynchronous input hashing");
  await admittedRejected;
  assert.equal(immediate.trace()[0].status, "rejected");
  assert.equal(immediate.trace()[0].pre_state_sha256, envelope.bindings.state_sha256);
});

test("Chrome adapter uses only exact tab injection and rejects malformed inputs", async () => {
  const calls = [];
  const queue = [
    [{ result: { origin: "http://127.0.0.1:8123", url: "http://127.0.0.1:8123/a", title: "A", pageEpoch: 42, documentId: "doc_fixture" }, documentId: "doc_fixture" }],
    [{ result: { title: "A", url: "http://127.0.0.1:8123/a", text: "fixture" }, documentId: "doc_fixture" }],
    [{ result: [{ public: { label: "Go" }, handle: { selector: "#go", index: 0, fingerprint: {} } }], documentId: "doc_fixture" }],
    [{ result: "", documentId: "doc_fixture" }],
    [{ result: { found: true }, documentId: "doc_fixture" }],
    [{ result: { applied: true }, documentId: "doc_fixture" }],
  ];
  const fakeChrome = { tabs: { get: async (id) => ({ id, windowId: 2, title: "A", url: "http://127.0.0.1:8123/a" }) }, scripting: { executeScript: async (request) => { calls.push(request); return queue.shift(); } } };
  const adapter = createChromeSurfaceProgramAdapter(fakeChrome);
  const binding = await adapter.currentBinding(7);
  assert.equal(binding.document_id, "doc_fixture");
  assert.equal((await adapter.snapshot(7)).text, "fixture");
  assert.equal((await adapter.queryElements(7, { selector: "#go" }))[0].public.label, "Go");
  assert.equal(await adapter.getText(7, { selector: "#empty" }), "");
  assert.deepEqual(await adapter.wait(7, { selector: "#done", timeout_ms: 10 }), { found: true });
  await adapter.click(7, { selector: "#go", index: 0, fingerprint: { label: "Go" } });
  assert.ok(calls.every((call) => call.target.tabId === 7 && call.target.frameIds[0] === 0 && call.world === "ISOLATED"));
  assert.throws(() => boundedSelector({}), /invalid_selector/);
  assert.throws(() => injectionValue([]), /page_injection_failed/);
  assert.deepEqual(injectionValue([{ result: false }]), { value: false, documentId: "" });
  assert.throws(() => adapter.click(7, { fingerprint: { label: "Delete account" } }), /sensitive_click/);
});

test("Chrome adapter packaged page functions redact, observe, wait, and mutate fixture DOM", async () => {
  class FakeInput {
    constructor(type = "text") { this.type = type; this._value = ""; this.isConnected = true; this.tagName = "INPUT"; this.innerText = ""; this.attrs = { type }; this.events = []; }
    get value() { return this._value; } set value(next) { this._value = next; }
    getAttribute(name) { return this.attrs[name] || ""; }
    getBoundingClientRect() { return { x: 1, y: 2, width: 100, height: 20 }; }
    dispatchEvent(event) { this.events.push(event.type); }
    click() { this.clicked = true; }
  }
  class FakeTextarea extends FakeInput { constructor() { super(""); this.tagName = "TEXTAREA"; } }
  globalThis.HTMLInputElement = FakeInput; globalThis.HTMLTextAreaElement = FakeTextarea;
  globalThis.InputEvent = class { constructor(type) { this.type = type; } }; globalThis.Event = class { constructor(type) { this.type = type; } };
  const button = new FakeInput("button"); button.tagName = "BUTTON"; button.innerText = "Continue";
  const input = new FakeInput(); input.attrs.name = "note";
  const password = new FakeInput("password"); password.value = "secret";
  const hidden = new FakeInput(); hidden.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0 });
  const content = { tagName: "DIV", innerText: "", textContent: "old", isContentEditable: true, isConnected: true, events: [], getAttribute: (name) => name === "aria-label" ? "Editor" : "", getBoundingClientRect: () => ({ x: 1, y: 2, width: 100, height: 20 }), dispatchEvent(event) { this.events.push(event.type); } };
  const plain = { ...content, isContentEditable: false, getAttribute: () => "", tagName: "DIV" };
  const nodes = { "#button": [button], "#input": [input], "#password": [password], "#hidden": [hidden], "#content": [content], "#plain": [plain], "#none": [] };
  globalThis.document = { title: "Fixture", body: { innerText: " fixture body " }, querySelectorAll: (selector) => nodes[selector] || [], querySelector: (selector) => (nodes[selector] || [])[0] || null };
  globalThis.location = { origin: "http://127.0.0.1:8123", href: "http://127.0.0.1:8123/fixture" }; globalThis.performance = { timeOrigin: 42 };
  const fakeChrome = { tabs: { get: async (id) => ({ id, windowId: 2, title: "Fixture", url: location.href }) }, scripting: { executeScript: async ({ func, args }) => [{ result: await func(...args), documentId: "doc_fixture" }] } };
  const adapter = createChromeSurfaceProgramAdapter(fakeChrome);
  assert.equal((await adapter.currentBinding(7)).page_epoch, 42);
  assert.equal((await adapter.currentBinding(7)).page_epoch, 42);
  document.title = ""; assert.equal((await adapter.currentBinding(7)).page_epoch, 42); document.title = "Fixture";
  assert.equal((await adapter.snapshot(7)).text, "fixture body");
  document.body = null; assert.equal((await adapter.snapshot(7)).text, ""); document.body = { innerText: " fixture body " };
  assert.equal((await adapter.queryElements(7, { selector: "#hidden" })).length, 0);
  const [buttonResult] = await adapter.queryElements(7, { selector: "#button", limit: 5 });
  assert.equal(buttonResult.public.label, "Continue");
  assert.equal(await adapter.getText(7, { selector: "#password" }), "[redacted]");
  assert.equal(await adapter.getText(7, { selector: "#content" }), "old");
  assert.deepEqual(await adapter.wait(7, { selector: "#input" }), { found: true });
  input.value = "ready"; assert.deepEqual(await adapter.wait(7, { selector: "#input", text: "ready" }), { found: true }); input.value = "";
  await adapter.click(7, buttonResult.handle); assert.equal(button.clicked, true);
  const [inputResult] = await adapter.queryElements(7, { selector: "#input" });
  await adapter.fill(7, inputResult.handle, { text: "a" }); await adapter.type(7, inputResult.handle, { text: "b" });
  assert.equal(input.value, "ab"); assert.deepEqual(input.events, ["input", "change", "input", "change"]);
  const [contentResult] = await adapter.queryElements(7, { selector: "#content" });
  await adapter.fill(7, contentResult.handle, { text: "new" }); await adapter.type(7, contentResult.handle, { text: "+" });
  assert.equal(content.textContent, "new+");
  const [plainResult] = await adapter.queryElements(7, { selector: "#plain" });
  await assert.rejects(adapter.fill(7, plainResult.handle, { text: "x" }), /not_editable/);
  const [passwordResult] = await adapter.queryElements(7, { selector: "#password" }); password.isConnected = true;
  await assert.rejects(adapter.fill(7, passwordResult.handle, { text: "x" }), /password_input/);
  assert.equal((await adapter.tabGet(7)).title, "Fixture");
  const blankTabs = createChromeSurfaceProgramAdapter({ tabs: { get: async (id) => ({ id, windowId: 2 }) }, scripting: fakeChrome.scripting });
  assert.deepEqual(await blankTabs.tabGet(7), { tab_id: 7, window_id: 2, title: "", url: "" });
  await assert.rejects(adapter.getText(7, { selector: "#none" }), /element_not_found/);
  await assert.rejects(adapter.queryElements(7, { selector: "#input", limit: Number.NaN }), /invalid_limit/);
  await assert.rejects(adapter.wait(7, { selector: "#input", timeout_ms: Number.NaN }), /invalid_timeout/);
  password.isConnected = false;
  await assert.rejects(adapter.fill(7, { selector: "#password", index: 0, fingerprint: {} }, { text: "x" }), /stale/);
  await assert.rejects(adapter.click(7, {}), /stale/);
  const invalidAdapter = createChromeSurfaceProgramAdapter({ tabs: { get: async () => null }, scripting: fakeChrome.scripting });
  await assert.rejects(invalidAdapter.currentBinding(7), /bound_tab_missing/);
});
