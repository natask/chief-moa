# Pass: Chat-History Search And Retrieval

Agent: `019f271b-7fa9-7db2-8278-1e18b7da2b10`

## Summary

CH/common-chat is the best owned local substrate because it already reads local
tool histories and supports native-format sync/writeback. CASS and AgentsView
are stronger external references for indexing, search UX, and analytics.

## Best Candidates

| Rank | Candidate | Use |
| ---: | --- | --- |
| 1 | CASS | Local archive plus Tantivy/full-text and optional semantic search |
| 2 | AgentsView | Local-first web UI, search, analytics, token/cost stats |
| 3 | CH/common-chat | Owned canonical history and native-format sync/writeback |
| 4 | MyChatArchive | Web-chat imports, SQLite, FTS/vector, MCP server |
| 5 | agentmemory | Persistent memory with BM25/vector/graph/RRF references |
| 6 | ChatSync | IDE-side normalized cache and context injection |
| 7 | Agent Sessions | macOS local session browser and resume UX |
| 8 | continues | Cross-harness handoff context |
| 9 | Claude Code History Viewer | Desktop viewer reference |
| 10 | memsearch | Markdown-backed semantic memory reference |

## Chief Moa Implication

Use CH/common-chat as the owned ingest/sync layer, then add:

- SQLite or Postgres canonical import table
- FTS5/Tantivy/BM25 lexical search
- optional local embeddings for semantic recall
- dedupe by source tool, project path, session id, message id, and content hash
- extracted task records with status and evidence links
- JSON/robot API for agents

The key product gap is not search alone. It is turning search hits into a
deduped work graph with owner, project, status, acceptance criteria, and
verification.
