# Goal: MB billing, metering and entitlements

Compile and execute the MB contract in `../portfolio-managers.md`, using
`../intent-execution-map.md`, the parent instructions, MF notes and relevant
hosted-product OpenSpecs. Own branch `agent/mb-billing-entitlements` and sibling
worktree `chief-moa-worktrees/mb-billing-entitlements`. Own only billing domain
schema, immutable meter/price/usage records, entitlement and budget projections,
provider-neutral sandbox adapters, verified webhook fixtures, reconciliation,
refund/dispute/grace state and audit receipts. Do not own identity, general
telemetry, client UX or deployment.

Run at least five read-only research passes: repository/data topology; money and
idempotency invariants; tenant/trust boundaries; crash/replay/reconciliation
failures; and dated official provider facts. Research provider/model/tool fit
before selection. Missing business model, tax geography, refund/grace policy,
provider or paid-account authority is an escalation, not permission to invent.

The contractor must specify exact files/interfaces/state transitions, integer
minor-unit money rules, test clocks, dedupe keys, migration/restore strategy,
bounded reconciliation, complexity <=10 and CRAP <=15 targets, performance
budgets, forbidden shortcuts and exact acceptance commands. Implementers stay in
disjoint ownership. Auditors cover goal correctness, financial/security,
tenant isolation, concurrency, performance/resource, quality/CRAP/complexity
and anti-gaming with a hostile claims ledger.

Required gates include gateway check, migration compatibility, money and
idempotency properties, signed/replay webhook fixtures, concurrent budget tests,
outage/grace, refund/dispute/reconciliation, two-principal isolation and scratch
restore. Block floats, unsigned webhook authority, overwritten history,
provider-as-truth, model/client payment mutation, leaked secrets or duplicate
charges. No real charge or provider selection is authorized.

Measured results must name executed commands. Architecture confidence must list
invariants/tests/canaries and residual unknowns; it is never a benchmark score.
