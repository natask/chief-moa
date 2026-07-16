// Bounded DOM perception and the local element index used by page actions.
// This module has no gateway, messaging, or execution authority.
(function installPageObservationRuntime(global) {
  "use strict";

  const SELECTOR =
    'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [contenteditable=""], [contenteditable=true], [onclick]';
  const DOCUMENT_TEXT_EXCLUDED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS"]);
  const RISKY_TEXT = /\b(delete|remove|submit|send|pay|purchase|buy|checkout|confirm|transfer|withdraw|archive|sign out|log out|logout)\b/i;

  function createPageObservationRuntime({ window: view, document: doc, documentContextPolicy, now, random } = {}) {
    if (!view || !doc) throw new Error("page observation runtime requires a window and document");
    const clock = typeof now === "function" ? now : () => new Date();
    const randomValue = typeof random === "function" ? random : Math.random;
    const contextPolicy = documentContextPolicy || global.AgeeDocumentContextPolicy;
    let indexed = [];

    function visible(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      if (rect.bottom < 0 || rect.top > view.innerHeight || rect.right < 0 || rect.left > view.innerWidth) return false;
      const style = view.getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    }

    function documentTextParts() {
      if (!doc.body) return [];
      const parts = [];
      for (const node of doc.body.childNodes) {
        if (node.nodeType === view.Node.TEXT_NODE) {
          const text = String(node.nodeValue || "").trim();
          if (text) parts.push(text);
          continue;
        }
        if (node.nodeType !== view.Node.ELEMENT_NODE || node.id === "agee-root" || DOCUMENT_TEXT_EXCLUDED_TAGS.has(node.tagName)) continue;
        for (const line of String(node.innerText || "").split(/\n+/)) {
          if (line.trim()) parts.push(line);
        }
      }
      return parts;
    }

    function documentPageContext() {
      const result = contextPolicy?.buildDocumentContext
        ? contextPolicy.buildDocumentContext(documentTextParts())
        : { text: "", metadata: { scope: "whole_rendered_document", coverage: "unavailable", complete: false, truncated: true } };
      return {
        pageText: result.text,
        metadata: {
          ...result.metadata,
          text_source: "rendered_dom_inner_text",
          canvas_count: doc.querySelectorAll("canvas").length,
          frame_count: doc.querySelectorAll("iframe,frame").length,
          virtualized_content_may_require_scroll: doc.documentElement.scrollHeight > view.innerHeight,
        },
      };
    }

    function label(element) {
      if (!element) return "";
      const text = element.getAttribute("aria-label")
        || element.getAttribute("placeholder")
        || (element.value && element.type !== "password" ? element.value : "")
        || element.innerText
        || element.getAttribute("title")
        || element.getAttribute("name")
        || "";
      return text.replace(/\s+/g, " ").trim().slice(0, 80);
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
      const elements = [];
      const documentContext = documentPageContext();
      for (const element of doc.querySelectorAll(SELECTOR)) {
        if (element.closest("#agee-root") || !visible(element)) continue;
        const i = indexed.length;
        indexed.push(element);
        elements.push({ i, tag: element.tagName.toLowerCase(), type: element.getAttribute("type") || "", label: label(element) });
      }
      const capturedAt = clock().toISOString();
      return {
        url: view.location.href,
        title: doc.title,
        pageText: documentContext.pageText,
        documentContext: documentContext.metadata,
        elements,
        snapshotId: `snap_${Date.parse(capturedAt).toString(36)}_${randomValue().toString(36).slice(2, 8)}`,
        viewport: {
          width: view.innerWidth,
          height: view.innerHeight,
          deviceScaleFactor: view.devicePixelRatio || 1,
          scrollX: view.scrollX,
          scrollY: view.scrollY,
        },
        capturedAt,
        elementSummaries: elements.map((item) => `[${item.i}] <${item.tag}${item.type ? ` ${item.type}` : ""}>${item.label ? ` ${item.label}` : ""}`),
      };
    }

    return Object.freeze({ snapshot, elementAt: (index) => indexed[index], label, needsConfirmation });
  }

  global.AgeePageObservationRuntime = Object.freeze({ createPageObservationRuntime });
})(typeof globalThis !== "undefined" ? globalThis : this);
