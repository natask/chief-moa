# MB hostile claims ledger

## Audit cycle 1 — BLOCK / repair required

| Implementer claim | Evidence checked | Auditor verdict |
|---|---|---|
| budget is authoritative | direct probe raised caller limit 10 -> 100 and reserved through it | refuted; BLOCK |
| idempotency is domain-scoped | same reservation id across two budgets collided | refuted; repair required |
| webhook replay is collision-safe | source accepted same event identity without comparing payload digest | unproven; repair required |
| persistence and restore are proven | migration integration skipped without `DATABASE_URL`; no scratch restore | unproven; deployment blocker |

Repair contract: introduce immutable budget versions, make reservation identity
tenant+budget scoped, reject same provider-event identity with changed digest or
type, mirror invariants in additive RLS schema and add hostile tests.

## Audit cycle 2 — PASS for source/sandbox unit

| Implementer claim | Evidence checked | Auditor verdict |
|---|---|---|
| caller cannot raise budget limit | `billing-domain.js:121-168`; hostile test lines 74-86 | verified; PASS |
| reservation idempotency is budget scoped | digest includes tenant+budget+reservation; DB compound key; retry/collision tests | verified; PASS |
| webhook raw-body replay/collision is safe | HMAC/timestamp verifier, digest/type collision rejection, hostile fixture | verified; PASS |
| money and currency are bounded | safe-integer helpers, overflow tests, DB checks, 3-letter currency | verified; PASS |
| reconciliation is bounded | max page 100 and cursor tests over 205 facts | verified; PASS |
| tenant and immutable-schema boundaries exist | constructor tenant scope, two-principal test, FORCE RLS and DML revocation | verified in source/unit; DB runtime unproven |
| adapter cannot charge | sandbox operations always `effect:none`, `charged:false` | verified; PASS |

Fresh repair auditor: Codex GPT-5.4, medium reasoning, read-only. Final verdict:
`PASS`. The attempted configured GPT-5.6-sol auditor could not start because the
installed CLI was too old; GPT-5.4 was the recorded fallback. Model choice and
reputation are not measured quality evidence.

Unproven: Postgres migration/app-role execution, scratch restore,
cross-process/transactional reservation, live provider, real charges, taxes,
commercial pricing and policy. These are not claimed by this source/sandbox
unit and block deployment/payment authority.
