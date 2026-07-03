# Fabro: Subscription Agent Control Plane

## Workflow

- path: `.fabro/workflows/subscription-agent-control-plane/workflow.fabro`
- goal: produce a research-backed first implementation plan for a Chief
  Moa-owned subscription, credential, chat-history, and agent-work control plane
- gates: human approval before implementation, credential use, account
  provisioning, or deploy
- artifacts:
  - `00-intent.md`
  - `00-critique.md`
  - `01-openspec.md`
  - `02-fabro.md`
  - landscape research report under
    `scratch/landscape-research/subscription-agent-control-plane-20260703-013126/`
  - `03-execution.md`
  - `04-verification.md`

## Tickets

| id | title | track | depends | acceptance | agent | verification |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Inventory CH local history | workflow | none | Tool counts, project counts, search capabilities, and open-thread themes are summarized without exposing secrets | current session | `ch tools`, `ch projects`, `ch search --help` |
| T2 | Research credential and subscription control planes | workflow | none | Ranked candidate table covers OAuth brokers, secrets managers, agent auth runtimes, and SaaS spend references | subagent A | source-backed pass file |
| T3 | Research account and browser-session provisioning | workflow | none | Ranked candidate table covers SCIM/JML, browser session vaults, RPA credential governance, QA inboxes, and safety boundaries | subagent B | source-backed pass file |
| T4 | Research chat-history search systems | workflow | none | Ranked candidate table compares CH/common-chat, CASS, AgentsView, and adjacent archive/search tools | subagent C | source-backed pass file |
| T5 | Research agent orchestration systems | workflow | none | Ranked candidate table compares LangGraph, Temporal, DBOS, OpenHands, Restate, and related systems | subagent D | source-backed pass file |
| T6 | Synthesize Chief Moa architecture map | docs | T1,T2,T3,T4,T5 | Report maps product needs to Moa primitives and names first implementation slices | current session | manual artifact review |
| T7 | Create first implementation workflow | workflow | T6 | Fabro workflow validates and ticket ledger contains the implementation queue | current session | `fabro validate ...` |

## Waves

| wave | tickets | rule |
| --- | --- | --- |
| 1 | T1,T2,T3,T4,T5 | Run in parallel where possible; all are read-only |
| 2 | T6 | Synthesize after research passes complete |
| 3 | T7 | Create and validate the continuation workflow |
