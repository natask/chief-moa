# Track C: Chat History, Search, Retrieval, And CH Fit

Subagent: Rawls (`019f271b-83f0-7c91-aa8f-38c729638abf`)

Date: 2026-07-03

## Shortlist

| Rank | Project | Search/storage model | Fit for Chief Moa |
|---:|---|---|---|
| 1 | Local [CH/common-chat](/Users/natnaelkahssay/projs/common-chat/README.md:1) | Canonical `.chat/` records and index, native local-tool parsers, some native write-back. | Best ingestion/canonicalization layer because it already sees local Codex, Claude Code, OpenCode, and Gemini history. |
| 2 | [CASS](https://github.com/Dicklesworthstone/coding_agent_session_search) | SQLite source of truth, Tantivy BM25, vector embeddings, hybrid RRF, source-path/line drilldown. | Best retrieval design reference: cited snippets, bounded evidence packs, rebuildable indexes. |
| 3 | [Callimachus](https://github.com/BetaBots-LLC/callimachus) | SQLite, SQLite FTS5/BM25, sqlite-vec semantic KNN, RRF, MCP, VS Code/Cursor, Obsidian export. | Strong ideas, but too young to make canonical. |
| 4 | [AgentsView](https://github.com/kenn-io/agentsview) | Local SQLite + FTS5, REST/SSE, embedded UI, watches session dirs. | Good viewer/analytics reference; weaker as task-extraction substrate. |
| 5 | [Claude Code History Viewer](https://github.com/jhlee0409/claude-code-history-viewer) | Offline/headless viewer across many providers with search/export. | Useful UI reference, not broker/work-graph primitive. |
| 6 | [SpecStory](https://docs.specstory.com) | Saves AI conversations as markdown, preserves decisions/tradeoffs, derives rules. | Good artifact format inspiration. |
| 7 | [cli-continues](https://github.com/yigitkonur/cli-continues) and [casr](https://github.com/Dicklesworthstone/cross_agent_session_resumer) | Handoff/resume IR, native session read/write. | Useful for migration/resume, not retrieval authority. |

## Recommendation

Use CH as the read-only importer. Use CASS/Callimachus as retrieval references. Use Chief Moa gateway Postgres as the canonical store.

Required invariants:

- Preserve `source_tool`, `source_session_id`, source path, line/byte offset when available, message ordinal, timestamp, and content hash.
- Redact secrets before embeddings.
- Store raw source refs and hashes separately from derived summaries, facts, TODOs, and candidate tasks.
- Retrieval returns bounded, source-cited context packs, not raw transcript dumps.
- Candidate task extraction creates proposed artifacts with citations; promotion to agent runs remains explicit.
