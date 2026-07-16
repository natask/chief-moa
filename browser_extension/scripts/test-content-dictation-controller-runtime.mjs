import assert from "node:assert/strict";

await import(`../extension/content-dictation-controller-runtime.js?test=${Date.now()}`);
const runtime = globalThis.AgeeContentDictationControllerRuntime;
assert.ok(Object.isFrozen(runtime));

function target(overrides = {}) {
  const listeners = new Map();
  return {
    tagName: "INPUT",
    type: "text",
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    isConnected: true,
    disabled: false,
    readOnly: false,
    closest: () => null,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
    dispatch(name) { listeners.get(name)?.(); },
    ...overrides,
  };
}

function harness(overrides = {}) {
  let active = overrides.active ?? target();
  let context = overrides.context ?? { tabId: 4, frameId: 0, documentId: "doc-a", documentToken: "token-a" };
  let clock = 100;
  let sequence = 0;
  const inserts = [];
  const receipts = [];
  const watchers = new Map();
  const controller = runtime.createController({
    now: () => ++clock,
    createId: () => `binding-${++sequence}`,
    readActiveTarget: () => active,
    readContext: () => context,
    insertText: (...args) => {
      inserts.push(args);
      if (overrides.throwInsert) throw new Error("insert failed");
      return overrides.insertResult ?? true;
    },
    onReceipt: (receipt) => receipts.push(receipt),
    watch: (element, invalidate) => {
      watchers.set(element, invalidate);
      return () => watchers.delete(element);
    },
  });
  return {
    controller,
    inserts,
    receipts,
    watchers,
    get active() { return active; },
    setActive(value) { active = value; },
    setContext(value) { context = value; },
  };
}

for (const [candidate, expected] of [
  [null, "unsupported_target"],
  [target({ type: "password" }), "sensitive_target"],
  [target({ autocomplete: "current-password" }), "sensitive_target"],
  [target({ autocomplete: "new-password" }), "sensitive_target"],
  [target({ closest: (selector) => selector.includes("sensitive") ? {} : null }), "sensitive_target"],
  [target({ closest: (selector) => selector === "#agee-root" ? {} : null }), "unsupported_target"],
  [target({ disabled: true }), "unsupported_target"],
  [target({ readOnly: true }), "unsupported_target"],
  [target({ isConnected: false }), "unsupported_target"],
  [target({ type: "number" }), "unsupported_target"],
  [target({ tagName: "BUTTON" }), "unsupported_target"],
]) {
  assert.equal(runtime.classifyTarget(candidate).reason, expected);
}

for (const [candidate, kind] of [
  [target(), "input"],
  [target({ type: "search" }), "input"],
  [target({ type: "email" }), "input"],
  [target({ type: "url" }), "input"],
  [target({ type: "tel" }), "input"],
  [target({ tagName: "TEXTAREA" }), "textarea"],
  [target({ tagName: "DIV", isContentEditable: true }), "contenteditable"],
  [target({ tagName: "DIV", contentEditable: "plaintext-only" }), "contenteditable"],
]) {
  assert.deepEqual(runtime.classifyTarget(candidate), { ok: true, kind, target: candidate });
}

assert.equal(runtime.isSensitiveTarget(null), false);
assert.equal(runtime.isSensitiveTarget(target({ autocomplete: "off", type: "text" })), false);
assert.deepEqual(runtime.normalizeContext(), { tabId: null, frameId: null, documentId: null, documentToken: null });
assert.deepEqual(runtime.normalizeContext({ tabId: 1.5, frameId: "0", documentId: "", documentToken: "x" }), {
  tabId: null,
  frameId: null,
  documentId: null,
  documentToken: "x",
});
assert.equal(runtime.contextsMatch({ tabId: null, frameId: null, documentId: null, documentToken: null }, {}), true);
for (const changed of [
  { tabId: 8, frameId: 0, documentId: "doc-a", documentToken: "token-a" },
  { tabId: 4, frameId: 2, documentId: "doc-a", documentToken: "token-a" },
  { tabId: 4, frameId: 0, documentId: "doc-b", documentToken: "token-a" },
  { tabId: 4, frameId: 0, documentId: "doc-a", documentToken: "token-b" },
]) {
  assert.equal(runtime.contextsMatch({ tabId: 4, frameId: 0, documentId: "doc-a", documentToken: "token-a" }, changed), false);
}

{
  const h = harness();
  const binding = h.controller.bind();
  assert.deepEqual(binding, { ok: true, id: "binding-1", target_kind: "input" });
  assert.equal(h.controller.attachContext(binding.id, { tabId: 4, frameId: 0, documentId: "doc-a", documentToken: "token-a" }), true);
  const result = h.controller.insert(binding.id, " exact words ");
  assert.equal(result.ok, true);
  assert.equal(h.inserts.length, 1);
  assert.equal(h.inserts[0][2], " exact words ");
  assert.equal(result.receipt.character_count, 13);
  assert.equal(result.receipt.status, "inserted");
  assert.equal(Object.isFrozen(result.receipt), true);
  assert.equal(h.controller.insert(binding.id, "again").reason, "already_consumed");
  assert.equal(h.inserts.length, 1);
  assert.equal(h.watchers.size, 0);
}

