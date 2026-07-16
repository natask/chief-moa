import assert from "node:assert/strict";

await import(`../extension/content-ui-controller-runtime.js?test=${Date.now()}`);
const { createContentUiControllerRuntime } = globalThis.AgeeContentUiControllerRuntime;

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.value = "";
    this.checked = false;
    this.focusCount = 0;
    this._textContent = "";
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    };
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  get textContent() {
    return this._textContent;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatch(type, values = {}) {
    let prevented = 0;
    let stopped = 0;
    const event = {
      preventDefault: () => { prevented += 1; },
      stopPropagation: () => { stopped += 1; },
      ...values,
    };
    this.listeners.get(type)?.(event);
    return { prevented, stopped };
  }

  focus() {
    this.focusCount += 1;
  }
}

function findAll(node, predicate) {
  const matches = predicate(node) ? [node] : [];
  for (const child of node.children) matches.push(...findAll(child, predicate));
  return matches;
}

function byClass(node, name) {
  return findAll(node, (element) => element.className.split(" ").includes(name));
}

function spec({ title = "Dashboard", components = [], controls = [], customized = true } = {}) {
  return {
    isCustomized: customized,
    surfaces: [{ id: "main", title, components, controls }],
  };
}

function createHarness(overrides = {}) {
  const root = overrides.root === null ? null : new FakeElement("div");
  const surface = overrides.surface === null ? null : new FakeElement("div");
  const input = overrides.input === null ? null : new FakeElement("textarea");
  const calls = {
    anchors: 0,
    describes: 0,
    messages: [],
    opens: 0,
    primes: 0,
    sanitizes: [],
    sets: [],
    submits: [],
    toggles: 0,
  };
  const uiSpecRuntime = {
    sanitize: (payload) => {
      calls.sanitizes.push(payload);
      return overrides.sanitize ? overrides.sanitize(payload) : payload;
    },
    ...(overrides.withResolver === false ? {} : {
      resolveAction: (action, prompt, label, value) => overrides.resolveAction
        ? overrides.resolveAction(action, prompt, label, value)
        : { action, prompt: String(prompt || "").replace(/\{value\}/g, value).trim() },
    }),
  };
  const runtime = createContentUiControllerRuntime({
    document: { createElement: (tagName) => new FakeElement(tagName) },
    uiSpecRuntime,
    storageGet: overrides.storageGet || (async () => ({})),
    sendMessage: (message) => calls.messages.push(message),
    getRoot: () => root,
    getSurface: () => surface,
    getInput: () => input,
    anchorPanel: () => { calls.anchors += 1; },
    openSurface: () => { calls.opens += 1; },
    setInputText: (...args) => calls.sets.push(args),
    primeAudio: () => { calls.primes += 1; },
    toggleVoice: () => { calls.toggles += 1; },
    describePage: () => { calls.describes += 1; },
    submitInstruction: (prompt) => calls.submits.push(prompt),
    cacheKey: overrides.cacheKey,
  });
  return { calls, input, root, runtime, surface };
}

{
  const payload = spec({ components: [{ type: "card", tone: "neutral", title: "Cached", body: "Ready" }] });
  const h = createHarness({ storageGet: async (defaults) => {
    assert.deepEqual(defaults, { ageeUiSpec: null });
    return { ageeUiSpec: { payload } };
  } });
  assert.ok(Object.isFrozen(h.runtime));
  await h.runtime.loadUiSpec();
  assert.deepEqual(h.calls.sanitizes, [payload]);
  assert.equal(h.surface.children.length, 1);
}

{
  const payload = spec({ components: [{ type: "stat", tone: "positive", label: "Score", value: "9", delta: "up" }] });
  const h = createHarness({ cacheKey: "customUi", storageGet: async () => ({ customUi: payload }) });
  await h.runtime.loadUiSpec();
  assert.deepEqual(h.calls.sanitizes, [payload]);
}

{
  const h = createHarness({ storageGet: async () => ({ ageeUiSpec: null }) });
  await h.runtime.loadUiSpec();
  assert.deepEqual(h.calls.sanitizes, [null]);
  assert.equal(h.surface.children.length, 0);
}

{
  const h = createHarness({ storageGet: async () => { throw new Error("storage unavailable"); } });
  await assert.doesNotReject(h.runtime.loadUiSpec());
  assert.deepEqual(h.calls.sanitizes, []);
}

