import assert from "node:assert/strict";
import test from "node:test";

await import(`../extension/page-observation-runtime.js?test=${Date.now()}`);
const { createPageObservationRuntime, maxObservationAnchors } = globalThis.AgeePageObservationRuntime;

function element({ tag = "BUTTON", label = "", placeholder = "", title = "", name = "", type = "", value = "", innerText = "", root = false, visible = true, rect = null } = {}) {
  const attributes = new Map([
    ["aria-label", label],
    ["placeholder", placeholder],
    ["title", title],
    ["name", name],
    ["type", type],
  ]);
  return {
    tagName: tag,
    type,
    value,
    innerText,
    getAttribute: (name) => attributes.get(name) || "",
    closest: (selector) => selector === "#agee-root" && root ? {} : null,
    getBoundingClientRect: () => rect || (visible
      ? ({ width: 80, height: 24, top: 10, bottom: 34, left: 20, right: 100 })
      : ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 })),
  };
}

function fixture({ elements = [], textNodes = [], rangeFactory = null, style = null, withBody = true } = {}) {
  const body = element({ tag: "BODY" });
  const document = {
    body: withBody ? body : null,
    activeElement: body,
    title: "Fixture title",
    querySelectorAll: () => elements,
    createTreeWalker(_body, _kind, filter) {
      const accepted = textNodes.filter((node) => filter.acceptNode(node) === 1);
      let index = 0;
      return { nextNode: () => accepted[index++] || null };
    },
    createRange() {
      if (rangeFactory) return rangeFactory();
      return {
        selectNodeContents() {},
        getClientRects: () => [{ width: 40, height: 12, top: 2, bottom: 14, left: 2, right: 42 }],
        detach() {},
      };
    },
  };
  const window = {
    location: { href: "https://example.test/page" },
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 2,
    scrollX: 4,
    scrollY: 8,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    getComputedStyle: (target) => style?.(target) || ({ visibility: "visible", display: "block", opacity: "1" }),
  };
  return { body, document, window };
}

test("snapshot keeps bounded visible page evidence and anchor identity", () => {
  const visibleButton = element({ label: "Open details" });
  const hiddenButton = element({ label: "Hidden", visible: false });
  const overlayButton = element({ label: "Overlay", root: true });
  const textParent = element({ tag: "P" });
  const duplicateText = [
    { nodeValue: "  Visible   page text ", parentElement: textParent },
    { nodeValue: "Visible page text", parentElement: textParent },
  ];
  const { document, window } = fixture({
    elements: [visibleButton, hiddenButton, overlayButton],
    textNodes: duplicateText,
  });
  const observed = [];
  const runtime = createPageObservationRuntime({
    window,
    document,
    observationRuntime: {
      observe(target, options) {
        observed.push({ target, options });
        return { anchor_id: "anchor-1", snapshot_id: options.snapshotId };
      },
      state: () => ({ document_id: "doc-1" }),
      limitations: () => [{ kind: "canvas_region" }],
    },
    now: () => new Date("2024-01-01T00:00:00.000Z"),
    random: () => 0.5,
  });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.elements.length, 1);
  assert.equal(snapshot.elements[0].label, "Open details");
  assert.equal(snapshot.elements[0].observation_anchor.snapshot_id, snapshot.snapshotId);
  assert.equal(snapshot.pageText, "Visible page text");
  assert.deepEqual(snapshot.viewport, { width: 800, height: 600, deviceScaleFactor: 2, scrollX: 4, scrollY: 8 });
  assert.deepEqual(snapshot.observation, { document_id: "doc-1" });
  assert.deepEqual(snapshot.observationLimitations, [{ kind: "canvas_region" }]);
  assert.equal(snapshot.elementSummaries[0], "[0] <button> Open details");
  assert.equal(runtime.elementAt(0), visibleButton);
  assert.equal(observed[0].target, visibleButton);
});

