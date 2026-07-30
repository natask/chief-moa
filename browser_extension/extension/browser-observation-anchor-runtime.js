const MAX_TEXT_CHARS = 160;
const MAX_PROVENANCE_CHARS = 256;

function createBrowserObservationAnchorRuntime({
  window: windowObject = globalThis.window,
  document: documentObject = windowObject?.document,
  now = () => Date.now(),
  createId = defaultIdFactory(),
} = {}) {
  if (!documentObject) throw new TypeError("document is required");

  const anchors = new Map();
  const nodeIds = new WeakMap();
  let pageEpoch = 1;
  let layoutEpoch = 1;
  let pageIdentity = readPageIdentity(windowObject, documentObject);
  let lastLayoutSignature = readLayoutSignature(windowObject, documentObject);

  function capture(node, options = {}) {
    syncEpochs();
    const unsupported = unsupportedReason(node, documentObject);
    if (unsupported) return failure("unsupported", unsupported);
    if (!isLiveNode(node, documentObject)) return failure("stale", "target_not_live");

    const provenance = normalizeProvenance(options.provenance || options);
    const observationIdentity = provenance.observation_id || provenance.snapshot_id;
    if (!observationIdentity) return failure("unsupported", "observation_identity_required");
    const anchorId = String(createId("anchor"));
    const nodeIdentity = nodeIds.get(node) || String(createId("node"));
    nodeIds.set(node, nodeIdentity);
    const fingerprint = fingerprintNode(node);
    const geometry = measureGeometry(node, windowObject, documentObject);
    const capturedAtMs = Number(now());
    const anchor = Object.freeze({
      version: 1,
      anchor_id: anchorId,
      node_identity: nodeIdentity,
      page_epoch: pageEpoch,
      layout_epoch: layoutEpoch,
      captured_at: new Date(capturedAtMs).toISOString(),
      captured_at_ms: capturedAtMs,
      observation_identity: observationIdentity,
      fingerprint,
      provenance,
      geometry,
    });
    anchors.set(anchorId, { anchor, node, pageIdentity, lastGeometry: geometry });
    return { ok: true, status: "valid", anchor };
  }

  function revalidate(anchorReference) {
    syncEpochs();
    if (!anchorReference || typeof anchorReference !== "object") {
      return failure("stale", "anchor_evidence_required");
    }
    const record = resolveRecord(anchorReference);
    if (!record) return failure("stale", "anchor_unknown");
    if (!matchesStoredAnchor(anchorReference, record.anchor)) {
      return failure("stale", "anchor_evidence_mismatch", record.anchor);
    }
    if (record.pageIdentity !== pageIdentity || record.anchor.page_epoch !== pageEpoch) {
      return failure("stale", "page_changed", record.anchor);
    }

    const unsupported = unsupportedReason(record.node, documentObject);
    if (unsupported) return failure("unsupported", unsupported, record.anchor);
    if (!isLiveNode(record.node, documentObject)) {
      return failure("stale", classifyMissingNode(record, documentObject), record.anchor);
    }
    if (nodeIds.get(record.node) !== record.anchor.node_identity) {
      return failure("stale", "node_identity_changed", record.anchor);
    }
    if (!fingerprintsEqual(fingerprintNode(record.node), record.anchor.fingerprint)) {
      return failure("stale", "semantic_fingerprint_changed", record.anchor);
    }
    const geometry = measureGeometry(record.node, windowObject, documentObject);
    if (!layoutGeometryEqual(geometry, record.lastGeometry)) layoutEpoch += 1;
    record.lastGeometry = geometry;
    return {
      ok: true,
      status: "valid",
      anchor: record.anchor,
      page_epoch: pageEpoch,
      layout_epoch: layoutEpoch,
      geometry,
    };
  }

  function reproject(anchorReference) {
    const validation = revalidate(anchorReference);
    if (!validation.ok) return validation;
    return {
      ...validation,
      projection: {
        anchor_id: validation.anchor.anchor_id,
        node_identity: validation.anchor.node_identity,
        from_layout_epoch: validation.anchor.layout_epoch,
        to_layout_epoch: validation.layout_epoch,
        observation: validation.anchor.geometry.observation,
        document: validation.geometry.document,
        viewport: validation.geometry.viewport,
        scroll: validation.geometry.scroll,
        visual_viewport: validation.geometry.visual_viewport,
      },
    };
  }

  function noteLayoutChange() {
    layoutEpoch += 1;
    lastLayoutSignature = readLayoutSignature(windowObject, documentObject);
    return layoutEpoch;
  }

  function notePageChange() {
    pageEpoch += 1;
    pageIdentity = readPageIdentity(windowObject, documentObject);
    lastLayoutSignature = readLayoutSignature(windowObject, documentObject);
    layoutEpoch += 1;
    return pageEpoch;
  }

  function syncEpochs() {
    const currentPageIdentity = readPageIdentity(windowObject, documentObject);
    if (currentPageIdentity !== pageIdentity) {
      pageEpoch += 1;
      layoutEpoch += 1;
      pageIdentity = currentPageIdentity;
      lastLayoutSignature = readLayoutSignature(windowObject, documentObject);
      return;
    }
    const signature = readLayoutSignature(windowObject, documentObject);
    if (signature !== lastLayoutSignature) {
      layoutEpoch += 1;
      lastLayoutSignature = signature;
    }
  }

  function resolveRecord(reference) {
    const id = reference?.anchor_id;
    return anchors.get(String(id || "")) || null;
  }

  return Object.freeze({
    capture,
    reproject,
    revalidate,
    noteLayoutChange,
    notePageChange,
    epochs: () => Object.freeze({ page_epoch: pageEpoch, layout_epoch: layoutEpoch }),
  });
}

