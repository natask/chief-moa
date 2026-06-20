## Context

The gateway already has durable work nodes and a thin supervisor, but the store
has been a single JSON file. That works for one local smoke but fails the real
product model: multiple disposable workers need to write progress and output
concurrently, and the user needs artifacts that survive sessions and can be
queried later.

## Decisions

### Decision: `DATABASE_URL` Selects Postgres

When `DATABASE_URL` is set, the gateway uses a Postgres adapter for work nodes,
work events, and work artifacts. The adapter runs the idempotent `schema.sql`
DDL on startup. When `DATABASE_URL` is absent, the gateway uses the existing
local JSON/JSONL fallback so laptop/device QA still works with no database.

### Decision: Preserve The Supervisor API

The existing `/v1/work/nodes` and `/v1/supervisor/status` API remains the
gateway contract. The implementation becomes async so the same routes can use
Postgres without changing Android or extension clients.

### Decision: Workers Write Events And Artifacts

Workers POST append-only events to `/v1/work/events` and produced work to
`/v1/work/artifacts`. Events are ordered by a per-node sequence. Artifacts are
the durable recall layer for plans, decisions, tool specs, results, and merged
answers.

### Decision: Reducer Writes A First `merged_answer`

The first reducer is intentionally simple: it reads a node's events and creates
a `merged_answer` artifact from the text-like event payloads. Better reducers can
replace it later without changing the event/artifact storage contract.

## Risks

- The first implementation only ports the work graph/events/artifacts. Agent run
  files still remain JSON-backed.
- The reducer is not semantic yet; it proves the write path and durable artifact
  contract.
- Production deployment still requires provisioning a real Postgres database and
  setting `DATABASE_URL` on the main-machine gateway.