{
  const sensitive = target({ type: "password" });
  const h = harness({ active: sensitive });
  const result = h.controller.bind();
  assert.equal(result.ok, false);
  assert.equal(result.receipt.status, "refused");
  assert.equal(result.receipt.character_count, 0);
  assert.equal(result.receipt.target_kind, null);
}

for (const [mutate, expected] of [
  [(h) => h.setActive(target()), "focus_changed"],
  [(h) => h.setContext({ tabId: 5, frameId: 0, documentId: "doc-a", documentToken: "token-a" }), "stale_context"],
  [(h, binding) => h.watchers.get(h.active)("focus_changed"), "focus_changed"],
  [(h) => { h.active.isConnected = false; }, "stale_target"],
  [(h) => { h.active.type = "password"; }, "sensitive_target"],
]) {
  const h = harness();
  const binding = h.controller.bind();
  mutate(h, binding);
  const result = h.controller.insert(binding.id, "words");
  assert.equal(result.reason, expected);
  assert.equal(h.inserts.length, 0);
  assert.equal(result.receipt.status, "refused");
}

{
  const h = harness();
  const binding = h.controller.bind();
  assert.equal(h.controller.insert(binding.id, "").reason, "empty_transcript");
  assert.equal(h.controller.invalidate(binding.id, "stale_context"), false);
  assert.equal(h.controller.invalidate("missing"), false);
  assert.equal(h.controller.insert("missing", "words").reason, "stale_target");
}

{
  const h = harness();
  const binding = h.controller.bind();
  assert.equal(h.controller.invalidate(binding.id), true);
  assert.equal(h.controller.insert(binding.id, "words").reason, "focus_changed");
}

{
  const h = harness();
  const binding = h.controller.bind();
  assert.equal(h.controller.attachContext(binding.id, { tabId: 99, frameId: 0, documentId: "doc-a", documentToken: "token-a" }), false);
  assert.equal(h.controller.attachContext("missing", {}), false);
  assert.equal(h.controller.insert(binding.id, "words").reason, "stale_context");
}

for (const options of [{ insertResult: false }, { throwInsert: true }]) {
  const h = harness(options);
  const binding = h.controller.bind();
  const result = h.controller.insert(binding.id, "words");
  assert.equal(result.reason, "insert_failed");
  assert.equal(result.receipt.status, "failed");
}

{
  const events = [];
  const input = target({
    value: "hello world",
    selectionStart: 6,
    selectionEnd: 11,
    dispatchEvent(event) { events.push(event.type); return true; },
    setRangeText(text, start, end) {
      this.value = `${this.value.slice(0, start)}${text}${this.value.slice(end)}`;
      this.selectionStart = this.selectionEnd = start + text.length;
    },
  });
  assert.equal(runtime.insertDomText(input, "input", "Moa"), true);
  assert.equal(input.value, "hello Moa");
  assert.deepEqual(events, ["beforeinput", "input"]);
}

{
  const input = target({
    value: "ab",
    selectionStart: null,
    selectionEnd: null,
    dispatchEvent: () => true,
    setRangeText: undefined,
  });
  assert.equal(runtime.insertDomText(input, "textarea", "!"), true);
  assert.equal(input.value, "ab!");
  assert.equal(input.selectionStart, 3);
}

{
  const input = target({ dispatchEvent: (event) => event.type !== "beforeinput" });
  assert.equal(runtime.insertDomText(input, "input", "blocked"), false);
}

{
  const host = target({ tagName: "DIV", isContentEditable: true });
  const node = {};
  const calls = [];
  const range = {
    commonAncestorContainer: node,
    deleteContents: () => calls.push("delete"),
    insertNode: () => calls.push("insert"),
    setStartAfter: () => calls.push("after"),
    collapse: () => calls.push("collapse"),
  };
  host.contains = (candidate) => candidate === node;
  host.dispatchEvent = () => true;
  const documentObject = {
    getSelection: () => ({
      rangeCount: 1,
      getRangeAt: () => range,
      removeAllRanges: () => calls.push("remove"),
      addRange: () => calls.push("add"),
    }),
    createTextNode: (text) => ({ text }),
  };
  assert.equal(runtime.insertDomText(host, "contenteditable", "words", documentObject), true);
  assert.deepEqual(calls, ["delete", "insert", "after", "collapse", "remove", "add"]);
  assert.equal(runtime.insertDomText(host, "contenteditable", "words", { getSelection: () => null }), false);
  assert.equal(runtime.insertDomText(host, "contenteditable", "words", { getSelection: () => ({ rangeCount: 0 }) }), false);
  host.contains = () => false;
  assert.equal(runtime.insertDomText(host, "contenteditable", "words", documentObject), false);
}

{
  const previousDocument = globalThis.document;
  const input = target({
    value: "a",
    selectionStart: 1,
    selectionEnd: 1,
    dispatchEvent: () => true,
    setRangeText(text, start, end) {
      this.value = `${this.value.slice(0, start)}${text}${this.value.slice(end)}`;
    },
  });
  globalThis.document = { activeElement: input };
  try {
    const defaults = runtime.createController();
    const binding = defaults.bind();
    assert.equal(binding.ok, true);
    assert.equal(defaults.insert(binding.id, "b").ok, true);
    assert.equal(input.value, "ab");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

console.log("content dictation controller runtime ok");
