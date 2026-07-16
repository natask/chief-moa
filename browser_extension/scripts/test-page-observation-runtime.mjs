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

function fixture({ elements = [], childNodes = [], style = null, withBody = true, scrollHeight = 0 } = {}) {
  const body = element({ tag: "BODY" });
  body.childNodes = childNodes;
  const document = {
    body: withBody ? body : null,
    documentElement: { scrollHeight },
    activeElement: body,
    title: "Fixture title",
    querySelectorAll: (selector) => selector === "canvas" || selector === "iframe,frame" ? [] : elements,
  };
  const window = {
    location: { href: "https://example.test/page" },
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 2,
    scrollX: 4,
    scrollY: 8,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    getComputedStyle: (target) => style?.(target) || ({ visibility: "visible", display: "block", opacity: "1" }),
  };
  return { body, document, window };
}

test("snapshot keeps bounded visible page evidence and anchor identity", () => {
  const visibleButton = element({ label: "Open details" });
  const hiddenButton = element({ label: "Hidden", visible: false });
  const overlayButton = element({ label: "Overlay", root: true });
  const childNodes = [
    { nodeType: 3, nodeValue: "Visible page text" },
    { nodeType: 1, tagName: "P", id: "", innerText: "More page text" },
  ];
  const { document, window } = fixture({
    elements: [visibleButton, hiddenButton, overlayButton],
    childNodes,
  });
  const runtime = createPageObservationRuntime({
    window,
    document,
    documentContextPolicy: {
      buildDocumentContext(parts) {
        assert.deepEqual(parts, ["Visible page text", "More page text"]);
        return { text: parts.join("\n"), metadata: { scope: "whole_rendered_document", complete: true } };
      },
    },
    now: () => new Date("2024-01-01T00:00:00.000Z"),
    random: () => 0.5,
  });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.elements.length, 1);
  assert.equal(snapshot.elements[0].label, "Open details");
  assert.equal(snapshot.pageText, "Visible page text\nMore page text");
  assert.deepEqual(snapshot.viewport, { width: 800, height: 600, deviceScaleFactor: 2, scrollX: 4, scrollY: 8 });
  assert.equal(snapshot.documentContext.scope, "whole_rendered_document");
  assert.equal(snapshot.documentContext.canvas_count, 0);
  assert.equal(snapshot.documentContext.virtualized_content_may_require_scroll, false);
  assert.equal(snapshot.elementSummaries[0], "[0] <button> Open details");
  assert.equal(runtime.elementAt(0), visibleButton);
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
  assert.equal(snapshot.documentContext.coverage, "unavailable");
  assert.equal(snapshot.documentContext.truncated, true);
  assert.equal(runtime.label(null), "");
  assert.equal(runtime.needsConfirmation(null, { action: "key", text: "Escape" }), false);
});

test("whole-document context excludes extension, script, and non-element nodes", () => {
  const contextFixture = fixture({
    scrollHeight: 1200,
    childNodes: [
      { nodeType: 3, nodeValue: " plain text " },
      { nodeType: 3, nodeValue: "   " },
      { nodeType: 1, id: "agee-root", tagName: "DIV", innerText: "extension chrome" },
      { nodeType: 1, id: "", tagName: "SCRIPT", innerText: "script text" },
      { nodeType: 1, id: "", tagName: "MAIN", innerText: "first line\n\nsecond line" },
      { nodeType: 8, nodeValue: "comment" },
    ],
  });
  const runtime = createPageObservationRuntime({
    window: contextFixture.window,
    document: contextFixture.document,
    documentContextPolicy: {
      buildDocumentContext(parts) {
        assert.deepEqual(parts, ["plain text", "first line", "second line"]);
        return { text: parts.join(" | "), metadata: { scope: "whole_rendered_document" } };
      },
    },
  });
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.pageText, "plain text | first line | second line");
  assert.equal(snapshot.documentContext.virtualized_content_may_require_scroll, true);

  const noBody = fixture({ withBody: false });
  assert.equal(createPageObservationRuntime({ window: noBody.window, document: noBody.document }).snapshot().pageText, "");
});
