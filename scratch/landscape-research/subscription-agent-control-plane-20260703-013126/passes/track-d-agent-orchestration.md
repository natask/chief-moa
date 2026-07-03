# Pass: Agent Orchestration And Project Management

Agent: `019f271b-8fac-77a3-9e3a-7c0a365c9662`

## Summary

The strongest architecture is a two-layer runtime:

- Durable control plane: DBOS or Temporal.
- Agent graph/thread layer: LangGraph or a Moa-native equivalent.

OpenHands is the strongest product reference for an agent workbench. Browser-use,
Stagehand, Skyvern, Steel, and SWE-agent are tool/action backends, not the
central work graph.

## Best Candidates

| Rank | Candidate | Use |
| ---: | --- | --- |
| 1 | LangGraph + LangSmith Deployment | Agent threads, runs, interrupts, persistence |
| 2 | Temporal | Mature durable workflows, signals, queries, human approval |
| 3 | DBOS | Postgres-backed durable workflows that fit a Postgres gateway |
| 4 | OpenHands / Agent Canvas | Self-hosted agent workbench and coding-agent UI reference |
| 5 | Restate | Lightweight durable services and human approval patterns |
| 6 | Microsoft Agent Framework / AutoGen | Typed workflow and multi-agent references |
| 7 | Mastra | TypeScript agent/workflow framework reference |
| 8 | Trigger.dev / Inngest | Durable background task references |
| 9 | GitHub Copilot Cloud Agent / Codex Cloud | Product reference for async task delegation and PR evidence |
| 10 | CrewAI | Role/task abstraction reference |
| 11 | browser-use / Stagehand / Skyvern / Steel | Browser-action backends |
| 12 | SWE-agent / mini-SWE-agent | Evidence/trajectory reference for code tasks |

## Chief Moa Implication

Do not make provider chat threads the work engine. Chief Moa should persist:

- broker event
- route decision
- context pack
- work item
- workflow/run id
- agent run events
- approval events
- receipts
- artifacts
- verification result

DBOS is a strong fit because existing Chief Moa specs already point toward
Postgres. Temporal remains the safer mature option if operational overhead is
acceptable.
