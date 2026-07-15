"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
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
} = require("../lib/browser-evidence");
const { screenNodeLabel } = require("../lib/input-utils");

test("browser evidence is bounded context and never gains execution fields", () => {
  const summary = browserEvidenceSummaryFromBody({
    page: { url: "https://example.com/path", title: "  Example   Page " },
    screen: {
      nodes: [{ text: " Submit " }, { description: "Account menu" }],
      actions: [{ type: "click", selector: "#submit" }],
      cookies: "secret",
    },
  });
  assert.deepEqual(summary.page_ref, {
    url: "https://example.com/path",
    title: "Example Page",
    origin: "https://example.com",
  });
  assert.equal(summary.visible_text, "Submit Account menu");
  assert.equal("actions" in summary, false);
  assert.equal("cookies" in summary, false);
});

test("browser evidence merges deterministically and caps visible text", () => {
  const merged = mergeBrowserEvidenceSummaries(
    browserEvidenceSummaryFromValue({ url: "https://example.com/a", visible_text: "first", id: "one" }),
    browserEvidenceSummaryFromValue({ title: "Title", visible_text: "x".repeat(21_000), id: "two" }),
  );
  assert.equal(merged.page_ref.url, "https://example.com/a");
  assert.equal(merged.page_ref.title, "Title");
  assert.equal(merged.source_ref, "one");
  assert.equal(merged.visible_text.length, 20_003);
  assert.match(merged.visible_text, /\.\.\.$/);
});

test("browser page references preserve first fields and fill a missing origin", () => {
  assert.deepEqual(
    mergeBrowserPageRefs(
      { url: "not a URL", title: "first" },
      { url: "https://ignored.example/path", title: "second" },
    ),
    { url: "not a URL", title: "first", origin: "https://ignored.example" },
  );
});

test("browser identifiers and client metadata are allowlisted and bounded", () => {
  assert.deepEqual(sanitizeBrowserIdList(["good-id", "bad/id", "good-id", "", "also.ok"]), ["good-id", "badid", "alsook"]);
  assert.equal(browserRouteRef("route:one/../../$(bad)"), "route:one....bad");
  assert.equal(browserTurnStatusUrl("../turn one"), "/v1/browser/turns/turnone/status");
  assert.deepEqual(sanitizeBrowserClientMetadata({ platform: "browser", token: "secret", tab_id: 7 }), {
    platform: "browser",
    tab_id: "7",
  });
});

test("browser evidence accepts legacy aliases and primitive evidence safely", () => {
  const summary = browserEvidenceSummaryFromBody({
    visibleText: " top   level ",
    pageUrl: "https://example.com/legacy",
    pageTitle: "Legacy",
    evidence_summary: " string evidence ",
  });
  assert.equal(summary.visible_text, "top level string evidence");
  assert.equal(summary.page_ref.url, "https://example.com/legacy");
  assert.equal(browserEvidenceSummaryFromValue(7).visible_text, "");
  assert.equal(browserEvidenceSummaryFromValue(null).visible_text, "");
  assert.deepEqual(browserPageRefFromBody(null), {});
  assert.deepEqual(browserPageRefFromValue([]), {});
});

test("browser text extraction covers direct arrays, headings, and bounded node labels", () => {
  const text = browserVisibleTextFromValue({
    text: ["one", "two"],
    headings: ["Heading", { label: "Subheading" }, { text: "Details" }],
    nodes: [{ view_id: "submit_button" }, null, { text: "x".repeat(200) }],
  });
  assert.match(text, /^one\ntwo\nsubmit_button\n/);
  assert.match(text, /Heading\nSubheading\nDetails$/);
  assert.equal(screenNodeLabel(null), "");
  assert.equal(screenNodeLabel({}), "");
  assert.equal(screenNodeLabel({ text: "x".repeat(200) }).length, 143);
  assert.equal(browserVisibleTextFromValue("not an object"), "");
});

