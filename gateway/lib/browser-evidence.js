"use strict";

const { sanitizeLooseId, screenNodeLabel } = require("./input-utils");

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function browserEvidenceSummaryFromBody(body) {
  if (!body || typeof body !== "object") return emptyBrowserEvidenceSummary();
  const summaries = [];
  const topLevelVisibleText = body.visible_text || body.visibleText || body.page_text || body.pageText || "";
  if (topLevelVisibleText) {
    summaries.push(browserEvidenceSummaryFromValue({
      visible_text: topLevelVisibleText,
      url: body.url,
      title: body.title,
      origin: body.origin,
    }));
  }
  for (const value of [
    body.evidence,
    body.evidence_summary,
    body.snapshot,
    body.screen,
    body.context?.screen,
    body.page_context,
    body.page,
    body.context?.page,
    body.context?.browser_page,
  ]) {
    const summary = browserEvidenceSummaryFromValue(value);
    if (summary.visible_text || summary.source_ref || summary.context_scope) summaries.push(summary);
  }
  if (!summaries.length) return emptyBrowserEvidenceSummary(browserPageRefFromBody(body));
  return mergeBrowserEvidenceSummaries(...summaries, { page_ref: browserPageRefFromBody(body) });
}

function browserEvidenceSummaryFromValue(value) {
  if (!value) return emptyBrowserEvidenceSummary();
  if (typeof value === "string") {
    return { ...emptyBrowserEvidenceSummary(), visible_text: normalizeWhitespace(value) };
  }
  if (typeof value !== "object" || Array.isArray(value)) return emptyBrowserEvidenceSummary();
  const sourceRef = String(value.id || value.ref || value.evidence_ref || value.evidence_id || "").trim();
  const documentContext = browserDocumentContextFromValue(value);
  return {
    page_ref: browserPageRefFromValue(value),
    visible_text: normalizeWhitespace(browserVisibleTextFromValue(value)),
    source_ref: sourceRef ? truncate(sourceRef, 200) : "",
    source_kind: truncate(String(value.kind || value.type || ""), 80),
    ...documentContext,
  };
}

function browserDocumentContextFromValue(value) {
  const raw = value?.document_context || value?.documentContext;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const scope = truncate(String(raw.scope || ""), 80);
  const coverage = truncate(String(raw.coverage || ""), 80);
  const finiteCount = (item) => item != null && Number.isSafeInteger(Number(item)) && Number(item) >= 0 ? Number(item) : null;
  return {
    context_scope: scope,
    context_coverage: coverage,
    context_complete: raw.complete === true ? true : raw.complete === false ? false : null,
    context_truncated: raw.truncated === true,
    source_parts_total: finiteCount(raw.source_parts_total),
    source_parts_included: finiteCount(raw.source_parts_included),
  };
}

function browserVisibleTextFromValue(value) {
  if (!value || typeof value !== "object") return "";
  const direct = [
    value.visible_text,
    value.visibleText,
    value.text,
    value.page_text,
    value.pageText,
    value.summary,
    value.content,
    value.markdown,
    value.selection,
    value.selected_text,
    value.selectedText,
  ].map((item) => Array.isArray(item) ? item.join("\n") : String(item || "").trim()).filter(Boolean);
  const nodeText = Array.isArray(value.nodes) ? value.nodes.map(screenNodeLabel).filter(Boolean).join("\n") : "";
  const headings = Array.isArray(value.headings)
    ? value.headings.map((item) => typeof item === "string" ? item : String(item?.text || item?.label || "")).filter(Boolean).join("\n")
    : "";
  return [direct.join("\n"), nodeText, headings].filter(Boolean).join("\n");
}

function mergeBrowserEvidenceSummaries(...summaries) {
  const next = emptyBrowserEvidenceSummary();
  const texts = [];
  for (const summary of summaries) {
    if (!summary || typeof summary !== "object") continue;
    next.page_ref = mergeBrowserPageRefs(next.page_ref, summary.page_ref);
    if (summary.visible_text) addDistinctEvidenceText(texts, summary.visible_text);
    if (!next.source_ref && summary.source_ref) next.source_ref = String(summary.source_ref);
    if (!next.source_kind && summary.source_kind) next.source_kind = String(summary.source_kind);
    if (!next.context_scope && summary.context_scope) next.context_scope = String(summary.context_scope);
    if (!next.context_coverage && summary.context_coverage) next.context_coverage = String(summary.context_coverage);
    if (summary.context_complete === false) next.context_complete = false;
    else if (next.context_complete == null && summary.context_complete === true) next.context_complete = true;
    if (summary.context_truncated === true) next.context_truncated = true;
    if (next.source_parts_total == null && summary.source_parts_total != null) next.source_parts_total = Number(summary.source_parts_total);
    if (next.source_parts_included == null && summary.source_parts_included != null) next.source_parts_included = Number(summary.source_parts_included);
  }
  next.visible_text = truncate(normalizeWhitespace(texts.join("\n")), 20_000);
  return next;
}

