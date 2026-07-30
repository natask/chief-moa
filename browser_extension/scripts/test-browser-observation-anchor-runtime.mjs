import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserObservationAnchorRuntime } from "../extension/browser-observation-anchor-runtime.js";

function fixture() {
  const nodes = [];
  const document = {
    location: { href: "https://shop.example/products" },
    documentElement: { scrollLeft: 0, scrollTop: 0 },
    contains: (node) => nodes.includes(node) && node.isConnected !== false,
    querySelectorAll: (tag) => nodes.filter((node) => node.isConnected !== false && (tag === "*" || node.localName === tag)),
  };
  const window = {
    document,
    location: document.location,
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1200,
    innerHeight: 800,
    visualViewport: { offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, width: 1200, height: 800, scale: 1 },
  };
  let nextId = 0;
  const runtime = createBrowserObservationAnchorRuntime({
    window,
    document,
    now: () => Date.parse("2026-07-29T12:00:00.000Z"),
    createId: (prefix) => `${prefix}-${++nextId}`,
  });
  function element({ tag = "button", text = "Buy", rect = { left: 40, top: 60, width: 100, height: 30 }, attributes = {}, owner = document } = {}) {
    const node = {
      localName: tag,
      ownerDocument: owner,
      isConnected: true,
      innerText: text,
      getAttribute: (name) => attributes[name] || "",
      getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
    };
    nodes.push(node);
    return node;
  }
  return { runtime, window, document, nodes, element };
}

test("scroll reprojects one live-node identity through document and visual viewport geometry", () => {
  const { runtime, window, element } = fixture();
  const node = element({ attributes: { role: "button", "data-testid": "buy" } });
  const captured = runtime.capture(node, { provenance: { observation_id: "obs-7", source: "semantic_dom" } });
  assert.equal(captured.ok, true);
  assert.equal(captured.anchor.captured_at, "2026-07-29T12:00:00.000Z");
  assert.equal(captured.anchor.geometry.observation.top, 60);
  assert.equal(captured.anchor.geometry.document.top, 60);
  assert.equal(captured.anchor.provenance.observation_id, "obs-7");

  window.scrollY = 250;
  window.visualViewport.pageTop = 250;
  node.getBoundingClientRect = () => ({ left: 40, top: -190, right: 140, bottom: -160, width: 100, height: 30 });
  const moved = runtime.reproject(captured.anchor);
  assert.equal(moved.ok, true);
  assert.equal(moved.anchor.node_identity, captured.anchor.node_identity);
  assert.equal(moved.projection.viewport.top, -190);
  assert.equal(moved.projection.document.top, 60);
  assert.equal(moved.projection.scroll.y, 250);
  assert.equal(moved.projection.to_layout_epoch, moved.projection.from_layout_epoch);
});

test("replacement lookalikes and ambiguous replacements fail closed with distinct reasons", () => {
  const one = fixture();
  const original = one.element({ text: "Continue", attributes: { role: "button", "data-testid": "continue" } });
  const anchor = one.runtime.capture(original, { observation_id: "obs-one" }).anchor;
  original.isConnected = false;
  one.element({ text: "Continue", attributes: { role: "button", "data-testid": "continue" } });
  assert.deepEqual(one.runtime.revalidate(anchor).reason, "replacement_lookalike");

  const many = fixture();
  const first = many.element({ text: "Continue", attributes: { role: "button" } });
  const ambiguous = many.runtime.capture(first, { observation_id: "obs-many" }).anchor;
  first.isConnected = false;
  many.element({ text: "Continue", attributes: { role: "button" } });
  many.element({ text: "Continue", attributes: { role: "button" } });
  assert.equal(many.runtime.reproject(ambiguous).reason, "ambiguous_replacement");
});

test("navigation invalidates an anchor even when its old node still appears connected", () => {
  const { runtime, window, element } = fixture();
  const anchor = runtime.capture(element(), { snapshot_id: "snapshot-navigation" }).anchor;
  window.location.href = "https://shop.example/checkout";
  const result = runtime.revalidate(anchor);
  assert.equal(result.ok, false);
  assert.equal(result.status, "stale");
  assert.equal(result.reason, "page_changed");
});

