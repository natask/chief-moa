# Claims ledger

| Implementer claim | Status | Evidence | Verdict |
|---|---|---|---|
| Scoped relational writer rejects record identity override | verified | hostile loop covers all 7 methods | pass for MF-1 |
| Versioned tenant namespace is delimiter-safe and legacy-owner compatible | verified | focused delimiter + owner identity tests | pass for MF-1 |
| Hostile long tenant/entity ids keep bounded distinct event identities | verified | focused long-id tests assert <=240 chars plus distinct scoped keys | pass for MF-1 |
| Cross-tenant identifier reuse is blocked in Postgres | unproven | integration test added; skipped without `DATABASE_URL` | preview required |
| Full gateway regression is green | refuted in this sandbox | `npm run check`: 129 pass, 33 fail, 1 skip; failures are localhost `listen EPERM` smoke/unit tests | blocked here |
| Hosted multi-user auth is complete | refuted | `server.js` exact single bearer token | block |
| RLS schema scaffolding exists | verified | migration 0002 policies | partial pass |
| Retention/export/delete is implemented | refuted | no lifecycle policy/job/API evidence | block |
| Production restore passed for this lane | unproven | no production operation run | block promotion |

Measured results and architecture-confidence are recorded separately after gates.

## Measured results

- Focused tenant tests: 7 passed, 0 failed.
- `npm run check`: 129 passed, 33 failed, 1 skipped in this sandbox.
- The 33 failures all stem from localhost bind attempts returning
  `listen EPERM 127.0.0.1`; no full-suite green claim is made from this run.
- The skipped count includes unavailable disposable-Postgres integration; no
  database isolation or migration benchmark result is claimed.

## Architecture-confidence only

MF-1 increases confidence that application writers cannot accept a body-derived
tenant and that global identifier collisions cannot transfer row ownership.
This is not proof of hosted isolation: request-scoped auth, event-table RLS,
tenant-scoped reads/files/blobs, lifecycle jobs and restore evidence are absent.
The new namespace uses versioned SHA-256-derived identifiers to be
collision-resistant within the tested source unit, but no cryptographic proof or
database uniqueness proof is claimed. Historical owner events are not backfilled
with `authority.tenant_id`; hosted auth must reserve/remap the literal `owner`
subject before enabling multi-user.

## Audit cycles

- Cycle 1: BLOCK — stale DB expectation, only one method attacked, ambiguous
  delimiter namespace.
- Repair MF-1-R1: corrected FK path, attacked all seven methods, encoded hosted
  tenant segment, and preserved reserved-owner import identity.
- Cycle 2: PASS for the bounded source unit. Real Postgres remains unmeasured.
- Cycle 3: BLOCK — encoded tenant segment can still truncate at 240 chars and
  collide for hostile long but allowed trusted user ids.
- Repair MF-1-R2: replaced the encoded prefix with versioned fixed-length
  tenant namespaces plus bounded fallback keys for overlong scoped values, while
  preserving reserved-owner identities.
- Cycle 4: PASS for focused source tests; full gateway suite remains blocked in
  this sandbox by localhost `listen EPERM`, and real Postgres is still
  unmeasured.
