## Why

Moa's work graph and supervisor cannot become the durable operating substrate
while they are backed only by a single JSON file. Concurrent workers need an
append-only event stream, produced work needs queryable artifacts, and the
supervisor report should be a database read instead of chat archaeology.

Postgres is the intended gateway store. The existing `schema.sql` is Postgres
DDL, but a schema file alone does not make the gateway use Postgres. This change
wires the gateway work graph, worker events, and artifacts through a Postgres
adapter when `DATABASE_URL` is configured.

## What Changes

- Add a Postgres-backed work-graph adapter behind the existing gateway
  supervisor/work-node API.
- Keep JSON/JSONL as a local fallback when `DATABASE_URL` is not set.
- Add authenticated event and artifact API routes so workers can POST produced
  state instead of leaving it in chat transcripts.
- Add a reducer endpoint that writes a durable `merged_answer` artifact from a
  node event stream.
- Report storage mode in supervisor status.

## Impact

- `gateway/lib/work-graph.js`: storage adapter boundary and JSON
  fallback parity for events/artifacts.
- `gateway/lib/work-graph-postgres.js`: Postgres adapter.
- `gateway/server.js`: async work-graph route boundary plus event,
  artifact, and reducer routes.
- `gateway/schema.sql`: canonical Postgres schema used at startup.
- `gateway/scripts/smoke-supervisor.js`: coverage for event,
  artifact, and reducer APIs.
- `ARCHITECTURE.md`: Postgres-backed work graph/artifact store becomes a gateway
  store primitive.
