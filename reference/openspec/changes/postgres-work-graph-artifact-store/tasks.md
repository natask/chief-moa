## 1. Store Boundary

- [x] 1.1 Add a Postgres work-graph adapter selected by `DATABASE_URL`.
- [x] 1.2 Preserve JSON/JSONL fallback behavior when no database is configured.
- [x] 1.3 Report active work-graph storage mode in supervisor status.

## 2. Worker Events And Artifacts

- [x] 2.1 Add authenticated API routes to append and query work-node events.
- [x] 2.2 Add authenticated API routes to create and query durable artifacts.
- [x] 2.3 Add a first reducer that writes a `merged_answer` artifact from node events.

## 3. Verification

- [x] 3.1 Extend supervisor smoke coverage for events, artifacts, and reducer output.
- [x] 3.2 Add Postgres adapter syntax coverage to gateway checks.
- [x] 3.3 Run a real Postgres-backed smoke with `DATABASE_URL` against a local or main-machine database.