test("browser evidence sanitizers cover empty, invalid, and bounded values", () => {
  assert.equal(browserOriginFromUrl(""), "");
  assert.equal(browserOriginFromUrl("not a url"), "");
  assert.equal(compactVisibleTextSummary(""), "No visible text summary was provided.");
  assert.equal(compactVisibleTextSummary("x".repeat(800)).length, 703);
  assert.equal(normalizeWhitespace(null), "");
  assert.deepEqual(emptyBrowserEvidenceSummary(), {
    page_ref: { url: "", title: "", origin: "" },
    visible_text: "",
    source_ref: "",
    source_kind: "",
    context_scope: "",
    context_coverage: "",
    context_complete: null,
    context_truncated: false,
    source_parts_total: null,
    source_parts_included: null,
  });
  assert.deepEqual(sanitizeBrowserPageRef(null), {});
  assert.deepEqual(sanitizeBrowserClientMetadata([]), {});
  assert.equal(browserTurnStatusUrl(""), "/v1/browser/turns/browserturn/status");
  assert.equal(browserRouteRef("x".repeat(250)).length, 203);
});

test("evidence merging ignores malformed inputs and keeps first provenance", () => {
  const merged = mergeBrowserEvidenceSummaries(
    null,
    "invalid",
    { source_ref: "first", source_kind: "screen" },
    { source_ref: "second", source_kind: "page", visible_text: "evidence" },
  );
  assert.equal(merged.source_ref, "first");
  assert.equal(merged.source_kind, "screen");
  assert.equal(merged.visible_text, "evidence");
});

test("browser snapshot evidence preserves whole-document coverage metadata and removes duplicate fallback text", () => {
  const summary = browserEvidenceSummaryFromBody({
    snapshot: {
      page_text: "top middle bottom",
      document_context: {
        scope: "whole_rendered_document",
        coverage: "distributed_sample",
        complete: false,
        truncated: true,
        source_parts_total: 500,
        source_parts_included: 100,
      },
    },
    screen: { summary: "top middle bottom" },
  });
  assert.equal(summary.visible_text, "top middle bottom");
  assert.equal(summary.context_scope, "whole_rendered_document");
  assert.equal(summary.context_coverage, "distributed_sample");
  assert.equal(summary.context_complete, false);
  assert.equal(summary.context_truncated, true);
  assert.equal(summary.source_parts_total, 500);
  assert.equal(summary.source_parts_included, 100);
});

test("document-context metadata rejects invalid counts and merges conservative coverage", () => {
  const complete = browserEvidenceSummaryFromValue({
    visible_text: "middle",
    documentContext: {
      scope: "whole_rendered_document",
      coverage: "complete",
      complete: true,
      truncated: false,
      source_parts_total: "3",
      source_parts_included: null,
    },
  });
  assert.equal(complete.context_complete, true);
  assert.equal(complete.context_truncated, false);
  assert.equal(complete.source_parts_total, 3);
  assert.equal(complete.source_parts_included, null);

  const partial = browserEvidenceSummaryFromValue({
    visible_text: "top middle bottom",
    document_context: {
      complete: false,
      truncated: true,
      source_parts_total: -1,
      source_parts_included: 1.5,
    },
  });
  const merged = mergeBrowserEvidenceSummaries(complete, partial, browserEvidenceSummaryFromValue({ document_context: [] }));
  assert.equal(merged.visible_text, "top middle bottom");
  assert.equal(merged.context_complete, false);
  assert.equal(merged.context_truncated, true);
  assert.equal(merged.source_parts_total, 3);
  assert.equal(merged.source_parts_included, null);

  const unknown = browserEvidenceSummaryFromValue({ document_context: { complete: "yes" } });
  assert.equal(unknown.context_complete, null);
});

test("an empty rendered document retains complete zero-part coverage metadata", () => {
  const summary = browserEvidenceSummaryFromBody({
    snapshot: {
      page_text: "",
      document_context: {
        scope: "whole_rendered_document",
        coverage: "complete",
        complete: true,
        truncated: false,
        source_parts_total: 0,
        source_parts_included: 0,
      },
    },
  });
  assert.equal(summary.visible_text, "");
  assert.equal(summary.context_scope, "whole_rendered_document");
  assert.equal(summary.context_complete, true);
  assert.equal(summary.source_parts_total, 0);
  assert.equal(summary.source_parts_included, 0);
});
