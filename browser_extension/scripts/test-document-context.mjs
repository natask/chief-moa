import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const context = vm.createContext({});
vm.runInContext(readFileSync("extension/document-context.js", "utf8"), context, { filename: "document-context.js" });
const { buildDocumentContext } = context.AgeeDocumentContextPolicy;

test("whole-document context preserves complete rendered text", () => {
  const result = buildDocumentContext(["top marker", "middle marker", "bottom marker"]);
  assert.equal(result.text, "top marker\nmiddle marker\nbottom marker");
  assert.equal(result.metadata.scope, "whole_rendered_document");
  assert.equal(result.metadata.coverage, "complete");
  assert.equal(result.metadata.complete, true);
  assert.equal(result.metadata.truncated, false);
  assert.equal(result.metadata.first_source_part, 0);
  assert.equal(result.metadata.last_source_part, 2);
});

test("oversized context is a distributed sample that retains both ends", () => {
  const parts = Array.from({ length: 500 }, (_, index) => `part-${String(index).padStart(3, "0")}-${"x".repeat(180)}`);
  const result = buildDocumentContext(parts, { maxChars: 4_000, maxParts: 40 });
  assert.equal(result.metadata.coverage, "distributed_sample");
  assert.equal(result.metadata.complete, false);
  assert.equal(result.metadata.truncated, true);
  assert.equal(result.metadata.first_source_part, 0);
  assert.equal(result.metadata.last_source_part, 499);
  assert.match(result.text, /part-000/);
  assert.match(result.text, /part-499/);
  assert.ok(result.text.length <= 4_000);
  assert.ok(result.metadata.source_parts_included <= 40);
});

test("context normalizes duplicates and control characters", () => {
  const result = buildDocumentContext([" same\ttext ", "same text", "\u0000safe"]);
  assert.equal(result.text, "same text\nsafe");
  assert.equal(result.metadata.source_parts_total, 2);
});
