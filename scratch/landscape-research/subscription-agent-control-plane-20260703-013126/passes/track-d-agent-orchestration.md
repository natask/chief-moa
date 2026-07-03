# Track D: Agent Orchestration, Project Progress, And Durable Workflows

Subagent: Feynman (`019f271b-a072-7b92-9521-d7f58badb2d7`)

Date: 2026-07-03

## Shortlist

| Rank | System | Runtime/storage model | Fit for Chief Moa |
|---:|---|---|---|
| 1 | [DBOS](https://docs.dbos.dev/ai/ai-quickstart) | App-embedded durable workflows, Postgres state, no separate orchestrator. | Closest fit to Chief Moa's existing Postgres work-graph direction. |
| 2 | [Temporal](https://temporal.io/blog/building-durable-agents-with-temporal-and-ai-sdk-by-vercel) | External workflow service, durable event history, replay, workers. | Mature but operationally heavy. Add later if needed. |
| 3 | [Hatchet](https://github.com/hatchet-dev/hatchet) | Postgres-backed durable task queue/workflow platform. | Good durable task reference; watch API/storage churn. |
| 4 | [Trigger.dev](https://trigger.dev) | TypeScript hosted/self-hosted task platform, run metadata, checkpoints. | Strong TS workflow UX; too product-shaped to be canonical private graph. |
| 5 | [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | Thread checkpointers, cross-thread stores, Postgres/SQLite savers. | Good inside agent workers, not as outer broker/work store. |
| 6 | [OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands) | Self-hosted agent UI/backend/remote agent server, GitHub/Slack/Linear/webhooks. | Strong inspiration for worker backend and UI; do not replace Moa gateway state. |
| 7 | [SWE-agent](https://github.com/SWE-agent/SWE-agent) and [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) | CLI harnesses for code tasks and GitHub issues. | Worker strategy/eval inspiration. |
| 8 | [Omnara](https://github.com/omnara-ai/omnara) | Dashboard for Claude Code/Codex/n8n, realtime visibility, remote/headless launch. | Good "what are my agents doing" reference. |
| 9 | [Nimbalyst](https://github.com/nimbalyst/nimbalyst) | Local visual session manager for Codex/Claude/OpenCode/Copilot, kanban/search/resume/worktrees/mobile. | Strong local UX reference. |
| 10 | [CrewAI](https://github.com/crewAIInc/crewAI), [AutoGen](https://github.com/microsoft/autogen) | Multi-agent crews/workflows/team patterns. | Use concepts only; weaker fit as canonical durable scheduler. |

## Recommendation

Keep Chief Moa's gateway Postgres work graph as canonical:

- `broker_event`
- `route_decision`
- `work_node`
- `node_event`
- `artifact`
- `agent_run`
- `verification_result`
- `cancellation_request`

Borrow DBOS-style durable steps first. Workers remain pluggable: Codex, Claude, Gemini, OpenHands, SWE-agent, LangGraph, browser workers, and Android/browser-extension workers should all post events and artifacts back to Moa.

Cancellation should be cooperative and explicit. New chat messages should not silently cancel existing work.