function addDistinctEvidenceText(texts, value) {
  const text = normalizeWhitespace(value);
  if (!text) return;
  if (texts.some((existing) => existing.includes(text))) return;
  const containedIndex = texts.findIndex((existing) => text.includes(existing));
  if (containedIndex >= 0) texts[containedIndex] = text;
  else texts.push(text);
}

function emptyBrowserEvidenceSummary(pageRef = {}) {
  return {
    page_ref: sanitizeBrowserPageRef(pageRef),
    visible_text: "",
    source_ref: "",
    source_kind: "",
    context_scope: "",
    context_coverage: "",
    context_complete: null,
    context_truncated: false,
    source_parts_total: null,
    source_parts_included: null,
  };
}

function browserPageRefFromBody(body) {
  if (!body || typeof body !== "object") return {};
  return mergeBrowserPageRefs(
    browserPageRefFromValue(body),
    browserPageRefFromValue(body.page_ref),
    browserPageRefFromValue(body.page),
    browserPageRefFromValue(body.page_context),
    browserPageRefFromValue(body.context?.page),
    browserPageRefFromValue(body.context?.browser_page),
    browserPageRefFromValue(body.evidence),
    browserPageRefFromValue(body.screen),
    browserPageRefFromValue(body.context?.screen),
  );
}

function browserPageRefFromValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return sanitizeBrowserPageRef({
    url: value.url || value.href || value.page_url || value.pageUrl || "",
    title: value.title || value.page_title || value.pageTitle || "",
    origin: value.origin || "",
  });
}

function mergeBrowserPageRefs(...refs) {
  const merged = { url: "", title: "", origin: "" };
  for (const ref of refs) {
    const safe = sanitizeBrowserPageRef(ref);
    if (!merged.url && safe.url) merged.url = safe.url;
    if (!merged.title && safe.title) merged.title = safe.title;
    if (!merged.origin && safe.origin) merged.origin = safe.origin;
  }
  if (!merged.origin && merged.url) merged.origin = browserOriginFromUrl(merged.url);
  return sanitizeBrowserPageRef(merged);
}

function sanitizeBrowserPageRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const url = truncate(String(value.url || "").trim(), 1000);
  const origin = truncate(String(value.origin || "").trim() || browserOriginFromUrl(url), 300);
  const title = truncate(String(value.title || "").replace(/\s+/g, " ").trim(), 300);
  return { url, title, origin };
}

function browserOriginFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

function compactVisibleTextSummary(value) {
  const text = normalizeWhitespace(value);
  return text ? truncate(text, 700) : "No visible text summary was provided.";
}

function sanitizeBrowserClientMetadata(client) {
  if (!client || typeof client !== "object" || Array.isArray(client)) return {};
  const out = {};
  for (const key of ["id", "client_id", "platform", "source", "version", "tab_id", "window_id", "owner_id", "device_id"]) {
    if (client[key] != null) out[key] = truncate(String(client[key]), 200);
  }
  return out;
}

function sanitizeBrowserIdList(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  const ids = [];
  for (const item of list) {
    const safe = sanitizeLooseId(item);
    if (safe && !ids.includes(safe)) ids.push(safe);
  }
  return ids.slice(0, 50);
}

function browserRouteRef(value) {
  return truncate(String(value || "").replace(/[^a-zA-Z0-9_.:-]/g, ""), 200);
}

function browserTurnStatusUrl(id) {
  const safe = sanitizeLooseId(id) || "browserturn";
  return `/v1/browser/turns/${encodeURIComponent(safe)}/status`;
}

module.exports = {
  browserEvidenceSummaryFromBody,
  browserEvidenceSummaryFromValue,
  browserOriginFromUrl,
  browserPageRefFromBody,
  browserPageRefFromValue,
  browserRouteRef,
  browserTurnStatusUrl,
  browserVisibleTextFromValue,
  compactVisibleTextSummary,
  emptyBrowserEvidenceSummary,
  mergeBrowserEvidenceSummaries,
  mergeBrowserPageRefs,
  normalizeWhitespace,
  sanitizeBrowserClientMetadata,
  sanitizeBrowserIdList,
  sanitizeBrowserPageRef,
};
