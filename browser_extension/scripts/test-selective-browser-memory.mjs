import assert from "node:assert/strict";
import {
  BROWSER_MEMORY_LIMIT,
  BROWSER_MEMORY_TTL_MS,
  boundedText,
  canonicalPageUrl,
  mergeMemoryEntries,
  normalizeMemoryCandidate,
} from "../extension/selective-browser-memory.js";

assert.equal(canonicalPageUrl("https://example.com/work?q=secret#private"), "https://example.com/work");
assert.equal(canonicalPageUrl("chrome://settings"), "");
assert.equal(canonicalPageUrl("https://user:secret@example.com/"), "");
assert.equal(boundedText("  useful\n  page\u0000 ", 20), "useful page");
assert.equal(normalizeMemoryCandidate({ url: "https://example.com", suppressed: true }), null);
assert.equal(normalizeMemoryCandidate({ url: "https://example.com" }), null);

const now = 2_000_000_000_000;
const candidate = normalizeMemoryCandidate({
  url: "https://example.com/article?token=drop-me",
  title: "A useful article",
  heading: "The important idea",
  summary: "A short publisher-provided description.",
  page_kind: "document",
}, now);
assert.equal(candidate.url, "https://example.com/article");
assert.equal(candidate.site, "example.com");
assert.equal(candidate.page_kind, "document");

let entries = mergeMemoryEntries([], candidate, { nowMs: now });
assert.equal(entries.length, 1);
entries = mergeMemoryEntries(entries, candidate, { nowMs: now + 1000 });
assert.equal(entries.length, 1);
assert.equal(entries[0].visit_count, 2);

const expired = { ...entries[0], first_seen_at: now - BROWSER_MEMORY_TTL_MS - 1, last_seen_at: now - BROWSER_MEMORY_TTL_MS - 1 };
assert.deepEqual(mergeMemoryEntries([expired], null, { nowMs: now }), []);

const many = [];
for (let index = 0; index < BROWSER_MEMORY_LIMIT + 5; index += 1) {
  const item = normalizeMemoryCandidate({ url: `https://example.com/${index}`, title: `Page ${index}` }, now + index);
  many.push(item);
}
const capped = mergeMemoryEntries(many, null, { nowMs: now + BROWSER_MEMORY_LIMIT + 5 });
assert.equal(capped.length, BROWSER_MEMORY_LIMIT);
assert.equal(capped[0].title, `Page ${BROWSER_MEMORY_LIMIT + 4}`);

console.log("selective browser memory unit checks passed");
