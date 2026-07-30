import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createBrowserInjectedToolRuntime } from "../extension/browser-injected-tool-runtime.js";

function storageArea(seed = {}) {
  const state = structuredClone(seed);
  return {
    state,
    async get(defaults) { return { ...structuredClone(defaults), ...structuredClone(state) }; },
    async set(values) { Object.assign(state, structuredClone(values)); },
  };
}

const storage = storageArea({ ageeDelegatedUserScriptsEnabled: true });
const calls = [];
const chromeApi = {
  storage: { local: storage },
  runtime: { getManifest: () => ({ permissions: ["userScripts"] }) },
  permissions: { contains: async () => true },
  tabs: {
    query: async () => [{ id: 7, url: "https://shop.example.test/products?q=desk" }],
    get: async () => ({ id: 7, url: "https://shop.example.test/products?q=desk" }),
  },
  scripting: { executeScript: async () => [{ documentId: "doc-7" }] },
  userScripts: {
    getScripts: async () => [], register: async () => {}, update: async () => {}, unregister: async () => {},
    execute: async (request) => { calls.push(request); return [{ frameId: 0, result: { count: 2 } }]; },
  },
};
const runtime = createBrowserInjectedToolRuntime({ chromeApi, subtle: webcrypto.subtle, now: () => new Date("2026-07-29T12:00:00Z") });

await runtime.save({
  schema: "moa.browser-injected-tool.v1",
  name: "extract_prices",
  description: "Extract visible product prices from the current page.",
  effect: "read",
  matches: ["https://shop.example.test/*"],
  input_schema: {
    type: "object",
    properties: { currency: { type: "string", maxLength: 3 } },
    required: ["currency"],
    additionalProperties: false,
  },
  source: "async (input) => ({ currency: input.currency, count: document.querySelectorAll('.price').length })",
});

assert.deepEqual((await runtime.manifest()).map((entry) => entry.tool), ["browser.injected.extract_prices"]);
const executed = await runtime.execute("browser.injected.extract_prices", { arguments: { currency: "USD" } });
assert.equal(executed.ok, true);
assert.deepEqual(executed.result, { count: 2 });
assert.equal(executed.local_receipt.source_sha256.startsWith("sha256:"), true);
assert.equal(executed.local_receipt.input_sha256.startsWith("sha256:"), true);
assert.equal(executed.local_receipt.page_url_sha256.startsWith("sha256:"), true);
assert.equal("page_url" in executed.local_receipt, false);
assert.equal(calls[0].world, "USER_SCRIPT");
assert.match(calls[0].js[0].code, /"currency":"USD"/);
await assert.rejects(() => runtime.execute("browser.injected.extract_prices", { arguments: { currency: "TOOLONG" } }), /tool_arguments_invalid/);
await assert.rejects(() => runtime.save({ schema: "moa.browser-injected-tool.v1", name: "bad", description: "bad", effect: "read", matches: ["https://*.example.test/*"], source: "(input) => input" }), /match_host_must_be_exact/);
await assert.rejects(() => runtime.save({ schema: "moa.browser-injected-tool.v1", name: "change_page", description: "Change the page.", effect: "page_change", matches: ["https://shop.example.test/*"], source: "(input) => input" }), /requires_checkpoint_runtime/);

storage.state.ageeDelegatedUserScriptsEnabled = false;
assert.deepEqual(await runtime.manifest(), []);
await assert.rejects(() => runtime.execute("browser.injected.extract_prices", { arguments: { currency: "USD" } }), /runtime_disabled/);

console.log("browser injected tool runtime tests passed");
