import assert from "node:assert/strict";
import test from "node:test";
import {
  browserAutomationToolManifest,
  browserLocalToolManifest,
  boundedTabId,
  filterSnapshotElements,
  normalizePageToolRequest,
  normalizeSearchRequest,
} from "../extension/browser-automation-contract.js";

test("first-party browser automation manifest exposes coherent page and search tools", () => {
  const manifest = browserAutomationToolManifest();
  assert.equal(manifest.length, 12);
  assert.ok(manifest.some((entry) => entry.tool === "browser.search.open" && entry.risk === "navigation"));
  assert.ok(manifest.some((entry) => entry.tool === "browser.page.click" && entry.approval === "target_app_confirmation"));
  assert.ok(manifest.some((entry) => entry.tool === "browser.page.snapshot" && entry.risk === "read_only"));
  assert.equal(browserLocalToolManifest().length, 22);
  assert.ok(browserLocalToolManifest().some((entry) => entry.tool === "browser.tab.close"));
  assert.ok(browserLocalToolManifest().some((entry) => entry.tool === "browser.permissions.status"));
  assert.ok(browserLocalToolManifest().some((entry) => entry.tool === "browser.page.network"));
});

test("search requests compile descriptions into bounded Google and Amazon URLs", () => {
  assert.equal(normalizeSearchRequest({ query: "ergonomic red chair", provider: "amazon" }).url,
    "https://www.amazon.com/s?k=ergonomic+red+chair");
  assert.equal(normalizeSearchRequest({ text: "chief moa", site: "web", active: false }).url,
    "https://www.google.com/search?q=chief+moa");
  assert.equal(normalizeSearchRequest({ query: "chair", provider: "amazon" }).provider, "amazon");
  assert.throws(() => normalizeSearchRequest({ query: "" }), /requires a query/);
  assert.throws(() => normalizeSearchRequest({ query: "chair", provider: "unknown" }), /unsupported search provider/);
});

test("page tool requests reject unbounded actions and normalize reads", () => {
  assert.deepEqual(normalizePageToolRequest("browser.page.click", { tab_id: 7, index: 3 }),
    { tabId: 7, index: 3, action: "click" });
  assert.deepEqual(normalizePageToolRequest("browser.page.fill", { tabId: 7, index: 2, value: "desk" }),
    { tabId: 7, index: 2, action: "type", text: "desk" });
  assert.deepEqual(normalizePageToolRequest("browser.page.query_elements", { query: "Buy", limit: 500 }),
    { tabId: null, locator: { query: "buy" }, limit: 100 });
  assert.deepEqual(normalizePageToolRequest("browser.page.wait", { text: "results", timeout: 90_000 }),
    { tabId: null, locator: { query: "results" }, timeoutMs: 30_000 });
  assert.deepEqual(normalizePageToolRequest("browser.page.click", { tabId: 7, role: "button", name: "Buy now" }),
    { tabId: 7, index: null, locator: { role: "button", name: "buy now" }, action: "click" });
  assert.equal(boundedTabId("12"), 12);
  assert.equal(boundedTabId(-1), null);
  assert.throws(() => normalizePageToolRequest("browser.page.click", { index: 100 }), /0 to 99/);
  assert.throws(() => normalizePageToolRequest("browser.page.click", {}), /index or semantic locator/);
  assert.throws(() => normalizePageToolRequest("browser.page.fill", { index: 1, value: "x".repeat(2001) }), /exceeds/);
});

test("snapshot element filtering stays bounded and deterministic", () => {
  const snapshot = { elements: [
    { i: 0, tag: "a", type: "", label: "Product details" },
    { i: 1, tag: "button", type: "submit", role: "button", label: "Buy now", test_id: "checkout" },
    { i: 2, tag: "input", type: "search", role: "searchbox", label: "Search Amazon" },
  ] };
  assert.deepEqual(filterSnapshotElements(snapshot, "buy", 10), [snapshot.elements[1]]);
  assert.deepEqual(filterSnapshotElements(snapshot, "", 2), snapshot.elements.slice(0, 2));
  assert.deepEqual(filterSnapshotElements(snapshot, { role: "button", testId: "checkout" }, 10), [snapshot.elements[1]]);
});