for (const missing of ["root", "surface"]) {
  const h = createHarness({ [missing]: null });
  assert.doesNotThrow(() => h.runtime.renderUiSpecSurface(spec()));
}

{
  const h = createHarness();
  h.root.classList.add("agee-has-ui-spec");
  h.surface.appendChild(new FakeElement("p"));
  h.runtime.applyUiSpec(null);
  assert.equal(h.surface.children.length, 0);
  assert.equal(h.root.classList.contains("agee-has-ui-spec"), false);
  h.runtime.renderUiSpecSurface({ isCustomized: true, surfaces: [] });
  h.runtime.renderUiSpecSurface(spec({ customized: false }));
  h.runtime.renderUiSpecSurface(spec({ title: "Title only" }));
  assert.equal(h.surface.children.length, 0);
  assert.equal(h.calls.anchors, 0);
}

{
  const h = createHarness();
  const rendered = spec({
    components: [
      { type: "card", tone: "neutral", title: "Card title", body: "Card body" },
      { type: "card", tone: "warning", title: "", body: "" },
      { type: "stat", tone: "positive", label: "Revenue", value: "42", delta: "+5" },
      { type: "stat", tone: "neutral", label: "Empty", value: "", delta: "" },
      {
        type: "list",
        title: "Tasks",
        items: [
          { label: "Run", detail: "now", action: "agent.run", prompt: "Do it" },
          { label: "Static", detail: "", action: "noop", prompt: "" },
          { label: "Plain", detail: "later", action: "", prompt: "" },
        ],
      },
      { type: "list", title: "", items: [] },
      {
        type: "map",
        title: "Stops",
        center: { lat: 10, lng: 20, label: "Center" },
        markers: [
          { lat: 9, lng: 19, label: "Southwest" },
          { lat: 11, lng: 21, label: "" },
        ],
      },
    ],
    controls: [
      { type: "button", label: "Describe", action: "page.describe", prompt: "" },
      { type: "text", label: "Instruction", action: "agent.run", prompt: "Use {value}", value: "seed" },
      { type: "toggle", label: "Voice", action: "agent.run", prompt: "Voice {value}", checked: true },
      { type: "select", label: "Mode", action: "agent.run", prompt: "Mode {value}", options: ["A", "B"] },
    ],
  });
  h.runtime.renderUiSpecSurface(rendered);
  assert.equal(h.surface.children.length, 1);
  assert.equal(h.root.classList.contains("agee-has-ui-spec"), true);
  assert.equal(h.calls.anchors, 1);
  assert.equal(byClass(h.surface, "agee-ui-card").length, 2);
  assert.equal(byClass(h.surface, "agee-ui-stat").length, 2);
  assert.equal(byClass(h.surface, "agee-ui-stat-value")[1].textContent, "-");
  assert.equal(byClass(h.surface, "agee-ui-list").length, 2);
  assert.equal(byClass(h.surface, "agee-ui-map-pin").length, 2);
  assert.equal(byClass(h.surface, "agee-ui-map-pin")[0].getAttribute("aria-label"), "Southwest");
  assert.equal(byClass(h.surface, "agee-ui-map-pin")[1].getAttribute("aria-label"), "map marker");
  assert.equal(byClass(h.surface, "agee-ui-map-meta")[0].textContent, "Center");

  const listButton = byClass(h.surface, "agee-ui-list-row").find((row) => row.tagName === "BUTTON");
  assert.deepEqual(listButton.dispatch("click"), { prevented: 1, stopped: 1 });
  assert.deepEqual(h.calls.submits, ["Do it"]);

  const describeButton = byClass(h.surface, "agee-ui-button")[0];
  assert.deepEqual(describeButton.dispatch("click"), { prevented: 1, stopped: 1 });
  assert.equal(h.calls.describes, 1);

  const textInput = byClass(h.surface, "agee-ui-text")[0].children[0];
  assert.deepEqual(textInput.dispatch("keydown", { key: "Escape" }), { prevented: 0, stopped: 1 });
  textInput.value = "   ";
  assert.deepEqual(textInput.dispatch("keydown", { key: "Enter" }), { prevented: 1, stopped: 1 });
  textInput.value = "search docs";
  textInput.dispatch("keydown", { key: "Enter" });
  assert.equal(h.calls.submits.at(-1), "Use search docs");

  const checkbox = byClass(h.surface, "agee-ui-toggle")[0].children[0];
  assert.equal(checkbox.checked, true);
  checkbox.checked = false;
  checkbox.dispatch("change");
  assert.equal(h.calls.submits.at(-1), "Voice off");

  const select = byClass(h.surface, "agee-ui-select")[0].children[1];
  select.value = "B";
  select.dispatch("change");
  assert.equal(h.calls.submits.at(-1), "Mode B");
}

