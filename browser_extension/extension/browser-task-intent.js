// Detect typed requests that should launch the browser task-agent path.
// The service worker owns execution; this module only extracts a safe http(s)
// target from natural language.

const ACTION_RE = /\b(open|visit|go to|navigate to|load)\b/i;
const REPORT_RE = /\b(report|summari[sz]e|describe|check|find|look up|read|tell me|what(?:'s| is)?|inspect)\b/i;
const FULL_HTTP_RE = /\bhttps?:\/\/[^\s<>"']+/i;
const LOCALHOST_RE = /\b(?:localhost|127(?:\.\d{1,3}){3})(?::\d+)?(?:\/[^\s<>"']*)?/i;
const DOMAIN_RE = /\b(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/[^\s<>"']*)?/i;
const PAGE_CONTEXT_TARGET_RE = /\b(?:this|current|visible|open|active)\s+(?:web\s*)?(?:page|site|tab|screen|view|button|form|field|link)\b/i;
const PAGE_CONTEXT_VERB_RE = /\b(?:summari[sz]e|read|describe|check|inspect|analy[sz]e|explain|review|scan)\b/i;
const PAGE_CONTEXT_QUESTION_RE = /\b(?:what|where|which|who|why|how|can|does|is|are|should)\b/i;
const PAGE_LOOKING_RE = /\bwhat\s+(?:am i|are we)\s+(?:looking at|seeing|viewing)\b|\bwhat(?:'s| is)\s+on\s+(?:my|this|the)\s+screen\b/i;
const POLITE_PREFIX_RE = /^(?:hey\s+(?:a\.?g\.?|aggie|moa)[, ]+|please\s+)+/i;

function parseBrowserTaskIntent(text) {
  const raw = String(text || "").trim();
  if (!raw || !ACTION_RE.test(raw) || !REPORT_RE.test(raw)) {
    return null;
  }
  const url = extractHttpUrl(raw);
  if (!url) return null;
  return { url, instruction: raw };
}

function parseOpenTabIntent(text) {
  const raw = String(text || "").trim();
  if (!raw || !ACTION_RE.test(raw) || REPORT_RE.test(raw)) {
    return null;
  }
  const url = extractHttpUrl(raw);
  if (!url) return null;
  return { url, instruction: raw };
}

function parseBrowserSearchIntent(text) {
  const raw = String(text || "").trim().replace(POLITE_PREFIX_RE, "");
  if (!raw || raw.length > 500 || raw.includes("\n")) return null;
  const value = raw.replace(/[.?!]+$/g, "").trim();
  if (/^search\s+(?:this|the\s+current)\s+page\b/i.test(value)) return null;
  const amazonPatterns = [
    /^find\s+(?:me\s+)?(?:a\s+)?product\s+like\s+(.+?)\s+(?:on|at|in)\s+amazon(?:\.com)?$/i,
    /^(?:search|find|look)\s+(?:on\s+)?amazon(?:\.com)?\s+(?:for\s+)?(.+)$/i,
    /^(?:find(?:\s+me)?|look\s+for|shop\s+for|search\s+for)\s+(?:(?:a|an)\s+)?(.+?)\s+(?:on|at|in)\s+amazon(?:\.com)?$/i,
  ];
  for (const pattern of amazonPatterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const query = boundedSearchQuery(match[1]);
    return query ? { query, provider: "amazon", active: true } : null;
  }
  const webPatterns = [
    /^(?:search(?:\s+the\s+web)?|google|look\s+up)\s+(?:for\s+)?(.+)$/i,
    /^open\s+(?:a\s+)?(?:new\s+)?tab\s+(?:that\s+says|for|searching\s+for)\s+(.+)$/i,
  ];
  for (const pattern of webPatterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const query = boundedSearchQuery(match[1]);
    return query ? { query, provider: "google", active: true } : null;
  }
  return null;
}

function boundedSearchQuery(value) {
  const query = String(value || "").replace(/\s+/g, " ").trim();
  if (/^(?:this|that|it|this product|that product|this (?:image|photo)|that (?:image|photo))$/i.test(query)) return "";
  return query && query.length <= 500 ? query : "";
}

function extractHttpUrl(text) {
  const raw = String(text || "");
  const explicit = raw.match(FULL_HTTP_RE)?.[0];
  if (explicit) return normalizeHttpUrl(explicit);

  const local = raw.match(LOCALHOST_RE)?.[0];
  if (local) return normalizeHttpUrl(`http://${local}`);

  const domain = raw.match(DOMAIN_RE)?.[0];
  if (domain) return normalizeHttpUrl(`https://${domain}`);

  return null;
}

function looksLikePageContextQuestion(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 260 || raw.split(/\r?\n/).length > 3) return false;
  if (PAGE_LOOKING_RE.test(raw)) return true;
  if (!PAGE_CONTEXT_TARGET_RE.test(raw)) return false;
  return PAGE_CONTEXT_VERB_RE.test(raw) || PAGE_CONTEXT_QUESTION_RE.test(raw) || /\?$/.test(raw);
}

function normalizeHttpUrl(value) {
  const token = String(value || "")
    .trim()
    .replace(/^[<("']+/, "")
    .replace(/[>)"',.;!?]+$/g, "");
  try {
    const url = new URL(token);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

export { parseBrowserSearchIntent, parseBrowserTaskIntent, parseOpenTabIntent, extractHttpUrl, looksLikePageContextQuestion };
