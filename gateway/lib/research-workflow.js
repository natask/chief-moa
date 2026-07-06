"use strict";

// Research workflow engine for the message broker (task 4.3).
//
// When the broker selects the research workflow, this engine fans a single
// research query out into several focused sub-queries ("lenses"), runs one
// pass per sub-query (a search pass and/or a model pass), then runs one refine
// pass that synthesizes the collected findings into a report with a
// recommendation.
//
// The engine is pure and deterministic by default: with no injected runners it
// produces a stable, provider-free report, so it can be smoke-tested with no
// network and no model key. The gateway injects a real `runPass` (a bounded
// model call) and, when available, a `search` runner; either falls back to the
// deterministic path on error. Output is a proposal/report, never an executable
// command.

const RESEARCH_LENSES = Object.freeze([
  { id: "current_state", angle: "current state and how it works today" },
  { id: "options", angle: "the main options, tools, or approaches and how they compare" },
  { id: "tradeoffs", angle: "tradeoffs, risks, costs, and constraints" },
  { id: "recommendation", angle: "the most optimal path and its implementation implications" },
]);

const DEFAULT_MAX_PASSES = 4;

function normalizeQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function deriveSubQueries(query, maxPasses) {
  const base = normalizeQuery(query);
  const count = clampInt(maxPasses, 1, RESEARCH_LENSES.length, DEFAULT_MAX_PASSES);
  return RESEARCH_LENSES.slice(0, count).map((lens) => ({
    lens_id: lens.id,
    sub_query: `${base} — ${lens.angle}`,
    angle: lens.angle,
  }));
}

// Deterministic fallback pass. It never calls a provider; it restates the
// sub-query as a bounded finding so a report is always producible offline.
function deterministicPass(subQuery) {
  return {
    text: `On ${subQuery.angle}: no live source was consulted, so this is a structured placeholder derived from the request. A worker with search/model access should replace it with sourced findings.`,
    sources: [],
  };
}

async function runOnePass({ subQuery, query, context, runPass, search }) {
  let sources = [];
  if (typeof search === "function") {
    try {
      const found = await search(subQuery.sub_query, { query, context });
      if (Array.isArray(found)) sources = found.filter(Boolean).slice(0, 10);
    } catch {
      sources = [];
    }
  }
  let result;
  if (typeof runPass === "function") {
    try {
      result = await runPass(subQuery.sub_query, { query, context, sources, lens_id: subQuery.lens_id });
    } catch {
      result = null;
    }
  }
  if (!result) {
    result = deterministicPass(subQuery);
  }
  const text = truncate(String(result.text || result.output || "").trim(), 8000)
    || deterministicPass(subQuery).text;
  const passSources = Array.isArray(result.sources) && result.sources.length
    ? result.sources.filter(Boolean).slice(0, 10)
    : sources;
  return {
    lens_id: subQuery.lens_id,
    sub_query: subQuery.sub_query,
    angle: subQuery.angle,
    findings: text,
    sources: passSources,
    used_runner: typeof runPass === "function" && result && !result.__fallback,
  };
}

function dedupeSources(passes) {
  const seen = new Set();
  const merged = [];
  for (const pass of passes) {
    for (const source of pass.sources || []) {
      const key = typeof source === "string" ? source : JSON.stringify(source);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(source);
      if (merged.length >= 30) return merged;
    }
  }
  return merged;
}

async function refinePass({ query, passes, context, runPass }) {
  const findingsBlock = passes
    .map((pass, index) => `${index + 1}. (${pass.angle}) ${pass.findings}`)
    .join("\n");
  const synthesisPrompt = [
    `Synthesize a single recommendation for: ${query}`,
    "Use only the findings below as evidence. Give the most optimal path and its tradeoffs.",
    "",
    findingsBlock,
  ].join("\n");
  if (typeof runPass === "function") {
    try {
      const result = await runPass(synthesisPrompt, { query, context, refine: true });
      const text = truncate(String(result?.text || result?.output || "").trim(), 8000);
      if (text) return text;
    } catch {
      // fall through to deterministic synthesis
    }
  }
  // Deterministic synthesis: name the lenses covered and defer the sourced
  // recommendation to a worker with model/search access.
  const covered = passes.map((pass) => pass.angle).join("; ");
  return `Synthesis for "${query}": covered ${passes.length} research angle(s) — ${covered}. `
    + "No model/search runner was available, so this report is a structured scaffold. "
    + "Route it to a worker with research access to fill in sourced findings and a final recommendation.";
}

function buildReportMarkdown({ query, passes, recommendation, sources, createdAt }) {
  const lines = [
    `# Research report: ${query}`,
    "",
    `Generated ${createdAt} by the gateway research workflow (fan-out of ${passes.length} pass(es) + 1 refine pass).`,
    "",
    "## Findings by angle",
    "",
  ];
  for (const pass of passes) {
    lines.push(`### ${pass.angle}`);
    lines.push(pass.findings);
    if (pass.sources && pass.sources.length) {
      lines.push("");
      lines.push("Sources:");
      for (const source of pass.sources) {
        lines.push(`- ${typeof source === "string" ? source : JSON.stringify(source)}`);
      }
    }
    lines.push("");
  }
  lines.push("## Recommendation", "", recommendation, "");
  if (sources.length) {
    lines.push("## All sources", "");
    for (const source of sources) {
      lines.push(`- ${typeof source === "string" ? source : JSON.stringify(source)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

// runResearch(request, options) -> report
//   request: { query, context?, session_id?, branch_id?, source?, max_passes? }
//   options: { runPass?, search?, idFactory?, now? }
async function runResearch(request = {}, options = {}) {
  const query = normalizeQuery(request.query || request.text || request.transcript || "");
  if (!query) {
    throw new Error("research query is required");
  }
  const context = truncate(String(request.context || ""), 8000);
  const maxPasses = clampInt(request.max_passes || request.maxPasses, 1, RESEARCH_LENSES.length, DEFAULT_MAX_PASSES);
  const runPass = typeof options.runPass === "function" ? options.runPass : null;
  const search = typeof options.search === "function" ? options.search : null;
  const now = options.now || new Date().toISOString();
  const idFactory = typeof options.idFactory === "function"
    ? options.idFactory
    : () => `research_${Math.random().toString(36).slice(2, 12)}`;

  const subQueries = deriveSubQueries(query, maxPasses);
  const passes = [];
  for (const subQuery of subQueries) {
    passes.push(await runOnePass({ subQuery, query, context, runPass, search }));
  }
  const recommendation = await refinePass({ query, passes, context, runPass });
  const sources = dedupeSources(passes);
  const reportMarkdown = buildReportMarkdown({ query, passes, recommendation, sources, createdAt: now });

  return {
    id: idFactory(),
    kind: "research_report",
    query,
    source: String(request.source || "broker-research"),
    session_id: String(request.session_id || request.conversation_id || ""),
    branch_id: String(request.branch_id || ""),
    broker_event_id: String(request.broker_event_id || ""),
    route_decision_id: String(request.route_decision_id || ""),
    sub_queries: subQueries.map((item) => item.sub_query),
    pass_count: passes.length,
    passes,
    findings: passes.map((pass) => ({ angle: pass.angle, findings: pass.findings, sources: pass.sources })),
    sources,
    recommendation,
    report_markdown: reportMarkdown,
    runner_used: passes.some((pass) => pass.used_runner),
    created_at: now,
  };
}

module.exports = { runResearch, deriveSubQueries, RESEARCH_LENSES };
