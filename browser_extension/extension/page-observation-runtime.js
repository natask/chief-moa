// Browser-page perception for the classic content script. This module owns the
// bounded DOM snapshot and the local index that page actions resolve against;
// it has no gateway, messaging, or execution authority.
(function installPageObservationRuntime(global) {
  "use strict";

  const SELECTOR =
    'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [contenteditable=""], [contenteditable=true], [onclick]';
  const MAX_VISIBLE_TEXT_CHARS = 5200;
  const MAX_VISIBLE_TEXT_PARTS = 140;
  const MAX_OBSERVATION_ANCHORS = 100;
  const TEXT_NODE_EXCLUDED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS"]);
  const RISKY_TEXT = /\b(delete|remove|submit|send|pay|purchase|buy|checkout|confirm|transfer|withdraw|archive|sign out|log out|logout)\b/i;
  const root = global || globalThis;

  function createPageObservationRuntime({ window: view, document: doc, observationRuntime, now, random } = {}) {
    if (!view || !doc) throw new Error("page observation runtime requires a window and document");
    const clock = typeof now === "function" ? now : () => new Date();
    const randomValue = typeof random === "function" ? random : Math.random;
    let indexed = [];

    function visible(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      if (rect.bottom < 0 || rect.top > view.innerHeight || rect.right < 0 || rect.left > view.innerWidth) return false;
      const style = view.getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    }

    function cleanVisibleText(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    function textNodeVisible(node) {
      const parent = node?.parentElement;
      if (!parent || parent.closest("#agee-root") || TEXT_NODE_EXCLUDED_TAGS.has(parent.tagName)) return false;
      if (cleanVisibleText(node.nodeValue).length < 2) return false;
      const style = view.getComputedStyle(parent);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
      try {
        const range = doc.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects());
        if (typeof range.detach === "function") range.detach();
        if (!rects.length) return visible(parent);
        return rects.some((rect) =>
          rect.width >= 1 && rect.height >= 1 && rect.bottom >= 0 && rect.top <= view.innerHeight && rect.right >= 0 && rect.left <= view.innerWidth
        );
      } catch {
        return visible(parent);
      }
    }

    function visiblePageText() {
      if (!doc.body) return "";
      const walker = doc.createTreeWalker(doc.body, view.NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return textNodeVisible(node) ? view.NodeFilter.FILTER_ACCEPT : view.NodeFilter.FILTER_REJECT;
        },
      });
      const parts = [];
      const seen = new Set();
      let chars = 0;
      let node;
      while ((node = walker.nextNode())) {
        const text = cleanVisibleText(node.nodeValue);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        parts.push(text);
        chars += text.length + 1;
        if (parts.length >= MAX_VISIBLE_TEXT_PARTS || chars >= MAX_VISIBLE_TEXT_CHARS) break;
      }
      return parts.join("\n").slice(0, MAX_VISIBLE_TEXT_CHARS);
    }

    function label(element) {
      if (!element) return "";
      const text =
        element.getAttribute("aria-label") ||
        element.getAttribute("placeholder") ||
        (element.value && element.type !== "password" ? element.value : "") ||
        element.innerText ||
        element.getAttribute("title") ||
        element.getAttribute("name") ||
        "";
      return cleanVisibleText(text).slice(0, 80);
    }

    function elementSummary(item) {
      const type = item.type ? ` ${item.type}` : "";
      const labelText = item.label ? ` ${item.label}` : "";
      return `[${item.i}] <${item.tag}${type}>${labelText}`;
    }

    function inferredRole(element) {
      const explicit = element.getAttribute("role");
      if (explicit) return explicit;
      if (element.tagName === "A" && element.getAttribute("href")) return "link";
      if (element.tagName === "BUTTON") return "button";
      if (["INPUT", "TEXTAREA"].includes(element.tagName)) return element.getAttribute("type") === "search" ? "searchbox" : "textbox";
      if (element.tagName === "SELECT") return "combobox";
      return "";
    }

    function needsConfirmation(element, request) {
      if (request.action === "key" && (request.text || "Enter") === "Enter") {
        const active = doc.activeElement;
        return !!active && active !== doc.body;
      }
      if (!element) return false;
      if (request.action === "type" && element.getAttribute("type") === "password") return true;
      return request.action === "click" && RISKY_TEXT.test(label(element));
    }

    function snapshot() {
      indexed = [];
      const observed = [];
      for (const element of doc.querySelectorAll(SELECTOR)) {
        if (element.closest("#agee-root") || !visible(element)) continue;
        const i = indexed.length;
        indexed.push(element);
        observed.push({
          i,
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute("type") || "",
          role: inferredRole(element),
          name: element.getAttribute("name") || "",
          label: label(element),
          placeholder: element.getAttribute("placeholder") || "",
          test_id: element.getAttribute("data-testid") || element.getAttribute("data-test-id") || "",
          href: element.getAttribute("href") || "",
          disabled: element.hasAttribute?.("disabled") === true,
          element,
        });
        if (observed.length >= MAX_OBSERVATION_ANCHORS) break;
      }
      const capturedAt = clock().toISOString();
      const snapshotId = `snap_${Date.parse(capturedAt).toString(36)}_${randomValue().toString(36).slice(2, 8)}`;
      const elements = observed.map(({ element, ...item }) => ({
        ...item,
        observation_anchor: observationRuntime?.observe(element, { snapshotId, capturedAt }) || null,
      }));
      return {
        url: view.location.href,
        title: doc.title,
        pageText: visiblePageText(),
        elements,
        snapshotId,
        observation: observationRuntime?.state() || null,
        observationLimitations: observationRuntime?.limitations() || [],
        viewport: {
          width: view.innerWidth,
          height: view.innerHeight,
          deviceScaleFactor: view.devicePixelRatio || 1,
          scrollX: view.scrollX,
          scrollY: view.scrollY,
        },
        capturedAt,
        elementSummaries: elements.map(elementSummary),
      };
    }

    return Object.freeze({
      snapshot,
      elementAt: (index) => indexed[index],
      label,
      needsConfirmation,
    });
  }

  root.AgeePageObservationRuntime = Object.freeze({
    maxObservationAnchors: MAX_OBSERVATION_ANCHORS,
    createPageObservationRuntime,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
