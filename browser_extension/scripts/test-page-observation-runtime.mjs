import assert from "node:assert/strict";
import test from "node:test";

await import(`../extension/page-observation-runtime.js?test=${Date.now()}`);
const { createPageObservationRuntime, maxObservationAnchors } = globalThis.AgeePageObservationRuntime;

function element({ tag = "BUTTON", label = "", type = "", root = false, visible = true } = {}) {
  const attributes = new Map([
    ["aria-label", label],
    ["type", type],
  ]);
  return {
    tagName: tag,
    type,
    value: "",
    innerText: "",
    getAttribute: (name) => attributes.get(name) || "",
    closest: (selector) => selector === "#agee-root" && root ? {} : null,
    getBoundingClientRect: () => visible
      ? ({ width: 80, height: 24, top: 10, bottom: 34, left: 20, right: 100 })
      : ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 }),
  };
}

function fixture({ elements = [], textNodes = [] } = {}) {
  const body = element({ tag: "BODY" });
  const document = {
    body,
    activeElement: body,
    title: "Fixture title",
    querySelectorAll: () => elements,
    createTreeWalker(_body, _kind, filter) {
      const accepted = textNodes.filter((node) => filter.acceptNode(node) === 1);
      let index = 0;
      return { nextNode: () => accepted[index++] || null };
    },
    createRange() {
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
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
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