{
  const h = createHarness();
  const map = h.runtime.renderUiMap({
    title: "",
    center: { lat: 1, lng: 2, label: "Only" },
    markers: [],
  });
  const pins = byClass(map, "agee-ui-map-pin");
  assert.equal(pins.length, 1);
  assert.equal(pins[0].style.left, "10%");
  assert.equal(pins[0].style.top, "90%");
  assert.equal(byClass(map, "agee-ui-map-meta").length, 1);

  const empty = h.runtime.renderUiMap({ title: "", center: null, markers: [] });
  assert.equal(byClass(empty, "agee-ui-map-pin").length, 0);
  assert.equal(byClass(empty, "agee-ui-map-meta").length, 0);
}

{
  const h = createHarness();
  assert.equal(h.runtime.renderUiComponent({ type: "unknown" }), null);
  assert.equal(h.runtime.renderUiControl({ type: "unknown" }), null);
  const map = h.runtime.renderUiComponent({
    type: "map",
    title: "Delegated",
    center: { lat: 1, lng: 1, label: "" },
    markers: [],
  });
  assert.equal(map.className, "agee-ui-map-card");

  const button = h.runtime.renderUiControl({
    type: "button",
    label: "Open",
    action: "command.open",
    prompt: "",
    value: "typed",
  });
  button.dispatch("click");
  assert.deepEqual(h.calls.sets, [["typed", { select: true }]]);
  assert.equal(h.input.focusCount, 1);

  const text = h.runtime.renderUiControl({ type: "text", label: "", action: "agent.run", prompt: "", value: "" });
  assert.equal(text.children[0].placeholder, "Ask A.G.");
  text.children[0].value = "fallback text";
  text.children[0].dispatch("keydown", { key: "Enter" });
  assert.equal(h.calls.submits.at(-1), "fallback text");

  const toggle = h.runtime.renderUiControl({ type: "toggle", label: "Flag", action: "agent.run", prompt: "", checked: false });
  toggle.children[0].checked = true;
  toggle.children[0].dispatch("change");
  assert.equal(h.calls.submits.at(-1), "Flag: on");

  const select = h.runtime.renderUiControl({ type: "select", label: "Choice", action: "agent.run", prompt: "" });
  assert.equal(select.children[1].children.length, 0);
  select.children[1].value = "X";
  select.children[1].dispatch("change");
  assert.equal(h.calls.submits.at(-1), "Choice: X");
}

{
  const h = createHarness({ resolveAction: () => ({ action: "voice.toggle", prompt: "" }) });
  h.runtime.runUiAction("anything", "", "");
  assert.equal(h.calls.opens, 1);
  assert.equal(h.calls.primes, 1);
  assert.equal(h.calls.toggles, 1);
}

{
  const h = createHarness();
  h.runtime.runUiAction("command.open", "prefill", "Command");
  h.runtime.runUiAction("command.open", "", "Command");
  h.runtime.runUiAction("page.describe", "", "Describe");
  h.runtime.runUiAction("settings.open", "", "Settings");
  h.runtime.runUiAction("agent.run", "", "Fallback label", "fallback value");
  h.runtime.runUiAction("noop", "", "No-op");
  assert.equal(h.calls.opens, 2);
  assert.deepEqual(h.calls.sets, [["prefill", { select: true }]]);
  assert.equal(h.input.focusCount, 2);
  assert.equal(h.calls.describes, 1);
  assert.deepEqual(h.calls.messages, [{ cmd: "openOptions" }]);
  assert.deepEqual(h.calls.submits, ["Fallback label"]);
}

{
  const h = createHarness({ input: null });
  h.runtime.runUiAction("command.open", "ignored", "Command");
  assert.equal(h.calls.opens, 1);
  assert.deepEqual(h.calls.sets, []);
}

{
  const h = createHarness({ withResolver: false });
  h.runtime.runUiAction("agent.run", "  use {value}  ", "", "fallback");
  h.runtime.runUiAction("agent.run", null, "", "value only");
  assert.deepEqual(h.calls.submits, ["use fallback", "value only"]);
}

console.log("content UI controller runtime tests passed");
