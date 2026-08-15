(function exposeBrowserErrors(root, factory) {
  const errors = factory();
  if (typeof module === "object" && module.exports) module.exports = errors;
  else root.AgBrowserErrors = errors;
}(typeof globalThis === "object" ? globalThis : this, function createBrowserErrors() {
  "use strict";

  const fallbackByStatus = {
    400: "That request could not be completed.",
    401: "Connection needs attention. Check the gateway token in Settings.",
    403: "This connection does not have permission for that action.",
    404: "That gateway service is not available.",
    409: "This work changed elsewhere. Refresh and try again.",
    429: "Ag is handling a lot right now. Try again shortly.",
  };

  function looksLikeMarkup(value) {
    return /<(?:!doctype|html|head|body|script|style|title|h\d|p|div|pre)(?:\s|>)/i.test(value);
  }

  function concise(value) {
    const clean = String(value || "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/[<>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return clean.length > 180 ? `${clean.slice(0, 177)}…` : clean;
  }

  function message(response, payload = {}, rawText = "") {
    const status = Number(response && response.status) || 0;
    const detail = typeof payload.error === "string" ? payload.error : "";
    if (status >= 500) return "The gateway is temporarily unavailable. Try again shortly.";
    if (looksLikeMarkup(rawText) || looksLikeMarkup(detail)) {
      return fallbackByStatus[status] || `Gateway request failed${status ? ` (${status})` : ""}.`;
    }
    const safeDetail = concise(detail);
    return safeDetail || fallbackByStatus[status] || `Gateway request failed${status ? ` (${status})` : ""}.`;
  }

  return { concise, looksLikeMarkup, message };
}));