test("canvas and foreign-document targets are explicitly unsupported", () => {
  const { runtime, element } = fixture();
  const canvas = runtime.capture(element({ tag: "canvas" }), { observation_id: "obs-canvas" });
  assert.deepEqual({ status: canvas.status, reason: canvas.reason }, { status: "unsupported", reason: "canvas_target" });

  const foreign = runtime.capture(element({ owner: { location: { href: "https://frames.example" } } }), { observation_id: "obs-frame" });
  assert.deepEqual({ status: foreign.status, reason: foreign.reason }, { status: "unsupported", reason: "cross_origin_target" });
});

test("detachment without a lookalike and tampered serialized evidence fail closed", () => {
  const { runtime, element } = fixture();
  const node = element({ text: "Unique" });
  const anchor = runtime.capture(node, { observation_id: "obs-unique" }).anchor;
  node.isConnected = false;
  assert.equal(runtime.revalidate(anchor).reason, "target_detached");

  const fresh = runtime.capture(element({ text: "Fresh" }), { observation_id: "obs-fresh" }).anchor;
  assert.equal(runtime.revalidate({ ...fresh, node_identity: "forged" }).reason, "anchor_evidence_mismatch");
  assert.equal(runtime.revalidate({ ...fresh, anchor_id: "missing-anchor" }).reason, "anchor_unknown");
});

test("a predictable bare anchor id cannot validate or reproject an effect proposal", () => {
  const { runtime, element } = fixture();
  const anchor = runtime.capture(element(), { observation_id: "obs-bound-object" }).anchor;
  assert.equal(runtime.revalidate(anchor.anchor_id).reason, "anchor_evidence_required");
  assert.equal(runtime.reproject(anchor.anchor_id).reason, "anchor_evidence_required");
  assert.equal(runtime.revalidate(anchor).ok, true);
});

test("same-node semantic mutation invalidates the captured proposal", () => {
  const { runtime, element } = fixture();
  const node = element({ text: "Buy", attributes: { role: "button", "data-testid": "primary-action" } });
  const anchor = runtime.capture(node, { observation_id: "obs-semantic" }).anchor;
  node.innerText = "Delete account";
  const result = runtime.revalidate(anchor);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "semantic_fingerprint_changed");
});

test("serialized proposal binding rejects tampered layout, fingerprint, provenance, and geometry", () => {
  const { runtime, element } = fixture();
  const anchor = runtime.capture(element(), {
    provenance: { observation_id: "obs-bound", snapshot_id: "snapshot-bound", source: "semantic_dom" },
  }).anchor;
  const mutations = [
    { ...anchor, layout_epoch: anchor.layout_epoch + 1 },
    { ...anchor, fingerprint: { ...anchor.fingerprint, text: "Delete" } },
    { ...anchor, provenance: { ...anchor.provenance, observation_id: "obs-other" } },
    { ...anchor, geometry: { ...anchor.geometry, document: { ...anchor.geometry.document, top: 999 } } },
  ];
  for (const mutation of mutations) {
    assert.equal(runtime.revalidate(mutation).reason, "anchor_evidence_mismatch");
  }
});

test("capture requires a snapshot or observation identity and reflow advances layout epoch", () => {
  const { runtime, element } = fixture();
  const rect = { left: 10, top: 20, width: 80, height: 20 };
  const node = element({ rect });
  assert.equal(runtime.capture(node).reason, "observation_identity_required");
  const anchor = runtime.capture(node, { snapshot_id: "snapshot-layout" }).anchor;
  rect.top = 45;
  const moved = runtime.reproject(anchor);
  assert.equal(moved.ok, true);
  assert.ok(moved.layout_epoch > anchor.layout_epoch);
  assert.equal(moved.projection.document.top, 45);
});
