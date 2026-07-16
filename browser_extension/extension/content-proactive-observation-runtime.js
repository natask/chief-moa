(function installContentProactiveObservationRuntime(global) {
  "use strict";

  const root = global || globalThis;

  function createContentProactiveObservationRuntime(options = {}) {
    const documentRef = options.document || root.document;
    const locationRef = options.location || root.location;
    const nodeFilter = options.NodeFilter || root.NodeFilter;
    const getHelper = options.getHelper || (() => root.AgeeProactiveHelper || null);
    const getOverlayRoot = options.getOverlayRoot || (() => null);

    function proactiveHelper() {
      return getHelper() || null;
    }

    function proactiveSensitivity() {
      const helper = proactiveHelper();
      if (!helper) return { suppressed: true, reason: "helper_unavailable" };
      return helper.detectSensitivePage(documentRef, locationRef);
    }

    function collectProactiveSignals() {
      const helper = proactiveHelper();
      if (!helper || !documentRef?.documentElement) return null;
      const signals = {
        article_count: 0,
        heading_count: 0,
        paragraph_count: 0,
        link_count: 0,
        table_count: 0,
        list_count: 0,
        task_count: 0,
        form_count: 0,
        editable_count: 0,
        button_count: 0,
      };
      let saturated = 0;
      const increment = (key) => {
        if (signals[key] >= 100) return;
        signals[key] += 1;
        if (signals[key] === 100) saturated += 1;
      };
      let visited = 0;
      try {
        const walker = documentRef.createTreeWalker(
          documentRef.documentElement,
          nodeFilter.SHOW_ELEMENT,
          {
            acceptNode(node) {
              return node === getOverlayRoot() ? nodeFilter.FILTER_REJECT : nodeFilter.FILTER_ACCEPT;
            },
          },
        );
        let node;
        while (visited < 2000 && (node = walker.nextNode())) {
          visited += 1;
          const tag = node.localName;
          const role = String(node.getAttribute("role") || "").toLowerCase();
          if (tag === "article" || (tag === "main" && role === "main")) increment("article_count");
          if (tag === "h1" || tag === "h2" || tag === "h3" || role === "heading") increment("heading_count");
          if (tag === "p") increment("paragraph_count");
          if (tag === "a" && node.hasAttribute("href")) increment("link_count");
          if (tag === "table" || role === "table" || role === "grid") increment("table_count");
          if (tag === "ul" || tag === "ol" || role === "list") increment("list_count");
          if (
            (tag === "input" && String(node.getAttribute("type") || "").toLowerCase() === "checkbox") ||
            role === "checkbox" ||
            node.hasAttribute("data-task") ||
            node.hasAttribute("data-todo")
          ) increment("task_count");
          if (tag === "form") increment("form_count");
          if (
            (tag === "input" && String(node.getAttribute("type") || "").toLowerCase() !== "hidden") ||
            tag === "textarea" ||
            tag === "select" ||
            String(node.getAttribute("contenteditable") || "").toLowerCase() === "true"
          ) increment("editable_count");
          if (tag === "button" || role === "button") increment("button_count");
          if (saturated === 10) break;
        }
      } catch {
        return null;
      }
      return helper.sanitizeSignals(signals) || null;
    }

    return Object.freeze({ collectProactiveSignals, proactiveHelper, proactiveSensitivity });
  }

  root.AgeeContentProactiveObservationRuntime = Object.freeze({ createContentProactiveObservationRuntime });
})(typeof globalThis !== "undefined" ? globalThis : this);
