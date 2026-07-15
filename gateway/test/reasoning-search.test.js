"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SEARCH_ROUTES,
  resolveReasoningProvider,
  selectReasoningSearch,
  withReasoningSearchTools,
} = require("../lib/reasoning-search");

const ANSWER_ROUTES = [
  SEARCH_ROUTES.CHAT_ANSWER,
  SEARCH_ROUTES.BROWSER_TURN,
  SEARCH_ROUTES.BROWSER_EVIDENCE,
  SEARCH_ROUTES.CASCADED_REASONING,
  SEARCH_ROUTES.BROKER_DIRECT_ANSWER,
  SEARCH_ROUTES.BROKER_RESEARCH,
];

const EXCLUDED_ROUTES = [
  SEARCH_ROUTES.CONTEXT_PREFLIGHT,
  SEARCH_ROUTES.TRANSCRIPTION,
  SEARCH_ROUTES.TTS,
  SEARCH_ROUTES.PROACTIVE,
  SEARCH_ROUTES.PROFILE_CONFIRMATION,
  SEARCH_ROUTES.THREAD_SUMMARY,
  SEARCH_ROUTES.ROUTER,
  SEARCH_ROUTES.UNCLASSIFIED,
];

test("resolved profile provider overrides the boot provider", () => {
  assert.equal(resolveReasoningProvider({ reasoning_provider: "Vertex" }, "openai-compatible"), "vertex");
  assert.equal(resolveReasoningProvider({ reasoning_provider: "openai_compatible" }, "vertex"), "openai-compatible");
  assert.equal(resolveReasoningProvider({ reasoning_provider: "unsupported" }, "vertex"), "vertex");
});

test("ordinary answer route matrix selects native Vertex search", () => {
  for (const route of ANSWER_ROUTES) {
    const plan = selectReasoningSearch({
      route,
      profile: { reasoning_provider: "vertex" },
      defaultProvider: "openai-compatible",
      env: {},
    });
    assert.equal(plan.provider, "vertex", route);
    assert.equal(plan.status, "native", route);
    assert.deepEqual(plan.nativeTool, { googleSearch: {} }, route);
    assert.equal(plan.functionTool, null, route);
  }
});

test("ordinary answer route matrix selects Exa when native search is unavailable", () => {
  for (const [provider, env] of [
    ["openai-compatible", { EXA_API_KEY: "exa-key" }],
    ["vertex", { MODEL_NATIVE_WEB_SEARCH: "0", EXA_API_KEY: "exa-key" }],
  ]) {
    for (const route of ANSWER_ROUTES) {
      const plan = selectReasoningSearch({ route, profile: { reasoning_provider: provider }, env });
      assert.equal(plan.status, "exa_fallback", `${provider}/${route}`);
      assert.equal(plan.nativeTool, null, `${provider}/${route}`);
      assert.equal(plan.functionTool?.name, "web_search", `${provider}/${route}`);
    }
  }
});

test("ordinary answer route matrix reports search unavailable explicitly", () => {
  for (const route of ANSWER_ROUTES) {
    const plan = selectReasoningSearch({ route, profile: { reasoning_provider: "openai-compatible" }, env: {} });
    assert.equal(plan.status, "unavailable", route);
    assert.equal(plan.nativeTool, null, route);
    assert.equal(plan.functionTool, null, route);
  }
});

test("control-plane route matrix remains search-free even with every search backend configured", () => {
  for (const provider of ["vertex", "openai-compatible"]) {
    for (const route of EXCLUDED_ROUTES) {
      const plan = selectReasoningSearch({
        route,
        profile: { reasoning_provider: provider },
        env: { MODEL_NATIVE_WEB_SEARCH: "1", EXA_API_KEY: "exa-key" },
      });
      assert.equal(plan.status, "excluded", `${provider}/${route}`);
      assert.equal(plan.nativeTool, null, `${provider}/${route}`);
      assert.equal(plan.functionTool, null, `${provider}/${route}`);
    }
  }
});

test("fallback tool merge is additive and deduplicated", () => {
  const existing = { name: "existing" };
  const fallback = { name: "web_search" };
  const plan = { functionTool: fallback };
  assert.deepEqual(withReasoningSearchTools([existing], plan), [existing, fallback]);
  assert.deepEqual(withReasoningSearchTools([existing, fallback], plan), [existing, fallback]);
  assert.deepEqual(withReasoningSearchTools(null, { functionTool: null }), []);
});