test("snapshot caps action targets and confirmation policy stays local", () => {
  const targets = Array.from({ length: maxObservationAnchors + 5 }, (_, index) => element({ label: `Target ${index}` }));
  const { body, document, window } = fixture({ elements: targets });
  const runtime = createPageObservationRuntime({ window, document });
  assert.equal(runtime.snapshot().elements.length, maxObservationAnchors);
  assert.equal(runtime.elementAt(maxObservationAnchors), undefined);

  const send = element({ label: "Send report" });
  const password = element({ tag: "INPUT", type: "password" });
  assert.equal(runtime.needsConfirmation(send, { action: "click" }), true);
  assert.equal(runtime.needsConfirmation(send, { action: "type" }), false);
  assert.equal(runtime.needsConfirmation(password, { action: "type" }), true);
  assert.equal(runtime.needsConfirmation(null, { action: "scroll" }), false);
  document.activeElement = send;
  assert.equal(runtime.needsConfirmation(null, { action: "key", text: "Enter" }), true);
  document.activeElement = body;
  assert.equal(runtime.needsConfirmation(null, { action: "key", text: "Enter" }), false);
});

test("page observation rejects missing dependencies and covers visibility and label fallbacks", () => {
  assert.throws(() => createPageObservationRuntime(), /requires a window and document/);
  assert.throws(() => createPageObservationRuntime({ window: {} }), /requires a window and document/);

  const offscreen = element({ rect: { width: 20, height: 20, top: 700, bottom: 720, left: 0, right: 20 } });
  const transparent = element({ label: "Transparent" });
  const placeholder = element({ tag: "INPUT", placeholder: "Search here", type: "text" });
  const valued = element({ tag: "INPUT", type: "text", value: "Current value" });
  const inner = element({ innerText: "Inner label" });
  const titled = element({ title: "Title label" });
  const named = element({ name: "Name label" });
  const empty = element();
  const passwordValue = element({ tag: "INPUT", type: "password", value: "secret" });
  const { document, window } = fixture({
    elements: [offscreen, transparent, placeholder, valued, inner, titled, named, empty, passwordValue],
    style: (target) => target === transparent
      ? { visibility: "visible", display: "block", opacity: "0" }
      : { visibility: "visible", display: "block", opacity: "1" },
  });
  window.devicePixelRatio = 0;
  const runtime = createPageObservationRuntime({ window, document });
  const snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.elements.map((item) => item.label), [
    "Search here", "Current value", "Inner label", "Title label", "Name label", "", "",
  ]);
  assert.equal(snapshot.viewport.deviceScaleFactor, 1);
  assert.equal(snapshot.observation, null);
  assert.deepEqual(snapshot.observationLimitations, []);
  assert.equal(runtime.label(null), "");
  assert.equal(runtime.needsConfirmation(null, { action: "key", text: "Escape" }), false);
});

test("visible text handles rejected nodes, empty ranges, and range failures", () => {
  const normal = element({ tag: "P" });
  const overlay = element({ tag: "P", root: true });
  const script = element({ tag: "SCRIPT" });
  const hidden = element({ tag: "P" });
  const nodes = [
    { nodeValue: "orphan", parentElement: null },
    { nodeValue: "overlay text", parentElement: overlay },
    { nodeValue: "script text", parentElement: script },
    { nodeValue: "x", parentElement: normal },
    { nodeValue: "hidden text", parentElement: hidden },
    { nodeValue: "visible by parent", parentElement: normal },
  ];
  const emptyRangeFixture = fixture({
    textNodes: nodes,
    style: (target) => target === hidden
      ? { visibility: "hidden", display: "block", opacity: "1" }
      : { visibility: "visible", display: "block", opacity: "1" },
    rangeFactory: () => ({ selectNodeContents() {}, getClientRects: () => [] }),
  });
  assert.equal(
    createPageObservationRuntime({ window: emptyRangeFixture.window, document: emptyRangeFixture.document }).snapshot().pageText,
    "visible by parent",
  );

  const failingRangeFixture = fixture({
    textNodes: [{ nodeValue: "range fallback", parentElement: normal }],
    rangeFactory: () => { throw new Error("range unavailable"); },
  });
  assert.equal(
    createPageObservationRuntime({ window: failingRangeFixture.window, document: failingRangeFixture.document }).snapshot().pageText,
    "range fallback",
  );

  const noBody = fixture({ withBody: false });
  assert.equal(createPageObservationRuntime({ window: noBody.window, document: noBody.document }).snapshot().pageText, "");
});
