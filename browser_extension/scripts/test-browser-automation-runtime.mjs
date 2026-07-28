import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserAutomationRuntime } from "../extension/browser-automation-runtime.js";

function runtimeFixture(options = {}) {
  const created = [];
  const actions = [];
  const page = options.page || {
    title: "Shop",
    pageText: "Product results",
    snapshotId: "snap-1",
    elements: [{ i: 4, tag: "button", role: "button", name: "Buy now", label: "Buy now", test_id: "checkout" }],
  };
  const runtime = createBrowserAutomationRuntime({
    chromeApi: {
      tabs: {
        create: async (input) => (created.push(input), { id: 9, url: input.url, active: input.active }),
        get: async (id) => ({ id, title: "Shop" }),
        update: async (id, input) => ({ id, url: input.url, active: true }),
      },
    },
    allowedUrl: (url) => String(url).startsWith("https://") ? String(url) : "",
    activeTab: async () => ({ id: 3, title: "Shop" }),
    snapshot: async () => page,
    captureScreenshot: async () => "jpeg-data",
    act: async (tabId, request) => (actions.push({ tabId, request }), { result: "clicked Buy now" }),
    screenFromSnapshot: (value) => ({ title: value.title }),
    maxScreenshotChars: 100,
    sleep: async () => {},
  });
  return { runtime, created, actions };
}

test("runtime opens compiled product search without stealing focus", async () => {
  const { runtime, created } = runtimeFixture();
  const receipt = await runtime.execute({
    tool: "browser.search.open",
    input: { query: "ergonomic red chair", provider: "amazon", active: false },
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.result.url, "https://www.amazon.com/s?k=ergonomic+red+chair");
  assert.deepEqual(created, [{ url: receipt.result.url, active: false }]);
});

test("runtime resolves semantic actions locally and returns retryable misses", async () => {
  const { runtime, actions } = runtimeFixture();
  const clicked = await runtime.execute({ tool: "browser.page.click", input: { role: "button", testId: "checkout" } });
  assert.equal(clicked.ok, true);
  assert.deepEqual(actions, [{ tabId: 3, request: { action: "click", index: 4, text: undefined, background: false } }]);

  const missing = await runtime.execute({ tool: "browser.page.click", input: { role: "link", name: "Missing" } });
  assert.equal(missing.ok, false);
  assert.equal(missing.result.retryable, true);
});

test("runtime bounds screenshots and ignores tools owned by the legacy broker", async () => {
  const { runtime } = runtimeFixture();
  assert.equal((await runtime.execute({ tool: "browser.page.screenshot", input: {} })).result.screenshot.encoding, "base64_jpeg");
  assert.equal(await runtime.execute({ tool: "browser.tab.list", input: {} }), null);

  const oversized = runtimeFixture();
  oversized.runtime = createBrowserAutomationRuntime({
    chromeApi: { tabs: { get: async (id) => ({ id }) } },
    activeTab: async () => ({ id: 3 }),
    captureScreenshot: async () => "too-large",
    maxScreenshotChars: 2,
  });
  const receipt = await oversized.runtime.execute({ tool: "browser.page.screenshot", input: {} });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.result.screenshot.encoding, "omitted");
});

test("runtime reports file-scheme permission denial without navigating", async () => {
  const { runtime } = runtimeFixture();
  const denied = createBrowserAutomationRuntime({
    chromeApi: { tabs: { update: async () => assert.fail("navigation must not run") } },
    authorizeUrl: async () => ({
      ok: false,
      error: "file_scheme_access_disabled",
      instruction: "Enable Allow access to file URLs.",
      file_access: { allowed: false },
    }),
    activeTab: async () => ({ id: 3 }),
  });
  const receipt = await denied.execute({ tool: "browser.navigate", input: { url: "file:///tmp/readme.md" } });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error, "file_scheme_access_disabled");
  assert.equal(receipt.summary, "Enable Allow access to file URLs.");
  assert.deepEqual(receipt.result.file_access, { allowed: false });
});
