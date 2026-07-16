(function installBrowserCommandTranscriptRuntime(global) {
  "use strict";

  function normalizeSpokenCommand(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  }

  function isBrowserCommandTranscript(text) {
    const raw = String(text || "").trim();
    if (!raw || raw.length > 500 || raw.includes("\n")) return false;
    const lower = normalizeSpokenCommand(raw);
    if (/^(?:search|google|look up)\b/.test(lower)) return true;
    if (/^(?:find|look for|shop for)\b.*\bamazon(?: com)?\b/.test(lower)) return true;
    if (/^open\s+(?:a\s+)?(?:new\s+)?tab\s+(?:that\s+says|for|searching\s+for)\b/.test(lower)) return true;
    return /^(?:open|visit|go to|navigate to|load)\b/.test(lower) &&
      /(?:https?\s|localhost|\b[a-z0-9-]+\s+(?:com|org|net|io)\b)/.test(lower);
  }

  global.AgeeBrowserCommandTranscriptRuntime = Object.freeze({ isBrowserCommandTranscript });
})(typeof globalThis !== "undefined" ? globalThis : this);
