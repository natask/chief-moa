# S1 Intent Domain Goal

## Goal

Build a product-events-backed intent aggregate and pure reducer over the
existing event substrate. It must support durable capture, legal lifecycle
transitions, typed relations, focus push/pop for a temporary child intent, and
bounded source-linked rehydration after restart.

## Owned paths

- New gateway intent-domain/router/rehydration modules.
- Focused tests for those modules.

## Branch and worktree

- Branch: `agent/intent-domain-20260711`
- Worktree:
  `/Users/natnaelkahssay/projs/chief-moa-worktrees/intent-domain-20260711`

## Acceptance

- The event substrate is the only persistence authority.
- Duplicate commands are idempotent.
- Illegal lifecycle and relation transitions fail closed.
- A transactional child can push focus, complete with a receipt reference, and
  pop back to its parent deterministically.
- Rehydration returns objective, lifecycle, relations, decisions, blockers,
  artifact/run/receipt refs, next step, and bounded source receipts.
- JSON and Postgres event-store adapters use the same module contract.

## Verification

`cd gateway && node --test test/intent-runtime.test.js`

## Do not touch

- `gateway/server.js`, `gateway/package.json`, existing work/thread stores,
  surface files, deployment files, or active state.
- Do not add a second JSON intent store.
