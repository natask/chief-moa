# Contract MF-1: trusted tenant relational writes

## Objective

Make the existing relational writer a strict executor of a trusted tenant
context, without redesigning auth or applying a durable migration.

## Owned paths

- `gateway/lib/relational-store.js`
- `gateway/scripts/import-datadir.js`
- focused gateway tests for this module
- this manager packet

## Behavior

- `createRelationalStore` requires `userId`.
- Every method rejects a record whose optional `user_id` differs.
- SQL receives only the trusted `userId`.
- Events include versioned fixed-length tenant-scoped streams/idempotency keys
  plus tenant authority metadata where the existing envelope permits it.
- Importer explicitly supplies legacy owner identity.

## Forbidden shortcuts

No request/body-derived tenant, no global mutable current user, no production
DB, no destructive migration, no claim that RLS is end-to-end, no invented
retention policy, no cryptographic-proof claim, and no benchmark/confidence
conflation.

## Gates

Focused unit tests, gateway `npm run check`, optional isolated Postgres tests
only when a safe URL is already available. A fresh adversarial audit must return
PASS or generate a repair contract.

## Escalation

Escalate event-table migration, better-auth/session authority, retention/export/
delete policy and blob ownership as separate staged contracts.
