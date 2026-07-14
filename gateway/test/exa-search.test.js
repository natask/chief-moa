"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createExaSearchTool, searchExa } = require("../lib/exa-search");

test("Exa fallback is absent without a gateway key", () => {
  assert.equal(createExaSearchTool({ env: {} }), null);
});

test("Exa fallback sends a bounded query and normalizes safe results", async () => {
  let request;
  const result = await searchExa({ query: ` current voice news ${"x".repeat(700)}`, num_results: 99 }, {
    env: { EXA_API_KEY: "secret-test-key", EXA_SEARCH_TIMEOUT_MS: "1000" },
    fetch: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return response(200, {
        results: [
          { title: "Useful result", url: "https://example.test/news", publishedDate: "2026-07-13", highlights: ["A useful current fact."] },
          { title: "Unsafe result", url: "javascript:alert(1)", highlights: ["drop me"] },
        ],
      });
    },
  });

  assert.equal(request.url, "https://api.exa.ai/search");
  assert.equal(request.options.headers["x-api-key"], "secret-test-key");
  assert.equal(request.body.query.length, 500);
  assert.equal(request.body.numResults, 8);
  assert.equal(request.body.type, "instant");
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, [{
    title: "Useful result",
    url: "https://example.test/news",
    published_at: "2026-07-13",
    author: "",
    highlights: ["A useful current fact."],
  }]);
  assert.doesNotMatch(JSON.stringify(result), /secret-test-key/);
});

test("Exa fallback reports provider errors without returning provider bodies", async () => {
  const result = await searchExa({ query: "test" }, {
    env: { EXA_API_KEY: "secret-test-key" },
    fetch: async () => response(429, { error: "sensitive upstream detail" }),
  });
  assert.deepEqual(result, { ok: false, status: "provider_error", error: "Exa search failed (429)" });
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}
