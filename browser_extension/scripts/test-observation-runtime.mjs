import assert from "node:assert/strict";

delete globalThis.AgeeObservationRuntime;
await import(`../extension/observation-runtime.js?test=${Date.now()}`);
const api = globalThis.AgeeObservationRuntime;
assert.ok(api, "observation runtime must expose a browser/Node-compatible global");

const listeners = new Map();
const viewportListeners = new Map();
let mutationCallback;
class FakeMutationObserver {
  constructor(callback) { mutationCallback = callback; }
  observe() {}
  disconnect() {}
}

const doc = {
  limitationNodes: [],
  querySelectorAll(selector) {
    if (selector === "canvas") return this.limitationNodes.filter((node) => node.tagName === "CANVAS");
    if (selector === "iframe,frame") return this.limitationNodes.filter((node) => node.tagName === "IFRAME");
    return [];
  },
};
const view = {
  performance: { timeOrigin: 1000 },
  MutationObserver: FakeMutationObserver,
  innerWidth: 800,
  innerHeight: 600,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 2,
  location: { href: "https://example.test/one" },
  crypto: { randomUUID: () => "unused" },
  addEventListener(type, callback) { listeners.set(type, callback); },
  visualViewport: {
    width: 800,
    height: 600,
    offsetLeft: 0,
    offsetTop: 0,
    pageLeft: 0,
    pageTop: 0,
    scale: 1,
    addEventListener(type, callback) { viewportListeners.set(type, callback); },
  },
};
view.top = view;

function element(tagName, attributes = {}, rect = { x: 40, y: 200, width: 180, height: 44 }) {
  return {
    tagName,
    ownerDocument: doc,
    isConnected: true,
    innerText: attributes.text || "",
    value: attributes.value || "",
    rect: { ...rect },
    getAttribute(name) { return attributes[name] || ""; },
    getBoundingClientRect() { return { ...this.rect }; },
    closest() { return null; },
  };
}

let id = 0;
const runtime = api.createObservationRuntime({
  window: view,
  document: doc,
  now: () => "2026-07-15T00:00:00.000Z",
  randomId: () => `fixed_${++id}`,
});
const button = element("BUTTON", { "aria-label": "Stable target", text: "Stable target" });
const first = runtime.observe(button, { snapshotId: "snap_one" });
const second = runtime.observe(button, { snapshotId: "snap_two" });
assert.equal(first.schema_version, "moa.observation-anchor.v1");
assert.equal(first.snapshot_id, "snap_one");
assert.equal(first.element_ref.local_id, second.element_ref.local_id);
assert.equal(first.element_ref.role, "button");
assert.equal(first.captured_at, "2026-07-15T00:00:00.000Z");
assert.deepEqual(first.frame_path, ["top"]);
assert.deepEqual(first.geometry.document_rect, { x: 40, y: 200, width: 180, height: 44 });

view.scrollY = 100;
view.visualViewport.pageTop = 100;
button.rect.y = 100;
const scrolled = runtime.revalidate(first);
assert.equal(scrolled.valid, true);
assert.equal(scrolled.status, "current", "ordinary scroll must not advance layout epoch");
assert.equal(scrolled.current_geometry.document_rect.y, 200);
assert.equal(scrolled.current_geometry.viewport_rect_at_observation.y, 100);

button.rect.y = 160;
mutationCallback([{ target: button }]);
const reflowed = runtime.revalidate(first);
assert.equal(reflowed.valid, true);
assert.equal(reflowed.status, "remeasured");
assert.equal(reflowed.current_geometry.document_rect.y, 260);

viewportListeners.get("resize")();
assert.ok(runtime.state().layout_epoch > first.layout_epoch);

const wrongFrame = structuredClone(first);
wrongFrame.frame_path = ["child"];
assert.equal(runtime.revalidate(wrongFrame).reason, "frame_changed");
const unknown = structuredClone(first);
unknown.element_ref.local_id = "el_unknown";
assert.equal(runtime.revalidate(unknown).reason, "ambiguous_identity");

button.isConnected = false;
assert.equal(runtime.revalidate(first).reason, "node_replaced");

button.isConnected = true;
view.location.href = "https://example.test/two";
assert.equal(runtime.revalidate(first).reason, "page_changed");
const afterSameDocumentNavigation = runtime.observe(button, { snapshotId: "snap_three" });
assert.ok(afterSameDocumentNavigation, "same-document navigation must permit a fresh observation");
assert.notEqual(afterSameDocumentNavigation.page_epoch, first.page_epoch);

const canvas = element("CANVAS");
const iframe = element("IFRAME");
Object.defineProperty(iframe, "contentDocument", { get() { throw new Error("cross origin"); } });
doc.limitationNodes = [canvas, iframe];
assert.deepEqual(runtime.limitations().map((item) => item.kind), ["canvas_region", "cross_origin_frame"]);
assert.ok(runtime.limitations().every((item) => item.element_identity === false));

listeners.get("pagehide")();
assert.equal(runtime.revalidate(first).reason, "page_changed");
assert.equal(runtime.state().active, false);
assert.equal(runtime.observe(button), null);

console.log("observation runtime unit checks passed");
