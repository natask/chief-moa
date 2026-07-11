# Claims ledger

| Implementer claim | Status | Evidence | Verdict |
|---|---|---|---|
| Scoped relational writer rejects record identity override | verified | hostile loop covers all 7 methods | pass for MF-1 |
| New event namespace is delimiter-safe and legacy-owner compatible | verified | focused collision + owner identity tests | pass for MF-1 |
| Cross-tenant identifier reuse is blocked in Postgres | unproven | integration test added; skipped without `DATABASE_URL` | preview required |
| Full gateway regression is green | verified | `npm run check`: 160 pass, 1 skip, 0 fail | pass |
| Hosted multi-user auth is complete | refuted | `server.js` exact single bearer token | block |
| RLS schema scaffolding exists | verified | migration 0002 policies | partial pass |
| Retention/export/delete is implemented | refuted | no lifecycle policy/job/API evidence | block |
| Production restore passed for this lane | unproven | no production operation run | block promotion |

Measured results and architecture-confidence are recorded separately after gates.

## Measured results

- Focused tenant tests: 5 passed, 0 failed.
- Gateway check after dependency install: 160 passed, 1 skipped, 0 failed.
- The skipped count includes unavailable disposable-Postgres integration; no
  database isolation or migration benchmark result is claimed.
- Dependency install reported two high-severity audit findings; no unsafe
  breaking auto-fix was applied. Dependency remediation is residual risk.

## Architecture-confidence only

MF-1 increases confidence that application writers cannot accept a body-derived
tenant and that global identifier collisions cannot transfer row ownership.
This is not proof of hosted isolation: request-scoped auth, event-table RLS,
tenant-scoped reads/files/blobs, lifecycle jobs and restore evidence are absent.
Historical owner events are not backfilled with `authority.tenant_id`; hosted
auth must reserve/remap the literal `owner` subject before enabling multi-user.

## Audit cycles

- Cycle 1: BLOCK — stale DB expectation, only one method attacked, ambiguous
  delimiter namespace.
- Repair MF-1-R1: corrected FK path, attacked all seven methods, encoded hosted
  tenant segment, and preserved reserved-owner import identity.
- Cycle 2: PASS for the bounded source unit. Real Postgres remains unmeasured.