function measureGeometry(node, windowObject, documentObject) {
  const rect = normalizeRect(node.getBoundingClientRect());
  const scrollX = finite(windowObject?.scrollX ?? documentObject?.documentElement?.scrollLeft);
  const scrollY = finite(windowObject?.scrollY ?? documentObject?.documentElement?.scrollTop);
  const visual = windowObject?.visualViewport;
  const visualViewport = Object.freeze({
    offset_left: finite(visual?.offsetLeft),
    offset_top: finite(visual?.offsetTop),
    page_left: finite(visual?.pageLeft, scrollX),
    page_top: finite(visual?.pageTop, scrollY),
    width: finite(visual?.width, windowObject?.innerWidth),
    height: finite(visual?.height, windowObject?.innerHeight),
    scale: finite(visual?.scale, 1),
  });
  return Object.freeze({
    observation: rect,
    document: translateRect(rect, scrollX, scrollY),
    viewport: translateRect(rect, -visualViewport.offset_left, -visualViewport.offset_top),
    scroll: Object.freeze({ x: scrollX, y: scrollY }),
    visual_viewport: visualViewport,
  });
}

function normalizeRect(rect = {}) {
  const left = finite(rect.left ?? rect.x);
  const top = finite(rect.top ?? rect.y);
  const width = finite(rect.width, finite(rect.right) - left);
  const height = finite(rect.height, finite(rect.bottom) - top);
  return Object.freeze({
    x: left,
    y: top,
    left,
    top,
    right: finite(rect.right, left + width),
    bottom: finite(rect.bottom, top + height),
    width,
    height,
  });
}

function translateRect(rect, dx, dy) {
  return Object.freeze({
    x: rect.x + dx,
    y: rect.y + dy,
    left: rect.left + dx,
    top: rect.top + dy,
    right: rect.right + dx,
    bottom: rect.bottom + dy,
    width: rect.width,
    height: rect.height,
  });
}

function fingerprintNode(node) {
  const attribute = (name) => clean(node.getAttribute?.(name), MAX_TEXT_CHARS);
  return Object.freeze({
    tag: clean(node.localName || node.tagName, 64).toLowerCase(),
    id: clean(node.id, MAX_TEXT_CHARS),
    role: attribute("role"),
    test_id: attribute("data-testid") || attribute("data-test-id"),
    name: attribute("name"),
    type: attribute("type"),
    text: clean(node.innerText || node.textContent, MAX_TEXT_CHARS),
  });
}

