"use strict";

const crypto = require("node:crypto");
const { sanitizeLooseId, screenNodeLabel } = require("./input-utils");
const { inspectBoundedBrowserJpeg } = require("./browser-multimodal");

const BROWSER_INLINE_JPEG_MAX_BASE64_CHARS = 420 * 1024;

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
    if (summary.visible_text || summary.source_ref) summaries.push(summary);
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
  return {
    page_ref: browserPageRefFromValue(value),
    visible_text: normalizeWhitespace(browserVisibleTextFromValue(value)),
    source_ref: sourceRef ? truncate(sourceRef, 200) : "",
    source_kind: truncate(String(value.kind || value.type || ""), 80),
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
  const nodes = Array.isArray(value.nodes) ? value.nodes : (Array.isArray(value.elements) ? value.elements : []);
  const nodeText = nodes.map(screenNodeLabel).filter(Boolean).join("\n");
  const elementSummaries = Array.isArray(value.element_summaries)
    ? value.element_summaries.map((item) => String(item || "").trim()).filter(Boolean).join("\n")
    : Array.isArray(value.elementSummaries)
      ? value.elementSummaries.map((item) => String(item || "").trim()).filter(Boolean).join("\n")
      : "";
  const headings = Array.isArray(value.headings)
    ? value.headings.map((item) => typeof item === "string" ? item : String(item?.text || item?.label || "")).filter(Boolean).join("\n")
    : "";
  return [direct.join("\n"), nodeText, elementSummaries, headings].filter(Boolean).join("\n");
}

function mergeBrowserEvidenceSummaries(...summaries) {
  const next = emptyBrowserEvidenceSummary();
  const texts = [];
  for (const summary of summaries) {
    if (!summary || typeof summary !== "object") continue;
    next.page_ref = mergeBrowserPageRefs(next.page_ref, summary.page_ref);
    if (summary.visible_text) texts.push(String(summary.visible_text));
    if (!next.source_ref && summary.source_ref) next.source_ref = String(summary.source_ref);
    if (!next.source_kind && summary.source_kind) next.source_kind = String(summary.source_kind);
  }
  next.visible_text = truncate(normalizeWhitespace(texts.join("\n")), 6000);
  return next;
}

function emptyBrowserEvidenceSummary(pageRef = {}) {
  return { page_ref: sanitizeBrowserPageRef(pageRef), visible_text: "", source_ref: "", source_kind: "" };
}

function browserPageRefFromBody(body) {
  if (!body || typeof body !== "object") return {};
  return mergeBrowserPageRefs(
    browserPageRefFromValue(body),
    browserPageRefFromValue(body.page_ref),
    browserPageRefFromValue(body.page),
    browserPageRefFromValue(body.page_context),
    browserPageRefFromValue(body.snapshot),
    browserPageRefFromValue(body.context?.page),
    browserPageRefFromValue(body.context?.browser_page),
    browserPageRefFromValue(body.evidence),
    browserPageRefFromValue(body.screen),
    browserPageRefFromValue(body.context?.screen),
  );
}

function browserInlineScreenshotFromBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body.screenshot || body.snapshot?.screenshot || body.evidence?.screenshot || null;
}

function sanitizeBrowserInlineScreenshot(value) {
  if (value == null) {
    return {
      audit: { media_type: "image/jpeg", status: "missing", bytes: 0, reason: "no inline JPEG supplied" },
      provider: null,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return omittedInlineScreenshot("invalid screenshot shape");
  }
  if (value.omitted === true || String(value.encoding || "").toLowerCase() === "omitted") {
    return omittedInlineScreenshot(String(value.reason || "screenshot omitted by browser"), Number(value.bytes) || 0);
  }
  const mediaType = String(value.media_type || value.mediaType || value.mime_type || "").toLowerCase();
  if (mediaType !== "image/jpeg") return omittedInlineScreenshot("inline screenshot must be image/jpeg");
  const encoding = String(value.encoding || "base64").toLowerCase();
  if (encoding !== "base64" && encoding !== "base64_jpeg") return omittedInlineScreenshot("unsupported screenshot encoding");
  const data = String(value.data || value.data_base64 || "");
  if (!data || data.length > BROWSER_INLINE_JPEG_MAX_BASE64_CHARS || !canonicalBase64(data)) {
    return omittedInlineScreenshot(data.length > BROWSER_INLINE_JPEG_MAX_BASE64_CHARS
      ? "inline screenshot exceeds the gateway cap"
      : "invalid inline screenshot base64");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    return omittedInlineScreenshot("inline screenshot is not a JPEG", bytes.length);
  }
  const dimensions = inspectBoundedBrowserJpeg(bytes);
  if (!dimensions) {
    return omittedInlineScreenshot("inline screenshot JPEG is invalid", bytes.length);
  }
  const declaredBytes = Number(value.bytes);
  if (Number.isFinite(declaredBytes) && declaredBytes > 0 && declaredBytes !== bytes.length) {
    return omittedInlineScreenshot("inline screenshot byte count does not match", bytes.length);
  }
  const audit = {
    media_type: "image/jpeg",
    status: "available",
    bytes: bytes.length,
    width: dimensions.width,
    height: dimensions.height,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    reason: "",
  };
  return { audit, provider: { mime_type: "image/jpeg", data_base64: data } };
}

function canonicalBase64(value) {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    && Buffer.from(value, "base64").toString("base64") === value;
}

function omittedInlineScreenshot(reason, bytes = 0) {
  return {
    audit: {
      media_type: "image/jpeg",
      status: "omitted",
      bytes: Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0,
      reason: truncate(String(reason || "inline screenshot omitted"), 200),
    },
    provider: null,
  };
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
  browserInlineScreenshotFromBody,
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
  sanitizeBrowserInlineScreenshot,
  sanitizeBrowserIdList,
  sanitizeBrowserPageRef,
};
