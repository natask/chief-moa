// Browser-local observation anchors. This file intentionally has no gateway or
// action authority: it only records and revalidates evidence owned by this
// document.
(function installObservationRuntime(global) {
  "use strict";

  const SCHEMA_VERSION = "moa.observation-anchor.v1";
  const root = global || globalThis;

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : 0;
  }

  function compactText(value, limit = 120) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function hashText(value) {
    // A deterministic compatibility fingerprint, not a security boundary.
    let hash = 2166136261;
    for (const character of String(value)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function roleFor(element) {
    const explicit = compactText(element?.getAttribute?.("role"), 40).toLowerCase();
    if (explicit) return explicit;
    const tag = String(element?.tagName || "").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = String(element?.getAttribute?.("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return tag || "element";
  }

  function nameFor(element) {
    if (!element) return "";
    const type = String(element.getAttribute?.("type") || "").toLowerCase();
    return compactText(
      element.getAttribute?.("aria-label") ||
        element.getAttribute?.("placeholder") ||
        (type !== "password" ? element.value : "") ||
        element.innerText ||
        element.getAttribute?.("title") ||
        element.getAttribute?.("name"),
    );
  }

  function elementFingerprint(element) {
    const tag = String(element?.tagName || "").toLowerCase();
    const type = compactText(element?.getAttribute?.("type"), 40).toLowerCase();
    return hashText(JSON.stringify([tag, type, roleFor(element), nameFor(element)]));
  }

  function createObservationRuntime({ window: view, document: doc, now, randomId } = {}) {
    if (!view || !doc) throw new Error("observation runtime requires a window and document");
    const clock = typeof now === "function" ? now : () => new Date().toISOString();
    const makeRandomId = typeof randomId === "function"
      ? randomId
      : () => view.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const timeOrigin = Number(view.performance?.timeOrigin) || Date.now();
    let pageEpoch = Math.max(1, Math.floor(timeOrigin * 1000));
    let layoutEpoch = 1;
    let active = true;
    let lastHref = String(view.location?.href || "");
    const documentId = `doc_${makeRandomId()}`;
    const frameId = view.top === view ? "top" : `child_${makeRandomId()}`;
    const nodeIds = new WeakMap();
    const registry = new Map();
    let nextNodeId = 1;

    function bumpLayout() {
      layoutEpoch += 1;
    }

    function invalidatePage() {
      active = false;
      pageEpoch += 1;
      layoutEpoch += 1;
      registry.clear();
    }

    function noteSameDocumentNavigation() {
      pageEpoch += 1;
      layoutEpoch += 1;
      lastHref = String(view.location?.href || "");
      registry.clear();
    }

    function syncPageLocation() {
      const href = String(view.location?.href || "");
      if (href && lastHref && href !== lastHref) noteSameDocumentNavigation();
    }

    const observer = typeof view.MutationObserver === "function"
      ? new view.MutationObserver((records) => {
          if (records.some((record) => !record.target?.closest?.("#agee-root"))) bumpLayout();
        })
      : null;
    observer?.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
    view.addEventListener?.("resize", bumpLayout, { passive: true });
    view.visualViewport?.addEventListener?.("resize", bumpLayout, { passive: true });
    view.addEventListener?.("pagehide", invalidatePage, { capture: true });
    view.addEventListener?.("beforeunload", invalidatePage, { capture: true });
    view.addEventListener?.("popstate", noteSameDocumentNavigation, { capture: true });
    view.addEventListener?.("hashchange", noteSameDocumentNavigation, { capture: true });

    function viewportState() {
      const viewport = view.visualViewport;
      return {
        width: finite(viewport?.width ?? view.innerWidth),
        height: finite(viewport?.height ?? view.innerHeight),
        offset_x: finite(viewport?.offsetLeft),
        offset_y: finite(viewport?.offsetTop),
        page_x: finite(viewport?.pageLeft ?? view.scrollX),
        page_y: finite(viewport?.pageTop ?? view.scrollY),
        scale: finite(viewport?.scale || 1),
        device_scale_factor: finite(view.devicePixelRatio || 1),
      };
    }

    function rectValue(rect) {
      return {
        x: finite(rect?.x ?? rect?.left),
        y: finite(rect?.y ?? rect?.top),
        width: finite(rect?.width),
        height: finite(rect?.height),
      };
    }

    function geometryFor(element) {
      const viewportRect = rectValue(element.getBoundingClientRect());
      return {
        document_rect: {
          ...viewportRect,
          x: finite(viewportRect.x + view.scrollX),
          y: finite(viewportRect.y + view.scrollY),
        },
        viewport_rect_at_observation: viewportRect,
        scroll_at_observation: { x: finite(view.scrollX), y: finite(view.scrollY) },
        visual_viewport: viewportState(),
      };
    }

    function localIdFor(element) {
      let localId = nodeIds.get(element);
      if (!localId) {
        localId = `el_${nextNodeId++}`;
        nodeIds.set(element, localId);
      }
      return localId;
    }

    function observe(element, { snapshotId, capturedAt } = {}) {
      syncPageLocation();
      if (!active || !element?.isConnected) return null;
      const localId = localIdFor(element);
      const fingerprint = elementFingerprint(element);
      const anchor = {
        schema_version: SCHEMA_VERSION,
        anchor_id: `anchor_${documentId}_${localId}_${snapshotId || makeRandomId()}`,
        snapshot_id: snapshotId || `snap_${makeRandomId()}`,
        document_id: documentId,
        page_epoch: pageEpoch,
        layout_epoch: layoutEpoch,
        frame_path: [frameId],
        element_ref: {
          local_id: localId,
          role: roleFor(element),
          name: nameFor(element),
          fingerprint,
        },
        geometry: geometryFor(element),
        captured_at: capturedAt || clock(),
        provenance: "dom",
      };
      registry.set(localId, { element, fingerprint });
      return anchor;
    }

    function stale(anchor, reason) {
      return {
        valid: false,
        status: "stale",
        reason,
        anchor_id: anchor?.anchor_id || "",
        page_epoch: pageEpoch,
        layout_epoch: layoutEpoch,
      };
    }

    function revalidate(anchor) {
      syncPageLocation();
      if (!anchor || anchor.schema_version !== SCHEMA_VERSION) return stale(anchor, "invalid_anchor");
      if (!active || anchor.document_id !== documentId || anchor.page_epoch !== pageEpoch) return stale(anchor, "page_changed");
      if (anchor.frame_path?.length !== 1 || anchor.frame_path[0] !== frameId) return stale(anchor, "frame_changed");
      const localId = anchor.element_ref?.local_id;
      const entry = registry.get(localId);
      if (!entry) return stale(anchor, "ambiguous_identity");
      if (!entry.element?.isConnected || entry.element.ownerDocument !== doc) return stale(anchor, "node_replaced");
      const fingerprint = elementFingerprint(entry.element);
      if (fingerprint !== entry.fingerprint || fingerprint !== anchor.element_ref.fingerprint) return stale(anchor, "identity_changed");
      const currentGeometry = geometryFor(entry.element);
      return {
        valid: true,
        status: layoutEpoch === anchor.layout_epoch ? "current" : "remeasured",
        reason: "",
        anchor_id: anchor.anchor_id,
        page_epoch: pageEpoch,
        layout_epoch: layoutEpoch,
        original_geometry: anchor.geometry,
        current_geometry: currentGeometry,
      };
    }

    function limitations() {
      const result = [];
      for (const canvas of doc.querySelectorAll?.("canvas") || []) {
        result.push({
          kind: "canvas_region",
          provenance: "pixels_unobserved",
          element_identity: false,
          geometry: geometryFor(canvas),
        });
      }
      for (const frame of doc.querySelectorAll?.("iframe,frame") || []) {
        let crossOrigin = false;
        try {
          void frame.contentDocument?.documentElement;
          crossOrigin = !frame.contentDocument;
        } catch {
          crossOrigin = true;
        }
        if (crossOrigin) {
          result.push({
            kind: "cross_origin_frame",
            provenance: "frame_boundary",
            element_identity: false,
            geometry: geometryFor(frame),
          });
        }
      }
      return result;
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      observe,
      revalidate,
      limitations,
      state: () => {
        syncPageLocation();
        return { document_id: documentId, page_epoch: pageEpoch, layout_epoch: layoutEpoch, frame_path: [frameId], active };
      },
      destroy: () => {
        observer?.disconnect();
        invalidatePage();
      },
    };
  }

  root.AgeeObservationRuntime = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    createObservationRuntime,
    elementFingerprint,
  });

  if (root.window === root && root.document && !root.__ageeObservationRuntime) {
    root.__ageeObservationRuntime = createObservationRuntime({ window: root, document: root.document });
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