function classifyMissingNode(record, documentObject) {
  const candidates = Array.from(documentObject.querySelectorAll?.(record.anchor.fingerprint.tag || "*") || [])
    .filter((candidate) => fingerprintsMatch(fingerprintNode(candidate), record.anchor.fingerprint));
  if (candidates.length > 1) return "ambiguous_replacement";
  if (candidates.length === 1 && candidates[0] !== record.node) return "replacement_lookalike";
  return "target_detached";
}

function fingerprintsMatch(left, right) {
  const discriminators = ["id", "role", "test_id", "name", "type", "text"];
  return left.tag === right.tag && discriminators.every((key) => !right[key] || left[key] === right[key]);
}

function fingerprintsEqual(left, right) {
  return ["tag", "id", "role", "test_id", "name", "type", "text"].every((key) => left[key] === right[key]);
}

function layoutGeometryEqual(left, right) {
  if (!right) return false;
  return ["left", "top", "right", "bottom", "width", "height"]
    .every((key) => left.document[key] === right.document[key]);
}

function unsupportedReason(node, documentObject) {
  if (!node || typeof node !== "object" || typeof node.getBoundingClientRect !== "function") {
    return "non_element_target";
  }
  if (String(node.localName || node.tagName || "").toLowerCase() === "canvas") {
    return "canvas_target";
  }
  if (node.ownerDocument && node.ownerDocument !== documentObject) return "cross_origin_target";
  return "";
}

function isLiveNode(node, documentObject) {
  if (node.isConnected === false) return false;
  return typeof documentObject.contains !== "function" || documentObject.contains(node);
}

function matchesStoredAnchor(reference, stored) {
  return [
    "version", "anchor_id", "node_identity", "page_epoch", "layout_epoch",
    "captured_at", "captured_at_ms", "observation_identity",
  ].every((key) => reference[key] === stored[key])
    && canonical(reference.fingerprint) === canonical(stored.fingerprint)
    && canonical(reference.provenance) === canonical(stored.provenance)
    && canonical(reference.geometry) === canonical(stored.geometry);
}

function normalizeProvenance(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.freeze({
    observation_id: clean(source.observation_id || source.observationId, MAX_PROVENANCE_CHARS),
    snapshot_id: clean(source.snapshot_id || source.snapshotId, MAX_PROVENANCE_CHARS),
    source: clean(source.source || "dom", 64),
    frame: clean(source.frame || "top", 64),
    selector_hint: clean(source.selector_hint || source.selectorHint, MAX_PROVENANCE_CHARS),
  });
}

function readPageIdentity(windowObject, documentObject) {
  const liveDocument = windowObject?.document || documentObject;
  const href = clean(windowObject?.location?.href || liveDocument?.location?.href, 2048);
  return `${objectIdentity(liveDocument)}\u0000${href}`;
}

const objectIdentities = new WeakMap();
let nextObjectIdentity = 1;
function objectIdentity(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return "none";
  if (!objectIdentities.has(value)) objectIdentities.set(value, nextObjectIdentity++);
  return objectIdentities.get(value);
}

function readLayoutSignature(windowObject, documentObject) {
  const visual = windowObject?.visualViewport;
  return [
    finite(windowObject?.innerWidth),
    finite(windowObject?.innerHeight),
    finite(visual?.width),
    finite(visual?.height),
    finite(visual?.scale, 1),
  ].join(":");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function defaultIdFactory() {
  let sequence = 0;
  return (prefix) => `${prefix}-${++sequence}`;
}

function failure(status, reason, anchor) {
  return { ok: false, status, reason, ...(anchor ? { anchor } : {}) };
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback) || 0;
}

function clean(value, maxChars) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

export { createBrowserObservationAnchorRuntime };
