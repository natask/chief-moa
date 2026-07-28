const MAX_DIAGNOSTIC_DURATION_MS = 2_000;
const MAX_DIAGNOSTIC_ENTRIES = 100;

function normalizeDiagnosticRequest(input = {}) {
  const duration = Number(input.duration_ms ?? input.duration);
  const limit = Number(input.limit);
  return {
    tabId: boundedTabId(input.tab_id ?? input.tabId),
    durationMs: Number.isFinite(duration) ? Math.max(0, Math.min(Math.floor(duration), MAX_DIAGNOSTIC_DURATION_MS)) : 500,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_DIAGNOSTIC_ENTRIES) : 50,
  };
}

function boundedTabId(value) {
  if (value == null || value === "") return null;
  const tabId = Number(value);
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

function compactDiagnosticEntry(value, maxChars = 2_000) {
  if (!value || typeof value !== "object") return null;
  try {
    const serialized = JSON.stringify(value);
    return JSON.parse(serialized.slice(0, maxChars));
  } catch {
    return { text: String(value).slice(0, maxChars) };
  }
}

export { MAX_DIAGNOSTIC_DURATION_MS, MAX_DIAGNOSTIC_ENTRIES, compactDiagnosticEntry, normalizeDiagnosticRequest };
