# CH Inventory

Read-only inventory captured on 2026-07-03 from `/Users/natnaelkahssay/projs/chief-moa`.

## Local Tool Coverage

`ch tools` detects 3,935 local sessions before any new sync:

| Tool | Path | Format | Sessions |
|---|---:|---|---:|
| OpenCode | `/Users/natnaelkahssay/.local/share/opencode` | sqlite | 2,391 |
| Codex | `/Users/natnaelkahssay/.codex` | jsonl | 1,132 |
| Claude Code | `/Users/natnaelkahssay/.claude` | jsonl | 283 |
| Gemini | `/Users/natnaelkahssay/.gemini` | json | 129 |
| Antigravity | `/Users/natnaelkahssay/.gemini` | json | 0 |

## Active Project Clusters

High-signal clusters from `ch projects`:

| Project | Sessions | Last active |
|---|---:|---|
| `moa` | 462 | 50d ago |
| `branch-continue` | 369 | 10d ago |
| `projs` | 336 | 16m ago |
| `my-harness` | 217 | 56d ago |
| `better-cmdk` | 179 | 69d ago |
| `codefour_negotiations` | 172 | 17d ago |
| `masterbranch` | 163 | 9d ago |
| `natstack` | 159 | 4h ago |
| `chief-moa` | 143 | just now |
| `moa-assistant` | 135 | 12d ago |
| `common-chat` | 131 | 50d ago |

## Local CH/Common-Chat State

`/Users/natnaelkahssay/projs/common-chat` already has the right ingestion shape:

- Native readers for Claude Code JSONL, Codex JSONL, OpenCode SQLite, Gemini JSON, and other local session stores.
- Canonical `.chat/` records and an index layer.
- Native write-back for some tools, which generic viewers do not provide.
- A documented goal of reducing fragmented AI-tool history and turning raw ideas into completed work.
- Existing workflow docs for raw thought capture, maintained state, task extraction, implementation, tests, QA, review, and state updates.

Current gap: CH is the right importer/canonicalizer, but Chief Moa still needs a gateway-backed retrieval/index/task-extraction layer with source hashes, citations, dedupe, promotion gates, and work-node linkage.

## Relevant Prior User Requests Found

Targeted `ch search` found repeated prior intent around the exact system in this request:

- `019f270b-679` in `chief-moa`: self-hosted/VPS service, one login, all credentials, expiry pings, manual re-auth, chat history before/after codebase changes, and not giving agents access to the whole machine.
- `d2952978-c35` in `agent_launcher`: first-class agent launcher that specifies tools, execution environment, system prompt, and skills for every agent.
- `019ef135-faa` in `chief-moa`: mine all project chat history, create durable artifacts, connect the work to a Fabro workflow graph, and continually implement in stages.
- `019ef131-456` in `natstack`: prevent thoughts from being locked in chat history; add an intake step between speech/chat and durable work.
- Multiple `etched` sessions: recurring need to find specific prior technical discussions and synthesize them into current project work.

## Decision

Do not launch one agent per raw chat history. With 3,935 sessions, that would duplicate work and create unsafe write pressure across many repos.

The correct first loop is:

1. Import sessions read-only through CH.
2. Store source refs, hashes, project, tool, timestamps, message ordinals, and redaction state.
3. Build lexical and semantic indexes as replaceable derivatives.
4. Extract `candidate_task` artifacts with citations and duplicate grouping.
5. Promote selected tasks into `work_node` records.
6. Launch bounded agents only from promoted work nodes with repo/tool/deploy policy.
