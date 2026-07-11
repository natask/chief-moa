# MF identity/data foundation

## Objective

Establish the enforceable identity and tenant boundary on which telemetry,
context, control-plane and billing work can safely depend. The coherent first
unit is a tenant-scoped relational/event write contract plus explicit lifecycle
policy blockers; it does not pretend the undecided retention schedule exists.

## Non-negotiables

- Local loopback may be no-auth and maps to one explicit local principal.
- Remote single-user uses one owner principal; hosted multi-user requires a
  verified user/device principal on every protected request.
- Request input never selects `user_id`; authenticated context does.
- Database writes and audit events carry the same tenant in one transaction.
- Cross-tenant identifier collisions fail; they never transfer ownership.
- No destructive migration, live database operation or active deployment.
- Retention/export/delete behavior remains blocked until its policy is recorded.

## Ownership and lane

- Branch: `agent/mf-identity-data-foundation`
- Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/mf-identity-data-foundation`
- Owns gateway identity context, tenant-scoped storage/migrations and lifecycle
  contracts. Does not own client UX, ranking, telemetry or billing.

## Acceptance for this implementation unit

1. A scoped relational store rejects a record claiming another principal.
2. Business rows and product events use one trusted tenant id.
3. Existing single-owner importer remains explicitly scoped to `owner`.
4. Two-principal tests attack cross-user record injection and identifier reuse.
5. Gateway unit suite passes; disposable-Postgres tests are reported separately
   and are not claimed when `DATABASE_URL` is absent.

## Live constraints

No active service restart, production database access, migration apply, push or
promotion. A source commit is the artifact; promotion requires an isolated
Postgres preview, backup/scratch-restore proof, compatibility and rollback.
