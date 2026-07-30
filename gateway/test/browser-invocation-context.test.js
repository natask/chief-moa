"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BROWSER_INVOCATION_CONTEXT_SCHEMA,
  browserInvocationContextPrompt,
  sanitizeBrowserInvocationContext,
} = require("../lib/browser-invocation-context");

function context(url = "https://tasks.example.test/project/7") {
  return {
    schema: BROWSER_INVOCATION_CONTEXT_SCHEMA,
    input: "voice",
    tab_id: 42,
    captured_at: "2026-07-29T18:00:00.000Z",
    page: { url, title: "Project seven", origin: "https://forged.test", snapshot_id: "snap-b", viewport: { width: 1200, height: 800, scrollY: 50 } },
    snapshot: {
      snapshot_id: "snap-b",
      url,
      title: "Project seven",
      page_text: "Task A\nTask B",
      document_context: { scope: "whole_rendered_document", coverage: "complete", complete: true, truncated: false, canvas_count: 0 },
      elements: [{ i: 1, tag: "button", type: "submit", label: "Finish", onclick: "steal()", cookies: "secret" }],
      element_summaries: ["[1] <button submit> Finish"],
      viewport: { width: 1200, height: 800, deviceScaleFactor: 2, scrollX: 0, scrollY: 50 },
      captured_at: "2026-07-29T18:00:00.000Z",
    },
    actions: [{ type: "click" }],
    authority: "admin",
  };
}

test("sanitizes and digest-binds browser invocation evidence without action authority", () => {
  const sanitized = sanitizeBrowserInvocationContext(context());
  assert.equal(sanitized.schema, BROWSER_INVOCATION_CONTEXT_SCHEMA);
  assert.equal(sanitized.page.origin, "https://tasks.example.test");
  assert.equal(sanitized.snapshot.elements[0].label, "Finish");
  assert.equal("onclick" in sanitized.snapshot.elements[0], false);
  assert.equal("actions" in sanitized, false);
  assert.equal(sanitized.trust, "untrusted_evidence");
  assert.equal(sanitized.executable, false);
  assert.match(sanitized.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(sanitized.snapshot), true);
  assert.equal(Object.isFrozen(sanitized.snapshot.elements[0]), true);
});

test("bounds malformed context and produces a model-facing evidence block", () => {
  const raw = context();
  raw.snapshot.page_text = "x".repeat(25_000);
  raw.snapshot.elements = Array.from({ length: 130 }, (_, i) => ({ i, tag: "button", label: `item ${i}` }));
  raw.snapshot.element_summaries = Array.from({ length: 130 }, (_, i) => `item ${i}`);
  raw.snapshot.viewport = { width: Infinity, height: -Infinity, scrollY: 99_999_999 };
  const sanitized = sanitizeBrowserInvocationContext(raw);
  assert.equal(sanitized.snapshot.page_text.length, 20_003);
  assert.equal(sanitized.snapshot.elements.length, 100);
  assert.equal(sanitized.snapshot.element_summaries.length, 100);
  assert.equal(sanitized.snapshot.viewport.width, null);
  assert.equal(sanitized.snapshot.viewport.scrollY, 10_000_000);
  const prompt = browserInvocationContextPrompt(sanitized);
  assert.match(prompt, /captured when this exact message was submitted/);
  assert.match(prompt, /untrusted evidence/);
  assert.match(prompt, /Project seven/);
  assert.match(prompt, /Task A|x{20}/);
});

test("rejects wrong schemas and changes the digest when the captured page changes", () => {
  assert.equal(sanitizeBrowserInvocationContext(null), null);
  assert.equal(sanitizeBrowserInvocationContext({ schema: "wrong" }), null);
  const pageB = sanitizeBrowserInvocationContext(context("https://tasks.example.test/b"));
  const pageC = sanitizeBrowserInvocationContext(context("https://tasks.example.test/c"));
  assert.notEqual(pageB.digest, pageC.digest);
});
