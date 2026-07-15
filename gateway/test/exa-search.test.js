"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createExaSearchTool, searchExa, normalizeExaResults } = require("../lib/exa-search");

test("Exa fallback is absent without a gateway key", () => {
  assert.equal(createExaSearchTool({ env: {} }), null);
});

test("Exa fallback exposes its schema and delegates through the configured client", async () => {
  let request;
  const tool = createExaSearchTool({
    env: { EXA_API_KEY: " configured-key ", EXA_SEARCH_ENDPOINT: "https://search.example.test/exa" },
    fetch: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return response(200, { results: [] });
    },
  });

  assert.equal(tool.name, "web_search");
  assert.deepEqual(tool.parameters.required, ["query"]);
  assert.equal(tool.parameters.properties.num_results.maximum, 8);
  assert.deepEqual(await tool.handler({ q: " delegated query ", numResults: 2 }), {
    ok: true,
    status: "complete",
    provider: "exa",
    query: "delegated query",
    results: [],
  });
  assert.deepEqual(request, {
    url: "https://search.example.test/exa",
    body: {
      query: "delegated query",
      numResults: 2,
      type: "instant",
      moderation: true,
      contents: { highlights: { maxCharacters: 800 } },
    },
  });
});

test("Exa fallback rejects unavailable and invalid requests before fetching", async () => {
  assert.deepEqual(await searchExa({ query: "anything" }, { env: {} }), {
    ok: false,
    status: "unavailable",
    error: "EXA_API_KEY is not configured on the gateway",
  });
  assert.deepEqual(await searchExa(undefined, { apiKey: "key", env: {} }), {
    ok: false,
    status: "invalid_request",
    error: "query is required",
  });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    assert.deepEqual(await searchExa({ query: "anything" }, { apiKey: "key", env: {} }), {
      ok: false,
      status: "unavailable",
      error: "fetch is unavailable",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Exa fallback clamps low result counts and floors a positive timeout", async () => {
  let requestBody;
  await searchExa({ query: "test", num_results: -10 }, {
    apiKey: "key",
    env: { EXA_SEARCH_TIMEOUT_MS: "10.9" },
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return response(200, {});
    },
  });
  assert.equal(requestBody.numResults, 1);
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

test("Exa fallback rejects successful non-JSON provider output", async () => {
  const result = await searchExa({ query: "test", num_results: "not-an-integer" }, {
    apiKey: "key",
    env: { EXA_SEARCH_TIMEOUT_MS: "invalid" },
    fetch: async () => ({ ok: true, status: 200, text: async () => "not json" }),
  });

  assert.deepEqual(result, {
    ok: false,
    status: "provider_error",
    error: "Exa search returned non-JSON output",
  });
});

test("Exa fallback classifies network errors and bounds their messages", async () => {
  const result = await searchExa({ query: "test" }, {
    apiKey: "key",
    env: {},
    fetch: async () => { throw new Error(`provider secret\n${"x".repeat(400)}`); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "provider_error");
  assert.equal(result.error.length, 300);
  assert.doesNotMatch(result.error, /\n/);
  assert.match(result.error, /…$/);
});

test("Exa fallback aborts a request after the configured timeout", async () => {
  const result = await searchExa({ query: "test" }, {
    apiKey: "key",
    env: { EXA_SEARCH_TIMEOUT_MS: "1" },
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });

  assert.deepEqual(result, {
    ok: false,
    status: "timeout",
    error: "Exa search timed out",
  });
});

test("Exa result normalization filters URLs, supplies titles, and bounds metadata", () => {
  const result = normalizeExaResults({
    results: [
      null,
      { url: "ftp://example.test/file" },
      {
        url: "http://example.test/path",
        title: "",
        publishedDate: `2026-07-15\n${"d".repeat(80)}`,
        author: "a".repeat(180),
        highlights: ["", ` first\n${"h".repeat(900)}`, "second", "third", "fourth"],
      },
      { url: "https://second.example.test", title: "second" },
    ],
  }, { query: "q", numResults: 1 });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, "http://example.test/path");
  assert.equal(result.results[0].published_at.length, 64);
  assert.equal(result.results[0].author.length, 160);
  assert.equal(result.results[0].highlights.length, 3);
  assert.equal(result.results[0].highlights[0].length, 800);
  assert.doesNotMatch(JSON.stringify(result), /\n/);
  assert.deepEqual(normalizeExaResults({}, { query: "empty", numResults: 5 }).results, []);
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}
