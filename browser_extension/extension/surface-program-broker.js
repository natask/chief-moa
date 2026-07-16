import { canonicalJson, capabilityDefinition, sha256, utf8Bytes } from "./surface-program-contract.js";

function assertRecord(value, name = "arguments") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid_${name}`);
  return value;
}

function validateCapabilityArgs(capabilityId, rawArgs) {
  const args = assertRecord(rawArgs);
  const allowed = capabilityId === "browser.page.query_elements" ? ["selector", "limit"]
    : capabilityId === "browser.page.get_text" ? ["selector"]
      : capabilityId === "browser.page.wait" ? ["selector", "text", "timeout_ms"]
        : capabilityId === "browser.page.click" ? ["element_id"]
          : new Set(["browser.page.fill", "browser.page.type"]).has(capabilityId) ? ["element_id", "text"] : [];
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error("capability_arguments_unknown_field");
  if (allowed.includes("selector") && (typeof args.selector !== "string" || !args.selector || args.selector.length > 500)) throw new Error("invalid_selector");
  if (allowed.includes("element_id") && (typeof args.element_id !== "string" || !args.element_id)) throw new Error("invalid_element_id");
  if (new Set(["browser.page.fill", "browser.page.type"]).has(capabilityId) && (typeof args.text !== "string" || args.text.length > 4000)) throw new Error("invalid_text");
  if (args.limit != null && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw new Error("invalid_limit");
  if (args.timeout_ms != null && (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1 || args.timeout_ms > 5000)) throw new Error("invalid_timeout");
  if (args.text != null && typeof args.text !== "string") throw new Error("invalid_text");
  return args;
}

function bindingsMatch(expected, actual) {
  return actual?.tab_id === expected.tab_id
    && actual?.window_id === expected.window_id
    && actual?.origin === expected.origin
    && actual?.document_id === expected.document_id
    && actual?.page_epoch === expected.page_epoch
    && actual?.observation_sha256 === expected.observation_sha256
    && actual?.state_sha256 === expected.state_sha256
    ;
}

function createSurfaceProgramBroker({ envelope, adapter, clock = () => Date.now(), recordReceipt = async (entry) => entry }) {
  if (!envelope || !adapter) throw new Error("broker_configuration_invalid");
  const allowed = new Set(envelope.catalog.allowed_capability_ids);
  const handles = new Map();
  const trace = [];
  let callCount = 0;
  let activeCalls = 0;
  let nextHandle = 1;
  let writeTail = Promise.resolve();
  let receiptTail = Promise.resolve();
  let previousReceiptSha256 = null;
  let revoked = false;
  const activeAttempts = new Map();

  async function persistReceipt(entry) {
    const persist = receiptTail.then(async () => {
      entry.previous_receipt_sha256 = previousReceiptSha256;
      entry.receipt_sha256 = await sha256(entry);
      const durable = await recordReceipt({ ...entry });
      if (durable?.receipt_sha256) entry.receipt_sha256 = durable.receipt_sha256;
      previousReceiptSha256 = entry.receipt_sha256;
      trace.push(Object.freeze(entry));
    });
    receiptTail = persist.catch(() => {});
    await persist;
  }

  async function revalidate() {
    if (clock() >= Date.parse(envelope.expires_at)) throw new Error("execution_expired");
    const current = await adapter.currentBinding(envelope.bindings.tab_id);
    if (!bindingsMatch(envelope.bindings, current)) throw new Error("browser_binding_stale");
    return current;
  }

  function handleFor(element) {
    if (handles.size >= 100) throw new Error("element_handle_limit_exceeded");
    const elementId = `element_${nextHandle++}`;
    handles.set(elementId, element);
    return elementId;
  }

  function resolveHandle(args) {
    const elementId = String(args.element_id || "");
    const handle = handles.get(elementId);
    if (!handle) throw new Error("element_handle_invalid");
    return handle;
  }

  async function dispatch(capabilityId, args) {
    const tabId = envelope.bindings.tab_id;
    switch (capabilityId) {
      case "browser.page.snapshot": return adapter.snapshot(tabId, args);
      case "browser.page.query_elements": {
        const elements = await adapter.queryElements(tabId, args);
        if (!Array.isArray(elements) || elements.length > 100) throw new Error("element_result_invalid");
        return elements.map((element) => ({ ...element.public, element_id: handleFor(element.handle) }));
      }
      case "browser.page.get_text": return adapter.getText(tabId, args);
      case "browser.page.wait": return adapter.wait(tabId, args);
      case "browser.tab.get": return adapter.tabGet(tabId);
      case "browser.page.click": return adapter.click(tabId, resolveHandle(args), args);
      case "browser.page.fill": return adapter.fill(tabId, resolveHandle(args), args);
      case "browser.page.type": return adapter.type(tabId, resolveHandle(args), args);
      default: throw new Error("capability_not_implemented");
    }
  }

  async function invoke(capabilityId, definition, args, attempt) {
    let preState;
    let dispatched = false;
    const inputSha256 = await sha256(args);
    attempt.input_sha256 = inputSha256;
    try {
      if (revoked) throw new Error("surface_program_revoked");
      preState = await revalidate();
      attempt.pre_state_sha256 = preState.state_sha256;
      if (revoked) throw new Error("surface_program_revoked");
      dispatched = true;
      attempt.dispatched = true;
      const result = await dispatch(capabilityId, args);
      const postState = await adapter.currentBinding(envelope.bindings.tab_id).catch(() => null);
      attempt.settled = true;
      if (attempt.finalized) throw new Error("surface_program_finalized_indeterminate");
      const entry = { call_id: attempt.call_id, capability_id: capabilityId, status: "succeeded", input_sha256: inputSha256, pre_state_sha256: preState.state_sha256, post_state_sha256: postState?.state_sha256 || null, started_at: attempt.started_at, finished_at: new Date(clock()).toISOString(), previous_receipt_sha256: null, result_sha256: await sha256(result ?? null) };
      await persistReceipt(entry);
      return result;
    } catch (error) {
      attempt.settled = true;
      if (attempt.finalized) throw error;
      const entry = { call_id: attempt.call_id, capability_id: capabilityId, status: revoked && !dispatched ? "rejected" : definition.risk === "read_only" ? "failed" : "indeterminate", input_sha256: inputSha256, pre_state_sha256: preState?.state_sha256 || null, post_state_sha256: null, started_at: attempt.started_at, finished_at: new Date(clock()).toISOString(), previous_receipt_sha256: null, error: String(error?.message || error).slice(0, 500) };
      await persistReceipt(entry);
      throw error;
    }
  }

  async function call(capabilityId, rawArgs = {}) {
    if (revoked) throw new Error("surface_program_revoked");
    const definition = capabilityDefinition(capabilityId);
    if (!definition || !allowed.has(capabilityId)) throw new Error("capability_not_allowed");
    if (callCount >= envelope.limits.tool_calls) throw new Error("tool_call_limit_exceeded");
    if (activeCalls >= envelope.limits.parallel_calls) throw new Error("parallel_call_limit_exceeded");
    const args = validateCapabilityArgs(capabilityId, rawArgs);
    callCount += 1;
    activeCalls += 1;
    const callId = `${envelope.execution_id}:call:${callCount}`;
    const startedAt = new Date(clock()).toISOString();
    const attempt = { call_id: callId, capability_id: capabilityId, started_at: startedAt, input_sha256: null, pre_state_sha256: null, dispatched: false, settled: false, finalized: false };
    activeAttempts.set(callId, attempt);
    try {
      if (definition.risk === "read_only") return await invoke(capabilityId, definition, args, attempt);
      const queued = writeTail.then(() => invoke(capabilityId, definition, args, attempt));
      writeTail = queued.catch(() => {});
      return await queued;
    } finally {
      activeCalls -= 1;
      activeAttempts.delete(callId);
    }
  }

  async function finalizeUnresolved() {
    revoked = true;
    const unresolved = [...activeAttempts.values()].filter((attempt) => attempt.dispatched && !attempt.settled && !attempt.finalized);
    for (const attempt of unresolved) {
      attempt.finalized = true;
      await persistReceipt({
        call_id: attempt.call_id, capability_id: attempt.capability_id, status: "indeterminate",
        input_sha256: attempt.input_sha256, pre_state_sha256: attempt.pre_state_sha256,
        post_state_sha256: null, started_at: attempt.started_at, finished_at: new Date(clock()).toISOString(),
        previous_receipt_sha256: null, error: "effect_outcome_indeterminate",
      });
    }
    return unresolved.length;
  }

  function assertResultSize(result) {
    if (utf8Bytes(canonicalJson(result ?? null)) > envelope.limits.result_bytes) throw new Error("result_too_large");
    if (utf8Bytes(canonicalJson(trace)) > envelope.limits.result_bytes) throw new Error("effect_receipts_too_large");
  }

  return Object.freeze({
    call,
    revoke: () => { revoked = true; },
    finalizeUnresolved,
    revalidate,
    assertResultSize,
    trace: () => trace.map((entry) => ({ ...entry })),
    stats: () => ({ call_count: callCount, active_calls: activeCalls, handle_count: handles.size, revoked }),
  });
}

export { bindingsMatch, createSurfaceProgramBroker, validateCapabilityArgs };
