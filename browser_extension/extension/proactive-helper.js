// Privacy-first proactive helper primitives.
//
// This file is deliberately a classic-script/Node-compatible UMD surface: the
// content script can load it before content.js without dynamic code, while the
// focused Node test can import it and read globalThis.AgeeProactiveHelper.
(function installProactiveHelper(root, factory) {
  const api = factory();
  root.AgeeProactiveHelper = Object.freeze(api);
  if (typeof module === "object" && module?.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createProactiveHelper() {
  "use strict";

  const MAX_COUNT = 100;
  const NUMERIC_SIGNAL_KEYS = Object.freeze([
    "article_count",
    "heading_count",
    "paragraph_count",
    "link_count",
    "table_count",
    "list_count",
    "task_count",
    "form_count",
    "editable_count",
    "button_count",
  ]);
  const SENSITIVE_ROUTE_RE = /(?:^|[\/_?&=.#-])(auth|login|log-in|sign-in|signin|password|passwd|credential|recover|reset|oauth|authorize|checkout|payment|billing|bank|wallet|patient|health|medical|tax|payroll|vault|admin|security)(?:$|[\/_?&=.#-])/i;
  const SENSITIVE_AUTOCOMPLETE = new Set([
    "current-password",
    "new-password",
    "one-time-code",
    "cc-name",
    "cc-given-name",
    "cc-additional-name",
    "cc-family-name",
    "cc-number",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
    "cc-csc",
    "cc-type",
    "transaction-currency",
    "transaction-amount",
  ]);
  const SENSITIVE_AUTOCOMPLETE_SELECTOR = [...SENSITIVE_AUTOCOMPLETE]
    .map((token) => `[autocomplete~="${token}" i]`)
    .join(",");
  const SENSITIVE_FORM_TERMS = Object.freeze([
    "auth", "login", "log-in", "sign in", "sign-in", "signin", "password", "credential",
    "checkout", "payment", "billing", "bank", "wallet", "card", "patient",
    "health", "medical", "tax", "payroll", "vault", "security",
  ]);
  const SENSITIVE_FORM_METADATA_SELECTOR = ["action", "id", "name", "class", "aria-label"]
    .flatMap((attribute) => SENSITIVE_FORM_TERMS.map((term) => `form[${attribute}*="${term}" i]`))
    .join(",");
  const CARD_DEFINITIONS = Object.freeze({
    form: Object.freeze({
      kind: "form",
      title: "Review this form",
      suggestion: "Would you like help making a checklist for this form?",
      instruction: "Help me make a checklist for reviewing this form's structure.",
    }),
    table: Object.freeze({
      kind: "table",
      title: "Analyze this table",
      suggestion: "Would you like help planning an analysis of this table?",
      instruction: "Help me plan an analysis for a table.",
    }),
    tasks: Object.freeze({
      kind: "tasks",
      title: "Organize this task surface",
      suggestion: "Would you like help organizing the work shown here?",
      instruction: "Help me organize a task surface.",
    }),
    document: Object.freeze({
      kind: "document",
      title: "Summarize this document",
      suggestion: "Would you like help planning a concise summary?",
      instruction: "Help me plan a concise document summary.",
    }),
  });

  function boundedCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.min(MAX_COUNT, Math.floor(number));
  }

  function sanitizeSignals(input) {
    const source = input && typeof input === "object" ? input : {};
    const output = { schema_version: 1 };
    for (const key of NUMERIC_SIGNAL_KEYS) output[key] = boundedCount(source[key]);
    return output;
  }

  function classifyStructuralPage(signals) {
    const safe = sanitizeSignals(signals);
    let kind = "";
    if (safe.form_count > 0 && safe.editable_count > 0) kind = "form";
    else if (safe.table_count > 0) kind = "table";
    else if (safe.task_count > 1 || (safe.list_count > 1 && safe.editable_count > 0)) kind = "tasks";
    else if (safe.article_count > 0 || safe.heading_count > 1 || safe.paragraph_count > 4) kind = "document";
    if (!kind) return null;
    return { ...CARD_DEFINITIONS[kind] };
  }

  function safeLocationParts(locationLike) {
    const protocol = String(locationLike?.protocol || "").toLowerCase();
    const hostname = String(locationLike?.hostname || "").toLowerCase();
    const pathname = String(locationLike?.pathname || "");
    const search = String(locationLike?.search || "");
    const hash = String(locationLike?.hash || "");
    const rawRoute = `${pathname}${search}${hash}`;
    if (rawRoute.length > 8192) return { protocol, hostname, route: "", routeError: "route_too_long" };
    try {
      return { protocol, hostname, route: decodeURIComponent(rawRoute), routeError: "" };
    } catch {
      return { protocol, hostname, route: "", routeError: "malformed_route" };
    }
  }

  function hasSensitiveAutocomplete(doc) {
    try {
      return Boolean(doc?.querySelector?.(SENSITIVE_AUTOCOMPLETE_SELECTOR));
    } catch {
      return true;
    }
  }

  function hasSensitiveFormMetadata(doc) {
    try {
      return Boolean(doc?.querySelector?.(SENSITIVE_FORM_METADATA_SELECTOR));
    } catch {
      return true;
    }
  }

  function detectSensitivePage(doc, locationLike) {
    const location = safeLocationParts(locationLike);
    if (location.protocol !== "http:" && location.protocol !== "https:") {
      return { suppressed: true, reason: "unsupported_protocol" };
    }
    if (location.routeError) return { suppressed: true, reason: location.routeError };
    if (SENSITIVE_ROUTE_RE.test(`${location.hostname}/${location.route}`)) {
      return { suppressed: true, reason: "sensitive_route" };
    }
    try {
      if (doc?.querySelector?.('input[type="password"], input[type="Password"]')) {
        return { suppressed: true, reason: "password_field" };
      }
    } catch {
      return { suppressed: true, reason: "document_unavailable" };
    }
    if (hasSensitiveAutocomplete(doc)) return { suppressed: true, reason: "sensitive_autocomplete" };
    if (hasSensitiveFormMetadata(doc)) return { suppressed: true, reason: "sensitive_form" };
    return { suppressed: false, reason: "" };
  }

  function buildAcceptedPrompt(card) {
    const kind = String(card?.kind || "");
    return CARD_DEFINITIONS[kind]?.instruction || "";
  }

  return {
    CARD_DEFINITIONS,
    NUMERIC_SIGNAL_KEYS,
    buildAcceptedPrompt,
    classifyStructuralPage,
    detectSensitivePage,
    sanitizeSignals,
  };
});
