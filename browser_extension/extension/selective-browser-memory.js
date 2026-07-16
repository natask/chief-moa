// Extension-owned policy for A.G.'s local selective browser memory.

const BROWSER_MEMORY_ENABLED_KEY = "ageeSelectiveBrowserMemoryEnabled";
const BROWSER_MEMORY_ENTRIES_KEY = "ageeSelectiveBrowserMemoryEntries";
const BROWSER_MEMORY_LIMIT = 100;
const BROWSER_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function boundedText(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function canonicalPageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 2048);
  } catch {
    return "";
  }
}

function normalizeMemoryCandidate(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== "object" || raw.suppressed === true) return null;
  const url = canonicalPageUrl(raw.url);
  if (!url) return null;
  const title = boundedText(raw.title, 180);
  const heading = boundedText(raw.heading, 280);
  const summary = boundedText(raw.summary, 500);
  if (!title && !heading && !summary) return null;
  const parsed = new URL(url);
  const pageKind = ["document", "form", "table", "tasks", "page"].includes(raw.page_kind)
    ? raw.page_kind
    : "page";
  const capturedAt = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  return {
    schema_version: 1,
    url,
    site: boundedText(parsed.hostname, 253),
    title,
    heading,
    summary,
    page_kind: pageKind,
    first_seen_at: capturedAt,
    last_seen_at: capturedAt,
    visit_count: 1,
  };
}

function sanitizeExistingEntry(raw) {
  const candidate = normalizeMemoryCandidate(raw, raw?.first_seen_at);
  if (!candidate) return null;
  const lastSeen = Number(raw?.last_seen_at);
  const visits = Number(raw?.visit_count);
  return {
    ...candidate,
    last_seen_at: Number.isFinite(lastSeen) ? lastSeen : candidate.first_seen_at,
    visit_count: Number.isFinite(visits) ? Math.max(1, Math.min(100000, Math.floor(visits))) : 1,
  };
}

function sameMemoryCard(left, right) {
  return ["url", "title", "heading", "summary", "page_kind"].every((key) => left[key] === right[key]);
}

function mergeMemoryEntries(existing, candidate, { nowMs = Date.now() } = {}) {
  const cutoff = nowMs - BROWSER_MEMORY_TTL_MS;
  const retained = (Array.isArray(existing) ? existing : [])
    .map(sanitizeExistingEntry)
    .filter((entry) => entry && entry.last_seen_at >= cutoff);
  if (!candidate) return retained.sort((a, b) => b.last_seen_at - a.last_seen_at).slice(0, BROWSER_MEMORY_LIMIT);
  const duplicate = retained.find((entry) => sameMemoryCard(entry, candidate));
  if (duplicate) {
    duplicate.last_seen_at = nowMs;
    duplicate.visit_count = Math.min(100000, duplicate.visit_count + 1);
  } else {
    retained.push({ ...candidate });
  }
  return retained.sort((a, b) => b.last_seen_at - a.last_seen_at).slice(0, BROWSER_MEMORY_LIMIT);
}

export {
  BROWSER_MEMORY_ENABLED_KEY,
  BROWSER_MEMORY_ENTRIES_KEY,
  BROWSER_MEMORY_LIMIT,
  BROWSER_MEMORY_TTL_MS,
  boundedText,
  canonicalPageUrl,
  mergeMemoryEntries,
  normalizeMemoryCandidate,
  sameMemoryCard,
};
