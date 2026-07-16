"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RESEARCH_LENSES,
  deriveSubQueries,
  runResearch,
} = require("../lib/research-workflow");

test("deriveSubQueries normalizes input and clamps the pass count", () => {
  assert.deepEqual(deriveSubQueries("  compare\n worker   models  ", 2), [
    {
      lens_id: "current_state",
      sub_query: "compare worker models — current state and how it works today",
      angle: "current state and how it works today",
    },
    {
      lens_id: "options",
      sub_query: "compare worker models — the main options, tools, or approaches and how they compare",
      angle: "the main options, tools, or approaches and how they compare",
    },
  ]);
  assert.equal(deriveSubQueries("query", 0).length, 1);
  assert.equal(deriveSubQueries("query", -10).length, 1);
  assert.equal(deriveSubQueries("query", 100).length, RESEARCH_LENSES.length);
  assert.equal(deriveSubQueries("query", "not-a-number").length, RESEARCH_LENSES.length);
});

test("runResearch requires a query and accepts the transcript alias", async () => {
  await assert.rejects(runResearch(), /research query is required/);

  const report = await runResearch({
    transcript: "  investigate\nthis  ",
    maxPasses: 1,
    conversation_id: 42,
  }, {
    idFactory: () => "research_alias",
    now: "2026-07-15T00:00:00.000Z",
  });

  assert.equal(report.id, "research_alias");
  assert.equal(report.query, "investigate this");
  assert.equal(report.session_id, "42");
  assert.equal(report.pass_count, 1);
  assert.equal(report.runner_used, false);
  assert.match(report.recommendation, /structured scaffold/);
  assert.match(report.report_markdown, /Generated 2026-07-15T00:00:00.000Z/);
});

test("runResearch combines search and runner sources and renders them once", async () => {
  const sharedObject = { title: "shared", url: "https://example.test/shared" };
  const report = await runResearch({
    text: "source comparison",
    context: "x".repeat(9000),
    max_passes: 2,
    source: "unit-test",
    session_id: "session-1",
    branch_id: "branch-1",
    broker_event_id: "event-1",
    route_decision_id: "route-1",
  }, {
    idFactory: () => "research_sources",
    now: "2026-07-15T01:00:00.000Z",
    search: async (_subQuery, options) => {
      assert.equal(options.context.length, 8003);
      return ["https://example.test/search", null, sharedObject];
    },
    runPass: async (_prompt, options) => {
      if (options.refine) return { output: "Use the sourced option." };
      if (options.lens_id === "current_state") {
        return { output: "Current finding", sources: [sharedObject, "https://example.test/direct"] };
      }
      return { text: "Option finding", sources: [] };
    },
  });

  assert.equal(report.source, "unit-test");
  assert.equal(report.session_id, "session-1");
  assert.equal(report.branch_id, "branch-1");
  assert.equal(report.broker_event_id, "event-1");
  assert.equal(report.route_decision_id, "route-1");
  assert.equal(report.recommendation, "Use the sourced option.");
  assert.equal(report.runner_used, true);
  assert.deepEqual(report.sources, [
    sharedObject,
    "https://example.test/direct",
    "https://example.test/search",
  ]);
  assert.match(report.report_markdown, /\{"title":"shared","url":"https:\/\/example\.test\/shared"\}/);
  assert.match(report.report_markdown, /## All sources/);
});

test("runResearch falls back when search and model runners fail", async () => {
  const report = await runResearch({ query: "failure handling", max_passes: 1 }, {
    idFactory: () => "research_failures",
    search: async () => {
      throw new Error("search unavailable");
    },
    runPass: async () => {
      throw new Error("model unavailable");
    },
  });

  assert.equal(report.passes[0].sources.length, 0);
  assert.match(report.passes[0].findings, /no live source was consulted/);
  assert.match(report.recommendation, /No model\/search runner was available/);
});

test("runResearch replaces empty runner findings and ignores invalid search output", async () => {
  let calls = 0;
  const report = await runResearch({ query: "empty outputs", max_passes: 1 }, {
    search: async () => ({ invalid: true }),
    runPass: async (_prompt, options) => {
      calls += 1;
      return options.refine ? { text: "" } : { output: "   ", __fallback: true };
    },
  });

  assert.equal(calls, 2);
  assert.match(report.passes[0].findings, /structured placeholder/);
  assert.equal(report.passes[0].used_runner, false);
  assert.match(report.recommendation, /structured scaffold/);
  assert.match(report.id, /^research_[a-z0-9]+$/);
  assert.equal(report.source, "broker-research");
  assert.equal(report.session_id, "");
});

test("runResearch truncates runner output and caps merged sources", async () => {
  const searchSources = Array.from({ length: 12 }, (_, index) => `search-${index}`);
  const report = await runResearch({ query: "bounded output", max_passes: 4 }, {
    search: async () => searchSources,
    runPass: async (_prompt, options) => {
      if (options.refine) return { text: "r".repeat(9000) };
      return {
        text: "f".repeat(9000),
        sources: Array.from({ length: 10 }, (_, index) => `${options.lens_id}-${index}`),
      };
    },
  });

  assert.equal(report.passes[0].findings.length, 8003);
  assert.equal(report.recommendation.length, 8003);
  assert.equal(report.sources.length, 30);
});
