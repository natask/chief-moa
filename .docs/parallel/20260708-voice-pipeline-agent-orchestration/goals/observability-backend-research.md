# Goal: observability-backend-research

Branch: read-only
Worktree: current checkout or assigned read-only workspace

## Goal

Recommend a self-hostable observability/log substrate for Chief Moa voice and
agent debugging that avoids Datadog lock-in but still lets agents search logs,
events, traces, and artifacts.

## Research Requirements

- Use current official docs or primary project docs for any external tools.
- Compare at least: OpenTelemetry Collector, Grafana Loki, Grafana Tempo,
  ClickHouse-based options, Better Stack/HyperDX self-hostable stack if
  relevant, and the repo's existing event substrate.
- Prefer a minimal architecture that complements the product event log rather
  than replacing it.

## Acceptance Criteria

- Produce a recommendation with ingestion format, storage, retention, query
  surface, and agent access pattern.
- State what belongs in structured product events versus logs/traces.
- Identify implementation tickets and deployment risks for the VPS.

## Do Not Touch

No file edits.

