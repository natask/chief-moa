# Reference product graph: resolved names and boundaries

Checked: 2026-07-11. This note records current official/vendor and local-repo
evidence; it is not an endorsement, purchase decision, or authorization to copy
code or send Chief Moa data to a third party.

## 1. Software-factory control plane

### Superset — the broader full-product-stack reference

- Local source: `/Users/natnaelkahssay/projs/superset`
- Upstream: <https://github.com/superset-sh/superset>
- Current positioning: source-available terminal/IDE for managing many coding
  agents in parallel, worktree isolation, monitoring, diffs, presets, and
  remote workspaces.
- Controlling local license: Elastic License 2.0. The committed README and root
  package metadata say Apache-2.0, but `LICENSE.md` contains ELv2 and therefore
  controls the checked-out code. Treat it as source-available, not OSI open
  source, and do not infer hosted-service rights from the inconsistent badge.
- YC: Spring 2026: <https://www.ycombinator.com/companies/superset>

Its breadth best matches the remembered “exceptional full-fledged product”
association. The literal open-source clue does not match its controlling
license.

### Emdash — likely the forgotten open-source orchestrator

- Local source: `/Users/natnaelkahssay/projs/emdash`
- Upstream: <https://github.com/generalaction/emdash>
- Current positioning: local-first, provider-agnostic Agentic Development
  Environment; one worktree per agent, ticket handoff, diff/review/PR, CI status,
  and remote projects over SSH.
- License: Apache-2.0.
- YC: Winter 2026: <https://www.ycombinator.com/companies/emdash>

Why the pair matches: both are local, current YC-backed coding-agent
orchestrators and direct product references. Emdash matches the literal
open-source clue; Superset matches the unusually complete company/product stack
clue. The phrase heard as “Asian orchestration” was likely “agent
orchestration.” The recovered answer is therefore the Emdash/Superset pair;
assigning only one side with certainty would overstate the evidence.

Chief Moa boundary: borrow product lessons about workspaces, isolation, agent
attention, review, and status—not their database as Chief Moa's canonical intent
model. Superset/Emdash manage coding-agent workspaces; Chief Moa must manage the
user's cross-project intent lifecycle and can launch into either kind of
software-factory surface later.

## 2. CI optimization

### StarSling

- YC page: <https://www.ycombinator.com/companies/starsling>
- Current positioning: drop-in hosted CI runners plus agents that inspect
  workflows, job logs, and runner telemetry and submit optimization PRs.

Chief Moa boundary: this is a buy/integrate candidate for hosted CI execution
and optimization. It does not replace Chief Moa's intent, deployment receipt,
or release-safety authority. An optimization PR remains a proposal requiring
the repository's normal review and verification gates.

## 3. Agentic operational diagnosis

### Superlog

- YC page: <https://www.ycombinator.com/companies/superlog>
- Current positioning: agent-installed OpenTelemetry instrumentation, incident
  grouping, code/deploy/log/trace context, and investigated/tested repair PRs.
  Its stated portability posture is vendor-neutral OTel telemetry.

This validates the user's strategy almost verbatim: maintain instrumentation as
code changes, reduce duplicate alerts, contextualize against code/deploy/history,
and return a concise finding or tested PR. It is Spring 2026 and therefore still
too early to make it a silent authority or sole store for Chief Moa.

### Sazabi

- YC page: <https://www.ycombinator.com/companies/sazabi>
- Current positioning: general agentic diagnosis from logs, code, cloud state,
  and prior incidents, with Slack/CLI/Web/MCP entry points and a vertically
  integrated storage layer. It currently describes itself as closed alpha.

Chief Moa boundary: useful market evidence, not a dependency decision. The
closed-alpha and vertically integrated storage posture conflicts with the
current requirements for mature use, owned data, and portable authority.

## 4. Voice-agent transaction and reliability data

This is a separate category from the products above.

- Canonical voice data: admitted user audio, transcript, model/tool transaction,
  response audio, intent link, action/approval/receipt, and retention policy.
- Operational voice diagnostics: stage timing, first-audio latency, gaps,
  provider errors, throughput, percentiles, release correlation, and failure
  classification.
- Derived telemetry may be dropped or rebuilt; canonical audio/turn/intent state
  may not. Raw content is excluded from external telemetry by default.

The current implementation wedge is therefore not “replace Grafana.” It is:

1. own the voice/intent transaction and exact source receipts;
2. emit bounded, content-free operational signals from it;
3. let agents investigate those signals against code, deploys, CI, and history;
4. produce a contextual daily brief and repair proposals;
5. export through a portable boundary only when useful.

## 5. Intent operating system

This is Chief Moa's differentiating authority and is not supplied by Superset,
Emdash, Superlog, StarSling, Langfuse, Datadog, or Grafana:

`spoken thought -> durable intent -> relationships/project -> enrichment ->
execution attempts -> receipts/outcome/lessons -> rehydration -> next intent`

The intent runtime and voice-draft work in this Peter run implement the first
coherent substrate for that loop. External software-factory, CI, and diagnostic
products remain adapters and evidence sources, never competing sources of
truth.
